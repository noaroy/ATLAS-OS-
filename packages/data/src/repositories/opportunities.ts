import type {
  Opportunity,
  OpportunityId,
  OpportunityReview,
  OpportunityScore,
  OpportunityStage,
  Qualification,
} from '@atlas/contracts';
import { id, nowIso, notFound } from '@atlas/core';
import type { Db } from '../database.ts';
import { fromJson, toJson, toBool, fromBool } from '../database.ts';

interface OpportunityRow {
  id: string;
  mission_id: string;
  department_key: string;
  company_id: string;
  target_types: string;
  stage: OpportunityStage;
  score: number | null;
  score_detail: string | null;
  qualification: string | null;
  rank: number | null;
  justification: string | null;
  reused_knowledge: number;
  review: string | null;
  discovered_by: string;
  created_at: string;
  updated_at: string;
}

const toOpportunity = (row: OpportunityRow): Opportunity => ({
  id: row.id,
  missionId: row.mission_id,
  departmentKey: row.department_key,
  companyId: row.company_id,
  targetTypes: fromJson<string[]>(row.target_types, []),
  stage: row.stage,
  score: row.score,
  scoreDetail: fromJson<OpportunityScore | null>(row.score_detail, null),
  qualification: fromJson<Qualification | null>(row.qualification, null),
  rank: row.rank,
  justification: row.justification,
  reusedKnowledge: toBool(row.reused_knowledge),
  review: fromJson<OpportunityReview | null>(row.review, null),
  discoveredBy: row.discovered_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Opportunities — a company considered as a candidate, for one mission.
 *
 * The `(mission_id, company_id)` uniqueness is the deduplication guarantee at
 * the storage layer: a discovery step that runs twice, or two steps that find
 * the same company, produce one opportunity rather than a duplicated shortlist.
 */
export class OpportunityRepository {
  constructor(private readonly db: Db) {}

  /**
   * Registers a candidate, or returns the one already registered.
   *
   * Idempotent on purpose: retries and overlapping discovery steps are normal,
   * and neither should be able to inflate the funnel.
   */
  register(input: {
    missionId: string;
    departmentKey: string;
    companyId: string;
    targetTypes: string[];
    discoveredBy: string;
    reusedKnowledge?: boolean;
  }): { opportunity: Opportunity; created: boolean } {
    const existing = this.db
      .prepare('SELECT * FROM opportunities WHERE mission_id = ? AND company_id = ?')
      .get(input.missionId, input.companyId) as OpportunityRow | undefined;
    if (existing) return { opportunity: toOpportunity(existing), created: false };

    const now = nowIso();
    const row: OpportunityRow = {
      id: id('opp'),
      mission_id: input.missionId,
      department_key: input.departmentKey,
      company_id: input.companyId,
      target_types: toJson(input.targetTypes),
      stage: 'discovered',
      score: null,
      score_detail: null,
      qualification: null,
      rank: null,
      justification: null,
      reused_knowledge: fromBool(input.reusedKnowledge ?? false),
      review: null,
      discovered_by: input.discoveredBy,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO opportunities (id, mission_id, department_key, company_id, target_types, stage,
                                    score, score_detail, qualification, rank, justification,
                                    reused_knowledge, review, discovered_by, created_at, updated_at)
         VALUES (@id, @mission_id, @department_key, @company_id, @target_types, @stage,
                 @score, @score_detail, @qualification, @rank, @justification,
                 @reused_knowledge, @review, @discovered_by, @created_at, @updated_at)`,
      )
      .run(row);
    return { opportunity: toOpportunity(row), created: true };
  }

  get(opportunityId: OpportunityId): Opportunity | null {
    const row = this.db.prepare('SELECT * FROM opportunities WHERE id = ?').get(opportunityId) as
      | OpportunityRow
      | undefined;
    return row ? toOpportunity(row) : null;
  }

  require(opportunityId: OpportunityId): Opportunity {
    const opportunity = this.get(opportunityId);
    if (!opportunity) throw notFound(`Opportunity '${opportunityId}'`);
    return opportunity;
  }

  /** Looks up by company inside a mission — how an agent addresses a candidate. */
  findByCompany(missionId: string, companyId: string): Opportunity | null {
    const row = this.db
      .prepare('SELECT * FROM opportunities WHERE mission_id = ? AND company_id = ?')
      .get(missionId, companyId) as OpportunityRow | undefined;
    return row ? toOpportunity(row) : null;
  }

  forMission(missionId: string): Opportunity[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM opportunities WHERE mission_id = ?
            ORDER BY CASE WHEN rank IS NULL THEN 1 ELSE 0 END, rank,
                     CASE WHEN score IS NULL THEN 1 ELSE 0 END, score DESC, created_at`,
        )
        .all(missionId) as OpportunityRow[]
    ).map(toOpportunity);
  }

  /** The ranked shortlist: what the founder actually asked for. */
  shortlistFor(missionId: string): Opportunity[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM opportunities
            WHERE mission_id = ? AND stage = 'shortlisted' AND rank IS NOT NULL
            ORDER BY rank`,
        )
        .all(missionId) as OpportunityRow[]
    ).map(toOpportunity);
  }

  forCompany(companyId: string): Opportunity[] {
    return (
      this.db
        .prepare('SELECT * FROM opportunities WHERE company_id = ? ORDER BY created_at DESC')
        .all(companyId) as OpportunityRow[]
    ).map(toOpportunity);
  }

  /**
   * Narrows or corrects the roles a candidate is relevant for.
   *
   * Qualification often finds that a company presented as both distributor and
   * integrator only really does one of the two. Recording that is the point of
   * the exercise — it decides which relationship to propose.
   */
  setTargetTypes(opportunityId: OpportunityId, targetTypes: string[]): Opportunity {
    this.db
      .prepare('UPDATE opportunities SET target_types = ?, updated_at = ? WHERE id = ?')
      .run(toJson([...new Set(targetTypes)]), nowIso(), opportunityId);
    return this.require(opportunityId);
  }

  setStage(opportunityId: OpportunityId, stage: OpportunityStage): Opportunity {
    this.db
      .prepare('UPDATE opportunities SET stage = ?, updated_at = ? WHERE id = ?')
      .run(stage, nowIso(), opportunityId);
    return this.require(opportunityId);
  }

  /**
   * Records a qualification verdict.
   *
   * A rejected candidate moves to `rejected` and stops there: it is kept for the
   * record and for the funnel, but never scored or ranked.
   */
  setQualification(opportunityId: OpportunityId, qualification: Qualification): Opportunity {
    const stage: OpportunityStage = qualification.verdict === 'rejected' ? 'rejected' : 'qualified';
    this.db
      .prepare(
        'UPDATE opportunities SET qualification = ?, stage = ?, updated_at = ? WHERE id = ?',
      )
      .run(toJson(qualification), stage, nowIso(), opportunityId);
    return this.require(opportunityId);
  }

  /**
   * Records a score.
   *
   * Re-scoring a candidate that was already ranked drops its rank and its
   * justification: the justification is generated from the score components, so
   * keeping it would leave a written reason that no longer matches the number.
   * A rank without a matching stage is the kind of inconsistency that survives
   * for weeks, so the two are cleared together.
   *
   * A candidate a human has already decided on is left alone — ATLAS does not
   * quietly reopen a founder's verdict.
   */
  setScore(opportunityId: OpportunityId, score: OpportunityScore): Opportunity {
    const current = this.require(opportunityId);
    const decided = current.stage === 'approved' || current.stage === 'reviewed';
    const now = nowIso();

    this.db
      .prepare(
        `UPDATE opportunities
            SET score = ?, score_detail = ?,
                stage = CASE WHEN ${decided ? '1' : '0'} THEN stage ELSE 'scored' END,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(score.total, toJson(score), now, opportunityId);

    // A rank is a position relative to the others, so changing one score
    // invalidates the whole ordering — not just that candidate's place. Clearing
    // the mission's ranking is what stops a shortlist reading "#2" with no "#1"
    // and a justification that argues from a number that has since moved.
    if (!decided && current.rank !== null) {
      this.db
        .prepare(
          `UPDATE opportunities
              SET rank = NULL, justification = NULL, stage = 'scored', updated_at = ?
            WHERE mission_id = ? AND rank IS NOT NULL
              AND stage NOT IN ('approved', 'reviewed')`,
        )
        .run(now, current.missionId);
    }
    return this.require(opportunityId);
  }

  /** Places an opportunity in the final shortlist with its written justification. */
  setRank(opportunityId: OpportunityId, rank: number, justification: string): Opportunity {
    this.db
      .prepare(
        `UPDATE opportunities SET rank = ?, justification = ?, stage = 'shortlisted', updated_at = ?
          WHERE id = ?`,
      )
      .run(rank, justification, nowIso(), opportunityId);
    return this.require(opportunityId);
  }

  /**
   * Records the founder's own verdict on a candidate.
   *
   * An approval moves the opportunity to `approved`, a rejection to `rejected`,
   * and a note without a decision to `reviewed` — a candidate someone has read
   * and not yet decided on is a different thing from one nobody has opened.
   */
  setReview(opportunityId: OpportunityId, review: OpportunityReview): Opportunity {
    const stage: OpportunityStage =
      review.decision === 'approved'
        ? 'approved'
        : review.decision === 'rejected'
          ? 'rejected'
          : 'reviewed';

    // La revue est écrite deux fois, et ce n'est pas une redondance inutile.
    // La colonne JSON garde la décision entière ; les trois colonnes plates la
    // rendent interrogeable — « tout ce que le fondateur a approuvé depuis
    // lundi » ne s'écrit pas contre un document JSON, et c'est précisément la
    // question qu'on pose à un journal de revue.
    this.db
      .prepare(
        `UPDATE opportunities
            SET review = ?, stage = ?, updated_at = ?,
                reviewed_by = ?, reviewed_at = ?, review_note = ?
          WHERE id = ?`,
      )
      .run(
        toJson(review),
        stage,
        nowIso(),
        review.reviewedBy,
        review.reviewedAt,
        review.note,
        opportunityId,
      );
    return this.require(opportunityId);
  }

  /**
   * Ce qu'un humain a réellement tranché sur une mission.
   *
   * Distinct de `approvedFor` : celui-ci rend aussi les rejets et les avis
   * réservés. Une shortlist n'est pas seulement ce qui a été retenu — c'est
   * aussi ce qui a été écarté, et par qui.
   */
  reviewedFor(missionId: string): Array<{
    id: string;
    stage: OpportunityStage;
    reviewedBy: string | null;
    reviewedAt: string | null;
    note: string | null;
  }> {
    return this.db
      .prepare(
        `SELECT id, stage, reviewed_by, reviewed_at, review_note
           FROM opportunities
          WHERE mission_id = ? AND reviewed_at IS NOT NULL
          ORDER BY reviewed_at DESC`,
      )
      .all(missionId)
      .map((row) => {
        const r = row as {
          id: string;
          stage: string;
          reviewed_by: string | null;
          reviewed_at: string | null;
          review_note: string | null;
        };
        return {
          id: r.id,
          stage: r.stage as OpportunityStage,
          reviewedBy: r.reviewed_by,
          reviewedAt: r.reviewed_at,
          note: r.review_note,
        };
      });
  }

  /** The candidates a human has actually signed off for delivery. */
  approvedFor(missionId: string): Opportunity[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM opportunities
            WHERE mission_id = ? AND stage = 'approved'
            ORDER BY CASE WHEN rank IS NULL THEN 1 ELSE 0 END, rank`,
        )
        .all(missionId) as OpportunityRow[]
    ).map(toOpportunity);
  }

  /** Clears a previous ranking so a re-rank cannot leave two #1s behind. */
  clearRanking(missionId: string): void {
    this.db
      .prepare(
        `UPDATE opportunities SET rank = NULL, justification = NULL, stage = 'scored', updated_at = ?
          WHERE mission_id = ? AND stage = 'shortlisted'`,
      )
      .run(nowIso(), missionId);
  }

  /** The funnel, counted from rows rather than tracked in a counter. */
  funnelFor(missionId: string): Record<OpportunityStage, number> {
    const rows = this.db
      .prepare('SELECT stage, COUNT(*) AS n FROM opportunities WHERE mission_id = ? GROUP BY stage')
      .all(missionId) as Array<{ stage: OpportunityStage; n: number }>;

    const funnel: Record<OpportunityStage, number> = {
      discovered: 0,
      enriched: 0,
      qualified: 0,
      scored: 0,
      shortlisted: 0,
      reviewed: 0,
      approved: 0,
      rejected: 0,
    };
    for (const row of rows) funnel[row.stage] = row.n;
    return funnel;
  }

  countForDepartment(departmentKey: string, stages?: OpportunityStage[]): number {
    if (!stages?.length) {
      return (
        this.db
          .prepare('SELECT COUNT(*) AS n FROM opportunities WHERE department_key = ?')
          .get(departmentKey) as { n: number }
      ).n;
    }
    const placeholders = stages.map(() => '?').join(',');
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM opportunities
            WHERE department_key = ? AND stage IN (${placeholders})`,
        )
        .get(departmentKey, ...stages) as { n: number }
    ).n;
  }

  /**
   * Everything past discovery counts as qualified for economics purposes:
   * an opportunity that was scored or shortlisted necessarily passed
   * qualification, so counting only stage='qualified' would undercount.
   */
  countQualified(missionId: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM opportunities
            WHERE mission_id = ? AND stage IN ('qualified','scored','shortlisted')`,
        )
        .get(missionId) as { n: number }
    ).n;
  }

  countReused(missionId: string): number {
    return (
      this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM opportunities WHERE mission_id = ? AND reused_knowledge = 1',
        )
        .get(missionId) as { n: number }
    ).n;
  }
}
