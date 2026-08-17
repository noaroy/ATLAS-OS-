/** Les preuves d'une mission, et lesquelles n'ont pas de source. Lecture seule. */
import Database from 'better-sqlite3';

const db = new Database('data/atlas.db', { readonly: true });
const code = process.argv[2];
const m = db.prepare('SELECT id, code FROM missions WHERE code = ?').get(code);
if (!m) {
  console.error('mission introuvable');
  process.exit(1);
}

const rows = db
  .prepare(
    `SELECT e.nature, e.field, e.claim, e.source_key, e.source_ref, e.basis, e.confidence, c.name
     FROM evidence e JOIN companies c ON c.id = e.company_id
     WHERE e.mission_id = ? ORDER BY e.nature`,
  )
  .all(m.id);

console.log(`\n${m.code} — ${rows.length} preuve(s)\n`);
for (const r of rows) {
  const flag = r.source_ref ? ' ' : 'X';
  console.log(`${flag} [${String(r.nature).padEnd(8)}] ${String(r.name).slice(0, 34).padEnd(34)} ${r.field}`);
  console.log(`    claim  ${String(r.claim).slice(0, 110)}`);
  console.log(`    source ${r.source_ref ?? '(AUCUNE)'}`);
  console.log(`    basis  ${String(r.basis ?? '-').slice(0, 110)}`);
}

const missing = rows.filter((r) => !r.source_ref);
console.log(`\nsans source : ${missing.length}`);
for (const r of missing) console.log(`  nature=${r.nature} field=${r.field}`);

db.close();
