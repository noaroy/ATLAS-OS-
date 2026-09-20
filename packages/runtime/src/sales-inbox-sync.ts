import { canonicalDomainOf } from '@atlas/core';
import type { Repositories, OutboundReceipt } from '@atlas/data';
import type { MailInboxProvider, MailMessage } from '@atlas/intelligence';
import {
  classifyInbound,
  matchIncoming,
  directionOf,
  sameMailbox,
  sameAddress,
  SELF_TEST_DOMAIN,
  type InboundKind,
  type MatchCandidate,
} from '@atlas/departments';

/**
 * Relier la boîte de réception aux conversations commerciales.
 *
 * C'est le cœur de `scripts/sales-inbox-sync.ts`, déplacé ici pour que le
 * daemon l'exécute à cadence fixe sans en faire une seconde version. Le
 * script continue d'appeler exactement ce code ; seule l'impression lui reste.
 *
 * Lecture seule, de bout en bout : le fournisseur n'expose aucun envoi, la
 * classification est déterministe, rien n'est écrit dans la messagerie.
 *
 * Trois garanties, chacune parce que son absence produirait une erreur
 * silencieuse :
 *
 *   · un message déjà lu n'est jamais réimporté — sinon une entreprise aurait
 *     répondu deux fois, au moment précis où l'on commence à s'y fier ;
 *   · une réponse qu'on ne sait pas rattacher n'est attribuée à personne —
 *     une réponse mal rattachée fait relancer quelqu'un qui avait dit non ;
 *   · aucun état commercial n'est déduit — `INTERESTED`, `WON`, `LOST`
 *     restent posés par un humain.
 */

/**
 * Le recouvrement retranché de la reprise. Les horloges d'expédition ne sont
 * pas les nôtres, et Gmail date un message à sa réception : un courrier
 * retardé peut apparaître avec un horodatage antérieur au dernier traité.
 * Relire un peu trop coûte quelques appels ; le journal d'import écarte les
 * doublons. Relire trop peu perd une réponse.
 */
export const INBOX_SYNC_OVERLAP_MS = 6 * 60 * 60 * 1000;

/** Sans curseur, on remonte volontairement loin : « jamais lu » n'est pas « à jour ». */
export const INBOX_FIRST_PASS_DAYS = 30;

export interface InboxSyncLine {
  kind: 'IMPORTED' | 'UNMATCHED' | 'OUTBOUND' | 'DUPLICATE';
  classification: string | null;
  companyName: string | null;
  subject: string | null;
  detail: string;
}

export interface InboxSyncReport {
  ran: boolean;
  /** Pourquoi la synchronisation n'a pas eu lieu, quand `ran` est faux. */
  skipped: string | null;
  mailbox: string;
  since: string | null;
  checkpoint: string | null;
  scanned: number;
  outbound: number;
  matched: number;
  newEvents: number;
  duplicates: number;
  unmatched: number;
  byClassification: Record<string, number>;
  lines: InboxSyncLine[];
  /** Les événements créés, pour que l'appelant en tire les conséquences. */
  imported: Array<{
    eventId: string;
    conversationId: string;
    domain: string;
    companyName: string;
    classification: string;
    confidence: number;
    subject: string | null;
    sender: string;
    body: string | null;
    receivedAt: string;
  }>;
}

export interface InboxSyncOptions {
  /** L'adresse dont le jeton porte les droits ; GMAIL_USER fait foi. */
  mailbox: string;
  since?: string | null;
  max?: number;
  /**
   * Le mode du moteur. Absent, on se comporte comme en PRODUCTION : aucune
   * exception. Seul INTERNAL_TEST peut ouvrir la lecture du self-test isolé.
   */
  engineMode?: 'INTERNAL_TEST' | 'PRODUCTION';
}

/**
 * Le périmètre exact dans lequel un message venu de notre propre boîte peut
 * être lu comme une réponse : les fils que le self-test isolé a ouverts.
 */
export interface SelfTestReplyScope {
  conversationId: string;
  threadIds: ReadonlySet<string>;
}

/**
 * Le self-test isolé a-t-il le droit d'être lu ?
 *
 * Le self-test (v4.5.4) écrit de GMAIL_USER à GMAIL_USER ; la réponse, dans
 * le même fil, porte donc à la fois SENT et INBOX. Le listing normal l'écarte
 * (`-in:sent -in:draft`), et la garde de direction l'écarterait ensuite. Les
 * deux ont raison pour tout prospect ; pour ce seul fil, elles rendent la
 * boucle impossible à fermer — relevé en production : 145 messages lus,
 * 0 rattaché, la réponse jamais consignée.
 *
 * Quatre conditions, toutes exactes, aucune configurable :
 *   · ATLAS_ENGINE_MODE=INTERNAL_TEST — en PRODUCTION, jamais ;
 *   · une conversation dont le domaine est exactement SELF_TEST_DOMAIN ;
 *   · un accusé d'envoi réel (SENT, identifiants rendus) de cette
 *     conversation, adressé à GMAIL_USER (trim + minuscules), premier contact ;
 *   · et ce sont *ces* fils-là, pas d'autres, qui s'ouvrent.
 */
