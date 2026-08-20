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

// `rm`'s own retry loop is not enough on its own, because it only covers EBUSY,
// EMFILE, ENFILE, ENOTEMPTY and EPERM. A Google Drive File Stream path actually
// fails the release with
//
//   EINVAL: invalid argument, lstat '<storage>/<file>.lock'
//
// from the lstat inside `rm`'s own recursive walk. EINVAL is absent from that list,
// so the backoff above never engages, the lock directory survives, and the next
// writer of that file waits out the entire `stale` window — measured at a p95 of
// ~11s and a max of ~12.9s against the real shared drive under four concurrent
// writers, versus a p50 of ~295ms when the release succeeds.
//
// So wrap the whole call in a second, narrower backoff over exactly the codes
// `rm` declines to retry. EINVAL is the one observed in the wild; EACCES is
// included because it is equally transient on a synced volume and equally
// uncovered. Everything else still surfaces immediately.
const UNCOVERED_RETRY_CODES = new Set(["EINVAL", "EACCES"]);
const UNCOVERED_MAX_RETRIES = 6;
const UNCOVERED_RETRY_DELAY_MS = 50;

// Linear, so the worst case is bounded and easy to reason about:
// 50+100+...+300 ≈ 1.05s, comfortably inside the 10s stale window this exists to
// avoid, and far below it even when `rm`'s internal budget is spent first.
function uncoveredRetryDelay(attempt: number): number {
	return UNCOVERED_RETRY_DELAY_MS * attempt;
}

function isUncoveredByRmRetry(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === "string" && UNCOVERED_RETRY_CODES.has(code);
}

// A synchronous sleep, needed only on the process-exit path where there is no event
// loop left to await. Atomics.wait on a never-notified buffer parks the thread for
// the timeout rather than spinning it.
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(milliseconds: number): void {
	Atomics.wait(sleepBuffer, 0, 0, milliseconds);
}

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
		let attempt = 0;
		const attemptRemoval = (): void => {
			rm(
				path,
				{
					recursive: true,
					force: true,
					maxRetries: RELEASE_MAX_RETRIES,
					retryDelay: RELEASE_RETRY_DELAY_MS,
				},
				(error) => {
					if (!error) {
						callback(null);
						return;
					}
					if (attempt < UNCOVERED_MAX_RETRIES && isUncoveredByRmRetry(error)) {
						attempt += 1;
						// Deliberately not unref'd: this timer must keep the loop alive long
						// enough to finish releasing the lock, or an otherwise-idle process
						// exits and leaves the directory behind — the exact failure this
						// retry exists to prevent.
						setTimeout(attemptRemoval, uncoveredRetryDelay(attempt));
						return;
					}
					callback(error);
				},
			);
		};
		attemptRemoval();
	},
	rmdirSync(path) {
		for (let attempt = 0; ; attempt += 1) {
			try {
				rmSync(path, {
					recursive: true,
					force: true,
					maxRetries: EXIT_RELEASE_MAX_RETRIES,
					retryDelay: EXIT_RELEASE_RETRY_DELAY_MS,
				});
				return;
			} catch (error) {
				// Shutdown budget stays tight, as above: at most a couple of short sleeps.
				// A lock still left behind here is handled by the next acquirer's stale check.
				if (attempt >= EXIT_RELEASE_MAX_RETRIES || !isUncoveredByRmRetry(error)) {
					throw error;
				}
				sleepSync(EXIT_RELEASE_RETRY_DELAY_MS);
			}
		}
	},
};
