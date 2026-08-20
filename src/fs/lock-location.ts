import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

// Where proper-lockfile's lock directories live.
//
// They are deliberately NOT placed next to the data they guard. Kanban's storage
// dir is frequently a virtual synced volume (Google Drive File Stream), and a
// `mkdir`-based mutex does not work there. Measured on the real shared drive with
// four concurrent writers on one file:
//
//   metric                      Google Drive        local disk
//   mkdir calls per 100 locks   978 (878 EEXIST)    183 (83 EEXIST)
//   stat errors                 EINVAL x11          ENOENT x4 (normal)
//   acquire avg / max           713ms / 21,513ms    57ms / 1,304ms
//   acquires over 5s            5 / 100             0 / 100
//
// Drive keeps reporting EEXIST from `mkdir` on an already-removed lock directory
// for seconds after the removal succeeded, and intermittently fails `stat` with
// EINVAL, so an acquirer burns its retry budget waiting for the virtual
// filesystem's view to converge. No amount of retrying fixes that; the lock has to
// live on a filesystem with immediate, coherent metadata.
//
// TRADE-OFF, worth being explicit about: a machine-local lock no longer excludes a
// *different machine* writing the same shared-drive file. That exclusion was
// already illusory — the EEXIST staleness above means two machines could both
// observe the lock as absent — but it is a real change in what the lock claims to
// guarantee. Processes on one machine, which is the case that actually occurs (the
// runtime plus its CLI subcommands), remain correctly serialized because they
// share this directory.
//
// KANBAN_LOCK_DIR overrides the location, for a setup where the default temp dir
// is unsuitable (a RAM disk that is wiped mid-run, a locked-down temp policy).

const LOCK_DIR_ENV = "KANBAN_LOCK_DIR";
const DEFAULT_LOCK_DIR_NAME = "kanban-locks";

export function getLockDir(): string {
	const override = process.env[LOCK_DIR_ENV]?.trim();
	if (override && override.length > 0) {
		return resolve(override);
	}
	return join(tmpdir(), DEFAULT_LOCK_DIR_NAME);
}

/**
 * Maps a target path to its lock file path.
 *
 * The name is a hash of the absolute target path, so two different files never
 * collide and the same file always resolves to the same lock across processes —
 * which is what makes the machine-local lock still mutually exclusive. A readable
 * prefix is kept so an abandoned lock can be traced back to its file by eye.
 *
 * Note the hash is taken over the resolved path, so `./a/b.json` and an absolute
 * spelling of the same file share one lock.
 */
export function resolveLockfilePath(targetPath: string): string {
	const absolute = resolve(targetPath);
	// Case-insensitive on Windows: the same file reached as C:\X and c:\x must not
	// end up with two different locks.
	const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
	const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
	const readable = basename(absolute)
		.replace(/[^a-zA-Z0-9._-]/g, "_")
		.slice(0, 40);
	return join(getLockDir(), `${readable}.${digest}.lock`);
}
