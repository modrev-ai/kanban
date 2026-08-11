// Owns the Modrev-specific settings state inside the settings dialog.
//
// Modrev is a native, in-app-authenticated agent that reuses the Cline SDK
// runtime. Each Modrev "model" is a full OpenAI-compatible provider (name, base
// URL, API key, model source URL, models, capabilities, timeout) registered
// through the same machinery as a Cline custom API provider, namespaced by a
// "modrev-" provider-id prefix.
//
// Crucially, Modrev's active model is tracked in Kanban's own config
// (modrevProviderId / modrevModelId), independently of the SDK-owned "last
// used" Cline provider. Registering or selecting a Modrev model never changes
// the Cline agent's active provider, so the two native agents operate
// independently.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AddClineProviderInput, UpdateClineProviderInput } from "@/hooks/use-runtime-settings-cline-controller";
import { ensureModrevProviderId, isModrevModelProviderId } from "@/runtime/modrev-provider";
import {
	addClineProvider,
	deleteClineProvider,
	fetchClineProviderCatalog,
	saveRuntimeConfig,
	updateClineProvider,
} from "@/runtime/runtime-config-query";
import type { RuntimeAgentId, RuntimeClineProviderCatalogItem, RuntimeConfigResponse } from "@/runtime/types";

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

	const configActiveModrevProviderId = isModrevModelProviderId(config?.modrevProviderId)
		? (config?.modrevProviderId?.trim().toLowerCase() ?? "")
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

	// Load the provider catalog whenever the settings dialog is open. The Models
	// registry is always visible (not gated on the Modrev agent being selected),
	// so registered Modrev models must load regardless of the active agent.
	useEffect(() => {
		if (!open) {
			catalogRequestIdRef.current += 1;
			setCatalog([]);
			setIsLoadingModels(false);
			return;
		}
		void loadModels();
	}, [loadModels, open]);

	// Seed the active selection from the persisted Modrev config.
	useEffect(() => {
		if (!open) {
			return;
		}
		setActiveProviderId(configActiveModrevProviderId);
	}, [configActiveModrevProviderId, open]);

	// Persist the Modrev active model to Kanban config (not the shared Cline
	// provider selection), keeping the two agents independent.
	const persistActiveSelection = useCallback(
		async (model: ModrevModel | null): Promise<void> => {
			await saveRuntimeConfig(workspaceId, {
				modrevProviderId: model?.providerId ?? null,
				modrevModelId: model?.defaultModelId ?? null,
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
				await persistActiveSelection(model);
				setActiveProviderId(model.providerId);
				return { ok: true };
			} catch (error) {
				return { ok: false, message: error instanceof Error ? error.message : String(error) };
			}
		},
		[models, persistActiveSelection],
	);

	const addModel = useCallback(
		async (input: AddClineProviderInput): Promise<SaveResult> => {
			const providerId = ensureModrevProviderId(input.providerId);
			try {
				// Register the provider without hijacking the Cline agent's active
				// provider, then record it as Modrev's active model in Kanban config.
				await addClineProvider(workspaceId, { ...input, providerId, setLastUsed: false });
				await persistActiveSelection({
					providerId,
					name: input.name,
					baseUrl: input.baseUrl,
					defaultModelId: input.defaultModelId?.trim() || input.models[0] || null,
				});
				setActiveProviderId(providerId);
				await loadModels();
				return { ok: true };
			} catch (error) {
				return { ok: false, message: error instanceof Error ? error.message : String(error) };
			}
		},
		[loadModels, persistActiveSelection, workspaceId],
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
						await persistActiveSelection(toModrevModel(updated));
					}
				}
				return { ok: true };
			} catch (error) {
				return { ok: false, message: error instanceof Error ? error.message : String(error) };
			}
		},
		[activeProviderId, loadModels, persistActiveSelection, workspaceId],
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
					const nextActive = nextCatalog.find((item) => isModrevModelProviderId(item.id)) ?? null;
					await persistActiveSelection(nextActive ? toModrevModel(nextActive) : null);
					setActiveProviderId(nextActive?.id ?? "");
				}
				return { ok: true };
			} catch (error) {
				return { ok: false, message: error instanceof Error ? error.message : String(error) };
			}
		},
		[activeProviderId, persistActiveSelection, workspaceId],
	);

	// Modrev model changes persist immediately (add/edit/select/remove each call
	// the backend), so there is no local draft to fold into the dialog's Save.
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
