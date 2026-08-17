/**
 * Le rapport factuel d'une mission : ce qu'elle a produit, ce qu'elle a coûté.
 *
 * Tout est lu en base. Rien n'est estimé, rien n'est arrondi vers le haut.
 *
 *   node scripts/report-mission.mjs M-WX5T0
 */
import Database from 'better-sqlite3';

const code = process.argv[2];
const db = new Database('data/atlas.db', { readonly: true });
const mission = db.prepare('SELECT id, code, status FROM missions WHERE code = ?').get(code);
if (!mission) {
  console.error(`Mission « ${code} » introuvable.`);
  process.exit(1);
}

const companies = db
  .prepare(
    `SELECT c.id, c.name, c.domain, c.country, c.city, c.data_origin,
            o.score, o.stage, o.rank,
            (SELECT COUNT(*) FROM evidence e WHERE e.opportunity_id = o.id) AS ev,
            (SELECT COUNT(*) FROM evidence e WHERE e.opportunity_id = o.id
               AND e.nature != 'inferred' AND e.source_ref IS NOT NULL) AS firsthand,
            (SELECT COUNT(*) FROM contacts ct WHERE ct.company_id = c.id) AS contacts
       FROM opportunities o JOIN companies c ON c.id = o.company_id
      WHERE o.mission_id = ? ORDER BY c.name`,
  )
  .all(mission.id);

console.log(`\n  Entreprises trouvées (${companies.length})\n  ` + '─'.repeat(74));
for (const c of companies) {
  console.log(
    `  ${c.name.slice(0, 34).padEnd(36)}${(c.domain ?? '—').slice(0, 26).padEnd(28)}` +
      `${c.data_origin.padEnd(10)}${String(c.ev).padStart(3)} preuves (${c.firsthand} 1re main) · ${c.contacts} contact(s)`,
  );
}

const sources = db
  .prepare(
    `SELECT DISTINCT source_ref FROM evidence
      WHERE mission_id = ? AND source_ref IS NOT NULL ORDER BY source_ref`,
  )
  .all(mission.id);
console.log(`\n  Sources consultées (${sources.length})\n  ` + '─'.repeat(74));
for (const s of sources) console.log(`  ${s.source_ref}`);

const contacts = db
  .prepare(
    `SELECT ct.name, ct.role, ct.email, ct.phone, c.name AS company
       FROM contacts ct JOIN companies c ON c.id = ct.company_id
      WHERE c.id IN (SELECT company_id FROM opportunities WHERE mission_id = ?)`,
  )
  .all(mission.id);
console.log(`\n  Contacts (${contacts.length})\n  ` + '─'.repeat(74));
for (const ct of contacts) {
  console.log(
    `  ${(ct.company ?? '').slice(0, 30).padEnd(32)}${(ct.name || '(sans nom)').padEnd(24)}` +
      `${ct.email ?? ct.phone ?? '—'}`,
  );
}
if (contacts.length === 0) console.log('  aucun');

console.log();
db.close();
