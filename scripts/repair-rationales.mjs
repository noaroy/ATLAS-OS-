/**
 * Remplace les justifications de notation par leur version française relue.
 *
 *   node scripts/repair-rationales.mjs           constate
 *   node scripts/repair-rationales.mjs --apply   corrige
 *
 * Traduire au moment du rendu ne suffisait pas : le bloc « recommandation » est
 * composé par `explainScore` au moment du classement, à partir des
 * justifications **stockées**. L'anglais réapparaissait donc là, une section
 * plus bas, après avoir disparu du tableau de notation.
 *
 * La donnée est donc corrigée à la source, une fois. Tout rendu ultérieur en
 * hérite, et le classement rejoué — qui ne coûte aucun appel au modèle — s'en
 * sert pour reconstruire ses textes.
 *
 * Le fond n'est pas retouché : ce sont les mêmes constats, dans la même langue
 * que le reste du livrable. Aucun appel au modèle.
 */
import Database from 'better-sqlite3';
import { RATIONALE_TRANSLATIONS } from '../packages/departments/src/rationale-translations.ts';

const APPLY = process.argv.includes('--apply');
const db = new Database('data/atlas.db');

const byKey = new Map(RATIONALE_TRANSLATIONS.map((t) => [`${t.company}|${t.dimension}`, t.french]));

const rows = db
  .prepare(
    `SELECT o.id, c.name, o.score_detail
       FROM opportunities o JOIN companies c ON c.id = o.company_id
      WHERE o.score_detail IS NOT NULL`,
  )
  .all();

let touched = 0;
let replaced = 0;

for (const row of rows) {
  const detail = JSON.parse(row.score_detail);
  let changed = false;

  for (const component of detail.components ?? []) {
    const french = byKey.get(`${row.name}|${component.dimension}`);
    if (!french || component.rationale === french) continue;
    component.rationale = french;
    changed = true;
    replaced++;
  }

  if (!changed) continue;
  touched++;
  console.log(`  ${row.name}`);
  if (APPLY) {
    db.prepare('UPDATE opportunities SET score_detail = ? WHERE id = ?').run(
      JSON.stringify(detail),
      row.id,
    );
  }
}

console.log(`\n  ${replaced} justification(s) traduite(s) sur ${touched} candidat(s)`);
console.log(`  ${APPLY ? 'Appliquées.' : 'Aucune modification. Relancez avec --apply.'}\n`);
db.close();
