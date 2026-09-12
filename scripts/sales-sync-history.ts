/**
 * Faire entrer les envois manuels dans la mémoire de la boucle.
 *
 * Le registre d'outreach savait déjà à qui on avait écrit ; la boucle, elle, ne
 * le savait pas. D'où un tableau de bord où l'entonnoir affichait zéro partout
 * alors que treize entreprises avaient reçu un message, et une relance annoncée
 * comme due pour Groupe JLF alors qu'elle était déjà partie.
 *
 * Un compteur qui ment par omission est pire qu'un compteur absent : il donne
 * l'assurance qu'il n'y a rien à faire.
 *
 * Deux règles tiennent ce script :
 *
 * 1. **Rien n'est inventé.** Un envoi n'est consigné comme tel que si l'adresse
 *    écrite est connue et ressemble à une adresse. Là où le canal enregistré est
 *    un téléphone ou un formulaire, seule la transition d'état est écrite — le
 *    message est bien parti, mais pas vers une adresse qu'on pourrait citer.
 * 2. **Rejouable.** Les transitions déjà posées sont sautées, et la réservation
 *    d'envoi refuse d'elle-même le doublon. Relancer ce script ne crée rien.
 *
 *   sales-sync-history --dry-run     montre ce qui serait écrit
 *   sales-sync-history --by=noaroy   écrit
 */
import { createLogger, canonicalDomainOf, loadAtlasEnv } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import { canTransitionLoop, type LoopState } from '../packages/departments/src/index.ts';

// Avant toute lecture de process.env : sans cet appel, `.env.local` n'existe
// pas pour ce processus et la configuration parait absente sans qu'aucune
// erreur ne le dise.
loadAtlasEnv();

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m',
};

const flag = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const dryRun = process.argv.includes('--dry-run');
const by = flag('by') ?? 'saisie-manuelle';

const logger = createLogger({ level: 'error', pretty: false });
const repos = createRepositories(process.env.ATLAS_DB_PATH ?? 'data/atlas.db', logger);

/**
 * Les adresses relevées ailleurs que dans les conversations.
 *
 * Ardes Solution et AeroXSense ont été contactées avant l'ouverture des fils :
 * leur adresse ne figure que dans la note du registre. La recopier ici est une
 * transcription, pas une déduction.
 */
const KNOWN_ADDRESSES: Record<string, string> = {
  'ardes-solution.com': 'contact@ardes-solution.com',
  'aeroxsense.com': 'info@aeroxsense.com',
};

/** La relance réellement partie, à consigner en plus du premier message. */
const FOLLOW_UPS: Array<{ domain: string; recipient: string; on: string }> = [
  { domain: 'groupe-jlf.com', recipient: 'info@groupe-jlf.com', on: '2026-08-24' },
];

const looksLikeEmail = (value: string | null): value is string =>
  Boolean(value && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value.trim()));

/**
 * Le chemin complet, SENDING compris.
 *
 * Il manquait d'abord cette etape, et les treize entreprises se sont arretees
 * a APPROVED_TO_SEND : le tableau de bord annoncait alors treize messages
 * approuves en attente d'envoi, ce qui etait faux et alarmant. La machine a
 * etats avait raison de refuser le raccourci ; c'est le chemin qui etait
 * incomplet.
 */
const PATH: LoopState[] = [
  'QUALIFYING', 'READY_FOR_APPROVAL', 'APPROVED_TO_SEND', 'SENDING', 'CONTACTED',
];

/**
 * Amener un domaine jusqu'a CONTACTED, en reprenant ou il en est.
 *
 * Le parcours ne repart pas du debut : un domaine deja arrive a
 * APPROVED_TO_SEND se verrait refuser un retour vers QUALIFYING, et le script
 * echouerait exactement sur les cas qu'il doit rattraper. On cherche donc la
 * position courante dans le chemin, et on poursuit a partir de la.
 */
function bringToContacted(domain: string, note: string): 'posé' | 'déjà en place' | 'refusé' {
  const current = repos.salesLoop.currentState(domain) as LoopState | null;
  if (current === 'CONTACTED' || current === 'REPLIED' || current === 'BLOCKED') {
    return 'déjà en place';
  }
  const from = current === null ? -1 : PATH.indexOf(current);
  if (current !== null && from === -1) return 'refusé';

  for (const step of PATH.slice(from + 1)) {
    const here = repos.salesLoop.currentState(domain) as LoopState | null;
    const check = canTransitionLoop(here, step);
    if (!check.allowed) return 'refusé';
    if (dryRun) return 'posé';
    repos.salesLoop.recordTransition({
      domain, fromState: here, toState: step, reason: note, actor: by,
    });
  }
  return 'posé';
}

