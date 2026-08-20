import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LockOptions } from "proper-lockfile";
import * as lockfile from "proper-lockfile";
import { resolveLockfilePath } from "./lock-location";
import { lockfileFs } from "./lockfile-fs";
import { retryTransientFs } from "./transient-fs";

const DEFAULT_LOCK_STALE_MS = 10_000;
// The retry window MUST comfortably exceed DEFAULT_LOCK_STALE_MS. proper-lockfile
// only reclaims an abandoned lock once it has aged past `stale`, so an acquirer has
// to keep retrying past that point to steal it. The previous 200×25-50ms window was
// only 5-10s — shorter than the 10s stale threshold — so a lock left behind by a
// killed or event-loop-stalled writer could exhaust its retries *before* becoming
// reclaimable, throwing ELOCKED ("Lock file is already being held") and surfacing as
// an intermittent disconnect. 250×50-80ms guarantees at least ~12.5s of retries
// (> stale), so a stale lock is always stolen rather than erroring out; `randomize`
// jitters the backoff so concurrent waiters don't stampede the steal.
const DEFAULT_LOCK_RETRIES: NonNullable<LockOptions["retries"]> = {
	retries: 250,
	factor: 1,
	minTimeout: 50,
	maxTimeout: 80,
	randomize: true,
};

interface BaseLockRequest {
	path: string;
	staleMs?: number;
	retries?: LockOptions["retries"];
	onCompromised?: LockOptions["onCompromised"];
}

export interface FileLockRequest extends BaseLockRequest {
	type?: "file";
	lockfilePath?: string;
}

export interface DirectoryLockRequest extends BaseLockRequest {
	type: "directory";
	lockfileName?: string;
	lockfilePath?: string;
}

export type LockRequest = FileLockRequest | DirectoryLockRequest;

interface NormalizedLockRequest {
	path: string;
	options: LockOptions;
	sortKey: string;
}

export interface AtomicTextWriteOptions {
	lock?: LockRequest | null;
	executable?: boolean;
}

// proper-lockfile refreshes each held lock's mtime on an internal timer and, if it
// finds the lock was stolen or removed in the meantime, invokes `onCompromised`. Its
// built-in default RETHROWS, and because that throw originates from the timer callback
// (not from any awaited promise) it surfaces as an uncaughtException that kills the
// whole process. On a resource-starved host a long event-loop stall lets the lock go
// stale and another writer steal it — compromising ours through no fault of the
// in-flight operation — so the default behavior turns a routine contention event into a
// full server crash. Losing one lock must not take everyone down: log and keep running.
// The atomic temp-file + rename writes bound the worst case to a lost update of a JSON
// file that is trivially rebuilt, never a corrupt/partial file.
function defaultOnCompromised(error: Error): void {
	process.stderr.write(`[locked-file-system] lock compromised, continuing without it: ${error?.message ?? error}\n`);
}

function createLockOptions(request: LockRequest, lockfilePath: string): LockOptions {
	return {
		stale: request.staleMs ?? DEFAULT_LOCK_STALE_MS,
		retries: request.retries ?? DEFAULT_LOCK_RETRIES,
		realpath: false,
		lockfilePath,
		onCompromised: request.onCompromised ?? defaultOnCompromised,
		// Retries the lock-directory removal that Windows/Google-Drive-backed paths
		// intermittently fail with EBUSY; see lockfile-fs.ts.
		fs: lockfileFs,
	};
}

