/**
 * Éprouver une sauvegarde en la restaurant.
 *
 * Une sauvegarde jamais restaurée n'est pas une sauvegarde : c'est un fichier
 * dont on espère qu'il en est une. Le seul moyen de le savoir est de l'ouvrir
 * et d'y chercher ce qui devrait s'y trouver.
 *
 * Deux versions se sont trompées avant celle-ci, et de deux façons opposées.
 * La première déclarait la restauration vérifiée dès qu'*un* domaine était
 * peuplé — registre OU conversations OU tâches : une copie ayant perdu toute la
 * file de tâches passait pour saine tant que les entreprises du registre
 * étaient là. La seconde comparait bien domaine par domaine, mais ne signalait
 * qu'un domaine tombé à zéro : une copie ayant gardé trois tâches sur quarante
 * la satisfaisait.
 *
 * La règle est donc l'égalité, pas la présence. Un domaine vide à la source doit
 * être vide dans la copie ; un domaine à quarante doit être à quarante. Ce n'est
 * pas plus sévère par principe — c'est la seule comparaison qui distingue une
 * copie fidèle d'une copie partielle.
 *
 * Le contrôle est non destructif : la copie est ouverte dans un répertoire
 * temporaire, jamais à la place de la base courante.
 *
 *   npm run backup && npm run restore-check
 */
import {
  copyFileSync, mkdtempSync, rmSync, readdirSync, statSync, writeFileSync, existsSync, mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createLogger, loadConfig, nowIso } from '../packages/core/src/index.ts';
import { createRepositories, proveReadonly, type Repositories } from '../packages/data/src/index.ts';

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
};

const logger = createLogger({ level: 'error', pretty: false });
const config = loadConfig(process.cwd());
const dir = config.paths.backupDir;

const sum = (record: Record<string, number>): number =>
  Object.values(record).reduce((total, n) => total + n, 0);

/**
 * Les domaines qu'une base ATLAS porte, et comment les mesurer.
 *
 * Chaque mesure passe par une méthode que les dépôts exposent déjà. Aucune n'a
 * été ajoutée pour les besoins de ce contrôle : une méthode écrite pour être
 * vérifiée se contente en général de rendre ce qu'on espérait lire.
 */
const DOMAINS: Array<{ name: string; measure: (r: Repositories) => number }> = [
  { name: 'registre commercial', measure: (r) => r.sales.ledgerDomains().length },
  { name: 'conversations', measure: (r) => r.conversations.all().length },
  { name: 'file de tâches', measure: (r) => sum(r.tasks.countByStatus()) },
  {
    name: 'transitions de tâches',
    // L'historique compte plus que l'état : deux bases peuvent afficher les
    // mêmes totaux par statut en ayant perdu tout le chemin qui y mène.
    measure: (r) => r.tasks
      .list({ limit: 10_000 })
      .reduce((total, task) => total + r.tasks.historyFor(task.taskId).length, 0),
  },
  {
    name: 'chaînes IA',
    measure: (r) => new Set(
      r.tasks.list({ limit: 10_000 }).map((t) => t.chainId).filter((id): id is string => id !== null),
    ).size,
  },
  {
    name: 'appels IA',
    // Depuis l'origine : une fenêtre journalière rendrait zéro sur une base
    // ancienne et ferait passer une perte pour une absence normale.
    measure: (r) => r.tasks.aiUsageSince('1970-01-01T00:00:00.000Z').calls,
  },
  { name: 'espaces de travail', measure: (r) => sum(r.tasks.workspaceCounts()) },
  { name: 'états de la boucle commerciale', measure: (r) => sum(r.salesLoop.stateCounts()) },
  {
    name: 'brouillons à relire',
    measure: (r) => r.salesLoop.draftsInState('READY_FOR_APPROVAL').length,
  },
];

/**
 * Le dernier run du daemon, compare par identite plutot que par compte.
 *
 * Les depots n'exposent pas de total de runs, et en ajouter un pour ce seul
 * controle serait ecrire la mesure d'apres la reponse attendue. Comparer
 * l'identifiant du dernier run repond a la meme question — la copie porte-t-elle
 * le meme historique d'execution — avec ce qui existe deja.
 */
const daemonFingerprint = (r: Repositories): string => {
  const run = r.tasks.lastDaemonRun();
  return run ? `${run.id}@${run.startedAt}` : 'aucun';
};

const copies = existsSync(dir)
  ? readdirSync(dir)
      .filter((name) => name.startsWith('atlas-') && name.endsWith('.db'))
      .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
  : [];

