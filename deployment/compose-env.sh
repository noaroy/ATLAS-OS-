# ATLAS OS — la commande Compose du déploiement, résolue une seule fois.
#
# À sourcer, jamais à exécuter :
#
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   . "${SCRIPT_DIR}/compose-env.sh"
#
# Le déploiement réel lance Compose avec un --env-file et plusieurs fichiers :
# la base du dépôt, un éventuel override, et `docker-compose.private.yml`,
# propre au serveur (liaisons 127.0.0.1) et jamais versionné. Tout outil qui
# parle à Compose doit lui parler avec les mêmes fichiers — sinon Compose
# refuse en silence et l'outil conclut « absent » devant des conteneurs sains.
#
#   ATLAS_COMPOSE_FILES   liste de fichiers séparés par « : » (impose la liste)
#   ATLAS_COMPOSE_FILE    un seul fichier (compatibilité)
#   ATLAS_COMPOSE_DIR     où chercher base/override/private (défaut : deployment/)
#   ATLAS_COMPOSE_PROJECT le projet (défaut : atlas-os)
#   ATLAS_ENV_FILE        le .env passé en --env-file (défaut : <dépôt>/.env)
#
# Rend : COMPOSE_FILES (tableau), COMPOSE_ARGS (tableau), COMPOSE_FILE (le
# premier), PROJECT, ENV_FILE, COMPOSE_DIR, ROOT_DIR ; et deux fonctions,
# `compose` (docker compose avec les bons arguments) et `compose_command_text`
# (la commande, pour l'afficher). Aucune valeur du .env n'est lue ici.

SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
ROOT_DIR="${ROOT_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
COMPOSE_DIR="${ATLAS_COMPOSE_DIR:-${SCRIPT_DIR}}"
PROJECT="${ATLAS_COMPOSE_PROJECT:-atlas-os}"
ENV_FILE="${ATLAS_ENV_FILE:-${ROOT_DIR}/.env}"

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

# Le volume de données du projet, tel que Compose le nomme : <projet>_<volume>.
# C'est lui, et lui seul, qui porte la base canonique.
ATLAS_DATA_VOLUME="${ATLAS_DATA_VOLUME:-${PROJECT}_atlas-data}"
