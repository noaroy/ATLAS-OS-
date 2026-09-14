#!/usr/bin/env bash
#
# ATLAS OS — livrer une version sur le VPS (systemd), ou revenir en arrière.
#
#   sudo bash deployment/release.sh              livraison depuis le dépôt courant
#   sudo bash deployment/release.sh --rollback   revient au dernier checkpoint sain
#
# L'ordre est celui des conséquences : rien n'est arrêté tant que la version
# n'est pas compilée et testée ; la base est sauvegardée avant d'être migrée ;
# le service n'est redémarré qu'après ; et si la santé ne revient pas, le
# checkpoint précédent est remis en place et le service relancé dessus.
#
# Ne transfère aucun secret : le .env du serveur reste le sien. Ne force-push
# rien, ne réécrit rien. Idempotent : relancer une livraison identique ne
# change rien.

set -Eeuo pipefail

ATLAS_HOME="${ATLAS_HOME:-/opt/atlas}"
ATLAS_USER="${ATLAS_USER:-atlas}"
SERVICE="${ATLAS_SERVICE:-atlas}"
CHECKPOINTS="${ATLAS_HOME}/releases"
KEEP="${ATLAS_KEEP_RELEASES:-3}"
PORT="$(grep -E '^ATLAS_PORT=' "${ATLAS_HOME}/.env" 2>/dev/null | cut -d= -f2 || true)"
PORT="${PORT:-4700}"

log()  { printf '\033[36m›\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "À lancer en root (sudo)."
[[ -d "${ATLAS_HOME}" ]] || die "${ATLAS_HOME} absent : installez d'abord (deployment/install.sh)."

healthy() {
  local tries="${1:-20}"
  for _ in $(seq 1 "${tries}"); do
    if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then return 0; fi
    sleep 3
  done
  return 1
}

# ── Retour arrière ────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--rollback" ]]; then
  last="$(ls -1dt "${CHECKPOINTS}"/*/ 2>/dev/null | head -1 || true)"
  [[ -n "${last}" ]] || die "Aucun checkpoint sous ${CHECKPOINTS}."
  log "Retour au checkpoint ${last}"
  systemctl stop "${SERVICE}" || true
  rsync -a --delete --exclude 'data/' --exclude '.env' --exclude 'out/' --exclude 'releases/' \
    "${last}/" "${ATLAS_HOME}/"
  chown -R "${ATLAS_USER}:${ATLAS_USER}" "${ATLAS_HOME}"
  systemctl start "${SERVICE}"
  healthy 20 && ok "ATLAS répond sur le checkpoint précédent" || die "le checkpoint précédent ne répond pas non plus : journalctl -u ${SERVICE} -n 100"
  exit 0
fi

# ── 1. Installer les dépendances ─────────────────────────────────────────────
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log "Source : ${SOURCE_DIR}"
cd "${SOURCE_DIR}"
log "npm ci"
npm ci --no-audit --no-fund >/dev/null

# ── 2. Typecheck, tests critiques, build — avant de toucher au service ───────
log "typecheck"
npm run typecheck
log "tests critiques"
node --import tsx --test \
  "packages/core/test/sales-engine-config.test.ts" \
  "packages/departments/test/sales-engine.test.ts" \
  "packages/departments/test/send-gate.test.ts" \
  "packages/data/test/sales-engine-repo.test.ts" \
  "packages/runtime/test/sales-engine.test.ts" \
  "packages/runtime/test/client-autopilot.test.ts" \
  "packages/server/test/sales-routes.test.ts" >/dev/null
ok "tests critiques verts"
log "build"
npm run build >/dev/null
[[ -f dist/server/atlas.mjs ]] || die "dist/server/atlas.mjs absent après le build"
ok "build"

# ── 3. Checkpoint de la version en place ─────────────────────────────────────
stamp="$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "${CHECKPOINTS}/${stamp}"
rsync -a --exclude 'data/' --exclude '.env' --exclude 'out/' --exclude 'releases/' --exclude 'node_modules/' \
  "${ATLAS_HOME}/" "${CHECKPOINTS}/${stamp}/" 2>/dev/null || true
ok "checkpoint ${CHECKPOINTS}/${stamp}"
ls -1dt "${CHECKPOINTS}"/*/ 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -rf

# ── 4. Déployer les fichiers (jamais data/, jamais .env) ─────────────────────
log "copie vers ${ATLAS_HOME}"
rsync -a --delete \
  --exclude 'data/' --exclude '.env' --exclude '.env.local' --exclude 'out/' --exclude 'releases/' \
  --exclude '.git/' --exclude 'briefs/*.json' --include 'briefs/*.example.json' --include 'briefs/internal-test-sweden.json' \
  "${SOURCE_DIR}/" "${ATLAS_HOME}/"
chown -R "${ATLAS_USER}:${ATLAS_USER}" "${ATLAS_HOME}"
mkdir -p "${ATLAS_HOME}/data/backups" "${ATLAS_HOME}/out"
chown -R "${ATLAS_USER}:${ATLAS_USER}" "${ATLAS_HOME}/data" "${ATLAS_HOME}/out"

# ── 5. Sauvegarde puis migration, sous l'identité du service ─────────────────
cd "${ATLAS_HOME}"
if [[ -f data/atlas.db ]]; then
  log "sauvegarde avant migration"
  sudo -u "${ATLAS_USER}" npm run --silent backup >/dev/null
  ok "sauvegarde écrite"
fi
log "migration"
sudo -u "${ATLAS_USER}" npm run --silent db:migrate || {
  warn "migration refusée : retour au checkpoint"
  exec bash "${ATLAS_HOME}/deployment/release.sh" --rollback
}

# ── 6. Redémarrer et vérifier ────────────────────────────────────────────────
install -m 0644 "${ATLAS_HOME}/deployment/atlas.service" /etc/systemd/system/${SERVICE}.service
systemctl daemon-reload
systemctl enable "${SERVICE}" >/dev/null 2>&1 || true
log "redémarrage"
systemctl restart "${SERVICE}"

if healthy 20; then
  ok "ATLAS répond sur http://127.0.0.1:${PORT}/healthz"
  sudo -u "${ATLAS_USER}" npm run --silent atlas:status || true
  echo
  ok "Livraison ${stamp} terminée. Retour arrière : sudo bash deployment/release.sh --rollback"
else
  warn "le service ne répond pas après le redémarrage : journalctl -u ${SERVICE} -n 100"
  exec bash "${ATLAS_HOME}/deployment/release.sh" --rollback
fi
