#!/usr/bin/env bash
#
# ATLAS OS — les outils, dans le conteneur, sur la base canonique.
#
#   ./deployment/atlas-cli.sh client-mission start --brief=briefs/internal-test-sweden.json
#   ./deployment/atlas-cli.sh client-mission batch --run=msn_… --size=20 --queries=8 --budget=0.30 --batch-budget=0.30 --concurrency=4 --go
#   ./deployment/atlas-cli.sh client-mission status --run=msn_…
#   ./deployment/atlas-cli.sh client-review --run=msn_…
#   ./deployment/atlas-cli.sh client-preflight --brief=briefs/internal-test-sweden.json
#   ./deployment/atlas-cli.sh backup | restore-check | daemon-check | atlas-status | production-check
#   ./deployment/atlas-cli.sh gmail-check | gmail-read-check                # Gmail en lecture seule, rien n'est envoyé
#   ./deployment/atlas-cli.sh inbox-initial-sync                             # premier import : conversations depuis le registre, puis lecture de la boîte
#   ./deployment/atlas-cli.sh sales-inbox [sync|record …] | inbox-sync       # la boîte commerciale ; la lecture Gmail seule (rejouable, sans trou)
#   ./deployment/atlas-cli.sh send-approved --file=out/lot.json [--send]  # envoi manuel approuvé ; en INTERNAL_TEST, vers GMAIL_USER seulement, confirmé [o/N]
#   ./deployment/atlas-cli.sh autopilot-once | autopilot-status | autopilot-queue | autopilot-report   # la boucle de contrôle : un cycle, l'état, la file, les cycles
#   ./deployment/atlas-cli.sh autopilot pause "motif" | resume | decide <id> done|reject
#   ./deployment/atlas-cli.sh npm run client:status          # une commande npm brute
#   ./deployment/atlas-cli.sh --shell                        # un shell dans le conteneur
#   ./deployment/atlas-cli.sh --build                        # construire l'image outils (une fois par version)
#   ./deployment/atlas-cli.sh --print <commande…>            # afficher la commande Docker, sans l'exécuter
#
# Ce que fait le wrapper, et rien d'autre : il retrouve le dépôt, résout la
# commande Compose du déploiement (--env-file, base, override, private), vérifie
# que le volume de données existe — sinon Compose en créerait un vide, et une
# base neuve avec — puis lance `docker compose … run --rm atlas-cli <commande>`.
# Aucun port publié, aucun daemon, aucun redémarrage ; le conteneur meurt avec
# la commande. Le .env est transmis par Compose, jamais lu ni affiché ici.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
. "${SCRIPT_DIR}/compose-env.sh"

SERVICE="${ATLAS_CLI_SERVICE:-atlas-cli}"
IMAGE="${ATLAS_CLI_IMAGE:-atlas-os-cli:1.0.0}"

die() { printf 'atlas-cli : %s\n' "$*" >&2; exit 2; }
usage() { sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# ── La commande demandée → la commande npm ────────────────────────────────────
# Une liste fermée : ce wrapper ne devine pas. `npm`, `node`, `sh`, `bash`
# passent tels quels pour ce qui n'y figure pas.
npm_script_of() {
  case "$1" in
    client-mission)   printf 'client:mission' ;;
    client-review)    printf 'client:review' ;;
    client-preflight) printf 'client:preflight' ;;
    client-report)    printf 'client:report' ;;
    client-status)    printf 'client:status' ;;
    client-auto)      printf 'client:auto' ;;
    client-dryrun)    printf 'client:dryrun' ;;
    client-pause)     printf 'client:pause' ;;
    atlas-status)     printf 'atlas:status' ;;
    atlas-report)     printf 'atlas:report' ;;
    production-check) printf 'atlas:production-check' ;;
    backup)           printf 'backup' ;;
    restore-check)    printf 'restore-check' ;;
    daemon-check)     printf 'atlas:daemon-check' ;;
    db-check)         printf 'db:check' ;;
    sales-status)     printf 'sales:status' ;;
    gmail-check)      printf 'gmail:check' ;;
    gmail-read-check) printf 'gmail:read-check' ;;
    sales-inbox)      printf 'sales:inbox' ;;
    inbox-sync)       printf 'sales:inbox-sync' ;;
    send-approved)    printf 'sales:send-approved' ;;
    autopilot)        printf 'autopilot' ;;
    autopilot-once)   printf 'autopilot:once' ;;
    autopilot-status) printf 'autopilot:status' ;;
    autopilot-queue)  printf 'autopilot:queue' ;;
    autopilot-report) printf 'autopilot:report' ;;
    *) return 1 ;;
  esac
}

build_container_command() {
  # Rend, sur stdout, un mot par ligne : la commande à exécuter dans le conteneur.
  local first="$1"; shift
  local script
  # Le premier import Gmail, en deux temps dans un seul conteneur : ouvrir une
  # conversation par entreprise contactée (registre d'outreach), puis lire la
  # boîte et rattacher les réponses. Rejouable : les deux étapes sont idempotentes.
  if [[ "${first}" == "inbox-initial-sync" ]]; then
    printf '%s
' sh -c 'npm run sales:inbox -- sync && npm run sales:inbox-sync'
    return 0
  fi
  if script="$(npm_script_of "${first}")"; then
    printf '%s\n' npm run "${script}"
    if [[ $# -gt 0 ]]; then printf '%s\n' -- "$@"; fi
  else
    case "${first}" in
      npm|node|npx|sh|bash) printf '%s\n' "${first}" "$@" ;;
      *) die "commande inconnue : ${first} (voir --help)" ;;
    esac
  fi
}

