#!/usr/bin/env bash
#
# ATLAS OS — contrôle du VPS, en lecture seule.
#
#   bash deployment/vps-check.sh            depuis le dépôt déployé (ex. /opt/atlas)
#   npm run atlas:vps-check
#
# Ce script ne répare rien, ne redémarre rien, n'écrit rien : il rapporte.
# Chaque ligne est PASS, WARN, FAIL ou N/A (non vérifiable ici), avec la
# mesure qui la fonde. Aucun secret n'est affiché : pour une clé, on dit
# « présente » ou « absente », jamais sa valeur.
#
# Il ne dépend d'aucun nom de conteneur : les services sont résolus par
# Docker Compose (projet + service) avec les MÊMES fichiers que le
# déploiement — base, override, private — et le même `--env-file` ; à défaut,
# par les étiquettes que Compose pose sur chaque conteneur
# (com.docker.compose.project / .service). Les commandes internes passent par
# `docker exec` sur l'identifiant trouvé. Sans Docker, il dit ce qu'il ne
# peut pas voir.
#
#   ATLAS_COMPOSE_FILES   liste de fichiers Compose séparés par « : »
#                         (défaut : docker-compose.yml + override + private
#                         s'ils existent dans deployment/)
#   ATLAS_ENV_FILE        le .env passé en --env-file (défaut : <dépôt>/.env)
#   ATLAS_COMPOSE_PROJECT le projet (défaut : atlas-os)
#   --compose-command     affiche la commande Compose résolue et s'arrête
#
# Code de sortie : 0 si aucun FAIL, 1 sinon — pour qu'un cron ou un humain
# lise le verdict d'un coup d'œil.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_DIR="${ATLAS_COMPOSE_DIR:-${SCRIPT_DIR}}"
PROJECT="${ATLAS_COMPOSE_PROJECT:-atlas-os}"
ENV_FILE="${ATLAS_ENV_FILE:-${ROOT_DIR}/.env}"
PORT_DEFAULT=4700

# ── La commande Compose, telle que le déploiement la lance ────────────────────
# Relevé sur le VPS : `docker compose -p atlas-os -f docker-compose.yml ps`
# sans --env-file échouait en silence (une variable « :? » du fichier de base
# n'était pas fournie) et sans le fichier privé — et le contrôle concluait
# « conteneur absent » devant deux conteneurs sains.
COMPOSE_FILES=()
if [[ -n "${ATLAS_COMPOSE_FILES:-}" ]]; then
  IFS=':' read -r -a COMPOSE_FILES <<< "${ATLAS_COMPOSE_FILES}"
elif [[ -n "${ATLAS_COMPOSE_FILE:-}" ]]; then
  COMPOSE_FILES=("${ATLAS_COMPOSE_FILE}")
else
  for f in docker-compose.yml docker-compose.override.yml docker-compose.private.yml; do
    [[ -f "${COMPOSE_DIR}/${f}" ]] && COMPOSE_FILES+=("${COMPOSE_DIR}/${f}")
  done
fi
COMPOSE_ARGS=(-p "${PROJECT}")
[[ -f "${ENV_FILE}" ]] && COMPOSE_ARGS+=(--env-file "${ENV_FILE}")
for f in "${COMPOSE_FILES[@]+"${COMPOSE_FILES[@]}"}"; do COMPOSE_ARGS+=(-f "${f}"); done
COMPOSE_FILE="${COMPOSE_FILES[0]:-}"
compose() { docker compose "${COMPOSE_ARGS[@]}" "$@"; }
compose_command_text() { printf 'docker compose'; for a in "${COMPOSE_ARGS[@]}"; do printf ' %s' "${a}"; done; printf '\n'; }

if [[ "${1:-}" == "--compose-command" ]]; then compose_command_text; exit 0; fi

