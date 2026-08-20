#!/usr/bin/env node
/**
 * Header-rewriting reverse proxy that fronts a Kanban runtime on a public port.
 *
 * Why this exists
 * ---------------
 * The runtime gates every HTTP request and every WebSocket upgrade on the Host
 * and Origin headers (`src/server/middleware.ts`). `getAllowedHostHeaders()`
 * accepts only `localhost:PORT`, `127.0.0.1:PORT`, and — when bound to a
 * non-loopback address — the bound address itself. There is no env var to add
 * more. So a browser hitting `http://<oracle-public-ip>:4173` sends
 * `Host: <oracle-public-ip>:4173` and gets a flat `403 Host not allowed.`
 *
 * Binding the runtime to the public IP is not a fix either: on OCI the public
 * address is NAT'd by the internet gateway and is not present on the instance
 * NIC, so bind() fails with EADDRNOTAVAIL. Binding 0.0.0.0 makes
 * `isKanbanRemoteHost()` true, which turns on the interactive passcode gate and
 * still rejects the public Host header.
 *
 * This proxy resolves all of that: the runtime stays on 127.0.0.1 (loopback, so
 * no passcode and an allow-listed Host), and this process owns the public port,
 * rewriting Host/Origin to the loopback authority the runtime already trusts.
 *
 * Deliberately dependency-free — it runs from a plain `node` on the server with
 * nothing installed, so it cannot break when the app's dependency tree changes.
 *
 * Config (env):
 *   PROXY_HOST    address to bind        (default 0.0.0.0)
 *   PROXY_PORT    public port            (required)
 *   TARGET_HOST   runtime address        (default 127.0.0.1)
 *   TARGET_PORT   runtime port           (required)
 */

import { createServer, request } from "node:http";

function readPort(name) {
	const raw = process.env[name]?.trim();
	const port = Number.parseInt(raw ?? "", 10);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		console.error(`[kanban-proxy] ${name} must be an integer from 1-65535 (got ${JSON.stringify(raw)})`);
		process.exit(1);
	}
	return port;
}

const proxyHost = process.env.PROXY_HOST?.trim() || "0.0.0.0";
const proxyPort = readPort("PROXY_PORT");
const targetHost = process.env.TARGET_HOST?.trim() || "127.0.0.1";
const targetPort = readPort("TARGET_PORT");

// The authority the runtime's Host allowlist accepts, and the matching Origin.
const targetAuthority = `${targetHost}:${targetPort}`;
const targetOrigin = `http://${targetAuthority}`;

/**
 * Rewrites the two headers the runtime gates on. Everything else is forwarded
 * untouched, including cookies and Authorization.
 */
function rewriteHeaders(headers) {
	const rewritten = { ...headers, host: targetAuthority };
	// Only rewrite Origin when the client actually sent one. Same-origin fetches
	// omit it, and the runtime treats a missing Origin as allowed — forging one
	// here would be strictly worse than passing none.
	if (rewritten.origin !== undefined) {
		rewritten.origin = targetOrigin;
	}
	return rewritten;
}

const server = createServer((clientReq, clientRes) => {
	const proxyReq = request(
		{
			host: targetHost,
			port: targetPort,
			method: clientReq.method,
			path: clientReq.url,
			headers: rewriteHeaders(clientReq.headers),
		},
		(proxyRes) => {
			clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
			proxyRes.pipe(clientRes);
		},
	);

	proxyReq.on("error", (error) => {
		console.error(`[kanban-proxy] upstream error for ${clientReq.method} ${clientReq.url}: ${error.message}`);
		if (!clientRes.headersSent) {
			clientRes.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
		}
		clientRes.end(JSON.stringify({ error: "Kanban runtime is not reachable." }));
	});

	clientReq.on("error", () => proxyReq.destroy());
	clientReq.pipe(proxyReq);
});

// WebSocket upgrades carry the same Host/Origin gate, and the runtime runs it
// twice per upgrade (the state hub and the terminal bridge each listen for
// 'upgrade'), so getting these headers right matters as much as for plain HTTP.
server.on("upgrade", (clientReq, clientSocket, head) => {
	// Node attaches no 'error' listener to a raw upgrade socket; without one, a
	// peer vanishing mid-handshake turns an EPIPE into an unhandled 'error' event
	// that takes this process down.
	clientSocket.on("error", () => {});
	clientSocket.setNoDelay(true);

	const proxyReq = request({
		host: targetHost,
		port: targetPort,
		method: clientReq.method,
		path: clientReq.url,
		headers: rewriteHeaders(clientReq.headers),
	});

	proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
		proxySocket.on("error", () => {});
		proxySocket.setNoDelay(true);

		// Re-serialize the 101 response ourselves: at this layer Node hands us the
		// parsed headers, not the original bytes.
		const statusLine = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}`;
		const headerLines = [];
		for (const [key, value] of Object.entries(proxyRes.headers)) {
			if (Array.isArray(value)) {
				for (const entry of value) {
					headerLines.push(`${key}: ${entry}`);
				}
			} else if (value !== undefined) {
				headerLines.push(`${key}: ${value}`);
			}
		}
		clientSocket.write(`${statusLine}\r\n${headerLines.join("\r\n")}\r\n\r\n`);

		// Any bytes the parsers read past the header boundary must be replayed
		// before piping, or the first WebSocket frame in each direction is lost.
		if (proxyHead?.length) {
			proxySocket.unshift(proxyHead);
		}
		if (head?.length) {
			clientSocket.unshift(head);
		}

		proxySocket.pipe(clientSocket);
		clientSocket.pipe(proxySocket);
	});

	proxyReq.on("response", (proxyRes) => {
		// Upstream refused the upgrade (e.g. the runtime's own 403). Forward the
		// status instead of dropping the socket, so the browser reports something
		// better than an opaque 1006 abnormal closure.
		if (!clientSocket.destroyed && clientSocket.writable) {
			clientSocket.end(
				`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
			);
		}
	});

	proxyReq.on("error", (error) => {
		console.error(`[kanban-proxy] upstream websocket error for ${clientReq.url}: ${error.message}`);
		if (!clientSocket.destroyed && clientSocket.writable) {
			clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
		} else {
			clientSocket.destroy();
		}
	});

	proxyReq.end();
});

server.on("clientError", (_error, socket) => {
	if (!socket.destroyed && socket.writable) {
		socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
	}
});

for (const signal of ["SIGTERM", "SIGINT"]) {
	process.on(signal, () => {
		server.close(() => process.exit(0));
		// systemd sends SIGTERM on restart; long-lived WebSocket connections would
		// otherwise hold the close() open past the stop timeout.
		setTimeout(() => process.exit(0), 5000).unref();
	});
}

server.listen(proxyPort, proxyHost, () => {
	console.log(`[kanban-proxy] listening on ${proxyHost}:${proxyPort} -> ${targetAuthority} (Host/Origin rewritten)`);
});
