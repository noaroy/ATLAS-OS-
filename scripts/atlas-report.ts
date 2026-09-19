/**
 * Le rapport d'activité.
 *
 * Déterministe et hors ligne : il relit la base, il ne recalcule rien qui
 * demanderait un appel. C'est ce qui permettra plus tard de le produire chaque
 * nuit sans dépense ni surveillance.
 *
 * Il n'est pas envoyé. Le produire et le transmettre sont deux gestes
 * distincts, et le second appartient à quelqu'un.
 *
 *   npm run atlas:report
 *   npm run atlas:report -- --since=2026-08-01
 */
import { createLogger, loadAtlasEnv, loadConfig } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';

// Avant toute lecture de process.env : sans cet appel, `.env.local` n'existe
// pas pour ce processus et la configuration parait absente sans qu'aucune
// erreur ne le dise.
loadAtlasEnv();

const c = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', amber: '\x1b[33m' };

const flag = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const logger = createLogger({ level: 'error', pretty: false });
const config = loadConfig(process.cwd());
const repos = createRepositories(config.paths.databaseFile, logger);

const since = flag('since') ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const sinceIso = `${since}T00:00:00.000Z`;
const until = new Date().toISOString();

const line = (label: string, value: string | number, note = '') =>
  console.log(`    ${label.padEnd(26)}${String(value).padStart(8)}  ${c.dim}${note}${c.reset}`);

console.log(`\n  ${c.bold}ATLAS ACTIVITY REPORT${c.reset}`);
console.log(`  ${c.dim}période : ${since} → ${until.slice(0, 10)}${c.reset}\n`);

const counts = repos.tasks.countByStatus();
const at = (status: string) => counts[status] ?? 0;
const completed = repos.tasks.completedSince(sinceIso);

console.log(`  ${c.bold}TÂCHES${c.reset}`);
line('completed', completed.length);
line('failed', at('FAILED'));
line('queued', at('QUEUED') + at('RETRY_SCHEDULED'));
line('waiting human', at('WAITING_HUMAN'), 'décision attendue');
line('paused quota', at('PAUSED_QUOTA'));
line('paused budget', at('PAUSED_BUDGET'));

console.log(`\n  ${c.bold}PAR DÉPARTEMENT${c.reset}`);
const byDepartment = new Map<string, number>();
for (const task of completed) {
  byDepartment.set(task.department, (byDepartment.get(task.department) ?? 0) + 1);
}
for (const department of ['SALES', 'ENGINEERING', 'MAINTENANCE', 'BACKGROUND', 'CLIENT_REPLY', 'CRITICAL_CLIENT']) {
  line(department.toLowerCase(), byDepartment.get(department) ?? 0);
}

console.log(`\n  ${c.bold}FOURNISSEURS${c.reset}`);
for (const provider of ['OPENAI', 'ANTHROPIC']) {
  const health = repos.tasks.providerHealth(provider);
  const downMs = repos.tasks.providerDowntimeMs(provider, sinceIso);
  line(
    `${provider.toLowerCase()} downtime`,
    health ? `${Math.round(downMs / 60_000)} min` : 'N/A',
    health ? `état courant ${health.state}` : 'jamais observé',
  );
}

console.log(`\n  ${c.bold}MODÈLES${c.reset}`);
for (const provider of ['OPENAI', 'ANTHROPIC']) {
  const usage = repos.tasks.aiUsageSince(sinceIso, provider);
  const workerType = provider === 'OPENAI' ? 'OPENAI' : 'CLAUDE';
  const tasks = completed.filter((task) => task.workerType === workerType).length;
  line(`${provider.toLowerCase()} tâches`, tasks);
  line(`${provider.toLowerCase()} appels`, usage.calls);
  line(`${provider.toLowerCase()} jetons`, usage.inputTokens + usage.outputTokens);
  // Le cout connu et les appels au tarif inconnu restent separes : additionner
  // les seconds comme des zeros ferait passer une depense pour rien.
  line(
    `${provider.toLowerCase()} coût`,
    usage.calls === 0 ? 'N/A' : `${usage.knownCostUsd.toFixed(4)} $`,
    usage.unknownCostCalls > 0 ? `${usage.unknownCostCalls} appel(s) au tarif inconnu` : '',
  );
}

console.log(`\n  ${c.bold}CHAÎNES${c.reset}`);
const chainIds = new Set(
  repos.tasks.list({ limit: 500 }).map((task) => task.chainId).filter(Boolean) as string[],
);
let chainsDone = 0;
let chainsBlocked = 0;
for (const chainId of chainIds) {
  const tasks = repos.tasks.chainTasks(chainId);
  const open = tasks.filter((t) => ['QUEUED', 'RUNNING', 'RETRY_SCHEDULED'].includes(t.status));
  const stuck = tasks.filter((t) => ['WAITING_HUMAN', 'PAUSED_QUOTA'].includes(t.status));
  if (open.length === 0 && stuck.length === 0) chainsDone += 1;
  if (stuck.length > 0) chainsBlocked += 1;
}
line('chaînes terminées', chainsDone);
line('chaînes bloquées', chainsBlocked, 'quota ou décision humaine');
line(
  'changements ingénierie',
  completed.filter((t) => t.taskType === 'ENGINEERING_CHANGE').length,
);
line('revues', completed.filter((t) => t.taskType.includes('REVIEW')).length);

console.log(`\n  ${c.bold}COÛT${c.reset}`);
// Le coût porté par la tâche, distinct de celui des appels ci-dessus : il ne
// vaut que pour les tâches dont le worker a su chiffrer sa dépense. En mode
// figé, aucune ne le fait — et N/A est alors plus honnête qu'un zéro.
const withCost = completed.filter((task) => task.actualCost != null);
line(
  'known ai cost',
  withCost.length === 0 ? 'N/A' : `${withCost.reduce((s, t) => s + (t.actualCost ?? 0), 0).toFixed(4)} $`,
  withCost.length === 0 ? 'aucune tâche ne rapporte de coût' : `${withCost.length} tâche(s)`,
);

console.log(`\n  ${c.bold}ACTIONS HUMAINES REQUISES${c.reset}`);
const waiting = repos.tasks.list({ status: 'WAITING_HUMAN', limit: 20 });
const failed = repos.tasks.list({ status: 'FAILED', limit: 20 });
if (waiting.length === 0 && failed.length === 0) {
  console.log(`    ${c.dim}aucune.${c.reset}`);
}
for (const task of waiting) {
  console.log(`    ${c.amber}DÉCISION${c.reset}  ${task.taskType.padEnd(22)}${c.dim}${task.taskId}${c.reset}`);
}
for (const task of failed) {
  console.log(
    `    ${c.amber}ÉCHEC   ${c.reset}  ${task.taskType.padEnd(22)}` +
      `${c.dim}${task.errorCode ?? 'sans code'} — ${task.taskId}${c.reset}`,
  );
}

console.log(`\n  ${c.dim}Rapport non envoyé. MESSAGES SENT: 0${c.reset}\n`);
repos.close();
