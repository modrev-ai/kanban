import { describe, expect, it } from "vitest";

// The postinstall script is an `.mjs` whose pure logic takes injected
// dependencies. These tests drive it with fakes, so they never touch a real
// toolchain, node_modules, or the filesystem.
import {
	FORCE_REBUILD_ENV,
	planPostinstall,
	runPostinstall,
	type PostinstallDeps,
} from "../scripts/postinstall.mjs";

const PREBUILT_FILES = ["pty.node", "conpty.node"];

interface Harness {
	deps: PostinstallDeps;
	calls: Array<{ file: string; args: string[] }>;
	logs: string[];
}

function makeHarness(overrides: Partial<PostinstallDeps> & { rebuildStatus?: number; patchStatus?: number } = {}): Harness {
	const calls: Array<{ file: string; args: string[] }> = [];
	const logs: string[] = [];
	const { rebuildStatus = 0, patchStatus = 0, ...rest } = overrides;
	const deps: PostinstallDeps = {
		platform: "linux",
		arch: "x64",
		env: {},
		nodeExecutable: "node-exe",
		electronBuilderCli: "/fake/electron-builder/cli.js",
		patchScript: "/fake/patch-node-pty.mjs",
		nodePtyDir: "/fake/node-pty",
		fileExists: () => false,
		listFiles: () => [],
		capture: () => ({ status: 1, stdout: "" }),
		inherit: (file: string, args: string[]) => {
			calls.push({ file, args });
			return args[0] === "/fake/electron-builder/cli.js" ? rebuildStatus : patchStatus;
		},
		log: (message: string) => {
			logs.push(message);
		},
		...rest,
	};
	return { deps, calls, logs };
}

function rebuildRan(calls: Harness["calls"]): boolean {
	return calls.some((c) => c.args[0] === "/fake/electron-builder/cli.js");
}

function patchRan(calls: Harness["calls"]): boolean {
	return calls.some((c) => c.args[0] === "/fake/patch-node-pty.mjs");
}

describe("postinstall", () => {
	describe("toolchain detection", () => {
		it("win32: vswhere reports an installation -> rebuild runs, then patch", () => {
			const h = makeHarness({
				platform: "win32",
				env: { "ProgramFiles(x86)": "C:\\Program Files (x86)" },
				fileExists: () => true,
				capture: (file) =>
					file.endsWith("vswhere.exe")
						? { status: 0, stdout: "C:\\VS\\2022\\Community\r\n" }
						: { status: 1, stdout: "" },
			});

			const result = runPostinstall(h.deps);

			expect(result.plan).toEqual({ rebuild: true, reason: "toolchain" });
			expect(rebuildRan(h.calls)).toBe(true);
			expect(h.calls[0]).toEqual({ file: "node-exe", args: ["/fake/electron-builder/cli.js", "install-app-deps"] });
			expect(patchRan(h.calls)).toBe(true);
			expect(result.exitCode).toBe(0);
		});

		it("win32: VCINSTALLDIR set -> rebuild runs without consulting vswhere", () => {
			const h = makeHarness({
				platform: "win32",
				env: { VCINSTALLDIR: "C:\\VS\\VC\\" },
				capture: () => {
					throw new Error("vswhere must not run when VCINSTALLDIR is set");
				},
			});

			const result = runPostinstall(h.deps);

			expect(result.plan).toEqual({ rebuild: true, reason: "toolchain" });
			expect(rebuildRan(h.calls)).toBe(true);
			expect(patchRan(h.calls)).toBe(true);
		});

		it("darwin: xcode-select -p exits 0 -> rebuild runs, then patch", () => {
			const h = makeHarness({
				platform: "darwin",
				arch: "arm64",
				capture: (file) => (file === "xcode-select" ? { status: 0, stdout: "/Library/Developer/CommandLineTools" } : { status: 1, stdout: "" }),
			});

			const result = runPostinstall(h.deps);

			expect(result.plan).toEqual({ rebuild: true, reason: "toolchain" });
			expect(rebuildRan(h.calls)).toBe(true);
			expect(patchRan(h.calls)).toBe(true);
		});

		it("linux: make and g++ present -> rebuild runs, then patch", () => {
			const h = makeHarness({
				platform: "linux",
				capture: (file) => ({ status: file === "make" || file === "g++" ? 0 : 1, stdout: "" }),
			});

			const result = runPostinstall(h.deps);

			expect(result.plan).toEqual({ rebuild: true, reason: "toolchain" });
			expect(rebuildRan(h.calls)).toBe(true);
			expect(patchRan(h.calls)).toBe(true);
		});
	});

	describe("no toolchain", () => {
		it("with a prebuilt for this platform-arch -> rebuild skipped, message printed, patch still runs", () => {
			const h = makeHarness({
				platform: "win32",
				arch: "x64",
				listFiles: (dir) => (dir.replace(/\\/g, "/").endsWith("prebuilds/win32-x64") ? PREBUILT_FILES : []),
			});

			const result = runPostinstall(h.deps);

			expect(result.plan.rebuild).toBe(false);
			expect(rebuildRan(h.calls)).toBe(false);
			expect(patchRan(h.calls)).toBe(true);
			expect(result.exitCode).toBe(0);
			const message = h.logs.join("\n");
			expect(message).toContain("skipping the node-pty rebuild");
			expect(message).toContain("prebuilt binary");
			expect(message).toContain("C++ toolchain");
			expect(message).toContain(`${FORCE_REBUILD_ENV}=1`);
		});

		it("without a prebuilt for this platform-arch -> rebuild runs (fails loudly without a compiler)", () => {
			const h = makeHarness({ platform: "win32", listFiles: () => [] });

			const result = runPostinstall(h.deps);

			expect(result.plan).toEqual({ rebuild: true, reason: "no-prebuilt" });
			expect(rebuildRan(h.calls)).toBe(true);
			expect(patchRan(h.calls)).toBe(true);
		});

		it("a prebuilt directory without any .node file does not count as a prebuilt", () => {
			const h = makeHarness({ platform: "linux", listFiles: () => ["README.md"] });

			const plan = planPostinstall(h.deps);

			expect(plan).toEqual({ rebuild: true, reason: "no-prebuilt" });
		});
	});

	describe("forced rebuild", () => {
		it("KANBAN_FORCE_NATIVE_REBUILD=1 with a prebuilt present -> rebuild runs", () => {
			const h = makeHarness({
				platform: "win32",
				env: { [FORCE_REBUILD_ENV]: "1" },
				listFiles: () => PREBUILT_FILES,
			});

			const result = runPostinstall(h.deps);

			expect(result.plan).toEqual({ rebuild: true, reason: "forced" });
			expect(rebuildRan(h.calls)).toBe(true);
			expect(patchRan(h.calls)).toBe(true);
		});
	});

	describe("failure handling", () => {
		it("rebuild failure -> non-zero result, patch is not run", () => {
			const h = makeHarness({
				platform: "linux",
				capture: (file) => ({ status: file === "make" || file === "g++" ? 0 : 1, stdout: "" }),
				rebuildStatus: 7,
			});

			const result = runPostinstall(h.deps);

			expect(rebuildRan(h.calls)).toBe(true);
			expect(patchRan(h.calls)).toBe(false);
			expect(result.exitCode).toBe(7);
		});

		it("patch failure after a skipped rebuild -> non-zero result", () => {
			const h = makeHarness({
				platform: "win32",
				listFiles: () => PREBUILT_FILES,
				patchStatus: 3,
			});

			const result = runPostinstall(h.deps);

			expect(result.exitCode).toBe(3);
		});
	});
});
