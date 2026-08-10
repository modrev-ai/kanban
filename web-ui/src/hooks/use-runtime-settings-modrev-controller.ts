// Owns the Modrev-specific settings state inside the settings dialog.
//
// Modrev is a native, in-app-authenticated agent that reuses the Cline SDK
// runtime. Instead of a single pinned provider, Modrev exposes a list of custom
// "models" — each one a full OpenAI-compatible provider (name, base URL, API
// key, model source URL, models, capabilities, timeout) registered through the
// same machinery as a Cline custom API provider. Modrev models are namespaced
// by a "modrev-" provider-id prefix (the legacy exact id "modrev" is also
// treated as a Modrev model) so they stay separate from the Cline agent's own
// providers. The currently selected model is persisted as the active Cline
// provider so task launches resolve their config from it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AddClineProviderInput, UpdateClineProviderInput } from "@/hooks/use-runtime-settings-cline-controller";
import { getRuntimeClineProviderSettings } from "@/runtime/native-agent";
import {
	addClineProvider,
	deleteClineProvider,
	fetchClineProviderCatalog,
	saveClineProviderSettings,
	updateClineProvider,
} from "@/runtime/runtime-config-query";
import type { RuntimeAgentId, RuntimeClineProviderCatalogItem, RuntimeConfigResponse } from "@/runtime/types";

export const MODREV_PROVIDER_ID_PREFIX = "modrev-";
export const MODREV_LEGACY_PROVIDER_ID = "modrev";

export interface ModrevModel {
	providerId: string;
	name: string;
	baseUrl: string | null;
	defaultModelId: string | null;
}

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
	models: ModrevModel[];
	activeProviderId: string;
	isLoadingModels: boolean;
	existingProviderIds: string[];
	hasUnsavedChanges: boolean;
	reloadModels: () => Promise<void>;
	selectModel: (providerId: string) => Promise<SaveResult>;
	addModel: (input: AddClineProviderInput) => Promise<SaveResult>;
	updateModel: (input: UpdateClineProviderInput) => Promise<SaveResult>;
	removeModel: (providerId: string) => Promise<SaveResult>;
	saveModrevSettings: () => Promise<SaveResult>;
}

export function isModrevModelProviderId(providerId: string | null | undefined): boolean {
	const normalized = providerId?.trim().toLowerCase() ?? "";
	return normalized === MODREV_LEGACY_PROVIDER_ID || normalized.startsWith(MODREV_PROVIDER_ID_PREFIX);
}

// Normalizes a user-entered provider id into the Modrev namespace so every
// registered model is discoverable via the prefix filter.
export function ensureModrevProviderId(providerId: string): string {
	const normalized = providerId.trim().toLowerCase().replace(/\s+/g, "-");
	if (isModrevModelProviderId(normalized)) {
		return normalized;
	}
	return `${MODREV_PROVIDER_ID_PREFIX}${normalized}`;
}

function toModrevModel(item: RuntimeClineProviderCatalogItem): ModrevModel {
	return {
		providerId: item.id,
		name: item.name,
		baseUrl: item.baseUrl,
		defaultModelId: item.defaultModelId,
	};
}

