import { defineConfig } from "vitest/config";

process.env.NODE_ENV = "production";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		// Every suite this config owns lives under `test/`, so scope discovery there
		// instead of letting vitest's default `**/*.test.ts` sweep the whole tree.
		// Unrelated checkouts sitting in the repo root — a nested clone of this repo,
		// a sibling project — otherwise get collected too, which silently runs every
		// suite twice and double-counts failures against code that isn't ours.
		include: ["test/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
		// `packages/**` excluded: those workspaces have their own vitest
		// configs and runtime shapes (e.g. Electron) and are run explicitly by
		// CI. New workspaces under `packages/` MUST get matching install/test
		// steps in .github/workflows/test.yml or they fall out of CI coverage.
		exclude: [
			"apps/**",
			"packages/**",
			"web-ui/**",
			"third_party/**",
			"**/node_modules/**",
			"**/dist/**",
			".worktrees/**",
		],
		testTimeout: 15_000,
	},
});
