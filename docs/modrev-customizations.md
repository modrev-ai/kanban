# Modrev Customizations

This document describes everything the Modrev fork adds on top of upstream
Kanban (`cline/kanban`). It is the companion to [`architecture.md`](./architecture.md):
read that first for the base runtime model, then read this for what
`@modrev-ai/kanban` changes.

> **One-line summary:** The fork adds a native **Modrev agent** — a way to run
> *any* OpenAI-compatible model with your own API key, base URL, and model ID —
> plus configurable LLM retry, credit-exhaustion handling, a unified per-task
> model picker, and scoped-package publishing under `@modrev-ai/kanban`.

## What "Modrev" means in this codebase

Upstream Kanban has two execution paths (see `architecture.md`): PTY-backed CLI
agents, and native Cline chat through the Cline SDK. The Modrev fork adds a
third *logical* agent, **`modrev`**, but it is **not a new runtime path** — it
reuses the native Cline SDK runtime.

A "Modrev model" is really a **custom OpenAI-compatible provider** registered in
the Cline SDK provider catalog, tagged so Kanban can tell it apart from Cline's
own providers. The tag is a provider-id prefix:

- `web-ui/src/runtime/modrev-provider.ts` defines `MODREV_PROVIDER_ID_PREFIX = "modrev-"`
  and the legacy exact id `"modrev"`.
- `isModrevModelProviderId()` / `ensureModrevProviderId()` classify and normalize
  provider ids into that namespace.

Because Modrev runs on the SDK runtime, `modrev` is listed as a **native Cline
runtime agent**:

- `src/core/agent-catalog.ts`: `RUNTIME_NATIVE_CLINE_AGENT_IDS = ["cline", "modrev"]`,
  and the predicate `isNativeClineRuntimeAgent()` is what routes a task through
  the SDK session runtime instead of launching a CLI binary. The catalog entry
  for `modrev` has an **empty `binary`** — it is never spawned as a process, and
  is always considered "installed" (auth is in-app, not a tool on `PATH`).

Keep this mental model in mind for the rest of the document:

```
Modrev agent (agentId "modrev")
        │  is a native Cline runtime agent
        ▼
Custom OpenAI-compatible provider  (provider id "modrev-<name>")
        │  registered in the Cline SDK provider catalog (models.json)
        ▼
Launched via a built-in chat-completions proxy provider ("openrouter")
        │  configured with the model's own baseURL / apiKey / modelId
        ▼
Cline SDK session host  →  streamed back into the Kanban board
```

## Feature areas

The fork is best understood as seven areas. Each maps to a cluster of commits
and a small set of files.

| # | Area | Primary files |
| --- | --- | --- |
| 1 | Modrev agent + custom-model system | `modrev-provider.ts`, `agent-catalog.ts`, `cline-provider-service.ts`, `sdk-provider-boundary.ts` |
| 2 | Session runtime routing + retry + credit exhaustion | `cline-session-runtime.ts`, `cline-task-session-service.ts`, `cline-event-adapter.ts`, `cline-session-state.ts` |
| 3 | Unified model registry + flat per-task model picker | `task-model-options.ts`, `task-agent-model-picker.tsx` |
| 4 | NVIDIA env seeding (added, then removed) | `cline-provider-service.ts` (historical) |
| 5 | Runtime-config keys (`llmRetry`, `modrev*`) | `runtime-config.ts`, `api-contract.ts`, `api-validation.ts`, `runtime-api.ts`, `agent-registry.ts` |
| 6 | Modrev settings UI + wiring | `modrev-setup-section.tsx`, `use-runtime-settings-modrev-controller.ts`, `card-detail-view.tsx`, `use-home-sidebar-agent-panel.tsx` |
| 7 | Packaging + release | `package.json`, `.npmrc`, `.github/workflows/publish.yml`, `RELEASE_WORKFLOW.md` |

### 1. The Modrev custom-provider / custom-model system

Adding a Modrev model creates/updates a custom provider in the SDK catalog and
stores it independently of Cline's active provider.

- **Namespace helper** — `web-ui/src/runtime/modrev-provider.ts`: the
  `modrev-` prefix, `isModrevModelProviderId()`, `ensureModrevProviderId()`.
