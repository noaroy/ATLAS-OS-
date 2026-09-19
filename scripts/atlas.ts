/**
 * L'écran qu'on ouvre le matin.
 *
 * Une contrainte le gouverne : on doit pouvoir le lire en trente secondes et
 * le refermer. Ce qui s'est passé, ce qui attend une décision, où en est la
 * vente, ce que font les agents. Rien d'autre.
 *
 * Aucun identifiant de bail, aucun numéro de migration, aucun SQL. Ces choses
 * existent et restent consultables — `atlas:status`, `atlas:task`, `atlas:report`
 * — mais elles n'aident personne à décider quoi faire, et les afficher ici
 * ferait que l'écran cesse d'être lu.
 *
 *   npm run atlas
 */
import { createLogger, loadConfig, AUTONOMY_LEVELS, canRunProvider } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import {
  collectNeedsYou, todaySnapshot, pipelineSnapshot, inspectRepo,
} from '../packages/runtime/src/index.ts';

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};

const flag = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const logger = createLogger({ level: 'error', pretty: false });
const config = loadConfig(process.cwd());
const repos = createRepositories(config.paths.databaseFile, logger);
const today = flag('today') ?? new Date().toISOString().slice(0, 10);
const now = Date.now();

const num = (value: number | null, suffix = '') =>
  value === null ? 'N/A' : `${value}${suffix}`;
const row = (label: string, value: string | number, note = '') =>
  console.log(`    ${label.padEnd(22)}${String(value).padStart(9)}   ${c.dim}${note}${c.reset}`);

console.log(`\n  ${c.bold}${c.cyan}ATLAS${c.reset}  ${c.dim}${today}${c.reset}`);

// --- Ce qui attend une personne. En premier, parce que c'est ce qui décide ---

const systemBlockers: Array<{ what: string; why: string; action: string }> = [];

const gmail = process.env.GMAIL_REFRESH_TOKEN?.trim();
if (!gmail) {
  systemBlockers.push({
    what: 'la boîte Gmail n’est pas connectée',
    why: 'les réponses de prospects ne remontent pas seules — elles se saisissent à la main',
    action: 'npm run gmail:authorize',
  });
}

const needs = collectNeedsYou({ repos, today, systemBlockers });

console.log(`\n  ${c.bold}IL FAUT VOUS${c.reset} ${c.dim}— ${needs.length} chose(s)${c.reset}`);
if (needs.length === 0) {
  console.log(`    ${c.green}Rien.${c.reset} ${c.dim}ATLAS continue seul.${c.reset}`);
}
for (const item of needs.slice(0, 8)) {
  const colour = item.kind === 'CLIENT_REPLY' ? c.green
    : item.kind === 'SYSTEM' ? c.red : c.amber;
  console.log(`\n    ${colour}${item.kind.replace('_', ' ')}${c.reset}  ${item.what}`);
  console.log(`      ${c.dim}pourquoi${c.reset}      ${item.why}`);
  console.log(`      ${c.dim}recommandé${c.reset}    ${item.recommendation}`);
  console.log(`      ${c.dim}action${c.reset}        ${c.bold}${item.action}${c.reset}`);
}
if (needs.length > 8) {
  console.log(`\n    ${c.dim}… et ${needs.length - 8} autre(s).${c.reset}`);
}

// --- Aujourd'hui ------------------------------------------------------------

const snapshot = todaySnapshot(repos, today);
console.log(`\n  ${c.bold}AUJOURD’HUI${c.reset}`);
row('entreprises contactées', snapshot.contacted);
row('réponses', snapshot.replies);
row('réponses positives', snapshot.positiveReplies);
row('clients payants', snapshot.paidClients);
row('revenu', `${snapshot.revenueEur.toFixed(2)} €`);
row(
  'coût IA',
  snapshot.aiCostUsd === null ? 'N/A' : `${snapshot.aiCostUsd.toFixed(4)} $`,
  snapshot.aiCostUnknownCalls > 0
    ? `+ ${snapshot.aiCostUnknownCalls} appel(s) au tarif inconnu`
    : snapshot.aiCostUsd === null ? 'aucun appel' : '',
);
row('tâches terminées', snapshot.tasksDone);

// --- L'entonnoir ------------------------------------------------------------