# ── Les modes ─────────────────────────────────────────────────────────────────
MODE=run
case "${1:-}" in
  ''|-h|--help) usage; exit 0 ;;
  --compose-command) compose_command_text; exit 0 ;;
  --print) MODE=print; shift ;;
  --build) MODE=build; shift ;;
  --shell) MODE=shell; shift ;;
esac

# ── Les préalables — clairs, jamais silencieux ────────────────────────────────
preflight() {
  command -v docker >/dev/null 2>&1 || die "docker absent sur cet hôte"
  docker compose version >/dev/null 2>&1 || die "le plugin docker compose est absent"
  [[ -n "${COMPOSE_FILE}" && -f "${COMPOSE_FILE}" ]] || die "aucun fichier Compose trouvé dans ${COMPOSE_DIR} (ATLAS_COMPOSE_DIR / ATLAS_COMPOSE_FILES)"
  [[ -f "${ENV_FILE}" ]] || die "${ENV_FILE} introuvable : le .env du déploiement est requis (ATLAS_ENV_FILE pour un autre chemin)"
  docker info >/dev/null 2>&1 || die "le démon Docker ne répond pas (droits ? service arrêté ?)"
  if [[ "${MODE}" != "build" ]]; then
    # Le volume DOIT préexister : `run` sur un volume absent en créerait un vide,
    # et ATLAS y ouvrirait une base neuve — exactement ce qu'on interdit.
    docker volume inspect "${ATLAS_DATA_VOLUME}" >/dev/null 2>&1 \
      || die "volume ${ATLAS_DATA_VOLUME} introuvable : ATLAS n'est pas déployé ici (ou sous un autre projet : ATLAS_COMPOSE_PROJECT). Ce wrapper ne crée jamais de base."
    docker image inspect "${IMAGE}" >/dev/null 2>&1 \
      || die "image ${IMAGE} absente : construisez-la une fois avec ./deployment/atlas-cli.sh --build"
  fi
  # Les rapports s'écrivent dans out/ sur l'hôte, par l'utilisateur `node`
  # (uid 1000) du conteneur. Le dossier est créé ici, jamais « chowné » : si
  # node ne peut pas y écrire, on le dit, et l'opérateur décide.
  mkdir -p "${ROOT_DIR}/out" 2>/dev/null || true
  if [[ -d "${ROOT_DIR}/out" ]]; then
    local uid perms
    uid="$(stat -c '%u' "${ROOT_DIR}/out" 2>/dev/null || echo '?')"
    perms="$(stat -c '%a' "${ROOT_DIR}/out" 2>/dev/null || echo '?')"
    if [[ "${uid}" != "1000" && "${perms}" != *7 ]]; then
      printf 'atlas-cli : avertissement — %s/out appartient à uid %s (droits %s) : l’utilisateur node (uid 1000) du conteneur ne pourra pas y écrire les rapports. Une fois : chown 1000 %s/out\n' "${ROOT_DIR}" "${uid}" "${perms}" "${ROOT_DIR}" >&2
    fi
  fi
}

if [[ "${MODE}" == "build" ]]; then
  preflight
  printf 'atlas-cli : construction de %s (étape cli du Dockerfile)\n' "${IMAGE}" >&2
  exec docker compose "${COMPOSE_ARGS[@]}" build "${SERVICE}"
fi

# Sans terminal (cron, script) : pas de TTY demandé, sinon Compose refuse.
TTY_ARGS=()
[[ -t 0 && -t 1 ]] || TTY_ARGS=(-T)

if [[ "${MODE}" == "shell" ]]; then
  CONTAINER_CMD=(bash)
else
  [[ $# -gt 0 ]] || { usage; exit 2; }
  # Le premier mot est validé ici, dans le processus principal : un `die`
  # dans une substitution ne sortirait que de la substitution.
  npm_script_of "$1" >/dev/null || case "$1" in npm|node|npx|sh|bash|inbox-initial-sync) ;; *) die "commande inconnue : $1 (voir --help)" ;; esac
  mapfile -t CONTAINER_CMD < <(build_container_command "$@")
  [[ ${#CONTAINER_CMD[@]} -gt 0 ]] || die "commande vide"
fi

# `run --rm` : un conteneur par commande, supprimé à la fin ; pas de
# --service-ports, donc aucun port ; le profil `cli` s'active de lui-même
# parce que le service est nommé.
DOCKER_CMD=(docker compose "${COMPOSE_ARGS[@]}" run --rm "${TTY_ARGS[@]+"${TTY_ARGS[@]}"}" "${SERVICE}" "${CONTAINER_CMD[@]}")

if [[ "${MODE}" == "print" ]]; then
  printf '%q ' "${DOCKER_CMD[@]}"; printf '\n'
  exit 0
fi

preflight
exec "${DOCKER_CMD[@]}"
