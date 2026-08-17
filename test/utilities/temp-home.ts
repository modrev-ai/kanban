import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME_ENV_KEYS = ["HOME", "USERPROFILE", "KANBAN_STORAGE_DIR"] as const;

export interface TempHome {
	/** The sandboxed home directory. `os.homedir()` resolves here while it is active. */
	path: string;
	/** Restores the previous environment and removes the directory. */
	cleanup: () => void;
}

/**
 * Creates a throwaway home directory and points every input Kanban uses to locate
 * its own state at it.
 *
 * Setting `HOME` alone is NOT enough, and getting this wrong is destructive rather
 * than merely wrong:
 *
 * - `os.homedir()` reads `HOME` on POSIX but `USERPROFILE` on Windows. A HOME-only
 *   sandbox silently resolves to the developer's real home on Windows.
 * - `getKanbanStorageDir()` prefers the `KANBAN_STORAGE_DIR` env var, then a pointer
 *   file at `~/.cline/kanban-storage-dir`. So on a machine with a configured storage
 *   directory, a leaked `homedir()` sends tests at the *real* configured location —
 *   which for `resetAllState` and the hook-script writers means creating and deleting
 *   files in the user's live config.
 */
export function createTempHome(prefix = "kanban-test-home-"): TempHome {
	const path = mkdtempSync(join(tmpdir(), prefix));
	const previousEnv = new Map(HOME_ENV_KEYS.map((key) => [key, process.env[key]]));

	process.env.HOME = path;
	process.env.USERPROFILE = path;
	// Pinned explicitly so a developer who exports KANBAN_STORAGE_DIR in their shell
	// cannot override the sandbox: the env var outranks the pointer file, so without
	// this the whole temp home would be bypassed.
	process.env.KANBAN_STORAGE_DIR = join(path, ".cline", "kanban");

	return {
		path,
		cleanup: () => {
			for (const [key, value] of previousEnv) {
				if (value === undefined) {
					delete process.env[key];
					continue;
				}
				process.env[key] = value;
			}
			rmSync(path, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 });
		},
	};
}