export function useRuntimeSettingsModrevController(
	options: UseRuntimeSettingsModrevControllerOptions,
): UseRuntimeSettingsModrevControllerResult {
	const { open, workspaceId, selectedAgentId, config } = options;
	const [catalog, setCatalog] = useState<RuntimeClineProviderCatalogItem[]>([]);
	const [isLoadingModels, setIsLoadingModels] = useState(false);
	const [activeProviderId, setActiveProviderId] = useState("");
	const catalogRequestIdRef = useRef(0);

	const configProviderId = getRuntimeClineProviderSettings(config).providerId ?? "";
	const configActiveModrevProviderId = isModrevModelProviderId(configProviderId)
		? configProviderId.trim().toLowerCase()
		: "";

	const models = useMemo(
		() => catalog.filter((item) => isModrevModelProviderId(item.id)).map(toModrevModel),
		[catalog],
	);
	const existingProviderIds = useMemo(() => catalog.map((item) => item.id), [catalog]);

	const loadModels = useCallback(async (): Promise<void> => {
		const requestId = catalogRequestIdRef.current + 1;
		catalogRequestIdRef.current = requestId;
		setIsLoadingModels(true);
		try {
			const nextCatalog = await fetchClineProviderCatalog(workspaceId);
			if (catalogRequestIdRef.current === requestId) {
				setCatalog(nextCatalog);
			}
		} catch {
			if (catalogRequestIdRef.current === requestId) {
				setCatalog([]);
			}
		} finally {
			if (catalogRequestIdRef.current === requestId) {
				setIsLoadingModels(false);
			}
		}
	}, [workspaceId]);

	// Load the provider catalog whenever the Modrev agent settings are shown.
	useEffect(() => {
		if (!open || selectedAgentId !== "modrev") {
			catalogRequestIdRef.current += 1;
			setCatalog([]);
			setIsLoadingModels(false);
			return;
		}
		void loadModels();
	}, [loadModels, open, selectedAgentId]);

	// Seed the active selection from the persisted provider settings.
	useEffect(() => {
		if (!open) {
			return;
		}
		setActiveProviderId(configActiveModrevProviderId);
	}, [configActiveModrevProviderId, open]);

	const persistActiveModel = useCallback(
		async (model: ModrevModel): Promise<void> => {
			await saveClineProviderSettings(workspaceId, {
				providerId: model.providerId,
				modelId: model.defaultModelId,
				baseUrl: model.baseUrl,
			});
		},
		[workspaceId],
	);

	const selectModel = useCallback(
		async (providerId: string): Promise<SaveResult> => {
			const model = models.find((entry) => entry.providerId === providerId);
			if (!model) {
				return { ok: false, message: "That Modrev model no longer exists." };
			}
			try {
				await persistActiveModel(model);
				setActiveProviderId(model.providerId);
				return { ok: true };
			} catch (error) {
				return { ok: false, message: error instanceof Error ? error.message : String(error) };
			}
		},
		[models, persistActiveModel],
	);

	const addModel = useCallback(
		async (input: AddClineProviderInput): Promise<SaveResult> => {
			const providerId = ensureModrevProviderId(input.providerId);
			try {
				await addClineProvider(workspaceId, { ...input, providerId });
				await saveClineProviderSettings(workspaceId, {
					providerId,
					modelId: input.defaultModelId?.trim() || input.models[0] || null,
					baseUrl: input.baseUrl,
					...(input.apiKey ? { apiKey: input.apiKey } : {}),
				});
				setActiveProviderId(providerId);
				await loadModels();
				return { ok: true };
			} catch (error) {
				return { ok: false, message: error instanceof Error ? error.message : String(error) };
			}
		},
		[loadModels, workspaceId],
	);

	const updateModel = useCallback(
		async (input: UpdateClineProviderInput): Promise<SaveResult> => {
			const providerId = input.providerId.trim().toLowerCase();
			try {
				await updateClineProvider(workspaceId, { ...input, providerId });
				await loadModels();
				if (providerId === activeProviderId) {
					const nextCatalog = await fetchClineProviderCatalog(workspaceId);
					const updated = nextCatalog.find((item) => item.id === providerId);
					if (updated) {
						await persistActiveModel(toModrevModel(updated));
					}
				}
				return { ok: true };
			} catch (error) {
				return { ok: false, message: error instanceof Error ? error.message : String(error) };
			}
		},
		[activeProviderId, loadModels, persistActiveModel, workspaceId],
	);

	const removeModel = useCallback(
		async (providerId: string): Promise<SaveResult> => {
			const normalizedProviderId = providerId.trim().toLowerCase();
			try {
				await deleteClineProvider(workspaceId, { providerId: normalizedProviderId });
				const nextCatalog = await fetchClineProviderCatalog(workspaceId);
				catalogRequestIdRef.current += 1;
				setCatalog(nextCatalog);
				// If the removed model was active, promote another Modrev model so
				// launches keep resolving, or clear the selection when none remain.
				if (normalizedProviderId === activeProviderId) {
					const nextActive = nextCatalog.find((item) => isModrevModelProviderId(item.id));
					if (nextActive) {
						await persistActiveModel(toModrevModel(nextActive));
						setActiveProviderId(nextActive.id);
					} else {
						setActiveProviderId("");
					}
				}
				return { ok: true };
			} catch (error) {
				return { ok: false, message: error instanceof Error ? error.message : String(error) };
			}
		},
		[activeProviderId, persistActiveModel, workspaceId],
	);

	// Modrev model changes persist immediately (add/edit/select each call the
	// backend), so there is no local draft to fold into the dialog's Save.
	const hasUnsavedChanges = false;

	const saveModrevSettings = useCallback(async (): Promise<SaveResult> => {
		if (selectedAgentId !== "modrev") {
			return { ok: true };
		}
		const firstModel = models[0];
		if (!firstModel) {
			return { ok: false, message: "Add at least one Modrev model before saving." };
		}
		if (!activeProviderId) {
			// Nothing selected yet — activate the first model so launches resolve.
			return selectModel(firstModel.providerId);
		}
		return { ok: true };
	}, [activeProviderId, models, selectModel, selectedAgentId]);

	return {
		models,
		activeProviderId,
		isLoadingModels,
		existingProviderIds,
		hasUnsavedChanges,
		reloadModels: loadModels,
		selectModel,
		addModel,
		updateModel,
		removeModel,
		saveModrevSettings,
	};
}
