import { id, nowIso, invalidState, canonicalDomainOf } from '@atlas/core';
import type { Db } from '../database.ts';

/**
 * Ce qui revient après un envoi.
 *
 * Le registre d'outreach dit qu'on a écrit. Il ne dit pas ce qu'on a reçu, et
 * sans cela rien ne distingue une entreprise silencieuse d'une entreprise dont
 * l'adresse était fausse. Les deux ressemblent à « pas de réponse », et l'une
 * des deux demande une action immédiate.
 *
 * Une conversation par entreprise, jamais par lot : CIRMECA figure dans trois
 * lots et n'a qu'une histoire commerciale. Deux fils pour une même maison
 * produiraient deux relances, ce qui est précisément ce que la déduplication
 * inter-lots venait d'empêcher côté prospection.
 */

export interface SalesConversation {
  id: string;
  canonicalDomain: string;
  companyName: string;
  outreachLedgerEntryId: string | null;
  channel: string | null;
  destination: string | null;
  firstContactAt: string;
  lastActivityAt: string;
  source: string;
}

export interface ConversationEventRow {
  id: string;
  conversationId: string;
  kind: string;
  occurredAt: string;
  source: string;
  rawSubject: string | null;
  sender: string | null;
  bodyExcerpt: string | null;
  classification: string;
  confidence: number;
  signals: string[];
  returnDate: string | null;
  humanReviewed: boolean;
  declaredStatus: string | null;
  note: string | null;
  externalMessageId: string | null;
  externalThreadId: string | null;
  recordedAt: string;
}

export interface MailImportEntry {
  provider: string;
  externalMessageId: string;
  externalThreadId: string | null;
  disposition: 'IMPORTED' | 'UNMATCHED' | 'IGNORED';
  matchMethod: string | null;
  conversationId: string | null;
  eventId: string | null;
  reason: string | null;
  fromAddress: string | null;
  subject: string | null;
  receivedAt: string | null;
  scannedAt: string;
}

interface ConversationRow {
  id: string;
  canonical_domain: string;
  company_name: string;
  outreach_ledger_entry_id: string | null;
  channel: string | null;
  destination: string | null;
  first_contact_at: string;
  last_activity_at: string;
  source: string;
}

interface EventRow {
  id: string;
  conversation_id: string;
  kind: string;
  occurred_at: string;
  source: string;
  raw_subject: string | null;
  sender: string | null;
  body_excerpt: string | null;
  classification: string;
  confidence: number;
  signals: string | null;
  return_date: string | null;
  human_reviewed: number;
  declared_status: string | null;
  note: string | null;
  external_message_id: string | null;
  external_thread_id: string | null;
  recorded_at: string;
}

const toConversation = (row: ConversationRow): SalesConversation => ({
  id: row.id,
  canonicalDomain: row.canonical_domain,
  companyName: row.company_name,
  outreachLedgerEntryId: row.outreach_ledger_entry_id,
  channel: row.channel,
  destination: row.destination,
  firstContactAt: row.first_contact_at,
  lastActivityAt: row.last_activity_at,
  source: row.source,
});

const toEvent = (row: EventRow): ConversationEventRow => ({
  id: row.id,
  conversationId: row.conversation_id,
  kind: row.kind,
  occurredAt: row.occurred_at,
  source: row.source,
  rawSubject: row.raw_subject,
  sender: row.sender,
  bodyExcerpt: row.body_excerpt,
  classification: row.classification,
  confidence: row.confidence,
  signals: row.signals ? (JSON.parse(row.signals) as string[]) : [],
  returnDate: row.return_date,
  humanReviewed: row.human_reviewed === 1,
  declaredStatus: row.declared_status,
  note: row.note,
  externalMessageId: row.external_message_id,
  externalThreadId: row.external_thread_id,
  recordedAt: row.recorded_at,
});

export class ConversationRepository {
  constructor(private readonly db: Db) {}

