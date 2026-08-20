#!/usr/bin/env node
/**
 * Prints the newest release tag for a channel, or nothing when there is none.
 *
 *   node scripts/latest-release-tag.mjs prod   ->  v1.2.3
 *   node scripts/latest-release-tag.mjs dev    ->  v1.2.3.7-dev
 *
 * Used by kanban-dev.cmd / kanban-prod.cmd to launch the most recent release
 * rather than the branch tip, and it mirrors the parsing in
 * .github/workflows/release.yml.
 *
 * Sorting is numeric per field on purpose. Both lexicographic ordering and
 * `git tag --sort=v:refname` place v1.0.9 after v1.0.10, which would pick a
 * stale release. The regexes are anchored at both ends so unrelated tags --
 * v1.0.3-modrev, v0.1.70-modrev.1 -- are excluded from both channels.
 *
 * Exits 0 with empty output when no tag matches, so callers can fall back to a
 * branch. Exits 1 only on bad usage or when git itself is unavailable.
 */

import { execFileSync } from "node:child_process";

const CHANNELS = {
	// vX.Y.Z
	prod: /^v(\d+)\.(\d+)\.(\d+)$/,
	// vX.Y.Z.R-dev
	dev: /^v(\d+)\.(\d+)\.(\d+)\.(\d+)-dev$/,
};

const channel = process.argv[2];
const pattern = CHANNELS[channel];

if (!pattern) {
	process.stderr.write(`usage: latest-release-tag.mjs <${Object.keys(CHANNELS).join("|")}>\n`);
	process.exit(1);
}

let tags;
try {
	tags = execFileSync("git", ["tag", "--list"], { encoding: "utf8" });
} catch (error) {
	process.stderr.write(`could not list git tags: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
}

const newest = tags
	.split(/\r?\n/)
	.map((line) => line.trim())
	.map((tag) => {
		const match = pattern.exec(tag);
		return match ? { tag, key: match.slice(1).map(Number) } : null;
	})
	.filter((entry) => entry !== null)
	.sort((a, b) => {
		for (let i = 0; i < a.key.length; i++) {
			if (a.key[i] !== b.key[i]) {
				return a.key[i] - b.key[i];
			}
		}
		return 0;
	})
	.at(-1);

if (newest) {
	process.stdout.write(`${newest.tag}\n`);
}
