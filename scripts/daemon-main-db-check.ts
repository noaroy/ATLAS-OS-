/**
 * Faire tourner le daemon sur la base principale, une fois, sous contrôle.
 *
 * Jusqu'ici le daemon n'avait tourné que sur des bases jetables créées par les
 * tests. C'est une preuve incomplète : une base de test est vide, neuve, sans
 * migration en retard et sans données à abîmer. Tant que ce run n'a pas eu
 * lieu, « le daemon fonctionne » reste une affirmation sur un cas facile, et
 * l'observabilité — journaux de démarrage, d'arrêt, de tâche — n'a jamais été
 * lue ailleurs que dans un bac à sable.
 *
 * Le run est borné par le nombre de tours, pas par une horloge : une borne de
 * temps laisserait le processus vivant si un tour se bloquait, ce qui est
 * précisément le cas qu'on ne veut pas découvrir sur un VPS.
 *
 * Aucun appel de modèle : `ATLAS_AI_LIVE` reste faux. Aucun envoi : la tâche
 * déposée est un travail déterministe interne. Rien n'est supprimé.
 *
 *   npm run atlas:daemon-check
 */
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger, loadConfig } from '../packages/core/src/index.ts';
import { createRepositories, type Repositories } from '../packages/data/src/index.ts';

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
};

const logger = createLogger({ level: 'error', pretty: false });
const config = loadConfig(process.cwd());
const dbPath = process.env.ATLAS_DB_PATH ?? config.paths.databaseFile;

const sum = (record: Record<string, number>): number =>
  Object.values(record).reduce((total, n) => total + n, 0);

/**
 * Ce qui doit être exactement identique après le run.
 *
 * Trois familles, et la troisième est celle qui compte le plus. Les données
 * commerciales ne doivent pas bouger — c'est l'évidence. Les compteurs d'envoi
 * et d'appels de modèle ne doivent pas bouger non plus, et c'est moins évident :
 * un daemon qui déciderait tout seul d'écrire à un prospect ou d'appeler un
 * modèle facturé le ferait sans rien casser, donc sans rien signaler. Un
 * relevé avant/après est le seul moyen de constater qu'il ne l'a pas fait.
 */
const snapshot = (r: Repositories) => ({
  registre: r.sales.ledgerDomains().length,
  conversations: r.conversations.all().length,
  brouillons: r.salesLoop.draftsInState('READY_FOR_APPROVAL').length,
  etatsBoucle: sum(r.salesLoop.stateCounts()),
  // Depuis l'origine : une fenêtre du jour raterait un envoi daté d'hier.
  envois: r.salesLoop.sentSince('1970-01-01T00:00:00.000Z'),
  appelsIa: r.tasks.aiUsageSince('1970-01-01T00:00:00.000Z').calls,
});

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
};

console.log(`\n  ${c.bold}DAEMON SUR LA BASE PRINCIPALE${c.reset}`);
console.log(`  ${c.dim}${dbPath}${c.reset}`);
console.log(`  ${c.dim}ATLAS_AI_LIVE=${process.env.ATLAS_AI_LIVE ?? 'false'} · aucun envoi · aucune suppression${c.reset}\n`);

// --- Avant ---
const before = (() => {
  const repos = createRepositories(dbPath, logger);
  try {
    const snap = snapshot(repos);
    const runsBefore = repos.tasks.lastDaemonRun();
    // Une tâche déterministe, pour que le daemon ait réellement quelque chose à
    // prendre : un daemon qui ne fait que dormir ne prouve pas qu'il travaille.
    // DEMO_SLEEP a un handler deterministe et aboutit : un type sans handler
    // finirait en RETRY_SCHEDULED et laisserait dans la file principale une
    // tache qui reessaie sans fin. La sonde doit se refermer, pas s'installer.
    const task = repos.tasks.create({
      taskType: 'DEMO_SLEEP', department: 'ENGINEERING',
      workerType: 'DETERMINISTIC',
      payload: { durationMs: 50, label: 'sonde base principale' },
    }).task;
    return { snap, runsBefore, taskId: task.taskId };
  } finally { repos.close(); }
})();

console.log(`  ${c.dim}tâche déposée : ${before.taskId}${c.reset}`);

// --- Le run ---
const started = Date.now();
const run = spawnSync(
  process.execPath,
  ['--import', 'tsx', 'scripts/atlas-daemon.ts', '--cycles=3', '--idle=1500', '--log=info'],
  {
    encoding: 'utf8', timeout: 90_000, cwd: process.cwd(),
    env: { ...process.env, ATLAS_AI_LIVE: 'false', ATLAS_DB_PATH: dbPath },
  },
);
const elapsed = Date.now() - started;
const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;

check(
  'démarrage',
  /daemon/i.test(output) && run.error === undefined,
  run.error ? String(run.error).slice(0, 100) : `sorti en ${(elapsed / 1000).toFixed(1)} s`,
);
check(
  'arrêt propre',
  run.status === 0 && run.signal === null,
  `code ${run.status}, signal ${run.signal ?? 'aucun'}`,
);

