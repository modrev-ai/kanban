import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import {
	getKanbanRuntimeHost,
	getKanbanRuntimePort,
	isKanbanRemoteHost,
	isKanbanRuntimeHttps,
} from "../core/runtime-endpoint";

export type CorsDecision =
	| { kind: "allow"; origin: string | null }
	| { kind: "preflight"; origin: string }
	| { kind: "reject"; origin: string };

export interface CorsGateInput {
	method: string | undefined;
	originHeader: string | undefined;
	allowedOrigins: ReadonlySet<string>;
}

const isDev = process.env.NODE_ENV === "development";
// The Vite dev-server port, configurable via KANBAN_WEB_UI_PORT (default 4173).
// Sourcing it from the env — instead of hardcoding 4173 — lets a second dev
// instance on another port (e.g. 4174) pass the dev-only Host/Origin gates.
const devWebUiPort = process.env.KANBAN_WEB_UI_PORT?.trim() || "4173";

export function evaluateCors(input: CorsGateInput): CorsDecision {
	const origin = input.originHeader || null;
	const isPreflight = input.method === "OPTIONS";

	if (origin === null) {
		return { kind: "allow", origin: null };
	}

	const isDevServer =
		isDev && (origin === `http://localhost:${devWebUiPort}` || origin === `http://127.0.0.1:${devWebUiPort}`);

	if (!input.allowedOrigins.has(origin) && !isDevServer) {
		return { kind: "reject", origin };
	}

	if (isPreflight) {
		return { kind: "preflight", origin };
	}

	return { kind: "allow", origin };
}

export interface HostGateInput {
	hostHeader: string | undefined;
	allowedHosts: ReadonlySet<string>;
}

export type HostDecision = { kind: "allow" } | { kind: "reject"; host: string | null };

export function evaluateHost(input: HostGateInput): HostDecision {
	if (!input.hostHeader) {
		return { kind: "reject", host: null };
	}

	if (!input.allowedHosts.has(input.hostHeader.toLowerCase())) {
		return { kind: "reject", host: input.hostHeader };
	}

	return { kind: "allow" };
}

export function getAllowedHostHeaders(): ReadonlySet<string> {
	const port = getKanbanRuntimePort();
	const boundHost = getKanbanRuntimeHost().toLowerCase();
	const allowed = new Set<string>();
	const addHostPort = (host: string) => {
		allowed.add(`${host}:${port}`);
	};

	// Loopback host headers are always allowed. They cannot be forged by a
	// DNS-rebinding attacker (the browser sends the URL's own hostname as Host,
	// and no external domain resolves to the literal "localhost"/"127.0.0.1"), and
	// allowing them lets a server that binds 0.0.0.0 but is published only on the
	// host's loopback — e.g. the Docker image on Docker Desktop — still be reached
	// at http://localhost:PORT from any browser.
	addHostPort("localhost");
	addHostPort("127.0.0.1");

	// When bound to a non-loopback address (0.0.0.0 in a container, or a LAN IP),
	// also accept that address so direct hits to the bound host work.
	if (isKanbanRemoteHost()) {
		addHostPort(boundHost);
	}

	if (isDev) {
		// Vite dev server host:port (KANBAN_WEB_UI_PORT, default 4173)
		allowed.add(`localhost:${devWebUiPort}`);
		allowed.add(`127.0.0.1:${devWebUiPort}`);
	}
	return allowed;
}

// The Origin allowlist mirrors the Host allowlist: loopback origins are always
// accepted so the app's own fetch/WebSocket calls work when the board is opened
// at http://localhost:PORT (the browser stamps that as the Origin header), and
// the bound-host origin is accepted too when bound to a non-loopback address.
export function getAllowedOrigins(): ReadonlySet<string> {
	const port = getKanbanRuntimePort();
	const scheme = isKanbanRuntimeHttps() ? "https" : "http";
	const boundHost = getKanbanRuntimeHost().toLowerCase();
	const allowed = new Set<string>();
	const addOrigin = (host: string) => {
		allowed.add(`${scheme}://${host}:${port}`);
	};

	addOrigin("localhost");
	addOrigin("127.0.0.1");
	if (isKanbanRemoteHost()) {
		addOrigin(boundHost);
	}
	return allowed;
}

const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].join(", ");
const ALLOWED_HEADERS = ["Authorization", "Content-Type", "X-Kanban-Workspace-Id"].join(", ");
const PREFLIGHT_MAX_AGE_SECONDS = "600";

