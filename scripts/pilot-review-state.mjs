/**
 * L'état de revue humaine d'un pilote, et sa ventilation de preuves.
 *
 * Lecture seule. Sert à vérifier qu'aucune opportunité n'a été approuvée
 * automatiquement : l'approbation est une décision humaine, et une shortlist
 * qui arrive déjà validée retire au fondateur la seule décision qui lui revient.
 */
import Database from 'better-sqlite3';

const db = new Database(process.argv[2] ?? 'data/atlas.db', { readonly: true });

const mission = db
  .prepare(
    `SELECT id, code, status FROM missions
     WHERE context LIKE '%LIVE-001%' AND id IN (SELECT mission_id FROM opportunities)
     ORDER BY created_at DESC LIMIT 1`,
  )
  .get();

console.log(`\n${mission.code} · ${mission.status}\n`);

const rows = db
  .prepare(
    `SELECT c.name, c.website, o.id, o.stage, o.score, o.rank, o.qualification, o.review, o.justification
     FROM opportunities o JOIN companies c ON c.id = o.company_id
     WHERE o.mission_id = ? ORDER BY o.rank IS NULL, o.rank`,
  )
  .all(mission.id);

console.log('ETAT DE REVUE');
for (const r of rows) {
  const review = r.review ? JSON.parse(r.review) : null;
  const decision = review?.decision ?? 'PENDING_REVIEW';
  const qual = r.qualification ? JSON.parse(r.qualification) : null;
  console.log(`\n  ${r.name}`);
  console.log(`    rang        ${r.rank ?? '-'}`);
  console.log(`    stade       ${r.stage}`);
  console.log(`    score       ${r.score ?? '-'}`);
  console.log(`    verdict     ${qual?.verdict ?? '-'}`);
  console.log(`    revue       ${decision}`);
  if (r.justification) console.log(`    classement  ${String(r.justification).slice(0, 160)}`);

  const nat = db
    .prepare(
      `SELECT nature, COUNT(*) n, SUM(CASE WHEN source_ref IS NOT NULL THEN 1 ELSE 0 END) sourced
       FROM evidence WHERE opportunity_id = ? GROUP BY nature`,
    )
    .all(r.id);
  const parts = nat.map((x) => `${x.nature} ${x.n} (${x.sourced} sourcees)`);
  console.log(`    preuves     ${parts.join(' · ') || 'aucune'}`);
}

const totals = db
  .prepare(
    `SELECT nature, COUNT(*) n, SUM(simulated) sim FROM evidence WHERE mission_id = ? GROUP BY nature`,
  )
  .all(mission.id);
console.log('\nVENTILATION GLOBALE');
for (const t of totals) console.log(`  ${t.nature.padEnd(10)} ${t.n}  simulees=${t.sim}`);

const artifacts = db.prepare(`SELECT result FROM missions WHERE id = ?`).get(mission.id);
const result = artifacts.result ? JSON.parse(artifacts.result) : null;
console.log(`\nRAPPORT FINAL  ${result?.artifacts?.length ?? 0} artefact(s)`);
if (result?.summary) console.log(`  ${String(result.summary).slice(0, 400)}`);

db.close();