// --- Après ---
const repos = createRepositories(dbPath, logger);
try {
  const after = snapshot(repos);
  const cles = Object.keys(after) as Array<keyof typeof after>;
  const bouges = cles.filter((k) => after[k] !== before.snap[k]);
  check(
    'aucune donnée commerciale touchée',
    bouges.length === 0,
    bouges.length === 0
      ? `registre ${after.registre} · conversations ${after.conversations} · `
        + `brouillons ${after.brouillons} · etats ${after.etatsBoucle} — inchanges`
      : bouges.map((k) => `${k} ${before.snap[k]}→${after[k]}`).join(' · '),
  );
  check(
    'aucun email envoye',
    after.envois === before.snap.envois,
    `${after.envois} envoi(s) au total, inchange — MESSAGES SENT = 0`,
  );
  check(
    'aucune consommation IA reelle',
    after.appelsIa === before.snap.appelsIa,
    `${after.appelsIa} appel(s) de modele au total, inchange`,
  );

  const lastRun = repos.tasks.lastDaemonRun();
  check(
    'journal de run enregistré',
    lastRun !== null && lastRun.id !== before.runsBefore?.id,
    lastRun ? `${lastRun.id} · pid ${lastRun.pid}` : 'aucun run journalisé',
  );
  check(
    'run refermé',
    lastRun?.stoppedAt != null,
    lastRun?.stoppedAt
      ? `arrêté à ${lastRun.stoppedAt.slice(11, 19)}`
      : 'run laissé ouvert : une reprise le croirait vivant',
  );

  const probe = repos.tasks.byId(before.taskId);
  check(
    'tâche prise et menée à son terme',
    probe !== null && probe.status === 'DONE',
    probe ? `état final ${probe.status}, ${probe.attemptCount} tentative(s)` : 'tâche introuvable',
  );

  const evenements = repos.tasks.historyFor(before.taskId);
  check(
    'événements de tâche journalisés',
    evenements.length > 0,
    `${evenements.length} événement(s) : ${evenements.map((e) => e.to).slice(0, 4).join(' → ')}`,
  );

  // La file reste lisible : un etat par statut, et la sonde retrouvable.
  const parStatut = repos.tasks.countByStatus();
  check(
    'file lisible apres le run',
    sum(parStatut) > 0 && repos.tasks.byId(before.taskId) !== null,
    Object.entries(parStatut).map(([etat, n]) => `${etat} ${n}`).join(' · '),
  );

  // Aucun secret ne doit apparaître dans la sortie du daemon.
  const fuite = [/sk-ant-[A-Za-z0-9]/, /sk-proj-[A-Za-z0-9]/, /GMAIL_REFRESH_TOKEN=\S/]
    .find((re) => re.test(output));
  check('aucun secret dans la sortie', fuite === undefined, fuite ? `motif ${fuite}` : 'sortie propre');

  /**
   * L'integrite du fichier, demandee a SQLite lui-meme.
   *
   * Une base qui repond aux requetes peut avoir un index corrompu : seul ce
   * pragma le dit. Le fichier est ouvert directement plutot que par les depots,
   * qui n'exposent pas la connexion brute — et a raison de ne pas l'exposer.
   * Ajouter un acces au moteur pour satisfaire ce controle affaiblirait la
   * frontiere que tout le reste du code respecte.
   */
  const inspecteur = new Database(dbPath, { readonly: true });
  try {
    const integrite = inspecteur.pragma('integrity_check', { simple: true }) as string;
    check('aucune corruption', integrite === 'ok', `integrity_check : ${integrite}`);
  } finally {
    inspecteur.close();
  }
} finally {
  repos.close();
}

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  const mark = r.ok ? `${c.green}PASS${c.reset}` : `${c.red}FAIL${c.reset}`;
  console.log(`  ${mark}  ${r.name.padEnd(width)}  ${c.dim}${r.detail}${c.reset}`);
}

const ok = results.every((r) => r.ok);

// Le recu, a cote des sauvegardes : le controle de production le relit plutot
// que de supposer qu'un run a eu lieu. Sans lui, « le daemon tourne sur la base
// principale » resterait une affirmation invérifiable.
const receipt = join(config.paths.backupDir, 'daemon-main-db-check.json');
mkdirSync(config.paths.backupDir, { recursive: true });
writeFileSync(
  receipt,
  JSON.stringify({ at: new Date().toISOString(), db: dbPath, ok, checks: results }, null, 2),
  'utf8',
);
console.log(`  ${c.dim}recu : ${receipt}${c.reset}`);
console.log(
  `\n  ${ok ? `${c.green}DAEMON ÉPROUVÉ SUR LA BASE PRINCIPALE${c.reset}` : `${c.red}ÉCHEC${c.reset}`}`
  + ` — ${results.filter((r) => r.ok).length}/${results.length}\n`,
);
process.exitCode = ok ? 0 : 1;