# Le conteneur d'un service : par Compose d'abord, par ses étiquettes ensuite.
# Les étiquettes ne dépendent d'aucun fichier : elles sont posées par Compose
# à la création, quel que soit le jeu de fichiers utilisé ce jour-là.
container_of() {
  local service="$1" cid=""
  cid="$(compose ps -q "${service}" 2>/dev/null | head -1)"
  if [[ -z "${cid}" ]]; then
    cid="$(docker ps -aq --filter "label=com.docker.compose.project=${PROJECT}" --filter "label=com.docker.compose.service=${service}" 2>/dev/null | head -1)"
  fi
  printf '%s' "${cid}"
}
# Exécute Node dans le conteneur atlas, par son identifiant : aucun nom en dur.
atlas_node() { docker exec -i "${ATLAS_CID}" node "$@"; }

if [[ -t 1 ]]; then B=$'\e[1m'; R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; D=$'\e[2m'; N=$'\e[0m'; else B=''; R=''; G=''; Y=''; D=''; N=''; fi

FAILS=0; WARNS=0
pass() { printf '  %sPASS%s  %-28s %s\n' "$G" "$N" "$1" "${2:-}"; }
warn() { printf '  %sWARN%s  %-28s %s\n' "$Y" "$N" "$1" "${2:-}"; WARNS=$((WARNS+1)); }
fail() { printf '  %sFAIL%s  %-28s %s\n' "$R" "$N" "$1" "${2:-}"; FAILS=$((FAILS+1)); }
na()   { printf '  %sN/A %s  %-28s %s\n' "$D" "$N" "$1" "${2:-}"; }
head_() { printf '\n%s%s%s\n' "$B" "$1" "$N"; }

# Lit une variable du .env sans jamais l'afficher. Rend la valeur sur stdout.
envval() { grep -E "^${1}=" "${ENV_FILE}" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" ; }
envset() { local v; v="$(envval "$1")"; [[ -n "${v}" ]]; }

printf '\n%sATLAS — CONTRÔLE VPS (lecture seule)%s  %s%s%s\n' "$B" "$N" "$D" "$(date -u +%Y-%m-%dT%H:%M:%SZ) · $(hostname)" "$N"

# ── 1. Système ────────────────────────────────────────────────────────────────
head_ "1. Système"
if [[ -r /etc/os-release ]]; then
  . /etc/os-release
  case "${ID:-} ${VERSION_ID:-}" in
    "debian 12"*|"debian 13"*|"ubuntu 22.04"*|"ubuntu 24.04"*) pass "distribution" "${PRETTY_NAME:-${ID} ${VERSION_ID}}" ;;
    *) warn "distribution" "${PRETTY_NAME:-inconnue} — testé sur Debian 12 / Ubuntu 22.04+" ;;
  esac
else
  na "distribution" "/etc/os-release illisible"
fi
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -v | sed 's/v\([0-9]*\).*/\1/')"
  if [[ "${NODE_MAJOR}" -ge 24 ]]; then pass "node (hôte)" "$(node -v)"; else warn "node (hôte)" "$(node -v) — 24 requis pour les scripts hors conteneur"; fi
else
  na "node (hôte)" "absent — les scripts (client:auto, backup…) exigent Node 24 sur l’hôte ou un conteneur complet"
fi
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  pass "docker" "$(docker --version | sed 's/,.*//')"
  if docker compose version >/dev/null 2>&1; then pass "docker compose" "$(docker compose version --short 2>/dev/null || docker compose version)"; else fail "docker compose" "plugin absent"; fi
  DOCKER_OK=1
else
  fail "docker" "absent ou démon injoignable (droits ?)"
  DOCKER_OK=0
fi
DISK_USE="$(df -P / 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')"
if [[ "${DISK_USE}" =~ ^[0-9]{1,3}$ && "${DISK_USE}" -le 100 ]]; then
  if [[ "${DISK_USE}" -lt 80 ]]; then pass "disque /" "${DISK_USE} % utilisé"; elif [[ "${DISK_USE}" -lt 90 ]]; then warn "disque /" "${DISK_USE} % utilisé"; else fail "disque /" "${DISK_USE} % utilisé — plus de 90 %"; fi