if (copies.length === 0) {
  console.error('aucune sauvegarde à éprouver');
  process.exit(1);
}

const latest = join(dir, copies[0]!.name);
const ageHours = (Date.now() - copies[0]!.at) / 3_600_000;
const scratch = mkdtempSync(join(tmpdir(), 'atlas-restore-'));
const restored = join(scratch, 'restored.db');
/*
 * Deux epreuves, parce que la base est vivante.
 *
 * La sauvegarde stockee date d'hier soir ; la base a bouge depuis (un tour de
 * daemon, une tache). La comparer a la source d'aujourd'hui dirait « diverge »
 * sans rien apprendre. On l'eprouve donc pour ce qu'elle est : un fichier qui
 * doit se restaurer — non vide, integre, lisible domaine par domaine.
 *
 * La fidelite du mecanisme, elle, s'eprouve sans course : la source est
 * ouverte en LECTURE SEULE (SQLITE_OPEN_READONLY), une transaction de lecture
 * y est ouverte — sous WAL, elle fige ce que cette connexion voit pendant que
 * le daemon continue d'ecrire —, les domaines sont mesures dans cette
 * transaction, et l'instantane est pris par l'API de sauvegarde de SQLite
 * DEPUIS CETTE MEME CONNEXION : il copie exactement le meme etat. Restaure
 * dans un fichier temporaire, il doit rendre ce que la transaction a lu — a
 * l'unite pres, quel que soit le nombre d'ecrivains a cote.
 *
 * « Base principale intacte » ne signifie plus « le fichier n'a pas change de
 * taille » — sur une base vivante, il change. Il signifie : cette epreuve n'a
 * rien ecrit, et SQLite le prouve en refusant une ecriture d'essai.
 */
const fresh = join(scratch, 'fresh.db');
const freshRestored = join(scratch, 'fresh-restored.db');

console.log(`\n  ${c.bold}ÉPREUVE DE RESTAURATION${c.reset}`);
console.log(`  ${c.dim}${latest}${c.reset}`);
console.log(`  ${c.dim}âge : ${ageHours < 1 ? 'moins d’une heure' : `${Math.round(ageHours)} h`}${c.reset}\n`);

let ok = false;
let detail = '';
const rows: Array<{ name: string; source: string; restored: string; equal: boolean }> = [];

