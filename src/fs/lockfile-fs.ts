import { mkdir, realpath, rm, rmSync, stat, utimes } from "node:fs";

// proper-lockfile represents a held lock as a *directory*: it acquires with `mkdir`
// (atomic) and releases with `rmdir`. On Windows that release is not reliably
// immediate — an antivirus scanner, the search indexer, or (much worse) a virtual
// synced filesystem such as Google Drive File Stream can still hold a handle on the
// directory that was just created and touched, so the `rmdir` fails with EBUSY/EPERM
// even though nothing is actually wrong.
//
// proper-lockfile does not retry the release, so the lock directory survives. Every
// later writer of that file then has to wait out the full `stale` window before it may
// steal the abandoned lock, which surfaces as a multi-second stall plus a
// "[locked-file-system] failed to release lock (ignoring): EBUSY ... rmdir
// '<path>.lock'" line on stderr.
//
// `node:fs`'s own `rm`/`rmSync` already implement exactly the retry loop this needs —
// linear backoff over EBUSY, EMFILE, ENFILE, ENOTEMPTY and EPERM — so route the lock
// directory's removal through it instead of hand-rolling a backoff. `recursive` is
// required because `rm` refuses to remove a directory without it; the path is always
// the lock directory proper-lockfile derived from the target file, never user data.
// `force` makes a missing lock a no-op, which matches proper-lockfile's own
// ENOENT-tolerant `removeLock`.
const RELEASE_MAX_RETRIES = 8;
const RELEASE_RETRY_DELAY_MS = 50;

// The synchronous release only runs from proper-lockfile's process-exit handler, where
// every retry busy-waits and delays shutdown. Keep that budget small: a lock left
// behind at exit is already handled by the next acquirer's stale check.
const EXIT_RELEASE_MAX_RETRIES = 3;
const EXIT_RELEASE_RETRY_DELAY_MS = 20;

// The subset of the fs surface proper-lockfile drives through `options.fs`. It is
// passed as a single long-lived object because proper-lockfile's mtime-precision probe
// caches its result on the object identity; a fresh object per lock would re-probe
// (an extra utimes + stat round trip) on every acquisition.
export interface LockfileFs {
	mkdir: typeof mkdir;
	stat: typeof stat;
	utimes: typeof utimes;
	realpath: typeof realpath;
	rmdir: (path: string, callback: (error: NodeJS.ErrnoException | null) => void) => void;
	rmdirSync: (path: string) => void;
}

export const lockfileFs: LockfileFs = {
	mkdir,
	stat,
	utimes,
	realpath,
	rmdir(path, callback) {
		rm(
			path,
			{
				recursive: true,
				force: true,
				maxRetries: RELEASE_MAX_RETRIES,
				retryDelay: RELEASE_RETRY_DELAY_MS,
			},
			callback,
		);
	},
	rmdirSync(path) {
		rmSync(path, {
			recursive: true,
			force: true,
			maxRetries: EXIT_RELEASE_MAX_RETRIES,
			retryDelay: EXIT_RELEASE_RETRY_DELAY_MS,
		});
	},
};
