import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { CLI_COMMAND_TIMEOUT_MS } from "../utilities/integration-timeouts";

const requireFromHere = createRequire(import.meta.url);

function resolveTsxLoaderImportSpecifier(): string {
	return pathToFileURL(requireFromHere.resolve("tsx")).href;
}

// Spawns the CLI through tsx, which recompiles the entry graph in the child process:
// ~10s on Windows, against vitest's 15s default. Too tight to rely on.
describe("cli compatibility flags", { timeout: CLI_COMMAND_TIMEOUT_MS * 2 }, () => {
	it("accepts the deprecated --agent flag as a no-op", () => {
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				resolveTsxLoaderImportSpecifier(),
				resolve(process.cwd(), "src/cli.ts"),
				"--agent",
				"legacy-alias-value",
				"--help",
			],
			{
				encoding: "utf8",
			},
		);

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("--port");
		expect(result.stdout).not.toContain("--agent");
		expect(result.stdout).not.toContain("Agent IDs:");
	});
});
