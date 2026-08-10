import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ModrevModel, useRuntimeSettingsModrevController } from "@/hooks/use-runtime-settings-modrev-controller";
import type {
	RuntimeAgentId,
	RuntimeClineProviderCatalogItem,
	RuntimeClineProviderSettings,
	RuntimeConfigResponse,
} from "@/runtime/types";

const fetchClineProviderCatalogMock = vi.hoisted(() => vi.fn());
const addClineProviderMock = vi.hoisted(() => vi.fn());
const updateClineProviderMock = vi.hoisted(() => vi.fn());
const deleteClineProviderMock = vi.hoisted(() => vi.fn());
const saveClineProviderSettingsMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/runtime-config-query", () => ({
	fetchClineProviderCatalog: fetchClineProviderCatalogMock,
	addClineProvider: addClineProviderMock,
	updateClineProvider: updateClineProviderMock,
	deleteClineProvider: deleteClineProviderMock,
	saveClineProviderSettings: saveClineProviderSettingsMock,
}));

interface HookSnapshot {
	models: ModrevModel[];
	activeProviderId: string;
	isLoadingModels: boolean;
	existingProviderIds: string[];
	hasUnsavedChanges: boolean;
	selectModel: (providerId: string) => Promise<{ ok: boolean; message?: string }>;
	addModel: (input: Parameters<HookSnapshotControllerAdd>[0]) => Promise<{ ok: boolean; message?: string }>;
	updateModel: (input: Parameters<HookSnapshotControllerUpdate>[0]) => Promise<{ ok: boolean; message?: string }>;
	removeModel: (providerId: string) => Promise<{ ok: boolean; message?: string }>;
	saveModrevSettings: () => Promise<{ ok: boolean; message?: string }>;
}

type HookSnapshotControllerAdd = ReturnType<typeof useRuntimeSettingsModrevController>["addModel"];
type HookSnapshotControllerUpdate = ReturnType<typeof useRuntimeSettingsModrevController>["updateModel"];

function requireSnapshot(snapshot: HookSnapshot | null): HookSnapshot {
	if (!snapshot) {
		throw new Error("Expected hook snapshot.");
	}
	return snapshot;
}