  /**
   * Ouvre la conversation d'une entreprise, ou rend celle qui existe.
   *
   * Idempotent par domaine canonique : appeler deux fois depuis deux lots ne
   * crée pas deux fils. C'est l'unicité SQL qui le garantit, pas la prudence
   * de l'appelant.
   */
  open(input: {
    domain: string;
    companyName: string;
    outreachLedgerEntryId?: string | null;
    channel?: string | null;
    destination?: string | null;
    firstContactAt?: string;
    source?: string;
  }): { conversation: SalesConversation; created: boolean } {
    const domain = canonicalDomainOf(input.domain);
    if (!domain) throw invalidState('Une conversation sans domaine ne se rattache à personne.');

    const existing = this.db
      .prepare('SELECT * FROM sales_conversations WHERE canonical_domain = ?')
      .get(domain) as ConversationRow | undefined;
    if (existing) return { conversation: toConversation(existing), created: false };

    const now = nowIso();
    const row: ConversationRow = {
      id: id('cnv'),
      canonical_domain: domain,
      company_name: input.companyName,
      outreach_ledger_entry_id: input.outreachLedgerEntryId ?? null,
      channel: input.channel ?? null,
      destination: input.destination ?? null,
      first_contact_at: input.firstContactAt ?? now,
      last_activity_at: input.firstContactAt ?? now,
      source: input.source ?? 'manuel',
    };
    this.db
      .prepare(
        `INSERT INTO sales_conversations
           (id, canonical_domain, company_name, outreach_ledger_entry_id, channel, destination,
            first_contact_at, last_activity_at, source, created_at)
         VALUES (@id, @canonical_domain, @company_name, @outreach_ledger_entry_id, @channel,
                 @destination, @first_contact_at, @last_activity_at, @source, @created_at)`,
      )
      .run({ ...row, created_at: now });
    return { conversation: toConversation(row), created: true };
  }

  byDomain(domain: string): SalesConversation | null {
    const row = this.db
      .prepare('SELECT * FROM sales_conversations WHERE canonical_domain = ?')
      .get(canonicalDomainOf(domain)) as ConversationRow | undefined;
    return row ? toConversation(row) : null;
  }

  all(): SalesConversation[] {
    return (
      this.db
        .prepare('SELECT * FROM sales_conversations ORDER BY last_activity_at DESC')
        .all() as ConversationRow[]
    ).map(toConversation);
  }

