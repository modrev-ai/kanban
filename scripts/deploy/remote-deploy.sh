#!/usr/bin/env bash
#
# Runs ON the Oracle Compute instance. Copied to /tmp by
# .github/workflows/deploy-oracle.yml and executed over SSH.
#
# Does a fresh pull and full build of one branch, then (re)starts two systemd
# units for that environment:
#
#   kanban-<env>.service        the app, bound to 127.0.0.1:<INTERNAL_PORT>
#   kanban-<env>-proxy.service  public listener on 0.0.0.0:<PUBLIC_PORT>
#
# The split is not decoration. The runtime rejects any Host header outside
# {localhost, 127.0.0.1, its own bound address} and has no env var to extend
# that list, and binding a non-loopback address additionally turns on the
# interactive passcode gate. Keeping the app on loopback and letting the proxy
# rewrite Host/Origin is what makes http://<public-ip>:<PUBLIC_PORT> work at all.
# See scripts/deploy/kanban-host-proxy.mjs.
#
# Required env: ENVIRONMENT BRANCH PUBLIC_PORT INTERNAL_PORT DEPLOY_PATH REPO_URL

set -euo pipefail

for var in ENVIRONMENT BRANCH PUBLIC_PORT INTERNAL_PORT DEPLOY_PATH REPO_URL; do
	if [ -z "${!var:-}" ]; then
		echo "ERROR: required environment variable $var is not set" >&2
		exit 1
	fi
done

