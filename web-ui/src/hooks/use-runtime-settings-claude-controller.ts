// Owns the native Claude agent's settings inside the settings dialog.
//
// Claude runs through the Cline SDK runtime pinned to the SDK's built-in
// "claude-code" provider, which authenticates with the user's Claude Pro/Max
// subscription (via the Claude Agent SDK) instead of an Anthropic API key. Only
// the model lives in the "claude-code" provider-settings slot, saved with
// setLastUsed:false so configuring Claude never changes the Cline agent's active
// provider — mirroring how Modrev stays independent of the shared Cline provider
// selection.
import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CLAUDE_NATIVE_PROVIDER_ID, isClaudeSubscriptionConfigured } from "@/runtime/native-agent";
import { fetchClineProviderModels, saveClineProviderSettings } from "@/runtime/runtime-config-query";
import type { RuntimeClineProviderModel, RuntimeConfigResponse } from "@/runtime/types";

// The built-in SDK provider the native Claude agent runs through.
export const CLAUDE_PROVIDER_ID = CLAUDE_NATIVE_PROVIDER_ID;

interface UseRuntimeSettingsClaudeControllerOptions {
	open: boolean;
	workspaceId: string | null;
	config: RuntimeConfigResponse | null;
}

interface SaveResult {
	ok: boolean;
	message?: string;
}

export interface UseRuntimeSettingsClaudeControllerResult {
	modelId: string;
	setModelId: Dispatch<SetStateAction<string>>;
	models: RuntimeClineProviderModel[];
	isLoadingModels: boolean;
	/** True once the "claude-code" subscription provider slot has been selected. */
	subscriptionConfigured: boolean;
	configuredModelId: string | null;
	hasUnsavedChanges: boolean;
	saveClaudeSettings: () => Promise<SaveResult>;
}

export function useRuntimeSettingsClaudeController(
	options: UseRuntimeSettingsClaudeControllerOptions,
): UseRuntimeSettingsClaudeControllerResult {
	const { open, workspaceId, config } = options;
	const claudeSettings = config?.claudeProviderSettings ?? null;
	const subscriptionConfigured = isClaudeSubscriptionConfigured(claudeSettings);
	const configuredModelId = claudeSettings?.modelId ?? null;

	const [modelId, setModelId] = useState(configuredModelId ?? "");
	const [models, setModels] = useState<RuntimeClineProviderModel[]>([]);
	const [isLoadingModels, setIsLoadingModels] = useState(false);
	const modelsRequestIdRef = useRef(0);

	// Re-seed the draft model from the persisted claude-code slot each time the
	// dialog opens.
	useEffect(() => {
		if (!open) {
			return;
		}
		setModelId(configuredModelId ?? "");
	}, [configuredModelId, open]);

	// Load the Claude Code model catalog while the dialog is open.
	useEffect(() => {
		if (!open) {
			modelsRequestIdRef.current += 1;
			setModels([]);
			setIsLoadingModels(false);
			return;
		}
		const requestId = modelsRequestIdRef.current + 1;
		modelsRequestIdRef.current = requestId;
		setIsLoadingModels(true);
		void (async () => {
			try {
				const nextModels = await fetchClineProviderModels(workspaceId, CLAUDE_PROVIDER_ID);
				if (modelsRequestIdRef.current === requestId) {
					setModels(nextModels);
				}
			} catch {
				if (modelsRequestIdRef.current === requestId) {
					setModels([]);
				}
			} finally {
				if (modelsRequestIdRef.current === requestId) {
					setIsLoadingModels(false);
				}
			}
		})();
	}, [open, workspaceId]);

	// Saving a model also (re)selects the claude-code provider slot, so an
	// unselected slot always counts as an unsaved change even before the user
	// touches the model dropdown.
	const hasUnsavedChanges = useMemo(
		() => !subscriptionConfigured || modelId.trim() !== (configuredModelId ?? "").trim(),
		[configuredModelId, modelId, subscriptionConfigured],
	);

	const saveClaudeSettings = useCallback(async (): Promise<SaveResult> => {
		try {
			await saveClineProviderSettings(workspaceId, {
				providerId: CLAUDE_PROVIDER_ID,
				modelId: modelId.trim() || null,
				// Keep Claude's provider slot independent of the Cline agent's active
				// provider selection.
				setLastUsed: false,
			});
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				message: error instanceof Error ? error.message : "Failed to save Claude settings.",
			};
		}
	}, [modelId, workspaceId]);

	return {
		modelId,
		setModelId,
		models,
		isLoadingModels,
		subscriptionConfigured,
		configuredModelId,
		hasUnsavedChanges,
		saveClaudeSettings,
	};
}
