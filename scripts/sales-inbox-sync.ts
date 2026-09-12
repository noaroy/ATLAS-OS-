/**
 * Relier la boîte de réception aux conversations commerciales.
 *
 * Lecture seule, de bout en bout : le fournisseur n'expose aucun envoi, la
 * classification est déterministe, et rien n'est écrit dans la messagerie.
 *
 * Trois garanties comptent ici, et chacune existe parce que son absence
 * produirait une erreur silencieuse :
 *
 *   · un message déjà lu n'est jamais réimporté — sinon une entreprise aurait
 *     répondu deux fois, au moment précis où l'on commence à s'y fier ;
 *   · une réponse qu'on ne sait pas rattacher n'est attribuée à personne —
 *     une réponse mal rattachée fait relancer quelqu'un qui avait dit non ;
 *   · aucun état commercial n'est déduit — `INTERESTED`, `WON`, `LOST`
 *     restent posés par un humain.
 *
 *   npm run sales:inbox-sync              boîte Gmail réelle
 *   npm run sales:inbox-sync -- --fixture fixtures/inbox.json
 */
import { readFileSync } from 'node:fs';
import { createLogger, canonicalDomainOf, loadAtlasEnv } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import {
  GmailInboxProvider,
  MAX_MESSAGES_PER_SYNC,
  FixtureInboxProvider,
  type MailInboxProvider,
  type MailMessage,
} from '../packages/intelligence/src/index.ts';
import {
  classifyInbound,
  matchIncoming,
  directionOf,
  type InboundKind,
  type MatchCandidate,
} from '../packages/departments/src/index.ts';

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
const has = (name: string) => process.argv.includes(`--${name}`);

const logger = createLogger({ level: 'error', pretty: false });
const fixturePath = flag('fixture');
const dbPath = process.env.ATLAS_DB_PATH ?? 'data/atlas.db';

/**
 * Une boîte figée n'écrit pas dans la base de production.
 *
 * La première répétition à blanc a inscrit trois événements de démonstration
 * dans la vraie base : la boîte commerciale a affiché un rebond, une absence
 * et une réponse qui n'avaient jamais eu lieu. Les données étaient fausses au
 * moment précis où l'on commence à s'y fier — exactement ce que tout ce module
 * cherche à éviter.
 *
 * Le refus est donc dans le chemin par défaut, pas dans la vigilance de celui
 * qui lance la commande.
 */
if (fixturePath && !process.env.ATLAS_DB_PATH && !has('allow-production')) {
  console.error('');
  console.error(`  Refus : une boîte figée écrirait dans « ${dbPath} », la base de production.`);
  console.error('  Des événements de démonstration y deviendraient des faits commerciaux.');
  console.error('');
  console.error('  Pointez ailleurs :');
  console.error('    ATLAS_DB_PATH=/tmp/atlas-demo.db npm run sales:inbox-sync -- --fixture=…');
  console.error('');
  console.error('  Ou, si c’est vraiment voulu : --allow-production');
  console.error('');
  process.exit(2);
}

const repos = createRepositories(dbPath, logger);
const provider: MailInboxProvider = fixturePath
  ? new FixtureInboxProvider(JSON.parse(readFileSync(fixturePath, 'utf8')) as MailMessage[])
  : new GmailInboxProvider({ logger });

const status = provider.status();
console.log(`\n  ${c.bold}SALES INBOX SYNC${c.reset}  ${c.dim}lecture seule · aucun message envoyé${c.reset}`);
console.log(`  fournisseur : ${provider.id} · ${status.code} · ${status.detail}`);
console.log(`  portées     : ${status.scopes.join(', ')}\n`);

if (!status.configured) {
  // Une messagerie non configurée n'est pas une panne : c'est l'état par
  // défaut d'une machine neuve. On le dit, on explique quoi renseigner, et
  // on s'arrête sans rien casser.
  console.log(`  ${c.amber}${status.code}${c.reset} — la synchronisation n'a pas eu lieu.`);
  console.log('  Renseignez dans l’environnement, jamais dans le dépôt :');
  console.log('    GMAIL_CLIENT_ID · GMAIL_CLIENT_SECRET · GMAIL_REFRESH_TOKEN · GMAIL_USER');
  console.log('  Le consentement doit porter la seule portée gmail.readonly.\n');
  console.log('  Pour répéter à blanc : npm run sales:inbox-sync -- --fixture=<fichier.json>\n');
  console.log('  MESSAGES SENT: 0\n');
  repos.close();
  process.exit(0);
}

// Les entreprises à qui l'on a écrit, avec ce qu'il faut pour rapprocher.
const candidates: MatchCandidate[] = repos.conversations.all().map((conversation) => ({
  canonicalDomain: conversation.canonicalDomain,
  companyName: conversation.companyName,
  outreachDestination: conversation.destination,
  knownThreadIds: repos.conversations.knownThreadIds(conversation.id),
  knownMessageIds: repos.conversations.knownMessageIds(conversation.id),
}));

