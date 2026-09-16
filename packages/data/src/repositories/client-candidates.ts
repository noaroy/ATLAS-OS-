import { id, nowIso } from '@atlas/core';
import type { Db } from '../database.ts';
import { fromJson, toJson } from '../database.ts';

/**
 * Le journal de bord d'une mission client : un candidat, une ligne, un état.
 *
 * Les états suivent le chemin réel d'un candidat, dans l'ordre. Un candidat
 * terminé — RETAINED, REVIEW_REQUIRED, EXCLUDED, FAILED_FINAL — n'est jamais
 * retraité ; un FAILED_RETRYABLE l'est au lot suivant, jusqu'au troisième
 * échec. C'est ce qui permet d'interrompre une mission et de la reprendre
 * sans repayer ce qui a été fait ni perdre ce qui a été trouvé.
 */
export const CLIENT_CANDIDATE_STAGES = [
  'DISCOVERED',
  'FILTERED',
  'FETCHED',
  'QUALIFIED',
  'CONTACT_ENRICHED',
  'VERIFIED',
  'REVIEW_REQUIRED',
  'RETAINED',
  'EXCLUDED',
  'FAILED_RETRYABLE',
  'FAILED_FINAL',
] as const;
export type ClientCandidateStage = (typeof CLIENT_CANDIDATE_STAGES)[number];

/** Les états qui ne bougent plus. */
export const TERMINAL_CANDIDATE_STAGES: ReadonlySet<ClientCandidateStage> = new Set([
  'REVIEW_REQUIRED', 'RETAINED', 'EXCLUDED', 'FAILED_FINAL',
]);

export const MAX_CANDIDATE_ATTEMPTS = 3;

export interface ClientCandidate {
  id: string;
  runId: string;
  domain: string;
  url: string;
  name: string | null;
  batch: number;
  briefVersion: number;
  stage: ClientCandidateStage;
  category: string | null;
  reason: string | null;
  evidenceQuote: string | null;
  evidenceUrl: string | null;
  attempts: number;
  lastError: string | null;
  companyId: string | null;
  opportunityId: string | null;
  costUsd: number;
  /** Ce que le pipeline a relevé, pour le rapport : critères, contacts, pays… */
  detail: Record<string, unknown>;
  discoveredAt: string;
  updatedAt: string;
}

interface Row {
  id: string; run_id: string; domain: string; url: string; name: string | null; batch: number;
  brief_version: number; stage: string; category: string | null; reason: string | null;
  evidence_quote: string | null; evidence_url: string | null; attempts: number; last_error: string | null;
  company_id: string | null; opportunity_id: string | null; cost_usd: number; detail: string | null;
  discovered_at: string; updated_at: string;
}

const fromRow = (r: Row): ClientCandidate => ({
  id: r.id, runId: r.run_id, domain: r.domain, url: r.url, name: r.name, batch: r.batch,
  briefVersion: r.brief_version, stage: r.stage as ClientCandidateStage, category: r.category,
  reason: r.reason, evidenceQuote: r.evidence_quote, evidenceUrl: r.evidence_url,
  attempts: r.attempts, lastError: r.last_error, companyId: r.company_id, opportunityId: r.opportunity_id,
  costUsd: r.cost_usd, detail: fromJson<Record<string, unknown>>(r.detail, {}),
  discoveredAt: r.discovered_at, updatedAt: r.updated_at,
});

export class ClientCandidateRepository {
  constructor(private readonly db: Db) {}

  /**
   * Inscrit un candidat découvert. Un domaine déjà connu de la mission n'est
   * pas réinscrit : la ligne existante est rendue, et c'est le dédoublonnage
   * entre lots.
   */
  discover(input: {
    runId: string; domain: string; url: string; name?: string | null; batch: number; briefVersion: number;
  }): { candidate: ClientCandidate; created: boolean } {
    const existing = this.byDomain(input.runId, input.domain);
    if (existing) return { candidate: existing, created: false };
    const now = nowIso();
    const row: Row = {
      id: id('ccd'), run_id: input.runId, domain: input.domain, url: input.url, name: input.name ?? null,
      batch: input.batch, brief_version: input.briefVersion, stage: 'DISCOVERED', category: null, reason: null,
      evidence_quote: null, evidence_url: null, attempts: 0, last_error: null, company_id: null,
      opportunity_id: null, cost_usd: 0, detail: null, discovered_at: now, updated_at: now,
    };
    this.db.prepare(
      `INSERT INTO client_candidates (id, run_id, domain, url, name, batch, brief_version, stage, category, reason,
         evidence_quote, evidence_url, attempts, last_error, company_id, opportunity_id, cost_usd, detail,
         discovered_at, updated_at)
       VALUES (@id, @run_id, @domain, @url, @name, @batch, @brief_version, @stage, @category, @reason,
         @evidence_quote, @evidence_url, @attempts, @last_error, @company_id, @opportunity_id, @cost_usd, @detail,
         @discovered_at, @updated_at)`,
    ).run(row);
    return { candidate: fromRow(row), created: true };
  }

