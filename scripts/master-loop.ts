/**
 * La boucle maîtresse : Claude ↔ GPT décident, la boucle locale exécute.
 *
 * Un cycle : le binôme (collab:loop, en mode décision) lit l'objectif et ce
 * que les cycles précédents ont réellement produit, puis converge soit sur
 * « objectif atteint », soit sur une action précise et bornée. Cette action
 * est confiée telle quelle à la boucle locale (local:loop) — worktree isolé,
 * mêmes garde-fous. Le résultat réel (diff, tests, erreurs) redevient le
 * contexte du cycle suivant. Rien de nouveau n'est exécuté que ce que les deux
 * boucles savaient déjà faire séparément.
 *
 * Arrêt : objectif atteint, diff prêt (READY_FOR_HUMAN_DEPLOYMENT), blocage de
 * sécurité ou de budget, ou l'un des plafonds (cycles, coût, temps).
 *
 *   npm run master:loop -- --objective="..." [--context="..."] \
 *     [--max-cycles=5] [--max-cost=3] [--max-wall-minutes=45] \
 *     [--collab-rounds=2] [--local-cycles=20] [--local-wall-minutes=10] [--local-max-attempts=2]
 */
import { createLogger, loadConfig, loadAtlasEnv } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import { createAiProviders, createWorkerRegistry, runMasterLoop } from '../packages/runtime/src/index.ts';

loadAtlasEnv();

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', amber: '\x1b[33m', cyan: '\x1b[36m',
};
const flag = (name: string): string | null =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const objective = flag('objective');
if (!objective) {
  console.error('usage: master:loop -- --objective="..." [--context="..."] [--max-cycles=5] [--max-cost=3] [--max-wall-minutes=45]');
  process.exit(1);
}

const config = loadConfig(process.cwd());
const logger = createLogger({ level: 'info', pretty: true });
const repos = createRepositories(config.paths.databaseFile, logger);

const { openai, anthropic, live: liveCollab } = createAiProviders({ config, logger, repos });
const { registry, live: liveEngineering } = createWorkerRegistry({ config, logger, repos, workspaceRoot: process.cwd() });
logger.info((liveCollab || liveEngineering) ? 'appels réels : cette boucle sera facturée' : 'mode figé : ATLAS_AI_LIVE=false, aucun appel payant', {});

let manualStop = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { manualStop = true; });
}

const STATUS_TINT: Record<string, string> = {
  OBJECTIVE_REACHED: c.green, READY_FOR_HUMAN_DEPLOYMENT: c.amber, BLOCKED: c.red, BOUNDS_EXHAUSTED: c.amber,
};

try {
  console.log(`\n  ${c.bold}BOUCLE MAÎTRESSE${c.reset}\n  objectif : ${objective}\n`);

  const report = await runMasterLoop(
    { repos, config, providers: { anthropic, openai }, registry, logger },
    {
      objective,
      context: flag('context') ?? undefined,
      maxCycles: flag('max-cycles') ? Number(flag('max-cycles')) : undefined,
      maxCostUsd: flag('max-cost') ? Number(flag('max-cost')) : undefined,
      maxWallMs: flag('max-wall-minutes') ? Number(flag('max-wall-minutes')) * 60_000 : undefined,
      collabMaxRoundsPerCycle: flag('collab-rounds') ? Number(flag('collab-rounds')) : undefined,
      localMaxCyclesPerAction: flag('local-cycles') ? Number(flag('local-cycles')) : undefined,
      localMaxWallMsPerAction: flag('local-wall-minutes') ? Number(flag('local-wall-minutes')) * 60_000 : undefined,
      localMaxAttempts: flag('local-max-attempts') ? Number(flag('local-max-attempts')) : undefined,
      shouldStop: () => manualStop,
    },
  );

  for (const rec of report.cycles) {
    console.log(`  ${c.bold}Cycle ${rec.cycle}${c.reset} — dialogue : ${rec.collab.turns.length} tour(s), ${rec.collab.converged ? 'convergé' : 'non convergé'} (${rec.collab.stoppedReason})`);
    if (!rec.decision) {
      console.log(`    ${c.dim}aucune décision exploitable ce cycle${c.reset}`);
    } else if (rec.decision.objectiveReached) {
      console.log(`    ${c.green}objectif déclaré atteint${c.reset} — ${rec.decision.reason}`);
    } else {
      console.log(`    action décidée : ${rec.decision.actionObjective}`);
      console.log(`    ${c.dim}chemins : ${rec.decision.allowedPaths.join(', ')}${rec.decision.testCommands.length ? ` · tests : ${rec.decision.testCommands.join(' · ')}` : ''}${c.reset}`);
    }
    if (rec.execution) {
      console.log(`    exécution : ${rec.execution.verdict.status} — ${rec.execution.verdict.reason} (tâche ${rec.execution.taskId})`);
    }
    console.log();
  }

  console.log(`  ${c.bold}RÉSULTAT${c.reset}  ${STATUS_TINT[report.finalStatus] ?? ''}${report.finalStatus}${c.reset} — ${report.reason}`);
  console.log(`  ${report.cycles.length} cycle(s) · coût total : ${report.totalCostUsd.toFixed(4)} $`);

  const lastExecution = [...report.cycles].reverse().find((c2) => c2.execution)?.execution;
  if (lastExecution?.workspace && (lastExecution.workspace.state === 'READY_FOR_REVIEW' || lastExecution.workspace.state === 'APPROVED_TO_APPLY')) {
    console.log(`\n  diff prêt (${lastExecution.workspace.state}) — ${lastExecution.workspace.filesChanged} fichier(s), ${lastExecution.workspace.diffLines} ligne(s)`);
    console.log(`  npm run atlas:task -- show ${lastExecution.taskId}`);
    console.log(`  npm run atlas:apply -- list          # relecture puis application, geste humain`);
  }
  console.log(`\n  Rien n'est appliqué au dépôt principal, aucun envoi, aucun déploiement. MESSAGES SENT: 0\n`);
} finally {
  repos.close();
}
