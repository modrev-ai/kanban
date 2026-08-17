import type { WebSocket } from "ws";

// 1001 "going away" is the code the WebSocket protocol reserves for a server that is
// shutting down, so the browser can tell a planned restart from a failure.
const SHUTDOWN_CLOSE_CODE = 1001;
const SHUTDOWN_CLOSE_REASON = "Runtime is shutting down.";
// How long a client gets to answer the close handshake before we stop being polite.
// Shutdown latency the user feels, so keep it short: the handshake is a single frame
// round trip over loopback and normally completes in single-digit milliseconds.
const SHUTDOWN_CLOSE_GRACE_MS = 250;

function terminateQuietly(client: WebSocket): void {
	try {
		client.terminate();
	} catch {
		// Ignore websocket termination errors during shutdown.
	}
}

/**
 * Closes every websocket with a real close handshake before forcing it down.
 *
 * `terminate()` on its own aborts the TCP connection with an RST. Anything proxying
 * the runtime — the Vite dev server proxies `/api` with `ws: true` — surfaces that as
 * `ws proxy error: Error: read ECONNRESET`, and the browser gets an abnormal 1006
 * closure that is indistinguishable from a crash, so client reconnect logic cannot
 * tell a planned shutdown from a real failure. Send the close frame first and fall
 * back to `terminate()` only for clients that do not answer in time.
 */
export async function closeWebSocketsForShutdown(clients: Iterable<WebSocket>): Promise<void> {
	await Promise.all(
		Array.from(clients).map(
			async (client) =>
				await new Promise<void>((resolveClosed) => {
					if (client.readyState === client.CLOSED) {
						resolveClosed();
						return;
					}
					let graceTimer: ReturnType<typeof setTimeout> | null = null;
					const onClosed = () => {
						if (graceTimer !== null) {
							clearTimeout(graceTimer);
							graceTimer = null;
						}
						resolveClosed();
					};
					graceTimer = setTimeout(() => {
						graceTimer = null;
						client.off("close", onClosed);
						terminateQuietly(client);
						resolveClosed();
					}, SHUTDOWN_CLOSE_GRACE_MS);
					client.once("close", onClosed);
					try {
						client.close(SHUTDOWN_CLOSE_CODE, SHUTDOWN_CLOSE_REASON);
					} catch {
						client.off("close", onClosed);
						terminateQuietly(client);
						onClosed();
					}
				}),
		),
	);
}