- **Provider service (backend facade)** — `src/cline-sdk/cline-provider-service.ts`:
  - `addCustomProvider()`, `updateCustomProvider()`, `deleteCustomProvider()`
    (the Remove-model action).
  - `AddCustomClineProviderInput` carries a `setLastUsed?` flag. Modrev passes
    `setLastUsed: false` so **registering a model does not hijack Cline's active
    provider** — the two agents stay independent.
  - `resolveLaunchConfig()` calls `ensureSdkCustomProvidersLoaded()` first so a
    just-registered model is recognized at launch, then resolves
    provider/model/apiKey/baseUrl honoring any `providerIdOverride` /
    `modelIdOverride`.
  - `getProviderCatalog()` / `getProviderModels()` list what's registered.
- **SDK persistence boundary** — `src/cline-sdk/sdk-provider-boundary.ts`:
  `ensureSdkCustomProvidersLoaded()`, `addSdkCustomProvider()`,
  `updateSdkCustomProvider()` (with a `models.json` fallback when the installed
  SDK lacks `updateLocalProvider`), `deleteSdkCustomProvider()`. Custom
  providers persist to a local `models.json`.
- **Client query fns** — `web-ui/src/runtime/runtime-config-query.ts`:
  `addClineProvider`, `updateClineProvider`, `deleteClineProvider`,
  `fetchClineProviderCatalog`, `fetchClineProviderModels`.

> **Why a separate registry note:** loading a custom provider into the
> `@clinebot/llms` model registry does **not** make the SDK's session *gateway*
> aware of it. See area 2 for how launches actually reach the model.

### 2. Session runtime routing, retry, and credit exhaustion

**Routing custom models — `src/cline-sdk/cline-session-runtime.ts`.** The SDK
runtime gateway only *registers* built-in providers and merely *configures* them
at session start; it never registers custom ones, so a custom provider id
resolves as "Unknown or disabled provider" and the chat shows "Model stream
failed". The fix routes custom models through a built-in **generic
OpenAI-compatible proxy provider**:

- `GENERIC_OPENAI_COMPATIBLE_PROVIDER_ID = "openrouter"`.
- In `startTaskSession`, `isCustomProvider = !isBuiltInSdkProviderId(providerId)`;
  when custom, `effectiveProviderId` becomes `openrouter`, and the model's own
  base URL, API key, and model id are passed through.
- **It must be a chat-completions provider, not a Responses-API one.**
  `litellm` and `openai-native` serialize prior assistant turns as Responses
  `input` items, which a plain chat-completions endpoint rejects with
  `data did not match any variant of untagged enum InputParam` on every turn
  after the first. `openrouter` speaks chat-completions and preserves multi-turn
  history. This only reproduces in a real multi-turn conversation — always test
  at least two turns.
- `isBuiltInSdkProviderId()` lives in `src/cline-sdk/sdk-runtime-boundary.ts`.

**Retry — `src/cline-sdk/cline-task-session-service.ts`.** Native-agent
model-response failures do **not** reliably surface as a thrown error from
`sessionHost.send`; most arrive as terminal SDK *error events* that the event
adapter turns into a warning, and some come back as the send *result text*
itself. So a retry built only around `.catch()` never fires. Instead:

- A `turnErrorByTaskId` latch captures event-driven failures via the adapter's
  `onTurnError` callback; `runSendTurnWithRetry()` retries on **any**
  model-response failure (thrown *or* latched) and also catches thrown errors,
  then re-dispatches.
- `resolveRetryPolicy()` reads config; `maxAttempts` counts retries **after** the
  first try. `emitTurnRetryingStatus()` surfaces retry progress to the UI.
- Defaults (in `src/config/runtime-config.ts`): retry **enabled**, delay
  **15000 ms**, max attempts **20**.

**Credit exhaustion.** Credit-exhaustion and user cancellation are **never
retried**.

- `isCreditLimitError()` + `CREDIT_LIMIT_PATTERNS` — `src/cline-sdk/cline-session-state.ts`.
- `src/cline-sdk/cline-event-adapter.ts`: on a credit-limit `error`/`run-failed`
  event, it calls `requestSessionAbort(taskId)` to tear down the dead session
  and tags `onTurnError` with `kind: "credit_limit"`. The service suppresses the
  noisy system message for credit limits.

### 3. Unified model registry + flat per-task model picker

Instead of picking an agent and then a provider and then a model, a task now
picks from **one flat dropdown** that lists Claude Code (and other CLI agents)
alongside every registered Modrev model.

