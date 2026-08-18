/**
 * Ramène à `null` les compatibilités de rôle qui n'ont jamais été évaluées.
 *
 * Elles étaient écrites `0`, ce qui se lit comme une mesure défavorable alors
 * qu'aucune mesure n'a eu lieu — et le classement en tirait un conseil :
 * « Distributeur 0/100, Intégrateur 0/100. À approcher d'abord comme
 * Distributeur ». La recommandation reposait sur l'ordre du tableau.
 *
 * Le marqueur est sans ambiguïté : la justification que le scoring inscrivait
 * lui-même quand aucune note n'avait été fournie.
 */
import Database from 'better-sqlite3';

const APPLY = process.argv.includes('--apply');
const db = new Database('data/atlas.db');
const MARKER = "Ce rôle n'a pas été évalué séparément.";

const rows = db
  .prepare("SELECT id, score_detail FROM opportunities WHERE score_detail LIKE '%pas été évalué séparément%'")
  .all();

let touched = 0;
let fits = 0;
for (const row of rows) {
  const detail = JSON.parse(row.score_detail);
  let changed = false;
  for (const fit of detail.roleFits ?? []) {
    if (fit.rationale === MARKER && fit.value === 0) {
      fit.value = null;
      changed = true;
      fits++;
    }
  }
  if (!changed) continue;
  touched++;
  if (APPLY) {
    db.prepare('UPDATE opportunities SET score_detail = ? WHERE id = ?').run(
      JSON.stringify(detail),
      row.id,
    );
  }
}

console.log(`\n  ${fits} compatibilité(s) de rôle non évaluée(s) sur ${touched} opportunité(s)`);
console.log(`  ${APPLY ? 'Corrigées : 0 → null.' : 'Aucune modification. Relancez avec --apply.'}\n`);
db.close();