if (candidates.length === 0) {
  console.log(`  ${c.amber}Aucune conversation ouverte.${c.reset} Lancez d'abord : npm run sales:inbox -- sync\n`);
  repos.close();
  process.exit(0);
}

/**
 * D'où reprendre.
 *
 * Le curseur est persisté par boîte : sans lui, chaque passage relisait les
 * cinquante messages les plus récents et une réponse arrivée en
 * cinquante-et-unième position n'était jamais lue — ni ce jour-là, ni jamais.
 *
 * Un recouvrement volontaire est retranché de la reprise. Deux raisons : les
 * horloges d'expédition ne sont pas les nôtres, et Gmail date un message à sa
 * réception, si bien qu'un courrier retardé peut apparaître avec un horodatage
 * antérieur au dernier traité. Relire un peu trop coûte quelques appels ; le
 * journal d'import écarte les doublons. Relire trop peu perd une réponse.
 */
const OVERLAP_MS = 6 * 60 * 60 * 1000;

/** Sans curseur, on remonte volontairement loin : « jamais lu » n'est pas « à jour ». */
const PREMIER_PASSAGE_JOURS = 30;

/**
 * L'identite de la boite, lue a la source.
 *
 * `GMAIL_USER` fait foi : c'est l'adresse dont le jeton porte les droits. Le
 * detail affiche par le fournisseur sert de repli, mais une garde de securite
 * ne doit pas dependre du formatage d'une phrase destinee a etre lue.
 */
const boiteSurveillee = process.env.GMAIL_USER?.trim()
  ?? status.detail.replace(/^bo[iî]te\s+/i, '').trim();
const mailbox = boiteSurveillee || 'inconnue';
const checkpoint = repos.conversations.syncCheckpoint(provider.id, mailbox);
const depuis = flag('since')
  ?? (checkpoint
    ? new Date(Date.parse(checkpoint.lastReceivedAt) - OVERLAP_MS).toISOString()
    : new Date(Date.now() - PREMIER_PASSAGE_JOURS * 86_400_000).toISOString());

console.log(
  `  reprise     : ${checkpoint ? `depuis ${depuis.slice(0, 16).replace('T', ' ')} `
    + `(curseur ${checkpoint.lastReceivedAt.slice(0, 16).replace('T', ' ')}, recouvrement 6 h)`
    : `aucun curseur — premier passage, ${PREMIER_PASSAGE_JOURS} derniers jours`}\n`,
);

const messages = await provider.list({
  since: depuis,
  max: Number(flag('max') ?? MAX_MESSAGES_PER_SYNC),
});

let scanned = 0;
let matched = 0;
let newEvents = 0;
let duplicates = 0;
let unmatched = 0;
let sortants = 0;
const byClassification = new Map<string, number>();

