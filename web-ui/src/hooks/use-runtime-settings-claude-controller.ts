// Owns the native Claude agent's settings inside the settings dialog.
//
// Claude runs through the Cline SDK runtime pinned to the SDK's built-in
// "anthropic" provider. Its API key and model live in the "anthropic"
// provider-settings slot, saved with setLastUsed:false so configuring Claude
// never changes the Cline agent's active provider — mirroring how Modrev stays
// independent of the shared Cline provider selection.
import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchClineProviderModels, saveClineProviderSettings } from "@/runtime/runtime-config-query";
import type { RuntimeClineProviderModel, RuntimeConfigResponse } from "@/runtime/types";

// The built-in SDK provider the native Claude agent runs through.
export const CLAUDE_PROVIDER_ID = "anthropic";

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
	apiKey: string;
	setApiKey: Dispatch<SetStateAction<string>>;
	modelId: string;
	setModelId: Dispatch<SetStateAction<string>>;
	models: RuntimeClineProviderModel[];
	isLoadingModels: boolean;
	apiKeyConfigured: boolean;
	configuredModelId: string | null;
	hasUnsavedChanges: boolean;
	saveClaudeSettings: () => Promise<SaveResult>;
}

export function useRuntimeSettingsClaudeController(
	options: UseRuntimeSettingsClaudeControllerOptions,
): UseRuntimeSettingsClaudeControllerResult {
	const { open, workspaceId, config } = options;
	const claudeSettings = config?.claudeProviderSettings ?? null;
	const apiKeyConfigured = claudeSettings?.apiKeyConfigured ?? false;
	const configuredModelId = claudeSettings?.modelId ?? null;

	const [apiKey, setApiKey] = useState("");
	const [modelId, setModelId] = useState(configuredModelId ?? "");
	const [models, setModels] = useState<RuntimeClineProviderModel[]>([]);
	const [isLoadingModels, setIsLoadingModels] = useState(false);
	const modelsRequestIdRef = useRef(0);

	// Re-seed the draft from the persisted anthropic slot each time the dialog
	// opens. The API key is never hydrated back (it is write-only), so start the
	// key field blank and rely on `apiKeyConfigured` for the placeholder.
	useEffect(() => {
		if (!open) {
			return;
		}
		setModelId(configuredModelId ?? "");
		setApiKey("");
	}, [configuredModelId, open]);

	// Load the Anthropic model catalog while the dialog is open.
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

	const hasUnsavedChanges = useMemo(
		() => apiKey.trim().length > 0 || modelId.trim() !== (configuredModelId ?? "").trim(),
		[apiKey, configuredModelId, modelId],
	);

	const saveClaudeSettings = useCallback(async (): Promise<SaveResult> => {
		try {
			const trimmedApiKey = apiKey.trim();
			await saveClineProviderSettings(workspaceId, {
				providerId: CLAUDE_PROVIDER_ID,
				modelId: modelId.trim() || null,
				// Only send the key when the user typed one, so saving a model change
				// does not wipe an already-configured API key.
				...(trimmedApiKey ? { apiKey: trimmedApiKey } : {}),
				// Keep Claude's provider slot independent of the Cline agent's active
				// provider selection.
				setLastUsed: false,
			});
			setApiKey("");
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				message: error instanceof Error ? error.message : "Failed to save Claude settings.",
			};
		}
	}, [apiKey, modelId, workspaceId]);

	return {
		apiKey,
		setApiKey,
		modelId,
		setModelId,
		models,
		isLoadingModels,
		apiKeyConfigured,
		configuredModelId,
		hasUnsavedChanges,
		saveClaudeSettings,
	};
}
