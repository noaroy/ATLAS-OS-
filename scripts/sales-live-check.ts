/**
 * Le contrôle avant un premier envoi réel.
 *
 * Un verrou qu'on croit fermé est plus dangereux qu'un verrou ouvert : on
 * n'inspecte pas ce dont on est sûr. Cette commande ne fait donc aucune
 * confiance à la configuration lue — elle interroge chaque garde et rapporte
 * ce qu'elle répond, y compris quand la réponse est « je ne sais pas ».
 *
 * Aucune action, aucun envoi, aucun appel de modèle. Deux appels réseau au
 * plus, en lecture : l'état de la messagerie et celui du moteur de recherche.
 *
 *   npm run sales:live-check
 */
import { createLogger, loadConfig } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import { GmailInboxProvider } from '../packages/intelligence/src/mail/gmail.ts';
import { GmailOutboundProvider } from '../packages/intelligence/src/mail/outbound.ts';
import { evaluateFollowUp, deriveConversationState } from '../packages/departments/src/index.ts';
import type { ConversationEvent, ConversationStatus } from '../packages/departments/src/index.ts';

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};

const flag = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const logger = createLogger({ level: 'error', pretty: false });
const config = loadConfig(process.cwd());
const repos = createRepositories(config.paths.databaseFile, logger);
const today = flag('today') ?? new Date().toISOString().slice(0, 10);

type Verdict = 'OK' | 'ATTENTION' | 'BLOQUANT' | 'INFO';

const checks: Array<{ name: string; verdict: Verdict; detail: string }> = [];
const add = (name: string, verdict: Verdict, detail: string) =>
  checks.push({ name, verdict, detail });

// --- Messagerie -------------------------------------------------------------

const inbox = new GmailInboxProvider({ logger });
const inboxStatus = inbox.status();
add(
  'GMAIL READ',
  inboxStatus.configured ? 'OK' : 'ATTENTION',
  inboxStatus.configured
    ? `${inboxStatus.detail} — lecture des réponses possible`
    : `${inboxStatus.detail} — les réponses devront être saisies à la main`,
);

/**
 * La portée d'envoi n'est jamais devinée depuis la configuration.
 *
 * La connaître exigerait d'échanger le jeton, donc d'appeler Google avec un
 * jeton dont on ignore les droits. On construit le fournisseur sans portée
 * déclarée : il répond ce qu'il ferait, et ce qu'il ferait est refuser.
 */
const outbound = new GmailOutboundProvider({});
const outboundStatus = outbound.status();
add(
  'GMAIL SEND AUTH',
  'BLOQUANT',
  `${outboundStatus.code} — portée d'envoi non accordée, envoi impossible`,
);

// --- Moteur de recherche ----------------------------------------------------