console.log(`\n  ${c.bold}SYNCHRONISATION DE L'HISTORIQUE MANUEL${c.reset}`);
if (dryRun) console.log(`  ${c.amber}simulation — rien n'est écrit${c.reset}`);
console.log();

const conversations = new Map(
  repos.conversations.all().map((conv) => [conv.canonicalDomain, conv]),
);

let transitions = 0;
let sends = 0;
let skipped = 0;

for (const entry of repos.sales.ledgerDomains()) {
  const domain = canonicalDomainOf(entry.domain);
  if (entry.kind !== 'CONTACTED') {
    console.log(`  ${c.dim}—     ${domain.padEnd(24)}${entry.kind} : hors périmètre${c.reset}`);
    continue;
  }

  const outcome = bringToContacted(domain, entry.note ?? 'envoi manuel consigné a posteriori');
  if (outcome === 'posé') transitions += 1;

  // L'envoi lui-même n'est consigné que si l'on sait vers quelle adresse.
  const conversation = conversations.get(domain);
  const address = KNOWN_ADDRESSES[domain]
    ?? (looksLikeEmail(conversation?.destination ?? null) ? conversation!.destination! : null);

  if (!address) {
    skipped += 1;
    console.log(
      `  ${c.amber}ÉTAT${c.reset}  ${domain.padEnd(24)}${outcome.padEnd(16)}` +
        `${c.dim}canal non-courriel : envoi non consigné${c.reset}`,
    );
    continue;
  }

  const subject = `Premier message — ${conversation?.companyName ?? domain}`;
  const body = `Envoi manuel consigné a posteriori. Canal : ${address}.`;
  const claim = dryRun
    ? { claimed: true, idempotencyKey: 'simulation', reason: 'simulation' }
    : repos.salesLoop.claimSend({
        domain,
        conversationId: conversation?.id ?? null,
        recipient: address,
        subject,
        body,
        purpose: 'FIRST_TOUCH',
        claimedBy: by,
      });

  if (!claim.claimed) {
    console.log(`  ${c.dim}—     ${domain.padEnd(24)}${claim.reason}${c.reset}`);
    continue;
  }
  if (!dryRun) {
    repos.salesLoop.recordSendResult({
      idempotencyKey: claim.idempotencyKey,
      phase: 'SENT',
      externalMessageId: null,
      externalThreadId: null,
    });
  }
  sends += 1;
  console.log(
    `  ${c.green}ENVOI${c.reset} ${domain.padEnd(24)}${outcome.padEnd(16)}${c.dim}${address}${c.reset}`,
  );
}

// --- Les relances réellement parties ---------------------------------------

console.log();
for (const followUp of FOLLOW_UPS) {
  const domain = canonicalDomainOf(followUp.domain);
  const already = repos.salesLoop.followUpsFor(domain);
  if (already > 0) {
    console.log(`  ${c.dim}—     ${domain.padEnd(24)}relance déjà consignée${c.reset}`);
    continue;
  }
  const claim = dryRun
    ? { claimed: true, idempotencyKey: 'simulation', reason: 'simulation' }
    : repos.salesLoop.claimSend({
        domain,
        conversationId: conversations.get(domain)?.id ?? null,
        recipient: followUp.recipient,
        subject: 'Relance',
        body: `Relance manuelle envoyée le ${followUp.on}.`,
        purpose: 'FOLLOW_UP',
        claimedBy: by,
      });
  if (!claim.claimed) {
    console.log(`  ${c.dim}—     ${domain.padEnd(24)}${claim.reason}${c.reset}`);
    continue;
  }
  if (!dryRun) {
    repos.salesLoop.recordSendResult({ idempotencyKey: claim.idempotencyKey, phase: 'SENT' });
  }
  console.log(
    `  ${c.green}RELANCE${c.reset} ${domain.padEnd(22)}${followUp.on}  ${c.dim}${followUp.recipient}${c.reset}`,
  );
}

console.log(
  `\n  ${transitions} état(s) posé(s) · ${sends} envoi(s) consigné(s) · ` +
    `${skipped} sans adresse citable`,
);
console.log(`  ${c.dim}Append-only : relancer ce script ne crée rien de neuf.${c.reset}`);
console.log(`  ${c.dim}MESSAGES SENT: 0 — aucun message n'a été émis par cette commande.${c.reset}\n`);

repos.close();
