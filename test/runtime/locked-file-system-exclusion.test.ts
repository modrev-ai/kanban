import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LockedFileSystem } from "../../src/fs/locked-file-system";
import { createTempDir } from "../utilities/temp-dir";

// Deliberately NO mocks in this file. `locked-file-system.test.ts` stubs
// proper-lockfile to test the wiring in isolation, which means it cannot say
// anything about whether locking actually excludes anyone. These tests drive the
// real lock, because the change under test moved where that lock lives.
describe("LockedFileSystem exclusion (real locks)", () => {
	it("writes the file without leaving a lock or temp file beside it", async () => {
		// The storage dir is frequently a Google Drive volume, where a mkdir-based
		// mutex does not work: mkdir keeps reporting EEXIST on an already-removed lock
		// directory for seconds, so acquirers burn their retry budget. The lock now
		// lives on local disk; the data must still land exactly where asked.
		const tempDir = createTempDir("kanban-locked-fs-excl-");
		try {
			const target = join(tempDir.path, "config.json");
			const fileSystem = new LockedFileSystem();

			await fileSystem.writeJsonFileAtomic(target, { hello: "world" });

			expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ hello: "world" });
			expect(readdirSync(tempDir.path)).toEqual(["config.json"]);
		} finally {
			tempDir.cleanup();
		}
	});

	it("still serializes concurrent writers to one file", async () => {
		// Relocating the lock must not weaken it for processes on this machine, which
		// is the case that actually occurs (the runtime plus its CLI subcommands).
		const tempDir = createTempDir("kanban-locked-fs-excl-");
		try {
			const target = join(tempDir.path, "counter.json");
			const fileSystem = new LockedFileSystem();
			writeFileSync(target, JSON.stringify({ runs: 0 }));

			await Promise.all(
				Array.from({ length: 8 }, async () => {
					await fileSystem.withLock({ path: target }, async () => {
						const current = JSON.parse(readFileSync(target, "utf8")) as { runs: number };
						// Yield inside the critical section: without real exclusion the
						// read-modify-write interleaves and the final count comes up short.
						await new Promise((resolve) => setTimeout(resolve, 1));
						writeFileSync(target, JSON.stringify({ runs: current.runs + 1 }));
					});
				}),
			);

			expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ runs: 8 });
		} finally {
			tempDir.cleanup();
		}
	});

	it("serializes two independent LockedFileSystem instances on one file", async () => {
		// The lock is derived from the target path, not held in instance state, so two
		// instances - standing in for two processes - must contend on the same lock.
		const tempDir = createTempDir("kanban-locked-fs-excl-");
		try {
			const target = join(tempDir.path, "shared.json");
			const first = new LockedFileSystem();
			const second = new LockedFileSystem();
			writeFileSync(target, JSON.stringify({ runs: 0 }));

			const bump = async (fileSystem: LockedFileSystem) => {
				await fileSystem.withLock({ path: target }, async () => {
					const current = JSON.parse(readFileSync(target, "utf8")) as { runs: number };
					await new Promise((resolve) => setTimeout(resolve, 1));
					writeFileSync(target, JSON.stringify({ runs: current.runs + 1 }));
				});
			};

			await Promise.all([bump(first), bump(second), bump(first), bump(second)]);

			expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ runs: 4 });
		} finally {
			tempDir.cleanup();
		}
	});
});