try {
  copyFileSync(latest, restored);
  /*
   * Deux preuves avant toute comparaison : le fichier n'est pas vide, et
   * SQLite le juge intègre. Une sauvegarde tronquée ou corrompue doit tomber
   * ici, avec le verdict de SQLite — pas plus loin, sur une mesure qui aurait
   * l'air d'une divergence métier.
   */
  const bytes = statSync(restored).size;
  if (bytes === 0) throw new Error('la sauvegarde est vide (0 octet)');
  const brute = new Database(restored, { readonly: true });
  try {
    const verdict = (brute.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>).map((r) => r.integrity_check);
    if (verdict.length !== 1 || verdict[0] !== 'ok') throw new Error(`integrity_check : ${verdict.join(' | ').slice(0, 200)}`);
  } finally {
    brute.close();
  }
  rows.push({ name: 'intégrité SQLite', source: 'ok', restored: 'ok', equal: true });
  rows.push({ name: 'taille (octets)', source: String(statSync(config.paths.databaseFile).size), restored: String(bytes), equal: bytes > 0 });

  // La sauvegarde stockée : chaque domaine se lit — c'est sa restaurabilité.
  {
    const copy = createRepositories(restored, logger);
    try {
      const lus = DOMAINS.map((d) => `${d.name} ${d.measure(copy)}`);
      rows.push({ name: `sauvegarde stockée lisible (${DOMAINS.length} domaines)`, source: 'lisible', restored: 'lisible', equal: true });
      console.log(`  ${c.dim}${copies[0]!.name} : ${lus.join(' · ')}${c.reset}`);
    } finally {
      copy.close();
    }
  }

  // L'instantané frais : une transaction de lecture sur la source en lecture
  // seule, les mesures dedans, la copie depuis la même connexion — donc du
  // même état. Aucune course possible avec le daemon, et rien d'écrit.
  const source = createRepositories(config.paths.databaseFile, logger, { readonly: true });
  let commitsAutres = 0;
  try {
    const preuve = proveReadonly(source.db);
    rows.push({ name: 'source ouverte en lecture seule', source: 'SQLITE_OPEN_READONLY', restored: preuve.readonly ? 'refus constaté' : 'ÉCRITURE ACCEPTÉE', equal: preuve.readonly });
    console.log(`  ${c.dim}${preuve.detail}${c.reset}`);

    const versionAvant = source.db.pragma('data_version', { simple: true }) as number;
    source.db.exec('BEGIN');
    const mesuresSource = DOMAINS.map((d) => ({ name: d.name, value: String(d.measure(source)) }));
    const runSource = daemonFingerprint(source);
    await source.db.backup(fresh);
    source.db.exec('COMMIT');
    // Les commits d'autres connexions pendant l'épreuve : une information,
    // jamais un échec — c'est le signe d'une base vivante.
    commitsAutres = Math.max(0, (source.db.pragma('data_version', { simple: true }) as number) - versionAvant);

    copyFileSync(fresh, freshRestored);
    const copy = createRepositories(freshRestored, logger);
    try {
      for (const [i, domain] of DOMAINS.entries()) {
        const inCopy = String(domain.measure(copy));
        const inSource = mesuresSource[i]!.value;
        rows.push({ name: domain.name, source: inSource, restored: inCopy, equal: inSource === inCopy });
      }
      const runCopy = daemonFingerprint(copy);
      rows.push({ name: 'dernier run du daemon', source: runSource.slice(0, 22), restored: runCopy.slice(0, 22), equal: runSource === runCopy });
    } finally {
      copy.close();
    }
  } finally {
    source.close();
  }
  rows.push({
    name: 'écritures de l’épreuve sur la source', source: 'aucune',
    restored: commitsAutres > 0 ? `aucune · ${commitsAutres} commit(s) d’autres processus pendant l’épreuve` : 'aucune',
    equal: true,
  });

  const divergents = rows.filter((r) => !r.equal);

  /**
   * Une source entièrement vide ne prouve pas qu'une sauvegarde est bonne : elle
   * prouve qu'on n'a pas su la lire. Le cas s'est produit — un mauvais nom de
   * champ pointait à côté de la base, tous les domaines paraissaient vides, et
   * le verdict annonçait « vérifiée » sans avoir rien comparé.
   */
  const mesures = rows.filter((r) => DOMAINS.some((d) => d.name === r.name) || r.name === 'dernier run du daemon');
  const sourceVide = mesures.every((r) => r.source === '0' || r.source === 'aucun');

  ok = divergents.length === 0 && !sourceVide;
  detail = sourceVide
    ? 'base source illisible ou vide : aucune comparaison possible'
    : divergents.length > 0
      ? `divergence(s) : ${divergents.map((d) => `${d.name} ${d.restored}≠${d.source}`).join(' ; ')}`
      : `sauvegarde stockée restaurable ; instantané frais : ${DOMAINS.length + 1} domaine(s) identiques à la source (lecture seule prouvée${commitsAutres > 0 ? `, base vivante : ${commitsAutres} commit(s) concurrents` : ''})`;

  const width = Math.max(...rows.map((r) => r.name.length));
  for (const row of rows) {
    const mark = row.equal ? `${c.green}=${c.reset}` : `${c.red}DIVERGE${c.reset}`;
    console.log(
      `  ${row.name.padEnd(width)}  ${row.restored.padStart(22)} / ${row.source.padEnd(22)}  ${mark}`,
    );
  }
  console.log(`  ${c.dim}${'copie / source'.padStart(width + 30)}${c.reset}`);
} catch (error) {
  detail = error instanceof Error ? error.message.slice(0, 160) : String(error);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// Le résultat est écrit à côté des sauvegardes : c'est lui que le contrôle de
// production relira, plutôt que de supposer.
const receipt = join(dir, 'restore-check.json');
mkdirSync(dir, { recursive: true });
writeFileSync(
  receipt,
  JSON.stringify(
    { at: nowIso(), backup: copies[0]!.name, ageHours: Math.round(ageHours * 10) / 10, ok, detail, domains: rows },
    null, 2,
  ),
  'utf8',
);

console.log(
  `\n  ${ok ? `${c.green}RESTAURATION VÉRIFIÉE${c.reset}` : `${c.red}ÉCHEC${c.reset}`} — ${detail}`,
);
if (!ok && rows.some((r) => !r.equal)) {
  console.log(
    `  ${c.dim}une divergence peut venir d'écritures postérieures à la sauvegarde :`
    + ` relancer « npm run backup » puis ce contrôle${c.reset}`,
  );
}
console.log(`  ${c.dim}reçu : ${receipt}${c.reset}\n`);
process.exitCode = ok ? 0 : 1;
