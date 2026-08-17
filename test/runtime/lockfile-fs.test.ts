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
	beforeEach(() => {
		fsSpies.rm.mockClear();
		fsSpies.rmSync.mockClear();
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