  /**
   * Consigne un événement entrant.
   *
   * `classification` et `confidence` viennent du classifieur déterministe, et
   * sont écrits tels quels : c'est ce qu'une règle a reconnu, pas ce qu'on a
   * conclu. `declaredStatus` est le seul champ où un humain pose un verdict,
   * et il exige `humanReviewed` — un état commercial qu'aucune personne n'a
   * constaté serait une vente inventée.
   */
  recordInboundEvent(input: {
    conversationId: string;
    kind: string;
    classification: string;
    confidence: number;
    occurredAt?: string;
    source: string;
    rawSubject?: string | null;
    sender?: string | null;
    bodyExcerpt?: string | null;
    signals?: readonly string[];
    returnDate?: string | null;
    humanReviewed?: boolean;
    declaredStatus?: string | null;
    note?: string | null;
    externalMessageId?: string | null;
    externalThreadId?: string | null;
  }): ConversationEventRow {
    const conversation = this.db
      .prepare('SELECT * FROM sales_conversations WHERE id = ?')
      .get(input.conversationId) as ConversationRow | undefined;
    if (!conversation) throw invalidState(`Conversation « ${input.conversationId} » introuvable.`);

    if (input.declaredStatus && !input.humanReviewed) {
      throw invalidState(
        `Poser l'état « ${input.declaredStatus} » exige une relecture humaine : ` +
          'un état commercial que personne n’a constaté est une supposition.',
      );
    }

    const now = nowIso();
    const occurredAt = input.occurredAt ?? now;
    const row: EventRow = {
      id: id('cev'),
      conversation_id: input.conversationId,
      kind: input.kind,
      occurred_at: occurredAt,
      source: input.source,
      raw_subject: input.rawSubject ?? null,
      sender: input.sender ?? null,
      body_excerpt: input.bodyExcerpt ? input.bodyExcerpt.slice(0, 500) : null,
      classification: input.classification,
      confidence: input.confidence,
      signals: input.signals ? JSON.stringify([...input.signals]) : null,
      return_date: input.returnDate ?? null,
      human_reviewed: input.humanReviewed ? 1 : 0,
      declared_status: input.declaredStatus ?? null,
      note: input.note ?? null,
      external_message_id: input.externalMessageId ?? null,
      external_thread_id: input.externalThreadId ?? null,
      recorded_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO sales_conversation_events
           (id, conversation_id, kind, occurred_at, source, raw_subject, sender, body_excerpt,
            classification, confidence, signals, return_date, human_reviewed, declared_status,
            note, external_message_id, external_thread_id, recorded_at)
         VALUES (@id, @conversation_id, @kind, @occurred_at, @source, @raw_subject, @sender,
                 @body_excerpt, @classification, @confidence, @signals, @return_date,
                 @human_reviewed, @declared_status, @note, @external_message_id,
                 @external_thread_id, @recorded_at)`,
      )
      .run(row);

    // La dernière activité est une donnée de la conversation, pas un événement :
    // elle se met à jour, contrairement aux événements eux-mêmes.
    if (occurredAt > conversation.last_activity_at) {
      this.db
        .prepare('UPDATE sales_conversations SET last_activity_at = ? WHERE id = ?')
        .run(occurredAt, input.conversationId);
    }
    return toEvent(row);
  }

  eventsFor(conversationId: string): ConversationEventRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM sales_conversation_events WHERE conversation_id = ?
            ORDER BY occurred_at ASC, rowid ASC`,
        )
        .all(conversationId) as EventRow[]
    ).map(toEvent);
  }

  /**
   * La relance portée par le registre d'outreach, lue et non recopiée.
   *
   * Groupe JLF a une date de retour enregistrée au moment de l'envoi. La
   * conversation la lit à travers son entrée de registre : dupliquer la date
   * créerait deux vérités qui divergeraient dès la première correction.
   */
  /**
   * Ce message a-t-il déjà été lu ?
   *
   * Consulté avant toute écriture : deux synchronisations voient les mêmes
   * messages, et sans cette question la seconde ferait répondre chaque
   * entreprise une fois de plus.
   */
  alreadyImported(provider: string, externalMessageId: string): MailImportEntry | null {
    const row = this.db
      .prepare(
        `SELECT * FROM mail_import_log WHERE provider = ? AND external_message_id = ?`,
      )
      .get(provider, externalMessageId) as Record<string, string | null> | undefined;
    if (!row) return null;
    return {
      provider: row.provider!,
      externalMessageId: row.external_message_id!,
      externalThreadId: row.external_thread_id ?? null,
      disposition: row.disposition as MailImportEntry['disposition'],
      matchMethod: row.match_method ?? null,
      conversationId: row.conversation_id ?? null,
      eventId: row.event_id ?? null,
      reason: row.reason ?? null,
      fromAddress: row.from_address ?? null,
      subject: row.subject ?? null,
      receivedAt: row.received_at ?? null,
      scannedAt: row.scanned_at!,
    };
  }

  /** Consigne qu'un message a été examiné, quelle qu'en soit l'issue. */
  logImport(entry: Omit<MailImportEntry, 'scannedAt'> & { toAddress?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO mail_import_log
           (id, provider, external_message_id, external_thread_id, from_address, to_address,
            subject, received_at, disposition, match_method, conversation_id, event_id,
            reason, scanned_at)
         VALUES (@id, @provider, @external_message_id, @external_thread_id, @from_address,
                 @to_address, @subject, @received_at, @disposition, @match_method,
                 @conversation_id, @event_id, @reason, @scanned_at)`,
      )
      .run({
        id: id('mil'),
        provider: entry.provider,
        external_message_id: entry.externalMessageId,
        external_thread_id: entry.externalThreadId ?? null,
        from_address: entry.fromAddress ?? null,
        to_address: entry.toAddress ?? null,
        subject: entry.subject ?? null,
        received_at: entry.receivedAt ?? null,
        disposition: entry.disposition,
        match_method: entry.matchMethod ?? null,
        conversation_id: entry.conversationId ?? null,
        event_id: entry.eventId ?? null,
        reason: entry.reason ?? null,
        scanned_at: nowIso(),
      });
  }

  /** Les fils déjà rattachés à une entreprise — première piste de rapprochement. */
  knownThreadIds(conversationId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT external_thread_id FROM sales_conversation_events
            WHERE conversation_id = ? AND external_thread_id IS NOT NULL`,
        )
        .all(conversationId) as Array<{ external_thread_id: string }>
    ).map((row) => row.external_thread_id);
  }

  knownMessageIds(conversationId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT external_message_id FROM sales_conversation_events
            WHERE conversation_id = ? AND external_message_id IS NOT NULL`,
        )
        .all(conversationId) as Array<{ external_message_id: string }>
    ).map((row) => row.external_message_id);
  }

  ledgerFollowUpFor(conversationId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT l.follow_up_at AS follow_up_at
           FROM sales_conversations c
           JOIN outreach_ledger l ON l.id = c.outreach_ledger_entry_id
          WHERE c.id = ?`,
      )
      .get(conversationId) as { follow_up_at: string | null } | undefined;
    return row?.follow_up_at ?? null;
  }

  /**
   * Jusqu'où cette boîte a-t-elle été lue ?
   *
   * `null` veut dire « jamais synchronisée », ce qui n'est pas « à jour » : le
   * premier passage doit alors remonter volontairement loin, plutôt que de
   * supposer que ce qui précède ne compte pas.
   */
  /**
   * Normalise la boîte comme une adresse, pas comme une chaîne quelconque.
   *
   * `Moi@Gmail.com` et `moi@gmail.com` désignent la même boîte mais produisaient
   * deux curseurs distincts : une simple différence de casse dans `GMAIL_USER`
   * remettait la synchronisation à zéro, ou en créait une seconde qui n'avançait
   * jamais — et le trou que le curseur existe pour empêcher se rouvrait. Les
   * domaines sont canonisés partout ailleurs ; la boîte ne l'était pas.
   */
  private static mailboxKey(mailbox: string): string {
    return mailbox.trim().toLowerCase();
  }

  syncCheckpoint(provider: string, mailbox: string): {
    lastReceivedAt: string; lastSyncedAt: string; messagesSeen: number;
  } | null {
    const row = this.db
      .prepare(
        `SELECT last_received_at, last_synced_at, messages_seen
           FROM mail_sync_checkpoints WHERE provider = ? AND mailbox = ?`,
      )
      .get(provider, ConversationRepository.mailboxKey(mailbox)) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      lastReceivedAt: row.last_received_at as string,
      lastSyncedAt: row.last_synced_at as string,
      messagesSeen: row.messages_seen as number,
    };
  }

  /**
   * Avancer le curseur — et seulement une fois le lot entièrement traité.
   *
   * L'avancer plus tôt, message par message, rendrait un plantage en cours de
   * pagination indiscernable d'une synchronisation réussie : le curseur serait
   * au-delà de ce qui a été traité, et les messages sautés ne seraient jamais
   * relus. Un trou permanent, sans trace.
   *
   * Le curseur ne recule jamais non plus. Une relecture volontaire d'une
   * ancienne fenêtre ne doit pas faire oublier ce qui a déjà été lu depuis.
   */
  advanceSyncCheckpoint(input: {
    provider: string;
    mailbox: string;
    lastReceivedAt: string;
    messagesSeen: number;
    now?: string;
  }): { advanced: boolean; lastReceivedAt: string } {
    const current = this.syncCheckpoint(input.provider, input.mailbox);
    const keep = current && current.lastReceivedAt >= input.lastReceivedAt
      ? current.lastReceivedAt
      : input.lastReceivedAt;

    this.db
      .prepare(
        `INSERT INTO mail_sync_checkpoints
           (provider, mailbox, last_received_at, last_synced_at, messages_seen)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (provider, mailbox) DO UPDATE SET
           last_received_at = excluded.last_received_at,
           last_synced_at   = excluded.last_synced_at,
           messages_seen    = mail_sync_checkpoints.messages_seen + excluded.messages_seen`,
      )
      .run(
        input.provider, ConversationRepository.mailboxKey(input.mailbox),
        keep, input.now ?? nowIso(), input.messagesSeen,
      );

    return { advanced: keep === input.lastReceivedAt, lastReceivedAt: keep };
  }
}