async function readFileIfExists(path: string): Promise<string | null> {
	try {
		return await retryTransientFs(() => readFile(path, "utf8"));
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

export class LockedFileSystem {
	private async normalizeLockRequest(request: LockRequest): Promise<NormalizedLockRequest> {
		// The lock lives on local disk, never beside the data. See lock-location.ts:
		// a mkdir-based mutex does not work on the synced volume the storage dir often
		// sits on. An explicit lockfilePath still wins, and `lockfileName` remains
		// honoured for directory locks that want a recognisable name.
		const lockfilePath =
			request.lockfilePath ??
			resolveLockfilePath(
				request.type === "directory" ? join(request.path, request.lockfileName ?? ".lock") : request.path,
			);
		await mkdir(dirname(lockfilePath), { recursive: true });

		if (request.type === "directory") {
			await mkdir(request.path, { recursive: true });
			return {
				path: request.path,
				options: createLockOptions(request, lockfilePath),
				sortKey: lockfilePath,
			};
		}

		await mkdir(dirname(request.path), { recursive: true });
		return {
			path: request.path,
			options: createLockOptions(request, lockfilePath),
			sortKey: lockfilePath,
		};
	}

	async withLock<T>(request: LockRequest, operation: () => Promise<T>): Promise<T> {
		return await this.withLocks([request], operation);
	}

	async withLocks<T>(requests: readonly LockRequest[], operation: () => Promise<T>): Promise<T> {
		const normalizedRequests = await Promise.all(
			requests.map(async (request) => await this.normalizeLockRequest(request)),
		);
		const orderedRequests = normalizedRequests
			.slice()
			.sort((left, right) => left.sortKey.localeCompare(right.sortKey));
		const releases: Array<() => Promise<void>> = [];
		try {
			for (const request of orderedRequests) {
				releases.push(await lockfile.lock(request.path, request.options));
			}
			return await operation();
		} finally {
			for (const release of releases.reverse()) {
				// Release best-effort: if a lock was compromised mid-operation (see
				// defaultOnCompromised), proper-lockfile's release rejects because the
				// lockfile is already gone. That must not mask the operation's result or
				// escape as an unhandled rejection, so swallow and log it.
				try {
					await release();
				} catch (releaseError) {
					const message = releaseError instanceof Error ? releaseError.message : String(releaseError);
					process.stderr.write(`[locked-file-system] failed to release lock (ignoring): ${message}\n`);
				}
			}
		}
	}

	async writeTextFileAtomic(path: string, content: string, options: AtomicTextWriteOptions = {}): Promise<void> {
		const lockRequest: LockRequest | null =
			options.lock === undefined
				? {
						path,
						type: "file" as const,
					}
				: options.lock;
		// Every mutation below carries transient-error backoff. The lock guards against
		// *other writers*; it does nothing about the antivirus scanner or sync agent
		// holding a handle on the file we just wrote, which is what EBUSY/EPERM/EACCES/
		// EINVAL on a synced volume actually is. `rename` is the one that matters most —
		// it is the atomic commit, and node:fs gives it no retry option at all.
		const writeOperation = async () => {
			const existingContent = await readFileIfExists(path);
			if (existingContent === content) {
				if (options.executable) {
					await retryTransientFs(() => chmod(path, 0o755));
				}
				return;
			}
			await retryTransientFs(() => mkdir(dirname(path), { recursive: true }));
			// The temp file MUST stay in the destination directory. Moving it to the OS
			// temp dir would make the rename cross-volume, which fails with EXDEV.
			const tempPath = `${path}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
			await retryTransientFs(() => writeFile(tempPath, content, "utf8"));
			try {
				await retryTransientFs(() => rename(tempPath, path));
			} catch (error) {
				// A failed rename leaves the temp file behind. Without this the storage dir
				// slowly fills with .tmp.<pid>.<ts>.<uuid> files that nothing ever collects.
				await rm(tempPath, { force: true, maxRetries: 3, retryDelay: 25 }).catch(() => {});
				throw error;
			}
			if (options.executable) {
				await retryTransientFs(() => chmod(path, 0o755));
			}
		};
		if (lockRequest) {
			await this.withLock(lockRequest, writeOperation);
			return;
		}
		await writeOperation();
	}

	async writeJsonFileAtomic(
		path: string,
		payload: unknown,
		options: Omit<AtomicTextWriteOptions, "executable"> = {},
	): Promise<void> {
		await this.writeTextFileAtomic(path, JSON.stringify(payload, null, 2), options);
	}

	async removePath(path: string, options: { lock: LockRequest; recursive?: boolean; force?: boolean }): Promise<void> {
		await this.withLock(options.lock, async () => {
			// maxRetries/retryDelay were absent here, so node:fs's own backoff over
			// EBUSY/EPERM never ran. retryTransientFs adds the codes rm declines to
			// retry (notably EINVAL, which is what a synced volume actually returns).
			await retryTransientFs(() =>
				rm(path, {
					recursive: options.recursive,
					force: options.force,
					maxRetries: 5,
					retryDelay: 25,
				}),
			);
		});
	}
}

export const lockedFileSystem = new LockedFileSystem();