else na "disque /" "df illisible sur cette plateforme"; fi
if command -v free >/dev/null 2>&1; then
  MEM_TOTAL="$(free -m | awk '/^Mem:/ {print $2}')"; MEM_AVAIL="$(free -m | awk '/^Mem:/ {print $7}')"
  if [[ "${MEM_AVAIL:-0}" -ge 512 ]]; then pass "mémoire" "${MEM_AVAIL} Mo disponibles sur ${MEM_TOTAL}"; else warn "mémoire" "${MEM_AVAIL:-?} Mo disponibles sur ${MEM_TOTAL:-?} — sous 512 Mo"; fi
else na "mémoire" "free indisponible"; fi

# ── 2. Configuration (.env) ───────────────────────────────────────────────────
head_ "2. Configuration — ${ENV_FILE}"
if [[ -f "${ENV_FILE}" ]]; then
  PERM="$(stat -c '%a' "${ENV_FILE}" 2>/dev/null || stat -f '%Lp' "${ENV_FILE}" 2>/dev/null)"
  if [[ "${PERM}" == "600" || "${PERM}" == "400" ]]; then pass "permissions .env" "${PERM}"; else warn "permissions .env" "${PERM} — attendu 600 (chmod 600 ${ENV_FILE})"; fi
  for key in ATLAS_SESSION_SECRET ATLAS_FOUNDER_EMAIL ATLAS_FOUNDER_PASSWORD ANTHROPIC_API_KEY; do
    if envset "${key}"; then pass "secret ${key}" "présent (valeur non affichée)"; else fail "secret ${key}" "absent"; fi
  done
  GMAIL_MISSING=""
  for key in GMAIL_CLIENT_ID GMAIL_CLIENT_SECRET GMAIL_REFRESH_TOKEN GMAIL_USER; do envset "${key}" || GMAIL_MISSING="${GMAIL_MISSING} ${key}"; done
  if [[ -z "${GMAIL_MISSING}" ]]; then pass "gmail credentials" "4/4 présents (valeurs non affichées)"; else warn "gmail credentials" "absents :${GMAIL_MISSING} — lecture de la boîte impossible"; fi

  OUTBOUND="$(envval ATLAS_OUTBOUND_ENABLED)"; MODE="$(envval ATLAS_ENGINE_MODE)"; AILIVE="$(envval ATLAS_AI_LIVE)"; FALLBACK="$(envval ATLAS_SEARCH_FALLBACK_ENABLED)"
  case "$(printf '%s' "${OUTBOUND}" | tr '[:upper:]' '[:lower:]')" in ""|false|0|off|no) pass "ATLAS_OUTBOUND_ENABLED" "${OUTBOUND:-non défini (=false)} — aucun envoi réel" ;; *) warn "ATLAS_OUTBOUND_ENABLED" "${OUTBOUND} — L’ENVOI RÉEL EST OUVERT" ;; esac
  case "${MODE}" in ""|INTERNAL_TEST) pass "ATLAS_ENGINE_MODE" "${MODE:-non défini (=INTERNAL_TEST)}" ;; PRODUCTION) warn "ATLAS_ENGINE_MODE" "PRODUCTION — de vrais prospects peuvent être contactés si l’envoi est ouvert" ;; *) fail "ATLAS_ENGINE_MODE" "${MODE} — valeur inconnue, le démarrage refusera" ;; esac
  case "$(printf '%s' "${AILIVE}" | tr '[:upper:]' '[:lower:]')" in true|1|yes|on) pass "ATLAS_AI_LIVE" "true — les appels de modèle sont facturés" ;; *) pass "ATLAS_AI_LIVE" "${AILIVE:-false} — aucune dépense de modèle" ;; esac
  case "$(printf '%s' "${FALLBACK}" | tr '[:upper:]' '[:lower:]')" in ""|false|0|off|no) pass "ATLAS_SEARCH_FALLBACK_ENABLED" "désactivé (obligatoire)" ;; *) fail "ATLAS_SEARCH_FALLBACK_ENABLED" "${FALLBACK} — doit rester désactivé" ;; esac
  BUDGET_DAY="$(envval ATLAS_AI_DAILY_BUDGET_USD)"; BUDGET_MISSION="$(envval ATLAS_MAX_MISSION_COST_USD)"; BUDGET_SALES="$(envval ATLAS_SALES_DAILY_AI_BUDGET_USD)"
  pass "budgets IA" "jour ${BUDGET_DAY:-défaut} $ · mission ${BUDGET_MISSION:-défaut} $ · découverte commerciale ${BUDGET_SALES:-0.50} $/jour"
  PORT="$(envval ATLAS_PORT)"; PORT="${PORT:-${PORT_DEFAULT}}"
