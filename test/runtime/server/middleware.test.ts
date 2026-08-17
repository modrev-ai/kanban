import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
	getKanbanRuntimeHost,
	getKanbanRuntimePort,
	setKanbanRuntimeHost,
	setKanbanRuntimePort,
} from "../../../src/core/runtime-endpoint";
import {
	endUpgradeSocket,
	evaluateCors,
	evaluateHost,
	getAllowedHostHeaders,
	getAllowedOrigins,
	handleSocketUpgrade,
} from "../../../src/server/middleware";

const ALLOWED_ORIGIN = "http://127.0.0.1:3484";
const ALLOWED_ORIGINS = new Set([ALLOWED_ORIGIN]);
const ALLOWED_HOSTS = new Set(["localhost:3484", "127.0.0.1:3484"]);

function makeFakeRequest(headers: Partial<IncomingMessage["headers"]>, method = "GET"): IncomingMessage {
	return { method, headers } as IncomingMessage;
}

// Rejections are now flushed and half-closed rather than aborted, so the bytes arrive
// asynchronously; drain the stream to end before asserting on them.
async function readSocket(socket: PassThrough): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of socket) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

describe("evaluateCors", () => {
	it("allows requests with no Origin header", () => {
		const decision = evaluateCors({
			method: "GET",
			originHeader: undefined,
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "allow", origin: null });
	});

	it("allows requests with an empty Origin header", () => {
		const decision = evaluateCors({
			method: "GET",
			originHeader: "",
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "allow", origin: null });
	});

	it("allows requests whose Origin matches the runtime origin", () => {
		const decision = evaluateCors({
			method: "POST",
			originHeader: ALLOWED_ORIGIN,
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "allow", origin: ALLOWED_ORIGIN });
	});

	it("rejects requests from a different origin", () => {
		const decision = evaluateCors({
			method: "POST",
			originHeader: "http://evil.example.com",
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "reject", origin: "http://evil.example.com" });
	});

	it("rejects requests from the same host but a different port", () => {
		const decision = evaluateCors({
			method: "GET",
			originHeader: "http://127.0.0.1:9999",
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "reject", origin: "http://127.0.0.1:9999" });
	});

	it("rejects requests from the same host but a different scheme", () => {
		const decision = evaluateCors({
			method: "GET",
			originHeader: "https://127.0.0.1:3484",
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "reject", origin: "https://127.0.0.1:3484" });
	});

	it("returns a preflight decision for OPTIONS from the allowed origin", () => {
		const decision = evaluateCors({
			method: "OPTIONS",
			originHeader: ALLOWED_ORIGIN,
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "preflight", origin: ALLOWED_ORIGIN });
	});

	it("rejects preflight from a disallowed origin", () => {
		const decision = evaluateCors({
			method: "OPTIONS",
			originHeader: "http://evil.example.com",
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "reject", origin: "http://evil.example.com" });
	});

	it("allows OPTIONS without an Origin header (not a CORS preflight)", () => {
		const decision = evaluateCors({
			method: "OPTIONS",
			originHeader: undefined,
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "allow", origin: null });
	});
});

describe("evaluateHost", () => {
	it("rejects requests with no Host header", () => {
		expect(evaluateHost({ hostHeader: undefined, allowedHosts: ALLOWED_HOSTS })).toEqual({
			kind: "reject",
			host: null,
		});
	});

	it("rejects requests with an empty Host header", () => {
		expect(evaluateHost({ hostHeader: "", allowedHosts: ALLOWED_HOSTS })).toEqual({ kind: "reject", host: null });
	});

	it("allows requests whose Host is in the allowlist", () => {
		expect(evaluateHost({ hostHeader: "127.0.0.1:3484", allowedHosts: ALLOWED_HOSTS })).toEqual({ kind: "allow" });
		expect(evaluateHost({ hostHeader: "localhost:3484", allowedHosts: ALLOWED_HOSTS })).toEqual({ kind: "allow" });
	});

	it("normalises Host header casing before comparing", () => {
		expect(evaluateHost({ hostHeader: "LocalHost:3484", allowedHosts: ALLOWED_HOSTS })).toEqual({ kind: "allow" });
	});

	it("rejects DNS rebinding attempts via a foreign Host header", () => {
		expect(evaluateHost({ hostHeader: "attacker.example.com:3484", allowedHosts: ALLOWED_HOSTS })).toEqual({
			kind: "reject",
			host: "attacker.example.com:3484",
		});
	});

	it("rejects when the port doesn't match", () => {
		expect(evaluateHost({ hostHeader: "localhost:9999", allowedHosts: ALLOWED_HOSTS })).toEqual({
			kind: "reject",
			host: "localhost:9999",
		});
	});
});

