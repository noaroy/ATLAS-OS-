#!/usr/bin/env bash
#
# ATLAS OS — VPS installation (SRS §5.16).
#
# Installs ATLAS as a systemd service on a fresh Debian/Ubuntu host:
#   curl -fsSL <raw-url>/deployment/install.sh | sudo bash
# or, from a checkout:
#   sudo ./deployment/install.sh
#
# Idempotent: safe to re-run to upgrade an existing installation.

set -Eeuo pipefail

ATLAS_USER="${ATLAS_USER:-atlas}"
ATLAS_HOME="${ATLAS_HOME:-/opt/atlas}"
NODE_MAJOR="${NODE_MAJOR:-24}"
REPO_URL="${REPO_URL:-}"

log()  { printf '\033[36m›\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run this as root (sudo)."

# ── Dependencies ────────────────────────────────────────────────────────────
log "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git rsync >/dev/null

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt "$NODE_MAJOR" ]]; then
  log "Installing Node.js ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
log "Node.js $(node -v)"

# ── Service account ─────────────────────────────────────────────────────────
if ! id -u "$ATLAS_USER" >/dev/null 2>&1; then
  log "Creating service account '${ATLAS_USER}'"
  useradd --system --create-home --home-dir "$ATLAS_HOME" --shell /usr/sbin/nologin "$ATLAS_USER"
fi
mkdir -p "$ATLAS_HOME"

# ── Source ──────────────────────────────────────────────────────────────────
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -n "$REPO_URL" ]]; then
  log "Fetching source from ${REPO_URL}"
  rm -rf /tmp/atlas-src
  git clone --depth 1 "$REPO_URL" /tmp/atlas-src >/dev/null 2>&1
  SOURCE_DIR=/tmp/atlas-src
fi

log "Staging source into ${ATLAS_HOME}"
rsync -a --delete \
  --exclude 'data/' --exclude 'node_modules/' --exclude '.git/' --exclude '.env' \
  "$SOURCE_DIR"/ "$ATLAS_HOME"/

# ── Configuration ───────────────────────────────────────────────────────────
if [[ ! -f "$ATLAS_HOME/.env" ]]; then
  log "Creating .env with generated secrets"
  cp "$ATLAS_HOME/.env.example" "$ATLAS_HOME/.env"

  SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  PASSWORD="$(node -e 'console.log(require("crypto").randomBytes(12).toString("base64url"))')"

  sed -i "s|^ATLAS_SESSION_SECRET=.*|ATLAS_SESSION_SECRET=${SECRET}|" "$ATLAS_HOME/.env"
  sed -i "s|^ATLAS_FOUNDER_PASSWORD=.*|ATLAS_FOUNDER_PASSWORD=${PASSWORD}|" "$ATLAS_HOME/.env"
  sed -i "s|^NODE_ENV=.*|NODE_ENV=production|" "$ATLAS_HOME/.env"
  sed -i "s|^ATLAS_LOG_PRETTY=.*|ATLAS_LOG_PRETTY=false|" "$ATLAS_HOME/.env"

  chmod 600 "$ATLAS_HOME/.env"
  GENERATED_PASSWORD="$PASSWORD"
else
  log "Keeping the existing .env"
fi

# ── Build ───────────────────────────────────────────────────────────────────
log "Installing dependencies (this takes a minute)"
cd "$ATLAS_HOME"
npm ci --no-audit --no-fund >/dev/null

log "Building ATLAS"
npm run build >/dev/null

mkdir -p "$ATLAS_HOME/data/artifacts" "$ATLAS_HOME/data/backups"
chown -R "$ATLAS_USER:$ATLAS_USER" "$ATLAS_HOME"

# ── Service ─────────────────────────────────────────────────────────────────
log "Installing the systemd unit"
install -m 0644 "$ATLAS_HOME/deployment/atlas.service" /etc/systemd/system/atlas.service
systemctl daemon-reload
systemctl enable atlas >/dev/null 2>&1
systemctl restart atlas

sleep 4
if systemctl is-active --quiet atlas; then
  log "ATLAS OS is running"
else
  warn "The service did not start cleanly. Inspect: journalctl -u atlas -n 60 --no-pager"
  exit 1
fi

PORT="$(grep -E '^ATLAS_PORT=' "$ATLAS_HOME/.env" | cut -d= -f2 || echo 4700)"
EMAIL="$(grep -E '^ATLAS_FOUNDER_EMAIL=' "$ATLAS_HOME/.env" | cut -d= -f2 || echo founder@atlas.local)"

cat <<BANNER

  ────────────────────────────────────────────────
   ATLAS OS is installed and running.

   Console   http://$(hostname -I | awk '{print $1}'):${PORT}
   Sign in   ${EMAIL}
BANNER

if [[ -n "${GENERATED_PASSWORD:-}" ]]; then
  cat <<BANNER
   Password  ${GENERATED_PASSWORD}
             (stored in ${ATLAS_HOME}/.env — record it now)
BANNER
fi

cat <<BANNER

   Logs      journalctl -u atlas -f
   Restart   systemctl restart atlas

   Next: put a TLS reverse proxy in front of this port
   before exposing it to the internet, and set
   ANTHROPIC_API_KEY in ${ATLAS_HOME}/.env for live
   intelligence.
  ────────────────────────────────────────────────

BANNER
