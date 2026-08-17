import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";

import { closeWebSocketsForShutdown } from "../../../src/server/websocket-shutdown";

const CLOSED = 3;
const OPEN = 1;

interface FakeWebSocketOptions {
	readyState?: number;
	answersHandshake?: boolean;
	throwOnClose?: boolean;
}

class FakeWebSocket extends EventEmitter {
	readonly CLOSED = CLOSED;
	readyState: number;
	closeCalls: Array<{ code?: number; reason?: string }> = [];
	terminateCalls = 0;
	private readonly answersHandshake: boolean;
	private readonly throwOnClose: boolean;

	constructor({ readyState = OPEN, answersHandshake = true, throwOnClose = false }: FakeWebSocketOptions = {}) {
		super();
		this.readyState = readyState;
		this.answersHandshake = answersHandshake;
		this.throwOnClose = throwOnClose;
	}

	close(code?: number, reason?: string): void {
		if (this.throwOnClose) {
			throw new Error("socket already gone");
		}
		this.closeCalls.push({ code, reason });
		if (this.answersHandshake) {
			setImmediate(() => {
				this.readyState = CLOSED;
				this.emit("close");
			});
		}
	}

	terminate(): void {
		this.terminateCalls += 1;
		this.readyState = CLOSED;
	}
}

function asWebSocket(fake: FakeWebSocket): WebSocket {
	return fake as unknown as WebSocket;
}

describe("closeWebSocketsForShutdown", () => {
	it("closes with the going-away code instead of aborting the connection", async () => {
		const client = new FakeWebSocket();

		await closeWebSocketsForShutdown([asWebSocket(client)]);

		// terminate() alone resets the TCP connection, which a proxy in front of the
		// runtime reports as `ws proxy error: read ECONNRESET` and the browser sees as
		// an abnormal 1006 close — indistinguishable from a crash.
		expect(client.closeCalls).toEqual([{ code: 1001, reason: "Runtime is shutting down." }]);
		expect(client.terminateCalls).toBe(0);
	});

	it("falls back to terminate when a client never answers the handshake", async () => {
		const client = new FakeWebSocket({ answersHandshake: false });

		await closeWebSocketsForShutdown([asWebSocket(client)]);

		expect(client.closeCalls).toHaveLength(1);
		expect(client.terminateCalls).toBe(1);
	});

	it("skips clients that are already closed", async () => {
		const client = new FakeWebSocket({ readyState: CLOSED });

		await closeWebSocketsForShutdown([asWebSocket(client)]);

		expect(client.closeCalls).toHaveLength(0);
		expect(client.terminateCalls).toBe(0);
	});

	it("terminates a client whose close throws rather than hanging shutdown", async () => {
		const client = new FakeWebSocket({ throwOnClose: true });

		await closeWebSocketsForShutdown([asWebSocket(client)]);

		expect(client.terminateCalls).toBe(1);
	});

	it("closes every client even when one of them stalls", async () => {
		const responsive = new FakeWebSocket();
		const stalled = new FakeWebSocket({ answersHandshake: false });

		await closeWebSocketsForShutdown([asWebSocket(responsive), asWebSocket(stalled)]);

		expect(responsive.closeCalls).toHaveLength(1);
		expect(responsive.terminateCalls).toBe(0);
		expect(stalled.terminateCalls).toBe(1);
	});
});
