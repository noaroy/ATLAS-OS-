import { id, nowIso } from '@atlas/core';
import type { Db } from '../database.ts';

/**
 * La fabrique de revenu : le verdict courant de chaque entreprise examinée,
 * l'historique de chaque passage, et chaque tour.
 *
 * Un domaine canonique, un verdict. Le verdict se réécrit à chaque passage —
 * c'est l'état — mais trois champs ne s'écrivent qu'une fois : le premier
 * score, la première classification et la date du premier passage. C'est
 * contre eux que les issues réelles (réponse, rendez-vous, client) seront
 * comparées ; les réécrire effacerait ce que la fabrique avait prédit.
 */

export const FACTORY_CLASSES = ['HOT', 'WARM', 'NEEDS_ENRICHMENT', 'DROP', 'DUPLICATE', 'BLOCKED'] as const;
export type FactoryClass = (typeof FACTORY_CLASSES)[number];

export interface FactoryEvidenceRef {
  claim: string;
  sourceUrl: string;
  nature: string;
}

export interface FactoryContactRoute {
  kind: 'EMAIL' | 'FORM' | 'PHONE';
  value: string;
  sourceUrl: string | null;
  observed: boolean;
}

export interface FactoryRecommendation {
  company: string;
  domain: string;
  reason: string;
  sourceUrl: string;
  evidenceQuote: string;
  confidence: number | null;
}

export interface FactoryVerdict {
  domain: string;
  prospectId: string;
  companyName: string;
  corporateGroup: string | null;
  classification: FactoryClass;
  sendEligible: boolean;
  revenueScore: number | null;
  scoreMethod: string | null;
  qualificationReason: string | null;
  evidence: FactoryEvidenceRef[];
  contactRoutes: FactoryContactRoute[];
  recommendations: FactoryRecommendation[];
  dedupeResult: string;
  blockers: string[];
  nextAction: string;
  processingCostUsd: number;
  pagesFetched: number;
  attempts: number;
  initialScore: number | null;
  firstClassification: FactoryClass;
  firstProcessedAt: string;
  processedAt: string;
  runId: string | null;
}

export type FactoryVerdictInput = Omit<FactoryVerdict, 'attempts' | 'initialScore' | 'firstClassification' | 'firstProcessedAt' | 'processedAt'> & {
  processedAt?: string;
};

export interface FactoryRun {
  runId: string;
  trigger: string;
  status: 'RUNNING' | 'DONE' | 'FAILED';
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number | null;
  processed: number;
  stats: Record<string, unknown>;
  costUsd: number;
  stopReason: string | null;
  error: string | null;
}

const json = (value: unknown): string => JSON.stringify(value ?? null);
const parse = <T>(raw: unknown, fallback: T): T => {
  if (typeof raw !== 'string' || raw === '') return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};

function toVerdict(r: Record<string, unknown>): FactoryVerdict {
  return {
    domain: r.domain as string,
    prospectId: r.prospect_id as string,
    companyName: r.company_name as string,
    corporateGroup: (r.corporate_group as string | null) ?? null,
    classification: r.classification as FactoryClass,
    sendEligible: r.send_eligible === 1,
    revenueScore: (r.revenue_score as number | null) ?? null,
    scoreMethod: (r.score_method as string | null) ?? null,
    qualificationReason: (r.qualification_reason as string | null) ?? null,
    evidence: parse(r.evidence, []),
    contactRoutes: parse(r.contact_routes, []),
    recommendations: parse(r.recommendations, []),
    dedupeResult: r.dedupe_result as string,
    blockers: parse(r.blockers, []),
    nextAction: r.next_action as string,
    processingCostUsd: Number(r.processing_cost_usd ?? 0),
    pagesFetched: Number(r.pages_fetched ?? 0),
    attempts: Number(r.attempts ?? 1),
    initialScore: (r.initial_score as number | null) ?? null,
    firstClassification: r.first_classification as FactoryClass,
    firstProcessedAt: r.first_processed_at as string,
    processedAt: r.processed_at as string,
    runId: (r.run_id as string | null) ?? null,
  };
}

function toRun(r: Record<string, unknown>): FactoryRun {
  return {
    runId: r.run_id as string,
    trigger: r.trigger as string,
    status: r.status as FactoryRun['status'],
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
    elapsedMs: (r.elapsed_ms as number | null) ?? null,
    processed: Number(r.processed ?? 0),
    stats: parse(r.stats, {}),
    costUsd: Number(r.cost_usd ?? 0),
    stopReason: (r.stop_reason as string | null) ?? null,
    error: (r.error as string | null) ?? null,
  };
}

