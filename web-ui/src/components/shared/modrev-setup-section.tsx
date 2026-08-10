import { Circle, CircleDot, Pencil, Plus, Trash2 } from "lucide-react";
import { type ReactElement, useState } from "react";

import {
	ClineAddProviderDialog,
	type ClineProviderDialogInitialValues,
	type ClineProviderDialogMode,
} from "@/components/shared/cline-add-provider-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import type { AddClineProviderInput, UpdateClineProviderInput } from "@/hooks/use-runtime-settings-cline-controller";
import type {
	ModrevModel,
	UseRuntimeSettingsModrevControllerResult,
} from "@/hooks/use-runtime-settings-modrev-controller";
import { fetchClineProviderModels } from "@/runtime/runtime-config-query";

// Lists the custom Modrev models and lets each one be added or edited through
// the same OpenAI-compatible provider dialog used by Cline (name, base URL, API
// key, model source URL, models, capabilities, timeout).
export function ModrevSetupSection({
	controller,
	controlsDisabled,
	workspaceId = null,
	onError,
	onSaved,
}: {
	controller: UseRuntimeSettingsModrevControllerResult;
	controlsDisabled: boolean;
	workspaceId?: string | null;
	onError?: (message: string | null) => void;
	onSaved?: () => void;
}): ReactElement {
	const [isDialogOpen, setIsDialogOpen] = useState(false);
	const [dialogMode, setDialogMode] = useState<ClineProviderDialogMode>("add");
	const [editInitialValues, setEditInitialValues] = useState<ClineProviderDialogInitialValues | null>(null);
	const [preparingEditProviderId, setPreparingEditProviderId] = useState<string | null>(null);
	const [modelPendingRemoval, setModelPendingRemoval] = useState<ModrevModel | null>(null);
	const [isRemoving, setIsRemoving] = useState(false);

	const openAddDialog = () => {
		onError?.(null);
		setDialogMode("add");
		setEditInitialValues(null);
		setIsDialogOpen(true);
	};

	const openEditDialog = (model: ModrevModel) => {
		onError?.(null);
		setPreparingEditProviderId(model.providerId);
		void (async () => {
			let modelIds: string[] = [];
			try {
				const providerModels = await fetchClineProviderModels(workspaceId, model.providerId);
				modelIds = providerModels.map((entry) => entry.id);
			} catch {
				modelIds = [];
			}
			if (modelIds.length === 0 && model.defaultModelId) {
				modelIds = [model.defaultModelId];
			}
			setEditInitialValues({
				providerId: model.providerId,
				name: model.name,
				baseUrl: model.baseUrl ?? "",
				models: modelIds,
				defaultModelId: model.defaultModelId ?? "",
			});
			setDialogMode("edit");
			setPreparingEditProviderId(null);
			setIsDialogOpen(true);
		})();
	};

	const handleSelectModel = (providerId: string) => {
		void (async () => {
			onError?.(null);
			const result = await controller.selectModel(providerId);
			if (!result.ok) {
				onError?.(result.message ?? "Failed to select Modrev model.");
				return;
			}
			onSaved?.();
		})();
	};

	const handleConfirmRemove = () => {
		const model = modelPendingRemoval;
		if (!model) {
			return;
		}
		void (async () => {
			setIsRemoving(true);
			onError?.(null);
			const result = await controller.removeModel(model.providerId);
			setIsRemoving(false);
			if (!result.ok) {
				onError?.(result.message ?? "Failed to remove Modrev model.");
				return;
			}
			setModelPendingRemoval(null);
			onSaved?.();
		})();
	};

	return (
		<>
			<div className="mt-2">
				<div className="flex items-center justify-between mb-2">
					<p className="text-text-primary font-semibold text-[12px] m-0">Models</p>
					{controller.models.length > 0 ? (
						<Button
							variant="ghost"
							size="sm"
							icon={<Plus size={14} />}
							disabled={controlsDisabled}
							onClick={openAddDialog}
						>
							Add model
						</Button>
					) : null}
				</div>
				<p className="text-text-secondary text-[12px] mt-0 mb-3">
					Register custom OpenAI-compatible models for Modrev. Select one to use it for tasks.
				</p>

				{controller.isLoadingModels ? (
					<p className="text-text-secondary text-[12px] mt-1 mb-0">Loading models...</p>
				) : controller.models.length === 0 ? (
					<div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-surface-1 px-4 py-6">
						<p className="text-text-secondary text-[12px] m-0">No models registered yet.</p>
						<Button
							variant="default"
							size="sm"
							icon={<Plus size={14} />}
							disabled={controlsDisabled}
							onClick={openAddDialog}
						>
							Add new model
						</Button>
					</div>
				) : (
					<div className="flex flex-col gap-1">
						{controller.models.map((model) => {
							const isActive = model.providerId === controller.activeProviderId;
							return (
								<div
									key={model.providerId}
									className={cn(
										"flex items-center justify-between gap-3 rounded-md border px-3 py-2",
										isActive ? "border-accent bg-surface-2" : "border-border bg-surface-1",
									)}
								>
									<button
										type="button"
										disabled={controlsDisabled}
										onClick={() => handleSelectModel(model.providerId)}
										className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
										aria-pressed={isActive}
									>
										{isActive ? (
											<CircleDot size={16} className="text-accent shrink-0" />
										) : (
											<Circle size={16} className="text-text-secondary shrink-0" />
										)}
										<span className="min-w-0">
											<span className="block truncate text-[13px] text-text-primary">{model.name}</span>
											{model.defaultModelId || model.baseUrl ? (
												<span className="block truncate text-text-secondary font-mono text-[11px]">
													{[model.defaultModelId, model.baseUrl].filter(Boolean).join(" · ")}
												</span>
											) : null}
										</span>
									</button>
									<div className="flex shrink-0 items-center gap-1">
										<Button
											variant="ghost"
											size="sm"
											icon={<Pencil size={14} />}
											disabled={controlsDisabled || preparingEditProviderId !== null}
											onClick={() => openEditDialog(model)}
										>
											Edit
										</Button>
										<Button
											variant="ghost"
											size="sm"
											icon={<Trash2 size={14} />}
											aria-label={`Remove ${model.name}`}
											disabled={controlsDisabled}
											onClick={() => {
												onError?.(null);
												setModelPendingRemoval(model);
											}}
										/>
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>

			<ClineAddProviderDialog
				open={isDialogOpen}
				onOpenChange={setIsDialogOpen}
				existingProviderIds={controller.existingProviderIds}
				mode={dialogMode}
				initialValues={dialogMode === "edit" ? editInitialValues : null}
				onSubmit={async (input) => {
					onError?.(null);
					const result =
						dialogMode === "edit"
							? await controller.updateModel(input as UpdateClineProviderInput)
							: await controller.addModel(input as AddClineProviderInput);
					if (!result.ok) {
						onError?.(
							result.message ?? (dialogMode === "edit" ? "Failed to update model." : "Failed to add model."),
						);
						return result;
					}
					onSaved?.();
					return result;
				}}
			/>

			<AlertDialog
				open={modelPendingRemoval !== null}
				onOpenChange={(isOpen) => {
					if (!isOpen && !isRemoving) {
						setModelPendingRemoval(null);
					}
				}}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>Remove this model?</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						This removes the Modrev model{modelPendingRemoval ? ` "${modelPendingRemoval.name}"` : ""} and its
						saved credentials.
					</AlertDialogDescription>
					<p className="text-text-primary">This action cannot be undone.</p>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="default" disabled={isRemoving} onClick={() => setModelPendingRemoval(null)}>
							Cancel
						</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button
							variant="danger"
							disabled={isRemoving}
							onClick={(event) => {
								event.preventDefault();
								handleConfirmRemove();
							}}
						>
							{isRemoving ? "Removing..." : "Remove model"}
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</>
	);
}