  byDomain(runId: string, domain: string): ClientCandidate | null {
    const row = this.db.prepare('SELECT * FROM client_candidates WHERE run_id = ? AND domain = ?').get(runId, domain) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  get(candidateId: string): ClientCandidate | null {
    const row = this.db.prepare('SELECT * FROM client_candidates WHERE id = ?').get(candidateId) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  forRun(runId: string): ClientCandidate[] {
    return (this.db.prepare('SELECT * FROM client_candidates WHERE run_id = ? ORDER BY batch, discovered_at').all(runId) as Row[]).map(fromRow);
  }

  /** Ce qui reste à traiter : découvert, ou échoué mais reprenable. */
  pending(runId: string, limit: number): ClientCandidate[] {
    return (this.db.prepare(
      `SELECT * FROM client_candidates WHERE run_id = ? AND stage IN ('DISCOVERED', 'FILTERED', 'FETCHED', 'FAILED_RETRYABLE')
       ORDER BY batch, discovered_at LIMIT ?`,
    ).all(runId, limit) as Row[]).map(fromRow);
  }

  knownDomains(runId: string): Set<string> {
    return new Set((this.db.prepare('SELECT domain FROM client_candidates WHERE run_id = ?').all(runId) as Array<{ domain: string }>).map((r) => r.domain));
  }

  setStage(candidateId: string, stage: ClientCandidateStage, patch: {
    name?: string | null; category?: string | null; reason?: string | null; evidenceQuote?: string | null;
    evidenceUrl?: string | null; companyId?: string | null; opportunityId?: string | null;
    detail?: Record<string, unknown>; addCostUsd?: number; briefVersion?: number;
  } = {}): ClientCandidate {
    const current = this.get(candidateId);
    if (!current) throw new Error(`candidat inconnu : ${candidateId}`);
    const detail = patch.detail ? { ...current.detail, ...patch.detail } : current.detail;
    this.db.prepare(
      `UPDATE client_candidates SET stage = @stage, name = @name, category = @category, reason = @reason,
         evidence_quote = @evidence_quote, evidence_url = @evidence_url, company_id = @company_id,
         opportunity_id = @opportunity_id, detail = @detail, cost_usd = cost_usd + @add_cost,
         brief_version = @brief_version, last_error = NULL, updated_at = @updated_at
       WHERE id = @id`,
    ).run({
      id: candidateId, stage,
      name: patch.name === undefined ? current.name : patch.name,
      category: patch.category === undefined ? current.category : patch.category,
      reason: patch.reason === undefined ? current.reason : patch.reason,
      evidence_quote: patch.evidenceQuote === undefined ? current.evidenceQuote : patch.evidenceQuote,
      evidence_url: patch.evidenceUrl === undefined ? current.evidenceUrl : patch.evidenceUrl,
      company_id: patch.companyId === undefined ? current.companyId : patch.companyId,
      opportunity_id: patch.opportunityId === undefined ? current.opportunityId : patch.opportunityId,
      detail: toJson(detail), add_cost: patch.addCostUsd ?? 0,
      brief_version: patch.briefVersion ?? current.briefVersion,
      updated_at: nowIso(),
    });
    return this.get(candidateId)!;
  }

  /**
   * Un échec, compté. Reprenable jusqu'à la troisième fois, définitif ensuite.
   * Rien d'autre ne bouge : ce qui a été écrit avant l'échec reste.
   */
  markFailed(candidateId: string, error: string): ClientCandidate {
    const current = this.get(candidateId);
    if (!current) throw new Error(`candidat inconnu : ${candidateId}`);
    const attempts = current.attempts + 1;
    const stage: ClientCandidateStage = attempts >= MAX_CANDIDATE_ATTEMPTS ? 'FAILED_FINAL' : 'FAILED_RETRYABLE';
    this.db.prepare(
      'UPDATE client_candidates SET stage = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?',
    ).run(stage, attempts, error.slice(0, 500), nowIso(), candidateId);
    return this.get(candidateId)!;
  }

  /** Un ajustement client : ces domaines sortent, avec la raison, sans rien effacer. */
  excludeByClient(runId: string, domain: string, reason: string, briefVersion: number): ClientCandidate | null {
    const c = this.byDomain(runId, domain);
    if (!c) return null;
    return this.setStage(c.id, 'EXCLUDED', {
      category: 'CLIENT_EXCLUDED', reason, briefVersion,
      detail: { triage: { status: 'HUMAN_EXCLUDED', priority: null, recommendation: 'EXCLUDE', reasons: [reason] } },
    });
  }

  /**
   * L'inverse : le client — ou le fondateur en revue — garde cette société.
   * Elle passe retenue, avec la raison, quel que soit le tri automatique ;
   * ce que le tri avait relevé reste dans le détail, sous `triage.previous`.
   */
  keepByClient(runId: string, domain: string, reason: string, briefVersion: number): ClientCandidate | null {
    const c = this.byDomain(runId, domain);
    if (!c) return null;
    const previous = (c.detail as { triage?: unknown }).triage ?? null;
    return this.setStage(c.id, 'RETAINED', {
      category: null, reason, briefVersion,
      detail: { triage: { status: 'HUMAN_APPROVED', priority: null, recommendation: 'RETAIN', reasons: [reason], previous } },
    });
  }

  counts(runId: string): Record<ClientCandidateStage, number> {
    const out = Object.fromEntries(CLIENT_CANDIDATE_STAGES.map((s) => [s, 0])) as Record<ClientCandidateStage, number>;
    for (const r of this.db.prepare('SELECT stage, COUNT(*) AS n FROM client_candidates WHERE run_id = ? GROUP BY stage').all(runId) as Array<{ stage: string; n: number }>) {
      out[r.stage as ClientCandidateStage] = r.n;
    }
    return out;
  }

  /**
   * L'invariant de comptage d'une mission, vérifié plutôt que supposé.
   *
   * Le benchmark suédois affichait « 20 nouveaux / 20 traités » puis des états
   * qui sommaient à 21. Le vingt-et-unième était un annuaire écarté avant
   * lecture : inscrit — pour ne jamais être redécouvert — mais compté nulle
   * part comme « nouveau ». Une ligne par domaine, un état par ligne : la
   * somme des états est le nombre de lignes, et le nombre de lignes est celui
   * des domaines distincts. Ce qui manquait, c'est de le dire : combien de
   * candidats lus, combien écartés au filtre.
   */
  summary(runId: string): {
    byStage: Record<ClientCandidateStage, number>;
    /** Toutes les lignes de la mission : chaque domaine, une fois. */
    total: number;
    distinctDomains: number;
    /** Écartés avant toute lecture (annuaires, marchés, agrégateurs). */
    prefiltered: number;
    /** Les candidats réellement lus ou à lire : total − préfiltrés. */
    candidates: number;
    /** Vrai quand la somme des états vaut le total et qu'aucun domaine n'est en double. */
    consistent: boolean;
  } {
    const byStage = this.counts(runId);
    const row = this.db.prepare(
      `SELECT COUNT(*) AS total, COUNT(DISTINCT domain) AS domains,
              SUM(CASE WHEN category = 'DIRECTORY' THEN 1 ELSE 0 END) AS prefiltered
         FROM client_candidates WHERE run_id = ?`,
    ).get(runId) as { total: number; domains: number; prefiltered: number | null };
    const somme = Object.values(byStage).reduce((a, b) => a + b, 0);
    const prefiltered = Number(row.prefiltered ?? 0);
    return {
      byStage, total: row.total, distinctDomains: row.domains, prefiltered,
      candidates: row.total - prefiltered,
      consistent: somme === row.total && row.total === row.domains,
    };
  }

  totalCost(runId: string): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM client_candidates WHERE run_id = ?').get(runId) as { c: number };
    return row.c;
  }
}