const searxng = config.search.searxngBaseUrl?.trim();
if (!searxng) {
  add('SEARXNG HEALTH', 'ATTENTION', 'aucune instance configurée : la découverte est impossible');
} else {
  try {
    const response = await fetch(`${searxng.replace(/\/+$/, '')}/healthz`, {
      signal: AbortSignal.timeout(5_000),
    });
    add(
      'SEARXNG HEALTH',
      response.ok ? 'OK' : 'ATTENTION',
      response.ok ? `${searxng} répond` : `${searxng} répond HTTP ${response.status}`,
    );
  } catch (error) {
    add(
      'SEARXNG HEALTH',
      'ATTENTION',
      `${searxng} injoignable — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// --- Registre ---------------------------------------------------------------

const ledger = repos.sales.ledgerDomains();
const contacted = ledger.filter((entry) => entry.kind === 'CONTACTED');
const doNotContact = ledger.filter((entry) => entry.kind === 'DO_NOT_CONTACT');
const loopStates = repos.salesLoop.stateCounts();
const inLoop = Object.values(loopStates).reduce((sum, n) => sum + n, 0);

/**
 * Le registre et la boucle doivent raconter la même histoire.
 *
 * Ils ont déjà divergé : treize entreprises contactées côté registre, zéro côté
 * boucle, et un tableau de bord qui annonçait des relances déjà parties. Un
 * écart ici n'est pas cosmétique — c'est ce qui produit un doublon.
 */
const drift = contacted.length - (loopStates.CONTACTED ?? 0)
  - (loopStates.REPLIED ?? 0) - (loopStates.BLOCKED ?? 0)
  - (loopStates.WAITING_REPLY ?? 0) - (loopStates.FOLLOW_UP_REQUIRED ?? 0);
add(
  'LEDGER HEALTH',
  drift === 0 ? 'OK' : 'ATTENTION',
  drift === 0
    ? `${ledger.length} entreprise(s), ${inLoop} suivie(s) par la boucle — cohérent`
    : `${drift} entreprise(s) contactée(s) au registre sans état de boucle : ` +
      'lancer npm run sales:sync-history',
);

// --- Ce qui attend une décision --------------------------------------------

const pending = repos.salesLoop.draftsInState('READY_FOR_APPROVAL');
add(
  'PENDING APPROVALS',
  'INFO',
  pending.length === 0
    ? 'aucun brouillon en attente'
    : `${pending.length} brouillon(s) à relire avant tout envoi`,
);

add(
  'DO_NOT_CONTACT COUNT',
  'INFO',
  `${doNotContact.length} domaine(s) définitivement écarté(s)`,
);

// --- Relances ---------------------------------------------------------------

let due = 0;
for (const conversation of repos.conversations.all()) {
  const events = repos.conversations.eventsFor(conversation.id).map((e) => ({
    kind: e.kind,
    classification: e.classification,
    occurredAt: e.occurredAt,
    returnDate: e.returnDate,
    humanReviewed: e.humanReviewed,
    declaredStatus: (e.declaredStatus as ConversationStatus | null) ?? null,
  })) as ConversationEvent[];
  const state = deriveConversationState(events, { today });
  const decision = evaluateFollowUp({
    domain: conversation.canonicalDomain,
    status: state.status,
    contactedOn: conversation.firstContactAt.slice(0, 10),
    followUpsSent: repos.salesLoop.followUpsFor(conversation.canonicalDomain),
    doNotContact: repos.sales.ledgerFor(conversation.canonicalDomain)?.kind === 'DO_NOT_CONTACT',
    afterBusinessDays: config.sales.followUpAfterDays,
    today,
  });
  if (decision.verdict === 'DUE') due += 1;
}
add('FOLLOW UPS DUE', 'INFO', `${due} relance(s) à préparer, chacune soumise à approbation`);

// --- La serrure anti-doublon ------------------------------------------------

/**
 * On ne se contente pas de lire que la garde existe : on la fait refuser.
 *
 * Une réservation est prise sur un domaine réservé aux essais, puis reprise à
 * l'identique. La seconde doit être refusée. C'est le seul contrôle de cette
 * commande qui écrit — dans une table append-only, sur un domaine qui ne
 * correspond à aucune entreprise réelle.
 */
const probeDomain = 'controle-avant-vol.invalid';
const probe = {
  domain: probeDomain,
  recipient: 'controle@controle-avant-vol.invalid',
  subject: 'Contrôle de la garde anti-doublon',
  body: 'Message de contrôle. Aucun envoi.',
  purpose: 'PREFLIGHT_PROBE',
  claimedBy: 'sales-live-check',
};
repos.salesLoop.claimSend(probe);
const second = repos.salesLoop.claimSend(probe);
add(
  'DUPLICATE SEND GUARD',
  second.claimed ? 'BLOQUANT' : 'OK',
  second.claimed
    ? 'la seconde réservation a été acceptée : la garde ne protège plus rien'
    : 'la seconde réservation du même message est refusée par la base',
);

// --- Le verrou d'approbation ------------------------------------------------

add(
  'HUMAN APPROVAL MODE',
  config.sales.humanApprovalRequired ? 'OK' : 'ATTENTION',
  config.sales.humanApprovalRequired
    ? 'exigée — aucun message ne part sans décision humaine'
    : 'DÉSACTIVÉE — des messages peuvent partir sans relecture',
);

// --- Rendu ------------------------------------------------------------------

// Le remplissage est calculé sur le mot, pas sur la chaîne colorée : les codes
// ANSI comptent dans `length` et décalent toute la colonne.
const COLOUR: Record<Verdict, string> = {
  OK: c.green, ATTENTION: c.amber, BLOQUANT: c.red, INFO: c.dim,
};
const mark = (verdict: Verdict) =>
  `${COLOUR[verdict]}${verdict.padEnd(9)}${c.reset}`;

console.log(`\n  ${c.bold}${c.cyan}CONTRÔLE AVANT ENVOI RÉEL${c.reset}  ${c.dim}au ${today}${c.reset}\n`);
for (const check of checks) {
  console.log(`  ${mark(check.verdict)} ${check.name.padEnd(22)}${check.detail}`);
}

const blocking = checks.filter((check) => check.verdict === 'BLOQUANT');
const ready = blocking.length === 0;

console.log(`\n  ${c.bold}READY FOR LIVE = ${ready ? `${c.green}YES` : `${c.red}NO`}${c.reset}`);
if (!ready) {
  console.log(`  ${c.dim}Bloquant(s) : ${blocking.map((b) => b.name).join(', ')}${c.reset}`);
  console.log(
    `  ${c.dim}La portée d'envoi Gmail doit être accordée par le propriétaire de la boîte.${c.reset}`,
  );
  console.log(`  ${c.dim}ATLAS ne la demande pas de lui-même et ne la contourne pas.${c.reset}`);
}
console.log(`\n  ${c.dim}MESSAGES SENT: 0 — cette commande n'envoie rien.${c.reset}\n`);

repos.close();
