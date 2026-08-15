import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The git branch of the Kanban app's OWN source checkout (e.g. "dev", "main"),
// surfaced so the UI can badge which build is running. Returns null when the app
// is not running from its own git checkout — a published/installed copy (under
// node_modules) or a non-git directory — so a host project's branch is never
// mistaken for the app's. Cached: the branch only changes across a restart (in
// dev, switching branches reloads the watcher).
let cachedBranch: string | null | undefined;

export function getKanbanAppBranch(): string | null {
	if (cachedBranch === undefined) {
		cachedBranch = resolveAppBranch();
	}
	return cachedBranch;
}

function resolveAppBranch(): string | null {
	const here = dirname(fileURLToPath(import.meta.url));
	// An installed copy lives under node_modules; its ancestor git repo would be
	// the host project, not Kanban. Only report a branch for a source checkout.
	if (here.split(/[\\/]/).includes("node_modules")) {
		return null;
	}
	try {
		const branch = execFileSync("git", ["-C", here, "rev-parse", "--abbrev-ref", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2000,
		}).trim();
		return branch.length > 0 && branch !== "HEAD" ? branch : null;
	} catch {
		return null;
	}
}
