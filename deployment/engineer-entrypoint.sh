#!/bin/sh
# Le runner d'ingénierie isolé : un clone jetable, jamais le dépôt déployé.
#
# /host-repo   le dépôt déployé, monté en lecture seule — on ne fait que le lire
# /work/repo   le clone jetable sur lequel les worktrees s'ouvrent
# /work/worktrees  un worktree par tâche, retiré avec elle
#
# À chaque démarrage, le clone est ramené au dernier commit du dépôt déployé :
# un worktree part toujours de ce qui tourne, jamais d'un état intermédiaire.
# Les dépendances du clone sont celles de l'image (/app/node_modules), liées
# dans chaque worktree par le runner — aucune installation réseau ici.
set -eu

HOST_REPO="${ATLAS_HOST_REPO:-/host-repo}"
REPO="${ATLAS_ENGINEER_REPO:-/work/repo}"
WORKTREES="${ATLAS_ENGINEERING_WORKSPACE_ROOT:-/work/worktrees}"

if [ ! -d "${HOST_REPO}/.git" ]; then
  echo "atlas-engineer : ${HOST_REPO} n'est pas un dépôt git (monter le dépôt déployé en lecture seule)" >&2
  exit 2
fi

# Le dépôt déployé appartient à un autre utilisateur que `node` : git refuse
# de le lire sans qu'on le lui dise. Lecture seule, rien d'autre n'est permis.
git config --global --add safe.directory "${HOST_REPO}"

mkdir -p "${WORKTREES}"
if [ ! -d "${REPO}/.git" ]; then
  echo "atlas-engineer : clone jetable de ${HOST_REPO} → ${REPO}"
  git clone --quiet --no-hardlinks "${HOST_REPO}" "${REPO}"
else
  # Le HEAD du dépôt déployé — branche ou tag détaché, peu importe : c'est
  # le commit qui tourne. Les worktrees ouverts par une tâche encore en cours
  # ne sont pas touchés ; ceux qui n'existent plus sont oubliés.
  echo "atlas-engineer : mise à jour du clone jetable depuis ${HOST_REPO}"
  git -C "${REPO}" worktree prune
  git -C "${REPO}" fetch --quiet origin HEAD
  git -C "${REPO}" reset --quiet --hard FETCH_HEAD
fi
git -C "${REPO}" config user.email "atlas-engineer@atlas.local"
git -C "${REPO}" config user.name "ATLAS engineer"

# Les dépendances : celles de l'image, visibles depuis le clone.
if [ ! -e "${REPO}/node_modules" ] && [ -d /app/node_modules ]; then
  ln -s /app/node_modules "${REPO}/node_modules"
fi

echo "atlas-engineer : dépôt ${REPO} @ $(git -C "${REPO}" rev-parse --short HEAD) · worktrees ${WORKTREES}"
exec node --import tsx /app/scripts/atlas-engineer.ts "$@"
