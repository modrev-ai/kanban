/**
 * Starts both the runtime server and Vite web UI dev server on an
 * automatically-selected free port. Use via `npm run dev:full` or the
 * VS Code "Dev (Full Stack)" launch config.
 */
import { createServer, connect } from "node:net";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const isWindows = process.platform === "win32";

async function ensureDependenciesInstalled() {
	const lockIndicator = join(process.cwd(), "node_modules", ".package-lock.json");
	try {
		await access(lockIndicator);
		return;
	} catch {
		// node_modules is missing; fall through to install below.
	}
	console.warn("node_modules not installed in this worktree. Running npm ci...");
	for (const args of [["ci"], ["--prefix", "web-ui", "ci"]]) {
		const result = spawnSync("npm", args, { stdio: "inherit", shell: isWindows });
		if (result.status !== 0) {
			process.exit(result.status ?? 1);
		}
	}
}

// Must run before importing any third-party modules so a fresh worktree with
// an empty node_modules can bootstrap itself using only node: built-ins.
await ensureDependenciesInstalled();

// Deferred until after ensureDependenciesInstalled so these resolve against
// the freshly-installed node_modules. Static top-level imports would be
// resolved before any code runs and fail with ERR_MODULE_NOT_FOUND.
const { default: treeKill } = await import("tree-kill");
const { default: open } = await import("open");

function findPort(start, reserved = new Set()) {
	if (reserved.has(start)) {
		return findPort(start + 1, reserved);
	}
	return new Promise((resolve) => {
		const srv = createServer();
		// Probe on 0.0.0.0 (all interfaces): Vite binds 0.0.0.0, so a loopback-only
		// probe would miss a port already held by another instance's dev server and
		// wrongly report it free. Binding 0.0.0.0 conflicts with any existing
		// listener on the port, loopback or not, so this detects them all.
		srv.listen(start, "0.0.0.0", () => {
			srv.close(() => resolve(start));
		});
		srv.on("error", () => resolve(findPort(start + 1, reserved)));
	});
}

// tsx watch has to typecheck-free compile the runtime entry on first boot, which
// on a cold cache can take well over 15s on Windows.
function waitForPort(port, timeout = 60000) {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		function attempt() {
			const sock = connect(port, "127.0.0.1");
			sock.on("connect", () => {
				sock.destroy();
				resolve();
			});
			sock.on("error", () => {
				if (Date.now() - start > timeout) {
					reject(new Error(`Runtime did not start within ${timeout}ms`));
				} else {
					setTimeout(attempt, 200);
				}
			});
		}
		attempt();
	});
}

// Honor explicit ports from the environment (e.g. the `dev:full` / `prod:full`
// scripts pin these) so instances land on deterministic ports; otherwise
// auto-select the first free ones.
const runtimePort = process.env.KANBAN_RUNTIME_PORT ? Number(process.env.KANBAN_RUNTIME_PORT) : await findPort(3484);
const webUiPort = process.env.KANBAN_WEB_UI_PORT
	? Number(process.env.KANBAN_WEB_UI_PORT)
	: await findPort(4173, new Set([runtimePort]));
const requestedDevFullArgs = process.argv.slice(2);
const withShutdownCleanupFlag = "--with-shutdown-cleanup";
const requestedRuntimeArgs = requestedDevFullArgs.filter((arg) => arg !== withShutdownCleanupFlag);
const hasExplicitSkipCleanupArg = requestedRuntimeArgs.some((arg) => arg === "--skip-shutdown-cleanup");
const shouldDefaultSkipShutdownCleanup = !requestedDevFullArgs.includes(withShutdownCleanupFlag);
const runtimeCliArgs = [
	"--port",
	String(runtimePort),
	"--no-open",
	...(shouldDefaultSkipShutdownCleanup && !hasExplicitSkipCleanupArg ? ["--skip-shutdown-cleanup"] : []),
	...requestedRuntimeArgs,
];

console.log(`\n  Runtime port: ${runtimePort}`);
console.log(`  Web UI:       http://127.0.0.1:${webUiPort}\n`);

const env = {
	NODE_ENV: "development",
	...process.env,
	KANBAN_RUNTIME_PORT: String(runtimePort),
	KANBAN_WEB_UI_PORT: String(webUiPort),
};

// Spawn tsx's JS entry with the current node binary instead of the .bin shim.
// On Windows the shim is a .cmd batch file, which Node refuses to spawn directly
// (EINVAL) and which otherwise needs shell: true -- that wraps the runtime in a
// cmd.exe process, so treeKill would only reap the wrapper and leave an orphaned
// runtime holding the port.
const tsxCli = join("node_modules", "tsx", "dist", "cli.mjs");
const runtime = spawn(process.execPath, [tsxCli, "watch", "src/cli.ts", ...runtimeCliArgs], {
	env,
	stdio: "inherit",
});

let vite;
let exiting = false;

function cleanup(exitCode = 0) {
	if (exiting) return;
	exiting = true;
	if (runtime.pid) treeKill(runtime.pid);
	if (vite?.pid) treeKill(vite.pid);
	process.exit(exitCode);
}

process.on("SIGTERM", () => cleanup(0));
process.on("SIGINT", () => cleanup(0));
runtime.on("exit", () => cleanup(1));

// Wait for runtime to accept connections before starting Vite
try {
	await waitForPort(runtimePort);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Failed to start runtime: ${message}`);
	cleanup(1);
}

vite = spawn("npm", ["run", "web:dev"], {
	env,
	stdio: "inherit",
	shell: isWindows,
});

vite.on("exit", () => cleanup(1));

// Auto-open browser after a short delay for Vite to start
setTimeout(() => {
	open(`http://127.0.0.1:${webUiPort}`);
}, 2000);
