/**
 * La boucle locale : un objectif, jusqu'à résolution ou plafond.
 *
 * Elle n'invente rien : une tâche ENGINEERING_CHANGE posée dans la file
 * existante, servie par le même daemon et les mêmes garde-fous que la
 * production (worktree isolé, chemins autorisés vérifiés, budget de diff,
 * tests) — juste bornée à cet objectif précis et rendue au terminal au lieu
 * d'être laissée à un daemon qui tourne indéfiniment. Après chaque tour, l'état
 * de la tâche est relu ; la boucle s'arrête dès qu'il devient terminal, ou aux
 * plafonds (tours, minutes).
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
import { AtlasDaemon, createWorkerRegistry, verdictFromTasks, checkCommand } from '../packages/runtime/src/index.ts';

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
for (const command of testCommands) {
  const verdict = checkCommand(command);
  if (!verdict.allowed) {
    console.error(`  commande de test refusée : ${verdict.reason}`);
    process.exit(1);
  }
}

const config = loadConfig(process.cwd());
const logger = createLogger({ level: 'info', pretty: true });
const repos = createRepositories(config.paths.databaseFile, logger);

const { registry, live } = createWorkerRegistry({ config, logger, repos, workspaceRoot: process.cwd() });
logger.info(live ? 'appels réels : cette boucle sera facturée' : 'mode figé : ATLAS_AI_LIVE=false, aucun appel payant', {});

const created = repos.tasks.create({
  taskType: 'ENGINEERING_CHANGE',
  department: 'ENGINEERING',
  workerType: 'CLAUDE',
  priority: Number(flag('priority') ?? 80),
  maxAttempts: Number(flag('max-attempts') ?? 2),
  payload: {
    objective,
    allowed_paths: allowedPaths,
    test_commands: testCommands,
    ...(flag('acceptance') ? { acceptance_criteria: flag('acceptance') } : {}),
  },
});
console.log(`\n  ${c.bold}BOUCLE LOCALE${c.reset}  tâche ${created.task.taskId} ${created.created ? 'créée' : 'réutilisée (même clé)'} — ${created.task.status}`);
console.log(`  objectif : ${objective}`);
console.log(`  chemins  : ${allowedPaths.join(', ')}${testCommands.length ? `\n  tests    : ${testCommands.join(' · ')}` : ''}\n`);

const maxCyclesTotal = Number(flag('max-cycles') ?? 40);
const maxWallMinutes = Number(flag('max-wall-minutes') ?? 30);
const deadlineAt = Date.now() + maxWallMinutes * 60_000;

let currentDaemon: AtlasDaemon | null = null;
let manualStop = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    manualStop = true;
    currentDaemon?.requestStop(`signal ${signal}`);
  });
}

let cyclesUsed = 0;
let lastVerdict = verdictFromTasks(repos, repos.tasks.byId(created.task.taskId)!);
const TERMINAL = new Set(['DONE', 'WAITING_HUMAN', 'BLOCKED']);

try {
  while (cyclesUsed < maxCyclesTotal && Date.now() < deadlineAt && !manualStop && !TERMINAL.has(lastVerdict.status)) {
    currentDaemon = new AtlasDaemon({
      repos, registry, logger, owner: 'local-loop',
      workerTypes: ['CLAUDE'], maxCycles: 1, maxIdleMs: 3_000,
    });
    const stats = await currentDaemon.run();
    cyclesUsed += stats.cycles;
    lastVerdict = verdictFromTasks(repos, repos.tasks.byId(created.task.taskId)!);
    console.log(`  ${c.dim}tour ${cyclesUsed} · ${lastVerdict.status} · ${lastVerdict.reason}${c.reset}`);
  }

  const task = repos.tasks.byId(created.task.taskId)!;
  console.log(`\n  ${c.bold}RÉSULTAT${c.reset}  ${cyclesUsed} tour(s)`);
  const tint = lastVerdict.status === 'DONE' ? c.green : lastVerdict.status === 'BLOCKED' ? c.red : c.amber;
  console.log(`  état  : ${tint}${lastVerdict.status}${c.reset} — ${lastVerdict.reason}`);
  if (lastVerdict.costUsd !== null) console.log(`  coût  : ${lastVerdict.costUsd.toFixed(4)} $`);

  const workspace = repos.tasks.workspaceFor(task.taskId);
  if (workspace && (workspace.state === 'READY_FOR_REVIEW' || workspace.state === 'APPROVED_TO_APPLY')) {
    console.log(`\n  diff prêt (${workspace.state}) — ${workspace.filesChanged} fichier(s), ${workspace.diffLines} ligne(s)`);
    console.log(`  npm run atlas:task -- show ${task.taskId}`);
    console.log(`  npm run atlas:apply -- list          # relecture puis application, geste humain`);
  } else if (!TERMINAL.has(lastVerdict.status)) {
    console.log(`\n  non résolu dans les bornes de ce lancement (${manualStop ? 'arrêt demandé' : Date.now() >= deadlineAt ? 'délai atteint' : 'plafond de tours atteint'}) — relancer la même commande reprend là où c'est resté :`);
    console.log(`  npm run local:loop -- --objective="${objective}" --paths=${pathsArg}${testCommands.map((t) => ` --test="${t}"`).join('')}`);
  }
  console.log(`\n  Rien n'est appliqué au dépôt principal. MESSAGES SENT: 0\n`);
} finally {
  repos.close();
}