else
  fail ".env" "introuvable — attendu ${ENV_FILE}"
  PORT="${PORT_DEFAULT}"
fi

# ── 3. Conteneurs ─────────────────────────────────────────────────────────────
head_ "3. Conteneurs — projet ${PROJECT}"
ATLAS_UP=0
ATLAS_CID=""
if [[ "${DOCKER_OK}" -eq 1 ]]; then
  if [[ -n "${COMPOSE_FILE}" && -f "${COMPOSE_FILE}" ]]; then
    printf '  %s      compose : %s%s\n' "$D" "$(compose_command_text | sed "s#${ROOT_DIR}/##g")" "$N"
    COMPOSE_ERR="$(compose config --services 2>&1 >/dev/null | head -1 | cut -c1-140)"
    [[ -n "${COMPOSE_ERR}" ]] && warn "fichiers compose" "Compose ne les lit pas tels quels (${COMPOSE_ERR}) — résolution par étiquettes"
  else
    warn "fichiers compose" "aucun fichier trouvé dans ${COMPOSE_DIR} — résolution par étiquettes Docker seulement"
  fi
  for service in atlas searxng; do
    CID="$(container_of "${service}")"
    if [[ -z "${CID}" ]]; then
      fail "conteneur ${service}" "absent (ni par Compose, ni par étiquette com.docker.compose.project=${PROJECT}/service=${service})"
      continue
    fi
    [[ "${service}" == "atlas" ]] && ATLAS_CID="${CID}"
    STATE="$(docker inspect --format '{{.State.Status}}' "${CID}" 2>/dev/null)"
    HEALTH="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}sans healthcheck{{end}}' "${CID}" 2>/dev/null)"
    RESTART="$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "${CID}" 2>/dev/null)"
    UPTIME="$(docker inspect --format '{{.State.StartedAt}}' "${CID}" 2>/dev/null | cut -c1-19)"
    if [[ "${STATE}" == "running" && ( "${HEALTH}" == "healthy" || "${HEALTH}" == "sans healthcheck" ) ]]; then pass "conteneur ${service}" "${STATE} · ${HEALTH} · démarré ${UPTIME}"; [[ "${service}" == "atlas" ]] && ATLAS_UP=1; else fail "conteneur ${service}" "${STATE} · ${HEALTH}"; fi
    if [[ "${RESTART}" == "unless-stopped" || "${RESTART}" == "always" ]]; then pass "restart ${service}" "${RESTART}"; else fail "restart ${service}" "${RESTART:-aucune} — attendu unless-stopped (redémarrage après reboot)"; fi
  done
  # n8n est optionnel (profil) : on le dit seulement s'il tourne.
  N8N="$(container_of n8n)"; [[ -n "${N8N}" ]] && pass "conteneur n8n" "présent (optionnel)" || na "conteneur n8n" "non démarré (optionnel, profil n8n)"