export class RevenueFactoryRepository {
  constructor(private readonly db: Db) {}

  verdict(domain: string): FactoryVerdict | null {
    const row = this.db.prepare('SELECT * FROM revenue_factory_verdicts WHERE domain = ?').get(domain) as Record<string, unknown> | undefined;
    return row ? toVerdict(row) : null;
  }

  verdicts(filter: { classification?: FactoryClass; sendEligible?: boolean; since?: string; limit?: number } = {}): FactoryVerdict[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.classification) { where.push('classification = ?'); args.push(filter.classification); }
    if (filter.sendEligible !== undefined) { where.push('send_eligible = ?'); args.push(filter.sendEligible ? 1 : 0); }
    if (filter.since) { where.push('processed_at >= ?'); args.push(filter.since); }
    const sql = `SELECT * FROM revenue_factory_verdicts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY send_eligible DESC, revenue_score DESC, processed_at DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, filter.limit ?? 500) as Array<Record<string, unknown>>).map(toVerdict);
  }

  /** Les domaines déjà jugés, avec la date du dernier passage — pour choisir qui repasser. */
  lastProcessed(): Map<string, { processedAt: string; classification: FactoryClass; attempts: number }> {
    const rows = this.db.prepare('SELECT domain, processed_at, classification, attempts FROM revenue_factory_verdicts')
      .all() as Array<{ domain: string; processed_at: string; classification: FactoryClass; attempts: number }>;
    return new Map(rows.map((r) => [r.domain, { processedAt: r.processed_at, classification: r.classification, attempts: r.attempts }]));
  }

  /**
   * Écrit le verdict courant et un événement d'audit, dans une transaction.
   * Le premier score, la première classification et la première date ne sont
   * jamais réécrits.
   */
  record(input: FactoryVerdictInput): FactoryVerdict {
    const at = input.processedAt ?? nowIso();
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO revenue_factory_verdicts
          (domain, prospect_id, company_name, corporate_group, classification, send_eligible, revenue_score, score_method,
           qualification_reason, evidence, contact_routes, recommendations, dedupe_result, blockers, next_action,
           processing_cost_usd, pages_fetched, attempts, initial_score, first_classification, first_processed_at, processed_at, run_id)
        VALUES (@domain, @prospect_id, @company_name, @corporate_group, @classification, @send_eligible, @revenue_score, @score_method,
           @qualification_reason, @evidence, @contact_routes, @recommendations, @dedupe_result, @blockers, @next_action,
           @cost, @pages_fetched, 1, @revenue_score, @classification, @at, @at, @run_id)
        ON CONFLICT(domain) DO UPDATE SET
          prospect_id = excluded.prospect_id, company_name = excluded.company_name, corporate_group = excluded.corporate_group,
          classification = excluded.classification, send_eligible = excluded.send_eligible,
          revenue_score = excluded.revenue_score, score_method = excluded.score_method,
          qualification_reason = excluded.qualification_reason, evidence = excluded.evidence,
          contact_routes = excluded.contact_routes, recommendations = excluded.recommendations,
          dedupe_result = excluded.dedupe_result, blockers = excluded.blockers, next_action = excluded.next_action,
          processing_cost_usd = revenue_factory_verdicts.processing_cost_usd + excluded.processing_cost_usd,
          pages_fetched = revenue_factory_verdicts.pages_fetched + excluded.pages_fetched,
          attempts = revenue_factory_verdicts.attempts + 1,
          initial_score = COALESCE(revenue_factory_verdicts.initial_score, excluded.revenue_score),
          processed_at = excluded.processed_at, run_id = excluded.run_id
      `).run({
        domain: input.domain,
        prospect_id: input.prospectId,
        company_name: input.companyName,
        corporate_group: input.corporateGroup,
        classification: input.classification,
        send_eligible: input.sendEligible ? 1 : 0,
        revenue_score: input.revenueScore,
        score_method: input.scoreMethod,
        qualification_reason: input.qualificationReason,
        evidence: json(input.evidence),
        contact_routes: json(input.contactRoutes),
        recommendations: json(input.recommendations),
        dedupe_result: input.dedupeResult,
        blockers: json(input.blockers),
        next_action: input.nextAction,
        cost: input.processingCostUsd,
        pages_fetched: input.pagesFetched,
        at,
        run_id: input.runId,
      });
      this.db.prepare(`
        INSERT INTO revenue_factory_events (id, run_id, domain, prospect_id, classification, send_eligible, revenue_score, blockers, cost_usd, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id('rfe'), input.runId, input.domain, input.prospectId, input.classification, input.sendEligible ? 1 : 0,
        input.revenueScore, json(input.blockers), input.processingCostUsd, at);
    });
    tx();
    return this.verdict(input.domain)!;
  }

  startRun(trigger: string, startedAt = nowIso()): FactoryRun {
    const runId = id('rfr');
    this.db.prepare('INSERT INTO revenue_factory_runs (run_id, trigger, status, started_at) VALUES (?, ?, ?, ?)')
      .run(runId, trigger, 'RUNNING', startedAt);
    return this.run(runId)!;
  }

  finishRun(runId: string, input: { status: 'DONE' | 'FAILED'; processed: number; stats: Record<string, unknown>; costUsd: number; stopReason: string | null; error?: string | null; finishedAt?: string }): FactoryRun {
    const run = this.run(runId);
    if (!run) throw new Error(`tour de fabrique inconnu : ${runId}`);
    const finishedAt = input.finishedAt ?? nowIso();
    this.db.prepare(`UPDATE revenue_factory_runs SET status = ?, finished_at = ?, elapsed_ms = ?, processed = ?, stats = ?, cost_usd = ?, stop_reason = ?, error = ?
      WHERE run_id = ?`).run(input.status, finishedAt, Math.max(0, Date.parse(finishedAt) - Date.parse(run.startedAt)), input.processed,
      json(input.stats), input.costUsd, input.stopReason, input.error ?? null, runId);
    return this.run(runId)!;
  }

  run(runId: string): FactoryRun | null {
    const row = this.db.prepare('SELECT * FROM revenue_factory_runs WHERE run_id = ?').get(runId) as Record<string, unknown> | undefined;
    return row ? toRun(row) : null;
  }

  runs(limit = 20): FactoryRun[] {
    return (this.db.prepare('SELECT * FROM revenue_factory_runs ORDER BY started_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>).map(toRun);
  }

  /** Un tour laissé RUNNING par un arrêt brutal : clos comme FAILED, jamais effacé. */
  closeAbandonedRuns(olderThan: string): number {
    return this.db.prepare(`UPDATE revenue_factory_runs SET status = 'FAILED', finished_at = ?, error = 'tour interrompu (arrêt du processus)'
      WHERE status = 'RUNNING' AND started_at < ?`).run(nowIso(), olderThan).changes;
  }

  /** Les chiffres d'une fenêtre : entreprises uniques examinées, classes, coût. */
  windowStats(since: string): {
    processed: number; byClass: Record<FactoryClass, number>; sendEligible: number;
    contactsVerified: number; withRecommendations: number; costUsd: number; runs: number; runElapsedMs: number;
  } {
    const rows = this.db.prepare(`SELECT classification, send_eligible, contact_routes, recommendations FROM revenue_factory_verdicts WHERE processed_at >= ?`)
      .all(since) as Array<{ classification: FactoryClass; send_eligible: number; contact_routes: string; recommendations: string }>;
    const byClass = Object.fromEntries(FACTORY_CLASSES.map((c) => [c, 0])) as Record<FactoryClass, number>;
    let contactsVerified = 0;
    let withRecommendations = 0;
    for (const r of rows) {
      byClass[r.classification] += 1;
      if (parse<FactoryContactRoute[]>(r.contact_routes, []).some((c) => c.observed)) contactsVerified += 1;
      if (parse<FactoryRecommendation[]>(r.recommendations, []).length >= 2) withRecommendations += 1;
    }
    const cost = this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM revenue_factory_events WHERE occurred_at >= ?').get(since) as { c: number };
    const runs = this.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(elapsed_ms), 0) AS ms FROM revenue_factory_runs WHERE started_at >= ? AND status = 'DONE'`)
      .get(since) as { n: number; ms: number };
    return {
      processed: rows.length, byClass, sendEligible: rows.filter((r) => r.send_eligible === 1).length,
      contactsVerified, withRecommendations, costUsd: Number(cost.c), runs: runs.n, runElapsedMs: runs.ms,
    };
  }
}
