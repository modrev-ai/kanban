import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	type UseRuntimeSettingsClaudeControllerResult,
	useRuntimeSettingsClaudeController,
} from "@/hooks/use-runtime-settings-claude-controller";
import type { RuntimeClineProviderSettings, RuntimeConfigResponse } from "@/runtime/types";

const fetchClineProviderModelsMock = vi.hoisted(() => vi.fn());
const saveClineProviderSettingsMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/runtime-config-query", () => ({
	fetchClineProviderModels: fetchClineProviderModelsMock,
	saveClineProviderSettings: saveClineProviderSettingsMock,
}));

function makeProviderSettings(overrides: Partial<RuntimeClineProviderSettings> = {}): RuntimeClineProviderSettings {
	return {
		providerId: null,
		modelId: null,
		baseUrl: null,
		apiKeyConfigured: false,
		oauthProvider: null,
		oauthAccessTokenConfigured: false,
		oauthRefreshTokenConfigured: false,
		oauthAccountId: null,
		oauthExpiresAt: null,
		...overrides,
	};
}

function makeConfig(claude: RuntimeClineProviderSettings): RuntimeConfigResponse {
	return {
		selectedAgentId: "claude",
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		effectiveCommand: null,
		globalConfigPath: "/tmp/global.json",
		projectConfigPath: "/tmp/project.json",
		readyForReviewNotificationsEnabled: true,
		detectedCommands: [],
		agents: [],
		shortcuts: [],
		clineProviderSettings: makeProviderSettings(),
		claudeProviderSettings: claude,
		modrevProviderId: null,
		modrevModelId: null,
		commitPromptTemplate: "",
		openPrPromptTemplate: "",
		commitPromptTemplateDefault: "",
		openPrPromptTemplateDefault: "",
		llmRetry: { enabled: true, delayMs: 15000, maxAttempts: 20 },
	};
}

let latest: UseRuntimeSettingsClaudeControllerResult | null = null;

function Harness({ config }: { config: RuntimeConfigResponse | null }): null {
	const controller = useRuntimeSettingsClaudeController({ open: true, workspaceId: "workspace-1", config });
	useEffect(() => {
		latest = controller;
	}, [controller]);
	return null;
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("useRuntimeSettingsClaudeController", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		fetchClineProviderModelsMock.mockReset();
		fetchClineProviderModelsMock.mockResolvedValue([{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }]);
		saveClineProviderSettingsMock.mockReset();
		saveClineProviderSettingsMock.mockResolvedValue(makeProviderSettings());
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		latest = null;
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("loads Anthropic models and seeds the configured model", async () => {
		await act(async () => {
			root.render(<Harness config={makeConfig(makeProviderSettings({ modelId: "claude-sonnet-4-6" }))} />);
			await flush();
		});
		expect(fetchClineProviderModelsMock).toHaveBeenCalledWith("workspace-1", "anthropic");
		expect(latest?.models).toEqual([{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }]);
		expect(latest?.modelId).toBe("claude-sonnet-4-6");
		expect(latest?.hasUnsavedChanges).toBe(false);
	});

	it("saves the anthropic slot with setLastUsed:false and an entered key", async () => {
		await act(async () => {
			root.render(<Harness config={makeConfig(makeProviderSettings())} />);
			await flush();
		});
		await act(async () => {
			latest?.setApiKey("sk-ant-123");
			latest?.setModelId("claude-sonnet-4-6");
			await flush();
		});
		expect(latest?.hasUnsavedChanges).toBe(true);
		await act(async () => {
			await latest?.saveClaudeSettings();
		});
		expect(saveClineProviderSettingsMock).toHaveBeenCalledWith("workspace-1", {
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			apiKey: "sk-ant-123",
			setLastUsed: false,
		});
	});

	it("omits the API key when left blank so an existing key is preserved", async () => {
		await act(async () => {
			root.render(<Harness config={makeConfig(makeProviderSettings({ apiKeyConfigured: true }))} />);
			await flush();
		});
		await act(async () => {
			latest?.setModelId("claude-sonnet-4-6");
			await flush();
		});
		await act(async () => {
			await latest?.saveClaudeSettings();
		});
		expect(saveClineProviderSettingsMock).toHaveBeenCalledWith("workspace-1", {
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			setLastUsed: false,
		});
	});
});
