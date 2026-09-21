# ─── Build stage ────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS build

WORKDIR /build

# Build tools are needed only if a prebuilt better-sqlite3 binary is unavailable
# for this platform; they are discarded with this stage either way.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Copy manifests first so dependency layers cache across source changes.
COPY package.json package-lock.json* ./
COPY packages/contracts/package.json  packages/contracts/
COPY packages/core/package.json       packages/core/
COPY packages/data/package.json       packages/data/
COPY packages/memory/package.json     packages/memory/
COPY packages/llm/package.json        packages/llm/
COPY packages/agents/package.json     packages/agents/
COPY packages/hermes/package.json     packages/hermes/
COPY packages/automation/package.json packages/automation/
COPY packages/evolution/package.json  packages/evolution/
COPY packages/runtime/package.json    packages/runtime/
COPY packages/server/package.json     packages/server/
COPY apps/console/package.json        apps/console/

RUN npm ci --no-audit --no-fund

COPY . .

RUN npm run build

# ─── CLI stage ──────────────────────────────────────────────────────────────
# Les outils ponctuels — client:mission, client:review, client:preflight,
# backup, restore-check, atlas:status — ont besoin du dépôt complet et de tsx,
# que l'image serveur, volontairement dist-only, ne porte pas. Cette image les
# porte, et rien d'autre : pas de serveur, pas de daemon, pas de healthcheck,
# pas de port. Même base, même utilisateur `node`, même /data que le serveur :
# lancée sur le même volume, elle ouvre la même base — jamais une seconde.
#
# Elle précède `runtime` dans le fichier : l'étape finale reste l'image
# serveur, celle qu'un build sans --target produit.
#
#   docker build --target cli -t atlas-os-cli:1.0.0 -f deployment/Dockerfile .
#   docker compose … build atlas-cli
FROM node:24-bookworm-slim AS cli

RUN apt-get update  && apt-get install -y --no-install-recommends tini ca-certificates  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# Le dépôt tel que `build` l'a installé — sources, scripts, briefs, node_modules
# avec tsx — copié pièce par pièce : ni .env, ni data/, ni dist, ni bundle.
COPY --from=build /build/package.json /build/package-lock.json* /build/tsconfig.json ./
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/packages ./packages
COPY --from=build /build/scripts ./scripts
COPY --from=build /build/briefs ./briefs
# Les artefacts de déploiement et le guide opérateur : production-check lit
# ce qui déploie vraiment (Compose, Dockerfile, OPERATOR.md) pour rendre son
# verdict. Le fichier privé et les rapports de déploiement restent dehors.
COPY --from=build /build/deployment ./deployment
COPY --from=build /build/docs ./docs

# /data est le volume partagé ; out/ reçoit les rapports (monté depuis l'hôte).
RUN mkdir -p /data/artifacts /data/backups /app/out && chown -R node:node /data /app
ENV ATLAS_DATA_DIR=/data ATLAS_BACKUP_DIR=/data/backups ATLAS_CLI_CONTEXT=docker

USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
# Sans commande : l'état, en lecture. Jamais un processus qui reste.
CMD ["npm", "run", "atlas:status"]

# ─── Engineer stage ─────────────────────────────────────────────────────────
# Le runner d'ingénierie isolé (service `atlas-engineer`, profil `engineering`).
#
# L'image outils, plus ce que l'ingénierie autonome exige et que ni le serveur
# ni les outils ne doivent porter : git, et le binaire Claude Code. Le dépôt
# déployé lui est monté en lecture seule (/host-repo) ; il en tire un clone
# jetable (/work/repo) et y ouvre un worktree par tâche (/work/worktrees).
# Aucun port, aucun serveur, aucun .env : Compose ne lui transmet que les
# variables de sa liste. Il ne déploie rien — un diff en base, en attente
# d'une personne, est tout ce qu'il produit.
#
#   docker compose … --profile engineering up -d --build atlas-engineer
FROM cli AS engineer

USER root
RUN apt-get update  && apt-get install -y --no-install-recommends git  && rm -rf /var/lib/apt/lists/*  && npm install -g @anthropic-ai/claude-code --no-audit --no-fund  && npm cache clean --force  && mkdir -p /work/worktrees /home/node/.claude  && chown -R node:node /work /home/node/.claude

# Le point d'entrée est déjà là (l'étape outils copie deployment/) ; seul le
# bit d'exécution, perdu d'un poste Windows, est rétabli.
RUN chmod 0755 /app/deployment/engineer-entrypoint.sh

ENV ATLAS_ENGINEER_REPO=/work/repo     ATLAS_ENGINEERING_WORKSPACE_ROOT=/work/worktrees     ATLAS_HOST_REPO=/host-repo     HOME=/home/node

USER node

ENTRYPOINT ["/usr/bin/tini", "--", "/app/deployment/engineer-entrypoint.sh"]
CMD []

# ─── Runtime stage ──────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime

# tini gives us correct signal forwarding, so SIGTERM reaches ATLAS and the
# graceful shutdown (final backup, WAL checkpoint) actually runs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# Only production dependencies; better-sqlite3's native binding is copied
# from the build stage so no compiler is needed at runtime.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /build/dist ./dist

# The data directory is a volume — never bake state into the image.
RUN mkdir -p /data/artifacts /data/backups && chown -R node:node /data /app
ENV ATLAS_DATA_DIR=/data ATLAS_BACKUP_DIR=/data/backups

USER node
EXPOSE 4700

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ATLAS_PORT||4700)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/atlas.mjs"]
