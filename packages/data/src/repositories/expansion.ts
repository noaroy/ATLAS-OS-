import { id, nowIso } from '@atlas/core';
import type { Db } from '../database.ts';
import { fromJson, toJson } from '../database.ts';

/**
 * La mémoire du moteur d'expansion : ses tours, ses candidats, ses relations,
 * ses preuves.
 *
 * Une règle par table. Un tour est un fait daté qui sait où il en est — sa
 * progression est écrite après chaque graine, pour reprendre après un arrêt
 * sans refaire ni dupliquer. Un candidat est *une* entreprise par tour, quel
 * que soit le nombre de chemins qui y mènent : la clé canonique dédoublonne en
 * base, pas dans la vigilance de celui qui écrit. Une relation est unique par
 * (source, cible, type, preuve) : la même page relue ne la compte pas deux
 * fois, et une seconde page qui la confirme est une seconde ligne — une
 * seconde preuve, pas un doublon. Une preuve dit ce qui a été vu, où, et avec
 * quelle confiance ; elle n'est jamais inventée : l'URL est obligatoire.
 *
 * Relations et preuves sont du *savoir*, pas des lignes de tour : elles
 * appartiennent au graphe, cumulatif. Un tour les crée ou les confirme ; les
 * chiffres d'un tour (« ses » relations, « ses » preuves) se lisent par ses
 * candidats, pas par la colonne run_id — qui ne dit que qui a écrit la ligne
 * en premier.
 */

export type ExpansionRunStatus = 'RUNNING' | 'DONE' | 'FAILED' | 'INTERRUPTED' | 'CAPPED';
export type ExpansionPurpose = 'SALES' | 'CLIENT';
export type EntityKind = 'COMPANY' | 'EVENT' | 'ASSOCIATION';
export type ExpansionStage = 'UNIVERSE' | 'RELEVANT' | 'QUALIFIED' | 'HIGH_PRIORITY' | 'REJECTED';
export type SourceTrust = 'OFFICIAL' | 'ASSOCIATION_EVENT' | 'SECONDARY';
export type RelationshipStatus = 'VERIFIED' | 'INFERRED';
export type EvidenceKind = 'RELATIONSHIP' | 'IDENTITY' | 'ACTIVITY' | 'COUNTRY' | 'MEMBERSHIP';

export const EXPANSION_STAGES: readonly ExpansionStage[] = ['UNIVERSE', 'RELEVANT', 'QUALIFIED', 'HIGH_PRIORITY', 'REJECTED'];

export interface ExpansionRun {
  id: string;
  status: ExpansionRunStatus;
  purpose: ExpansionPurpose;
  missionId: string | null;
  trigger: string;
  seeds: Array<Record<string, unknown>>;
  strategies: string[];
  limits: Record<string, unknown>;
  icp: Record<string, unknown> | null;
  progress: Record<string, unknown>;
  stats: Record<string, unknown>;
  searchCalls: number;
  searchCostUsd: number;
  aiCalls: number;
  aiCostUsd: number;
  fetches: number;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
  summary: string | null;
  error: string | null;
}

export interface ExpansionCandidate {
  id: string;
  runId: string;
  entityKey: string;
  entityKind: EntityKind;
  companyName: string;
  canonicalDomain: string | null;
  website: string | null;
  country: string | null;
  aliases: string[];
  depth: number;
  seedKey: string | null;
  isSeed: boolean;
  stage: ExpansionStage;
  icpStatus: string | null;
  score: number | null;
  scoreDetail: Record<string, unknown> | null;
  rejectReason: string | null;
  prospectId: string | null;
  discoveredAt: string;
  updatedAt: string;
}

export interface ProspectRelationship {
  id: string;
  runId: string | null;
  sourceKey: string;
  sourceName: string;
  sourceKind: EntityKind;
  targetKey: string;
  targetName: string;
  relationshipType: string;
  confidence: number;
  status: RelationshipStatus;
  evidenceUrl: string;
  evidenceSummary: string;
  sourceMethod: string;
  sourceTrust: SourceTrust;
  country: string | null;
  sourceDate: string | null;
  discoveredAt: string;
}

export interface ProspectEvidence {
  id: string;
  runId: string | null;
  entityKey: string;
  kind: EvidenceKind;
  claim: string;
  url: string;
  excerpt: string | null;
  trust: SourceTrust;
  method: string;
  confidence: number;
  collectedAt: string;
}