function applyAllowedOriginHeaders(res: ServerResponse, origin: string): void {
	res.setHeader("Access-Control-Allow-Origin", origin);
	res.setHeader("Vary", "Origin");
	res.setHeader("Access-Control-Allow-Credentials", "true");
}

function rejectRequest(res: ServerResponse, message: string): { end: boolean } {
	res.writeHead(403, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	res.end(JSON.stringify({ error: message }));
	return { end: true };
}

/**
 * Answers a WebSocket upgrade we are not going to complete, then closes the
 * connection cleanly.
 *
 * `socket.destroy()` aborts the TCP connection with an RST. That discards the status
 * line we just wrote, so the peer never learns *why* the upgrade was refused: a proxy
 * in front of the runtime — the Vite dev server proxies `/api` with `ws: true` — can
 * only report `ws proxy error: Error: read ECONNRESET`, and the browser sees an opaque
 * 1006 abnormal closure. Writing the response and half-closing with FIN turns an
 * undiagnosable reset into the 401/403/404 that actually explains the rejection.
 */
export function endUpgradeSocket(socket: Duplex, statusLine: string): void {
	// Node's http server attaches no 'error' listener to a raw upgrade socket, so a
	// peer that disappears mid-handshake turns an EPIPE/ECONNRESET write into an
	// unhandled 'error' event, which takes the whole runtime down.
	socket.on("error", () => {});
	if (socket.destroyed || !socket.writable) {
		socket.destroy();
		return;
	}
	socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => {
		socket.destroy();
	});
}

function rejectSocket(socket: Duplex, reason: string): { end: boolean } {
	// A refused upgrade is otherwise silent on the runtime side, which leaves the
	// proxy's connection error as the only evidence that anything happened.
	process.stderr.write(`[runtime-server] rejected websocket upgrade: ${reason}\n`);
	endUpgradeSocket(socket, "403 Forbidden");
	return { end: true };
}

export function handleHttpRequest(req: IncomingMessage, res: ServerResponse): { end: boolean } {
	const hostDecision = evaluateHost({
		hostHeader: req.headers.host,
		allowedHosts: getAllowedHostHeaders(),
	});
	if (hostDecision.kind === "reject") {
		return rejectRequest(res, "Host not allowed.");
	}

	const corsDecision = evaluateCors({
		method: req.method,
		originHeader: req.headers.origin,
		allowedOrigins: getAllowedOrigins(),
	});

	switch (corsDecision.kind) {
		case "allow": {
			if (corsDecision.origin !== null) {
				applyAllowedOriginHeaders(res, corsDecision.origin);
			}
			return { end: false };
		}
		case "preflight": {
			applyAllowedOriginHeaders(res, corsDecision.origin);
			res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
			res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
			res.setHeader("Access-Control-Max-Age", PREFLIGHT_MAX_AGE_SECONDS);
			res.writeHead(204);
			res.end();
			return { end: true };
		}
		case "reject": {
			return rejectRequest(res, "Origin not allowed.");
		}
	}
}

interface GatedUpgradeRequest extends IncomingMessage {
	__kanbanUpgradeGate?: { end: boolean };
}

function evaluateSocketUpgrade(request: IncomingMessage, socket: Duplex): { end: boolean } {
	const hostDecision = evaluateHost({
		hostHeader: request.headers.host,
		allowedHosts: getAllowedHostHeaders(),
	});
	if (hostDecision.kind === "reject") {
		return rejectSocket(socket, `Host ${hostDecision.host ?? "(missing)"} not allowed.`);
	}

	const corsDecision = evaluateCors({
		method: request.method,
		originHeader: request.headers.origin,
		allowedOrigins: getAllowedOrigins(),
	});
	if (corsDecision.kind === "reject") {
		return rejectSocket(socket, `Origin ${corsDecision.origin} not allowed.`);
	}

	return { end: false };
}

export function handleSocketUpgrade(request: IncomingMessage, socket: Duplex): { end: boolean } {
	// The runtime-state and terminal bridges both register an 'upgrade' listener, so
	// every upgrade runs this gate twice. Memoize the decision on the request: without
	// it a rejected upgrade is rejected twice, and the second write lands on an
	// already-destroyed socket as an unhandled 'error' event.
	const gatedRequest = request as GatedUpgradeRequest;
	const memoizedDecision = gatedRequest.__kanbanUpgradeGate;
	if (memoizedDecision) {
		return memoizedDecision;
	}
	const decision = evaluateSocketUpgrade(request, socket);
	gatedRequest.__kanbanUpgradeGate = decision;
	return decision;
}