async function flushAsyncWork(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function makeProviderSettings(overrides: Partial<RuntimeClineProviderSettings> = {}): RuntimeClineProviderSettings {
	return {
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
		...overrides,
	};
}

function makeConfig(providerSettings: RuntimeClineProviderSettings): RuntimeConfigResponse {
	return { clineProviderSettings: providerSettings } as unknown as RuntimeConfigResponse;
}

function makeCatalogItem(overrides: Partial<RuntimeClineProviderCatalogItem> = {}): RuntimeClineProviderCatalogItem {
	return {
		id: "modrev-a",
		name: "Modrev A",
		oauthSupported: false,
		enabled: false,
		defaultModelId: "model-a",
		baseUrl: "https://api.modrev.ai/v1",
		supportsBaseUrl: true,
		...overrides,
	};
}

function HookHarness({
	config,
	onSnapshot,
}: {
	config: RuntimeConfigResponse | null;
	onSnapshot: (snapshot: HookSnapshot) => void;
}): null {
	const state = useRuntimeSettingsModrevController({
		open: true,
		workspaceId: "workspace-1",
		selectedAgentId: "modrev" as RuntimeAgentId,
		config,
	});

	useEffect(() => {
		onSnapshot({
			models: state.models,
			activeProviderId: state.activeProviderId,
			isLoadingModels: state.isLoadingModels,
			existingProviderIds: state.existingProviderIds,
			hasUnsavedChanges: state.hasUnsavedChanges,
			selectModel: state.selectModel,
			addModel: state.addModel,
			updateModel: state.updateModel,
			removeModel: state.removeModel,
			saveModrevSettings: state.saveModrevSettings,
		});
	}, [onSnapshot, state]);

	return null;
}

describe("useRuntimeSettingsModrevController", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		fetchClineProviderCatalogMock.mockReset();
		addClineProviderMock.mockReset();
		updateClineProviderMock.mockReset();
		saveClineProviderSettingsMock.mockReset();
		deleteClineProviderMock.mockReset();
		fetchClineProviderCatalogMock.mockResolvedValue([]);
		addClineProviderMock.mockResolvedValue(makeProviderSettings({ providerId: "modrev-a" }));
		updateClineProviderMock.mockResolvedValue(makeProviderSettings({ providerId: "modrev-a" }));
		deleteClineProviderMock.mockResolvedValue(makeProviderSettings());
		saveClineProviderSettingsMock.mockResolvedValue(makeProviderSettings({ providerId: "modrev-a" }));

		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("lists only namespaced modrev models and seeds the active selection", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		fetchClineProviderCatalogMock.mockResolvedValue([
			makeCatalogItem({ id: "modrev-a", name: "Modrev A" }),
			makeCatalogItem({ id: "anthropic", name: "Anthropic" }),
			makeCatalogItem({ id: "modrev", name: "Modrev Legacy" }),
		]);
		const config = makeConfig(makeProviderSettings({ providerId: "modrev-a" }));

		await act(async () => {
			root.render(
				<HookHarness
					config={config}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushAsyncWork();
		});

		const snapshot = requireSnapshot(latestSnapshot);
		expect(snapshot.models.map((model) => model.providerId)).toEqual(["modrev-a", "modrev"]);
		expect(snapshot.activeProviderId).toBe("modrev-a");
		expect(snapshot.existingProviderIds).toContain("anthropic");
	});

	it("adds a model under the modrev namespace and activates it", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		await act(async () => {
			root.render(
				<HookHarness
					config={makeConfig(makeProviderSettings())}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushAsyncWork();
		});

		let result: { ok: boolean; message?: string } = { ok: false };
		await act(async () => {
			result = await requireSnapshot(latestSnapshot).addModel({
				providerId: "gpt-oss",
				name: "GPT OSS",
				baseUrl: "https://api.modrev.ai/v1",
				apiKey: "secret",
				models: ["gpt-oss-120b"],
				defaultModelId: "gpt-oss-120b",
			});
			await flushAsyncWork();
		});

		expect(result.ok).toBe(true);
		expect(addClineProviderMock).toHaveBeenCalledWith("workspace-1", {
			providerId: "modrev-gpt-oss",
			name: "GPT OSS",
			baseUrl: "https://api.modrev.ai/v1",
			apiKey: "secret",
			models: ["gpt-oss-120b"],
			defaultModelId: "gpt-oss-120b",
		});
		expect(saveClineProviderSettingsMock).toHaveBeenCalledWith("workspace-1", {
			providerId: "modrev-gpt-oss",
			modelId: "gpt-oss-120b",
			baseUrl: "https://api.modrev.ai/v1",
			apiKey: "secret",
		});
		expect(requireSnapshot(latestSnapshot).activeProviderId).toBe("modrev-gpt-oss");
	});

	it("selects an existing model as the active provider", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		fetchClineProviderCatalogMock.mockResolvedValue([
			makeCatalogItem({ id: "modrev-a", name: "Modrev A", defaultModelId: "model-a" }),
			makeCatalogItem({
				id: "modrev-b",
				name: "Modrev B",
				defaultModelId: "model-b",
				baseUrl: "https://b.modrev.ai/v1",
			}),
		]);
		await act(async () => {
			root.render(
				<HookHarness
					config={makeConfig(makeProviderSettings({ providerId: "modrev-a" }))}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushAsyncWork();
		});

		await act(async () => {
			await requireSnapshot(latestSnapshot).selectModel("modrev-b");
			await flushAsyncWork();
		});

		expect(saveClineProviderSettingsMock).toHaveBeenCalledWith("workspace-1", {
			providerId: "modrev-b",
			modelId: "model-b",
			baseUrl: "https://b.modrev.ai/v1",
		});
		expect(requireSnapshot(latestSnapshot).activeProviderId).toBe("modrev-b");
	});

	it("requires at least one model when saving with Modrev selected", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		await act(async () => {
			root.render(
				<HookHarness
					config={makeConfig(makeProviderSettings())}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushAsyncWork();
		});

		let result: { ok: boolean; message?: string } = { ok: true };
		await act(async () => {
			result = await requireSnapshot(latestSnapshot).saveModrevSettings();
			await flushAsyncWork();
		});
		expect(result.ok).toBe(false);
	});

	it("removes a model and promotes another when the active one is deleted", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		fetchClineProviderCatalogMock.mockResolvedValueOnce([
			makeCatalogItem({ id: "modrev-a", name: "Modrev A", defaultModelId: "model-a" }),
			makeCatalogItem({ id: "modrev-b", name: "Modrev B", defaultModelId: "model-b" }),
		]);
		// After the delete the reload returns only the surviving model.
		fetchClineProviderCatalogMock.mockResolvedValue([
			makeCatalogItem({ id: "modrev-b", name: "Modrev B", defaultModelId: "model-b" }),
		]);
		await act(async () => {
			root.render(
				<HookHarness
					config={makeConfig(makeProviderSettings({ providerId: "modrev-a" }))}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushAsyncWork();
		});

		let result: { ok: boolean; message?: string } = { ok: false };
		await act(async () => {
			result = await requireSnapshot(latestSnapshot).removeModel("modrev-a");
			await flushAsyncWork();
		});

		expect(result.ok).toBe(true);
		expect(deleteClineProviderMock).toHaveBeenCalledWith("workspace-1", { providerId: "modrev-a" });
		expect(requireSnapshot(latestSnapshot).models.map((model) => model.providerId)).toEqual(["modrev-b"]);
		expect(requireSnapshot(latestSnapshot).activeProviderId).toBe("modrev-b");
	});
});
