#!/usr/bin/env bash
#
# ATLAS OS — retour en arrière après un déploiement raté.
#
#   sudo bash deployment/rollback.sh deployment/backups/20260812-070000
#
# Remet la configuration et, si vous le demandez explicitement, les données.
# Ne supprime jamais un volume : il est renommé, jamais détruit — un retour en
# arrière qui efface est un retour sans retour.

set -Eeuo pipefail

BACKUP_DIR="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"
PROJECT="atlas-os"

[[ -n "${BACKUP_DIR}" ]] || { echo "Usage : bash deployment/rollback.sh <répertoire-de-sauvegarde>"; exit 1; }
[[ -d "${BACKUP_DIR}" ]] || { echo "Sauvegarde introuvable : ${BACKUP_DIR}"; exit 1; }

echo "Retour en arrière depuis ${BACKUP_DIR}"

# 1. Arrêter les services. `stop` et non `down` : les conteneurs et les réseaux
#    restent, et surtout aucun volume n'est touché.
docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" stop || true
echo "  ✓ services arrêtés (volumes intacts)"

# 2. Restaurer la configuration.
if [[ -f "${BACKUP_DIR}/.env" ]]; then
  install -m 0600 "${BACKUP_DIR}/.env" "${ROOT_DIR}/.env"
  echo "  ✓ .env restauré"
fi
if [[ -f "${BACKUP_DIR}/docker-compose.yml" ]]; then
  cp "${BACKUP_DIR}/docker-compose.yml" "${COMPOSE_FILE}"
  echo "  ✓ docker-compose.yml restauré"
fi

# 3. Les données ne sont restaurées que sur demande explicite : dans la plupart
#    des cas le volume en place est plus récent que la sauvegarde, et l'écraser
#    ferait perdre le travail des dernières heures.
if [[ -f "${BACKUP_DIR}/atlas-data.tgz" ]]; then
  if [[ "${2:-}" == "--restore-data" ]]; then
    ASIDE="${PROJECT}_atlas-data-avant-rollback-$(date +%Y%m%d-%H%M%S)"
    echo "  Le volume actuel est mis de côté sous ${ASIDE} — rien n'est supprimé."
    docker volume create "${ASIDE}" >/dev/null
    docker run --rm -v "${PROJECT}_atlas-data:/from:ro" -v "${ASIDE}:/to" alpine:3 \
      sh -c 'cd /from && cp -a . /to/' >/dev/null
    docker run --rm -v "${PROJECT}_atlas-data:/data" -v "${BACKUP_DIR}:/backup:ro" alpine:3 \
      sh -c 'rm -rf /data/* /data/..?* 2>/dev/null; tar xzf /backup/atlas-data.tgz -C /data'
    echo "  ✓ données restaurées (copie de l'état précédent conservée dans ${ASIDE})"
  else
    echo "  · données NON restaurées — ajoutez --restore-data si vous le voulez vraiment"
    echo "    (le volume actuel est probablement plus récent que la sauvegarde)"
  fi
fi

# 4. Redémarrer.
docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" up -d
echo "  ✓ services redémarrés"
echo
echo "État :"
docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" ps
