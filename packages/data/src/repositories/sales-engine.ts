import { id, nowIso, canonicalDomainOf } from '@atlas/core';
import type { Db } from '../database.ts';
import { fromJson, toJson, toBool, fromBool } from '../database.ts';

/**
 * La mémoire du moteur commercial en production.
 *
 * Les tables d'ici ne décident d'aucun envoi : la porte reste `outbound_sends`
 * et le registre `outreach_ledger`. Elles répondent à trois questions que la
 * boucle ne savait pas poser : à quel marché et à quel message chaque contact
 * doit-il son existence, qu'est-ce que cela a rapporté, et qu'a-t-on décidé
 * de changer — avec la version d'avant, pour revenir dessus.
 *
 * Deux règles traversent tout le fichier. Les issues commerciales (rendez-vous,
 * gagné, chiffre d'affaires) sont saisies par une personne : aucune méthode ne
 * les déduit. Et la liste de suppression ne se vide jamais par effet de bord :
 * une entrée s'ajoute, elle ne se retire qu'à la main.
 */

export const SEGMENT_STATUSES = ['TESTING', 'VALIDATED', 'SCALE', 'PAUSED', 'STOPPED'] as const;
export type SegmentStatus = (typeof SEGMENT_STATUSES)[number];

export interface SalesSegment {
  id: string;
  name: string;
  countries: string[];
  sectors: string[];
  companySize: { min?: number; max?: number } | null;
  keywords: string[];
  exclusions: string[];
  targetPersonas: string[];
  buyingSignals: string[];
  offerAngle: string | null;
  status: SegmentStatus;
  explorationWeight: number;
  approvedForSend: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SalesAttribution {
  domain: string;
  prospectId: string | null;
  segmentId: string | null;
  persona: string | null;
  angle: string | null;
  messageVariant: string | null;
  subjectVariant: string | null;
  followupVariant: string | null;
  experimentId: string | null;
  discoveredAt: string | null;
  contactedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const OUTCOME_KINDS = ['MEETING_BOOKED', 'MEETING_DONE', 'PROPOSAL_SENT', 'WON', 'LOST'] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export interface SalesOutcome {
  id: string;
  domain: string;
  kind: OutcomeKind;
  revenueAmount: number | null;
  currency: string | null;
  occurredAt: string;
  offer: string | null;
  segmentId: string | null;
  recordedBy: string;
  note: string | null;
  createdAt: string;
}

export const SUPPRESSION_KINDS = ['EMAIL', 'DOMAIN', 'COMPANY'] as const;
export type SuppressionKind = (typeof SUPPRESSION_KINDS)[number];
export const SUPPRESSION_REASONS = ['OPT_OUT', 'BOUNCE', 'MANUAL', 'LEGAL', 'BAD_CONTACT'] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export interface SuppressionEntry {
  id: string;
  kind: SuppressionKind;
  value: string;
  reason: SuppressionReason;
  source: string | null;
  evidence: string | null;
  createdBy: string;
  createdAt: string;
}

export const EXPERIMENT_DIMENSIONS = [
  'segment', 'persona', 'angle', 'message_variant', 'subject_variant', 'followup_variant',
] as const;
export type ExperimentDimension = (typeof EXPERIMENT_DIMENSIONS)[number];

export interface SalesExperiment {
  id: string;
  name: string;
  dimension: ExperimentDimension;
  variants: Array<{ key: string; weight: number }>;
  segmentId: string | null;
  status: 'ACTIVE' | 'PAUSED' | 'CONCLUDED';
  winner: string | null;
  createdAt: string;
  concludedAt: string | null;
}

export const RECOMMENDATION_KINDS = [
  'SCALE_SEGMENT', 'REDUCE_SEGMENT', 'TEST_NEW_MESSAGE', 'PROMOTE_MESSAGE', 'TEST_PERSONA',
  'CHANGE_ANGLE', 'IMPROVE_CONTACT_SOURCE', 'CHANGE_FOLLOWUP', 'ENGINEERING_INSIGHT',
] as const;
export type RecommendationKind = (typeof RECOMMENDATION_KINDS)[number];
export const RECOMMENDATION_STATUSES = [
  'PROPOSED', 'TESTING', 'APPROVED', 'REJECTED', 'SUCCESS', 'FAILED', 'ROLLED_BACK',
] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

export interface OptimizationRecommendation {
  id: string;
  kind: RecommendationKind;
  title: string;
  reason: string;
  evidence: Record<string, unknown>;
  sampleSize: number;
  expectedImpact: string | null;
  risk: 'low' | 'medium' | 'high';
  status: RecommendationStatus;
  /** Le réglage commercial que VALIDER appliquerait. Null = rien à appliquer (insight). */
  change: Record<string, unknown> | null;
  humanRequired: boolean;
  fingerprint: string;
  strategyVersionId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StrategyVersion {
  id: string;
  version: number;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  reason: string;
  recommendationId: string | null;
  metricsBefore: Record<string, unknown> | null;
  createdBy: string;
  createdAt: string;
  rolledBackAt: string | null;
  rollbackOf: string | null;
}

export interface EngineeringInsight {
  id: string;
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
  frequency: number;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export const FRICTION_KINDS = [
  'CONTACT_NOT_FOUND', 'SEARCH_FAILURE', 'COUNTRY_UNCERTAIN', 'LOW_SIGNAL', 'LLM_FAILURE',
  'SEND_BLOCKED', 'DISCOVERY_UNAVAILABLE', 'GMAIL_UNAVAILABLE', 'BUDGET_EXHAUSTED',
] as const;
export type FrictionKind = (typeof FRICTION_KINDS)[number];

export interface FrictionEvent {
  id: string;
  kind: FrictionKind;
  domain: string | null;
  segmentId: string | null;
  detail: string | null;
  createdAt: string;
}

const list = (raw: unknown): string[] => fromJson<string[]>(raw as string, []);

const toSegment = (r: Record<string, unknown>): SalesSegment => ({
  id: r.id as string,
  name: r.name as string,
  countries: list(r.countries),
  sectors: list(r.sectors),
  companySize: fromJson<{ min?: number; max?: number } | null>(r.company_size as string, null),
  keywords: list(r.keywords),
  exclusions: list(r.exclusions),
  targetPersonas: list(r.target_personas),
  buyingSignals: list(r.buying_signals),
  offerAngle: (r.offer_angle as string | null) ?? null,
  status: r.status as SegmentStatus,
  explorationWeight: Number(r.exploration_weight),
  approvedForSend: toBool(r.approved_for_send),
  approvedBy: (r.approved_by as string | null) ?? null,
  approvedAt: (r.approved_at as string | null) ?? null,
  notes: (r.notes as string | null) ?? null,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

const toAttribution = (r: Record<string, unknown>): SalesAttribution => ({
  domain: r.domain as string,
  prospectId: (r.prospect_id as string | null) ?? null,
  segmentId: (r.segment_id as string | null) ?? null,
  persona: (r.persona as string | null) ?? null,
  angle: (r.angle as string | null) ?? null,
  messageVariant: (r.message_variant as string | null) ?? null,
  subjectVariant: (r.subject_variant as string | null) ?? null,
  followupVariant: (r.followup_variant as string | null) ?? null,
  experimentId: (r.experiment_id as string | null) ?? null,
  discoveredAt: (r.discovered_at as string | null) ?? null,
  contactedAt: (r.contacted_at as string | null) ?? null,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

const toOutcome = (r: Record<string, unknown>): SalesOutcome => ({
  id: r.id as string,
  domain: r.domain as string,
  kind: r.kind as OutcomeKind,
  revenueAmount: r.revenue_amount === null || r.revenue_amount === undefined ? null : Number(r.revenue_amount),
  currency: (r.currency as string | null) ?? null,
  occurredAt: r.occurred_at as string,
  offer: (r.offer as string | null) ?? null,
  segmentId: (r.segment_id as string | null) ?? null,
  recordedBy: r.recorded_by as string,
  note: (r.note as string | null) ?? null,
  createdAt: r.created_at as string,
});

const toSuppression = (r: Record<string, unknown>): SuppressionEntry => ({
  id: r.id as string,
  kind: r.kind as SuppressionKind,
  value: r.value as string,
  reason: r.reason as SuppressionReason,
  source: (r.source as string | null) ?? null,
  evidence: (r.evidence as string | null) ?? null,
  createdBy: r.created_by as string,
  createdAt: r.created_at as string,
});

const toExperiment = (r: Record<string, unknown>): SalesExperiment => ({
  id: r.id as string,
  name: r.name as string,
  dimension: r.dimension as ExperimentDimension,
  variants: fromJson<Array<{ key: string; weight: number }>>(r.variants as string, []),
  segmentId: (r.segment_id as string | null) ?? null,
  status: r.status as SalesExperiment['status'],
  winner: (r.winner as string | null) ?? null,
  createdAt: r.created_at as string,
  concludedAt: (r.concluded_at as string | null) ?? null,
});

const toRecommendation = (r: Record<string, unknown>): OptimizationRecommendation => ({
  id: r.id as string,
  kind: r.kind as RecommendationKind,
  title: r.title as string,
  reason: r.reason as string,
  evidence: fromJson<Record<string, unknown>>(r.evidence as string, {}),
  sampleSize: Number(r.sample_size),
  expectedImpact: (r.expected_impact as string | null) ?? null,
  risk: r.risk as OptimizationRecommendation['risk'],
  status: r.status as RecommendationStatus,
  change: fromJson<Record<string, unknown> | null>(r.change as string | null, null),
  humanRequired: toBool(r.human_required),
  fingerprint: r.fingerprint as string,
  strategyVersionId: (r.strategy_version_id as string | null) ?? null,
  decidedBy: (r.decided_by as string | null) ?? null,
  decidedAt: (r.decided_at as string | null) ?? null,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

const toStrategyVersion = (r: Record<string, unknown>): StrategyVersion => ({
  id: r.id as string,
  version: Number(r.version),
  before: fromJson<Record<string, unknown>>(r.before_json as string, {}),
  after: fromJson<Record<string, unknown>>(r.after_json as string, {}),
  reason: r.reason as string,
  recommendationId: (r.recommendation_id as string | null) ?? null,
  metricsBefore: fromJson<Record<string, unknown> | null>(r.metrics_before as string | null, null),
  createdBy: r.created_by as string,
  createdAt: r.created_at as string,
  rolledBackAt: (r.rolled_back_at as string | null) ?? null,
  rollbackOf: (r.rollback_of as string | null) ?? null,
});

const toInsight = (r: Record<string, unknown>): EngineeringInsight => ({
  id: r.id as string,
  title: r.title as string,
  detail: r.detail as string,
  evidence: fromJson<Record<string, unknown>>(r.evidence as string, {}),
  frequency: Number(r.frequency),
  status: r.status as EngineeringInsight['status'],
  fingerprint: r.fingerprint as string,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
  lastSeenAt: r.last_seen_at as string,
});

const toFriction = (r: Record<string, unknown>): FrictionEvent => ({
  id: r.id as string,
  kind: r.kind as FrictionKind,
  domain: (r.domain as string | null) ?? null,
  segmentId: (r.segment_id as string | null) ?? null,
  detail: (r.detail as string | null) ?? null,
  createdAt: r.created_at as string,
});

const normaliseEmail = (value: string): string => value.trim().toLowerCase();
const normaliseCompany = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, ' ');

export class SalesEngineRepository {
  constructor(private readonly db: Db) {}

  // ─── Segments ─────────────────────────────────────────────────────────────

  createSegment(input: {
    name: string;
    countries?: string[];
    sectors?: string[];
    companySize?: { min?: number; max?: number } | null;
    keywords?: string[];
    exclusions?: string[];
    targetPersonas?: string[];
    buyingSignals?: string[];
    offerAngle?: string | null;
    status?: SegmentStatus;
    explorationWeight?: number;
    notes?: string | null;
  }): { segment: SalesSegment; created: boolean } {
    const existing = this.segmentByName(input.name);
    if (existing) return { segment: existing, created: false };
    const now = nowIso();
    const segmentId = id('seg');
    this.db
      .prepare(
        `INSERT INTO sales_segments
           (id, name, countries, sectors, company_size, keywords, exclusions, target_personas,
            buying_signals, offer_angle, status, exploration_weight, approved_for_send, notes,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        segmentId,
        input.name.trim(),
        toJson(input.countries ?? []),
        toJson(input.sectors ?? []),
        input.companySize ? toJson(input.companySize) : null,
        toJson(input.keywords ?? []),
        toJson(input.exclusions ?? []),
        toJson(input.targetPersonas ?? []),
        toJson(input.buyingSignals ?? []),
        input.offerAngle ?? null,
        input.status ?? 'TESTING',
        input.explorationWeight ?? 1,
        input.notes ?? null,
        now,
        now,
      );
    return { segment: this.segment(segmentId)!, created: true };
  }

  segment(segmentId: string): SalesSegment | null {
    const row = this.db.prepare('SELECT * FROM sales_segments WHERE id = ?').get(segmentId) as
      | Record<string, unknown>
      | undefined;
    return row ? toSegment(row) : null;
  }

  segmentByName(name: string): SalesSegment | null {
    const row = this.db
      .prepare('SELECT * FROM sales_segments WHERE lower(name) = lower(?)')
      .get(name.trim()) as Record<string, unknown> | undefined;
    return row ? toSegment(row) : null;
  }

  segments(filter: { status?: SegmentStatus | SegmentStatus[] } = {}): SalesSegment[] {
    const statuses = filter.status
      ? Array.isArray(filter.status) ? filter.status : [filter.status]
      : null;
    const rows = statuses
      ? this.db
          .prepare(
            `SELECT * FROM sales_segments WHERE status IN (${statuses.map(() => '?').join(',')})
              ORDER BY created_at ASC`,
          )
          .all(...statuses)
      : this.db.prepare('SELECT * FROM sales_segments ORDER BY created_at ASC').all();
    return (rows as Array<Record<string, unknown>>).map(toSegment);
  }

  /** Le statut d'un segment change ; la raison est gardée dans les notes. */
  setSegmentStatus(segmentId: string, status: SegmentStatus, by: string, note?: string | null): SalesSegment {
    const current = this.segment(segmentId);
    if (!current) throw new Error(`segment inconnu : ${segmentId}`);
    const stamp = `${nowIso().slice(0, 16)} ${by}: ${current.status} → ${status}${note ? ` — ${note}` : ''}`;
    const notes = current.notes ? `${current.notes}\n${stamp}` : stamp;
    this.db
      .prepare('UPDATE sales_segments SET status = ?, notes = ?, updated_at = ? WHERE id = ?')
      .run(status, notes, nowIso(), segmentId);
    return this.segment(segmentId)!;
  }

  setSegmentWeight(segmentId: string, explorationWeight: number): SalesSegment {
    this.db
      .prepare('UPDATE sales_segments SET exploration_weight = ?, updated_at = ? WHERE id = ?')
      .run(explorationWeight, nowIso(), segmentId);
    const segment = this.segment(segmentId);
    if (!segment) throw new Error(`segment inconnu : ${segmentId}`);
    return segment;
  }

  /**
   * L'approbation d'envoi d'une campagne. Une personne nommée, une date : un
   * segment jamais approuvé n'envoie rien, quel que soit son statut.
   */
  approveSegmentForSend(segmentId: string, by: string): SalesSegment {
    if (!by.trim()) throw new Error("une approbation sans auteur ne se consigne pas");
    this.db
      .prepare(
        `UPDATE sales_segments SET approved_for_send = 1, approved_by = ?, approved_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(by, nowIso(), nowIso(), segmentId);
    const segment = this.segment(segmentId);
    if (!segment) throw new Error(`segment inconnu : ${segmentId}`);
    return segment;
  }

  revokeSegmentApproval(segmentId: string, by: string, reason: string): SalesSegment {
    const current = this.segment(segmentId);
    if (!current) throw new Error(`segment inconnu : ${segmentId}`);
    const stamp = `${nowIso().slice(0, 16)} ${by}: approbation retirée — ${reason}`;
    this.db
      .prepare(
        `UPDATE sales_segments SET approved_for_send = 0, notes = ?, updated_at = ? WHERE id = ?`,
      )
      .run(current.notes ? `${current.notes}\n${stamp}` : stamp, nowIso(), segmentId);
    return this.segment(segmentId)!;
  }

  // ─── Attributions ─────────────────────────────────────────────────────────

  /**
   * Rattache une entreprise à ce qui l'a produite. Idempotent : une valeur déjà
   * posée n'est jamais écrasée par une valeur nulle, et la première attribution
   * d'un segment reste la bonne — c'est elle qui explique le message envoyé.
   */
  attribute(input: {
    domain: string;
    prospectId?: string | null;
    segmentId?: string | null;
    persona?: string | null;
    angle?: string | null;
    messageVariant?: string | null;
    subjectVariant?: string | null;
    followupVariant?: string | null;
    experimentId?: string | null;
    discoveredAt?: string | null;
  }): SalesAttribution {
    const domain = canonicalDomainOf(input.domain);
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO sales_attributions
           (domain, prospect_id, segment_id, persona, angle, message_variant, subject_variant,
            followup_variant, experiment_id, discovered_at, contacted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(domain) DO UPDATE SET
           prospect_id      = COALESCE(sales_attributions.prospect_id, excluded.prospect_id),
           segment_id       = COALESCE(sales_attributions.segment_id, excluded.segment_id),
           persona          = COALESCE(sales_attributions.persona, excluded.persona),
           angle            = COALESCE(sales_attributions.angle, excluded.angle),
           message_variant  = COALESCE(sales_attributions.message_variant, excluded.message_variant),
           subject_variant  = COALESCE(sales_attributions.subject_variant, excluded.subject_variant),
           followup_variant = COALESCE(sales_attributions.followup_variant, excluded.followup_variant),
           experiment_id    = COALESCE(sales_attributions.experiment_id, excluded.experiment_id),
           discovered_at    = COALESCE(sales_attributions.discovered_at, excluded.discovered_at),
           updated_at       = excluded.updated_at`,
      )
      .run(
        domain,
        input.prospectId ?? null,
        input.segmentId ?? null,
        input.persona ?? null,
        input.angle ?? null,
        input.messageVariant ?? null,
        input.subjectVariant ?? null,
        input.followupVariant ?? null,
        input.experimentId ?? null,
        input.discoveredAt ?? now,
        now,
        now,
      );
    return this.attributionFor(domain)!;
  }

  markContacted(domain: string, contactedAt = nowIso()): void {
    const canonical = canonicalDomainOf(domain);
    this.attribute({ domain: canonical });
    this.db
      .prepare(
        `UPDATE sales_attributions SET contacted_at = COALESCE(contacted_at, ?), updated_at = ?
          WHERE domain = ?`,
      )
      .run(contactedAt, nowIso(), canonical);
  }

  attributionFor(domain: string): SalesAttribution | null {
    const row = this.db
      .prepare('SELECT * FROM sales_attributions WHERE domain = ?')
      .get(canonicalDomainOf(domain)) as Record<string, unknown> | undefined;
    return row ? toAttribution(row) : null;
  }

  attributions(filter: { segmentId?: string | null; contactedSince?: string | null } = {}): SalesAttribution[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.segmentId) {
      clauses.push('segment_id = ?');
      params.push(filter.segmentId);
    }
    if (filter.contactedSince) {
      clauses.push('contacted_at IS NOT NULL AND contacted_at >= ?');
      params.push(filter.contactedSince);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM sales_attributions ${where} ORDER BY created_at ASC`)
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map(toAttribution);
  }

  // ─── Issues commerciales ──────────────────────────────────────────────────

  /** Toujours saisi par une personne nommée : le moteur ne déduit aucune issue. */
  recordOutcome(input: {
    domain: string;
    kind: OutcomeKind;
    revenueAmount?: number | null;
    currency?: string | null;
    occurredAt?: string;
    offer?: string | null;
    segmentId?: string | null;
    recordedBy: string;
    note?: string | null;
  }): SalesOutcome {
    if (!input.recordedBy.trim()) throw new Error("une issue sans auteur ne se consigne pas");
    if (!OUTCOME_KINDS.includes(input.kind)) throw new Error(`issue inconnue : ${input.kind}`);
    if (input.kind === 'WON' && (input.revenueAmount === null || input.revenueAmount === undefined)) {
      throw new Error('un client gagné se consigne avec son montant (0 accepté)');
    }
    const domain = canonicalDomainOf(input.domain);
    const attribution = this.attributionFor(domain);
    const outcomeId = id('out');
    this.db
      .prepare(
        `INSERT INTO sales_outcomes
           (id, domain, kind, revenue_amount, currency, occurred_at, offer, segment_id, recorded_by,
            note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        outcomeId,
        domain,
        input.kind,
        input.revenueAmount ?? null,
        input.currency ?? (input.revenueAmount !== null && input.revenueAmount !== undefined ? 'EUR' : null),
        input.occurredAt ?? nowIso(),
        input.offer ?? null,
        input.segmentId ?? attribution?.segmentId ?? null,
        input.recordedBy,
        input.note ?? null,
        nowIso(),
      );
    return this.outcome(outcomeId)!;
  }

  outcome(outcomeId: string): SalesOutcome | null {
    const row = this.db.prepare('SELECT * FROM sales_outcomes WHERE id = ?').get(outcomeId) as
      | Record<string, unknown>
      | undefined;
    return row ? toOutcome(row) : null;
  }

  outcomes(filter: { since?: string | null; kind?: OutcomeKind; segmentId?: string | null } = {}): SalesOutcome[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.since) {
      clauses.push('occurred_at >= ?');
      params.push(filter.since);
    }
    if (filter.kind) {
      clauses.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.segmentId) {
      clauses.push('segment_id = ?');
      params.push(filter.segmentId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM sales_outcomes ${where} ORDER BY occurred_at ASC`)
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map(toOutcome);
  }

  outcomesFor(domain: string): SalesOutcome[] {
    const rows = this.db
      .prepare('SELECT * FROM sales_outcomes WHERE domain = ? ORDER BY occurred_at ASC')
      .all(canonicalDomainOf(domain)) as Array<Record<string, unknown>>;
    return rows.map(toOutcome);
  }

  // ─── Liste de suppression ─────────────────────────────────────────────────

  suppress(input: {
    kind: SuppressionKind;
    value: string;
    reason: SuppressionReason;
    source?: string | null;
    evidence?: string | null;
    createdBy: string;
  }): { entry: SuppressionEntry; created: boolean } {
    if (!input.createdBy.trim()) throw new Error("une suppression sans auteur ne se consigne pas");
    const value =
      input.kind === 'EMAIL' ? normaliseEmail(input.value)
      : input.kind === 'DOMAIN' ? canonicalDomainOf(input.value)
      : normaliseCompany(input.value);
    if (!value) throw new Error('une suppression sans valeur ne protège personne');
    const existing = this.db
      .prepare('SELECT * FROM suppression_list WHERE kind = ? AND value = ?')
      .get(input.kind, value) as Record<string, unknown> | undefined;
    if (existing) return { entry: toSuppression(existing), created: false };
    const entryId = id('sup');
    this.db
      .prepare(
        `INSERT INTO suppression_list (id, kind, value, reason, source, evidence, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(entryId, input.kind, value, input.reason, input.source ?? null, input.evidence ?? null, input.createdBy, nowIso());
    return { entry: this.suppressionById(entryId)!, created: true };
  }

  private suppressionById(entryId: string): SuppressionEntry | null {
    const row = this.db.prepare('SELECT * FROM suppression_list WHERE id = ?').get(entryId) as
      | Record<string, unknown>
      | undefined;
    return row ? toSuppression(row) : null;
  }

  /**
   * La question posée avant chaque envoi : cette adresse, ce domaine ou cette
   * société sont-ils sur la liste ? La première entrée trouvée suffit.
   */
  isSuppressed(target: { email?: string | null; domain?: string | null; company?: string | null }): {
    suppressed: boolean;
    entry: SuppressionEntry | null;
  } {
    const probes: Array<[SuppressionKind, string]> = [];
    if (target.email) {
      probes.push(['EMAIL', normaliseEmail(target.email)]);
      const at = target.email.indexOf('@');
      if (at > 0 && !target.domain) probes.push(['DOMAIN', canonicalDomainOf(target.email.slice(at + 1))]);
    }
    if (target.domain) probes.push(['DOMAIN', canonicalDomainOf(target.domain)]);
    if (target.company) probes.push(['COMPANY', normaliseCompany(target.company)]);
    for (const [kind, value] of probes) {
      if (!value) continue;
      const row = this.db
        .prepare('SELECT * FROM suppression_list WHERE kind = ? AND value = ?')
        .get(kind, value) as Record<string, unknown> | undefined;
      if (row) return { suppressed: true, entry: toSuppression(row) };
    }
    return { suppressed: false, entry: null };
  }

  suppressions(): SuppressionEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM suppression_list ORDER BY created_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(toSuppression);
  }

  // ─── Expériences ──────────────────────────────────────────────────────────

  createExperiment(input: {
    name: string;
    dimension: ExperimentDimension;
    variants: Array<{ key: string; weight: number }>;
    segmentId?: string | null;
  }): SalesExperiment {
    if (input.variants.length < 2) throw new Error('une expérience compare au moins deux variantes');
    const experimentId = id('exp');
    this.db
      .prepare(
        `INSERT INTO sales_experiments (id, name, dimension, variants, segment_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)`,
      )
      .run(experimentId, input.name, input.dimension, toJson(input.variants), input.segmentId ?? null, nowIso());
    return this.experiment(experimentId)!;
  }

  experiment(experimentId: string): SalesExperiment | null {
    const row = this.db.prepare('SELECT * FROM sales_experiments WHERE id = ?').get(experimentId) as
      | Record<string, unknown>
      | undefined;
    return row ? toExperiment(row) : null;
  }

  experiments(filter: { status?: SalesExperiment['status']; dimension?: ExperimentDimension } = {}): SalesExperiment[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter.dimension) {
      clauses.push('dimension = ?');
      params.push(filter.dimension);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM sales_experiments ${where} ORDER BY created_at ASC`)
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map(toExperiment);
  }

  setExperimentVariants(experimentId: string, variants: Array<{ key: string; weight: number }>): SalesExperiment {
    this.db
      .prepare('UPDATE sales_experiments SET variants = ? WHERE id = ?')
      .run(toJson(variants), experimentId);
    const experiment = this.experiment(experimentId);
    if (!experiment) throw new Error(`expérience inconnue : ${experimentId}`);
    return experiment;
  }

  concludeExperiment(experimentId: string, winner: string | null, status: 'CONCLUDED' | 'PAUSED' = 'CONCLUDED'): SalesExperiment {
    this.db
      .prepare('UPDATE sales_experiments SET status = ?, winner = ?, concluded_at = ? WHERE id = ?')
      .run(status, winner, status === 'CONCLUDED' ? nowIso() : null, experimentId);
    const experiment = this.experiment(experimentId);
    if (!experiment) throw new Error(`expérience inconnue : ${experimentId}`);
    return experiment;
  }

  // ─── Recommandations ──────────────────────────────────────────────────────

  /**
   * Propose une recommandation. La même idée (même empreinte) encore ouverte
   * n'est pas reproposée : l'index partiel rend le contrôle sûr même si deux
   * cycles d'optimisation se chevauchent.
   */
  propose(input: {
    kind: RecommendationKind;
    title: string;
    reason: string;
    evidence?: Record<string, unknown>;
    sampleSize?: number;
    expectedImpact?: string | null;
    risk?: OptimizationRecommendation['risk'];
    change?: Record<string, unknown> | null;
    humanRequired?: boolean;
    fingerprint: string;
  }): { recommendation: OptimizationRecommendation; created: boolean } {
    const open = this.db
      .prepare(
        `SELECT * FROM optimization_recommendations
          WHERE fingerprint = ? AND status IN ('PROPOSED', 'TESTING', 'APPROVED')`,
      )
      .get(input.fingerprint) as Record<string, unknown> | undefined;
    if (open) return { recommendation: toRecommendation(open), created: false };
    const now = nowIso();
    const recommendationId = id('rec');
    this.db
      .prepare(
        `INSERT INTO optimization_recommendations
           (id, kind, title, reason, evidence, sample_size, expected_impact, risk, status, change,
            human_required, fingerprint, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PROPOSED', ?, ?, ?, ?, ?)`,
      )
      .run(
        recommendationId,
        input.kind,
        input.title,
        input.reason,
        toJson(input.evidence ?? {}),
        input.sampleSize ?? 0,
        input.expectedImpact ?? null,
        input.risk ?? 'low',
        input.change ? toJson(input.change) : null,
        fromBool(input.humanRequired ?? true),
        input.fingerprint,
        now,
        now,
      );
    return { recommendation: this.recommendation(recommendationId)!, created: true };
  }

  recommendation(recommendationId: string): OptimizationRecommendation | null {
    const row = this.db
      .prepare('SELECT * FROM optimization_recommendations WHERE id = ?')
      .get(recommendationId) as Record<string, unknown> | undefined;
    return row ? toRecommendation(row) : null;
  }

  recommendations(filter: { status?: RecommendationStatus | RecommendationStatus[]; limit?: number } = {}): OptimizationRecommendation[] {
    const statuses = filter.status
      ? Array.isArray(filter.status) ? filter.status : [filter.status]
      : null;
    const where = statuses ? `WHERE status IN (${statuses.map(() => '?').join(',')})` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM optimization_recommendations ${where}
          ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...(statuses ?? []), filter.limit ?? 100) as Array<Record<string, unknown>>;
    return rows.map(toRecommendation);
  }

  setRecommendationStatus(
    recommendationId: string,
    status: RecommendationStatus,
    decidedBy: string,
    extra: { strategyVersionId?: string | null } = {},
  ): OptimizationRecommendation {
    if (!decidedBy.trim()) throw new Error("une décision sans auteur ne se consigne pas");
    const current = this.recommendation(recommendationId);
    if (!current) throw new Error(`recommandation inconnue : ${recommendationId}`);
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE optimization_recommendations
            SET status = ?, decided_by = ?, decided_at = ?, updated_at = ?,
                strategy_version_id = COALESCE(?, strategy_version_id)
          WHERE id = ?`,
      )
      .run(status, decidedBy, now, now, extra.strategyVersionId ?? null, recommendationId);
    return this.recommendation(recommendationId)!;
  }

  // ─── Versions de stratégie ────────────────────────────────────────────────

  recordStrategyVersion(input: {
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    reason: string;
    recommendationId?: string | null;
    metricsBefore?: Record<string, unknown> | null;
    createdBy: string;
    rollbackOf?: string | null;
  }): StrategyVersion {
    if (!input.createdBy.trim()) throw new Error("un changement de stratégie sans auteur ne se consigne pas");
    const last = this.db
      .prepare('SELECT MAX(version) AS v FROM strategy_versions')
      .get() as { v: number | null };
    const versionId = id('stv');
    this.db
      .prepare(
        `INSERT INTO strategy_versions
           (id, version, before_json, after_json, reason, recommendation_id, metrics_before,
            created_by, created_at, rollback_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        versionId,
        (last.v ?? 0) + 1,
        toJson(input.before),
        toJson(input.after),
        input.reason,
        input.recommendationId ?? null,
        input.metricsBefore ? toJson(input.metricsBefore) : null,
        input.createdBy,
        nowIso(),
        input.rollbackOf ?? null,
      );
    return this.strategyVersion(versionId)!;
  }

  strategyVersion(versionId: string): StrategyVersion | null {
    const row = this.db.prepare('SELECT * FROM strategy_versions WHERE id = ?').get(versionId) as
      | Record<string, unknown>
      | undefined;
    return row ? toStrategyVersion(row) : null;
  }

  strategyVersions(limit = 50): StrategyVersion[] {
    const rows = this.db
      .prepare('SELECT * FROM strategy_versions ORDER BY version DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(toStrategyVersion);
  }

  markRolledBack(versionId: string): void {
    this.db
      .prepare('UPDATE strategy_versions SET rolled_back_at = ? WHERE id = ?')
      .run(nowIso(), versionId);
  }

  // ─── Insights d'ingénierie ────────────────────────────────────────────────

  /** Un insight revu n'est pas dupliqué : sa fréquence augmente et sa date bouge. */
  upsertInsight(input: {
    title: string;
    detail: string;
    evidence?: Record<string, unknown>;
    fingerprint: string;
  }): EngineeringInsight {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO engineering_insights
           (id, title, detail, evidence, frequency, status, fingerprint, created_at, updated_at, last_seen_at)
         VALUES (?, ?, ?, ?, 1, 'OPEN', ?, ?, ?, ?)
         ON CONFLICT(fingerprint) DO UPDATE SET
           detail = excluded.detail,
           evidence = excluded.evidence,
           frequency = engineering_insights.frequency + 1,
           updated_at = excluded.updated_at,
           last_seen_at = excluded.last_seen_at,
           status = CASE WHEN engineering_insights.status = 'RESOLVED' THEN 'OPEN' ELSE engineering_insights.status END`,
      )
      .run(id('ins'), input.title, input.detail, toJson(input.evidence ?? {}), input.fingerprint, now, now, now);
    const row = this.db
      .prepare('SELECT * FROM engineering_insights WHERE fingerprint = ?')
      .get(input.fingerprint) as Record<string, unknown>;
    return toInsight(row);
  }

  insights(filter: { status?: EngineeringInsight['status'] } = {}): EngineeringInsight[] {
    const rows = (filter.status
      ? this.db.prepare('SELECT * FROM engineering_insights WHERE status = ? ORDER BY frequency DESC, last_seen_at DESC').all(filter.status)
      : this.db.prepare('SELECT * FROM engineering_insights ORDER BY frequency DESC, last_seen_at DESC').all()
    ) as Array<Record<string, unknown>>;
    return rows.map(toInsight);
  }

  setInsightStatus(insightId: string, status: EngineeringInsight['status']): void {
    this.db
      .prepare('UPDATE engineering_insights SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowIso(), insightId);
  }

  // ─── Frictions ────────────────────────────────────────────────────────────

  recordFriction(input: {
    kind: FrictionKind;
    domain?: string | null;
    segmentId?: string | null;
    detail?: string | null;
  }): FrictionEvent {
    const eventId = id('frc');
    this.db
      .prepare(
        `INSERT INTO sales_friction_events (id, kind, domain, segment_id, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        input.kind,
        input.domain ? canonicalDomainOf(input.domain) : null,
        input.segmentId ?? null,
        input.detail ? input.detail.slice(0, 500) : null,
        nowIso(),
      );
    const row = this.db.prepare('SELECT * FROM sales_friction_events WHERE id = ?').get(eventId) as Record<string, unknown>;
    return toFriction(row);
  }

  frictionCounts(since: string): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT kind, COUNT(*) AS n FROM sales_friction_events WHERE created_at >= ?
          GROUP BY kind ORDER BY n DESC`,
      )
      .all(since) as Array<{ kind: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)]));
  }

  frictions(filter: { since?: string; kind?: FrictionKind; limit?: number } = {}): FrictionEvent[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.since) {
      clauses.push('created_at >= ?');
      params.push(filter.since);
    }
    if (filter.kind) {
      clauses.push('kind = ?');
      params.push(filter.kind);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM sales_friction_events ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, filter.limit ?? 200) as Array<Record<string, unknown>>;
    return rows.map(toFriction);
  }

  pruneFrictions(before: string): number {
    return this.db.prepare('DELETE FROM sales_friction_events WHERE created_at < ?').run(before).changes;
  }

  // ─── Réponses chaudes ─────────────────────────────────────────────────────

  markLeadHandled(domain: string, by: string, note?: string | null): void {
    if (!by.trim()) throw new Error("un traitement sans auteur ne se consigne pas");
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO sales_lead_reviews (domain, status, handled_by, handled_at, note, updated_at)
         VALUES (?, 'HANDLED', ?, ?, ?, ?)
         ON CONFLICT(domain) DO UPDATE SET status = 'HANDLED', handled_by = excluded.handled_by,
           handled_at = excluded.handled_at, note = excluded.note, updated_at = excluded.updated_at`,
      )
      .run(canonicalDomainOf(domain), by, now, note ?? null, now);
  }

  /** Une nouvelle réponse rouvre la question, même si la précédente était traitée. */
  reopenLead(domain: string): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO sales_lead_reviews (domain, status, updated_at) VALUES (?, 'OPEN', ?)
         ON CONFLICT(domain) DO UPDATE SET status = 'OPEN', updated_at = excluded.updated_at`,
      )
      .run(canonicalDomainOf(domain), now);
  }

  leadReview(domain: string): { status: 'OPEN' | 'HANDLED'; handledBy: string | null; handledAt: string | null; note: string | null } | null {
    const row = this.db
      .prepare('SELECT * FROM sales_lead_reviews WHERE domain = ?')
      .get(canonicalDomainOf(domain)) as Record<string, unknown> | undefined;
    return row
      ? {
          status: row.status as 'OPEN' | 'HANDLED',
          handledBy: (row.handled_by as string | null) ?? null,
          handledAt: (row.handled_at as string | null) ?? null,
          note: (row.note as string | null) ?? null,
        }
      : null;
  }
}
