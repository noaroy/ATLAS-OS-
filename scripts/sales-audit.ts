/**
 * L'audit entreprise par entreprise, avant toute relance.
 *
 * Deux métriques mentaient encore après la réparation des directions, et pour
 * deux raisons opposées.
 *
 * Le taux de réponse se déduisait du seul état courant : ACRN, qui avait
 * répondu deux fois et à qui nous avions ensuite envoyé l'aperçu, cessait de
 * compter comme ayant répondu. Le tableau annonçait 0 % là où une conversation
 * réelle était engagée. Un état dit ce qu'il faut faire maintenant ; il ne dit
 * pas ce qui s'est passé, et confondre les deux efface l'histoire.
 *
 * Les relances, elles, se calculaient depuis le premier contact sans regarder
 * ce qui avait suivi. Une entreprise à qui l'on venait d'envoyer un aperçu
 * gratuit se retrouvait « à relancer » le jour même.
 *
 * Ce script ne décide rien et n'envoie rien : il montre, ligne par ligne, sur
 * quoi chaque verdict repose.
 *
 *   npm run sales:audit
 */
import { createLogger, loadConfig, loadAtlasEnv } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import {
  replyHistory, deriveConversationState, evaluateFollowUp, directionOf,
  type ConversationEvent,
} from '../packages/departments/src/index.ts';
import { GmailInboxProvider } from '../packages/intelligence/src/index.ts';

loadAtlasEnv();

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', amber: '\x1b[33m', cyan: '\x1b[36m',
};

const config = loadConfig(process.cwd());
const logger = createLogger({ level: 'error', pretty: false });
const repos = createRepositories(config.paths.databaseFile, logger);
const boite = process.env.GMAIL_USER?.trim() ?? '';
const today = new Date().toISOString().slice(0, 10);

console.log(`\n  ${c.bold}${c.cyan}AUDIT COMMERCIAL${c.reset}  ${c.dim}au ${today} · aucun envoi${c.reset}\n`);

/**
 * Notre dernier message vers chaque domaine, lu dans Gmail.
 *
 * Le journal d'événements ne le sait plus : depuis que la synchronisation
 * écarte nos propres messages — à raison — ils n'y entrent plus. C'est pourtant
 * la donnée qui décide si le silence est le leur ou le nôtre.
 */
const dernierEnvoi = new Map<string, string>();
const inbox = new GmailInboxProvider({ logger });
const gmailLisible = inbox.status().configured;

if (gmailLisible) {
  for (const inscrit of repos.sales.ledgerDomains().filter((d) => d.kind === 'CONTACTED')) {
    try {
      const envoyes = await inbox.list({
        rawFilter: `in:sent to:${inscrit.domain}`,
        max: 20, includeOwnMessages: true, since: '2026-01-01T00:00:00.000Z',
      });
      if (envoyes.length > 0) {
        dernierEnvoi.set(
          inscrit.domain,
          envoyes.map((m) => m.receivedAt).reduce((a, b) => (a >= b ? a : b)),
        );
      }
    } catch { /* un domaine illisible n'empêche pas d'auditer les autres */ }
  }
} else {
  console.log(`  ${c.amber}Gmail non configuré${c.reset} — LAST_OUTBOUND indisponible.\n`);
}

const jour = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : '—');

interface Ligne {
  company: string;
  domain: string;
  lastOutbound: string;
  lastHumanReply: string;
  lastAutoReply: string;
  followUpSent: number;
  state: string;
  due: boolean;
  reason: string;
  everReplied: boolean;
}

const lignes: Ligne[] = [];

/**
 * On parcourt le registre, pas les conversations.
 *
 * Deux entreprises marquees CONTACTEES n'avaient aucune conversation ouverte :
 * elles etaient donc invisibles du tableau, jamais relancees et jamais comptees
 * comme en attente. Une entreprise contactee doit apparaitre quoi qu'il arrive —
 * l'absence de conversation est une information, pas une raison de disparaitre.
 */
const parDomaine = new Map(repos.conversations.all().map((cv) => [cv.canonicalDomain, cv]));

