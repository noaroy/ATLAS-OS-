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
