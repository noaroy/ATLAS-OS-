/**
 * Toutes les preuves écrites sur une entreprise, pour une mission.
 *
 *   node scripts/inspect-company.mjs M-WX5T0 Heidelberg
 */
import Database from 'better-sqlite3';

const [code, needle] = process.argv.slice(2);
const db = new Database('data/atlas.db', { readonly: true });
const mission = db.prepare('SELECT id FROM missions WHERE code = ?').get(code);

const rows = db
  .prepare(
    `SELECT c.name, c.domain, c.city, c.country, c.website,
            e.field, e.claim, e.source_ref, e.nature
       FROM evidence e JOIN companies c ON c.id = e.company_id
      WHERE e.mission_id = ? AND c.name LIKE ?
      ORDER BY c.name, e.field`,
  )
  .all(mission.id, `%${needle}%`);

let current = '';
for (const r of rows) {
  if (r.name !== current) {
    current = r.name;
    console.log(`\n  ${r.name}`);
    console.log(`  domaine : ${r.domain ?? '—'} · site : ${r.website ?? '—'}`);
    console.log(`  lieu    : ${r.city ?? '?'}, ${r.country ?? '?'}\n`);
  }
  console.log(`    ${r.field} (${r.nature})`);
  console.log(`      ${r.claim.slice(0, 200)}`);
  console.log(`      src : ${r.source_ref ?? '—'}`);
}
console.log();
db.close();
