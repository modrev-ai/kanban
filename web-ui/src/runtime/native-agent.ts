import { isNativeClineRuntimeAgent, isRuntimeAgentLaunchSupported } from "@runtime-agent-catalog";
import type {
	RuntimeAgentId,
	RuntimeClineProviderSettings,
	RuntimeConfigResponse,
	RuntimeStateStreamTaskChatMessage,
	RuntimeTaskChatMessage,
} from "@/runtime/types";

// The built-in SDK provider the native Claude agent runs through. The
// "claude-code" provider authenticates with the user's Claude Pro/Max
// subscription (via the Claude Agent SDK) rather than an Anthropic API key.
export const CLAUDE_NATIVE_PROVIDER_ID = "claude-code";

export function isNativeClineAgentSelected(agentId: RuntimeAgentId | null | undefined): boolean {
	return isNativeClineRuntimeAgent(agentId);
}

// Claude authenticates through its Claude Pro/Max subscription, which stores no
// secret in the provider slot. It is considered configured once the
// "claude-code" provider slot has been selected (i.e. a model saved).
export function isClaudeSubscriptionConfigured(
	settings: Pick<RuntimeClineProviderSettings, "providerId"> | null | undefined,
): boolean {
	return settings?.providerId === CLAUDE_NATIVE_PROVIDER_ID;
}

export function getRuntimeClineProviderSettings(
	config: Pick<RuntimeConfigResponse, "clineProviderSettings"> | null | undefined,
): RuntimeClineProviderSettings {
	return (
		config?.clineProviderSettings ?? {
			providerId: null,
			modelId: null,
			baseUrl: null,
			reasoningEffort: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		}
	);
}

export function isClineProviderAuthenticated(settings: RuntimeClineProviderSettings | null | undefined): boolean {
	if (!settings) {
		return false;
	}
	const hasProviderSelection =
		(settings.providerId?.trim().length ?? 0) > 0 || (settings.oauthProvider?.trim().length ?? 0) > 0;
	if (!hasProviderSelection) {
		return false;
	}
	return settings.apiKeyConfigured || settings.oauthAccessTokenConfigured;
}

/**
 * Returns true only when the selected provider is the Cline managed OAuth
 * provider **and** an access token is configured.  This is stricter than
 * {@link isClineProviderAuthenticated} which accepts any configured provider
 * (Claude API key, Codex, etc.).
 *
 * Use this for features that require a Cline-issued token (e.g. Featurebase
 * JWT authentication).
 */
export function isClineOauthAuthenticated(settings: RuntimeClineProviderSettings | null | undefined): boolean {
	if (!settings) {
		return false;
	}
	return (
		settings.oauthProvider === "cline" &&
		settings.oauthAccessTokenConfigured === true &&
		settings.oauthRefreshTokenConfigured === true
	);
}

export function isTaskAgentSetupSatisfied(
	config:
		| Pick<RuntimeConfigResponse, "selectedAgentId" | "agents" | "clineProviderSettings" | "claudeProviderSettings">
		| null
		| undefined,
): boolean | null {
	if (!config) {
		return null;
	}
	// Claude runs on its own built-in "claude-code" provider slot, authenticated
	// by the user's Claude Pro/Max subscription (no API key). It is set up once
	// that slot is selected (independent of the Cline provider).
	if (config.selectedAgentId === "claude") {
		return isClaudeSubscriptionConfigured(config.claudeProviderSettings);
	}
	if (isNativeClineAgentSelected(config.selectedAgentId)) {
		if (isClineProviderAuthenticated(getRuntimeClineProviderSettings(config))) {
			return true;
		}
		return config.agents.some(
			(agent) => !isNativeClineRuntimeAgent(agent.id) && isRuntimeAgentLaunchSupported(agent.id) && agent.installed,
		);
	}
	return config.agents.some((agent) => isRuntimeAgentLaunchSupported(agent.id) && agent.installed);
}

export function getTaskAgentNavbarHint(
	config:
		| Pick<RuntimeConfigResponse, "selectedAgentId" | "agents" | "clineProviderSettings" | "claudeProviderSettings">
		| null
		| undefined,
	options?: {
		shouldUseNavigationPath?: boolean;
	},
): string | undefined {
	if (options?.shouldUseNavigationPath) {
		return undefined;
	}
	const isTaskAgentReady = isTaskAgentSetupSatisfied(config);
	if (isTaskAgentReady === null || isTaskAgentReady) {
		return undefined;
	}
	return "No agent configured";
}

export function selectLatestTaskChatMessageForTask(
	taskId: string | null | undefined,
	latestTaskChatMessage: RuntimeStateStreamTaskChatMessage | null,
): RuntimeTaskChatMessage | null {
	if (!taskId || !latestTaskChatMessage || latestTaskChatMessage.taskId !== taskId) {
		return null;
	}
	return latestTaskChatMessage.message;
}

export function selectTaskChatMessagesForTask(
	taskId: string | null | undefined,
	taskChatMessagesByTaskId: Record<string, RuntimeTaskChatMessage[]>,
): RuntimeTaskChatMessage[] | null {
	if (!taskId) {
		return null;
	}
	return taskChatMessagesByTaskId[taskId] ?? null;
}
