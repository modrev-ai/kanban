import { type ReactElement, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { setRuntimeStorageDir } from "@/runtime/runtime-config-query";
import type { RuntimeConfigResponse } from "@/runtime/types";

// Lets the user relocate where Kanban saves config.json and the project-progress
// state. The value is persisted to a pointer file on the backend and applied on
// the next restart, so we surface both the active dir and the pending one.
export function StorageSettingsSection({
	config,
	workspaceId,
	onSaved,
	disabled,
}: {
	config: RuntimeConfigResponse | null;
	workspaceId: string | null;
	onSaved?: () => void;
	disabled?: boolean;
}): ReactElement {
	const activeDir = config?.storageDir ?? "";
	const pendingDir = config?.storageDirPending ?? "";
	const defaultDir = config?.storageDirDefault ?? "";

	const [value, setValue] = useState(pendingDir);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [savedPending, setSavedPending] = useState<string | null>(null);

	// Keep the input in sync with the loaded config.
	useEffect(() => {
		setValue(pendingDir);
		setSavedPending(null);
	}, [pendingDir]);

	const effectivePending = savedPending ?? pendingDir;
	const restartRequired = effectivePending !== activeDir;
	const busy = disabled || saving || config === null;

	async function persist(nextDir: string | null): Promise<void> {
		setSaving(true);
		setError(null);
		try {
			const response = await setRuntimeStorageDir(workspaceId, nextDir);
			setSavedPending(response.storageDirPending);
			setValue(response.storageDirPending);
			onSaved?.();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to update the storage directory.");
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="flex flex-col gap-3">
			<p className="text-text-secondary text-[13px] m-0">
				Where Kanban saves <code className="font-mono text-text-primary">config.json</code> and your project
				progress state (<code className="font-mono text-text-primary">workspaces/index.json</code>). Changes take
				effect after you restart Kanban.
			</p>

			<label className="flex flex-col gap-1 text-[13px] text-text-primary">
				<span className="text-text-secondary">Storage directory</span>
				<input
					type="text"
					value={value}
					disabled={busy}
					spellCheck={false}
					placeholder={defaultDir}
					onChange={(event) => setValue(event.target.value)}
					className="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-[13px] text-text-primary outline-none focus:border-border-focus disabled:opacity-40"
				/>
				<span className="text-text-tertiary text-xs">
					Leave empty to use the default: <span className="font-mono">{defaultDir}</span>
				</span>
			</label>

			<p className="text-text-tertiary text-xs m-0">
				Currently active: <span className="font-mono text-text-secondary">{activeDir || defaultDir}</span>
			</p>

			{restartRequired ? (
				<p className="text-status-orange text-xs m-0">
					Restart Kanban to apply — it will then use <span className="font-mono">{effectivePending}</span>.
				</p>
			) : null}

			{error ? <p className="text-status-red text-xs m-0">{error}</p> : null}

			<div className="flex items-center gap-2">
				<Button size="sm" variant="primary" disabled={busy} onClick={() => persist(value.trim() || null)}>
					Save directory
				</Button>
				<Button size="sm" variant="default" disabled={busy} onClick={() => persist(null)}>
					Reset to default
				</Button>
			</div>
		</div>
	);
}
