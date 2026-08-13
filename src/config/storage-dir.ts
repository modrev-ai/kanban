// Resolves the base directory where Kanban stores its own data: the global
// `config.json` and the project-progress state (`workspaces/index.json` and the
// per-workspace board/session files). This is user-configurable so the data can
// live somewhere other than the default `~/.cline/kanban`.
//
// Resolution precedence (highest first):
//   1. `KANBAN_STORAGE_DIR` environment variable
//   2. the pointer file written by the settings UI (see setKanbanStorageDir)
//   3. the default `~/.cline/kanban`
//
// The pointer file lives at a FIXED location (`~/.cline/kanban-storage-dir`) that
// is never affected by the setting. That solves the chicken-and-egg problem: the
// config file cannot record its own location, so the override lives outside the
// directory being configured. A change takes effect on the next process start,
// so the value is read once and cached for a stable path resolution per session.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const CLINE_PARENT_DIR = ".cline";
const DEFAULT_STORAGE_DIR_NAME = "kanban";
const STORAGE_POINTER_FILENAME = "kanban-storage-dir";
const STORAGE_DIR_ENV = "KANBAN_STORAGE_DIR";

function getDefaultStorageDir(): string {
	return join(homedir(), CLINE_PARENT_DIR, DEFAULT_STORAGE_DIR_NAME);
}

function toAbsolute(dir: string): string {
	return isAbsolute(dir) ? dir : resolve(dir);
}

/** Fixed location of the pointer file that records a configured storage dir. */
export function getStoragePointerPath(): string {
	return join(homedir(), CLINE_PARENT_DIR, STORAGE_POINTER_FILENAME);
}

function readEnvOverride(): string | null {
	const value = process.env[STORAGE_DIR_ENV]?.trim();
	return value && value.length > 0 ? value : null;
}

function readPointerOverride(): string | null {
	try {
		const raw = readFileSync(getStoragePointerPath(), "utf-8").trim();
		return raw.length > 0 ? raw : null;
	} catch {
		return null;
	}
}

let cachedStorageDir: string | null = null;

/** The active storage directory for this process (resolved once, then cached). */
export function getKanbanStorageDir(): string {
	if (cachedStorageDir === null) {
		const override = readEnvOverride() ?? readPointerOverride();
		cachedStorageDir = toAbsolute(override ?? getDefaultStorageDir());
	}
	return cachedStorageDir;
}

/** The built-in default, regardless of any override. Shown in the settings UI. */
export function getKanbanStorageDirDefault(): string {
	return getDefaultStorageDir();
}

/** Whether a non-default storage dir is currently in effect (env or pointer). */
export function isKanbanStorageDirConfigured(): boolean {
	return readEnvOverride() !== null || readPointerOverride() !== null;
}

/**
 * The storage dir that will be used after the next restart, based on the pointer
 * file and env var. May differ from getKanbanStorageDir() when a change was just
 * saved but not yet applied.
 */
export function getPendingKanbanStorageDir(): string {
	const override = readEnvOverride() ?? readPointerOverride();
	return toAbsolute(override ?? getDefaultStorageDir());
}

/**
 * Persist a new storage dir to the pointer file. Takes effect on the next
 * restart. Pass null/empty to clear the override and revert to the default.
 * Returns the resolved directory that will be used going forward.
 */
export function setKanbanStorageDir(dir: string | null): string {
	const pointerPath = getStoragePointerPath();
	mkdirSync(dirname(pointerPath), { recursive: true });
	const trimmed = dir?.trim() ?? "";
	if (trimmed.length === 0) {
		try {
			rmSync(pointerPath, { force: true });
		} catch {
			// Nothing to clear.
		}
		return getDefaultStorageDir();
	}
	const absolute = toAbsolute(trimmed);
	writeFileSync(pointerPath, absolute, "utf-8");
	return absolute;
}
