// Persists Kanban-owned runtime preferences on disk.
// This module should store Kanban settings such as selected agents,
// shortcuts, and prompt templates, not SDK-owned Cline secrets or OAuth data.
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getRuntimeAgentCatalogEntry, isRuntimeAgentLaunchSupported } from "../core/agent-catalog";
import type { RuntimeAgentId, RuntimeProjectShortcut } from "../core/api-contract";
import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system";
import { detectInstalledCommands } from "../terminal/agent-registry";

interface RuntimeGlobalConfigFileShape {
	selectedAgentId?: RuntimeAgentId;
	selectedShortcutLabel?: string;
	agentAutonomousModeEnabled?: boolean;
	readyForReviewNotificationsEnabled?: boolean;
	llmRetryEnabled?: boolean;
	llmRetryDelayMs?: number;
	llmRetryMaxAttempts?: number;
	commitPromptTemplate?: string;
	openPrPromptTemplate?: string;
}

interface RuntimeProjectConfigFileShape {
	shortcuts?: RuntimeProjectShortcut[];
}

export interface RuntimeConfigState {
	globalConfigPath: string;
	projectConfigPath: string | null;
	selectedAgentId: RuntimeAgentId;
	selectedShortcutLabel: string | null;
	agentAutonomousModeEnabled: boolean;
	readyForReviewNotificationsEnabled: boolean;
	llmRetryEnabled: boolean;
	llmRetryDelayMs: number;
	llmRetryMaxAttempts: number;
	shortcuts: RuntimeProjectShortcut[];
	commitPromptTemplate: string;
	openPrPromptTemplate: string;
	commitPromptTemplateDefault: string;
	openPrPromptTemplateDefault: string;
}

export interface RuntimeConfigUpdateInput {
	selectedAgentId?: RuntimeAgentId;
	selectedShortcutLabel?: string | null;
	agentAutonomousModeEnabled?: boolean;
	readyForReviewNotificationsEnabled?: boolean;
	shortcuts?: RuntimeProjectShortcut[];
	commitPromptTemplate?: string;
	openPrPromptTemplate?: string;
	llmRetryEnabled?: boolean;
	llmRetryDelayMs?: number;
	llmRetryMaxAttempts?: number;
}

const RUNTIME_HOME_PARENT_DIR = ".cline";
const RUNTIME_HOME_DIR = "kanban";
const CONFIG_FILENAME = "config.json";
const PROJECT_CONFIG_PARENT_DIR = ".cline";
const PROJECT_CONFIG_DIR = "kanban";
const PROJECT_CONFIG_FILENAME = "config.json";
const DEFAULT_AGENT_ID: RuntimeAgentId = "cline";
const AUTO_SELECT_AGENT_PRIORITY: readonly RuntimeAgentId[] = ["claude", "codex", "droid", "kiro"];
const DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED = true;
const DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED = true;
const DEFAULT_LLM_RETRY_ENABLED = true;
const DEFAULT_LLM_RETRY_DELAY_MS = 15000;
const DEFAULT_LLM_RETRY_MAX_ATTEMPTS = 20;
const DEFAULT_COMMIT_PROMPT_TEMPLATE = `You are in a worktree on a detached HEAD. When you are finished with the task, commit the working changes onto {{base_ref}}.

- Do not run destructive commands: git reset --hard, git clean -fdx, git worktree remove, rm/mv on repository paths.
- Do not edit files outside git workflows unless required for conflict resolution.
- Preserve any pre-existing user uncommitted changes in the base worktree.

Steps:
1. In the current task worktree, stage and create a commit for the pending task changes.
2. Find where {{base_ref}} is checked out:
   - Run: git worktree list --porcelain
   - If branch {{base_ref}} is checked out in path P, use that P.
   - If not checked out anywhere, use current worktree as P by checking out {{base_ref}} there.
3. In P, verify current branch is {{base_ref}}.
4. If P has uncommitted changes, stash them: git -C P stash push -u -m "kanban-pre-cherry-pick"
5. Cherry-pick the task commit into P. If this fails because .git/index.lock exists, wait briefly for any active git process to finish. If the lock remains and no git process is active, treat the lock as stale, remove it, and retry.
6. If cherry-pick conflicts, resolve carefully, preserving both the intended task changes and existing user edits.
7. If step 4 created a new stash entry, restore that stash with: git -C P stash pop <stash-ref>
8. If stash pop conflicts, resolve them while preserving pre-existing user edits.
9. Report:
   - Final commit hash
   - Final commit message
   - Whether stash was used
   - Whether conflicts were resolved
   - Any remaining manual follow-up needed`;
