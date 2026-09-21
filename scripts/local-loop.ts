/**
 * La boucle locale : un objectif, jusqu'à résolution ou plafond.
 *
 * Elle n'invente rien : une tâche ENGINEERING_CHANGE posée dans la file
 * existante, servie par le même daemon et les mêmes garde-fous que la
 * production (worktree isolé, chemins autorisés vérifiés, budget de diff,
 * tests) — juste bornée à cet objectif précis et rendue au terminal au lieu
 * d'être laissée à un daemon qui tourne indéfiniment. La logique elle-même vit
 * dans `runLocalObjectiveLoop` (`packages/runtime/src/local-loop.ts`) — ce
 * script n'est qu'un habillage CLI, pour que la boucle maîtresse puisse
 * l'appeler directement, sans sous-processus.
 *
 * Rien n'est appliqué au dépôt principal : un diff prêt attend une décision
 * humaine.
 *
 *   npm run local:loop -- --objective="..." --paths=packages/foo,packages/bar \
 *     [--test="npm test"] [--test="npm run typecheck"] [--acceptance="..."] \
 *     [--priority=80] [--max-cycles=40] [--max-wall-minutes=30]
 */
import { createLogger, loadConfig, loadAtlasEnv } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import { createWorkerRegistry, runLocalObjectiveLoop } from '../packages/runtime/src/index.ts';

loadAtlasEnv();

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', amber: '\x1b[33m', cyan: '\x1b[36m',
};
const flag = (name: string): string | null =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const flags = (name: string): string[] =>
  process.argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));

const objective = flag('objective');
const pathsArg = flag('paths');
if (!objective || !pathsArg) {
  console.error('usage: local:loop -- --objective="..." --paths=packages/foo,packages/bar [--test="npm test"]... [--acceptance="..."] [--priority=80] [--max-cycles=40] [--max-wall-minutes=30]');
  process.exit(1);
}
const allowedPaths = pathsArg.split(',').map((p) => p.trim()).filter(Boolean);
const testCommands = flags('test');

const config = loadConfig(process.cwd());
const logger = createLogger({ level: 'info', pretty: true });
const repos = createRepositories(config.paths.databaseFile, logger);

const { registry, live } = createWorkerRegistry({ config, logger, repos, workspaceRoot: process.cwd() });
logger.info(live ? 'appels réels : cette boucle sera facturée' : 'mode figé : ATLAS_AI_LIVE=false, aucun appel payant', {});

let manualStop = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { manualStop = true; });
}

try {
  console.log(`\n  ${c.bold}BOUCLE LOCALE${c.reset}`);
  console.log(`  objectif : ${objective}`);
  console.log(`  chemins  : ${allowedPaths.join(', ')}${testCommands.length ? `\n  tests    : ${testCommands.join(' · ')}` : ''}\n`);

  let report;
  try {
    report = await runLocalObjectiveLoop(
      { repos, registry, logger },
      {
        objective, allowedPaths, testCommands,
        acceptanceCriteria: flag('acceptance') ?? undefined,
        priority: Number(flag('priority') ?? 80),
        maxAttempts: Number(flag('max-attempts') ?? 2),
        maxCycles: Number(flag('max-cycles') ?? 40),
        maxWallMs: Number(flag('max-wall-minutes') ?? 30) * 60_000,
        shouldStop: () => manualStop,
      },
    );
  } catch (error) {
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  console.log(`\n  ${c.bold}RÉSULTAT${c.reset}  tâche ${report.taskId} · ${report.cyclesUsed} tour(s)`);
  const tint = report.verdict.status === 'DONE' ? c.green : report.verdict.status === 'BLOCKED' ? c.red : c.amber;
  console.log(`  état  : ${tint}${report.verdict.status}${c.reset} — ${report.verdict.reason}`);
  if (report.verdict.costUsd !== null) console.log(`  coût  : ${report.verdict.costUsd.toFixed(4)} $`);

  if (report.workspace && (report.workspace.state === 'READY_FOR_REVIEW' || report.workspace.state === 'APPROVED_TO_APPLY')) {
    console.log(`\n  diff prêt (${report.workspace.state}) — ${report.workspace.filesChanged} fichier(s), ${report.workspace.diffLines} ligne(s)`);
    console.log(`  npm run atlas:task -- show ${report.taskId}`);
    console.log(`  npm run atlas:apply -- list          # relecture puis application, geste humain`);
  } else if (report.stopped !== 'RESOLVED') {
    console.log(`\n  non résolu dans les bornes de ce lancement (${{ MAX_CYCLES: 'plafond de tours atteint', MAX_WALL_MS: 'délai atteint', MANUAL_STOP: 'arrêt demandé' }[report.stopped]}) — relancer la même commande reprend là où c'est resté :`);
    console.log(`  npm run local:loop -- --objective="${objective}" --paths=${pathsArg}${testCommands.map((t) => ` --test="${t}"`).join('')}`);
  }
  console.log(`\n  Rien n'est appliqué au dépôt principal. MESSAGES SENT: 0\n`);
} finally {
  repos.close();
}
