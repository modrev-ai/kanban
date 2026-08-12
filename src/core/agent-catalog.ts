import type { RuntimeAgentId } from "./api-contract";

export interface RuntimeAgentCatalogEntry {
	id: RuntimeAgentId;
	label: string;
	binary: string;
	baseArgs: string[];
	autonomousArgs: string[];
	installUrl: string;
}

export const RUNTIME_AGENT_CATALOG: RuntimeAgentCatalogEntry[] = [
	{
		// Claude is a native, in-app-authenticated agent. It runs through the same
		// Cline SDK runtime as Modrev/Cline (so its conversation is saved and
		// rendered in the Kanban chat UI rather than a raw CLI terminal), pinned to
		// the SDK's built-in "anthropic" provider configured with an Anthropic API
		// key and model in Settings. It is never launched as an external CLI, so it
		// has no binary.
		id: "claude",
		label: "Claude Code",
		binary: "",
		baseArgs: [],
		autonomousArgs: [],
		installUrl: "https://docs.anthropic.com/en/docs/claude-code/quickstart",
	},
	{
		id: "codex",
		label: "OpenAI Codex",
		binary: "codex",
		baseArgs: [],
		autonomousArgs: ["--dangerously-bypass-approvals-and-sandbox"],
		installUrl: "https://github.com/openai/codex",
	},
	{
		id: "cline",
		label: "Cline",
		binary: "cline",
		baseArgs: [],
		autonomousArgs: ["--auto-approve-all"],
		installUrl: "https://github.com/cline/cline",
	},
	{
		// Modrev is a native, in-app-authenticated agent. It reuses the Cline
		// runtime but is pinned to a custom OpenAI-compatible "modrev" provider
		// configured with an API key, base URL, and model ID in Settings. It is
		// never launched as an external CLI, so it has no binary.
		id: "modrev",
		label: "Modrev",
		binary: "",
		baseArgs: [],
		autonomousArgs: [],
		installUrl: "",
	},
	{
		id: "opencode",
		label: "OpenCode",
		binary: "opencode",
		baseArgs: [],
		autonomousArgs: [],
		installUrl: "https://github.com/sst/opencode",
	},
	{
		id: "droid",
		label: "Factory Droid",
		binary: "droid",
		baseArgs: [],
		autonomousArgs: ["--auto", "high"],
		installUrl: "https://docs.factory.ai/cli/getting-started/quickstart",
	},
	{
		id: "kiro",
		label: "Kiro",
		binary: "kiro-cli",
		baseArgs: ["chat"],
		autonomousArgs: ["--trust-all-tools"],
		installUrl: "https://kiro.dev",
	},
	{
		id: "gemini",
		label: "Gemini CLI",
		binary: "gemini",
		baseArgs: [],
		autonomousArgs: ["--yolo"],
		installUrl: "https://github.com/google-gemini/gemini-cli",
	},
];

// Temporarily keep launch support scoped to the core agent set.
// Re-enable additional CLIs by uncommenting entries below when ready.
export const RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS: readonly RuntimeAgentId[] = [
	"cline",
	"modrev",
	"claude",
	"codex",
	"droid",
	"kiro",
	// "opencode",
	// "gemini",
];

const RUNTIME_LAUNCH_SUPPORTED_AGENT_ID_SET = new Set<RuntimeAgentId>(RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS);

export function isRuntimeAgentLaunchSupported(agentId: RuntimeAgentId): boolean {
	return RUNTIME_LAUNCH_SUPPORTED_AGENT_ID_SET.has(agentId);
}

// Native, in-app-authenticated agents that run through the Cline SDK runtime
// rather than launching an external CLI binary. They are always considered
// "installed" and their auth is configured in-app (provider settings) instead
// of via a command-line tool on PATH.
//
// Claude is native too: it drives the Cline runtime through the SDK's built-in
// "anthropic" provider, so its conversation is persisted and shown in the
// Kanban chat UI just like Cline/Modrev (never a raw CLI terminal).
export const RUNTIME_NATIVE_CLINE_AGENT_IDS: readonly RuntimeAgentId[] = ["cline", "modrev", "claude"];

const RUNTIME_NATIVE_CLINE_AGENT_ID_SET = new Set<RuntimeAgentId>(RUNTIME_NATIVE_CLINE_AGENT_IDS);

export function isNativeClineRuntimeAgent(agentId: RuntimeAgentId | null | undefined): boolean {
	return agentId != null && RUNTIME_NATIVE_CLINE_AGENT_ID_SET.has(agentId);
}

export function getRuntimeLaunchSupportedAgentCatalog(): RuntimeAgentCatalogEntry[] {
	return RUNTIME_AGENT_CATALOG.filter((entry) => isRuntimeAgentLaunchSupported(entry.id));
}

export function getRuntimeAgentCatalogEntry(agentId: RuntimeAgentId): RuntimeAgentCatalogEntry | null {
	return RUNTIME_AGENT_CATALOG.find((entry) => entry.id === agentId) ?? null;
}
