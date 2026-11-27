#!/usr/bin/env node
/**
 * Desktop postinstall. Rebuilds node-pty against Electron when a C++
 * toolchain exists. Without one, it keeps node-pty's shipped prebuilt binary
 * and skips only the rebuild. The pure logic takes injected dependencies (see
 * postinstall.d.mts for their types) so tests need no real toolchain. Side
 * effects run only when this file is executed directly.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(__dirname, "..");
const NODE_PTY_DIR = join(PACKAGE_DIR, "node_modules", "node-pty");
const ELECTRON_BUILDER_CLI = join(PACKAGE_DIR, "node_modules", "electron-builder", "cli.js");
const PATCH_SCRIPT = join(__dirname, "patch-node-pty.mjs");

export const FORCE_REBUILD_ENV = "KANBAN_FORCE_NATIVE_REBUILD";

const VSWHERE_ARGS = [
	"-products",
	"*",
	"-prerelease",
	"-requires",
	"Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
	"-property",
	"installationPath",
];

export function hasCppToolchain(deps) {
	const { platform, env, capture, fileExists } = deps;
	if (platform === "win32") {
		if (env.VCINSTALLDIR && env.VCINSTALLDIR.trim() !== "") return true;
		const programFilesX86 = env["ProgramFiles(x86)"];
		if (!programFilesX86) return false;
		const vswhere = win32.join(programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
		if (!fileExists(vswhere)) return false;
		const result = capture(vswhere, VSWHERE_ARGS);
		return result.status === 0 && result.stdout.trim() !== "";
	}
	if (platform === "darwin") {
		return capture("xcode-select", ["-p"]).status === 0;
	}
	if (capture("make", ["--version"]).status !== 0) return false;
	return capture("g++", ["--version"]).status === 0 || capture("c++", ["--version"]).status === 0;
}

/**
 * Returns the prebuilt directory for this platform-arch when it holds at
 * least one .node file, otherwise null.
 */
export function findPrebuiltDir(deps) {
	const dir = join(deps.nodePtyDir, "prebuilds", `${deps.platform}-${deps.arch}`);
	const hasNodeBinary = deps.listFiles(dir).some((name) => name.endsWith(".node"));
	return hasNodeBinary ? dir : null;
}

export function planPostinstall(deps) {
	if (deps.env[FORCE_REBUILD_ENV] === "1") {
		return { rebuild: true, reason: "forced" };
	}
	if (hasCppToolchain(deps)) {
		return { rebuild: true, reason: "toolchain" };
	}
	const prebuiltDir = findPrebuiltDir(deps);
	if (prebuiltDir !== null) {
		return { rebuild: false, reason: "prebuilt", prebuiltDir };
	}
	return { rebuild: true, reason: "no-prebuilt" };
}

function skipMessage(prebuiltDir) {
	return [
		"postinstall: skipping the node-pty rebuild: no C++ toolchain was found on this machine.",
		`postinstall: using node-pty's prebuilt binary from ${prebuiltDir}.`,
		"postinstall: packaged builds must be made on a machine with a C++ toolchain",
		"(Visual Studio C++ tools on Windows, Xcode Command Line Tools on macOS, make and g++ on Linux).",
		`postinstall: to force the rebuild anyway, set ${FORCE_REBUILD_ENV}=1 and run the install again.`,
	].join("\n");
}

export function runPostinstall(deps) {
	const plan = planPostinstall(deps);
	if (plan.rebuild) {
		if (plan.reason === "no-prebuilt") {
			deps.log("postinstall: no C++ toolchain and no prebuilt node-pty for this platform; attempting the rebuild.");
		}
		const rebuildStatus = deps.inherit(deps.nodeExecutable, [deps.electronBuilderCli, "install-app-deps"]);
		if (rebuildStatus !== 0) {
			deps.log(`postinstall: electron-builder install-app-deps failed (exit ${rebuildStatus}); patch-node-pty was not run.`);
			return { exitCode: rebuildStatus, plan };
		}
	} else {
		deps.log(skipMessage(plan.prebuiltDir));
	}
	const patchStatus = deps.inherit(deps.nodeExecutable, [deps.patchScript]);
	return { exitCode: patchStatus, plan };
}

function listDir(dir) {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function runCapture(file, args) {
	const result = spawnSync(file, args, {
		encoding: "utf8",
		windowsHide: true,
		stdio: ["ignore", "pipe", "ignore"],
	});
	return { status: result.status, stdout: result.stdout ?? "" };
}

function runInherit(file, args) {
	const result = spawnSync(file, args, { stdio: "inherit", windowsHide: true });
	if (result.error) {
		console.error(`postinstall: could not start ${file}: ${result.error.message}`);
	}
	if (result.signal) {
		console.error(`postinstall: ${file} was terminated by signal ${result.signal}`);
	}
	return result.status ?? 1;
}

function realDeps() {
	return {
		platform: process.platform,
		arch: process.arch,
		env: process.env,
		nodeExecutable: process.execPath,
		electronBuilderCli: ELECTRON_BUILDER_CLI,
		patchScript: PATCH_SCRIPT,
		nodePtyDir: NODE_PTY_DIR,
		fileExists: existsSync,
		listFiles: listDir,
		capture: runCapture,
		inherit: runInherit,
		log: (message) => console.log(message),
	};
}

const isDirectRun = pathToFileURL(process.argv[1] ?? "").href === import.meta.url;
if (isDirectRun) {
	const result = runPostinstall(realDeps());
	process.exitCode = result.exitCode;
}
