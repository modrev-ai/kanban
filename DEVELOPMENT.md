# Development

## Requirements

- Node.js 20+
- npm 10+

## Install

```bash
npm run install:all
```

## Hot reload workflow

Fast path:

```bash
npm run dev:full
```

- Starts the runtime in watch mode and the Vite web UI dev server together
- Auto-picks free runtime and web UI ports so multiple checkouts can run side by side
- Best for day-to-day source development, especially web UI work and runtime changes that benefit from fast iteration

Manual equivalent in two terminals:

1. Runtime server (API + PTY agent runtime):

```bash
npm run dev
```

- Runs on `http://127.0.0.1:3484`

2. Web UI (Vite HMR):

```bash
npm run web:dev
```

- Runs on `http://127.0.0.1:4173`
- `/api/*` requests from Vite are proxied to `http://127.0.0.1:3484`

Use `http://127.0.0.1:4173` while developing UI so changes hot reload.

## Windows launchers

Two double-clickable launchers sit at the repo root for local use:

| File | Runs | Starts | URL |
| --- | --- | --- | --- |
| `kanban-dev.cmd` | latest `dev` release | `tsx watch` runtime + Vite web UI, hot reload | http://127.0.0.1:4173 |
| `kanban-prod.cmd` | latest `prod` release | production build, served from `dist` | http://127.0.0.1:4174 |

They are thin wrappers over the npm scripts, so nothing is duplicated. Each one
checks Node is 22+ and leaves the window open on failure so you can read the
error.

### Running the latest release

Each launcher runs the newest **release** for its channel, not the branch tip:

| Launcher | Channel | Picks the newest | Falls back to |
| --- | --- | --- | --- |
| `kanban-dev.cmd` | dev | `vX.Y.Z.R-dev` tag | `origin/dev` |
| `kanban-prod.cmd` | prod | `vX.Y.Z` tag | `origin/main` |

Those tags are produced by `.github/workflows/release.yml` on every merged pull
request, so "latest release" and "what that branch last shipped" are the same
thing. Until the first release exists on a channel, the launcher says so and
falls back to the branch tip.

The tag is checked out **detached**, so no local branch is ever moved or reset
and unpushed commits cannot be lost. The launcher prints how to get back:

```
Running release v1.0.1.10-dev
(detached HEAD - run "git checkout dev" to go back to developing)
```

Tag selection is numeric per field, via `scripts/latest-release-tag.mjs`. Both
lexicographic ordering and `git tag --sort=v:refname` place `v1.0.9` after
`v1.0.10`, which would silently launch a stale release.

Uncommitted changes to tracked files are **refused** rather than disturbed by the
checkout. Untracked files are ignored -- they do not block a checkout, and this
repo normally carries some.

Dependencies install with `npm ci`, not `npm install`: it installs exactly the
lockfile the release was cut from and leaves `package-lock.json` untouched.
`npm install` can rewrite the lockfile, which would dirty the tree and block the
next launch.

Two escape hatches:

- `--force-sync` -- check out the release anyway, discarding local changes.
- `--no-sync` -- skip all of this and run the current checkout, which is what you
  want when testing a feature branch. (`--no-branch-check` is accepted as an
  alias.)

### Freeing the ports

Before starting, each launcher terminates whatever is LISTENING on the ports it
needs (3484 and 4173 for dev, 4174 for prod), so a leftover instance cannot cause
an `EADDRINUSE` failure. It reports the PID and image name it kills, skips the
system PIDs 0 and 4, and warns rather than failing if a process cannot be
terminated (which usually means it belongs to another user and needs an elevated
prompt).

This is deliberately destructive: relaunching is expected to take over the port.

### Rebuild only when the release changes

Neither launcher rebuilds on every run. Each records the **release** it last
worked for and compares on launch:

| Launcher | Stamp | Redoes work when |
| --- | --- | --- |
| `kanban-prod.cmd` | `dist/.build-release` | a different release is checked out, or `dist` is missing/incomplete |
| `kanban-dev.cmd` | `node_modules/.kanban-release` | a different release is checked out, or dependencies are not installed |

The stamp records **which release** is checked out, not the `package.json`
version. Those are decoupled: `release.yml` derives tags from git
(`v1.0.4.1-dev`, `v1.0.6`) while `package.json` sits on a single version
(`1.0.5`) across every one of them. Keying on `package.json` meant the
stamp never changed after the first run — dependencies were never refreshed, and
prod never rebuilt at all, silently serving a stale `dist`.

