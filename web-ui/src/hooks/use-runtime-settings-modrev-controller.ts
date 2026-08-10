// Owns the Modrev-specific settings state inside the settings dialog.
//
// Modrev is a native, in-app-authenticated agent that reuses the Cline SDK
// runtime but is pinned to a single custom OpenAI-compatible provider (id
// "modrev"). The user configures it with an API key, base URL, and model ID —
// exactly like a Cline custom API provider. Saving registers/updates that
// custom provider and selects it as the active Cline provider so task launches
// resolve their launch config from it.
import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from "react";
import { getRuntimeClineProviderSettings } from "@/runtime/native-agent";
import {
	addClineProvider,
	fetchClineProviderCatalog,
	saveClineProviderSettings,
	updateClineProvider,
} from "@/runtime/runtime-config-query";
import type { RuntimeAgentId, RuntimeConfigResponse } from "@/runtime/types";

export const MODREV_PROVIDER_ID = "modrev";
export const MODREV_PROVIDER_NAME = "Modrev";

interface UseRuntimeSettingsModrevControllerOptions {
	open: boolean;
	workspaceId: string | null;
	selectedAgentId: RuntimeAgentId;
	config: RuntimeConfigResponse | null;
}

interface SaveResult {
	ok: boolean;
	message?: string;
}

export interface UseRuntimeSettingsModrevControllerResult {
	apiKey: string;
	setApiKey: Dispatch<SetStateAction<string>>;
	baseUrl: string;
	setBaseUrl: Dispatch<SetStateAction<string>>;
	modelId: string;
	setModelId: Dispatch<SetStateAction<string>>;
	apiKeyConfigured: boolean;
	hasUnsavedChanges: boolean;
	saveModrevSettings: () => Promise<SaveResult>;
}

function isModrevProviderSelected(config: RuntimeConfigResponse | null): boolean {
	return getRuntimeClineProviderSettings(config).providerId?.trim().toLowerCase() === MODREV_PROVIDER_ID;
}

export function useRuntimeSettingsModrevController(
	options: UseRuntimeSettingsModrevControllerOptions,
): UseRuntimeSettingsModrevControllerResult {
	const { open, workspaceId, selectedAgentId, config } = options;
	const [apiKey, setApiKey] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [modelId, setModelId] = useState("");

	const providerSettings = getRuntimeClineProviderSettings(config);
	const modrevSelected = isModrevProviderSelected(config);
	const initialBaseUrl = modrevSelected ? (providerSettings.baseUrl?.trim() ?? "") : "";
	const initialModelId = modrevSelected ? (providerSettings.modelId?.trim() ?? "") : "";
	const apiKeyConfigured = modrevSelected ? providerSettings.apiKeyConfigured : false;

	// Re-seed the draft fields whenever the dialog (re)opens or the persisted
	// Modrev provider settings change underneath us.
	useEffect(() => {
		if (!open) {
			return;
		}
		setApiKey("");
		setBaseUrl(initialBaseUrl);
		setModelId(initialModelId);
	}, [open, initialBaseUrl, initialModelId]);

	const hasUnsavedChanges = useMemo(() => {
		if (!config) {
			return false;
		}
		if (apiKey.trim().length > 0) {
			return true;
		}
		if (baseUrl.trim() !== initialBaseUrl.trim()) {
			return true;
		}
		return modelId.trim() !== initialModelId.trim();
	}, [apiKey, baseUrl, config, initialBaseUrl, initialModelId, modelId]);

	const saveModrevSettings = async (): Promise<SaveResult> => {
		if (selectedAgentId !== "modrev") {
			return { ok: true };
		}
		const trimmedBaseUrl = baseUrl.trim();
		const trimmedModelId = modelId.trim();
		const trimmedApiKey = apiKey.trim();

		if (trimmedBaseUrl.length === 0) {
			return { ok: false, message: "Enter a base URL for Modrev." };
		}
		if (trimmedModelId.length === 0) {
			return { ok: false, message: "Enter a model ID for Modrev." };
		}
		if (trimmedApiKey.length === 0 && !apiKeyConfigured) {
			return { ok: false, message: "Enter an API key for Modrev." };
		}

		try {
			const catalog = await fetchClineProviderCatalog(workspaceId);
			const providerExists = catalog.some((provider) => provider.id.trim().toLowerCase() === MODREV_PROVIDER_ID);

			if (providerExists) {
				await updateClineProvider(workspaceId, {
					providerId: MODREV_PROVIDER_ID,
					name: MODREV_PROVIDER_NAME,
					baseUrl: trimmedBaseUrl,
					models: [trimmedModelId],
					defaultModelId: trimmedModelId,
					...(trimmedApiKey.length > 0 ? { apiKey: trimmedApiKey } : {}),
				});
			} else {
				await addClineProvider(workspaceId, {
					providerId: MODREV_PROVIDER_ID,
					name: MODREV_PROVIDER_NAME,
					baseUrl: trimmedBaseUrl,
					apiKey: trimmedApiKey.length > 0 ? trimmedApiKey : null,
					models: [trimmedModelId],
					defaultModelId: trimmedModelId,
					capabilities: ["streaming", "tools"],
				});
			}

			// Select the Modrev provider and persist the active model/base URL/key
			// so task launches resolve their config from it.
			await saveClineProviderSettings(workspaceId, {
				providerId: MODREV_PROVIDER_ID,
				modelId: trimmedModelId,
				baseUrl: trimmedBaseUrl,
				...(trimmedApiKey.length > 0 ? { apiKey: trimmedApiKey } : {}),
			});

			setApiKey("");
			return { ok: true };
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
	};

	return {
		apiKey,
		setApiKey,
		baseUrl,
		setBaseUrl,
		modelId,
		setModelId,
		apiKeyConfigured,
		hasUnsavedChanges,
		saveModrevSettings,
	};
}
