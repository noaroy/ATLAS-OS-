/**
 * Refermer les brouillons restés « prêts à partir » sans l'être.
 *
 * Deux familles, et la distinction se déduit des données plutôt qu'elle ne se
 * décrète. Un brouillon dont le message correspondant est réellement parti doit
 * porter `SENT` : laissé en `APPROVED_TO_SEND`, il compte indéfiniment dans la
 * file des envois en attente alors qu'il est parti. Un brouillon sans envoi
 * correspondant est caduc — celui-là est un vestige de la simulation fautive
 * qui créait et approuvait avant de vérifier qu'elle était une simulation.
 *
 * Le rapprochement se fait par proximité : le script d'envoi crée le brouillon
 * puis expédie dans la seconde qui suit. Un brouillon suivi d'un envoi vers le
 * même domaine dans la minute est celui qui l'a produit ; sans envoi dans cette
 * fenêtre, rien n'est parti.
 *
 * Rien n'est supprimé, rien n'est réécrit : chaque changement d'état passe par
 * une décision consignée dans `outreach_draft_decisions`.
 *
 *   npm run sales:repair-drafts            montre
 *   npm run sales:repair-drafts -- --apply écrit
 */
import Database from 'better-sqlite3';
import { createLogger, loadConfig, loadAtlasEnv } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';

loadAtlasEnv();

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', amber: '\x1b[33m',
};

const APPLY = process.argv.includes('--apply');
const MOTIF = 'STALE_DRY_RUN_DRAFT — brouillon créé par la simulation fautive avant '
  + 'correction ; l’envoi réel correspondant a ensuite été effectué et consigné';

/** La fenêtre dans laquelle un envoi peut être attribué à un brouillon. */
const FENETRE_MS = 60_000;

const config = loadConfig(process.cwd());
const repos = createRepositories(config.paths.databaseFile,
  createLogger({ level: 'error', pretty: false }));

const lecture = new Database(config.paths.databaseFile, { readonly: true });
const brouillons = lecture
  .prepare('SELECT id, domain, state, created_at FROM outreach_drafts ORDER BY created_at')
  .all() as Array<{ id: string; domain: string; state: string; created_at: string }>;
const envois = lecture
  .prepare(
    `SELECT s.domain, e.occurred_at, e.external_message_id
       FROM outbound_send_events e
       JOIN outbound_sends s ON s.idempotency_key = e.idempotency_key
      WHERE e.phase = 'SENT'`,
  )
  .all() as Array<{ domain: string; occurred_at: string; external_message_id: string | null }>;
lecture.close();

console.log(`\n  ${c.bold}BROUILLONS RÉSIDUELS${c.reset}`);
console.log(`  ${c.dim}${APPLY ? 'écriture réelle' : 'simulation — --apply pour écrire'}${c.reset}\n`);

let envoyes = 0;
let abandonnes = 0;
let intacts = 0;

for (const brouillon of brouillons) {
  if (brouillon.state === 'SENT' || brouillon.state === 'ABANDONED' || brouillon.state === 'REJECTED') {
    intacts += 1;
    continue;
  }

  // L'envoi qui suit ce brouillon de moins d'une minute, vers le même domaine.
  const naissance = Date.parse(brouillon.created_at);
  const envoi = envois.find((e) => e.domain === brouillon.domain
    && Date.parse(e.occurred_at) >= naissance
    && Date.parse(e.occurred_at) - naissance <= FENETRE_MS);

  if (envoi) {
    console.log(
      `  ${c.green}ENVOYÉ${c.reset}     ${brouillon.domain.padEnd(20)} `
      + `${c.dim}message ${envoi.external_message_id} le ${envoi.occurred_at.slice(11, 19)}${c.reset}`,
    );
    if (APPLY) {
      repos.salesLoop.markDraftSent(brouillon.id);
      envoyes += 1;
    }
    continue;
  }

  console.log(
    `  ${c.amber}ABANDONNÉ${c.reset}  ${brouillon.domain.padEnd(20)} `
    + `${c.dim}créé le ${brouillon.created_at.slice(11, 19)}, aucun envoi dans la minute${c.reset}`,
  );
  if (APPLY) {
    const decision = repos.salesLoop.decideDraft({
      draftId: brouillon.id,
      decision: 'ABANDONED',
      decidedBy: 'proprietaire',
      note: MOTIF,
    });
    if (!decision.applied) {
      console.log(`     ${c.red}refusé${c.reset} : ${decision.reason}`);
      continue;
    }
    abandonnes += 1;
  }
}

console.log(`\n  ${c.bold}RÉSULTAT${c.reset}`);
console.log(`    marqués envoyés   ${APPLY ? envoyes : '(simulation)'}`);
console.log(`    abandonnés        ${APPLY ? abandonnes : '(simulation)'}`);
console.log(`    déjà refermés     ${intacts}`);

const restants = repos.salesLoop.draftsInState('READY_FOR_APPROVAL').length
  + repos.salesLoop.draftsInState('APPROVED_TO_SEND').length;
console.log(`\n  ${restants === 0 ? c.green : c.amber}brouillons ouverts : ${restants}${c.reset}`);
console.log(`  ${c.dim}MESSAGES SENT: 0 — ce script n'envoie rien.${c.reset}\n`);
repos.close();
