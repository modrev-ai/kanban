import { Check } from "lucide-react";
import { type ReactElement, useState } from "react";

import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import type { UseRuntimeSettingsClaudeControllerResult } from "@/hooks/use-runtime-settings-claude-controller";

// Configures the native Claude agent's Anthropic API key and model. Claude runs
// through the SDK's built-in "anthropic" provider, so this is the provider slot
// its conversation is powered by. Rendered inside the Models settings section
// when Claude Code is the selected default agent.
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

	const apiKeyPlaceholder = controller.apiKeyConfigured ? "••••••••  (leave blank to keep)" : "sk-ant-...";

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
				Claude runs natively on your Anthropic API key. Its conversation is saved and shown in the chat view.
			</p>

			<div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
				<div className="min-w-0">
					<p className="text-text-secondary text-[12px] mt-0 mb-1">Anthropic API key</p>
					<input
						type="password"
						value={controller.apiKey}
						onChange={(event) => controller.setApiKey(event.target.value)}
						placeholder={apiKeyPlaceholder}
						disabled={controlsDisabled || isSaving}
						className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
					/>
					<p className="text-text-tertiary text-[11px] mt-1 mb-0 break-all">Or use ANTHROPIC_API_KEY</p>
				</div>
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
			</div>

			<div className="mt-3 flex items-center justify-between gap-2">
				<span className="text-[11px] text-text-tertiary">
					{controller.apiKeyConfigured ? (
						<span className="inline-flex items-center gap-1 text-status-green">
							<Check size={12} /> API key configured
						</span>
					) : (
						"No API key configured yet"
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
