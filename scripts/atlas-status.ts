/**
 * L'état du cœur, en un écran.
 *
 * Tout ce qui est affiché ici est lu en base. Ce qui n'y est pas s'affiche
 * `N/A` — jamais zéro. La nuance décide de ce qu'on fait ensuite : « zéro tâche
 * en échec » invite à passer à autre chose, « je ne sais pas » invite à
 * regarder. Les confondre, sur un système qui tourne seul, revient à supprimer
 * la seule alerte qui comptait.
 *
 *   npm run atlas:status
 */
import { createLogger, loadConfig, canRunProvider } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import { inspectRepo } from '../packages/runtime/src/index.ts';

/** Un mot court pour la colonne de gauche, le détail allant en note. */
const state_label = (note: string) =>
  note.startsWith('propre') ? 'PROPRE' : note.startsWith('N/A') ? 'N/A' : 'MODIFIÉ';

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};

const flag = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const logger = createLogger({ level: 'error', pretty: false });
const config = loadConfig(process.cwd());
const repos = createRepositories(process.env.ATLAS_DB_PATH ?? 'data/atlas.db', logger);
const now = Date.now();
const today = flag('today') ?? new Date().toISOString().slice(0, 10);

const line = (label: string, value: string | number, note = '') =>
  console.log(`    ${label.padEnd(24)}${String(value).padStart(8)}  ${c.dim}${note}${c.reset}`);
const heading = (title: string) => console.log(`\n  ${c.bold}${title}${c.reset}`);

const human = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
};

console.log(`\n  ${c.bold}${c.cyan}ATLAS — ÉTAT DU CŒUR${c.reset}  ${c.dim}au ${today}${c.reset}`);

// --- Le daemon --------------------------------------------------------------

const run = repos.tasks.lastDaemonRun();
heading('DAEMON');
if (!run) {
  line('état', 'N/A', 'aucun démarrage enregistré');
  line('uptime', 'N/A');
} else if (run.stoppedAt) {
  line('état', 'ARRÊTÉ', `dernier arrêt le ${run.stoppedAt.slice(0, 19).replace('T', ' ')}`);
  line('uptime', 'N/A', 'aucun processus en cours d’après la base');
} else {
  // La base dit qu'un daemon a démarré sans s'arrêter. Elle ne prouve pas qu'il
  // vit encore — un processus tué n'écrit rien. On l'annonce comme tel.
  line('état', 'DÉMARRÉ', `pid ${run.pid} · non confirmé vivant`);
  line('uptime', human(now - Date.parse(run.startedAt)), 'depuis le dernier démarrage consigné');
}

// --- La file ----------------------------------------------------------------

const counts = repos.tasks.countByStatus();
const at = (status: string) => counts[status] ?? 0;
const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
const doneToday = repos.tasks.completedSince(`${today}T00:00:00.000Z`).length;

heading('FILE');
line('total', total);
line('queued', at('QUEUED'));
line('running', at('RUNNING'));
line('retry scheduled', at('RETRY_SCHEDULED'));
line('paused quota', at('PAUSED_QUOTA'));
line('paused budget', at('PAUSED_BUDGET'));
line('waiting human', at('WAITING_HUMAN'), 'ne bloque aucune autre tâche');
line('waiting dependency', at('WAITING_DEPENDENCY'));
line('failed', at('FAILED'));
line('done today', doneToday);

// --- Les fournisseurs -------------------------------------------------------

heading('FOURNISSEURS');
for (const provider of ['OPENAI', 'ANTHROPIC']) {
  const health = repos.tasks.providerHealth(provider);
  if (!health) {
    line(provider.toLowerCase(), 'UNKNOWN', 'jamais observé — distinct de disponible');
    continue;
  }
  const verdict = canRunProvider(health, now);
  const note = health.retryAt
    ? `reprise ${health.retryAt.slice(0, 19).replace('T', ' ')} (${health.retrySource})`
    : verdict.reason;
  line(provider.toLowerCase(), health.state, note);
}

// --- Les échéances ----------------------------------------------------------

heading('ÉCHÉANCES');
const oldest = repos.tasks.oldestQueued();
line(
  'oldest queued',
  oldest ? human(now - Date.parse(oldest.createdAt)) : 'N/A',
  oldest ? `${oldest.taskId} · ${oldest.taskType}` : 'file vide',
);

const next = repos.tasks.nextScheduled();
line(
  'next scheduled',
  next ? next.availableAt.slice(0, 19).replace('T', ' ') : 'N/A',
  next ? `${next.taskType} · ${next.status}` : 'rien de programmé',
);

const quotaRetries = [
  repos.tasks.providerHealth('OPENAI'),
  repos.tasks.providerHealth('ANTHROPIC'),
]
  .filter((h): h is NonNullable<typeof h> => Boolean(h?.retryAt))
  .map((h) => ({ provider: h.provider, retryAt: h.retryAt! }))
  .filter((h) => Date.parse(h.retryAt) > now)
  .sort((a, b) => Date.parse(a.retryAt) - Date.parse(b.retryAt));
line(
  'next quota retry',
  quotaRetries[0]?.retryAt.slice(0, 19).replace('T', ' ') ?? 'N/A',
  quotaRetries[0]?.provider ?? 'aucune reprise en attente',
);