const DEFAULT_OPEN_PR_PROMPT_TEMPLATE = `You are in a worktree on a detached HEAD. When you are finished with the task, open a pull request against {{base_ref}}.

- Do not run destructive commands: git reset --hard, git clean -fdx, git worktree remove, rm/mv on repository paths.
- Do not modify the base worktree.
- Keep all PR preparation in the current task worktree.

Steps:
1. Ensure all intended changes are committed in the current task worktree.
2. If currently on detached HEAD, create a branch at the current commit in this worktree.
3. Push the branch to origin and set upstream.
4. Create a pull request with base {{base_ref}} and head as the pushed branch (use gh CLI if available).
5. If a pull request already exists for the same head and base, return that existing PR URL instead of creating a duplicate.
6. If PR creation is blocked, explain exactly why and provide the exact commands to complete it manually.
7. Report:
   - PR title: PR URL
   - Base branch
   - Head branch
   - Any follow-up needed`;

export function pickBestInstalledAgentIdFromDetected(detectedCommands: readonly string[]): RuntimeAgentId | null {
	const detected = new Set(detectedCommands);
	for (const agentId of AUTO_SELECT_AGENT_PRIORITY) {
		const catalogEntry = getRuntimeAgentCatalogEntry(agentId);
		const binary = catalogEntry?.binary ?? agentId;
		if (detected.has(binary) || detected.has(agentId)) {
			return agentId;
		}
	}
	return null;
}

function getRuntimeHomePath(): string {
	return join(homedir(), RUNTIME_HOME_PARENT_DIR, RUNTIME_HOME_DIR);
}

function normalizeAgentId(agentId: RuntimeAgentId | string | null | undefined): RuntimeAgentId {
	if (
		(agentId === "claude" ||
			agentId === "codex" ||
			agentId === "gemini" ||
			agentId === "opencode" ||
			agentId === "droid" ||
			agentId === "kiro" ||
			agentId === "cline") &&
		isRuntimeAgentLaunchSupported(agentId)
	) {
		return agentId;
	}
	return DEFAULT_AGENT_ID;
}

function pickBestInstalledAgentId(): RuntimeAgentId | null {
	return pickBestInstalledAgentIdFromDetected(detectInstalledCommands());
}

function normalizeShortcut(shortcut: RuntimeProjectShortcut): RuntimeProjectShortcut | null {
	if (!shortcut || typeof shortcut !== "object") {
		return null;
	}

	const label = typeof shortcut.label === "string" ? shortcut.label.trim() : "";
	const command = typeof shortcut.command === "string" ? shortcut.command.trim() : "";
	const icon = typeof shortcut.icon === "string" ? shortcut.icon.trim() : "";

	if (!label || !command) {
		return null;
	}

	return {
		label,
		command,
		icon: icon || undefined,
	};
}

function normalizeShortcuts(shortcuts: RuntimeProjectShortcut[] | null | undefined): RuntimeProjectShortcut[] {
	if (!Array.isArray(shortcuts)) {
		return [];
	}
	const normalized: RuntimeProjectShortcut[] = [];
	for (const shortcut of shortcuts) {
		const parsed = normalizeShortcut(shortcut);
		if (parsed) {
			normalized.push(parsed);
		}
	}
	return normalized;
}