# Normalize DEPLOY_PATH to an absolute, canonical path before deriving anything
# from it. This is not defensive tidying -- a relative DEPLOY_PATH silently broke
# two deploys. The script cd's into APP_DIR partway through, so every relative
# path derived from DEPLOY_PATH re-roots at that point: the PATH entry for the
# private Node stopped resolving (installs fell back to the system Node 20 and
# reported EBADENGINE), and NODE_BIN itself became "No such file or directory".
# systemd also requires absolute WorkingDirectory/ExecStart, so relative values
# would have produced broken units even if the build had succeeded.
case "$DEPLOY_PATH" in
	/*) ;;
	*)
		echo "DEPLOY_PATH is relative (\"${DEPLOY_PATH}\") - resolving against ${HOME}"
		DEPLOY_PATH="${HOME}/${DEPLOY_PATH}"
		;;
esac
mkdir -p "$DEPLOY_PATH"
DEPLOY_PATH="$(cd "$DEPLOY_PATH" && pwd -P)"
echo "deploy path resolved to ${DEPLOY_PATH}"

APP_DIR="${DEPLOY_PATH}/kanban-${ENVIRONMENT}"
STATE_DIR="${DEPLOY_PATH}/state-${ENVIRONMENT}"
APP_SERVICE="kanban-${ENVIRONMENT}"
PROXY_SERVICE="kanban-${ENVIRONMENT}-proxy"
SERVICE_USER="$(id -un)"
SERVICE_GROUP="$(id -gn)"

echo "=============================================================="
echo " Kanban deploy: ${ENVIRONMENT}"
echo "   branch        ${BRANCH}"
echo "   app dir       ${APP_DIR}"
echo "   public port   ${PUBLIC_PORT}  (proxy, 0.0.0.0)"
echo "   internal port ${INTERNAL_PORT}  (app, 127.0.0.1)"
echo "   run as        ${SERVICE_USER}"
echo "=============================================================="

# ---------------------------------------------------------------------------
# 1. Toolchain
# ---------------------------------------------------------------------------
echo "=== [1/8] Checking toolchain ==="

# Kanban needs Node 22+ (engines.node). The system node is deliberately NOT
# upgraded to get there: /usr/local/bin/node is shared with the sibling
# cline-kanban-executables deployment, whose kanban-server/kanban-proxy units on
# 3484/3485 run on it. Swapping the major version underneath a running service is
# not ours to do. Instead, provision a private Node under DEPLOY_PATH and use its
# absolute path for both the build and our systemd units.
NODE_REQUIRED_MAJOR=22
NODE_PINNED_VERSION="v22.23.2"
TOOLCHAIN_DIR="${DEPLOY_PATH}/toolchain"
PRIVATE_NODE_DIR="${TOOLCHAIN_DIR}/node-${NODE_PINNED_VERSION}"

system_node_major() {
	command -v node >/dev/null 2>&1 || return 1
	node -p 'process.versions.node.split(".")[0]' 2>/dev/null || return 1
}

SYSTEM_NODE_MAJOR="$(system_node_major || echo 0)"
if [ "${SYSTEM_NODE_MAJOR:-0}" -ge "$NODE_REQUIRED_MAJOR" ]; then
	NODE_BIN="$(command -v node)"
	NPM_CLI=""
	echo "system node is new enough: ${NODE_BIN} ($(node --version))"
else
	echo "system node is $( (node --version 2>/dev/null) || echo 'absent') - provisioning a private Node ${NODE_PINNED_VERSION}"
	echo "  (leaving /usr/local/bin/node alone; it is shared with the 3484/3485 deployment)"

	case "$(uname -m)" in
		x86_64) NODE_ARCH="x64" ;;
		aarch64 | arm64) NODE_ARCH="arm64" ;;
		*) echo "ERROR: unsupported architecture $(uname -m) for a Node tarball install" >&2; exit 1 ;;
	esac

	if [ ! -x "${PRIVATE_NODE_DIR}/bin/node" ]; then
		command -v xz >/dev/null 2>&1 || sudo dnf install -y xz || sudo yum install -y xz || true
		TARBALL="node-${NODE_PINNED_VERSION}-linux-${NODE_ARCH}.tar.xz"
		URL="https://nodejs.org/dist/${NODE_PINNED_VERSION}/${TARBALL}"
		echo "  downloading ${URL}"
		mkdir -p "$TOOLCHAIN_DIR"
		TMP_DIR="$(mktemp -d)"
		curl -fsSL --retry 3 --max-time 300 -o "${TMP_DIR}/${TARBALL}" "$URL"
		tar -xJf "${TMP_DIR}/${TARBALL}" -C "$TMP_DIR"
		rm -rf "$PRIVATE_NODE_DIR"
		mv "${TMP_DIR}/node-${NODE_PINNED_VERSION}-linux-${NODE_ARCH}" "$PRIVATE_NODE_DIR"
		rm -rf "$TMP_DIR"
	else
		echo "  reusing cached ${PRIVATE_NODE_DIR}"
	fi

	NODE_BIN="${PRIVATE_NODE_DIR}/bin/node"
	# Invoke npm's JS entrypoint through our own interpreter rather than relying on
	# PATH. Prepending to PATH is not sufficient on its own: `npm` is a symlink to
	# a script whose shebang re-resolves `node`, so the system npm can still end up
	# running the install under the system Node -- which is exactly what happened on
	# the first attempt (EBADENGINE reported node v20.18.0 despite NODE_BIN being 22).
	NPM_CLI="${PRIVATE_NODE_DIR}/lib/node_modules/npm/bin/npm-cli.js"
	if [ ! -f "$NPM_CLI" ]; then
		echo "ERROR: private Node install has no npm at ${NPM_CLI}" >&2
		exit 1
	fi
	# Still prepend PATH, so nested tools the build spawns (node-gyp, npx, vite)
	# also pick up this interpreter.
	export PATH="${PRIVATE_NODE_DIR}/bin:${PATH}"
fi

# Every npm invocation goes through this, so the install can never silently run
# under a different interpreter than the one the units will use.
run_npm() {
	if [ -n "${NPM_CLI:-}" ]; then
		"$NODE_BIN" "$NPM_CLI" "$@"
	else
		npm "$@"
	fi
}

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
echo "using node ${NODE_BIN} ($("$NODE_BIN" --version)), npm $(run_npm --version 2>/dev/null || echo '?')"
if [ "$NODE_MAJOR" -lt "$NODE_REQUIRED_MAJOR" ]; then
	echo "ERROR: Node.js ${NODE_REQUIRED_MAJOR}+ is required (resolved $("$NODE_BIN" --version))." >&2
	exit 1
fi

# node-pty is a native addon compiled by node-gyp during npm ci. Without these
# the install fails deep inside gyp with a confusing error.
missing_build_deps=()
for tool in make g++ python3 git; do
	command -v "$tool" >/dev/null 2>&1 || missing_build_deps+=("$tool")
done
if [ ${#missing_build_deps[@]} -gt 0 ]; then
	echo "Missing build tools: ${missing_build_deps[*]} - installing"
	sudo dnf install -y gcc gcc-c++ make python3 git \
		|| sudo yum install -y gcc gcc-c++ make python3 git \
		|| { echo "ERROR: could not install build tools (needed to compile node-pty)" >&2; exit 1; }
fi

# ---------------------------------------------------------------------------
# 2. Memory guards
#
# The target is an Always Free VM.Standard.E2.1.Micro: 1 OCPU, 1 GB RAM. A full
# build does not fit in that. node-gyp compiling node-pty and rollup bundling the
# web-ui are both memory-hungry, and the kernel OOM-killer takes out the compiler
# or node with an error that reads like a random build failure ("Killed",
# exit 137, or a bare SIGKILL from cc1plus) rather than an out-of-memory one.
#
# Swap makes the build slow instead of fatal. Deploying two environments on this
# shape leaves very little headroom, so this is not optional here.
# ---------------------------------------------------------------------------
echo "=== [2/8] Memory guards (swap, heap cap, OOM priority) ==="

MEM_TOTAL_MB=$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo)
SWAP_TOTAL_MB=$(awk '/^SwapTotal:/ {print int($2/1024)}' /proc/meminfo)
echo "RAM ${MEM_TOTAL_MB}MB, swap ${SWAP_TOTAL_MB}MB"

# Only intervene on genuinely small hosts; a larger instance needs no help.
if [ "$MEM_TOTAL_MB" -lt 4096 ] && [ "$SWAP_TOTAL_MB" -lt 2048 ]; then
	if [ ! -f /swapfile ]; then
		echo "Creating a 2G swapfile at /swapfile"
		sudo fallocate -l 2G /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
		sudo chmod 600 /swapfile
		sudo mkswap /swapfile >/dev/null
	fi
	sudo swapon /swapfile 2>/dev/null || echo "  (swapfile already active)"
	# Survive a reboot.
	if ! grep -q '^/swapfile ' /etc/fstab 2>/dev/null; then
		echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
	fi
	echo "swap now $(awk '/^SwapTotal:/ {print int($2/1024)}' /proc/meminfo)MB"
fi

# Cap the JS heap explicitly. Without this, V8 sizes the old-space against
# physical RAM (~256MB on a 1GB box) and rollup dies with a heap OOM long before
# swap is ever touched.
export NODE_OPTIONS="--max-old-space-size=1536"

# This instance also hosts Vaultwarden (a password manager) behind Caddy, in
# containers with no memory limit. Under pressure the kernel OOM-killer scores
# every process and kills the worst offender, and there is no guarantee that is
# ours -- a squeeze during the build could take the vault down instead.
#
# Raising our own oom_score_adj makes the kernel prefer to kill *this* build and
# everything it spawns (the value is inherited across fork/exec) before touching
# anything else on the box. Raising the score needs no privileges; only lowering
# it below 0 requires CAP_SYS_RESOURCE. The failure mode becomes "the deploy
# died", never "the password manager died".
if [ -w /proc/self/oom_score_adj ] && echo 500 > /proc/self/oom_score_adj 2>/dev/null; then
	echo "build oom_score_adj = $(cat /proc/self/oom_score_adj) (preferred OOM victim)"
else
	echo "  (could not raise oom_score_adj; continuing)"
fi

# ---------------------------------------------------------------------------
# 3. Fresh pull
# ---------------------------------------------------------------------------
echo "=== [3/8] Fresh pull of ${BRANCH} ==="

mkdir -p "$DEPLOY_PATH" "$STATE_DIR"

if [ ! -d "${APP_DIR}/.git" ]; then
	echo "No existing checkout - cloning"
	rm -rf "$APP_DIR"
	git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
git remote set-url origin "$REPO_URL"
git fetch --prune --force origin "$BRANCH"
git checkout -B "$BRANCH" "origin/${BRANCH}"
git reset --hard "origin/${BRANCH}"
# -x also removes ignored files (node_modules, dist, web-ui/dist). npm ci wipes
# node_modules anyway, so nothing is gained by keeping a partial tree around.
git clean -xdff

DEPLOYED_SHA="$(git rev-parse HEAD)"
echo "Checked out ${BRANCH} @ ${DEPLOYED_SHA}"

# ---------------------------------------------------------------------------
# 4. Full build
# ---------------------------------------------------------------------------
echo "=== [4/8] Installing dependencies and building ==="

export HUSKY=0
export NPM_CONFIG_FUND=false
export NPM_CONFIG_AUDIT=false

# NODE_ENV is deliberately NOT exported as "production" here. npm reads it as an
# implicit --omit=dev, which skipped every devDependency on the first attempt and
# made the root `prepare` script fail with "husky: command not found" (exit 127).
# The build needs esbuild, tsx and vite, so dev dependencies are required; the
# runtime gets NODE_ENV=production from the systemd units instead, which is where
# it actually matters. `vite build` is production mode by default regardless.

# Git hooks are meaningless on a deploy target, and the root `prepare` script
# exists only to install them. Dropping it removes the whole failure mode rather
# than relying on HUSKY=0 (which only silences husky once it is already runnable).
# Scripts are not part of what `npm ci` validates against the lockfile.
# The interpreter was resolved before the cd into APP_DIR; assert it still works
# from here, so a path problem surfaces as a clear message rather than a bare 127.
if [ ! -x "$NODE_BIN" ]; then
	echo "ERROR: node interpreter ${NODE_BIN} is not executable from $(pwd)" >&2
	exit 1
fi

run_npm pkg delete scripts.prepare >/dev/null

run_npm ci --include=dev
run_npm ci --include=dev --prefix web-ui
run_npm run build

if [ ! -f "${APP_DIR}/dist/cli.js" ]; then
	echo "ERROR: build finished but ${APP_DIR}/dist/cli.js is missing" >&2
	exit 1
fi
if [ ! -d "${APP_DIR}/dist/web-ui" ]; then
	echo "ERROR: build finished but ${APP_DIR}/dist/web-ui is missing (the app would serve no UI)" >&2
	exit 1
fi
echo "Build OK"

# ---------------------------------------------------------------------------
# 5. systemd units
# ---------------------------------------------------------------------------
echo "=== [5/8] Writing systemd units ==="

sudo tee "/etc/systemd/system/${APP_SERVICE}.service" >/dev/null <<UNIT
[Unit]
Description=Kanban application server (${ENVIRONMENT})
Documentation=https://github.com/modrev-ai/kanban
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=HOME=${HOME}
# Loopback bind: keeps the Host header allow-listed and leaves the passcode gate
# off (it arms only when isKanbanRemoteHost() is true). The proxy owns the
# public port.
Environment=KANBAN_RUNTIME_HOST=127.0.0.1
Environment=KANBAN_RUNTIME_PORT=${INTERNAL_PORT}
# Per-environment state, so dev and prod never share a board, config or worktree.
Environment=KANBAN_STORAGE_DIR=${STATE_DIR}
Environment=KANBAN_NO_AUTO_UPDATE=1
ExecStart=${NODE_BIN} ${APP_DIR}/dist/cli.js --no-open --host 127.0.0.1 --port ${INTERNAL_PORT}
# Prefer killing this over Vaultwarden/Caddy when the box runs out of memory.
OOMScoreAdjust=500
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${APP_SERVICE}

[Install]
WantedBy=multi-user.target
UNIT

sudo tee "/etc/systemd/system/${PROXY_SERVICE}.service" >/dev/null <<UNIT
[Unit]
Description=Kanban public proxy (${ENVIRONMENT}) - rewrites Host/Origin for the runtime gate
Documentation=https://github.com/modrev-ai/kanban
After=network-online.target ${APP_SERVICE}.service
Wants=network-online.target
BindsTo=${APP_SERVICE}.service

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${APP_DIR}
Environment=PROXY_HOST=0.0.0.0
Environment=PROXY_PORT=${PUBLIC_PORT}
Environment=TARGET_HOST=127.0.0.1
Environment=TARGET_PORT=${INTERNAL_PORT}
ExecStart=${NODE_BIN} ${APP_DIR}/scripts/deploy/kanban-host-proxy.mjs
OOMScoreAdjust=500
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${PROXY_SERVICE}

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload

# ---------------------------------------------------------------------------
# 6. Firewall + SELinux
# ---------------------------------------------------------------------------
echo "=== [6/8] Opening host firewall for ${PUBLIC_PORT}/tcp ==="

if command -v firewall-cmd >/dev/null 2>&1 && sudo firewall-cmd --state >/dev/null 2>&1; then
	sudo firewall-cmd --permanent --add-port="${PUBLIC_PORT}/tcp" >/dev/null 2>&1 || true
	sudo firewall-cmd --reload >/dev/null 2>&1 || true
	echo "firewalld: $(sudo firewall-cmd --list-ports 2>/dev/null || echo 'n/a')"
else
	echo "firewalld not active - skipping (check iptables if the port is unreachable)"
fi

# Oracle Linux images ship iptables rules that predate firewalld on some shapes.
if command -v iptables >/dev/null 2>&1 && sudo iptables -L INPUT -n >/dev/null 2>&1; then
	if ! sudo iptables -C INPUT -p tcp --dport "${PUBLIC_PORT}" -j ACCEPT >/dev/null 2>&1; then
		sudo iptables -I INPUT 1 -p tcp --dport "${PUBLIC_PORT}" -j ACCEPT >/dev/null 2>&1 || true
		command -v netfilter-persistent >/dev/null 2>&1 && sudo netfilter-persistent save >/dev/null 2>&1 || true
	fi
fi

# The proxy connects to the app over loopback. Under enforcing SELinux a plain
# node service is denied that connect() with EACCES, which surfaces as a 502
# from a proxy whose backend is perfectly healthy - the exact failure the
# sibling deploy repo hit. Label the port so the targeted policy allows it.
if command -v getenforce >/dev/null 2>&1; then
	SELINUX_MODE="$(getenforce 2>/dev/null || echo Unknown)"
	echo "SELinux: ${SELINUX_MODE}"
	if [ "$SELINUX_MODE" = "Enforcing" ]; then
		sudo semanage port -a -t http_port_t -p tcp "${INTERNAL_PORT}" 2>/dev/null \
			|| sudo semanage port -m -t http_port_t -p tcp "${INTERNAL_PORT}" 2>/dev/null \
			|| echo "  (semanage unavailable or port already labelled)"
		sudo setsebool -P httpd_can_network_connect 1 2>/dev/null || true
		echo "  NOTE: if the proxy still returns 502 with 'connect EACCES 127.0.0.1:${INTERNAL_PORT}',"
		echo "        SELinux is still denying it. Confirm with: sudo ausearch -m avc -ts recent"
	fi
fi

# ---------------------------------------------------------------------------
# 7. Restart
# ---------------------------------------------------------------------------
echo "=== [7/8] Restarting services ==="

sudo systemctl enable "${APP_SERVICE}" "${PROXY_SERVICE}" >/dev/null 2>&1 || true
sudo systemctl restart "${APP_SERVICE}"
sudo systemctl restart "${PROXY_SERVICE}"

for unit in "${APP_SERVICE}" "${PROXY_SERVICE}"; do
	if ! systemctl is-active --quiet "$unit"; then
		echo "ERROR: ${unit} failed to start" >&2
		sudo systemctl status "$unit" --no-pager -l || true
		journalctl -u "$unit" --no-pager -l -n 60 || true
		exit 1
	fi
	echo "${unit}: active"
done

# ---------------------------------------------------------------------------
# 8. Wait for HTTP readiness
# ---------------------------------------------------------------------------
echo "=== [8/8] Waiting for the app to answer on the public port ==="

# The runtime needs a while to initialise its HTTP endpoint on a small instance.
ready=false
for attempt in $(seq 1 30); do
	code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:${PUBLIC_PORT}/" || echo 000)"
	echo "  attempt ${attempt}/30: HTTP ${code}"
	case "$code" in
		2??|3??)
			ready=true
			break
			;;
		502)
			# Proxy is up but cannot reach the app: either still booting, or the
			# SELinux loopback denial described above.
			;;
	esac
	sleep 5
done

if [ "$ready" != true ]; then
	echo "ERROR: http://127.0.0.1:${PUBLIC_PORT}/ did not become ready" >&2
	echo "--- listening sockets ---"; ss -tlnp | grep -E ":${PUBLIC_PORT}|:${INTERNAL_PORT}" || echo "none"
	echo "--- ${APP_SERVICE} ---";   journalctl -u "${APP_SERVICE}" --no-pager -l -n 60 || true
	echo "--- ${PROXY_SERVICE} ---"; journalctl -u "${PROXY_SERVICE}" --no-pager -l -n 40 || true
	exit 1
fi

echo "=============================================================="
echo " Deploy OK: ${ENVIRONMENT} (${BRANCH} @ ${DEPLOYED_SHA:0:8}) on port ${PUBLIC_PORT}"
echo "=============================================================="
