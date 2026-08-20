// Retry helper for filesystem mutations that can fail transiently.
//
// On Windows, and far more often on a virtual synced volume such as Google Drive
// File Stream, an antivirus scanner, the search indexer, or the sync agent can hold
// a handle on a file that was just written. The syscall then fails with EBUSY,
// EPERM, EACCES or EINVAL even though nothing is wrong and the same call succeeds a
// moment later.
//
// `node:fs`'s `rm` has its own retry loop for some of this, but it is the only call
// that does: `rename`, `writeFile`, `chmod` and `mkdir` take no `maxRetries`, so
// anything built from them needs backoff supplied around the call. See
// `lockfile-fs.ts` for the lock directory's equivalent, which is deliberately
// narrower because `rm` already handles part of this set internally.
//
// ENOENT is pointedly absent: a missing file is a real answer, not a transient
// failure, and retrying it would turn a fast correct result into a slow one.

const TRANSIENT_FS_ERROR_CODES = new Set(["EBUSY", "EPERM", "EACCES", "EINVAL", "EMFILE", "ENFILE", "ENOTEMPTY"]);

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_BASE_DELAY_MS = 25;

export function isTransientFsError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === "string" && TRANSIENT_FS_ERROR_CODES.has(code);
}

export interface TransientFsRetryOptions {
	/** Total attempts including the first. */
	maxAttempts?: number;
	/** Linear step; attempt N waits N * this. */
	baseDelayMs?: number;
}

async function delay(milliseconds: number): Promise<void> {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

/**
 * Runs `operation`, retrying it while it fails with a transient filesystem error.
 *
 * Linear backoff, so the worst case is easy to reason about and bounded: the
 * default 6 attempts at a 25ms step wait 25+50+75+100+125 = 375ms in total before
 * giving up. That is deliberately far below the 10s lock stale window, so a write
 * that is genuinely wedged still surfaces its error long before the lock guarding
 * it can be considered abandoned.
 *
 * The last error is rethrown unchanged, so callers still see the real errno and
 * path rather than a wrapper.
 */
export async function retryTransientFs<T>(
	operation: () => Promise<T>,
	options: TransientFsRetryOptions = {},
): Promise<T> {
	const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

	for (let attempt = 1; ; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			if (attempt >= maxAttempts || !isTransientFsError(error)) {
				throw error;
			}
			await delay(baseDelayMs * attempt);
		}
	}
}