else
  na "conteneurs" "Docker indisponible"
fi

# ── 4. Réseau et santé ────────────────────────────────────────────────────────
head_ "4. Réseau et santé"
if command -v ss >/dev/null 2>&1; then
  PUBLIC="$(ss -ltn 2>/dev/null | awk 'NR>1 {print $4}' | grep -E "(^|:)(${PORT}|8080|5678)$" | grep -vE '^(127\.0\.0\.1|\[::1\]|::1)' || true)"
  if [[ -z "${PUBLIC}" ]]; then pass "ports privés" "aucun port ATLAS/SearXNG/n8n écouté hors du loopback"; else fail "ports exposés" "$(echo "${PUBLIC}" | tr '\n' ' ') — le tableau de bord doit rester derrière le tunnel SSH ou Caddy"; fi
  for p in 80 443; do ss -ltn 2>/dev/null | awk 'NR>1 {print $4}' | grep -qE ":${p}$" && pass "port ${p}" "écouté (reverse proxy)" || na "port ${p}" "non écouté (pas de HTTPS public : tunnel SSH)"; done
else
  na "ports" "ss absent (apt install iproute2)"
fi
if curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
  pass "healthz (hôte)" "http://127.0.0.1:${PORT}/healthz → 200"
elif [[ "${ATLAS_UP}" -eq 1 ]]; then
  if atlas_node -e "fetch('http://127.0.0.1:'+(process.env.ATLAS_PORT||4700)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    pass "healthz (conteneur)" "200 depuis l’intérieur — port non publié sur l’hôte (accès par tunnel/exec)"
  else
    fail "healthz" "ni l’hôte ni le conteneur ne répondent 200"
  fi
else
  na "healthz" "conteneur atlas indisponible"
fi
if [[ "${ATLAS_UP}" -eq 1 && -n "$(container_of searxng)" ]]; then
  if atlas_node -e "fetch(process.env.SEARXNG_BASE_URL.replace(/\/+$/,'')+'/search?q=test&format=json').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    pass "searxng" "répond à ATLAS en JSON"
  else
    fail "searxng" "ne répond pas à une recherche JSON depuis le conteneur atlas"
  fi
fi

# ── 5. Données ────────────────────────────────────────────────────────────────
head_ "5. Données (dans le conteneur atlas)"
if [[ "${ATLAS_UP}" -eq 1 ]]; then
  # Les mesures sont prises par Node dans le conteneur : même bibliothèque SQLite qu’ATLAS, lecture seule.
  DATA_JSON="$(atlas_node - 2>/dev/null <<'JS' | tail -1