for (const inscrit of repos.sales.ledgerDomains().filter((d) => d.kind === 'CONTACTED')) {
  const conversation = parDomaine.get(inscrit.domain);
  const brut = conversation ? repos.conversations.eventsFor(conversation.id) : [];
  const histoire = replyHistory(brut, boite);

  const state = deriveConversationState(
    brut.map((e) => ({
      kind: e.kind, classification: e.classification, occurredAt: e.occurredAt,
      returnDate: e.returnDate, humanReviewed: e.humanReviewed,
      declaredStatus: e.declaredStatus,
    })) as ConversationEvent[],
    { today, ledgerFollowUpAt: repos.conversations.ledgerFollowUpFor(inscrit.domain) },
  );

  /**
   * Notre dernier envoi, vu par les deux sources qui le savent.
   *
   * Gmail connaît ce qui est parti de la boîte ; le registre d'ATLAS connaît ce
   * qu'ATLAS a expédié. Aucune ne suffit : la recherche Gmail se fait par
   * domaine, et trois de ces entreprises reçoivent sur un domaine différent de
   * celui du registre — leurs envois y sont donc invisibles. N'en lire qu'une
   * faisait diverger l'audit du War Room de deux entreprises.
   */
  const envoi = [
    dernierEnvoi.get(inscrit.domain) ?? null,
    repos.salesLoop.lastSentTo(inscrit.domain),
  ]
    .filter((d): d is string => d !== null)
    .reduce<string | null>((a, b) => (a === null || b > a ? b : a), null);
  // La dernière activité réelle, quel qu'en soit le sens.
  const activite = [envoi, histoire.lastHumanReplyAt, histoire.lastAutoReplyAt]
    .filter((d): d is string => d !== null)
    .reduce<string | null>((a, b) => (a === null || b > a ? b : a), null);

  const relances = repos.salesLoop.followUpsFor(inscrit.domain);
  const decision = evaluateFollowUp({
    domain: inscrit.domain,
    status: state.status,
    contactedOn: (conversation?.firstContactAt ?? inscrit.recordedAt ?? today).slice(0, 10),
    lastActivityOn: activite ? activite.slice(0, 10) : null,
    followUpsSent: relances,
    doNotContact: repos.sales.ledgerFor(inscrit.domain)?.kind === 'DO_NOT_CONTACT',
    afterBusinessDays: config.sales.followUpAfterDays,
    today,
  });

  lignes.push({
    company: conversation?.companyName ?? inscrit.domain,
    domain: inscrit.domain,
    lastOutbound: jour(envoi),
    lastHumanReply: jour(histoire.lastHumanReplyAt),
    lastAutoReply: jour(histoire.lastAutoReplyAt),
    followUpSent: relances,
    state: state.status,
    due: decision.verdict === 'DUE',
    reason: decision.reason,
    everReplied: histoire.everHumanReplied,
  });
}

// --- Le tableau -------------------------------------------------------------
const w = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

console.log(
  `  ${c.dim}${w('COMPANY', 22)}${w('OUTBOUND', 12)}${w('HUMAN', 12)}${w('AUTO', 12)}`
  + `${w('F/U', 5)}${w('STATE', 21)}${w('DUE', 5)}${c.reset}`,
);
for (const l of lignes) {
  const marque = l.due ? `${c.amber}OUI${c.reset}  ` : `${c.dim}non${c.reset}  `;
  console.log(
    `  ${w(l.company, 22)}${w(l.lastOutbound, 12)}`
    + `${l.lastHumanReply === '—' ? c.dim : c.green}${w(l.lastHumanReply, 12)}${c.reset}`
    + `${w(l.lastAutoReply, 12)}${w(String(l.followUpSent), 5)}${w(l.state, 21)}${marque}`,
  );
  console.log(`  ${c.dim}${' '.repeat(22)}${l.reason}${c.reset}`);
}

// --- Les métriques, historiques et non déduites de l'état courant ------------
const contactees = repos.sales.ledgerDomains().filter((d) => d.kind === 'CONTACTED').length;
const ayantRepondu = lignes.filter((l) => l.everReplied);
const enAttente = lignes.filter((l) => !l.everReplied && l.state === 'CONTACTED');
const actionRequise = lignes.filter((l) => ['REPLIED', 'INTERESTED', 'NEEDS_INFO', 'MEETING_REQUESTED', 'NEEDS_REVIEW'].includes(l.state));
const auto = lignes.filter((l) => l.lastAutoReply !== '—');
const dues = lignes.filter((l) => l.due);

const pct = (n: number, d: number) => (d === 0 ? 'N/A' : `${Math.round((n / d) * 100)} %`);

console.log(`\n  ${c.bold}COMPTAGES${c.reset}`);
console.log(`    companies_contacted              ${contactees}`);
console.log(`    companies_that_ever_human_replied ${ayantRepondu.length}  ${c.dim}${ayantRepondu.map((l) => l.company).join(', ') || '—'}${c.reset}`);
console.log(`    currently_waiting_reply          ${enAttente.length}`);
console.log(`    currently_need_action            ${actionRequise.length}  ${c.dim}${actionRequise.map((l) => l.company).join(', ') || '—'}${c.reset}`);
console.log(`    auto_replies                     ${auto.length}  ${c.dim}${auto.map((l) => l.company).join(', ') || '—'}${c.reset}`);

console.log(`\n  ${c.bold}REAL HUMAN RESPONSE COMPANIES${c.reset}  ${ayantRepondu.length}`);
for (const l of ayantRepondu) {
  console.log(`    ${c.green}${l.company}${c.reset} — dernière réponse humaine le ${l.lastHumanReply}`);
}
console.log(`\n  ${c.bold}REAL RESPONSE RATE${c.reset}  ${pct(ayantRepondu.length, contactees)}  ${c.dim}${ayantRepondu.length}/${contactees} entreprises${c.reset}`);
console.log(`  ${c.dim}historique : une entreprise qui a répondu le reste, quoi qu'on fasse ensuite.${c.reset}`);

console.log(`\n  ${c.bold}REAL FOLLOW-UPS DUE${c.reset}  ${dues.length}`);
for (const l of dues) console.log(`    ${c.amber}${l.company}${c.reset} — ${l.reason}`);
if (dues.length === 0) console.log(`    ${c.dim}aucune.${c.reset}`);

console.log(`\n  ${c.dim}MESSAGES SENT: 0 — cet audit n'envoie rien.${c.reset}\n`);
repos.close();
void directionOf;
