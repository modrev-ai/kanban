# Kanban release workflow

> **npm publishing is disabled.** `npm-release.yml` and `publish.yml` are both
> disabled in GitHub Actions, and `npm-release.yml`'s automatic trigger has been
> removed so re-enabling it alone cannot start publishing again. Repository
> releases (tags and GitHub Releases) are unaffected and still run on every merge.
> See [npm publishing (disabled)](#npm-publishing-disabled).

## Overview

This repository uses several GitHub Actions workflows for quality gates, releases,
publishing, and deployment:

- `.github/workflows/test.yml`
  - Reusable test workflow used by CI and Publish workflows.
  - Runs build, checks, and web-ui unit tests.
- `.github/workflows/ci.yml`
  - Runs on pushes and pull requests targeting `main`.
  - Calls the reusable `test.yml` workflow.
- `.github/workflows/release.yml`
  - Runs when a pull request is merged into `main` or `dev`.
  - Computes the next version **from git tags** and creates a GitHub Release:
    `vX.Y.Z` on main, `vX.Y.Z.R-dev` on dev.
  - Never touches `package.json` or npm.
- `.github/workflows/npm-release.yml` — **disabled**, automatic trigger removed.
- `.github/workflows/publish.yml` — **disabled**, manual dispatch only.
- `.github/workflows/deploy-dev.yml` / `deploy-prod.yml` / `deploy-oracle.yml`
  - Deploy the running app to the Oracle Compute instance when a PR is merged
    into `dev` (port 4173) or `main` (port 4174).
  - Separate from npm publishing: deploying does not publish, and publishing does
    not deploy. See [docs/deployment.md](docs/deployment.md).

## Contributor workflow

For regular development:

- Open a PR to `main` or `dev`.
- CI runs `test.yml` automatically.
- Merge once checks pass.
- Merging deploys that branch's environment (see
  [docs/deployment.md](docs/deployment.md)).

For direct pushes to `main`:

- CI also runs automatically on push.

## npm publishing (disabled)

Nothing publishes to npm. Two independent layers hold that:

1. Both workflows are disabled in GitHub Actions (`disabled_manually`), so nothing
   runs even if a trigger matched.
2. `npm-release.yml`'s `pull_request` trigger is removed in the file, so simply
   re-enabling the workflow does not silently resume publishing on the next merge
   to `main`. The trigger has to be restored deliberately.

npm currently serves `1.0.1-modrev` on both the `latest` and `modrev` dist-tags,
and will keep doing so. `package.json` is `1.0.5`, which is now only a repository
version.

To restore publishing: put the `pull_request` trigger back in `npm-release.yml`,
then `gh workflow enable npm-release.yml publish.yml`. Re-read
[Two kinds of release](#two-kinds-of-release) first — the tag namespace is shared
with `release.yml`.

## Two kinds of release

These are separate on purpose, and it is worth being clear about which one you
mean:

| | Repository release | npm release |
| --- | --- | --- |
| Workflow | `release.yml` | `npm-release.yml` -> `publish.yml` |
| Version from | git tags | `package.json` |
| Tag shape | `vX.Y.Z`, `vX.Y.Z.R-dev` | `v` + the package version (same namespace) |
| Trigger | every merged PR to `main` or `dev` | a merged PR to `main` that bumps the version |
| Publishes to npm | no | yes |

So every merge produces a repository release. The npm column is **currently
disabled** and describes what would happen if it were restored.

### Repository releases (automatic)

Nothing to do. Merging a PR into `dev` or `main` tags the merge commit and
creates a GitHub Release:

- `main`: `vX.Y.Z`. `Z` increments per merge; at 50 it rolls over to `Y+1` and
  `Z` resets to 0.
- `dev`: `vX.Y.Z.R-dev`. `X.Y.Z` mirrors the latest `main` tag; `R` increments
  while that base holds and resets to 1 when `main` moves.

### npm releases (a version bump)

Publishing is still a deliberate act, but the tagging is no longer manual:

1. Update `CHANGELOG.md` with a section for the new version.
2. Bump `package.json` version.
3. Open a PR to `main` and merge it.

`npm-release.yml` then ensures `v<version>` exists and dispatches `publish.yml`.
Whether to publish is decided by asking **npm**, not by whether the tag exists:
with no prerelease suffix, `release.yml` mints tags in the same namespace and
runs concurrently, so a tag being present says nothing about publication. A merge
that does not change the version is a no-op.

Since the version is now plain (no `-modrev`), `publish.yml` derives the
`latest` dist-tag rather than `modrev`.

## Manual publish in GitHub UI

Still available for republishing or for a tag pushed by hand:

1. Open Actions in GitHub.
2. Select `Publish` workflow.
3. Click `Run workflow`.
4. Enter the tag you already pushed, for example `v0.2.0`.
5. Run the workflow.

## What publish.yml does

Given the input tag, the workflow:

1. Fetches tags and verifies the input tag exists.
2. Checks out the exact commit for that tag.
3. Validates tag format (`vX.Y.Z` with optional prerelease suffix).
4. Runs the reusable test workflow (`test.yml`).
5. Verifies `tag == v${package.json version}`.
6. Runs `npm run prepublishOnly`.
   - This runs build + checks before publish.
7. Publishes with an explicit dist-tag derived from the prerelease suffix, so a
   prerelease never lands on `latest`:

```bash
npm publish --access public --tag "<dist-tag>"
```

   Authentication uses `NPM_TOKEN` via `NODE_AUTH_TOKEN`. `publishConfig` still
   requests provenance, which requires `id-token: write`.

8. Extracts the matching version section from `CHANGELOG.md`.
9. Creates a GitHub Release for the tag with that changelog section as release body.
10. Adds a compare link to the previous tag when available.

## Expected failure cases

Publish will fail if:

- The input tag does not exist.
- The tag does not match `package.json` version.
- `CHANGELOG.md` is missing.
- The changelog section for that version is missing or empty.
- Build/tests/checks fail.