interface RunRow {
  id: string; status: ExpansionRunStatus; purpose: ExpansionPurpose; mission_id: string | null; trigger: string;
  seeds_json: string; strategies_json: string; limits_json: string; icp_json: string | null; progress_json: string; stats_json: string;
  search_calls: number; search_cost_usd: number; ai_calls: number; ai_cost_usd: number; fetches: number;
  started_at: string; finished_at: string | null; updated_at: string; summary: string | null; error: string | null;
}
interface CandidateRow {
  id: string; run_id: string; entity_key: string; entity_kind: EntityKind; company_name: string; canonical_domain: string | null;
  website: string | null; country: string | null; aliases_json: string; depth: number; seed_key: string | null; is_seed: number;
  stage: ExpansionStage; icp_status: string | null; score: number | null; score_detail_json: string | null; reject_reason: string | null;
  prospect_id: string | null; discovered_at: string; updated_at: string;
}
interface RelationshipRow {
  id: string; run_id: string | null; source_key: string; source_name: string; source_kind: EntityKind; target_key: string; target_name: string;
  relationship_type: string; confidence: number; status: RelationshipStatus; evidence_url: string; evidence_summary: string;
  source_method: string; source_trust: SourceTrust; country: string | null; source_date: string | null; discovered_at: string;
}
interface EvidenceRow {
  id: string; run_id: string | null; entity_key: string; kind: EvidenceKind; claim: string; url: string; excerpt: string | null;
  trust: SourceTrust; method: string; confidence: number; collected_at: string;
}

const toRun = (r: RunRow): ExpansionRun => ({
  id: r.id, status: r.status, purpose: r.purpose, missionId: r.mission_id, trigger: r.trigger,
  seeds: fromJson<Array<Record<string, unknown>>>(r.seeds_json, []),
  strategies: fromJson<string[]>(r.strategies_json, []),
  limits: fromJson<Record<string, unknown>>(r.limits_json, {}),
  icp: r.icp_json ? fromJson<Record<string, unknown>>(r.icp_json, {}) : null,
  progress: fromJson<Record<string, unknown>>(r.progress_json, {}),
  stats: fromJson<Record<string, unknown>>(r.stats_json, {}),
  searchCalls: Number(r.search_calls ?? 0), searchCostUsd: Number(r.search_cost_usd ?? 0),
  aiCalls: Number(r.ai_calls ?? 0), aiCostUsd: Number(r.ai_cost_usd ?? 0), fetches: Number(r.fetches ?? 0),
  startedAt: r.started_at, finishedAt: r.finished_at, updatedAt: r.updated_at, summary: r.summary, error: r.error,
});
const toCandidate = (r: CandidateRow): ExpansionCandidate => ({
  id: r.id, runId: r.run_id, entityKey: r.entity_key, entityKind: r.entity_kind, companyName: r.company_name,
  canonicalDomain: r.canonical_domain, website: r.website, country: r.country,
  aliases: fromJson<string[]>(r.aliases_json, []), depth: Number(r.depth ?? 0), seedKey: r.seed_key, isSeed: r.is_seed === 1,
  stage: r.stage, icpStatus: r.icp_status, score: r.score === null ? null : Number(r.score),
  scoreDetail: r.score_detail_json ? fromJson<Record<string, unknown>>(r.score_detail_json, {}) : null,
  rejectReason: r.reject_reason, prospectId: r.prospect_id, discoveredAt: r.discovered_at, updatedAt: r.updated_at,
});
const toRelationship = (r: RelationshipRow): ProspectRelationship => ({
  id: r.id, runId: r.run_id, sourceKey: r.source_key, sourceName: r.source_name, sourceKind: r.source_kind,
  targetKey: r.target_key, targetName: r.target_name, relationshipType: r.relationship_type, confidence: Number(r.confidence),
  status: r.status, evidenceUrl: r.evidence_url, evidenceSummary: r.evidence_summary, sourceMethod: r.source_method,
  sourceTrust: r.source_trust, country: r.country, sourceDate: r.source_date, discoveredAt: r.discovered_at,
});
const toEvidence = (r: EvidenceRow): ProspectEvidence => ({
  id: r.id, runId: r.run_id, entityKey: r.entity_key, kind: r.kind, claim: r.claim, url: r.url, excerpt: r.excerpt,
  trust: r.trust, method: r.method, confidence: Number(r.confidence), collectedAt: r.collected_at,
});

export class ExpansionRepository {
  constructor(private readonly db: Db) {}

  // ─── Les tours ─────────────────────────────────────────────────────────────

