import { createHash } from 'node:crypto';
import { id, nowIso, canonicalDomainOf } from '@atlas/core';
import type { Db } from '../database.ts';

/**
 * La mémoire de la boucle commerciale.
 *
 * Trois choses y sont conservées, et une seule compte vraiment : la
 * réservation d'envoi. Les transitions d'état racontent, les brouillons se
 * relisent — la réservation, elle, empêche qu'un même message parte deux fois.
 *
 * Elle le fait par la clé primaire, pas par une vérification préalable. Entre
 * un `SELECT` qui ne trouve rien et l'`INSERT` qui suit, un retry concurrent
 * passe ; entre deux `INSERT` sur la même clé, non. La différence n'est pas
 * théorique : un plantage au milieu d'un envoi est exactement le moment où la
 * vérification préalable échoue.
 */

export interface LoopTransition {
  id: string;
  domain: string;
  fromState: string | null;
  toState: string;
  reason: string | null;
  actor: string;
  runId: string | null;
  occurredAt: string;
}

export interface SendClaim {
  /** La place a été prise par cet appel. */
  claimed: boolean;
  idempotencyKey: string;
  /** Quand la place était déjà prise : ce qu'on en sait. */
  existing: { sentAt: string | null; externalMessageId: string | null } | null;
  reason: string;
}

export interface OutreachDraftRow {
  id: string;
  domain: string;
  companyName: string;
  recipient: string;
  subject: string;
  body: string;
  bodyHash: string;
  purpose: string;
  conversionScore: number | null;
  rationale: string | null;
  sources: Array<{ quote: string; sourceUrl: string }>;
  state: string;
  createdAt: string;
  createdBy: string;
}

/**
 * La clé d'idempotence.
 *
 * Elle dépend du destinataire, du sujet et du corps — pas de l'horodatage.
 * Rejouer exactement le même message donne donc la même clé et se fait
 * refuser ; écrire une relance différente en donne une autre et passe. C'est
 * la propriété qu'on veut : bloquer le doublon, pas la suite de la
 * conversation.
 */
export function sendKey(input: {
  domain: string;
  recipient: string;
  subject: string;
  body: string;
  purpose: string;
}): string {
  const material = [
    canonicalDomainOf(input.domain),
    input.recipient.trim().toLowerCase(),
    input.purpose,
    input.subject.trim(),
    input.body.trim(),
  ].join(' ');
  return createHash('sha256').update(material).digest('hex').slice(0, 40);
}

export function bodyHashOf(body: string): string {
  return createHash('sha256').update(body.trim()).digest('hex').slice(0, 32);
}

export class SalesLoopRepository {
  constructor(private readonly db: Db) {}

  // --- Transitions --------------------------------------------------------

