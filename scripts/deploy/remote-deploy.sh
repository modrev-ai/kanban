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

if ! command -v node >/dev/null 2>&1; then
	echo "ERROR: node is not installed on this instance." >&2
	echo "Install Node.js 22+ before deploying (the package requires engines.node >= 22)." >&2
	exit 1
fi

NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
echo "node ${NODE_BIN} ($(node --version))"
if [ "$NODE_MAJOR" -lt 22 ]; then
	echo "ERROR: Node.js 22+ is required (found $(node --version))." >&2
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
# 2. Swap
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
echo "=== [2/8] Ensuring swap is available ==="

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

# No .git hooks wanted on a deploy target, and npm's fund/audit noise just
# clutters the Actions log.
export HUSKY=0
export NPM_CONFIG_FUND=false
export NPM_CONFIG_AUDIT=false
export NODE_ENV=production

# `npm ci` needs devDependencies (esbuild, tsx, vite) to build, so NODE_ENV must
# not suppress them.
npm ci --include=dev
npm ci --include=dev --prefix web-ui
npm run build

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
