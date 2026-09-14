/**
 * Amener la base au schéma courant, et vérifier qu'elle est saine.
 *
 *   npm run db:migrate            applique les migrations en attente, puis vérifie
 *   npm run db:migrate -- --check vérifie seulement : n'écrit rien
 *
 * Les migrations sont celles du code (`packages/data/src/migrations.ts`) :
 * versionnées, idempotentes, appliquées dans une transaction chacune. Ouvrir
 * la base suffit à les appliquer ; ce script existe pour le faire *avant* de
 * redémarrer le service, sous les yeux de l'opérateur, et pour refuser de
 * continuer si l'intégrité n'est pas au rendez-vous.
 *
 * Faites une sauvegarde d'abord : `npm run backup`. Le script le rappelle,
 * et ne l'impose pas — sous systemd, c'est `deployment/release.sh` qui l'enchaîne.
 */
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createLogger, loadConfig, loadAtlasEnv } from '../packages/core/src/index.ts';
import { createRepositories, MIGRATIONS } from '../packages/data/src/index.ts';

loadAtlasEnv();
const config = loadConfig(process.cwd());
const file = process.env.ATLAS_DB_PATH ?? config.paths.databaseFile;
const checkOnly = process.argv.includes('--check');
const logger = createLogger({ level: 'warn', pretty: true });

const c = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', amber: '\x1b[33m' };
const latest = MIGRATIONS[MIGRATIONS.length - 1]!.version;

console.log(`\n  ${c.bold}BASE${c.reset}  ${c.dim}${file}${c.reset}`);

if (!existsSync(file)) {
  if (checkOnly) {
    console.log(`  ${c.amber}absente${c.reset} — elle sera créée au premier démarrage (schéma ${latest})\n`);
    process.exit(0);
  }
  console.log(`  ${c.dim}absente : création au schéma ${latest}${c.reset}`);
}

const applied = (() => {
  if (!existsSync(file)) return 0;
  const db = new Database(file, { readonly: true });
  try {
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined;
    return row?.v ?? 0;
  } catch {
    return 0;
  } finally {
    db.close();
  }
})();

console.log(`  schéma      ${applied} → ${latest}${applied === latest ? `  ${c.dim}(à jour)${c.reset}` : checkOnly ? `  ${c.amber}${latest - applied} migration(s) en attente${c.reset}` : ''}`);

if (checkOnly && applied < latest) {
  console.log(`  ${c.dim}Sauvegardez (npm run backup) puis : npm run db:migrate${c.reset}\n`);
}

if (!checkOnly) {
  // Ouvrir avec les dépôts applique les migrations en attente, exactement comme
  // le serveur le ferait — mais ici, maintenant, sous les yeux de l'opérateur.
  const repos = createRepositories(file, logger);
  repos.close();
  console.log(`  ${c.green}migrations appliquées${c.reset}  ${c.dim}schéma ${latest}${c.reset}`);
}

const db = new Database(file, { readonly: true });
try {
  const integrity = (db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>).map((r) => r.integrity_check);
  const ok = integrity.length === 1 && integrity[0] === 'ok';
  console.log(`  intégrité   ${ok ? `${c.green}ok${c.reset}` : `${c.red}${integrity.join(' | ')}${c.reset}`}`);
  const journal = (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
  console.log(`  journal     ${journal}${journal === 'wal' ? '' : `  ${c.amber}(WAL attendu : il sera posé au prochain démarrage)${c.reset}`}`);
  for (const table of ['sales_prospects', 'outreach_ledger', 'outbound_sends', 'sales_segments', 'suppression_list', 'tasks']) {
    try {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      console.log(`  ${c.dim}${table.padEnd(20)} ${String(n).padStart(7)}${c.reset}`);
    } catch {
      console.log(`  ${c.dim}${table.padEnd(20)}   (absente)${c.reset}`);
    }
  }
  console.log();
  if (!ok) process.exitCode = 1;
} finally {
  db.close();
}