export function selfTestReplyScope(input: {
  engineMode: 'INTERNAL_TEST' | 'PRODUCTION' | undefined;
  mailbox: string;
  conversations: ReadonlyArray<{ id: string; canonicalDomain: string }>;
  receiptsOf: (conversationId: string) => OutboundReceipt[];
}): SelfTestReplyScope | null {
  if (input.engineMode !== 'INTERNAL_TEST') return null;
  const conversation = input.conversations.find((c) => c.canonicalDomain === SELF_TEST_DOMAIN);
  if (!conversation) return null;
  const threadIds = new Set(
    input.receiptsOf(conversation.id)
      .filter((r) => r.purpose === 'FIRST_TOUCH' && sameAddress(r.recipient, input.mailbox) && r.externalThreadId)
      .map((r) => r.externalThreadId!),
  );
  return threadIds.size > 0 ? { conversationId: conversation.id, threadIds } : null;
}

/**
 * Ce message de notre propre boîte est-il la réponse du self-test ?
 *
 * Même boîte à l'expédition et à la réception, fil connu du self-test, et un
 * identifiant qui n'est pas celui d'un de nos envois. Un message à soi-même
 * dans un autre fil, ou vers quelqu'un d'autre, reste ce qu'il est : le nôtre.
 */
export function isSelfTestReply(input: {
  scope: SelfTestReplyScope | null;
  mailbox: string;
  message: Pick<MailMessage, 'messageId' | 'threadId' | 'from' | 'to'>;
  ownSentIds: ReadonlySet<string>;
}): boolean {
  const { scope, message } = input;
  if (!scope || !message.threadId || !scope.threadIds.has(message.threadId)) return false;
  if (input.ownSentIds.has(message.messageId)) return false;
  if (!input.mailbox.trim() || !sameMailbox(message.from, input.mailbox)) return false;
  return message.to.some((to) => sameMailbox(to, input.mailbox));
}