So a normal restart is immediate, and a new release triggers exactly one rebuild.
The launcher prints why, e.g.
`Rebuilding (release changed: v1.0.4.1-dev -> v1.0.4.2-dev)`.

When `--no-sync` is used the stamp falls back to `git describe --tags --always`,
so a hand-checked-out commit is still detected as a change.

Pass `--rebuild` (or `-r`) to force the work regardless.

`kanban-dev.cmd` has nothing to build -- it runs from source under `tsx watch`
with Vite -- so its equivalent staleness check is the installed dependency tree.
Note the trigger is the **version**, not the lockfile: dependency changes without
a version bump will not be picked up automatically, so use `--rebuild` after
pulling changes that touch `package-lock.json`.

The prod stamp is written after the build, because `npm run clean` deletes
`dist` at the start of it. Both stamps live inside already-gitignored
directories.

`kanban-prod.cmd` is a **real production build**, not "dev on another port": it
runs `npm run build` and then serves the bundled web UI from `dist/web-ui` on a
single port with `NODE_ENV=production` - no Vite, no watcher. That is the same
shape as the deployed server, so use it when checking production-only behavior.

Note this differs from `npm run prod:full`, which despite its name is a *second
dev-mode instance* (`tsx watch` + Vite on 3485/4174), not a production build.

Both instances share one `KANBAN_STORAGE_DIR`, matching existing `dev:full` /
`prod:full` behavior - they show the same board. Set `KANBAN_STORAGE_DIR` before
launching if you want them isolated.

## Choose the right workflow

Use `npm run dev:full` when you are actively developing Kanban and want fast iteration. It runs the source checkout with `tsx watch` plus the Vite web UI dev server, so runtime changes reload and web UI changes get HMR.

By default, `dev:full` now starts Kanban with `--skip-shutdown-cleanup` so stopping a debug/dev instance does not move cards to Trash or delete task worktrees from your active boards.

To opt back into shutdown cleanup while using `dev:full`, run:

```bash
npm run dev:full -- --with-shutdown-cleanup
```

If `node_modules` has not been installed in this worktree, `dev:full` auto-runs `npm ci` before launch.

Use `npm run dogfood` when you want to validate the latest built CLI behavior more realistically. It builds the current checkout and launches `dist/cli.js`, which is better for checking packaged behavior, startup and shutdown flows, multi-instance dogfooding, and launch behavior against a target project.

## VS Code F5 debugging

The repo includes `.vscode/launch.json` with two configurations:

- `Dev (Full Stack)`: Launches the same workflow as `npm run dev:full`, starting both the runtime and Vite in one terminal.
- `Run Tests`: Runs `vitest run` with the debugger so you can set breakpoints in tests.

Shutdown cleanup flags:

- `--skip-shutdown-cleanup`: do not move sessions to trash or delete task worktrees on shutdown

## Build and run packaged CLI

```bash
npm run build
node dist/cli.js
```

This mode serves built web assets from `dist/web-ui` and does not hot reload the web UI.

Runtime port options:

```bash
# fixed port
node dist/cli.js --port 3484

# pick the first free port starting at 3484
node dist/cli.js --port auto
```

You can still use `KANBAN_RUNTIME_PORT` if needed, but `--port` is preferred for local multi-instance runs.

## Dogfooding with two Kanban instances

Run your stable orchestrator first (main checkout):

```bash
cd /path/to/kanban-main
npm run build
node dist/cli.js --port 3484
```

Then run a test checkout against a target project (feature worktree):

```bash
cd /path/to/kanban-feature-worktree
npm run dogfood -- --project /path/to/target/repo --port auto
```

If `--project` is omitted, the launcher starts Kanban from a non-git cwd so runtime behaves like launching outside a git repo and opens the first indexed project (if any):

```bash
npm run dogfood -- --port auto
```

Dogfood launcher behavior:

- builds the current checkout by default
- launches `dist/cli.js` with `cwd` set to the target project
- supports `--port <number|auto>`
- supports `--no-open`
- supports `--skip-build` when you already built and want faster restarts
- is the right choice when you want to test the latest built CLI rather than the source-mode dev server

## Run `kanban` from any directory

After cloning and installing dependencies, create/update the global CLI link from this repo:

```bash
npm run link
```

Verify:

```bash
which kanban
kanban --version
```

Then run from any project directory:

```bash
cd /path/to/your/project
kanban
```

After local code changes, run `npm run build` again before using the linked command.

When switching between worktrees, re-run `npm run link` from the worktree you want to test so the global `kanban` binary points at the right `dist/cli.js`. For sidebar agent automation guidance, inspect `src/prompts/append-system-prompt.ts`.

