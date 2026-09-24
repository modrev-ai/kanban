# Branch deployments (Oracle Compute)

> **Status: parked (backlog).** The pipeline is built and merged, but no
> deployment has ever completed. It is blocked on one repository secret and has
> not been prioritised. Nothing below is aspirational — it describes code that
> exists on `main` — but treat the instance as *not currently serving Kanban*.
> See [Resuming this work](#resuming-this-work) for the exact next step.

## Resuming this work

### The one blocker

The `DEPLOY_PATH` repository secret contains a **colon**. A colon is the `PATH`
separator, so every entry derived from the deploy path is split into two garbage
entries and no project binary resolves — while the files exist, `test -x` passes,
and absolute-path execution works. That combination cost six deploy attempts,
presenting first as `husky: command not found` and then `shx: command not found`.

```bash
gh secret set DEPLOY_PATH --repo modrev-ai/kanban --body "/home/opc/kanban-deploy"
```

`remote-deploy.sh` now rejects a colon (and whitespace) in about a second, so a
repeat of that mistake fails legibly instead of after a 30-minute build.

Then re-run either deploy from the Actions tab, or:

```bash
gh workflow run deploy-dev.yml --repo modrev-ai/kanban --ref dev
```

### Already proven on the instance

These ran successfully in earlier attempts and should not need rework:

- SSH connectivity and the base64 key handling.
- Private Node 22 provisioning under `<DEPLOY_PATH>/toolchain/` — the system
  Node is 20 and is shared with the sibling `cline-kanban-executables` services,
  so it is deliberately left alone.
- `npm ci` for both the root and `web-ui`, **including the native `node-pty`
  node-gyp compile**, which was the biggest open question. Roughly 18-36 minutes.
- Swap provisioning, the build heap cap, and the OOM guard.

### Never yet executed

Everything past the build is untested on real hardware:

- `npm run build` (the Vite/rollup stage) on a 498 MB instance.
- Both systemd units, firewalld, and the SELinux port labelling.
- The health poll and external reachability check.

The failure most worth anticipating is the **SELinux loopback denial**: a 502
from a proxy whose backend is perfectly healthy, with
`connect EACCES 127.0.0.1:<internal>` in the journal. See
[Troubleshooting](#troubleshooting).

### Decisions still open

- [ ] **These ports have no authentication.** See
      [Security](#security-these-ports-have-no-authentication). Ingress is
      `0.0.0.0/0`, matching the existing posture for 3484/3485. Narrow the CIDR,
      front it with the Caddy already on 80/443, or bind the proxy to a Tailscale
      address before treating this as usable.
- [ ] **Capacity.** A 498 MB instance hosting Vaultwarden, Caddy, the sibling
      deployment, and two Kanban environments is oversubscribed. The OOM guard
      bounds the blast radius; it does not create memory. One environment, or an
      Always Free `A1.Flex` (4 OCPU / 24 GB), is the real fix.
- [ ] **Build location.** Each deploy costs ~30-40 minutes, almost entirely
      install and compile, and every failure so far was an on-box toolchain
      problem rather than an application one. Building on the runner and shipping
      the artifact would remove that whole class of failure and cut a deploy to
      minutes — a different design from the build-on-server one requested, so it
      is recorded here rather than assumed.


Two environments run side by side on a single Oracle Compute instance, each
built from its own branch and reachable on its own port.

| Environment | Branch | Deployed when                | Public URL                       | Workflow            |
| ----------- | ------ | ---------------------------- | -------------------------------- | ------------------- |
| dev         | `dev`  | a PR into `dev` is merged    | `http://129.159.69.183:4173`     | `deploy-dev.yml`    |
| prod        | `main` | a PR into `main` is merged   | `http://129.159.69.183:4174`     | `deploy-prod.yml`   |

Target instance: `instance-20260730-0604`, Oracle Linux 9, **`VM.Standard.E2.1.Micro`
— 1 OCPU / 1 GB RAM**, in `US-ASHBURN-AD-2`. That shape drives several decisions
below; see [Memory](#memory).

Both are thin callers of the reusable `deploy-oracle.yml`, and both can also be
run by hand from the Actions tab (`workflow_dispatch`) to force a redeploy.

Nothing is built on the GitHub runner. The runner only copies
`scripts/deploy/remote-deploy.sh` to the instance and runs it over SSH; that
script does a fresh pull and full build of the branch on the server.

## Why each environment runs two processes

This is the part that is not obvious, and the reason a naive "just bind 0.0.0.0
and open the port" deploy returns `403 Host not allowed.` instead of the board.

The runtime gates every HTTP request and every WebSocket upgrade on the `Host`
and `Origin` headers (`src/server/middleware.ts`). `getAllowedHostHeaders()`
accepts only:

- `localhost:PORT`
- `127.0.0.1:PORT`
- its own bound address, when bound to something non-loopback

There is **no environment variable to extend that list**. So a browser at
`http://<public-ip>:4173` sends `Host: <public-ip>:4173` and is rejected.

Two non-fixes, for the record:

- **Bind the runtime to the public IP.** On OCI the public address is NAT'd by
  the internet gateway and is not present on the instance NIC, so `bind()` fails
  with `EADDRNOTAVAIL`.
- **Bind `0.0.0.0`.** That makes `isKanbanRemoteHost()` true, which arms the
  interactive passcode gate, and the public `Host` header is still rejected.

So each environment runs:

```
kanban-<env>-proxy.service   0.0.0.0:<public>    rewrites Host/Origin
        |
        v
kanban-<env>.service         127.0.0.1:<internal>   the app
```

The app stays on loopback, where its `Host` header is allow-listed and the
passcode gate stays off. `scripts/deploy/kanban-host-proxy.mjs` owns the public
port and rewrites `Host`/`Origin` to the loopback authority the runtime trusts.
It is deliberately dependency-free, so it runs from the system `node` and cannot
break when the app's dependency tree changes. It proxies WebSocket upgrades too,
which matters because the runtime runs the same gate on every upgrade — twice, in
fact, since the state hub and the terminal bridge each register an `upgrade`
listener.

A missing `Origin` header is forwarded as missing rather than forged: the runtime
already treats absent `Origin` as allowed, and inventing one would be strictly
worse.

## Ports

| Environment | Public (proxy) | Internal (app) |
| ----------- | -------------- | -------------- |
| dev         | 4173           | 3494           |
| prod        | 4174           | 3495           |

The internal ports are **not** the local `dev:full`/`prod:full` defaults
(3484/3485). The sibling deploy in `modrev-ai/cline-kanban-executables` already
runs its proxy and server on 3484/3485 on this instance; reusing them would
collide.

Each environment also gets its own `KANBAN_STORAGE_DIR`
(`<DEPLOY_PATH>/state-<env>`), so dev and prod never share a board, config, or
task worktree.

## Required repository secrets

Add these to `modrev-ai/kanban`. They exist only in
`modrev-ai/cline-kanban-executables`, and GitHub never returns a secret's value
once set — not through the API, not through the CLI — so they cannot be copied
between repositories. They have to be entered by hand.

| Secret               | Value                                                       |
| -------------------- | ----------------------------------------------------------- |
| `ORACLE_HOST`        | `129.159.69.183`                                             |
| `ORACLE_USER`        | `opc`  (Oracle Linux 9 default)                              |
| `DEPLOY_PATH`        | `/home/opc/kanban-deploy` (absolute preferred; see below)     |
| `ORACLE_SSH_KEY_B64` | **base64-encoded** private key for the instance              |

`DEPLOY_PATH` **must not contain a colon**, and must not contain whitespace. The
script rejects both immediately. A colon is especially vicious: it is the `PATH`
separator, so every entry derived from the deploy path — `node_modules/.bin`, the
private Node install — is split into two garbage entries and no project binary
resolves, while the files remain present, `test -x` passes, and absolute-path
execution works. That combination cost six deploy attempts, surfacing as
`husky: command not found` and then `shx: command not found`.

`DEPLOY_PATH` may be relative — the script resolves it against `$HOME` and
canonicalizes it before deriving anything. An absolute value is still preferred,
because a relative one is easy to misread. This matters more than it looks: the
script `cd`s into the checkout partway through, so before normalization every
relative path derived from `DEPLOY_PATH` re-rooted at that point, which broke the
private Node's `PATH` entry and then `NODE_BIN` itself.

The key is base64-encoded because a PEM pasted raw into a secret loses its
newlines and OpenSSH then rejects it as malformed. Use the same key already in
`ORACLE_SSH_KEY_B64` on the executables repo, or re-encode it:

```bash
base64 -w0 ~/.ssh/your_oracle_key
```

The deploy fails fast with an explicit list if any of these are missing.

## Node version

Kanban requires Node 22+, and the instance ships Node 20 at
`/usr/local/bin/node`. That system Node is **shared**: the sibling
`cline-kanban-executables` deployment runs its `kanban-server` and
`kanban-proxy` units (ports 3484/3485) on it. Swapping a major version out from
under a running service is not this deploy's call to make.

So `remote-deploy.sh` provisions its own interpreter instead:

- If the system Node is already 22+, it is used as-is and nothing is downloaded.
- Otherwise the pinned official tarball (currently `v22.23.2`, arch detected from
  `uname -m`) is unpacked to `<DEPLOY_PATH>/toolchain/node-<version>/` and put
  first on `PATH`, so `npm`, `npx`, and any node-gyp subprocess resolve to it.
  Subsequent deploys reuse the cached copy.

Prepending to `PATH` is **not sufficient on its own**, and assuming it was cost a
deploy attempt: `npm` is a symlink to a script whose shebang re-resolves `node`,
so the system npm can still run the install under the system Node — the first
attempt reported `EBADENGINE ... current: { node: 'v20.18.0' }` even though
`NODE_BIN` was correctly pointing at 22. Every npm invocation therefore goes
through a `run_npm` helper that calls npm's JS entrypoint with our interpreter
explicitly. `PATH` is still prepended, for nested tools the build spawns
(node-gyp, npx, vite).

The systemd units reference that interpreter by **absolute path**, so the running
services do not depend on `PATH` or on whatever the system Node happens to be.

To move to a newer Node, bump `NODE_PINNED_VERSION` in `remote-deploy.sh`; the
next deploy downloads it and leaves the old one cached on disk.

## Memory

The instance has **1 GB of RAM and no swap by default**, and a full build does
not fit in that. node-gyp compiling `node-pty` and rollup bundling the web-ui are
both memory-hungry; the OOM-killer takes out the compiler or node with something
that reads like a random build failure — `Killed`, exit 137, a bare SIGKILL from
`cc1plus` — rather than anything mentioning memory.

Observed on this instance: `MemTotal` is **498 MB** and it already carries
**4.5 GB of swap**, so the swapfile step correctly no-ops there. The heap cap and
OOM guard still apply.

`remote-deploy.sh` therefore, on any host with < 4 GB RAM and < 2 GB swap:

- creates a 2 GB `/swapfile`, enables it, and adds it to `/etc/fstab`;
- exports `NODE_OPTIONS=--max-old-space-size=1536` for the build. Without this V8
  sizes the old-space against *physical* RAM (~256 MB here) and rollup dies with a
  heap OOM before swap is ever touched.

This makes the build slow rather than fatal. Be realistic about the ceiling: two
environments, each a runtime plus a proxy, share 1 GB, and Kanban spawns coding
agents on top of that. If builds start timing out or agents get OOM-killed under
real use, the fix is a bigger shape (the Always Free ARM `A1.Flex` allows 4 OCPU
/ 24 GB) rather than more tuning here.

### This box also hosts Vaultwarden

The same instance runs a self-hosted **Vaultwarden** (password manager) behind
Caddy — that is what the pre-existing 80/443 ingress rules are for. It is
deployed from `modrev-ai/keywee` (`deploy/vaultwarden/`), and its containers set
no memory limit.

That matters because the kernel OOM-killer scores every process on the box and
kills the worst offender. During a Kanban build that is usually node or
`cc1plus` — but it is not guaranteed, and a sustained squeeze could take the
vault down instead. `restart: unless-stopped` would bring it back, but the vault
would be unavailable mid-SQLite-write while a deploy ran.

So the deploy marks **its own** processes as the preferred victims, and never
touches the Vaultwarden stack:

- `remote-deploy.sh` raises its own `oom_score_adj` to 500 before building. The
  value is inherited across fork/exec, so every `npm`, `node`, and compiler
  process the build spawns inherits it. Raising the score needs no privileges —
  only lowering it below 0 requires `CAP_SYS_RESOURCE`.
- Both systemd units set `OOMScoreAdjust=500`, so the long-running app and proxy
  carry the same preference.

The failure mode is now "the deploy died" rather than "the password manager
died". This is a preference, not a guarantee — it biases the kernel's choice, it
does not cap memory. If you want a hard ceiling, add `MemoryMax=` to the units,
but pick the number from an observed working set rather than guessing, or the app
will be killed during normal use.

Given the vault shares this hardware, running **both** dev and prod here is worth
questioning. One environment, or moving to an `A1.Flex`, is the safer shape.

## One-time server prerequisites

The deploy script installs what it can, but these must already be true:

- **Node.js** — handled automatically, but read the note below. Kanban needs 22+
  (`engines.node`). This instance has Node 20 at `/usr/local/bin/node`, and the
  deploy deliberately does **not** upgrade it.
- **Passwordless `sudo`** for the SSH user — it writes systemd units and manages
  the firewall.
- **Build toolchain** (`gcc-c++`, `make`, `python3`, `git`). `node-pty` is a
  native addon compiled by node-gyp during `npm ci`. The script installs these
  via `dnf`/`yum` if missing.
- **Swap**, on a micro shape. The script creates it automatically; see
  [Memory](#memory).

## OCI network ingress

Opening the host firewall is not enough. The script handles `firewalld` and
`iptables` on the instance, but the **OCI VCN Security List** is a cloud-level
control that cannot be changed from inside the instance.

**This is already done.** Ingress rules for TCP 4173 and TCP 4174 (source
`0.0.0.0/0`) were added to security list
`ocid1.securitylist.oc1.iad.aaaaaaaa2kw5krk66jnvvgdfzr3nsbcsmq73bwldnsipyzsrzqb3kz2etaua`,
alongside the pre-existing rules for 22, 80, 443, 3484, and 3485. The subnet uses
a security list rather than an NSG (`prohibit-public-ip-on-vnic: false`, no NSG
attached), so this is the only place the rule is needed.

The workflow verifies external reachability at the end. If the app is healthy on
the instance but unreachable from the internet, it emits a warning naming this as
the cause rather than failing the deploy.

## Security: these ports have no authentication

Worth being explicit about, because it is a direct consequence of the proxy
design and it is easy to miss.

Kanban's passcode gate arms only when `isKanbanRemoteHost()` is true — that is,
when the app itself binds a non-loopback address. Here the app binds `127.0.0.1`,
so **the passcode gate never arms**, and the proxy publishes that unauthenticated
runtime on a public port. Kanban runs coding agents that execute arbitrary
commands on the box, so anyone who reaches port 4173 or 4174 has shell-equivalent
access to the instance.

The ingress rules above use `0.0.0.0/0`, matching the posture already in place for
3484/3485. If that was not a deliberate choice, tighten it — any of:

- narrow the ingress `source` to your own IP/CIDR instead of `0.0.0.0/0`;
- front the ports with the reverse proxy already answering on 80/443 (the
  existing rules are described as "HTTP(S) for Caddy/ACME"), adding TLS and auth
  there;
- put the instance on Tailscale and bind the proxy to the tailnet address only —
  set `PROXY_HOST` in the unit to the Tailscale IP.

## What the remote script does

1. Resolves a Node 22+ interpreter (see [Node version](#node-version)) and
   installs the build toolchain if needed.
2. Ensures swap exists, caps the build's JS heap, and marks itself the preferred
   OOM victim so a squeeze cannot take down the co-hosted Vaultwarden.
3. Fresh pull: clone if absent, otherwise `fetch` + `reset --hard origin/<branch>`
   + `git clean -xdff`. Nothing from a previous build survives.
4. Full build: `npm ci` (root and `web-ui`), then `npm run build`, all through the
   resolved interpreter. `NODE_ENV` is left unset — npm reads `production` as an
   implicit `--omit=dev`, which strips the build's own toolchain — and the root
   `prepare` (husky) script is removed, since git hooks are meaningless here.
   Fails loudly if `dist/cli.js` or `dist/web-ui` is missing afterwards.
5. Writes both systemd units.
6. Opens the host firewall; labels the internal port for SELinux.
7. Enables and restarts both units.
8. Polls `http://127.0.0.1:<public>/` until it answers, dumping journal logs and
   listening sockets on failure.

## Operating it

```bash
systemctl status kanban-dev kanban-dev-proxy
journalctl -u kanban-dev -f
journalctl -u kanban-dev-proxy -f
```

Substitute `kanban-prod` / `kanban-prod-proxy` for production.

### Troubleshooting

**502 from the public port.** The proxy is up but cannot reach the app. If the
journal shows `connect EACCES 127.0.0.1:<internal>`, that is SELinux denying a
loopback `connect()` from a plain node service — not a network problem. Confirm
with `sudo ausearch -m avc -ts recent`. The deploy script applies the targeted
`semanage`/`setsebool` fix, but on this instance family the sibling repo
ultimately had to set SELinux to permissive. The script deliberately does **not**
flip that for you, since it is a host-wide security downgrade.

**403 `Host not allowed.`** Something is reaching the app without passing through
the proxy — check that `kanban-<env>-proxy` is the process on the public port
(`ss -tlnp | grep 4173`).

**Connection times out from outside, works via SSH.** OCI ingress, see above.
