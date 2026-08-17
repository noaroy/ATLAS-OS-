import type { DecisionKind, MissionDecision, MissionId } from '@atlas/contracts';
import { id, nowIso } from '@atlas/core';
import type { Db } from '../database.ts';

/**
 * Le journal des décisions d'Hermès.
 *
 * En ajout seul, comme la mémoire et les preuves : une décision revenue sur ne
 * s'efface pas, elle est suivie d'une autre. C'est ce qui permet de reconstruire
 * ce qu'ATLAS a cru, quand, et sur quelle base — y compris quand il s'est
 * trompé.
 */

interface DecisionRow {
  id: string;
  mission_id: string;
  task_ref: string | null;
  kind: string;
  decision: string;
  rationale: string;
  evidence_ids: string;
  estimated_cost_usd: number | null;
  impact: string | null;
  created_at: string;
}

const toDecision = (row: DecisionRow): MissionDecision => ({
  id: row.id,
  missionId: row.mission_id,
  taskRef: row.task_ref,
  kind: row.kind as DecisionKind,
  decision: row.decision,
  rationale: row.rationale,
  evidenceIds: parseIds(row.evidence_ids),
  estimatedCostUsd: row.estimated_cost_usd,
  impact: row.impact,
  createdAt: row.created_at,
});

/** Une colonne corrompue ne doit pas faire échouer la lecture d'un journal. */
function parseIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export interface RecordDecisionInput {
  missionId: MissionId;
  taskRef?: string | null;
  kind: DecisionKind;
  decision: string;
  rationale: string;
  evidenceIds?: string[];
  estimatedCostUsd?: number | null;
  impact?: string | null;
}

export class DecisionRepository {
  constructor(private readonly db: Db) {}

  record(input: RecordDecisionInput): MissionDecision {
    const row: DecisionRow = {
      id: id('dec'),
      mission_id: input.missionId,
      task_ref: input.taskRef ?? null,
      kind: input.kind,
      decision: input.decision,
      rationale: input.rationale,
      evidence_ids: JSON.stringify(input.evidenceIds ?? []),
      estimated_cost_usd: input.estimatedCostUsd ?? null,
      impact: input.impact ?? null,
      created_at: nowIso(),
    };

    this.db
      .prepare(
        `INSERT INTO mission_decisions
           (id, mission_id, task_ref, kind, decision, rationale, evidence_ids,
            estimated_cost_usd, impact, created_at)
         VALUES (@id, @mission_id, @task_ref, @kind, @decision, @rationale, @evidence_ids,
                 @estimated_cost_usd, @impact, @created_at)`,
      )
      .run(row);

    return toDecision(row);
  }

  forMission(missionId: MissionId): MissionDecision[] {
    return (
      this.db
        .prepare('SELECT * FROM mission_decisions WHERE mission_id = ? ORDER BY created_at, rowid')
        .all(missionId) as DecisionRow[]
    ).map(toDecision);
  }

  /**
   * Les décisions qui affirment quelque chose sans preuve.
   *
   * Sert au contrôle d'après-mission : une décision d'organisation n'a pas
   * besoin de preuve, une conclusion métier si. Les compter séparément est le
   * seul moyen de vérifier qu'Hermès n'a rien affirmé qu'il ne pouvait pas
   * étayer.
   */
  unsupportedClaims(missionId: MissionId): MissionDecision[] {
    return this.forMission(missionId).filter(
      (decision) => CLAIMS_REQUIRING_EVIDENCE.has(decision.kind) && decision.evidenceIds.length === 0,
    );
  }
}

/**
 * Les décisions qui portent sur le monde, et doivent donc citer leurs sources.
 *
 * `conclude` recommande quelque chose au fondateur ; `escalate` affirme qu'un
 * arbitrage est nécessaire sur un cas précis. Les autres catégories organisent
 * le travail et n'ont rien à prouver.
 */
const CLAIMS_REQUIRING_EVIDENCE = new Set<DecisionKind>(['conclude', 'escalate']);
