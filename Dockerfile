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

ENV NODE_ENV=production \
	KANBAN_RUNTIME_HOST=0.0.0.0 \
	KANBAN_RUNTIME_PORT=3484 \
	KANBAN_NO_AUTO_UPDATE=1

# The built bundle plus the pruned production dependency tree (node-pty and the
# handful of packages the bundle require()s dynamically at run time).
COPY --from=builder /app/dist /opt/kanban/dist
COPY --from=builder /app/package.json /opt/kanban/package.json
COPY --from=builder /app/node_modules /opt/kanban/node_modules

# Expose the CLI on PATH and prepare git for operating on mounted repos that
# are owned by a different (host) uid.
RUN chmod +x /opt/kanban/dist/cli.js \
	&& ln -s /opt/kanban/dist/cli.js /usr/local/bin/kanban \
	&& git config --global --add safe.directory '*' \
	&& git config --global user.name "Kanban" \
	&& git config --global user.email "kanban@localhost" \
	&& git config --global init.defaultBranch main

# /workspace is where you mount the git repo Kanban should manage.
WORKDIR /workspace

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3484

ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]
CMD ["kanban", "--no-open"]