  startRun(input: {
    purpose: ExpansionPurpose; trigger: string; seeds: Array<Record<string, unknown>>; strategies: string[];
    limits: Record<string, unknown>; icp?: Record<string, unknown> | null; missionId?: string | null; startedAt?: string;
  }): ExpansionRun {
    const now = input.startedAt ?? nowIso();
    const runId = id('xpn');
    this.db.prepare(
      `INSERT INTO prospect_expansion_runs
         (id, status, purpose, mission_id, trigger, seeds_json, strategies_json, limits_json, icp_json, progress_json, stats_json, started_at, updated_at)
       VALUES (?, 'RUNNING', ?, ?, ?, ?, ?, ?, ?, '{}', '{}', ?, ?)`,
    ).run(runId, input.purpose, input.missionId ?? null, input.trigger, toJson(input.seeds), toJson(input.strategies), toJson(input.limits),
      input.icp ? toJson(input.icp) : null, now, now);
    return this.run(runId)!;
  }

  run(runId: string): ExpansionRun | null {
    const row = this.db.prepare('SELECT * FROM prospect_expansion_runs WHERE id = ?').get(runId) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  runs(limit = 10, status?: ExpansionRunStatus): ExpansionRun[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM prospect_expansion_runs WHERE status = ? ORDER BY started_at DESC LIMIT ?').all(status, limit)
      : this.db.prepare('SELECT * FROM prospect_expansion_runs ORDER BY started_at DESC LIMIT ?').all(limit);
    return (rows as RunRow[]).map(toRun);
  }

  /** Les tours laissés ouverts par un processus mort : à reprendre, jamais à effacer. */
  openRuns(): ExpansionRun[] {
    return (this.db.prepare("SELECT * FROM prospect_expansion_runs WHERE status = 'RUNNING' ORDER BY started_at ASC").all() as RunRow[]).map(toRun);
  }

  /** La progression, écrite après chaque graine traitée : c'est elle qui permet la reprise. */
  saveProgress(runId: string, progress: Record<string, unknown>, counters?: { searchCalls?: number; searchCostUsd?: number; aiCalls?: number; aiCostUsd?: number; fetches?: number }): void {
    const current = this.run(runId);
    if (!current) throw new Error(`tour d'expansion inconnu : ${runId}`);
    this.db.prepare(
      `UPDATE prospect_expansion_runs SET progress_json = ?, search_calls = ?, search_cost_usd = ?, ai_calls = ?, ai_cost_usd = ?, fetches = ?, updated_at = ? WHERE id = ?`,
    ).run(toJson(progress), counters?.searchCalls ?? current.searchCalls, counters?.searchCostUsd ?? current.searchCostUsd,
      counters?.aiCalls ?? current.aiCalls, counters?.aiCostUsd ?? current.aiCostUsd, counters?.fetches ?? current.fetches, nowIso(), runId);
  }

  finishRun(runId: string, input: { status: Exclude<ExpansionRunStatus, 'RUNNING'>; stats: Record<string, unknown>; summary: string | null; error?: string | null; finishedAt?: string }): ExpansionRun {
    const now = input.finishedAt ?? nowIso();
    this.db.prepare(
      'UPDATE prospect_expansion_runs SET status = ?, stats_json = ?, summary = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?',
    ).run(input.status, toJson(input.stats), input.summary, input.error ?? null, now, now, runId);
    return this.run(runId)!;
  }

  // ─── Les candidats ─────────────────────────────────────────────────────────

  /**
   * Un candidat par (tour, clé canonique). Le retrouver par un second chemin
   * ne crée rien : il enrichit — alias, pays, site — et rend la ligne unique.
   */
  upsertCandidate(input: {
    runId: string; entityKey: string; entityKind?: EntityKind; companyName: string; canonicalDomain: string | null; website: string | null;
    country: string | null; aliases?: string[]; depth: number; seedKey: string | null; isSeed?: boolean; discoveredAt?: string;
  }): { candidate: ExpansionCandidate; created: boolean } {
    const existing = this.candidate(input.runId, input.entityKey);
    const now = input.discoveredAt ?? nowIso();
    if (existing) {
      const aliases = new Set<string>(existing.aliases);
      for (const a of input.aliases ?? []) aliases.add(a);
      if (input.companyName !== existing.companyName) aliases.add(input.companyName);
      aliases.delete(existing.companyName);
      this.db.prepare(
        `UPDATE expansion_candidates SET aliases_json = ?, country = COALESCE(country, ?), website = COALESCE(website, ?),
           depth = MIN(depth, ?), is_seed = MAX(is_seed, ?), updated_at = ? WHERE id = ?`,
      ).run(toJson([...aliases]), input.country, input.website, input.depth, input.isSeed ? 1 : 0, now, existing.id);
      return { candidate: this.candidate(input.runId, input.entityKey)!, created: false };
    }
    const candidateId = id('xpc');
    this.db.prepare(
      `INSERT INTO expansion_candidates
         (id, run_id, entity_key, entity_kind, company_name, canonical_domain, website, country, aliases_json, depth, seed_key, is_seed, stage, discovered_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UNIVERSE', ?, ?)`,
    ).run(candidateId, input.runId, input.entityKey, input.entityKind ?? 'COMPANY', input.companyName, input.canonicalDomain, input.website,
      input.country, toJson(input.aliases ?? []), input.depth, input.seedKey, input.isSeed ? 1 : 0, now, now);
    return { candidate: this.candidate(input.runId, input.entityKey)!, created: true };
  }

  candidate(runId: string, entityKey: string): ExpansionCandidate | null {
    const row = this.db.prepare('SELECT * FROM expansion_candidates WHERE run_id = ? AND entity_key = ?').get(runId, entityKey) as CandidateRow | undefined;
    return row ? toCandidate(row) : null;
  }

  candidates(runId: string, options: { stage?: ExpansionStage; limit?: number; kind?: EntityKind } = {}): ExpansionCandidate[] {
    const clauses = ['run_id = ?'];
    const params: unknown[] = [runId];
    if (options.stage) { clauses.push('stage = ?'); params.push(options.stage); }
    if (options.kind) { clauses.push('entity_kind = ?'); params.push(options.kind); }
    params.push(options.limit ?? 500);
    const rows = this.db.prepare(`SELECT * FROM expansion_candidates WHERE ${clauses.join(' AND ')} ORDER BY COALESCE(score, -1) DESC, discovered_at ASC LIMIT ?`).all(...params) as CandidateRow[];
    return rows.map(toCandidate);
  }

  setCandidateVerdict(candidateId: string, input: { stage: ExpansionStage; icpStatus: string | null; score: number | null; scoreDetail: Record<string, unknown> | null; rejectReason?: string | null; country?: string | null }): void {
    this.db.prepare(
      `UPDATE expansion_candidates SET stage = ?, icp_status = ?, score = ?, score_detail_json = ?, reject_reason = ?, country = COALESCE(?, country), updated_at = ? WHERE id = ?`,
    ).run(input.stage, input.icpStatus, input.score, input.scoreDetail ? toJson(input.scoreDetail) : null, input.rejectReason ?? null, input.country ?? null, nowIso(), candidateId);
  }

  linkProspect(candidateId: string, prospectId: string): void {
    this.db.prepare('UPDATE expansion_candidates SET prospect_id = ?, updated_at = ? WHERE id = ?').run(prospectId, nowIso(), candidateId);
  }

  countByStage(runId: string): Record<ExpansionStage, number> {
    const out = Object.fromEntries(EXPANSION_STAGES.map((s) => [s, 0])) as Record<ExpansionStage, number>;
    const rows = this.db.prepare("SELECT stage, COUNT(*) AS n FROM expansion_candidates WHERE run_id = ? AND entity_kind = 'COMPANY' GROUP BY stage").all(runId) as Array<{ stage: ExpansionStage; n: number }>;
    for (const r of rows) out[r.stage] = Number(r.n);
    return out;
  }

  // ─── Les relations ─────────────────────────────────────────────────────────

  /**
   * Une relation, une seule fois par preuve. La même page relue ne la compte
   * pas deux fois ; une autre page qui la confirme est une seconde preuve.
   */
  addRelationship(input: Omit<ProspectRelationship, 'id' | 'discoveredAt'> & { discoveredAt?: string }): { relationship: ProspectRelationship; created: boolean } {
    if (!input.evidenceUrl.trim()) throw new Error('une relation sans URL de preuve est refusée');
    const existing = this.db.prepare(
      'SELECT * FROM prospect_relationships WHERE source_key = ? AND target_key = ? AND relationship_type = ? AND evidence_url = ?',
    ).get(input.sourceKey, input.targetKey, input.relationshipType, input.evidenceUrl) as RelationshipRow | undefined;
    if (existing) {
      // Une confiance meilleure sur la même preuve s'écrit ; jamais une moins bonne.
      if (Number(input.confidence) > Number(existing.confidence)) {
        this.db.prepare('UPDATE prospect_relationships SET confidence = ?, status = ?, evidence_summary = ? WHERE id = ?')
          .run(input.confidence, input.status, input.evidenceSummary, existing.id);
      }
      return { relationship: toRelationship({ ...existing, confidence: Math.max(Number(existing.confidence), input.confidence) }), created: false };
    }
    const relId = id('rel');
    const now = input.discoveredAt ?? nowIso();
    this.db.prepare(
      `INSERT INTO prospect_relationships
         (id, run_id, source_key, source_name, source_kind, target_key, target_name, relationship_type, confidence, status, evidence_url, evidence_summary,
          source_method, source_trust, country, source_date, discovered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(relId, input.runId, input.sourceKey, input.sourceName, input.sourceKind, input.targetKey, input.targetName, input.relationshipType,
      input.confidence, input.status, input.evidenceUrl, input.evidenceSummary.slice(0, 600), input.sourceMethod, input.sourceTrust, input.country, input.sourceDate, now);
    return { relationship: this.relationship(relId)!, created: true };
  }

  relationship(relId: string): ProspectRelationship | null {
    const row = this.db.prepare('SELECT * FROM prospect_relationships WHERE id = ?').get(relId) as RelationshipRow | undefined;
    return row ? toRelationship(row) : null;
  }

  relationshipsOf(entityKey: string, limit = 200): ProspectRelationship[] {
    const rows = this.db.prepare(
      'SELECT * FROM prospect_relationships WHERE source_key = ? OR target_key = ? ORDER BY confidence DESC, discovered_at ASC LIMIT ?',
    ).all(entityKey, entityKey, limit) as RelationshipRow[];
    return rows.map(toRelationship);
  }

  /** Les relations *du tour* : celles qui visent (ou partent d') un de ses candidats. */
  relationshipsForRun(runId: string, limit = 2000): ProspectRelationship[] {
    return (this.db.prepare(
      `SELECT DISTINCT r.* FROM prospect_relationships r
         JOIN expansion_candidates c ON c.run_id = ? AND (c.entity_key = r.target_key OR c.entity_key = r.source_key)
        ORDER BY r.discovered_at ASC LIMIT ?`,
    ).all(runId, limit) as RelationshipRow[]).map(toRelationship);
  }

  relationshipsTo(targetKey: string): ProspectRelationship[] {
    const rows = this.db.prepare('SELECT * FROM prospect_relationships WHERE target_key = ? ORDER BY confidence DESC').all(targetKey);
    return (rows as RelationshipRow[]).map(toRelationship);
  }

  relationshipCounts(runId?: string): Record<string, number> {
    const rows = runId
      ? this.db.prepare(
        `SELECT r.relationship_type AS t, COUNT(DISTINCT r.id) AS n FROM prospect_relationships r
           JOIN expansion_candidates c ON c.run_id = ? AND c.entity_key = r.target_key
          GROUP BY r.relationship_type`,
      ).all(runId)
      : this.db.prepare('SELECT relationship_type AS t, COUNT(*) AS n FROM prospect_relationships GROUP BY relationship_type').all();
    return Object.fromEntries((rows as Array<{ t: string; n: number }>).map((r) => [r.t, Number(r.n)]));
  }

  // ─── Les preuves ───────────────────────────────────────────────────────────

  addEvidence(input: Omit<ProspectEvidence, 'id' | 'collectedAt'> & { collectedAt?: string }): { evidence: ProspectEvidence; created: boolean } {
    if (!input.url.trim()) throw new Error('une preuve sans URL est refusée');
    const existing = this.db.prepare('SELECT * FROM prospect_evidence WHERE entity_key = ? AND kind = ? AND url = ? AND claim = ?')
      .get(input.entityKey, input.kind, input.url, input.claim) as EvidenceRow | undefined;
    if (existing) return { evidence: toEvidence(existing), created: false };
    const evId = id('pev');
    this.db.prepare(
      `INSERT INTO prospect_evidence (id, run_id, entity_key, kind, claim, url, excerpt, trust, method, confidence, collected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(evId, input.runId, input.entityKey, input.kind, input.claim.slice(0, 400), input.url, input.excerpt?.slice(0, 600) ?? null, input.trust, input.method, input.confidence, input.collectedAt ?? nowIso());
    return { evidence: toEvidence(this.db.prepare('SELECT * FROM prospect_evidence WHERE id = ?').get(evId) as EvidenceRow), created: true };
  }

  evidenceOf(entityKey: string): ProspectEvidence[] {
    const rows = this.db.prepare('SELECT * FROM prospect_evidence WHERE entity_key = ? ORDER BY confidence DESC, collected_at ASC').all(entityKey);
    return (rows as EvidenceRow[]).map(toEvidence);
  }

  /** Les preuves *du tour* : celles de ses candidats, par confiance. */
  evidenceCountsByTrust(runId: string): Record<SourceTrust, number> {
    const out: Record<SourceTrust, number> = { OFFICIAL: 0, ASSOCIATION_EVENT: 0, SECONDARY: 0 };
    const rows = this.db.prepare(
      `SELECT e.trust AS trust, COUNT(DISTINCT e.id) AS n FROM prospect_evidence e
         JOIN expansion_candidates c ON c.run_id = ? AND c.entity_key = e.entity_key AND c.is_seed = 0
        GROUP BY e.trust`,
    ).all(runId) as Array<{ trust: SourceTrust; n: number }>;
    for (const r of rows) out[r.trust] = Number(r.n);
    return out;
  }

  // ─── Vue d'ensemble ────────────────────────────────────────────────────────

  /** Ce que le moteur a accumulé, tous tours confondus — pour le tableau de bord. */
  totals(): { runs: number; universe: number; relationships: number; qualified: number; highPriority: number; evidence: number; costUsd: number } {
    const one = <T>(sql: string): T => this.db.prepare(sql).get() as T;
    const runs = one<{ n: number; c: number }>('SELECT COUNT(*) AS n, COALESCE(SUM(search_cost_usd + ai_cost_usd), 0) AS c FROM prospect_expansion_runs');
    const universe = one<{ n: number }>("SELECT COUNT(DISTINCT entity_key) AS n FROM expansion_candidates WHERE entity_kind = 'COMPANY' AND is_seed = 0");
    const qualified = one<{ n: number }>("SELECT COUNT(DISTINCT entity_key) AS n FROM expansion_candidates WHERE stage IN ('QUALIFIED', 'HIGH_PRIORITY') AND is_seed = 0");
    const high = one<{ n: number }>("SELECT COUNT(DISTINCT entity_key) AS n FROM expansion_candidates WHERE stage = 'HIGH_PRIORITY' AND is_seed = 0");
    const rels = one<{ n: number }>('SELECT COUNT(*) AS n FROM prospect_relationships');
    const ev = one<{ n: number }>('SELECT COUNT(*) AS n FROM prospect_evidence');
    return {
      runs: Number(runs.n), universe: Number(universe.n), relationships: Number(rels.n), qualified: Number(qualified.n),
      highPriority: Number(high.n), evidence: Number(ev.n), costUsd: Number(runs.c),
    };
  }

  /** Les graines les plus fécondes : combien de candidats qualifiés chacune a révélés. */
  topSeeds(limit = 5): Array<{ seedKey: string; companies: number; qualified: number }> {
    const rows = this.db.prepare(
      `SELECT seed_key AS seedKey, COUNT(DISTINCT entity_key) AS companies,
              SUM(CASE WHEN stage IN ('QUALIFIED', 'HIGH_PRIORITY') THEN 1 ELSE 0 END) AS qualified
         FROM expansion_candidates WHERE is_seed = 0 AND seed_key IS NOT NULL AND entity_kind = 'COMPANY'
        GROUP BY seed_key ORDER BY qualified DESC, companies DESC LIMIT ?`,
    ).all(limit) as Array<{ seedKey: string; companies: number; qualified: number }>;
    return rows.map((r) => ({ seedKey: r.seedKey, companies: Number(r.companies), qualified: Number(r.qualified) }));
  }

  /** Les méthodes qui rapportent : relations par stratégie. */
  topMethods(limit = 6): Array<{ method: string; relationships: number }> {
    const rows = this.db.prepare(
      'SELECT source_method AS method, COUNT(*) AS n FROM prospect_relationships GROUP BY source_method ORDER BY n DESC LIMIT ?',
    ).all(limit) as Array<{ method: string; n: number }>;
    return rows.map((r) => ({ method: r.method, relationships: Number(r.n) }));
  }

  /** Les clés déjà vues par un tour terminé, pour ne pas les recompter comme « nouvelles ». */
  knownEntityKeys(): Set<string> {
    const rows = this.db.prepare("SELECT DISTINCT entity_key FROM expansion_candidates WHERE entity_kind = 'COMPANY'").all() as Array<{ entity_key: string }>;
    return new Set(rows.map((r) => r.entity_key));
  }
}
