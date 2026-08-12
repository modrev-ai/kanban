# Running Kanban with Docker

Kanban ships a multi-stage `Dockerfile` and a `docker-compose.yml` so you can
run the board server in a container instead of installing Node and building
locally.

> [!IMPORTANT]
> Kanban orchestrates coding-agent CLIs (Claude Code, Codex, Droid, Gemini,
> …) and manages git worktrees for the repo you point it at. The container
> image contains the Kanban server and `git`, but **not** the agent CLIs.
> Running tasks needs an agent binary on `PATH` inside the container — see
> [Adding an agent](#adding-an-agent). Without one you can still browse the
> board, create cards, and use the git interface.

## Quick start (Docker Compose)

Build and start the server, managing the repo in the current directory:

```bash
# From the repo you want Kanban to manage (or this repo, to try it out)
KANBAN_PROJECT="$PWD" docker compose -f /path/to/kanban/docker-compose.yml up --build
```

Or, from inside this repo, simply:

```bash
docker compose up --build
```

Then open **http://0.0.0.0:3484** in your browser (see
[Why 0.0.0.0 and not localhost](#why-0000-and-not-localhost)).

The first log lines print a one-time access passcode:

```
🔐 Remote access passcode: 1234-5678
```

Enter it in the browser to unlock the board. To skip the passcode entirely
(only do this when the port is bound to loopback or behind your own auth):

```bash
KANBAN_NO_PASSCODE=1 docker compose up --build
```

## Quick start (plain Docker)

```bash
# Build
docker build -t modrev-kanban:local .

# Run, mounting the repo you want to manage at /workspace
docker run --rm -it \
  -p 127.0.0.1:3484:3484 \
  -v "$PWD:/workspace" \
  -v kanban-state:/home/node/.cline \
  modrev-kanban:local
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `KANBAN_RUNTIME_HOST` | `0.0.0.0` | Interface the server binds to inside the container. Keep `0.0.0.0` so the published port is reachable. |
| `KANBAN_RUNTIME_PORT` | `3484` | Port the server listens on inside the container. |
| `KANBAN_NO_AUTO_UPDATE` | `1` | Disables self-update (containers are immutable). |
| `KANBAN_NO_PASSCODE` | _(unset)_ | Set to `1` to skip the remote-access passcode. |
| `KANBAN_PROJECT` | `./` | (compose only) Host path to the repo mounted at `/workspace`. |
| `KANBAN_PORT` | `3484` | (compose only) Host port the board is published on. |

## Volumes

- **`/workspace`** — the git repository Kanban manages. Mount your project
  here (it must be a git repo).
- **`/home/node/.cline`** — Kanban's state: indexed projects, task worktrees,
  and config. It lives under the non-root `node` user's home (see
  [Non-root user](#non-root-user)). The compose file keeps this in the named
  volume `kanban-state` so your board survives `docker compose down` and
  restarts.

## Why 0.0.0.0 and not localhost

Inside the container the server binds to `0.0.0.0` so the published port is
reachable from the host. Kanban treats any non-loopback bind address as
"remote mode": it enables the passcode gate **and** only accepts HTTP `Host`
headers that match the bound address. That means the board answers at
`http://0.0.0.0:3484` but returns `403 Host not allowed.` for
`http://localhost:3484`.

Two working options:

1. **Open `http://0.0.0.0:3484`** (works on Linux and macOS). This is the
   simplest path and what the compose file assumes.
2. **Linux host networking** — bind to loopback and use the host's network
   namespace, so `localhost` works with no passcode:

   ```bash
   docker run --rm -it --network host \
     -e KANBAN_RUNTIME_HOST=127.0.0.1 \
     -v "$PWD:/workspace" -v kanban-state:/home/node/.cline \
     modrev-kanban:local
   # → http://localhost:3484 (no passcode, loopback only)
   ```

   `--network host` is Linux-only; it is ignored on Docker Desktop for
   macOS/Windows.

## Adding an agent

To actually run tasks, an agent CLI must be available inside the container.
The cleanest way is a small image that extends this one and installs the
agent you use, for example Claude Code:

```dockerfile
FROM modrev-kanban:local
# Claude Code CLI (example)
RUN npm install -g @anthropic-ai/claude-code
# Provide credentials at runtime via env vars / mounted config, not baked in.
```

Build and run it in place of `modrev-kanban:local`, and pass the agent's
credentials at runtime (e.g. `-e ANTHROPIC_API_KEY=...` or by mounting the
agent's config directory). Never bake API keys into the image.

## Non-root user

The container runs as the non-root `node` user (uid/gid `1000`), which the base
`node` image already ships. State lives under that user's home
(`/home/node/.cline`) and `git config --global --add safe.directory '*'` is set
so git still trusts a bind-mounted repo owned by a different (host) uid.

Reads from a bind-mounted repo work regardless of uid. **Writes** to the
bind-mounted repo need the container user to own (or be able to write) those
files. If your host uid/gid is not `1000`, rebuild the image with matching ids
so the `node` user is remapped to them:

```bash
# Compose (the compose file forwards these as build args):
UID=$(id -u) GID=$(id -g) docker compose build
UID=$(id -u) GID=$(id -g) docker compose up

# Plain Docker:
docker build --build-arg UID=$(id -u) --build-arg GID=$(id -g) -t modrev-kanban:local .
```

On Docker Desktop (macOS/Windows) the file-sharing layer maps ownership for you,
so the default `1000` usually just works.

## Security notes

- The compose file publishes the port on `127.0.0.1` only, so the board is not
  exposed to your LAN. Change the mapping to `3484:3484` (all interfaces) only
  if you understand the exposure and keep the passcode enabled.
- The container runs as a non-root user (see [Non-root user](#non-root-user)).
  Keep the image local; do not push it to a public registry with credentials
  mounted.
