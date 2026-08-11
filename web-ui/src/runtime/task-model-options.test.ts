import { describe, expect, it, vi } from "vitest";

import type { RuntimeClineProviderCatalogItem } from "@/runtime/types";

vi.mock("@runtime-agent-catalog", () => ({
	getRuntimeLaunchSupportedAgentCatalog: vi.fn(() => [
		{ id: "cline", label: "Cline" },
		{ id: "modrev", label: "Modrev" },
		{ id: "claude", label: "Claude Code" },
		{ id: "codex", label: "OpenAI Codex" },
	]),
}));

import {
	buildDefaultTaskModelLabel,
	buildTaskModelOptions,
	MODREV_TASK_MODEL_VALUE_PREFIX,
	resolveTaskModelSelection,
	selectedTaskModelValue,
} from "@/runtime/task-model-options";

function createProvider(
	id: string,
	name: string,
	defaultModelId: string | null = null,
): RuntimeClineProviderCatalogItem {
	return { id, name, oauthSupported: false, enabled: true, defaultModelId, baseUrl: null, supportsBaseUrl: false };
}

describe("buildTaskModelOptions", () => {
	it("expands the Modrev agent into one entry per registered model and keeps other agents flat", () => {
		const catalog = [
			createProvider("cline", "Cline"),
			createProvider("anthropic", "Anthropic"),
			createProvider("modrev-a", "Modrev A", "model-a"),
			createProvider("modrev-b", "Modrev B", "model-b"),
		];

		const options = buildTaskModelOptions(catalog);

		expect(options).toEqual([
			{ value: "cline", label: "Cline", agentId: "cline" },
			{
				value: `${MODREV_TASK_MODEL_VALUE_PREFIX}modrev-a`,
				label: "Modrev A",
				agentId: "modrev",
				providerId: "modrev-a",
				modelId: "model-a",
			},
			{
				value: `${MODREV_TASK_MODEL_VALUE_PREFIX}modrev-b`,
				label: "Modrev B",
				agentId: "modrev",
				providerId: "modrev-b",
				modelId: "model-b",
			},
			{ value: "claude", label: "Claude Code", agentId: "claude" },
			{ value: "codex", label: "OpenAI Codex", agentId: "codex" },
		]);
	});

	it("omits Modrev entirely when no models are registered", () => {
		const options = buildTaskModelOptions([createProvider("cline", "Cline")]);
		expect(options.some((option) => option.agentId === "modrev")).toBe(false);
		expect(options.map((option) => option.value)).toEqual(["cline", "claude", "codex"]);
	});
});

describe("resolveTaskModelSelection", () => {
	const options = buildTaskModelOptions([createProvider("modrev-a", "Modrev A", "model-a")]);

	it("returns no override for the empty (default) value", () => {
		expect(resolveTaskModelSelection("", options)).toEqual({ agentId: undefined, clineSettings: undefined });
	});

	it("resolves a Modrev model to the modrev agent pinned to its provider and model", () => {
		expect(resolveTaskModelSelection(`${MODREV_TASK_MODEL_VALUE_PREFIX}modrev-a`, options)).toEqual({
			agentId: "modrev",
			clineSettings: { providerId: "modrev-a", modelId: "model-a" },
		});
	});

	it("resolves a plain agent to that agent with no cline settings", () => {
		expect(resolveTaskModelSelection("claude", options)).toEqual({ agentId: "claude", clineSettings: undefined });
	});

	it("falls back to the default when the value is unknown", () => {
		expect(resolveTaskModelSelection("does-not-exist", options)).toEqual({
			agentId: undefined,
			clineSettings: undefined,
		});
	});
});

describe("selectedTaskModelValue", () => {
	it("maps no agent override to the empty value", () => {
		expect(selectedTaskModelValue(undefined, undefined)).toBe("");
	});

	it("maps a plain agent override to its id", () => {
		expect(selectedTaskModelValue("claude", undefined)).toBe("claude");
	});

	it("maps a Modrev override to its namespaced provider value", () => {
		expect(selectedTaskModelValue("modrev", { providerId: "modrev-a", modelId: "model-a" })).toBe(
			`${MODREV_TASK_MODEL_VALUE_PREFIX}modrev-a`,
		);
	});

	it("treats a Modrev override without a provider as the default", () => {
		expect(selectedTaskModelValue("modrev", undefined)).toBe("");
	});
});

describe("buildDefaultTaskModelLabel", () => {
	const catalog = [createProvider("modrev-a", "Modrev A", "model-a")];

	it("labels a plain default agent", () => {
		expect(buildDefaultTaskModelLabel({ defaultAgentId: "claude", catalog })).toBe("Default (Claude Code)");
	});

	it("labels a Modrev default with the active model name", () => {
		expect(buildDefaultTaskModelLabel({ defaultAgentId: "modrev", defaultProviderId: "modrev-a", catalog })).toBe(
			"Default (Modrev A)",
		);
	});

	it("falls back to a bare Default when no default agent is configured", () => {
		expect(buildDefaultTaskModelLabel({ defaultAgentId: null, catalog })).toBe("Default");
	});
});