Remove the global link:

```bash
npm run unlink
```

## Scripts

- `npm run build`: build runtime and bundled web UI into `dist`
- `npm run dogfood -- [--project <path>] [--port <number|auto>] [--no-open] [--skip-build]`: build and launch this checkout, optionally targeting a specific project path
- `npm run dev`: run CLI in watch mode
- `npm run dev:full`: run the runtime watch server and Vite web UI dev server together
- `npm run prod:serve`: serve an already-built `dist` in production mode on port 4174
- `npm run prod:local`: build, then serve it in production mode on port 4174
- `npm run web:dev`: run web UI dev server
- `npm run web:build`: build web UI
- `npm run typecheck`: typecheck runtime
- `npm run web:typecheck`: typecheck web UI
- `npm run test`: run runtime tests
- `npm run web:test`: run web UI tests
- `npm run check`: lint, typecheck, and test runtime package

## Tests

- `test/integration`: integration tests for runtime behavior and startup flows
- `test/runtime`: runtime unit tests
- `test/utilities`: shared test helpers

## Agent tracking and runtime hooks

Kanban tracks agent session state with runtime hook events. The core transition model is:

- `in_progress -> review`
- `review -> in_progress`

Internal runtime session states are named `running` and `awaiting_review`, and hook events are transition intents:

- `to_in_progress` for `review -> in_progress`
- `to_review` for `in_progress -> review`

How it works end to end:

1. `prepareAgentLaunch` wires each agent with hook commands or hook-aware wrappers.
2. Hook handlers call `kanban hooks ...` subcommands.
3. `kanban hooks ingest --event <to_review|to_in_progress>` reads hook context from env:
   - `KANBAN_HOOK_TASK_ID`
   - `KANBAN_HOOK_WORKSPACE_ID`
   - `KANBAN_HOOK_PORT`
4. The ingest command calls runtime TRPC `hooks.ingest`.
5. The runtime applies guarded transitions and ignores duplicates or invalid transitions as no-ops.

Current agent mappings:

These are external agent/file-hook names where the agent config requires them.
They are distinct from Cline SDK plugin runtime hooks such as `beforeRun`,
`beforeTool`, `afterTool`, and `afterRun`.

- Claude
  - `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure` emit `to_in_progress`
  - `Stop`, `PermissionRequest`, and `Notification` with `permission_prompt` emit `to_review`
- Codex
  - wrapper enables TUI session logging and maps:
    - `task_started` and `exec_command_begin` to `to_in_progress`
    - `*_approval_request` to `to_review`
  - Codex `notify` completion path also emits `to_review`
- Gemini
  - `BeforeAgent` and `AfterTool` emit `to_in_progress`
  - `AfterAgent` emits `to_review`
  - hook command writes `{}` to stdout immediately to satisfy Gemini hook contract, then notifies in background
- OpenCode
  - plugin maps busy activity to `to_in_progress`
  - plugin maps idle/error and permission ask to `to_review`
  - plugin filters child sessions to avoid false transitions from nested runs
- Droid
  - `PreToolUse` for active tools like `Read`, `Grep`, `Glob`, `FetchUrl`, `WebSearch`, `Execute`, `Task`, `Edit`, and `Create` emits `to_in_progress`
  - `PreToolUse` for `AskUser` and `Stop` emit `to_review`
  - `PostToolUse` for `AskUser` and `UserPromptSubmit` emit `to_in_progress`

Important behavior details:

- Hooks are best-effort and should not crash or block the underlying agent process.
- Hook notify paths are asynchronous to keep agent UX responsive.
- Runtime transition guards are authoritative and prevent state flapping from duplicate events.
- Hook transport is implemented in Node and invoked through `kanban hooks ...`, so the behavior is consistent across Windows and non-Windows environments.

For a full technical breakdown, see:

- `.plan/docs/runtime-hooks-architecture.md`

## PostHog telemetry config

The web UI reads PostHog settings at build time:

- `POSTHOG_KEY`
- `POSTHOG_HOST`

Local development:
- Set these in `web-ui/.env.local` (see `web-ui/.env.example`).
- If `POSTHOG_KEY` is missing, telemetry does not initialize.

Release builds:
- The publish workflow injects `POSTHOG_KEY` and `POSTHOG_HOST` from GitHub Secrets.
- `POSTHOG_HOST` is optional and defaults to `https://data.cline.bot`.

Result:
- Official releases have telemetry enabled.
- Forks and source builds have telemetry disabled unless a key is explicitly provided.
