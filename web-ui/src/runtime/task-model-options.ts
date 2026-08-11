// Builds the flat list of "models" a task can be launched with.
//
// Historically, choosing a model for a task meant drilling through Agent →
// Provider → Model. This module flattens that into a single first-class list
// where each entry is a directly selectable target:
//   - Claude Code (and the other CLI agents) as single entries, and
//   - each registered Modrev model expanded into its own entry (by name).
//
// A registered Modrev "model" is really a custom OpenAI-compatible provider in
// the Cline provider catalog, namespaced by the "modrev-" prefix (see
// modrev-provider.ts). Selecting one launches the Modrev agent pinned to that
// provider (and its default model).
import { getRuntimeLaunchSupportedAgentCatalog } from "@runtime-agent-catalog";

import { isModrevModelProviderId } from "@/runtime/modrev-provider";
import type { RuntimeAgentId, RuntimeClineProviderCatalogItem, RuntimeTaskClineSettings } from "@/runtime/types";

// Dropdown values for Modrev models are namespaced so they never collide with
// a plain agent id (e.g. "modrev" itself, or a future agent that shares a name).
export const MODREV_TASK_MODEL_VALUE_PREFIX = "modrev:";

export interface TaskModelOption {
	/** Stable value used as the dropdown option value. */
	value: string;
	/** Human-readable label shown in the dropdown. */
	label: string;
	/** The agent this option launches. */
	agentId: RuntimeAgentId;
	/** For Modrev models: the registered provider id backing this model. */
	providerId?: string;
	/** For Modrev models: the specific model id to run. */
	modelId?: string;
}

/** The concrete task overrides a selected flat option resolves to. */
export interface TaskModelSelection {
	agentId: RuntimeAgentId | undefined;
	clineSettings: RuntimeTaskClineSettings | undefined;
}

/**
 * Builds the flat list of selectable task models from the launch-supported
 * agent catalog and the Cline provider catalog. Agent order is preserved; the
 * Modrev agent is expanded in place into one entry per registered Modrev model.
 * When no Modrev models are registered, Modrev contributes no entries.
 */
export function buildTaskModelOptions(catalog: readonly RuntimeClineProviderCatalogItem[]): TaskModelOption[] {
	const modrevModels = catalog.filter((provider) => isModrevModelProviderId(provider.id));
	const options: TaskModelOption[] = [];
	for (const agent of getRuntimeLaunchSupportedAgentCatalog()) {
		if (agent.id === "modrev") {
			for (const model of modrevModels) {
				options.push({
					value: `${MODREV_TASK_MODEL_VALUE_PREFIX}${model.id}`,
					label: model.name,
					agentId: "modrev",
					providerId: model.id,
					...(model.defaultModelId ? { modelId: model.defaultModelId } : {}),
				});
			}
			continue;
		}
		options.push({ value: agent.id, label: agent.label, agentId: agent.id });
	}
	return options;
}

/**
 * Resolves a selected dropdown value into the concrete task overrides to apply.
 * The empty value means "inherit the project default" (no per-task override).
 */
export function resolveTaskModelSelection(value: string, options: readonly TaskModelOption[]): TaskModelSelection {
	if (!value) {
		return { agentId: undefined, clineSettings: undefined };
	}
	const option = options.find((entry) => entry.value === value);
	if (!option) {
		return { agentId: undefined, clineSettings: undefined };
	}
	if (option.agentId === "modrev" && option.providerId) {
		return {
			agentId: "modrev",
			clineSettings: {
				providerId: option.providerId,
				...(option.modelId ? { modelId: option.modelId } : {}),
			},
		};
	}
	return { agentId: option.agentId, clineSettings: undefined };
}

/**
 * Maps the current per-task overrides back to the dropdown value that
 * represents them, so the flat selector reflects the active choice. Returns the
 * empty value when there is no explicit agent override (inherits the default).
 */
export function selectedTaskModelValue(
	agentId: RuntimeAgentId | undefined,
	clineSettings: RuntimeTaskClineSettings | undefined,
): string {
	if (!agentId) {
		return "";
	}
	if (agentId === "modrev") {
		const providerId = clineSettings?.providerId?.trim();
		return providerId ? `${MODREV_TASK_MODEL_VALUE_PREFIX}${providerId}` : "";
	}
	return agentId;
}

/**
 * Builds the label for the "Default" option, reflecting the project's
 * configured default agent (and, for Modrev, the active model name).
 */
export function buildDefaultTaskModelLabel(params: {
	defaultAgentId: RuntimeAgentId | null | undefined;
	defaultProviderId?: string | null;
	catalog: readonly RuntimeClineProviderCatalogItem[];
}): string {
	const { defaultAgentId, defaultProviderId, catalog } = params;
	if (!defaultAgentId) {
		return "Default";
	}
	if (defaultAgentId === "modrev" && defaultProviderId) {
		const model = catalog.find((provider) => provider.id === defaultProviderId);
		if (model) {
			return `Default (${model.name})`;
		}
	}
	const agent = getRuntimeLaunchSupportedAgentCatalog().find((entry) => entry.id === defaultAgentId);
	return `Default (${agent?.label ?? defaultAgentId})`;
}