const pipeline = pipelineSnapshot(repos, today);
console.log(`\n  ${c.bold}PIPELINE${c.reset}`);
row('découverts', pipeline.discovered);
row('qualifiés', pipeline.qualified);
row('contactés', pipeline.contacted);
row('intéressés', pipeline.interested);
// L'aperçu gratuit est produit et transmis à la main : rien en base ne permet
// de le compter, et un zéro se lirait « aucun » au lieu de « je ne sais pas ».
row('aperçus gratuits', pipeline.preview < 0 ? 'N/A' : pipeline.preview, 'livrés à la main');
row('payants', pipeline.paid);

// --- Les agents -------------------------------------------------------------

console.log(`\n  ${c.bold}AGENTS${c.reset}`);
const states = repos.tasks.countByStatus();
const running = repos.tasks.list({ status: 'RUNNING', limit: 20 });

const agentLine = (name: string, workerType: string | null) => {
  const mine = workerType ? running.filter((t) => t.workerType === workerType) : running;
  const health = workerType === 'OPENAI'
    ? repos.tasks.providerHealth('OPENAI')
    : workerType === 'CLAUDE' ? repos.tasks.providerHealth('ANTHROPIC') : null;
  const quota = health ? canRunProvider(health, now) : null;

  const state = mine.length > 0 ? `${c.green}au travail${c.reset}`
    : quota && !quota.allowed ? `${c.amber}en pause${c.reset}`
    : `${c.dim}au repos${c.reset}`;
  const detail = mine[0]?.taskType
    ?? (quota && !quota.allowed ? quota.reason : 'rien en cours');
  console.log(`    ${name.padEnd(12)}${state.padEnd(22)}${c.dim}${detail}${c.reset}`);
};

agentLine('Hermes', null);
agentLine('OpenAI', 'OPENAI');
agentLine('Claude', 'CLAUDE');
console.log(
  `    ${'Ventes'.padEnd(12)}${(repos.salesLoop.draftsInState('READY_FOR_APPROVAL').length > 0
    ? `${c.amber}attend vous${c.reset}` : `${c.dim}au repos${c.reset}`).padEnd(22)}` +
  `${c.dim}${pipeline.contacted} entreprise(s) au registre${c.reset}`,
);

// --- Le système -------------------------------------------------------------

console.log(`\n  ${c.bold}SYSTÈME${c.reset}`);
const run = repos.tasks.lastDaemonRun();
console.log(
  `    ${'daemon'.padEnd(16)}${run
    ? run.stoppedAt ? `${c.dim}arrêté${c.reset}` : `${c.green}démarré${c.reset} ${c.dim}(non confirmé vivant)${c.reset}`
    : `${c.dim}jamais lancé${c.reset}`}`,
);
console.log(
  `    ${'recherche'.padEnd(16)}${config.search.searxngBaseUrl
    ? `${c.dim}${config.search.searxngBaseUrl}${c.reset}` : `${c.amber}non configurée${c.reset}`}`,
);
console.log(
  `    ${'Gmail'.padEnd(16)}${gmail ? `${c.green}connecté${c.reset}` : `${c.amber}non connecté${c.reset}`}`,
);
let repoNote = 'N/A';
try {
  const state = inspectRepo(process.cwd());
  repoNote = state.clean ? 'propre' : `${state.dirtyFiles.length} fichier(s) non commité(s)`;
} catch { repoNote = 'pas un dépôt git'; }
console.log(`    ${'dépôt'.padEnd(16)}${c.dim}${repoNote}${c.reset}`);
console.log(
  `    ${'file'.padEnd(16)}${c.dim}${(states.QUEUED ?? 0)} en attente · ` +
  `${(states.FAILED ?? 0)} en échec · ${(states.PAUSED_QUOTA ?? 0)} en pause quota${c.reset}`,
);

// --- Les verrous, en une ligne ----------------------------------------------

const level = AUTONOMY_LEVELS[1];
console.log(`\n  ${c.bold}AUTONOMIE${c.reset}  ${c.dim}niveau ${level.level} — ${level.label}${c.reset}`);
console.log(`    ${c.dim}${level.description}${c.reset}`);
console.log(
  `    ${c.dim}IA : ${config.ai.live ? 'RÉELLE, facturée' : 'figée, aucune dépense'} · ` +
  `envoi commercial : approbation exigée · MESSAGES SENT: 0${c.reset}`,
);
console.log(`\n  ${c.dim}détail : atlas:status · atlas:report · atlas:production-check${c.reset}\n`);

repos.close();