describe("handleSocketUpgrade", () => {
	it("passes through upgrades whose Host and Origin are both allowed", () => {
		const socket = new PassThrough();
		const request = makeFakeRequest({ host: "127.0.0.1:3484", origin: ALLOWED_ORIGIN });
		const result = handleSocketUpgrade(request, socket);
		expect(result).toEqual({ end: false });
		expect(socket.destroyed).toBe(false);
	});

	it("rejects upgrades from a disallowed origin with a 403 status line", async () => {
		const socket = new PassThrough();
		const request = makeFakeRequest({ host: "127.0.0.1:3484", origin: "http://evil.example.com" });
		const result = handleSocketUpgrade(request, socket);
		expect(result).toEqual({ end: true });
		// The status line MUST reach the peer. Destroying the socket instead of
		// flushing it resets the connection, so a proxy in front of the runtime (the
		// Vite dev server's /api ws proxy) reports only `read ECONNRESET` and the
		// actual reason is lost.
		expect(await readSocket(socket)).toContain("HTTP/1.1 403 Forbidden");
	});

	it("rejects upgrades whose Host header doesn't match the allowlist", async () => {
		const socket = new PassThrough();
		const request = makeFakeRequest({ host: "attacker.example.com:3484", origin: ALLOWED_ORIGIN });
		const result = handleSocketUpgrade(request, socket);
		expect(result).toEqual({ end: true });
		expect(await readSocket(socket)).toContain("HTTP/1.1 403 Forbidden");
	});

	it("rejects upgrades with a missing Host header", async () => {
		const socket = new PassThrough();
		const request = makeFakeRequest({});
		const result = handleSocketUpgrade(request, socket);
		expect(result).toEqual({ end: true });
		expect(await readSocket(socket)).toContain("HTTP/1.1 403 Forbidden");
	});

	it("rejects an upgrade only once even though both bridges run the gate", async () => {
		const socket = new PassThrough();
		const request = makeFakeRequest({ host: "127.0.0.1:3484", origin: "http://evil.example.com" });

		expect(handleSocketUpgrade(request, socket)).toEqual({ end: true });
		// The runtime-state and terminal bridges both gate the same request. Rejecting
		// twice would write to an already-destroyed socket, and an unhandled 'error' on
		// a raw upgrade socket crashes the runtime.
		expect(handleSocketUpgrade(request, socket)).toEqual({ end: true });

		const response = await readSocket(socket);
		expect(response).toContain("HTTP/1.1 403 Forbidden");
		expect(response.match(/HTTP\/1\.1 403 Forbidden/g)).toHaveLength(1);
	});

	it("reuses the allow decision across both bridges", () => {
		const socket = new PassThrough();
		const request = makeFakeRequest({ host: "127.0.0.1:3484", origin: ALLOWED_ORIGIN });

		expect(handleSocketUpgrade(request, socket)).toEqual({ end: false });
		expect(handleSocketUpgrade(request, socket)).toEqual({ end: false });
		expect(socket.destroyed).toBe(false);
	});
});

describe("endUpgradeSocket", () => {
	it("flushes the status line and then closes the connection", async () => {
		const socket = new PassThrough();

		endUpgradeSocket(socket, "404 Not Found");

		const response = await readSocket(socket);
		expect(response).toContain("HTTP/1.1 404 Not Found");
		expect(response).toContain("Connection: close");
	});

	it("does not throw when the peer already went away", () => {
		const socket = new PassThrough();
		socket.destroy();

		// Node attaches no 'error' listener to a raw upgrade socket, so writing to a
		// dead one would surface as an unhandled 'error' event and kill the process.
		expect(() => endUpgradeSocket(socket, "403 Forbidden")).not.toThrow();
	});
});

describe("getAllowedHostHeaders", () => {
	const originalHost = getKanbanRuntimeHost();
	const originalPort = getKanbanRuntimePort();

	afterEach(() => {
		setKanbanRuntimeHost(originalHost);
		setKanbanRuntimePort(originalPort);
	});

	it("allows loopback host headers when bound to loopback", () => {
		setKanbanRuntimeHost("127.0.0.1");
		setKanbanRuntimePort(3484);
		const allowed = getAllowedHostHeaders();
		expect(allowed.has("localhost:3484")).toBe(true);
		expect(allowed.has("127.0.0.1:3484")).toBe(true);
	});

	it("still allows loopback host headers in remote mode (0.0.0.0), plus the bound host", () => {
		setKanbanRuntimeHost("0.0.0.0");
		setKanbanRuntimePort(3484);
		const allowed = getAllowedHostHeaders();
		// The fix: loopback stays allowed so a container that binds 0.0.0.0 but is
		// published on the host's loopback is reachable at http://localhost:PORT.
		expect(allowed.has("localhost:3484")).toBe(true);
		expect(allowed.has("127.0.0.1:3484")).toBe(true);
		expect(allowed.has("0.0.0.0:3484")).toBe(true);
	});

	it("does not allow a foreign host header in remote mode", () => {
		setKanbanRuntimeHost("0.0.0.0");
		setKanbanRuntimePort(3484);
		expect(getAllowedHostHeaders().has("attacker.example.com:3484")).toBe(false);
	});
});

describe("getAllowedOrigins", () => {
	const originalHost = getKanbanRuntimeHost();
	const originalPort = getKanbanRuntimePort();

	afterEach(() => {
		setKanbanRuntimeHost(originalHost);
		setKanbanRuntimePort(originalPort);
	});

	it("allows loopback origins when bound to loopback", () => {
		setKanbanRuntimeHost("127.0.0.1");
		setKanbanRuntimePort(3484);
		const allowed = getAllowedOrigins();
		expect(allowed.has("http://localhost:3484")).toBe(true);
		expect(allowed.has("http://127.0.0.1:3484")).toBe(true);
	});

	it("still allows loopback origins in remote mode (0.0.0.0), plus the bound origin", () => {
		setKanbanRuntimeHost("0.0.0.0");
		setKanbanRuntimePort(3484);
		const allowed = getAllowedOrigins();
		// The app opened at http://localhost:PORT stamps that as the Origin on its
		// own fetch/WS calls; without this they were rejected and the board went blank.
		expect(allowed.has("http://localhost:3484")).toBe(true);
		expect(allowed.has("http://127.0.0.1:3484")).toBe(true);
		expect(allowed.has("http://0.0.0.0:3484")).toBe(true);
	});

	it("does not allow a foreign origin in remote mode", () => {
		setKanbanRuntimeHost("0.0.0.0");
		setKanbanRuntimePort(3484);
		expect(getAllowedOrigins().has("http://attacker.example.com:3484")).toBe(false);
	});
});
