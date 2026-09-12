/**
 * Copier la base, pendant qu'elle travaille.
 *
 * Une base SQLite en WAL ne se sauvegarde pas en copiant son fichier : le
 * journal contient des pages non encore intégrées, et la copie obtenue peut
 * être cohérente, corrompue, ou — le pire cas — cohérente mais en retard de
 * quelques minutes sans que rien ne le signale. `VACUUM INTO` produit une base
 * complète et cohérente, sans interrompre les lecteurs.
 *
 * La rotation garde un nombre fixe de copies. Sans elle, le répertoire grossit
 * jusqu'au jour où le disque est plein — et un disque plein arrête aussi les
 * écritures de la base qu'on voulait protéger.
 *
 *   npm run backup
 *   npm run backup -- --keep=14
 */
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger, loadConfig } from '../packages/core/src/index.ts';
import { openDatabase } from '../packages/data/src/database.ts';

const c = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', amber: '\x1b[33m' };

const flag = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const logger = createLogger({ level: 'error', pretty: false });
const config = loadConfig(process.cwd());

const source = process.env.ATLAS_DB_PATH ?? config.paths.databaseFile;
const backupDir = flag('dir') ?? config.paths.backupDir;
const keep = Number(flag('keep') ?? config.backup.retention ?? 7);

if (!existsSync(source)) {
  console.error(`aucune base à sauvegarder : ${source}`);
  process.exit(1);
}

mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = join(backupDir, `atlas-${stamp}.db`);

const db = openDatabase(source, logger);
try {
  // `VACUUM INTO` défragmente au passage : la copie est souvent plus petite que
  // l'original, et surtout elle est complète — journal intégré compris.
  db.prepare('VACUUM INTO ?').run(target);
} finally {
  db.close();
}

const size = statSync(target).size;
console.log(`\n  ${c.green}sauvegarde${c.reset} ${target}`);
console.log(`  ${c.dim}${(size / 1_048_576).toFixed(1)} Mo · source ${source}${c.reset}`);

// --- Rotation ---------------------------------------------------------------

const copies = readdirSync(backupDir)
  .filter((name) => name.startsWith('atlas-') && name.endsWith('.db'))
  .map((name) => ({ name, at: statSync(join(backupDir, name)).mtimeMs }))
  .sort((a, b) => b.at - a.at);

const stale = copies.slice(keep);
for (const copy of stale) {
  // Une sauvegarde ancienne se supprime ; jamais la plus récente, quelle que
  // soit la valeur de `keep`.
  if (copy.name === `atlas-${stamp}.db`) continue;
  unlinkSync(join(backupDir, copy.name));
}

console.log(
  `  ${c.dim}${Math.min(copies.length, keep)} copie(s) conservée(s), `
  + `${stale.length} retirée(s)${c.reset}\n`,
);