const last = repos.tasks.lastCompleted();
line(
  'last completed',
  last?.finishedAt?.slice(0, 19).replace('T', ' ') ?? 'N/A',
  last ? `${last.taskType} · ${last.taskId}` : 'aucune tâche terminée',
);

// --- Les modèles ------------------------------------------------------------

heading('MODÈLES');
const todayIso = `${today}T00:00:00.000Z`;
for (const provider of ['OPENAI', 'ANTHROPIC']) {
  const usage = repos.tasks.aiUsageSince(todayIso, provider);
  const lastOk = repos.tasks.lastAiCall(provider, 'OK');
  const lastKo = repos.tasks.lastAiCall(provider, 'FAILED');
  const running = repos.tasks
    .list({ status: 'RUNNING', limit: 100 })
    .filter((t) => t.workerType === (provider === 'OPENAI' ? 'OPENAI' : 'CLAUDE')).length;

  console.log(`    ${c.bold}${provider}${c.reset}`);
  line('  running tasks', running);
  line('  tokens today', usage.inputTokens + usage.outputTokens, `${usage.calls} appel(s)`);
  // Un appel au tarif inconnu n'est pas un appel gratuit : il est compté à
  // part plutôt qu'ajouté comme zéro.
  line(
    '  cost today',
    usage.calls === 0 ? 'N/A' : `${usage.knownCostUsd.toFixed(4)} $`,
    usage.unknownCostCalls > 0 ? `+ ${usage.unknownCostCalls} au tarif inconnu` : '',
  );
  line('  last success', lastOk?.occurredAt.slice(0, 19).replace('T', ' ') ?? 'N/A');
  line('  last failure', lastKo?.occurredAt.slice(0, 19).replace('T', ' ') ?? 'N/A');
}

// --- Les chaînes ------------------------------------------------------------

const chains = new Map<string, { open: number; human: number; quota: number; done: number }>();
for (const task of repos.tasks.list({ limit: 500 })) {
  if (!task.chainId) continue;
  const entry = chains.get(task.chainId) ?? { open: 0, human: 0, quota: 0, done: 0 };
  if (['QUEUED', 'RUNNING', 'RETRY_SCHEDULED'].includes(task.status)) entry.open += 1;
  if (task.status === 'WAITING_HUMAN') entry.human += 1;
  if (task.status === 'PAUSED_QUOTA') entry.quota += 1;
  if (task.status === 'DONE') entry.done += 1;
  chains.set(task.chainId, entry);
}
const values = [...chains.values()];
heading('CHAÎNES IA');
line('actives', values.filter((v) => v.open > 0).length);
line('en attente humaine', values.filter((v) => v.human > 0).length);
line('bloquées par quota', values.filter((v) => v.quota > 0).length);
line(
  'terminées aujourd’hui',
  values.filter((v) => v.open === 0 && v.human === 0 && v.quota === 0 && v.done > 0).length,
);

// --- L'ingénierie -----------------------------------------------------------

const workspaces = repos.tasks.workspaceCounts();
const ws = (state: string) => workspaces[state] ?? 0;
heading('INGÉNIERIE');
line('workspaces actifs', ws('CREATED') + ws('IN_USE'));
line('prêts à relire', ws('READY_FOR_REVIEW'), 'attendent une décision');
line('approuvés, non appliqués', ws('APPROVED_TO_APPLY'));
line('application en cours', ws('APPLYING'));
line('appliqués', ws('APPLIED'));
line('abandonnés', ws('ABANDONED'), 'sortie de périmètre ou échec');

// L'état du dépôt décide de ce qui pourra être appliqué : un dépôt qui porte
// du travail non sauvegardé bloque toute application, et le savoir ici évite
// de le découvrir au moment d'approuver.
let repoNote = 'N/A';
try {
  const state = inspectRepo(process.cwd());
  repoNote = state.clean
    ? `propre · ${state.head.slice(0, 8)}`
    : `${state.dirtyFiles.length} fichier(s) non commité(s) — application bloquée`;
} catch {
  repoNote = 'N/A — pas un dépôt git';
}
line('dépôt principal', state_label(repoNote), repoNote);

// --- Les verrous, rappelés ici parce qu'ils décident du reste ---------------

heading('VERROUS');
const lock = repos.tasks.repoLockHolder('REPO_WRITE');
console.log(
  `    ${c.dim}mode IA : ${config.ai.live ? 'RÉEL — les appels sont facturés' : 'figé — aucune dépense'}${c.reset}`,
);
console.log(
  `    ${c.dim}verrou d'écriture dépôt : ${lock ? `tenu par ${lock.owner}` : 'libre'}${c.reset}`,
);
console.log(
  `    ${c.dim}chaîne : profondeur ${config.ai.maxChainDepth} · ${config.ai.maxTasksPerChain} tâches · ${config.ai.maxChainCostUsd} $ max${c.reset}`,
);
console.log(`    ${c.dim}approbation humaine commerciale : inchangée${c.reset}`);
console.log(`\n  ${c.dim}MESSAGES SENT: 0${c.reset}\n`);

repos.close();