const fs = require("fs"); const path = require("path");
const dir = process.env.ATLAS_DATA_DIR || "/data"; const db = path.join(dir, "atlas.db");
const out = { db: fs.existsSync(db), dbBytes: fs.existsSync(db) ? fs.statSync(db).size : 0 };
try {
  const Database = require("better-sqlite3"); const d = new Database(db, { readonly: true });
  out.integrity = d.prepare("PRAGMA integrity_check").all().map((r) => r.integrity_check).join("|");
  out.schema = d.prepare("SELECT MAX(version) v FROM schema_migrations").get().v;
  out.approvedSegments = d.prepare("SELECT COUNT(*) n FROM sales_segments WHERE approved_for_send = 1").get().n;
  out.approvedDrafts = d.prepare("SELECT COUNT(*) n FROM outreach_drafts WHERE state = 'APPROVED_TO_SEND'").get().n;
  out.sentTotal = d.prepare("SELECT COUNT(*) n FROM outbound_send_events WHERE phase = 'SENT'").get().n;
  const pause = d.prepare("SELECT value FROM settings WHERE key = 'sales.globalPause'").get();
  out.pause = pause ? Boolean(JSON.parse(pause.value).paused) : false;
  d.close();
} catch (e) { out.dbError = String((e && e.message) || e).slice(0, 120); }
const bdir = process.env.ATLAS_BACKUP_DIR || path.join(dir, "backups");
try {
  const files = fs.readdirSync(bdir).filter((f) => f.startsWith("atlas-") && f.endsWith(".db")).map((f) => ({ f, t: fs.statSync(path.join(bdir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  out.backups = files.length; out.lastBackupHours = files[0] ? Math.round((Date.now() - files[0].t) / 3600000) : null;
} catch { out.backups = 0; out.lastBackupHours = null; }
console.log(JSON.stringify(out));
JS
)"
  if [[ -n "${DATA_JSON}" ]]; then
    j() { printf '%s' "${DATA_JSON}" | sed -n "s/.*\"$1\":\([^,}]*\).*/\1/p" | tr -d '"'; }
    if [[ "$(j db)" == "true" ]]; then pass "base atlas.db" "$(( $(j dbBytes) / 1048576 )) Mo · schéma $(j schema)"; else fail "base atlas.db" "absente dans le volume"; fi
    INTEG="$(j integrity)"; if [[ "${INTEG}" == "ok" ]]; then pass "integrity_check" "ok"; elif [[ -n "${INTEG}" ]]; then fail "integrity_check" "${INTEG}"; else fail "integrity_check" "$(j dbError)"; fi
    LASTB="$(j lastBackupHours)"
    if [[ "${LASTB}" == "null" || -z "${LASTB}" ]]; then warn "sauvegarde" "aucune copie — la nocturne tourne à 02:15 UTC, ou npm run backup"; elif [[ "${LASTB}" -le 48 ]]; then pass "sauvegarde" "$(j backups) copie(s), la plus récente il y a ${LASTB} h"; else warn "sauvegarde" "la plus récente il y a ${LASTB} h — au-delà de 48 h"; fi
    SEGS="$(j approvedSegments)"; DRAFTS="$(j approvedDrafts)"
    OUT_LC="$(printf '%s' "${OUTBOUND:-false}" | tr '[:upper:]' '[:lower:]')"
    case "${OUT_LC}" in true|1|yes|on) OPEN=1 ;; *) OPEN=0 ;; esac
    if [[ "${DRAFTS:-0}" -gt 0 || "${SEGS:-0}" -gt 0 ]]; then
      if [[ "${OPEN}" -eq 1 ]]; then warn "envois prêts" "${DRAFTS} brouillon(s) approuvé(s), ${SEGS} campagne(s) approuvée(s) — partiront à la prochaine fenêtre"; else pass "envois prêts" "${DRAFTS} brouillon(s), ${SEGS} campagne(s) approuvée(s) — retenus par ATLAS_OUTBOUND_ENABLED=false"; fi
    else pass "envois prêts" "aucun brouillon approuvé, aucune campagne approuvée"; fi
    pass "messages envoyés" "$(j sentTotal) depuis toujours (registre exactement-une-fois)"
    [[ "$(j pause)" == "true" ]] && warn "PAUSE ATLAS" "le coupe-circuit est posé" || pass "PAUSE ATLAS" "levé"
  else
    na "données" "impossible d’exécuter Node dans le conteneur atlas"
  fi
else
  na "données" "conteneur atlas indisponible"
fi

# ── Verdict ───────────────────────────────────────────────────────────────────
printf '\n%s' "$B"
if [[ "${FAILS}" -eq 0 && "${WARNS}" -eq 0 ]]; then printf 'VPS_OK'; elif [[ "${FAILS}" -eq 0 ]]; then printf 'VPS_OK_WITH_WARNINGS (%d)' "${WARNS}"; else printf 'VPS_ISSUES (%d FAIL, %d WARN)' "${FAILS}" "${WARNS}"; fi
printf '%s  %sce contrôle n’a rien modifié%s\n\n' "$N" "$D" "$N"
[[ "${FAILS}" -eq 0 ]]
