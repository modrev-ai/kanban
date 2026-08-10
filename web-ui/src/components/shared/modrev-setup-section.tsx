import type { ReactElement } from "react";

import type { UseRuntimeSettingsModrevControllerResult } from "@/hooks/use-runtime-settings-modrev-controller";

// Custom-auth form for the native Modrev agent: API key, base URL, and model
// ID. Mirrors the field layout of the Cline custom API provider so the two
// native agents feel consistent.
export function ModrevSetupSection({
	controller,
	controlsDisabled,
}: {
	controller: UseRuntimeSettingsModrevControllerResult;
	controlsDisabled: boolean;
}): ReactElement {
	const apiKeyPlaceholder = controller.apiKeyConfigured ? "Saved" : "Enter API key";

	return (
		<div className="mt-2">
			<p className="text-text-primary font-semibold text-[12px] mt-0 mb-2">Custom authentication</p>
			<p className="text-text-secondary text-[12px] mt-0 mb-3">
				Connect Modrev with a custom OpenAI-compatible endpoint. Provide an API key, base URL, and model ID.
			</p>
			<div className="grid gap-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
				<div className="min-w-0">
					<p className="text-text-secondary text-[12px] mt-0 mb-1">API key</p>
					<input
						type="password"
						value={controller.apiKey}
						onChange={(event) => controller.setApiKey(event.target.value)}
						placeholder={apiKeyPlaceholder}
						disabled={controlsDisabled}
						className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
					/>
				</div>
				<div className="min-w-0">
					<p className="text-text-secondary text-[12px] mt-0 mb-1">Base URL</p>
					<input
						value={controller.baseUrl}
						onChange={(event) => controller.setBaseUrl(event.target.value)}
						placeholder="https://api.modrev.ai/v1"
						disabled={controlsDisabled}
						className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
					/>
				</div>
			</div>
			<div className="mt-3 min-w-0">
				<p className="text-text-secondary text-[12px] mt-0 mb-1">Model ID</p>
				<input
					value={controller.modelId}
					onChange={(event) => controller.setModelId(event.target.value)}
					placeholder="e.g. modrev/model-name"
					disabled={controlsDisabled}
					className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
				/>
			</div>
		</div>
	);
}
