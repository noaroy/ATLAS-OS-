import { id, nowIso, invalidState } from '@atlas/core';
import type { Db } from '../database.ts';
import { fromJson, toJson } from '../database.ts';

/**
 * Les commandes clients et les rapports qui en sortent.
 *
 * Séparés des missions parce qu'ils n'ont pas la même durée de vie : une
 * mission finit quand le pipeline s'arrête, un rapport vit tant qu'un client
 * peut le rouvrir et demander d'où vient une affirmation.
 *
 * Aucun encaissement n'est automatisé ici. `paidAt` est posé à la main après
 * constatation — brancher un paiement sans autorisation explicite reviendrait
 * à engager de l'argent qui n'est pas le nôtre.
 */

export type OrderStatus =
  /** L'extrait gratuit est parti, rien n'est engagé. */
  | 'teaser-sent'
  /** Le client a demandé le rapport complet. */
  | 'ordered'
  /** Paiement constaté, à la main. */
  | 'paid'
  /** La mission tourne. */
  | 'in-production'
  /** Le rapport est livré. */
  | 'delivered'
  | 'cancelled';

export type ReportState =
  | 'GENERATED'
  | 'PENDING_REVIEW'
  | 'APPROVED_FOR_DELIVERY'
  | 'REJECTED'
  | 'DELIVERED';

export type PaymentStatus = 'NONE' | 'PENDING' | 'CONFIRMED' | 'REFUNDED' | 'CANCELLED';
export type DeliveryStatus = 'NOT_READY' | 'READY_TO_DELIVER' | 'DELIVERED';

