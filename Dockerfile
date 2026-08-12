# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: builder
# Installs all dependencies (root + web-ui), builds the runtime bundle
# (dist/cli.js) and the bundled web UI (dist/web-ui). node-pty is a native
# addon, so this stage needs python3/make/g++ to compile it.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

# node-pty compiles a native binding via node-gyp during `npm ci`.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ git \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Skip husky git hooks — there is no .git in the build context and hooks are
# irrelevant to a production build.
ENV HUSKY=0 \
	NPM_CONFIG_FUND=false \
	NPM_CONFIG_AUDIT=false

# Install dependencies first so they are cached independently of source edits.
# Only the root package and web-ui are required to build the server + assets;
# packages/desktop (Electron) is intentionally excluded.
COPY package.json package-lock.json .npmrc ./
COPY web-ui/package.json web-ui/package-lock.json ./web-ui/
RUN npm ci \
	&& npm --prefix web-ui ci

# Build the app: bundles dist/cli.js + dist/index.js and copies web-ui/dist
# into dist/web-ui. The Sentry sourcemap upload is a no-op without
# SENTRY_AUTH_TOKEN, so no secrets are needed here.
COPY . .
RUN npm run build

# esbuild inlines most dependencies into dist/, but some packages emit dynamic
# require() calls that can't be bundled (ajv's generated validators, ws's
# optional native speedups) and node-pty is a native addon left external. Keep
# the production dependency tree on disk so those requires resolve at run time,
# and drop devDependencies to slim the image.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Stage 2: runtime
# A slim image that ships only what the server needs at run time: the built
# bundle, the compiled node-pty addon, git, and a small init (tini).
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# git: Kanban is a git-centric tool (worktrees, diffs, commits).
# openssh-client + ca-certificates: fetch/push over SSH/HTTPS.
# tini: proper PID 1 that forwards SIGTERM so graceful shutdown runs.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git openssh-client ca-certificates tini \
	&& rm -rf /var/lib/apt/lists/*

# Run as a non-root user. The node image already ships a `node` user/group at
# uid/gid 1000; reuse it, remapping the ids when the UID/GID build args are set
# so a bind-mounted repo owned by the host user stays writable, e.g.:
#   docker compose build --build-arg UID=$(id -u) --build-arg GID=$(id -g)
ARG UID=1000
ARG GID=1000
RUN if [ "$GID" != "1000" ]; then groupmod --gid "$GID" node; fi \
	&& if [ "$UID" != "1000" ]; then usermod --uid "$UID" node; fi

ENV NODE_ENV=production \
	KANBAN_RUNTIME_HOST=0.0.0.0 \
	KANBAN_RUNTIME_PORT=3484 \
	KANBAN_NO_AUTO_UPDATE=1 \
	HOME=/home/node

# The built bundle plus the pruned production dependency tree (node-pty and the
# handful of packages the bundle require()s dynamically at run time).
COPY --from=builder /app/dist /opt/kanban/dist
COPY --from=builder /app/package.json /opt/kanban/package.json
COPY --from=builder /app/node_modules /opt/kanban/node_modules

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Expose the CLI on PATH, create the state + workspace dirs, and hand ownership
# to the non-root user so bind mounts, the state volume, and git all work.
RUN chmod +x /opt/kanban/dist/cli.js /usr/local/bin/docker-entrypoint.sh \
	&& ln -s /opt/kanban/dist/cli.js /usr/local/bin/kanban \
	&& mkdir -p /workspace /home/node/.cline \
	&& chown -R node:node /home/node /workspace /opt/kanban

USER node

# Prepare git for operating on mounted repos owned by a different (host) uid.
# Runs as the node user, so this writes to /home/node/.gitconfig.
RUN git config --global --add safe.directory '*' \
	&& git config --global user.name "Kanban" \
	&& git config --global user.email "kanban@localhost" \
	&& git config --global init.defaultBranch main

# /workspace is where you mount the git repo Kanban should manage.
WORKDIR /workspace

EXPOSE 3484

ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]
CMD ["kanban", "--no-open"]