for (const message of messages) {
  scanned += 1;

  const seen = repos.conversations.alreadyImported(provider.id, message.messageId);
  if (seen) {
    duplicates += 1;
    continue;
  }

  /**
   * La direction, avant tout rapprochement.
   *
   * Placee ici et pas ailleurs : le rapprochement se fait par fil, et le fil
   * nous est connu parce que *nous* l'avons ouvert. Nos propres courriers de
   * prospection y correspondaient donc parfaitement, et revenaient classes
   * REPLIED. Quatre entreprises figuraient au tableau des reponses a traiter
   * alors que leur seul message etait le notre.
   *
   * Le message sortant est journalise comme ignore, jamais efface : le registre
   * d'import doit dire qu'on l'a vu et pourquoi on l'a ecarte.
   */
  const sens = directionOf({
    from: message.from, labels: message.labels, mailbox: boiteSurveillee,
  });
  if (sens.direction === 'OUTBOUND') {
    sortants += 1;
    repos.conversations.logImport({
      provider: provider.id,
      externalMessageId: message.messageId,
      externalThreadId: message.threadId,
      disposition: 'IGNORED',
      matchMethod: 'DIRECTION',
      conversationId: null,
      eventId: null,
      reason: `message sortant : ${sens.reason}`,
      fromAddress: message.from,
      subject: message.subject,
      receivedAt: message.receivedAt,
    });
    continue;
  }

  const match = matchIncoming(
    {
      from: message.from, to: message.to, threadId: message.threadId,
      headers: message.headers, bodyText: message.bodyText ?? message.snippet,
    },
    candidates,
  );

  if (!match.candidate) {
    unmatched += 1;
    repos.conversations.logImport({
      provider: provider.id,
      externalMessageId: message.messageId,
      externalThreadId: message.threadId,
      disposition: 'UNMATCHED',
      matchMethod: null,
      conversationId: null,
      eventId: null,
      reason: match.reason,
      fromAddress: message.from,
      toAddress: message.to.join(', '),
      subject: message.subject,
      receivedAt: message.receivedAt,
    });
    console.log(
      `  ${c.dim}non rattaché${c.reset} ${(message.subject ?? '(sans objet)').slice(0, 34).padEnd(36)}` +
        `${c.dim}${match.reason.slice(0, 60)}${c.reset}`,
    );
    continue;
  }

  matched += 1;
  const conversation = repos.conversations.byDomain(match.candidate.canonicalDomain)!;

  // La classification est celle du Reply Intake : les mêmes règles pour un
  // message lu dans Gmail que pour un message saisi à la main.
  const verdict = classifyInbound({
    kind: 'EMAIL_REPLY',
    subject: message.subject,
    sender: message.from,
    body: message.bodyText ?? message.snippet,
    receivedAt: message.receivedAt,
  });

  const event = repos.conversations.recordInboundEvent({
    conversationId: conversation.id,
    kind: (verdict.classification === 'BOUNCED'
      ? 'BOUNCE'
      : verdict.classification === 'AUTO_REPLY'
        ? 'AUTO_REPLY'
        : 'EMAIL_REPLY') as InboundKind,
    classification: verdict.classification,
    confidence: verdict.confidence,
    occurredAt: message.receivedAt,
    source: `${provider.id} (${match.method})`,
    rawSubject: message.subject,
    sender: message.from,
    bodyExcerpt: message.bodyText ?? message.snippet,
    signals: verdict.signals,
    returnDate: verdict.returnDate,
    // Jamais relu par un humain à ce stade, donc jamais d'état commercial.
    humanReviewed: false,
    declaredStatus: null,
    externalMessageId: message.messageId,
    externalThreadId: message.threadId,
  });
  newEvents += 1;
  byClassification.set(
    verdict.classification,
    (byClassification.get(verdict.classification) ?? 0) + 1,
  );

  repos.conversations.logImport({
    provider: provider.id,
    externalMessageId: message.messageId,
    externalThreadId: message.threadId,
    disposition: 'IMPORTED',
    matchMethod: match.method,
    conversationId: conversation.id,
    eventId: event.id,
    reason: match.reason,
    fromAddress: message.from,
    toAddress: message.to.join(', '),
    subject: message.subject,
    receivedAt: message.receivedAt,
  });

  const colour =
    verdict.classification === 'BOUNCED' ? c.red
    : verdict.classification === 'REPLIED' ? c.green
    : c.amber;
  console.log(
    `  ${colour}${verdict.classification.padEnd(13)}${c.reset}` +
      `${conversation.companyName.slice(0, 22).padEnd(24)}` +
      `${c.dim}${match.method} · ${(message.subject ?? '').slice(0, 40)}${c.reset}`,
  );
}

console.log('');
/**
 * Le curseur n'avance qu'ici — la boucle est terminée, tout a été traité.
 *
 * L'avancer message par message rendrait un plantage en cours de pagination
 * indiscernable d'une synchronisation réussie : le curseur serait au-delà de ce
 * qui a été traité, et les messages sautés ne seraient jamais relus. Un trou
 * permanent, et sans trace. Ici, un plantage laisse le curseur en place ; la
 * fenêtre est relue au passage suivant et le journal d'import écarte les
 * doublons.
 */
if (messages.length > 0) {
  const plusRecent = messages
    .map((m) => m.receivedAt)
    .reduce((a, b) => (a >= b ? a : b));
  repos.conversations.advanceSyncCheckpoint({
    provider: provider.id,
    mailbox,
    lastReceivedAt: plusRecent,
    messagesSeen: scanned,
  });
}

console.log(`  EMAILS SCANNED       ${scanned}`);
console.log(`  NOS PROPRES ENVOIS   ${sortants}  ${c.dim}(ecartes : jamais des reponses)${c.reset}`);
console.log(`  MATCHED TO OUTREACH  ${matched}`);
console.log(`  NEW EVENTS           ${newEvents}`);
console.log(`  DUPLICATES SKIPPED   ${duplicates}`);
console.log(`  UNMATCHED            ${unmatched}`);
console.log(`  BOUNCES              ${byClassification.get('BOUNCED') ?? 0}`);
console.log(`  AUTO REPLIES         ${byClassification.get('AUTO_REPLY') ?? 0}`);
console.log(`  HUMAN REPLIES        ${byClassification.get('REPLIED') ?? 0}`);
const review = byClassification.get('NEEDS_REVIEW') ?? 0;
if (review > 0 || unmatched > 0) {
  console.log(`  ${c.amber}À LIRE               ${review + unmatched}${c.reset}  ${c.dim}(non classés ou non rattachés)${c.reset}`);
}
console.log('');
console.log('  MESSAGES SENT: 0');
console.log('');
if (has('verbose')) console.log(`  ${c.dim}npm run sales:inbox pour la boîte commerciale.${c.reset}\n`);

repos.close();