export async function syncSalesInbox(
  repos: Repositories,
  provider: MailInboxProvider,
  options: InboxSyncOptions,
): Promise<InboxSyncReport> {
  const status = provider.status();
  const mailbox = options.mailbox.trim() || 'inconnue';
  const report: InboxSyncReport = {
    ran: false, skipped: null, mailbox, since: null, checkpoint: null,
    scanned: 0, outbound: 0, matched: 0, newEvents: 0, duplicates: 0, unmatched: 0,
    byClassification: {}, lines: [], imported: [],
  };

  if (!status.configured) {
    report.skipped = `${status.code} — ${status.detail}`;
    return report;
  }

  // Les entreprises à qui l'on a écrit, avec ce qu'il faut pour rapprocher.
  // Une conversation dont la destination est notre propre boîte (le self-test)
  // ne peut pas être reconnue par cette adresse : tout message qui nous est
  // adressé la « cite ». Pour le rapprochement, elle n'a pas d'adresse — seul
  // son fil la désigne.
  const candidates: MatchCandidate[] = repos.conversations.all().map((conversation) => ({
    canonicalDomain: conversation.canonicalDomain,
    companyName: conversation.companyName,
    outreachDestination: conversation.destination && mailbox.trim() && sameMailbox(conversation.destination, mailbox)
      ? null
      : conversation.destination,
    knownThreadIds: repos.conversations.knownThreadIds(conversation.id),
    knownMessageIds: repos.conversations.knownMessageIds(conversation.id),
  }));
  if (candidates.length === 0) {
    report.skipped = 'aucune conversation ouverte : rien à rapprocher';
    return report;
  }

  const checkpoint = repos.conversations.syncCheckpoint(provider.id, mailbox);
  const since = options.since
    ?? (checkpoint
      ? new Date(Date.parse(checkpoint.lastReceivedAt) - INBOX_SYNC_OVERLAP_MS).toISOString()
      : new Date(Date.now() - INBOX_FIRST_PASS_DAYS * 86_400_000).toISOString());
  report.since = since;
  report.checkpoint = checkpoint?.lastReceivedAt ?? null;
  report.ran = true;

  // Nos envois réels, par l'identifiant que le fournisseur a rendu : quoi
  // qu'en disent étiquettes ou expéditeur, un message qui le porte est le
  // nôtre et ne devient jamais une réponse.
  const ownSentIds = new Set(repos.salesLoop.sentExternalMessageIds());
  const selfTest = selfTestReplyScope({
    engineMode: options.engineMode, mailbox,
    conversations: repos.conversations.all(),
    receiptsOf: (conversationId) => repos.conversations.outboundReceipts(conversationId),
  });

  // Le listing normal ne change pas : nos propres messages restent écartés à
  // la requête. Le self-test isolé, quand il est autorisé, ajoute une seconde
  // lecture, la plus étroite possible — les messages de notre boîte vers
  // notre boîte — et rien d'autre de ce que nous avons écrit ne remonte.
  const messages: MailMessage[] = await provider.list({ since, max: options.max });
  if (selfTest) {
    const seen = new Set(messages.map((m) => m.messageId));
    const selfAddressed = await provider.list({
      since, max: 50, includeOwnMessages: true, rawFilter: `from:${mailbox} to:${mailbox}`,
    });
    for (const m of selfAddressed) if (!seen.has(m.messageId)) { seen.add(m.messageId); messages.push(m); }
  }

  for (const message of messages) {
    report.scanned += 1;

    if (repos.conversations.alreadyImported(provider.id, message.messageId)) {
      report.duplicates += 1;
      continue;
    }

    /**
     * La direction, avant tout rapprochement. Le rapprochement se fait par
     * fil, et le fil nous est connu parce que *nous* l'avons ouvert : nos
     * propres courriers y correspondaient parfaitement et revenaient classés
     * REPLIED. Le message sortant est journalisé comme ignoré, jamais effacé.
     *
     * Un accusé d'envoi consigné tranche avant toute lecture des étiquettes :
     * c'est notre message, point. Puis la direction ; et une seule réponse
     * venue de notre boîte passe — celle du self-test isolé, sur son fil.
     */
    const ownSend = ownSentIds.has(message.messageId);
    const direction = ownSend
      ? { direction: 'OUTBOUND' as const, reason: `accusé d’envoi consigné pour ${message.messageId}` }
      : directionOf({ from: message.from, labels: message.labels, mailbox });
    const selfTestReply = !ownSend && direction.direction === 'OUTBOUND'
      && isSelfTestReply({ scope: selfTest, mailbox, message, ownSentIds });
    if (direction.direction === 'OUTBOUND' && !selfTestReply) {
      report.outbound += 1;
      repos.conversations.logImport({
        provider: provider.id,
        externalMessageId: message.messageId,
        externalThreadId: message.threadId,
        disposition: 'IGNORED',
        matchMethod: 'DIRECTION',
        conversationId: null,
        eventId: null,
        reason: `message sortant : ${direction.reason}`,
        fromAddress: message.from,
        subject: message.subject,
        receivedAt: message.receivedAt,
      });
      report.lines.push({ kind: 'OUTBOUND', classification: null, companyName: null, subject: message.subject, detail: direction.reason });
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
      report.unmatched += 1;
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
      report.lines.push({ kind: 'UNMATCHED', classification: null, companyName: null, subject: message.subject, detail: match.reason });
      continue;
    }

    report.matched += 1;
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
    report.newEvents += 1;
    report.byClassification[verdict.classification] = (report.byClassification[verdict.classification] ?? 0) + 1;

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

    report.lines.push({
      kind: 'IMPORTED',
      classification: verdict.classification,
      companyName: conversation.companyName,
      subject: message.subject,
      detail: selfTestReply ? `${match.method} · réponse du self-test isolé` : match.method,
    });
    report.imported.push({
      eventId: event.id,
      conversationId: conversation.id,
      domain: canonicalDomainOf(conversation.canonicalDomain),
      companyName: conversation.companyName,
      classification: verdict.classification,
      confidence: verdict.confidence,
      subject: message.subject,
      sender: message.from,
      body: message.bodyText ?? message.snippet,
      receivedAt: message.receivedAt,
    });
  }

  /**
   * Le curseur n'avance qu'ici — la boucle est terminée, tout a été traité.
   * L'avancer message par message rendrait un plantage en cours de pagination
   * indiscernable d'une synchronisation réussie : les messages sautés ne
   * seraient jamais relus. Ici, un plantage laisse le curseur en place.
   */
  if (messages.length > 0) {
    const latest = messages.map((m) => m.receivedAt).reduce((a, b) => (a >= b ? a : b));
    repos.conversations.advanceSyncCheckpoint({
      provider: provider.id,
      mailbox,
      lastReceivedAt: latest,
      messagesSeen: report.scanned,
    });
  }

  return report;
}
