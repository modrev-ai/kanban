import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UseRuntimeSettingsModrevControllerResult } from "@/hooks/use-runtime-settings-modrev-controller";
import type { RuntimeAgentId } from "@/runtime/types";

vi.mock("@/runtime/runtime-config-query", () => ({
	fetchClineProviderModels: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/components/shared/cline-add-provider-dialog", () => ({
	ClineAddProviderDialog: () => null,
}));

import { ModrevSetupSection } from "@/components/shared/modrev-setup-section";

function makeController(
	overrides: Partial<UseRuntimeSettingsModrevControllerResult> = {},
): UseRuntimeSettingsModrevControllerResult {
	return {
		models: [],
		activeProviderId: "",
		isLoadingModels: false,
		existingProviderIds: [],
		hasUnsavedChanges: false,
		reloadModels: vi.fn().mockResolvedValue(undefined),
		selectModel: vi.fn().mockResolvedValue({ ok: true }),
		addModel: vi.fn().mockResolvedValue({ ok: true }),
		updateModel: vi.fn().mockResolvedValue({ ok: true }),
		removeModel: vi.fn().mockResolvedValue({ ok: true }),
		saveModrevSettings: vi.fn().mockResolvedValue({ ok: true }),
		...overrides,
	};
}

let container: HTMLDivElement;
let root: Root;
let previousActEnvironment: boolean | undefined;

beforeEach(() => {
	previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
		.IS_REACT_ACT_ENVIRONMENT;
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	if (previousActEnvironment === undefined) {
		delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	} else {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	}
	vi.clearAllMocks();
});

function findClaudeCodeEntry(): HTMLButtonElement {
	const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
		candidate.textContent?.includes("Claude Code"),
	);
	if (!button) {
		throw new Error("Expected a Claude Code registry entry.");
	}
	return button as HTMLButtonElement;
}

describe("ModrevSetupSection – Claude Code registry entry", () => {
	it("marks Claude Code active when it is the selected agent", async () => {
		await act(async () =>
			root.render(
				<ModrevSetupSection
					controller={makeController()}
					controlsDisabled={false}
					activeAgentId={"claude" as RuntimeAgentId}
					onActiveAgentChange={() => {}}
				/>,
			),
		);

		expect(findClaudeCodeEntry().getAttribute("aria-pressed")).toBe("true");
	});

	it("switches the default agent to Claude Code when its entry is chosen", async () => {
		const onActiveAgentChange = vi.fn();
		await act(async () =>
			root.render(
				<ModrevSetupSection
					controller={makeController()}
					controlsDisabled={false}
					activeAgentId={"modrev" as RuntimeAgentId}
					onActiveAgentChange={onActiveAgentChange}
				/>,
			),
		);

		const entry = findClaudeCodeEntry();
		expect(entry.getAttribute("aria-pressed")).toBe("false");
		await act(async () => {
			entry.click();
		});

		expect(onActiveAgentChange).toHaveBeenCalledWith("claude");
	});

	it("switches the default agent to Modrev when a Modrev model is chosen", async () => {
		const onActiveAgentChange = vi.fn();
		const selectModel = vi.fn().mockResolvedValue({ ok: true });
		await act(async () =>
			root.render(
				<ModrevSetupSection
					controller={makeController({
						models: [{ providerId: "modrev-a", name: "Modrev A", baseUrl: null, defaultModelId: "model-a" }],
						activeProviderId: "modrev-a",
						selectModel,
					})}
					controlsDisabled={false}
					activeAgentId={"claude" as RuntimeAgentId}
					onActiveAgentChange={onActiveAgentChange}
				/>,
			),
		);

		const modelButton = Array.from(container.querySelectorAll("button")).find((candidate) =>
			candidate.textContent?.includes("Modrev A"),
		);
		expect(modelButton).not.toBeUndefined();
		await act(async () => {
			(modelButton as HTMLButtonElement).click();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(selectModel).toHaveBeenCalledWith("modrev-a");
		expect(onActiveAgentChange).toHaveBeenCalledWith("modrev");
	});
});
