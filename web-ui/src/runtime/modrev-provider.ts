// Shared helpers for the Modrev provider namespace.
//
// Modrev "models" are custom OpenAI-compatible providers namespaced by a
// "modrev-" provider-id prefix (the legacy exact id "modrev" also counts) so
// they can be told apart from the Cline agent's own providers.

export const MODREV_PROVIDER_ID_PREFIX = "modrev-";
export const MODREV_LEGACY_PROVIDER_ID = "modrev";

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
