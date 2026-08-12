import { describe, expect, it } from "vitest";

import { isSelectedAgentAuthenticated, shouldShowStartupOnboardingDialog } from "@/runtime/onboarding";

describe("runtime onboarding helpers", () => {
	it("treats external-CLI selections as authenticated", () => {
		// Only external-CLI agents auth via their own tools; native agents (cline,
		// modrev, claude) authenticate through in-app provider settings.
		expect(isSelectedAgentAuthenticated("codex", null)).toBe(true);
		expect(isSelectedAgentAuthenticated("droid", null)).toBe(true);
	});

	it("requires provider auth for the native Claude agent", () => {
		expect(isSelectedAgentAuthenticated("claude", null)).toBe(false);
		expect(
			isSelectedAgentAuthenticated("claude", {
				providerId: "anthropic",
				modelId: "claude-sonnet-4-6",
				baseUrl: null,
				apiKeyConfigured: true,
				oauthProvider: null,
				oauthAccessTokenConfigured: false,
				oauthRefreshTokenConfigured: false,
				oauthAccountId: null,
				oauthExpiresAt: null,
			}),
		).toBe(true);
	});

	it("checks cline authentication from provider settings", () => {
		expect(
			isSelectedAgentAuthenticated("cline", {
				providerId: null,
				modelId: null,
				baseUrl: null,
				apiKeyConfigured: false,
				oauthProvider: null,
				oauthAccessTokenConfigured: false,
				oauthRefreshTokenConfigured: false,
				oauthAccountId: null,
				oauthExpiresAt: null,
			}),
		).toBe(false);
		expect(
			isSelectedAgentAuthenticated("cline", {
				providerId: "anthropic",
				modelId: "claude-3-7-sonnet",
				baseUrl: null,
				apiKeyConfigured: true,
				oauthProvider: null,
				oauthAccessTokenConfigured: false,
				oauthRefreshTokenConfigured: false,
				oauthAccountId: null,
				oauthExpiresAt: null,
			}),
		).toBe(true);
	});

	it("shows startup onboarding at least once for configured users", () => {
		expect(
			shouldShowStartupOnboardingDialog({
				hasShownOnboardingDialog: false,
			}),
		).toBe(true);
	});

	it("does not reopen startup onboarding after it has been shown", () => {
		expect(
			shouldShowStartupOnboardingDialog({
				hasShownOnboardingDialog: true,
			}),
		).toBe(false);
	});
});
