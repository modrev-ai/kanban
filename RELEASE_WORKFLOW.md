# Kanban release workflow

## Overview

This repository uses three GitHub Actions workflows for quality gates and publishing:

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
- `.github/workflows/npm-release.yml`
  - Runs when a pull request is merged into `main`.
  - Tags **the `package.json` version** and dispatches `publish.yml`.
  - A merge that does not bump the version is a no-op.
- `.github/workflows/publish.yml`
  - Manual only via `workflow_dispatch`.
  - Publishes a tagged release to npm using OIDC trusted publishing.
  - Creates a GitHub Release using changelog content.
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

## Release responsibilities

Release prep is intentionally manual on the maintainer side:

1. Update `CHANGELOG.md` with a section for the new version.
2. Bump `package.json` version.
3. Commit and push those changes.
4. Create and push a matching git tag in the form `vX.Y.Z` (or prerelease like `vX.Y.Z-beta.1`).

Example:

```bash
git tag v0.2.0
git push origin v0.2.0
```

Pushing the tag does not publish automatically.

## Manual publish in GitHub UI

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
7. Publishes with:

```bash
npm publish --provenance --access public
```

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
