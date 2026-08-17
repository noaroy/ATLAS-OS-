/** Le détail d'un score, dimension par dimension. `node scripts/show-score.mjs M-WX5T0` */
import Database from 'better-sqlite3';

const db = new Database('data/atlas.db', { readonly: true });
const rows = db
  .prepare(
    `SELECT c.name, o.score, o.rank, o.score_detail
       FROM opportunities o JOIN companies c ON c.id = o.company_id
      WHERE o.mission_id = (SELECT id FROM missions WHERE code = ?) AND o.rank IS NOT NULL
      ORDER BY o.rank`,
  )
  .all(process.argv[2] ?? 'M-WX5T0');

for (const row of rows) {
  const detail = JSON.parse(row.score_detail);
  console.log(`\n  ${row.name} — rang ${row.rank}, total ${row.score}/100`);
  console.log(`  ${'dimension'.padEnd(22)}${'note'.padStart(6)}${'poids'.padStart(7)}${'apport'.padStart(8)}  origine`);
  for (const comp of detail.components) {
    console.log(
      `  ${comp.dimension.padEnd(22)}${String(comp.value).padStart(6)}${String(comp.weight).padStart(7)}` +
        `${String(comp.contribution).padStart(8)}  ` +
        (comp.computed ? 'calculée par la plateforme' : `${comp.evidenceIds.length} preuve(s) citée(s)`),
    );
  }
  console.log(`  confiance globale : ${detail.confidence}`);
}
console.log();
db.close();