  recordTransition(input: {
    domain: string;
    fromState: string | null;
    toState: string;
    reason?: string | null;
    actor: string;
    runId?: string | null;
  }): LoopTransition {
    const row: LoopTransition = {
      id: id('trn'),
      domain: canonicalDomainOf(input.domain),
      fromState: input.fromState ?? null,
      toState: input.toState,
      reason: input.reason ?? null,
      actor: input.actor,
      runId: input.runId ?? null,
      occurredAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO sales_loop_transitions
           (id, domain, from_state, to_state, reason, actor, run_id, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.domain, row.fromState, row.toState,
        row.reason, row.actor, row.runId, row.occurredAt,
      );
    return row;
  }

  /** L'état courant : la dernière transition consignée, ou rien. */
  currentState(domain: string): string | null {
    const row = this.db
      .prepare(
        `SELECT to_state FROM sales_loop_transitions
          WHERE domain = ? ORDER BY occurred_at DESC, rowid DESC LIMIT 1`,
      )
      .get(canonicalDomainOf(domain)) as { to_state: string } | undefined;
    return row?.to_state ?? null;
  }

  historyFor(domain: string): LoopTransition[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sales_loop_transitions
          WHERE domain = ? ORDER BY occurred_at ASC, rowid ASC`,
      )
      .all(canonicalDomainOf(domain)) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      domain: r.domain as string,
      fromState: (r.from_state as string | null) ?? null,
      toState: r.to_state as string,
      reason: (r.reason as string | null) ?? null,
      actor: r.actor as string,
      runId: (r.run_id as string | null) ?? null,
      occurredAt: r.occurred_at as string,
    }));
  }

  /** Combien de domaines se trouvent aujourd'hui dans chaque état. */
  stateCounts(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT to_state AS state, COUNT(*) AS n FROM (
           SELECT domain, to_state,
                  ROW_NUMBER() OVER (
                    PARTITION BY domain ORDER BY occurred_at DESC, rowid DESC
                  ) AS rn
             FROM sales_loop_transitions
         ) WHERE rn = 1 GROUP BY to_state`,
      )
      .all() as Array<{ state: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }

  domainsInState(state: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT domain FROM (
           SELECT domain, to_state,
                  ROW_NUMBER() OVER (
                    PARTITION BY domain ORDER BY occurred_at DESC, rowid DESC
                  ) AS rn
             FROM sales_loop_transitions
         ) WHERE rn = 1 AND to_state = ?`,
      )
      .all(state) as Array<{ domain: string }>;
    return rows.map((r) => r.domain);
  }

  // --- Réservation d'envoi ------------------------------------------------

  /**
   * Prendre la place avant d'envoyer.
   *
   * Rendue plutôt que jetée quand la place est prise : un doublon évité est un
   * fonctionnement normal de la boucle — un retry après coupure réseau — et
   * non une anomalie qui mérite une exception.
   */
  claimSend(input: {
    domain: string;
    conversationId?: string | null;
    recipient: string;
    subject: string;
    body: string;
    purpose: string;
    claimedBy: string;
  }): SendClaim {
    const key = sendKey(input);
    const existing = this.db
      .prepare('SELECT idempotency_key FROM outbound_sends WHERE idempotency_key = ?')
      .get(key) as { idempotency_key: string } | undefined;

    if (existing) {
      const sent = this.db
        .prepare(
          `SELECT occurred_at, external_message_id FROM outbound_send_events
            WHERE idempotency_key = ? AND phase = 'SENT' LIMIT 1`,
        )
        .get(key) as { occurred_at: string; external_message_id: string | null } | undefined;
      /**
       * Une place rendue redevient prenable.
       *
       * Uniquement si un abandon a ete consigne — avec son acteur et son motif —
       * et qu'aucun envoi n'est constate. La reservation d'origine reste en
       * base : on ne la reecrit pas, on lit la decision qui l'a refermee.
       *
       * Le double envoi reste impossible par construction, abandon ou non :
       * l'index unique partiel sur les evenements SENT interdit physiquement
       * une seconde ligne d'envoi pour la meme cle. C'est lui la garantie, pas
       * cette reservation, qui n'est qu'un verrou consultatif entre processus.
       */
      const abandonne = this.db
        .prepare('SELECT reason FROM outbound_send_abandonments WHERE idempotency_key = ?')
        .get(key) as { reason: string } | undefined;
      // Et seulement tant qu'aucune tentative n'a eu lieu depuis. L'abandon est
      // permanent : sans cette condition il défaisait la garde d'ambiguïté pour
      // toujours, et un échec de transport — où Google a pu délivrer avant que
      // quelque chose casse en aval — laissait renvoyer indéfiniment.
      const tentatives = this.db
        .prepare('SELECT COUNT(*) AS n FROM outbound_send_events WHERE idempotency_key = ?')
        .get(key) as { n: number };
      if (!sent && abandonne && tentatives.n === 0) {
        return {
          claimed: true,
          idempotencyKey: key,
          existing: null,
          reason: `place rendue apres abandon consigne : ${abandonne.reason.slice(0, 70)}`,
        };
      }

      return {
        claimed: false,
        idempotencyKey: key,
        existing: {
          sentAt: sent?.occurred_at ?? null,
          externalMessageId: sent?.external_message_id ?? null,
        },
        reason: sent
          ? `déjà envoyé le ${sent.occurred_at}`
          : 'une tentative est déjà engagée sur ce message : reprise interdite sans décision humaine',
      };
    }

    this.db
      .prepare(
        `INSERT INTO outbound_sends
           (idempotency_key, domain, conversation_id, recipient, subject,
            body_hash, purpose, claimed_at, claimed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key,
        canonicalDomainOf(input.domain),
        input.conversationId ?? null,
        input.recipient,
        input.subject,
        bodyHashOf(input.body),
        input.purpose,
        nowIso(),
        input.claimedBy,
      );
    return { claimed: true, idempotencyKey: key, existing: null, reason: 'place réservée' };
  }

  /** Consigner l'issue. Un second `SENT` est refusé par l'index partiel. */

  /**
   * Ce qu'on sait de l'issue d'une réservation.
   *
   * Trois cas, et le troisième est le seul qui compte vraiment. Un envoi
   * constaté ferme le dossier. Aucun événement du tout veut dire qu'aucune
   * requête n'est jamais partie : la place est morte, et personne n'a rien reçu.
   * Un événement d'échec, lui, est ambigu — le transport a pu être accepté par
   * Google avant que quelque chose casse en aval, et rien ici ne permet de
   * trancher. Le doute ne se résout pas tout seul : il se signale.
   */
  sendOutcome(idempotencyKey: string): {
    exists: boolean;
    sent: boolean;
    ambiguous: boolean;
    abandoned: boolean;
    events: number;
  } {
    const reservation = this.db
      .prepare('SELECT idempotency_key FROM outbound_sends WHERE idempotency_key = ?')
      .get(idempotencyKey);
    if (!reservation) {
      return { exists: false, sent: false, ambiguous: false, abandoned: false, events: 0 };
    }
    const rows = this.db
      .prepare('SELECT phase FROM outbound_send_events WHERE idempotency_key = ?')
      .all(idempotencyKey) as Array<{ phase: string }>;
    const abandoned = this.db
      .prepare('SELECT 1 FROM outbound_send_abandonments WHERE idempotency_key = ?')
      .get(idempotencyKey) !== undefined;

    return {
      exists: true,
      sent: rows.some((r) => r.phase === 'SENT'),
      ambiguous: rows.length > 0 && !rows.some((r) => r.phase === 'SENT'),
      abandoned,
      events: rows.length,
    };
  }

  /**
   * Refermer une réservation dont aucun envoi n'est sorti.
   *
   * Jamais automatique : `actor` et `reason` sont obligatoires, et la ligne
   * écrite ne se modifie ni ne s'efface. La réservation d'origine reste en
   * place — on ajoute une décision à l'histoire, on n'en retire rien.
   *
   * Ce qui rend l'opération sûre n'est pas ce mécanisme mais l'index unique
   * partiel sur les événements `SENT` : la base ne peut pas contenir deux envois
   * pour une même clé, abandon ou pas. L'abandon rend une place, il n'ouvre
   * aucune porte.
   */
  abandonSend(input: {
    idempotencyKey: string;
    actor: string;
    reason: string;
  }): { released: boolean; reason: string } {
    if (!input.actor.trim() || !input.reason.trim()) {
      return { released: false, reason: 'un abandon sans acteur ni motif ne se consigne pas' };
    }
    const outcome = this.sendOutcome(input.idempotencyKey);
    if (!outcome.exists) return { released: false, reason: 'réservation inconnue' };
    if (outcome.sent) {
      return { released: false, reason: 'un envoi réel est consigné : cette place ne se rend pas' };
    }
    if (outcome.ambiguous) {
      return {
        released: false,
        reason: `${outcome.events} événement(s) sans envoi confirmé : issue ambiguë, `
          + 'une décision humaine est requise avant tout abandon',
      };
    }
    if (outcome.abandoned) return { released: false, reason: 'déjà abandonnée' };

    this.db
      .prepare(
        `INSERT INTO outbound_send_abandonments
           (idempotency_key, actor, reason, abandoned_at) VALUES (?, ?, ?, ?)`,
      )
      .run(input.idempotencyKey, input.actor.trim(), input.reason.trim(), nowIso());
    return { released: true, reason: 'place rendue, décision consignée' };
  }

  /** Les abandons consignés, pour l'audit. */
  abandonments(): Array<{ idempotencyKey: string; actor: string; reason: string; at: string }> {
    return (this.db
      .prepare('SELECT * FROM outbound_send_abandonments ORDER BY abandoned_at ASC')
      .all() as Array<Record<string, string>>)
      .map((r) => ({
        idempotencyKey: r.idempotency_key!,
        actor: r.actor!,
        reason: r.reason!,
        at: r.abandoned_at!,
      }));
  }

  recordSendResult(input: {
    idempotencyKey: string;
    phase: 'SENT' | 'FAILED';
    externalMessageId?: string | null;
    externalThreadId?: string | null;
    error?: string | null;
  }): { recorded: boolean; reason: string } {
    try {
      this.db
        .prepare(
          `INSERT INTO outbound_send_events
             (id, idempotency_key, phase, external_message_id,
              external_thread_id, error, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id('snd'),
          input.idempotencyKey,
          input.phase,
          input.externalMessageId ?? null,
          input.externalThreadId ?? null,
          input.error ?? null,
          nowIso(),
        );
      return { recorded: true, reason: `issue ${input.phase} consignée` };
    } catch (error) {
      // L'index unique partiel a parlé : un envoi réussi existait déjà.
      const message = error instanceof Error ? error.message : String(error);
      if (message.toUpperCase().includes('UNIQUE')) {
        return { recorded: false, reason: 'un envoi réussi est déjà consigné pour cette clé' };
      }
      throw error;
    }
  }

  alreadySent(idempotencyKey: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM outbound_send_events
          WHERE idempotency_key = ? AND phase = 'SENT' LIMIT 1`,
      )
      .get(idempotencyKey) as { ok: number } | undefined;
    return Boolean(row);
  }

  /** Combien de messages sont partis depuis une date : le quota du jour. */

  /**
   * La date de notre dernier envoi vers un domaine.
   *
   * Nécessaire pour savoir qui doit parler. Le War Room calculait l'échéance de
   * relance à partir des seuls messages *reçus* : une entreprise à qui l'on
   * venait d'écrire apparaissait « à relancer », parce que rien dans son calcul
   * ne savait que nous avions écrit. L'audit, lui, lisait Gmail et trouvait la
   * bonne réponse — deux vues, deux règles, et des chiffres qui divergent.
   *
   * Lue en base plutôt que dans Gmail : le War Room doit rester consultable
   * sans réseau, et ce que nous avons envoyé par ATLAS est consigné ici.
   */
  lastSentTo(domain: string, purpose?: string): string | null {
    const row = (purpose
      ? this.db.prepare(
        `SELECT MAX(e.occurred_at) AS at FROM outbound_send_events e
           JOIN outbound_sends s ON s.idempotency_key = e.idempotency_key
          WHERE e.phase = 'SENT' AND s.domain = ? AND s.purpose = ?`,
      ).get(canonicalDomainOf(domain), purpose)
      : this.db.prepare(
        `SELECT MAX(e.occurred_at) AS at FROM outbound_send_events e
           JOIN outbound_sends s ON s.idempotency_key = e.idempotency_key
          WHERE e.phase = 'SENT' AND s.domain = ?`,
      ).get(canonicalDomainOf(domain))) as { at: string | null } | undefined;
    return row?.at ?? null;
  }

  sentSince(isoDate: string, purpose?: string): number {
    const row = purpose
      ? (this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM outbound_send_events e
               JOIN outbound_sends s ON s.idempotency_key = e.idempotency_key
              WHERE e.phase = 'SENT' AND e.occurred_at >= ? AND s.purpose = ?`,
          )
          .get(isoDate, purpose) as { n: number })
      : (this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM outbound_send_events
              WHERE phase = 'SENT' AND occurred_at >= ?`,
          )
          .get(isoDate) as { n: number });
    return row.n;
  }

  /**
   * Combien de relances sont deja parties pour UNE entreprise.
   *
   * Distinct de `sentSince` avec un `purpose` : celui-la compte a l'echelle du
   * systeme. S'en servir pour plafonner la relance ferait qu'une seule relance,
   * n'importe ou, bloquerait toutes les autres — le plafond « une par
   * entreprise » deviendrait « une en tout », ce qui n'est pas la meme regle.
   */
  /**
   * Ce qui est reellement parti, du plus recent au plus ancien.
   *
   * La reservation porte le destinataire et l'objet ; l'evenement porte l'issue
   * et l'identifiant du message chez le transporteur. Les joindre donne la
   * seule liste d'envois qui fasse foi — celle que l'ecran doit montrer, plutot
   * qu'un compteur dont personne ne peut verifier le detail.
   */
  sentLog(limit = 100): Array<{
    idempotencyKey: string; domain: string; recipient: string; subject: string;
    purpose: string; claimedBy: string; claimedAt: string;
    phase: string | null; externalMessageId: string | null; error: string | null;
    occurredAt: string | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT s.idempotency_key, s.domain, s.recipient, s.subject, s.purpose,
                s.claimed_by, s.claimed_at,
                e.phase, e.external_message_id, e.error, e.occurred_at
           FROM outbound_sends s
           LEFT JOIN outbound_send_events e
             ON e.idempotency_key = s.idempotency_key AND e.phase = 'SENT'
          ORDER BY COALESCE(e.occurred_at, s.claimed_at) DESC
          LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      idempotencyKey: row.idempotency_key as string,
      domain: row.domain as string,
      recipient: row.recipient as string,
      subject: row.subject as string,
      purpose: row.purpose as string,
      claimedBy: row.claimed_by as string,
      claimedAt: row.claimed_at as string,
      // Une reservation sans evenement n'est pas un envoi : `null` le dit.
      phase: (row.phase as string | null) ?? null,
      externalMessageId: (row.external_message_id as string | null) ?? null,
      error: (row.error as string | null) ?? null,
      occurredAt: (row.occurred_at as string | null) ?? null,
    }));
  }

  /** Les envois reussis, jour par jour. */
  sentByDay(sinceIso: string): Array<{ day: string; sent: number }> {
    const rows = this.db
      .prepare(
        `SELECT substr(occurred_at, 1, 10) AS day, COUNT(*) AS sent
           FROM outbound_send_events
          WHERE phase = 'SENT' AND occurred_at >= ?
          GROUP BY day ORDER BY day ASC`,
      )
      .all(sinceIso) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ day: r.day as string, sent: Number(r.sent) }));
  }

  followUpsFor(domain: string, purpose = 'FOLLOW_UP'): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM outbound_send_events e
           JOIN outbound_sends s ON s.idempotency_key = e.idempotency_key
          WHERE e.phase = 'SENT' AND s.domain = ? AND s.purpose = ?`,
      )
      .get(canonicalDomainOf(domain), purpose) as { n: number };
    return row.n;
  }

  // --- Brouillons ---------------------------------------------------------

  saveDraft(input: {
    domain: string;
    companyName: string;
    recipient: string;
    subject: string;
    body: string;
    purpose: string;
    conversionScore?: number | null;
    rationale?: string | null;
    sources: Array<{ quote: string; sourceUrl: string }>;
    createdBy: string;
  }): OutreachDraftRow {
    const row: OutreachDraftRow = {
      id: id('drf'),
      domain: canonicalDomainOf(input.domain),
      companyName: input.companyName,
      recipient: input.recipient,
      subject: input.subject,
      body: input.body,
      bodyHash: bodyHashOf(input.body),
      purpose: input.purpose,
      conversionScore: input.conversionScore ?? null,
      rationale: input.rationale ?? null,
      sources: input.sources,
      state: 'READY_FOR_APPROVAL',
      createdAt: nowIso(),
      createdBy: input.createdBy,
    };
    this.db
      .prepare(
        `INSERT INTO outreach_drafts
           (id, domain, company_name, recipient, subject, body, body_hash, purpose,
            conversion_score, rationale, sources, state, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.domain, row.companyName, row.recipient, row.subject, row.body,
        row.bodyHash, row.purpose, row.conversionScore, row.rationale,
        JSON.stringify(row.sources), row.state, row.createdAt, row.createdBy,
      );
    return row;
  }

  /**
   * Approuver ou refuser.
   *
   * La décision est consignée à part, puis reportée sur le brouillon. Les deux
   * sont nécessaires : la table des décisions garde qui a autorisé quoi, la
   * colonne d'état permet de lister ce qui reste à relire sans recalculer.
   */
  /**
   * Trancher le sort d'un brouillon, par ajout d'une décision.
   *
   * `ABANDONED` referme un brouillon qui ne partira pas. Le cas s'est présenté :
   * une simulation fautive avait créé et approuvé quatre brouillons sans jamais
   * les envoyer. Ils restaient en `APPROVED_TO_SEND`, c'est-à-dire prêts à
   * partir — un état qui, laissé tel quel, finit par produire un envoi que
   * personne n'a redemandé.
   *
   * Un brouillon déjà envoyé ne se referme pas : son état constate un fait, pas
   * une intention. Le reste s'abandonne, quel que soit l'état, parce qu'un
   * brouillon peut être caduc aussi bien avant qu'après approbation.
   */
  decideDraft(input: {
    draftId: string;
    decision: 'APPROVED_TO_SEND' | 'REJECTED' | 'ABANDONED';
    decidedBy: string;
    note?: string | null;
  }): { applied: boolean; reason: string } {
    const draft = this.draftById(input.draftId);
    if (!draft) return { applied: false, reason: 'brouillon inconnu' };
    if (!input.decidedBy.trim()) {
      return { applied: false, reason: 'une décision sans auteur ne se consigne pas' };
    }
    if (input.decision === 'ABANDONED') {
      if (draft.state === 'SENT') {
        return { applied: false, reason: 'déjà envoyé : un fait ne s’abandonne pas' };
      }
      if (draft.state === 'ABANDONED') return { applied: false, reason: 'déjà abandonné' };
    } else if (draft.state !== 'READY_FOR_APPROVAL') {
      return { applied: false, reason: `déjà en état ${draft.state}` };
    }
    this.db
      .prepare(
        `INSERT INTO outreach_draft_decisions
           (id, draft_id, decision, decided_by, note, decided_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id('dec'), input.draftId, input.decision, input.decidedBy, input.note ?? null, nowIso());
    this.db
      .prepare('UPDATE outreach_drafts SET state = ? WHERE id = ?')
      .run(input.decision, input.draftId);
    return { applied: true, reason: `${input.draftId} vers ${input.decision}` };
  }

  markDraftSent(draftId: string): void {
    this.db.prepare('UPDATE outreach_drafts SET state = ? WHERE id = ?').run('SENT', draftId);
  }

  draftById(draftId: string): OutreachDraftRow | null {
    const row = this.db.prepare('SELECT * FROM outreach_drafts WHERE id = ?').get(draftId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.toDraft(row) : null;
  }

  draftsInState(state: string): OutreachDraftRow[] {
    const rows = this.db
      .prepare('SELECT * FROM outreach_drafts WHERE state = ? ORDER BY created_at ASC')
      .all(state) as Array<Record<string, unknown>>;
    return rows.map((r) => this.toDraft(r));
  }

  private toDraft(r: Record<string, unknown>): OutreachDraftRow {
    return {
      id: r.id as string,
      domain: r.domain as string,
      companyName: r.company_name as string,
      recipient: r.recipient as string,
      subject: r.subject as string,
      body: r.body as string,
      bodyHash: r.body_hash as string,
      purpose: r.purpose as string,
      conversionScore: (r.conversion_score as number | null) ?? null,
      rationale: (r.rationale as string | null) ?? null,
      sources: JSON.parse((r.sources as string) || '[]'),
      state: r.state as string,
      createdAt: r.created_at as string,
      createdBy: r.created_by as string,
    };
  }
}
