import { Check } from "lucide-react";
import { type ReactElement, useState } from "react";

import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import type { UseRuntimeSettingsClaudeControllerResult } from "@/hooks/use-runtime-settings-claude-controller";

// Configures the native Claude agent. Claude runs through the SDK's built-in
// "claude-code" provider, which authenticates with the user's Claude Pro/Max
// subscription (via the Claude Agent SDK) — no Anthropic API key. The only
// setting is the model. Rendered inside the Models settings section when Claude
// Code is the selected default agent.
export function ClaudeSetupCard({
	controller,
	controlsDisabled,
	onError,
	onSaved,
}: {
	controller: UseRuntimeSettingsClaudeControllerResult;
	controlsDisabled: boolean;
	onError?: (message: string | null) => void;
	onSaved?: () => void;
}): ReactElement {
	const [isSaving, setIsSaving] = useState(false);

	const handleSave = () => {
		void (async () => {
			setIsSaving(true);
			onError?.(null);
			const result = await controller.saveClaudeSettings();
			setIsSaving(false);
			if (!result.ok) {
				onError?.(result.message ?? "Failed to save Claude settings.");
				return;
			}
			onSaved?.();
		})();
	};

	return (
		<div className="mt-2 rounded-md border border-border bg-surface-1 px-3 py-3">
			<p className="text-text-secondary text-[12px] mt-0 mb-3">
				Claude runs on your Claude Pro/Max subscription through Claude Code — no API key needed. Sign in with{" "}
				<code className="text-text-primary">claude login</code> in your terminal, then pick a model. Its
				conversation is saved and shown in the chat view.
			</p>

			<div className="min-w-0">
				<p className="text-text-secondary text-[12px] mt-0 mb-1">Model</p>
				<NativeSelect
					fill
					value={controller.modelId}
					onChange={(event) => controller.setModelId(event.target.value)}
					disabled={controlsDisabled || isSaving || controller.isLoadingModels}
				>
					<option value="">{controller.isLoadingModels ? "Loading models..." : "Provider default"}</option>
					{controller.models.map((model) => (
						<option key={model.id} value={model.id}>
							{model.name}
						</option>
					))}
				</NativeSelect>
			</div>

			<div className="mt-3 flex items-center justify-between gap-2">
				<span className="text-[11px] text-text-tertiary">
					{controller.subscriptionConfigured ? (
						<span className="inline-flex items-center gap-1 text-status-green">
							<Check size={12} /> Using Claude Pro/Max subscription
						</span>
					) : (
						"Save to use your Claude Pro/Max subscription"
					)}
				</span>
				<Button
					variant="primary"
					size="sm"
					disabled={controlsDisabled || isSaving || !controller.hasUnsavedChanges}
					onClick={handleSave}
				>
					{isSaving ? "Saving..." : "Save"}
				</Button>
			</div>
		</div>
	);
}
