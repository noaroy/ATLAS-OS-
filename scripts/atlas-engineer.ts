/**
 * Le runner d'ingénierie isolé.
 *
 * Un daemon qui ne sert que les tâches d'ingénierie — CLAUDE (l'API, qui
 * propose des éditions qu'ATLAS écrit) et CLAUDE_CODE (le binaire, en mode
 * headless `-p`, facturé à la clé d'API) — sur un **clone jetable** du dépôt,
 * jamais sur le dépôt déployé. Chaque tâche ouvre son worktree, y travaille,
 * y teste ; le résultat est un diff en base, en attente d'une personne
 * (`atlas:apply`). Rien ici ne déploie.
 *
 * Ce que ce processus a : la base canonique (la file de tâches vit là), le
 * clone, la clé Anthropic. Ce qu'il n'a pas, et ne doit pas avoir : le
 * dépôt déployé en écriture, les identifiants Gmail, la clé OpenAI — les
 * revues tournent dans le daemon du serveur — et un port.
 *
 *   node --import tsx scripts/atlas-engineer.ts          # dans le service atlas-engineer
 *   npm run atlas:engineer -- --cycles=1                  # un tour, à la main
 */
import { createLogger, loadConfig } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import {
  AtlasDaemon, WorkerRegistry, ClaudeCodeWorker, ClaudeWorker, HermesRouter,
  createAiProviders, detectClaudeCode, detectClaudeCodeAuth, repoRootOf, inspectRepo, ENGINEER_HOST_LABEL,
} from '../packages/runtime/src/index.ts';

const flag = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const num = (name: string, fallback: number) => Number(flag(name) ?? fallback);

const logger = createLogger({ level: (flag('log') as 'debug' | 'info' | 'warn' | 'error') ?? 'info', pretty: true });
const config = loadConfig(process.cwd());
const repos = createRepositories(config.paths.databaseFile, logger);

const repoRoot = repoRootOf(config.engineering.repo || process.cwd());
if (!repoRoot) {
  logger.error('runner d’ingénierie : pas de dépôt git', { repo: config.engineering.repo || process.cwd() });
  repos.close();
  process.exit(2);
}
const availability = detectClaudeCode(config.engineering.claudeCodeBin);
const auth = detectClaudeCodeAuth(availability);
logger.info('runner d’ingénierie', {
  repo: repoRoot, head: inspectRepo(repoRoot).head.slice(0, 8), worktrees: config.engineering.workspaceRoot || '(temporaire)',
  claudeCode: availability.available ? availability.detail : availability.detail, auth: auth.detail, aiLive: config.ai.live,
});

const providers = createAiProviders({ config, logger, repos });
const registry = new WorkerRegistry()
  .register(new ClaudeWorker({
    repos, provider: providers.anthropic, timeoutMs: config.ai.claudeTimeoutMs, workspaceRoot: repoRoot,
    worktreeRoot: config.engineering.workspaceRoot || undefined, maxIterations: config.engineering.maxIterations,
    maxFilesChanged: config.engineering.maxFilesChanged, maxDiffLines: config.engineering.maxDiffLines, allowFileDelete: config.engineering.allowFileDelete,
  }))
  .register(new ClaudeCodeWorker({
    repos, logger, repoRoot, worktreeRoot: config.engineering.workspaceRoot || undefined,
    timeoutMs: config.engineering.claudeCodeTimeoutMs, maxFilesChanged: config.engineering.maxFilesChanged,
    maxDiffLines: config.engineering.maxDiffLines, binary: config.engineering.claudeCodeBin,
  }));

const hermes = new HermesRouter({
  repos, logger,
  limits: {
    maxDepth: config.ai.maxChainDepth, maxTasks: config.ai.maxTasksPerChain, maxCostUsd: config.ai.maxChainCostUsd,
    maxRuntimeMinutes: config.ai.maxChainRuntimeMinutes, unknownCostPolicy: config.ai.unknownCostPolicy,
  },
});

const daemon = new AtlasDaemon({
  repos, registry, logger, hermes,
  // Seulement l'ingénierie : les autres types restent au daemon du serveur.
  workerTypes: ['CLAUDE', 'CLAUDE_CODE'],
  owner: `${ENGINEER_HOST_LABEL}#${process.pid}`,
  hostLabel: ENGINEER_HOST_LABEL,
  leaseMs: num('lease', 60_000), heartbeatMs: num('heartbeat', 10_000), maxIdleMs: num('idle', 60_000),
  maxCycles: flag('cycles') ? num('cycles', 0) : undefined,
});

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    daemon.requestStop(`signal ${signal}`);
  });
}

try {
  const stats = await daemon.run();
  console.log(`\n  atlas-engineer : ${stats.cycles} tour(s) · ${stats.completed} terminée(s) · ${stats.failed} échec(s) · aucun déploiement · MESSAGES SENT: 0\n`);
} finally {
  repos.close();
}
