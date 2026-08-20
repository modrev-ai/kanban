import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getLockDir, resolveLockfilePath } from "../../src/fs/lock-location";

const ORIGINAL_LOCK_DIR = process.env.KANBAN_LOCK_DIR;

afterEach(() => {
	if (ORIGINAL_LOCK_DIR === undefined) {
		delete process.env.KANBAN_LOCK_DIR;
	} else {
		process.env.KANBAN_LOCK_DIR = ORIGINAL_LOCK_DIR;
	}
});

describe("lock location", () => {
	it("puts locks on local disk, not beside the data", () => {
		// The whole point: the storage dir is often a synced volume where a
		// mkdir-based mutex does not work, so the lock must not live next to the file.
		delete process.env.KANBAN_LOCK_DIR;
		const target = join("G:", "Shared drives", "team", "state", "config.json");

		const lockPath = resolveLockfilePath(target);

		expect(dirname(lockPath)).toBe(join(tmpdir(), "kanban-locks"));
		expect(lockPath.startsWith(dirname(target))).toBe(false);
	});

	it("is deterministic, so separate processes agree on one lock per file", () => {
		delete process.env.KANBAN_LOCK_DIR;
		const target = join(tmpdir(), "kanban-lock-location", "index.json");

		expect(resolveLockfilePath(target)).toBe(resolveLockfilePath(target));
	});

	it("resolves relative and absolute spellings of one file to the same lock", () => {
		delete process.env.KANBAN_LOCK_DIR;
		const relative = join("test-fixtures", "index.json");

		expect(resolveLockfilePath(relative)).toBe(resolveLockfilePath(resolve(relative)));
	});

	it("gives different files different locks", () => {
		delete process.env.KANBAN_LOCK_DIR;
		const base = join(tmpdir(), "kanban-lock-location");

		expect(resolveLockfilePath(join(base, "a.json"))).not.toBe(resolveLockfilePath(join(base, "b.json")));
	});

	it("keeps a readable prefix so an abandoned lock can be traced back", () => {
		delete process.env.KANBAN_LOCK_DIR;

		expect(resolveLockfilePath(join(tmpdir(), "workspaces", "index.json"))).toMatch(
			/index\.json\.[0-9a-f]{32}\.lock$/,
		);
	});

	it("honours KANBAN_LOCK_DIR for hosts where the temp dir is unsuitable", () => {
		const override = join(tmpdir(), "custom-kanban-locks");
		process.env.KANBAN_LOCK_DIR = override;

		expect(getLockDir()).toBe(override);
		expect(dirname(resolveLockfilePath(join(tmpdir(), "index.json")))).toBe(override);
	});
});