- **Option builder** — `web-ui/src/runtime/task-model-options.ts`:
  `MODREV_TASK_MODEL_VALUE_PREFIX = "modrev:"`, `TaskModelOption`,
  `buildTaskModelOptions()` (flattens Agent → Provider → Model; each CLI agent is
  one entry, the Modrev agent expands in place into one entry per registered
  model), `resolveTaskModelSelection()`, `selectedTaskModelValue()`,
  `buildDefaultTaskModelLabel()`.
- **Picker** — `web-ui/src/components/task-agent-model-picker.tsx`: the
  `useTaskAgentModelPicker()` hook loads the catalog/models; the component
  renders the flat "Model" dropdown and, for Modrev, hides the now-redundant
  provider picker. Used by `task-create-dialog.tsx` and
  `task-inline-create-card.tsx`; the default for new tasks is set from the
  unified Models settings.

### 4. NVIDIA seeding via `NVIDIA_API_KEY` (historical — removed)

An earlier iteration seeded a default NVIDIA `openai-compatible` provider on
startup from `process.env.NVIDIA_API_KEY` (base URL
`https://integrate.api.nvidia.com/v1`). **This code was fully removed** ("Remove
hardcoded NVIDIA … requirement"): models are now added purely through the Modrev
settings UI, with no hardcoded provider. It is documented here only because the
`CHANGELOG.md` entry for `1.0.0-modrev` still mentions the env-var seeding — see
[Known drift](#known-drift).

### 5. Runtime-config keys

New Kanban runtime-config keys, threaded end to end:

- **Storage** — `src/config/runtime-config.ts`: `llmRetryEnabled`,
  `llmRetryDelayMs`, `llmRetryMaxAttempts`, `modrevProviderId`, `modrevModelId`;
  defaults as in area 2; `normalizeAgentId` accepts `"modrev"`.
- **API contract** — `src/core/api-contract.ts`: `runtimeLlmRetrySettingsSchema`
  (`enabled` / `delayMs` / `maxAttempts`) exposed on responses as a nested
  **`llmRetry`** object, plus `modrevProviderId` / `modrevModelId`; custom-provider
  request schemas (`add` with `capabilities` + `setLastUsed`, `update`, `delete`);
  `runtimeAgentIdSchema` includes `"modrev"`.
- **Validation** — `src/core/api-validation.ts`: `parseClineAddProviderRequest`,
  `parseClineUpdateProviderRequest`, `parseClineDeleteProviderRequest`.
- **Wiring** — `src/trpc/runtime-api.ts`: `saveConfig` maps the nested `llmRetry`
  object down to the flat storage keys; add/update/delete provider endpoints;
  `resolveNativeAgentLaunchOverrides` for Modrev launch resolution.
- **Response assembly** — `src/terminal/agent-registry.ts`: packs the
  `modrev*` fields and the nested `llmRetry` object into the config response.

### 6. Modrev settings UI and wiring

- **Settings** — `web-ui/src/components/shared/modrev-setup-section.tsx`: the
  Models list (add / edit / select / remove, with a confirm-removal dialog),
  rendered inside `runtime-settings-dialog.tsx`.
- **Controller hook** — `web-ui/src/hooks/use-runtime-settings-modrev-controller.ts`:
  the `ModrevModel` type and `selectModel` / `addModel` / `updateModel` /
  `removeModel` / `saveModrevSettings`. It persists the active model to Kanban
  config **independently of Cline**, and `addModel` uses `setLastUsed: false`.
- **Chat surfaces** — `web-ui/src/components/card-detail-view.tsx` seeds the
  Modrev model into the chat panel (the "treat Modrev as a native agent in the
  chat UI" fix), and `web-ui/src/hooks/use-home-sidebar-agent-panel.tsx` seeds it
  into the home sidebar agent surface. `web-ui/src/runtime/native-agent.ts`
  (`isNativeClineAgentSelected`) decides when the native chat surface is used.

### 7. Packaging and release

- **`package.json`** — published as `@modrev-ai/kanban`; version carries a
  `-modrev` suffix (currently `1.0.1-modrev`); `publishConfig` sets
  `access: public` and `provenance: true`; `bin.kanban` → `dist/cli.js`;
  repository is `github.com/modrev-ai/kanban`.
- **`.npmrc`** — scopes both `@clinebot` and `@modrev-ai` to the public npm
  registry.
- **`.github/workflows/publish.yml`** — manual `workflow_dispatch` with a `tag`
  input. It derives the npm **dist-tag from the prerelease suffix**, so
  `1.0.0-modrev` publishes under the `modrev` dist-tag rather than `latest`;
  it authenticates the publish with `NPM_TOKEN`, then creates a GitHub Release
  from the changelog section and posts to Slack.
- **`RELEASE_WORKFLOW.md`** — the manual "update changelog → bump version → push
  tag → dispatch Publish" flow.

## File reference

| File | Area | Role |
| --- | --- | --- |
| `web-ui/src/runtime/modrev-provider.ts` | 1 | `modrev-` namespace: classify / normalize provider ids |
| `src/core/agent-catalog.ts` | 1 | `modrev` catalog entry; `RUNTIME_NATIVE_CLINE_AGENT_IDS`; `isNativeClineRuntimeAgent()` |
| `src/cline-sdk/cline-provider-service.ts` | 1 | add / update / delete / list custom providers; `resolveLaunchConfig()` |
| `src/cline-sdk/sdk-provider-boundary.ts` | 1 | custom-provider persistence to `models.json` |
| `src/cline-sdk/sdk-runtime-boundary.ts` | 2 | `isBuiltInSdkProviderId()`; ensures custom providers loaded at host start |
| `src/cline-sdk/cline-session-runtime.ts` | 2 | route custom models through the `openrouter` chat-completions proxy |
| `src/cline-sdk/cline-task-session-service.ts` | 2 | retry loop; latched turn errors; credit-limit gating |
| `src/cline-sdk/cline-event-adapter.ts` | 2 | abort live session on credit exhaustion; `onTurnError` |
| `src/cline-sdk/cline-session-state.ts` | 2 | `isCreditLimitError()` + patterns |
| `web-ui/src/runtime/task-model-options.ts` | 3 | flat task-model option builder / resolvers |
| `web-ui/src/components/task-agent-model-picker.tsx` | 3 | flat per-task model dropdown |
| `src/config/runtime-config.ts` | 5 | storage + defaults for `llmRetry*` and `modrev*` keys |
| `src/core/api-contract.ts` | 5 | `llmRetry` + `modrev*` response/request schemas |
| `src/core/api-validation.ts` | 5 | provider add/update/delete request parsing |
| `src/trpc/runtime-api.ts` | 5 | config save mapping; provider endpoints; launch overrides |
| `src/terminal/agent-registry.ts` | 5 | packs `modrev*` + `llmRetry` into config response |
| `web-ui/src/components/shared/modrev-setup-section.tsx` | 6 | Models list settings UI |
| `web-ui/src/hooks/use-runtime-settings-modrev-controller.ts` | 6 | `ModrevModel`; add/update/remove/select/save |
| `web-ui/src/components/card-detail-view.tsx` | 6 | seed Modrev model into task chat |
| `web-ui/src/hooks/use-home-sidebar-agent-panel.tsx` | 6 | seed Modrev model into sidebar agent |
| `web-ui/src/runtime/native-agent.ts` | 6 | native-chat selection predicate |
| `package.json` / `.npmrc` / `.github/workflows/publish.yml` | 7 | scoped-package publishing |

## Gotchas (tribal knowledge)

These are the non-obvious traps, condensed from `AGENTS.md`:

- **A custom provider id can't be launched directly.** The SDK gateway only
  configures built-in providers; route non-built-in ids through the built-in
  `openrouter` proxy (area 2).
- **The proxy must speak chat-completions, not the Responses API.** `litellm` /
  `openai-native` break every turn after the first. Always test **two** turns.
- **Model failures are event-driven, not thrown.** Retry must latch SDK error
  events via `onTurnError`, not just `.catch()` the send promise.
- **Never retry credit exhaustion or cancellation.**
- **Don't let Modrev hijack Cline's active provider** — Modrev registers models
  with `setLastUsed: false` and persists its active model to Kanban config
  independently.

## Known drift

Small doc/code mismatches worth reconciling:

1. `CHANGELOG.md` (`1.0.0-modrev`) still advertises automatic NVIDIA seeding from
   `NVIDIA_API_KEY`, which was removed from the code (area 4).
2. `RELEASE_WORKFLOW.md` shows `npm publish --provenance --access public` and
   describes OIDC trusted publishing, while `publish.yml` currently publishes
   with `--tag <dist-tag>` using `NPM_TOKEN`.
