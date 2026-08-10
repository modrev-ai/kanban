import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRuntimeSettingsModrevController } from "@/hooks/use-runtime-settings-modrev-controller";
import type { RuntimeAgentId, RuntimeClineProviderSettings, RuntimeConfigResponse } from "@/runtime/types";

const fetchClineProviderCatalogMock = vi.hoisted(() => vi.fn());
const addClineProviderMock = vi.hoisted(() => vi.fn());
const updateClineProviderMock = vi.hoisted(() => vi.fn());
const saveClineProviderSettingsMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/runtime-config-query", () => ({
	fetchClineProviderCatalog: fetchClineProviderCatalogMock,
	addClineProvider: addClineProviderMock,
	updateClineProvider: updateClineProviderMock,
	saveClineProviderSettings: saveClineProviderSettingsMock,
}));

interface HookSnapshot {
	apiKey: string;
	baseUrl: string;
	modelId: string;
	apiKeyConfigured: boolean;
	hasUnsavedChanges: boolean;
	setApiKey: (next: string) => void;
	setBaseUrl: (next: string) => void;
	setModelId: (next: string) => void;
	saveModrevSettings: () => Promise<{ ok: boolean; message?: string }>;
}

function requireSnapshot(snapshot: HookSnapshot | null): HookSnapshot {
	if (!snapshot) {
		throw new Error("Expected hook snapshot.");
	}
	return snapshot;
}

async function flushAsyncWork(): Promise<void> {
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
			apiKey: state.apiKey,
			baseUrl: state.baseUrl,
			modelId: state.modelId,
			apiKeyConfigured: state.apiKeyConfigured,
			hasUnsavedChanges: state.hasUnsavedChanges,
			setApiKey: state.setApiKey,
			setBaseUrl: state.setBaseUrl,
			setModelId: state.setModelId,
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
		fetchClineProviderCatalogMock.mockResolvedValue([]);
		addClineProviderMock.mockResolvedValue(makeProviderSettings({ providerId: "modrev" }));
		updateClineProviderMock.mockResolvedValue(makeProviderSettings({ providerId: "modrev" }));
		saveClineProviderSettingsMock.mockResolvedValue(makeProviderSettings({ providerId: "modrev" }));

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

	it("seeds draft fields from a persisted modrev provider", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const config = makeConfig(
			makeProviderSettings({
				providerId: "modrev",
				modelId: "modrev/model-a",
				baseUrl: "https://api.modrev.ai/v1",
				apiKeyConfigured: true,
			}),
		);

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

		expect(requireSnapshot(latestSnapshot).baseUrl).toBe("https://api.modrev.ai/v1");
		expect(requireSnapshot(latestSnapshot).modelId).toBe("modrev/model-a");
		expect(requireSnapshot(latestSnapshot).apiKeyConfigured).toBe(true);
		expect(requireSnapshot(latestSnapshot).hasUnsavedChanges).toBe(false);
	});

	it("requires base URL, model ID, and API key before saving", async () => {
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
		expect(addClineProviderMock).not.toHaveBeenCalled();
		expect(saveClineProviderSettingsMock).not.toHaveBeenCalled();
	});

	it("registers a new modrev provider and selects it on save", async () => {
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

		await act(async () => {
			requireSnapshot(latestSnapshot).setApiKey("secret-key");
			requireSnapshot(latestSnapshot).setBaseUrl("https://api.modrev.ai/v1");
			requireSnapshot(latestSnapshot).setModelId("modrev/model-a");
			await flushAsyncWork();
		});

		expect(requireSnapshot(latestSnapshot).hasUnsavedChanges).toBe(true);

		let result: { ok: boolean; message?: string } = { ok: false };
		await act(async () => {
			result = await requireSnapshot(latestSnapshot).saveModrevSettings();
			await flushAsyncWork();
		});

		expect(result.ok).toBe(true);
		expect(addClineProviderMock).toHaveBeenCalledWith("workspace-1", {
			providerId: "modrev",
			name: "Modrev",
			baseUrl: "https://api.modrev.ai/v1",
			apiKey: "secret-key",
			models: ["modrev/model-a"],
			defaultModelId: "modrev/model-a",
			capabilities: ["streaming", "tools"],
		});
		expect(updateClineProviderMock).not.toHaveBeenCalled();
		expect(saveClineProviderSettingsMock).toHaveBeenCalledWith("workspace-1", {
			providerId: "modrev",
			modelId: "modrev/model-a",
			baseUrl: "https://api.modrev.ai/v1",
			apiKey: "secret-key",
		});
	});

	it("updates the existing modrev provider without re-sending a saved key", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		fetchClineProviderCatalogMock.mockResolvedValue([
			{
				id: "modrev",
				name: "Modrev",
				oauthSupported: false,
				enabled: true,
				defaultModelId: "modrev/model-a",
				baseUrl: "https://api.modrev.ai/v1",
				supportsBaseUrl: true,
			},
		]);
		const config = makeConfig(
			makeProviderSettings({
				providerId: "modrev",
				modelId: "modrev/model-a",
				baseUrl: "https://api.modrev.ai/v1",
				apiKeyConfigured: true,
			}),
		);

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

		await act(async () => {
			requireSnapshot(latestSnapshot).setModelId("modrev/model-b");
			await flushAsyncWork();
		});

		let result: { ok: boolean; message?: string } = { ok: false };
		await act(async () => {
			result = await requireSnapshot(latestSnapshot).saveModrevSettings();
			await flushAsyncWork();
		});

		expect(result.ok).toBe(true);
		expect(addClineProviderMock).not.toHaveBeenCalled();
		expect(updateClineProviderMock).toHaveBeenCalledWith("workspace-1", {
			providerId: "modrev",
			name: "Modrev",
			baseUrl: "https://api.modrev.ai/v1",
			models: ["modrev/model-b"],
			defaultModelId: "modrev/model-b",
		});
		expect(saveClineProviderSettingsMock).toHaveBeenCalledWith("workspace-1", {
			providerId: "modrev",
			modelId: "modrev/model-b",
			baseUrl: "https://api.modrev.ai/v1",
		});
	});
});
