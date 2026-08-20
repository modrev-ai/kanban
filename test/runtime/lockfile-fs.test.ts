import type * as nodeFs from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTempDir } from "../utilities/temp-dir";

const fsSpies = vi.hoisted(() => ({
	rm: vi.fn(),
	rmSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = (await importOriginal()) as typeof nodeFs;
	fsSpies.rm.mockImplementation(actual.rm);
	fsSpies.rmSync.mockImplementation(actual.rmSync);
	return { ...actual, rm: fsSpies.rm, rmSync: fsSpies.rmSync };
});

import { lockfileFs } from "../../src/fs/lockfile-fs";

describe("lockfileFs", () => {
	beforeEach(async () => {
		// Reset, not just clear: these tests install failing implementations, and a
		// leaked one would silently break every later test in the file.
		const actual = (await vi.importActual("node:fs")) as typeof nodeFs;
		fsSpies.rm.mockReset();
		fsSpies.rmSync.mockReset();
		fsSpies.rm.mockImplementation(actual.rm);
		fsSpies.rmSync.mockImplementation(actual.rmSync);
	});

	it("removes a lock directory and reports success", async () => {
		const tempDir = createTempDir("kanban-lockfile-fs-");
		try {
			const lockPath = join(tempDir.path, "index.json.lock");
			mkdirSync(lockPath);

			await new Promise<void>((resolve, reject) => {
				lockfileFs.rmdir(lockPath, (error) => (error ? reject(error) : resolve()));
			});

			expect(existsSync(lockPath)).toBe(false);
		} finally {
			tempDir.cleanup();
		}
	});

	it("retries the removal so a transiently busy lock directory is not left behind", async () => {
		const tempDir = createTempDir("kanban-lockfile-fs-");
		try {
			const lockPath = join(tempDir.path, "index.json.lock");
			mkdirSync(lockPath);

			await new Promise<void>((resolve, reject) => {
				lockfileFs.rmdir(lockPath, (error) => (error ? reject(error) : resolve()));
			});

			// The EBUSY that Windows and Google-Drive-backed paths throw on rmdir is
			// transient, so the removal MUST carry node:fs's retry budget. Without it
			// proper-lockfile abandons the lock directory and every later writer stalls
			// for the full stale window before it may steal it.
			const options = fsSpies.rm.mock.calls[0]?.[1] as Record<string, unknown>;
			expect(options.recursive).toBe(true);
			expect(options.force).toBe(true);
			expect(options.maxRetries).toBeGreaterThan(0);
			expect(options.retryDelay).toBeGreaterThan(0);
		} finally {
			tempDir.cleanup();
		}
	});

	// node:fs's own rm retry loop covers only EBUSY, EMFILE, ENFILE, ENOTEMPTY and
	// EPERM. Google Drive File Stream fails the release with EINVAL from the lstat
	// inside rm's recursive walk, so without a second backoff the lock directory
	// survives and the next writer stalls for the whole stale window.
	function errnoError(code: string, syscall: string, path: string): NodeJS.ErrnoException {
		const error = new Error(`${code}: simulated, ${syscall} '${path}'`) as NodeJS.ErrnoException;
		error.code = code;
		error.syscall = syscall;
		error.path = path;
		return error;
	}

	it("retries a lock release that fails with EINVAL, the code node:fs rm does not retry", async () => {
		const tempDir = createTempDir("kanban-lockfile-fs-");
		try {
			const lockPath = join(tempDir.path, "index.json.lock");
			mkdirSync(lockPath);

			const actual = (await vi.importActual("node:fs")) as typeof nodeFs;
			let failuresLeft = 3;
			fsSpies.rm.mockImplementation(((path, options, callback) => {
				if (failuresLeft > 0) {
					failuresLeft -= 1;
					queueMicrotask(() => callback(errnoError("EINVAL", "lstat", String(path))));
					return;
				}
				actual.rm(path, options, callback);
			}) as typeof nodeFs.rm);

			await new Promise<void>((resolve, reject) => {
				lockfileFs.rmdir(lockPath, (error) => (error ? reject(error) : resolve()));
			});

			expect(failuresLeft).toBe(0);
			expect(fsSpies.rm).toHaveBeenCalledTimes(4);
			expect(existsSync(lockPath)).toBe(false);
		} finally {
			tempDir.cleanup();
		}
	});

	it("surfaces the error once the EINVAL retry budget is exhausted", async () => {
		const tempDir = createTempDir("kanban-lockfile-fs-");
		try {
			const lockPath = join(tempDir.path, "index.json.lock");
			mkdirSync(lockPath);

			fsSpies.rm.mockImplementation(((path, _options, callback) => {
				queueMicrotask(() => callback(errnoError("EINVAL", "lstat", String(path))));
			}) as typeof nodeFs.rm);

			await expect(
				new Promise<void>((resolve, reject) => {
					lockfileFs.rmdir(lockPath, (error) => (error ? reject(error) : resolve()));
				}),
			).rejects.toMatchObject({ code: "EINVAL" });
		} finally {
			tempDir.cleanup();
		}
	});

	it("does not retry an error node:fs rm already handles or that is not transient", async () => {
		const tempDir = createTempDir("kanban-lockfile-fs-");
		try {
			const lockPath = join(tempDir.path, "index.json.lock");
			mkdirSync(lockPath);

			fsSpies.rm.mockImplementation(((path, _options, callback) => {
				queueMicrotask(() => callback(errnoError("ENOTDIR", "rmdir", String(path))));
			}) as typeof nodeFs.rm);

			await expect(
				new Promise<void>((resolve, reject) => {
					lockfileFs.rmdir(lockPath, (error) => (error ? reject(error) : resolve()));
				}),
			).rejects.toMatchObject({ code: "ENOTDIR" });
			// Straight through: no second attempt for a code that is not transient here.
			expect(fsSpies.rm).toHaveBeenCalledTimes(1);
		} finally {
			tempDir.cleanup();
		}
	});

	it("retries the process-exit removal on EINVAL too", async () => {
		const tempDir = createTempDir("kanban-lockfile-fs-");
		try {
			const lockPath = join(tempDir.path, "index.json.lock");
			mkdirSync(lockPath);

			const actual = (await vi.importActual("node:fs")) as typeof nodeFs;
			let failuresLeft = 2;
			fsSpies.rmSync.mockImplementation(((path, options) => {
				if (failuresLeft > 0) {
					failuresLeft -= 1;
					throw errnoError("EINVAL", "lstat", String(path));
				}
				actual.rmSync(path, options);
			}) as typeof nodeFs.rmSync);

			lockfileFs.rmdirSync(lockPath);

			expect(failuresLeft).toBe(0);
			expect(existsSync(lockPath)).toBe(false);
		} finally {
			tempDir.cleanup();
		}
	});

	it("treats an already-removed lock directory as success", async () => {
		const tempDir = createTempDir("kanban-lockfile-fs-");
		try {
			const missingLockPath = join(tempDir.path, "never-created.lock");

			await expect(
				new Promise<void>((resolve, reject) => {
					lockfileFs.rmdir(missingLockPath, (error) => (error ? reject(error) : resolve()));
				}),
			).resolves.toBeUndefined();
		} finally {
			tempDir.cleanup();
		}
	});

	it("retries the process-exit removal too", () => {
		const tempDir = createTempDir("kanban-lockfile-fs-");
		try {
			const lockPath = join(tempDir.path, "index.json.lock");
			mkdirSync(lockPath);

			lockfileFs.rmdirSync(lockPath);

			expect(existsSync(lockPath)).toBe(false);
			const options = fsSpies.rmSync.mock.calls[0]?.[1] as Record<string, unknown>;
			expect(options.recursive).toBe(true);
			expect(options.force).toBe(true);
			expect(options.maxRetries).toBeGreaterThan(0);
		} finally {
			tempDir.cleanup();
		}
	});
});