function normalizePromptTemplate(value: unknown, fallback: string): string {
	if (typeof value !== "string") {
		return fallback;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? value : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	return fallback;
}

function normalizeNumber(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	return fallback;
}

function normalizeShortcutLabel(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function hasOwnKey<T extends object>(value: T | null, key: keyof T): boolean {
	if (!value) {
		return false;
	}
	return Object.hasOwn(value, key);
}

export function getRuntimeGlobalConfigPath(): string {
	return join(getRuntimeHomePath(), CONFIG_FILENAME);
}

export function getRuntimeProjectConfigPath(cwd: string): string {
	return join(resolve(cwd), PROJECT_CONFIG_PARENT_DIR, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILENAME);
}

interface RuntimeConfigPaths {
	globalConfigPath: string;
	projectConfigPath: string | null;
}

function normalizePathForComparison(path: string): string {
	const normalized = resolve(path).replaceAll("\\", "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function resolveRuntimeConfigPaths(cwd: string | null): RuntimeConfigPaths {
	const globalConfigPath = getRuntimeGlobalConfigPath();
	if (cwd === null) {
		return {
			globalConfigPath,
			projectConfigPath: null,
		};
	}

	const normalizedCwd = normalizePathForComparison(cwd);
	const normalizedHome = normalizePathForComparison(homedir());
	if (normalizedCwd === normalizedHome) {
		return {
			globalConfigPath,
			projectConfigPath: null,
		};
	}

	return {
		globalConfigPath,
		projectConfigPath: getRuntimeProjectConfigPath(cwd),
	};
}

function getRuntimeConfigLockRequests(cwd: string | null): LockRequest[] {
	const paths = resolveRuntimeConfigPaths(cwd);
	const requests: LockRequest[] = [
		{
			path: paths.globalConfigPath,
			type: "file",
		},
	];
	if (paths.projectConfigPath) {
		requests.push({
			path: paths.projectConfigPath,
			type: "file",
		});
	}
	return requests;
}

function toRuntimeConfigState({
	globalConfigPath,
	projectConfigPath,
	globalConfig,
	projectConfig,
}: {
	globalConfigPath: string;
	projectConfigPath: string | null;
	globalConfig: RuntimeGlobalConfigFileShape | null;
	projectConfig: RuntimeProjectConfigFileShape | null;
}): RuntimeConfigState {
	return {
		globalConfigPath,
		projectConfigPath,
		selectedAgentId: normalizeAgentId(globalConfig?.selectedAgentId),
		selectedShortcutLabel: normalizeShortcutLabel(globalConfig?.selectedShortcutLabel),
		agentAutonomousModeEnabled: normalizeBoolean(
			globalConfig?.agentAutonomousModeEnabled,
			DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED,
		),
		readyForReviewNotificationsEnabled: normalizeBoolean(
			globalConfig?.readyForReviewNotificationsEnabled,
			DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED,
		),
		llmRetryEnabled: normalizeBoolean(globalConfig?.llmRetryEnabled, DEFAULT_LLM_RETRY_ENABLED),
		llmRetryDelayMs: normalizeNumber(globalConfig?.llmRetryDelayMs, DEFAULT_LLM_RETRY_DELAY_MS),
		llmRetryMaxAttempts: normalizeNumber(globalConfig?.llmRetryMaxAttempts, DEFAULT_LLM_RETRY_MAX_ATTEMPTS),
		shortcuts: normalizeShortcuts(projectConfig?.shortcuts),
		commitPromptTemplate: normalizePromptTemplate(globalConfig?.commitPromptTemplate, DEFAULT_COMMIT_PROMPT_TEMPLATE),
		openPrPromptTemplate: normalizePromptTemplate(
			globalConfig?.openPrPromptTemplate,
			DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
		),
		commitPromptTemplateDefault: DEFAULT_COMMIT_PROMPT_TEMPLATE,
		openPrPromptTemplateDefault: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
	};
}

async function readRuntimeConfigFile<T>(configPath: string): Promise<T | null> {
	try {
		const raw = await readFile(configPath, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

async function writeRuntimeGlobalConfigFile(
	configPath: string,
	config: {
		selectedAgentId?: RuntimeAgentId;
		selectedShortcutLabel?: string | null;
		agentAutonomousModeEnabled?: boolean;
		readyForReviewNotificationsEnabled?: boolean;
		commitPromptTemplate?: string;
		openPrPromptTemplate?: string;
		llmRetryEnabled?: boolean;
		llmRetryDelayMs?: number;
		llmRetryMaxAttempts?: number;
	},
): Promise<void> {
	const existing = await readRuntimeConfigFile<RuntimeGlobalConfigFileShape>(configPath);
	const selectedAgentId = config.selectedAgentId === undefined ? undefined : normalizeAgentId(config.selectedAgentId);
	const existingSelectedAgentId = hasOwnKey(existing, "selectedAgentId")
		? normalizeAgentId(existing?.selectedAgentId)
		: undefined;
	const selectedShortcutLabel =
		config.selectedShortcutLabel === undefined ? undefined : normalizeShortcutLabel(config.selectedShortcutLabel);
	const existingSelectedShortcutLabel = hasOwnKey(existing, "selectedShortcutLabel")
		? normalizeShortcutLabel(existing?.selectedShortcutLabel)
		: undefined;
	const agentAutonomousModeEnabled =
		config.agentAutonomousModeEnabled === undefined
			? DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED
			: normalizeBoolean(config.agentAutonomousModeEnabled, DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED);
	const readyForReviewNotificationsEnabled =
		config.readyForReviewNotificationsEnabled === undefined
			? DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED
			: normalizeBoolean(config.readyForReviewNotificationsEnabled, DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED);
	const commitPromptTemplate =
		config.commitPromptTemplate === undefined
			? DEFAULT_COMMIT_PROMPT_TEMPLATE
			: normalizePromptTemplate(config.commitPromptTemplate, DEFAULT_COMMIT_PROMPT_TEMPLATE);
	const openPrPromptTemplate =
		config.openPrPromptTemplate === undefined
			? DEFAULT_OPEN_PR_PROMPT_TEMPLATE
			: normalizePromptTemplate(config.openPrPromptTemplate, DEFAULT_OPEN_PR_PROMPT_TEMPLATE);
	const llmRetryEnabled =
		config.llmRetryEnabled === undefined
			? DEFAULT_LLM_RETRY_ENABLED
			: normalizeBoolean(config.llmRetryEnabled, DEFAULT_LLM_RETRY_ENABLED);
	const llmRetryDelayMs =
		config.llmRetryDelayMs === undefined
			? DEFAULT_LLM_RETRY_DELAY_MS
			: normalizeNumber(config.llmRetryDelayMs, DEFAULT_LLM_RETRY_DELAY_MS);
	const llmRetryMaxAttempts =
		config.llmRetryMaxAttempts === undefined
			? DEFAULT_LLM_RETRY_MAX_ATTEMPTS
			: normalizeNumber(config.llmRetryMaxAttempts, DEFAULT_LLM_RETRY_MAX_ATTEMPTS);

	const payload: RuntimeGlobalConfigFileShape = {};
	if (selectedAgentId !== undefined) {
		if (hasOwnKey(existing, "selectedAgentId") || selectedAgentId !== DEFAULT_AGENT_ID) {
			payload.selectedAgentId = selectedAgentId;
		}
	} else if (existingSelectedAgentId !== undefined) {
		payload.selectedAgentId = existingSelectedAgentId;
	}
	if (selectedShortcutLabel !== undefined) {
		if (selectedShortcutLabel) {
			payload.selectedShortcutLabel = selectedShortcutLabel;
		}
	} else if (existingSelectedShortcutLabel) {
		payload.selectedShortcutLabel = existingSelectedShortcutLabel;
	}
	if (
		hasOwnKey(existing, "agentAutonomousModeEnabled") ||
		agentAutonomousModeEnabled !== DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED
	) {
		payload.agentAutonomousModeEnabled = agentAutonomousModeEnabled;
	}
	if (
		hasOwnKey(existing, "readyForReviewNotificationsEnabled") ||
		readyForReviewNotificationsEnabled !== DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED
	) {
		payload.readyForReviewNotificationsEnabled = readyForReviewNotificationsEnabled;
	}
	if (hasOwnKey(existing, "commitPromptTemplate") || commitPromptTemplate !== DEFAULT_COMMIT_PROMPT_TEMPLATE) {
		payload.commitPromptTemplate = commitPromptTemplate;
	}
	if (hasOwnKey(existing, "openPrPromptTemplate") || openPrPromptTemplate !== DEFAULT_OPEN_PR_PROMPT_TEMPLATE) {
		payload.openPrPromptTemplate = openPrPromptTemplate;
	}
	if (hasOwnKey(existing, "llmRetryEnabled") || llmRetryEnabled !== DEFAULT_LLM_RETRY_ENABLED) {
		payload.llmRetryEnabled = llmRetryEnabled;
	}
	if (hasOwnKey(existing, "llmRetryDelayMs") || llmRetryDelayMs !== DEFAULT_LLM_RETRY_DELAY_MS) {
		payload.llmRetryDelayMs = llmRetryDelayMs;
	}
	if (hasOwnKey(existing, "llmRetryMaxAttempts") || llmRetryMaxAttempts !== DEFAULT_LLM_RETRY_MAX_ATTEMPTS) {
		payload.llmRetryMaxAttempts = llmRetryMaxAttempts;
	}

	await lockedFileSystem.writeJsonFileAtomic(configPath, payload, {
		lock: null,
	});
}

async function writeRuntimeProjectConfigFile(
	configPath: string | null,
	config: { shortcuts: RuntimeProjectShortcut[] },
): Promise<void> {
	const normalizedShortcuts = normalizeShortcuts(config.shortcuts);
	if (!configPath) {
		if (normalizedShortcuts.length > 0) {
			throw new Error("Cannot save project shortcuts without a selected project.");
		}
		return;
	}
	if (normalizedShortcuts.length === 0) {
		await rm(configPath, { force: true });
		try {
			await rm(dirname(configPath));
		} catch {
			// Ignore missing or non-empty project config directories.
		}
		return;
	}
	await lockedFileSystem.writeJsonFileAtomic(
		configPath,
		{
			shortcuts: normalizedShortcuts,
		} satisfies RuntimeProjectConfigFileShape,
		{
			lock: null,
		},
	);
}

interface RuntimeConfigFiles {
	globalConfigPath: string;
	projectConfigPath: string | null;
	globalConfig: RuntimeGlobalConfigFileShape | null;
	projectConfig: RuntimeProjectConfigFileShape | null;
}

async function readRuntimeConfigFiles(cwd: string | null): Promise<RuntimeConfigFiles> {
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(cwd);
	return {
		globalConfigPath,
		projectConfigPath,
		globalConfig: await readRuntimeConfigFile<RuntimeGlobalConfigFileShape>(globalConfigPath),
		projectConfig: projectConfigPath
			? await readRuntimeConfigFile<RuntimeProjectConfigFileShape>(projectConfigPath)
			: null,
	};
}

async function loadRuntimeConfigLocked(cwd: string | null): Promise<RuntimeConfigState> {
	const configFiles = await readRuntimeConfigFiles(cwd);
	if (configFiles.globalConfig === null) {
		const autoSelectedAgentId = pickBestInstalledAgentId();
		if (autoSelectedAgentId) {
			await writeRuntimeGlobalConfigFile(configFiles.globalConfigPath, {
				selectedAgentId: autoSelectedAgentId,
			});
			configFiles.globalConfig = {
				selectedAgentId: autoSelectedAgentId,
			};
		}
	}
	return toRuntimeConfigState(configFiles);
}

function createRuntimeConfigStateFromValues(input: {
	globalConfigPath: string;
	projectConfigPath: string | null;
	selectedAgentId: RuntimeAgentId;
	selectedShortcutLabel: string | null;
	agentAutonomousModeEnabled: boolean;
	readyForReviewNotificationsEnabled: boolean;
	llmRetryEnabled: boolean;
	llmRetryDelayMs: number;
	llmRetryMaxAttempts: number;
	shortcuts: RuntimeProjectShortcut[];
	commitPromptTemplate: string;
	openPrPromptTemplate: string;
}): RuntimeConfigState {
	return {
		globalConfigPath: input.globalConfigPath,
		projectConfigPath: input.projectConfigPath,
		selectedAgentId: normalizeAgentId(input.selectedAgentId),
		selectedShortcutLabel: normalizeShortcutLabel(input.selectedShortcutLabel),
		agentAutonomousModeEnabled: normalizeBoolean(
			input.agentAutonomousModeEnabled,
			DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED,
		),
		readyForReviewNotificationsEnabled: normalizeBoolean(
			input.readyForReviewNotificationsEnabled,
			DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED,
		),
		llmRetryEnabled: input.llmRetryEnabled,
		llmRetryDelayMs: input.llmRetryDelayMs,
		llmRetryMaxAttempts: input.llmRetryMaxAttempts,
		shortcuts: normalizeShortcuts(input.shortcuts),
		commitPromptTemplate: normalizePromptTemplate(input.commitPromptTemplate, DEFAULT_COMMIT_PROMPT_TEMPLATE),
		openPrPromptTemplate: normalizePromptTemplate(input.openPrPromptTemplate, DEFAULT_OPEN_PR_PROMPT_TEMPLATE),
		commitPromptTemplateDefault: DEFAULT_COMMIT_PROMPT_TEMPLATE,
		openPrPromptTemplateDefault: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
	};
}

export function toGlobalRuntimeConfigState(current: RuntimeConfigState): RuntimeConfigState {
	return createRuntimeConfigStateFromValues({
		globalConfigPath: current.globalConfigPath,
		projectConfigPath: null,
		selectedAgentId: current.selectedAgentId,
		selectedShortcutLabel: current.selectedShortcutLabel,
		agentAutonomousModeEnabled: current.agentAutonomousModeEnabled,
		readyForReviewNotificationsEnabled: current.readyForReviewNotificationsEnabled,
		llmRetryEnabled: current.llmRetryEnabled,
		llmRetryDelayMs: current.llmRetryDelayMs,
		llmRetryMaxAttempts: current.llmRetryMaxAttempts,
		shortcuts: [],
		commitPromptTemplate: current.commitPromptTemplate,
		openPrPromptTemplate: current.openPrPromptTemplate,
	});
}

export function toProjectRuntimeConfigState(current: RuntimeConfigState, cwd: string): RuntimeConfigState {
	return createRuntimeConfigStateFromValues({
		globalConfigPath: current.globalConfigPath,
		projectConfigPath: getRuntimeProjectConfigPath(cwd),
		selectedAgentId: current.selectedAgentId,
		selectedShortcutLabel: current.selectedShortcutLabel,
		agentAutonomousModeEnabled: current.agentAutonomousModeEnabled,
		readyForReviewNotificationsEnabled: current.readyForReviewNotificationsEnabled,
		llmRetryEnabled: current.llmRetryEnabled,
		llmRetryDelayMs: current.llmRetryDelayMs,
		llmRetryMaxAttempts: current.llmRetryMaxAttempts,
		shortcuts: current.shortcuts,
		commitPromptTemplate: current.commitPromptTemplate,
		openPrPromptTemplate: current.openPrPromptTemplate,
	});
}

export async function loadRuntimeConfig(cwd: string | null): Promise<RuntimeConfigState> {
	const lockRequests = getRuntimeConfigLockRequests(cwd);
	return lockedFileSystem.withLocks(lockRequests, async () => {
		return loadRuntimeConfigLocked(cwd);
	});
}

export async function updateRuntimeConfig(
	cwd: string | null,
	update: RuntimeConfigUpdateInput,
): Promise<RuntimeConfigState> {
	const lockRequests = getRuntimeConfigLockRequests(cwd);
	return lockedFileSystem.withLocks(lockRequests, async () => {
		const configFiles = await readRuntimeConfigFiles(cwd);
		const currentState = toRuntimeConfigState(configFiles);

		const newState = createRuntimeConfigStateFromValues({
			globalConfigPath: currentState.globalConfigPath,
			projectConfigPath: currentState.projectConfigPath,
			selectedAgentId: update.selectedAgentId ?? currentState.selectedAgentId,
			selectedShortcutLabel: update.selectedShortcutLabel ?? currentState.selectedShortcutLabel,
			agentAutonomousModeEnabled: update.agentAutonomousModeEnabled ?? currentState.agentAutonomousModeEnabled,
			readyForReviewNotificationsEnabled:
				update.readyForReviewNotificationsEnabled ?? currentState.readyForReviewNotificationsEnabled,
			llmRetryEnabled: update.llmRetryEnabled ?? currentState.llmRetryEnabled,
			llmRetryDelayMs: update.llmRetryDelayMs ?? currentState.llmRetryDelayMs,
			llmRetryMaxAttempts: update.llmRetryMaxAttempts ?? currentState.llmRetryMaxAttempts,
			shortcuts: update.shortcuts ?? currentState.shortcuts,
			commitPromptTemplate: update.commitPromptTemplate ?? currentState.commitPromptTemplate,
			openPrPromptTemplate: update.openPrPromptTemplate ?? currentState.openPrPromptTemplate,
		});

		await writeRuntimeGlobalConfigFile(currentState.globalConfigPath, {
			selectedAgentId: newState.selectedAgentId,
			selectedShortcutLabel: newState.selectedShortcutLabel,
			agentAutonomousModeEnabled: newState.agentAutonomousModeEnabled,
			readyForReviewNotificationsEnabled: newState.readyForReviewNotificationsEnabled,
			commitPromptTemplate: newState.commitPromptTemplate,
			openPrPromptTemplate: newState.openPrPromptTemplate,
			llmRetryEnabled: newState.llmRetryEnabled,
			llmRetryDelayMs: newState.llmRetryDelayMs,
			llmRetryMaxAttempts: newState.llmRetryMaxAttempts,
		});

		if (currentState.projectConfigPath) {
			await writeRuntimeProjectConfigFile(currentState.projectConfigPath, {
				shortcuts: newState.shortcuts,
			});
		}

		return newState;
	});
}

export async function resetRuntimeConfig(cwd: string | null): Promise<void> {
	const lockRequests = getRuntimeConfigLockRequests(cwd);
	await lockedFileSystem.withLocks(lockRequests, async () => {
		const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(cwd);
		await rm(globalConfigPath, { force: true });
		if (projectConfigPath) {
			await rm(projectConfigPath, { force: true });
			try {
				await rm(dirname(projectConfigPath));
			} catch {
				// Ignore missing or non-empty project config directories.
			}
		}
	});
}
