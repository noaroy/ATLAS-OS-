import { canonicalDomainOf } from '@atlas/core';
import type { Repositories } from '@atlas/data';
import type { MailInboxProvider, MailMessage } from '@atlas/intelligence';
import {
  classifyInbound,
  matchIncoming,
  directionOf,
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
  const candidates: MatchCandidate[] = repos.conversations.all().map((conversation) => ({
    canonicalDomain: conversation.canonicalDomain,
    companyName: conversation.companyName,
    outreachDestination: conversation.destination,
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

  const messages: MailMessage[] = await provider.list({ since, max: options.max });

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
     */
    const direction = directionOf({ from: message.from, labels: message.labels, mailbox });
    if (direction.direction === 'OUTBOUND') {
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
      detail: match.method,
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