export interface ClientOrder {
  id: string;
  clientName: string;
  clientContact: string | null;
  email: string | null;
  company: string | null;
  /**
   * L'état du règlement, distinct de celui de la commande.
   *
   * Les confondre fait démarrer une production payante sur un prospect qui
   * hésite encore, et une dépense engagée ne se reprend pas.
   */
  paymentStatus: PaymentStatus;
  /** Ce qui a été constaté : virement, lien, espèces. Rempli à la main. */
  paymentReference: string | null;
  deliveryStatus: DeliveryStatus;
  brief: string;
  market: string;
  /** En centimes : un montant en flottant finit par dériver. */
  priceCents: number | null;
  currency: string;
  paidAt: string | null;
  status: OrderStatus;
  missionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClientReportRow {
  id: string;
  orderId: string | null;
  missionId: string;
  state: ReportState;
  htmlPath: string | null;
  csvPath: string | null;
  teaserPath: string | null;
  pipelineVersion: string;
  scoringVersion: string;
  executionMode: string;
  evidenceIds: string[];
  sources: string[];
  costUsd: number | null;
  candidates: number;
  retained: number;
  reviewer: string | null;
  reviewNotes: string | null;
  reviewPassed: string[];
  approvedAt: string | null;
  deliveredAt: string | null;
  generatedAt: string;
  updatedAt: string;
}

/**
 * Les transitions permises entre états d'un rapport.
 *
 * `GENERATED → DELIVERED` n'existe pas, et c'est le seul point de cette table.
 * Le dépôt refuse le saut plutôt que de le journaliser : une garde qui se
 * contente de signaler n'empêche rien.
 */
const TRANSITIONS: Readonly<Record<ReportState, readonly ReportState[]>> = {
  GENERATED: ['PENDING_REVIEW', 'REJECTED'],
  PENDING_REVIEW: ['APPROVED_FOR_DELIVERY', 'REJECTED'],
  APPROVED_FOR_DELIVERY: ['DELIVERED', 'REJECTED'],
  REJECTED: ['PENDING_REVIEW'],
  DELIVERED: [],
};

interface OrderRow {
  id: string;
  client_name: string;
  client_contact: string | null;
  customer_email: string | null;
  customer_company: string | null;
  payment_status: PaymentStatus;
  payment_reference: string | null;
  delivery_status: DeliveryStatus;
  brief: string;
  market: string;
  price_cents: number | null;
  currency: string;
  paid_at: string | null;
  status: OrderStatus;
  mission_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ReportRow {
  id: string;
  order_id: string | null;
  mission_id: string;
  state: ReportState;
  html_path: string | null;
  csv_path: string | null;
  teaser_path: string | null;
  pipeline_version: string;
  scoring_version: string;
  execution_mode: string;
  evidence_ids: string;
  sources: string;
  cost_usd: number | null;
  candidates: number;
  retained: number;
  reviewer: string | null;
  review_notes: string | null;
  review_passed: string;
  approved_at: string | null;
  delivered_at: string | null;
  generated_at: string;
  updated_at: string;
}

const toOrder = (row: OrderRow): ClientOrder => ({
  id: row.id,
  clientName: row.client_name,
  clientContact: row.client_contact,
  email: row.customer_email,
  company: row.customer_company,
  paymentStatus: (row.payment_status ?? 'NONE') as PaymentStatus,
  paymentReference: row.payment_reference,
  deliveryStatus: (row.delivery_status ?? 'NOT_READY') as DeliveryStatus,
  brief: row.brief,
  market: row.market,
  priceCents: row.price_cents,
  currency: row.currency,
  paidAt: row.paid_at,
  status: row.status,
  missionId: row.mission_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toReport = (row: ReportRow): ClientReportRow => ({
  id: row.id,
  orderId: row.order_id,
  missionId: row.mission_id,
  state: row.state,
  htmlPath: row.html_path,
  csvPath: row.csv_path,
  teaserPath: row.teaser_path,
  pipelineVersion: row.pipeline_version,
  scoringVersion: row.scoring_version,
  executionMode: row.execution_mode,
  evidenceIds: fromJson<string[]>(row.evidence_ids, []),
  sources: fromJson<string[]>(row.sources, []),
  costUsd: row.cost_usd,
  candidates: row.candidates,
  retained: row.retained,
  reviewer: row.reviewer,
  reviewNotes: row.review_notes,
  reviewPassed: fromJson<string[]>(row.review_passed, []),
  approvedAt: row.approved_at,
  deliveredAt: row.delivered_at,
  generatedAt: row.generated_at,
  updatedAt: row.updated_at,
});

export class OrderRepository {
  constructor(private readonly db: Db) {}

  // ─── Commandes ───────────────────────────────────────────────────────────

  createOrder(input: {
    clientName: string;
    clientContact?: string | null;
    email?: string | null;
    company?: string | null;
    brief: string;
    market: string;
    priceCents?: number | null;
    currency?: string;
  }): ClientOrder {
    const now = nowIso();
    const row: OrderRow = {
      id: id('ord'),
      client_name: input.clientName,
      client_contact: input.clientContact ?? null,
      customer_email: input.email ?? null,
      customer_company: input.company ?? null,
      payment_status: 'NONE',
      payment_reference: null,
      delivery_status: 'NOT_READY',
      brief: input.brief,
      market: input.market,
      price_cents: input.priceCents ?? null,
      currency: input.currency ?? 'EUR',
      paid_at: null,
      status: 'teaser-sent',
      mission_id: null,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO client_orders (id, client_name, client_contact, customer_email,
                                    customer_company, payment_status, payment_reference,
                                    delivery_status, brief, market, price_cents,
                                    currency, paid_at, status, mission_id, created_at, updated_at)
         VALUES (@id, @client_name, @client_contact, @customer_email,
                 @customer_company, @payment_status, @payment_reference,
                 @delivery_status, @brief, @market, @price_cents,
                 @currency, @paid_at, @status, @mission_id, @created_at, @updated_at)`,
      )
      .run(row);
    return toOrder(row);
  }

  getOrder(orderId: string): ClientOrder | null {
    const row = this.db.prepare('SELECT * FROM client_orders WHERE id = ?').get(orderId) as
      | OrderRow
      | undefined;
    return row ? toOrder(row) : null;
  }

  listOrders(limit = 50): ClientOrder[] {
    return (
      this.db
        .prepare('SELECT * FROM client_orders ORDER BY created_at DESC LIMIT ?')
        .all(limit) as OrderRow[]
    ).map(toOrder);
  }

  /**
   * Constate un paiement.
   *
   * Appelée à la main, jamais par un webhook : aucun encaissement n'est branché
   * sans autorisation explicite, et un statut « payé » qu'ATLAS pourrait poser
   * seul serait un statut auquel on ne peut pas se fier.
   */
  markPaid(orderId: string, reference: string, at = nowIso()): ClientOrder {
    this.db
      .prepare(
        `UPDATE client_orders SET paid_at = ?, status = 'paid', payment_status = 'CONFIRMED',
                                  payment_reference = ?, updated_at = ? WHERE id = ?`,
      )
      .run(at, reference, nowIso(), orderId);
    const order = this.getOrder(orderId);
    if (!order) throw invalidState(`Commande « ${orderId} » introuvable`);
    return order;
  }

  /** Pose l'état du règlement sans toucher au reste — utile pour PENDING. */
  setPaymentStatus(orderId: string, status: PaymentStatus): ClientOrder {
    this.db
      .prepare('UPDATE client_orders SET payment_status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowIso(), orderId);
    const order = this.getOrder(orderId);
    if (!order) throw invalidState(`Commande « ${orderId} » introuvable`);
    return order;
  }

  setDeliveryStatus(orderId: string, status: DeliveryStatus): ClientOrder {
    this.db
      .prepare('UPDATE client_orders SET delivery_status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowIso(), orderId);
    const order = this.getOrder(orderId);
    if (!order) throw invalidState(`Commande « ${orderId} » introuvable`);
    return order;
  }

  setOrderStatus(orderId: string, status: OrderStatus, missionId?: string | null): ClientOrder {
    this.db
      .prepare(
        `UPDATE client_orders SET status = ?, mission_id = COALESCE(?, mission_id), updated_at = ?
          WHERE id = ?`,
      )
      .run(status, missionId ?? null, nowIso(), orderId);
    const order = this.getOrder(orderId);
    if (!order) throw invalidState(`Commande « ${orderId} » introuvable`);
    return order;
  }

  // ─── Rapports ────────────────────────────────────────────────────────────

  recordReport(input: {
    orderId?: string | null;
    missionId: string;
    htmlPath?: string | null;
    csvPath?: string | null;
    teaserPath?: string | null;
    pipelineVersion: string;
    scoringVersion: string;
    executionMode: string;
    evidenceIds: string[];
    sources: string[];
    costUsd?: number | null;
    candidates: number;
    retained: number;
    generatedAt?: string;
  }): ClientReportRow {
    const now = nowIso();
    const row: ReportRow = {
      id: id('rep'),
      order_id: input.orderId ?? null,
      mission_id: input.missionId,
      state: 'GENERATED',
      html_path: input.htmlPath ?? null,
      csv_path: input.csvPath ?? null,
      teaser_path: input.teaserPath ?? null,
      pipeline_version: input.pipelineVersion,
      scoring_version: input.scoringVersion,
      execution_mode: input.executionMode,
      evidence_ids: toJson(input.evidenceIds),
      sources: toJson(input.sources),
      cost_usd: input.costUsd ?? null,
      candidates: input.candidates,
      retained: input.retained,
      reviewer: null,
      review_notes: null,
      review_passed: toJson([]),
      approved_at: null,
      delivered_at: null,
      generated_at: input.generatedAt ?? now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO client_reports (id, order_id, mission_id, state, html_path, csv_path,
                                     teaser_path, pipeline_version, scoring_version, execution_mode,
                                     evidence_ids, sources, cost_usd, candidates, retained,
                                     reviewer, review_notes, review_passed, approved_at,
                                     delivered_at, generated_at, updated_at)
         VALUES (@id, @order_id, @mission_id, @state, @html_path, @csv_path,
                 @teaser_path, @pipeline_version, @scoring_version, @execution_mode,
                 @evidence_ids, @sources, @cost_usd, @candidates, @retained,
                 @reviewer, @review_notes, @review_passed, @approved_at,
                 @delivered_at, @generated_at, @updated_at)`,
      )
      .run(row);
    return toReport(row);
  }

  getReport(reportId: string): ClientReportRow | null {
    const row = this.db.prepare('SELECT * FROM client_reports WHERE id = ?').get(reportId) as
      | ReportRow
      | undefined;
    return row ? toReport(row) : null;
  }

  listReports(limit = 50): ClientReportRow[] {
    return (
      this.db
        .prepare('SELECT * FROM client_reports ORDER BY generated_at DESC LIMIT ?')
        .all(limit) as ReportRow[]
    ).map(toReport);
  }

  /**
   * Change l'état d'un rapport, si la transition est permise.
   *
   * Le refus est une exception et non un journal : une garde qui se contente
   * de signaler n'empêche rien, et celle-ci existe pour qu'aucun document ne
   * parte sans avoir été lu par quelqu'un.
   */
  setReportState(
    reportId: string,
    state: ReportState,
    patch: { reviewer?: string | null; notes?: string | null; passed?: string[] } = {},
  ): ClientReportRow {
    const current = this.getReport(reportId);
    if (!current) throw invalidState(`Rapport « ${reportId} » introuvable`);
    if (!TRANSITIONS[current.state].includes(state)) {
      throw invalidState(
        `Transition refusée : ${current.state} → ${state}. ` +
          `Depuis ${current.state}, seuls ${TRANSITIONS[current.state].join(', ') || '(aucun état)'} ` +
          `sont atteignables. Un rapport ne se livre pas sans avoir été relu.`,
      );
    }

    const now = nowIso();
    this.db
      .prepare(
        `UPDATE client_reports SET
           state = @state,
           reviewer = COALESCE(@reviewer, reviewer),
           review_notes = COALESCE(@notes, review_notes),
           review_passed = COALESCE(@passed, review_passed),
           approved_at = CASE WHEN @state = 'APPROVED_FOR_DELIVERY' THEN @now ELSE approved_at END,
           delivered_at = CASE WHEN @state = 'DELIVERED' THEN @now ELSE delivered_at END,
           updated_at = @now
         WHERE id = @id`,
      )
      .run({
        id: reportId,
        state,
        reviewer: patch.reviewer ?? null,
        notes: patch.notes ?? null,
        passed: patch.passed ? toJson(patch.passed) : null,
        now,
      });

    return this.getReport(reportId)!;
  }
}
