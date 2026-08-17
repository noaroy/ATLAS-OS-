import { createHash } from 'node:crypto';
import type { Improvement, ImprovementChange, ImprovementStatus } from '@atlas/contracts';
import { id, nowIso, notFound } from '@atlas/core';
import type { Db } from '../database.ts';
import { fromJson, toJson } from '../database.ts';

interface ImprovementRow {
  id: string;
  title: string;
  category: Improvement['category'];
  rationale: string;
  evidence: string;
  change: string;
  revert_data: string | null;
  impact: Improvement['impact'];
  risk: Improvement['risk'];
  status: ImprovementStatus;
  proposed_by: string;
  decided_by: string | null;
  fingerprint: string;
  created_at: string;
  applied_at: string | null;
}

const toImprovement = (row: ImprovementRow): Improvement => ({
  id: row.id,
  title: row.title,
  category: row.category,
  rationale: row.rationale,
  evidence: fromJson<Record<string, unknown>>(row.evidence, {}),
  change: fromJson<ImprovementChange>(row.change, {
    type: 'orchestration.setting',
    key: 'noop',
    value: null,
  }),
  revertData: fromJson<Record<string, unknown> | null>(row.revert_data, null),
  impact: row.impact,
  risk: row.risk,
  status: row.status,
  proposedBy: row.proposed_by as Improvement['proposedBy'],
  decidedBy: row.decided_by,
  createdAt: row.created_at,
  appliedAt: row.applied_at,
});

/** Stable identity for a change, so the same idea is never proposed twice. */
export function fingerprintChange(change: ImprovementChange): string {
  return createHash('sha256').update(JSON.stringify(change)).digest('hex').slice(0, 32);
}

export class ImprovementRepository {
  constructor(private readonly db: Db) {}

  /**
   * Records a proposal. Returns null when an identical open proposal already
   * exists — the partial unique index makes that check race-free.
   */
  propose(input: {
    title: string;
    category: Improvement['category'];
    rationale: string;
    evidence: Record<string, unknown>;
    change: ImprovementChange;
    impact: Improvement['impact'];
    risk: Improvement['risk'];
    proposedBy: string;
  }): Improvement | null {
    const row: ImprovementRow = {
      id: id('imp'),
      title: input.title,
      category: input.category,
      rationale: input.rationale,
      evidence: toJson(input.evidence),
      change: toJson(input.change),
      revert_data: null,
      impact: input.impact,
      risk: input.risk,
      status: 'proposed',
      proposed_by: input.proposedBy,
      decided_by: null,
      fingerprint: fingerprintChange(input.change),
      created_at: nowIso(),
      applied_at: null,
    };

    try {
      this.db
        .prepare(
          `INSERT INTO improvements (id, title, category, rationale, evidence, change, revert_data,
                                     impact, risk, status, proposed_by, decided_by, fingerprint,
                                     created_at, applied_at)
           VALUES (@id, @title, @category, @rationale, @evidence, @change, @revert_data,
                   @impact, @risk, @status, @proposed_by, @decided_by, @fingerprint,
                   @created_at, @applied_at)`,
        )
        .run(row);
      return toImprovement(row);
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint/i.test(err.message)) return null;
      throw err;
    }
  }

  get(improvementId: string): Improvement | null {
    const row = this.db.prepare('SELECT * FROM improvements WHERE id = ?').get(improvementId) as
      | ImprovementRow
      | undefined;
    return row ? toImprovement(row) : null;
  }

  require(improvementId: string): Improvement {
    const improvement = this.get(improvementId);
    if (!improvement) throw notFound(`Improvement '${improvementId}'`);
    return improvement;
  }

  list(status?: ImprovementStatus, limit = 100): Improvement[] {
    const rows = status
      ? (this.db
          .prepare('SELECT * FROM improvements WHERE status = ? ORDER BY created_at DESC LIMIT ?')
          .all(status, limit) as ImprovementRow[])
      : (this.db
          .prepare('SELECT * FROM improvements ORDER BY created_at DESC LIMIT ?')
          .all(limit) as ImprovementRow[]);
    return rows.map(toImprovement);
  }

  setStatus(
    improvementId: string,
    status: ImprovementStatus,
    patch: { decidedBy?: string | null; revertData?: Record<string, unknown> | null } = {},
  ): Improvement {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE improvements SET
           status = @status,
           decided_by = COALESCE(@decided_by, decided_by),
           revert_data = COALESCE(@revert_data, revert_data),
           applied_at = CASE WHEN @status = 'applied' THEN @now ELSE applied_at END
         WHERE id = @id`,
      )
      .run({
        id: improvementId,
        status,
        decided_by: patch.decidedBy ?? null,
        revert_data: patch.revertData !== undefined ? toJson(patch.revertData) : null,
        now,
      });
    return this.require(improvementId);
  }

  countByStatus(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM improvements GROUP BY status')
      .all() as Array<{ status: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }
}
