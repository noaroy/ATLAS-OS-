/**
 * Révoque une approbation qui n'aurait pas dû être donnée.
 *
 *   node scripts/revoke-approval.mjs <reportId>           constate
 *   node scripts/revoke-approval.mjs <reportId> --apply   révoque
 *
 * Le 18 août, une approbation a été posée par la machine alors que le fondateur
 * avait explicitement demandé à lancer la commande lui-même. Une signature de
 * relecture qui ne correspond à aucune relecture est pire qu'une absence de
 * signature : elle fait croire que quelqu'un a ouvert les URL et relu les
 * traductions.
 *
 * La révocation emprunte le chemin légal de la machine à états —
 * APPROVED_FOR_DELIVERY → REJECTED → PENDING_REVIEW — pour que l'anomalie reste
 * lisible dans l'historique. Seul le nom du relecteur et l'horodatage sont
 * effacés directement : ils ne peuvent pas rester, et aucune transition ne sait
 * les retirer.
 */
import Database from 'better-sqlite3';

const reportId = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!reportId) {
  console.error('Usage : node scripts/revoke-approval.mjs <reportId> [--apply]');
  process.exit(1);
}

const db = new Database('data/atlas.db');
const row = db.prepare('SELECT * FROM client_reports WHERE id = ?').get(reportId);
if (!row) {
  console.error(`Rapport « ${reportId} » introuvable.`);
  process.exit(1);
}

console.log(`\n  ${row.id}`);
console.log(`    état actuel   ${row.state}`);
console.log(`    relecteur     ${row.reviewer ?? '—'}`);
console.log(`    approuvé le   ${row.approved_at ?? '—'}`);
console.log(`    points cochés ${row.review_passed}`);

if (row.state !== 'APPROVED_FOR_DELIVERY') {
  console.log(`\n  Rien à révoquer : le rapport n'est pas approuvé.\n`);
  process.exit(0);
}

if (!APPLY) {
  console.log(`\n  Révocation : APPROVED_FOR_DELIVERY → REJECTED → PENDING_REVIEW`);
  console.log(`  Le relecteur et l'horodatage seront effacés.`);
  console.log(`  Relancez avec --apply.\n`);
  process.exit(0);
}

const now = new Date().toISOString();
const note =
  'Approbation révoquée : posée par la machine alors que la relecture humaine ' +
  'était explicitement réservée au fondateur. Aucune URL n’avait été ouverte, ' +
  'aucune traduction relue.';

db.transaction(() => {
  // Le chemin légal, pour que l'anomalie figure dans l'historique.
  db.prepare("UPDATE client_reports SET state = 'REJECTED', review_notes = ?, updated_at = ? WHERE id = ?")
    .run(note, now, reportId);
  db.prepare("UPDATE client_reports SET state = 'PENDING_REVIEW', updated_at = ? WHERE id = ?")
    .run(now, reportId);
  // La signature, elle, ne peut pas rester : aucune transition ne la retire, et
  // la laisser ferait croire à une relecture qui n'a pas eu lieu.
  db.prepare(
    "UPDATE client_reports SET reviewer = NULL, approved_at = NULL, review_passed = '[]' WHERE id = ?",
  ).run(reportId);
})();

const after = db.prepare('SELECT state, reviewer, approved_at, review_passed FROM client_reports WHERE id = ?').get(reportId);
console.log(`\n  Révoquée.`);
console.log(`    état          ${after.state}`);
console.log(`    relecteur     ${after.reviewer ?? '—'}`);
console.log(`    approuvé le   ${after.approved_at ?? '—'}`);
console.log(`    points cochés ${after.review_passed}\n`);
db.close();
