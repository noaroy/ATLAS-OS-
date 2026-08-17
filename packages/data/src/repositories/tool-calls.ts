import type { MissionId } from '@atlas/contracts';
import { id } from '@atlas/core';
import type { Db } from '../database.ts';

/**
 * Ce que chaque appel d'outil a fait, réussi comme échoué.
 *
 * L'événement `agent.tool` est publié en sévérité `debug`, et le journal
 * d'événements écarte le `debug` pour rester lisible. Un outil qui *réussissait*
 * ne laissait donc aucune trace, et l'économie d'une mission ne comptait que
 * les échecs : LIVE #001 rapportait « 5 appels externes » précisément parce que
 * les cinq avaient échoué.
 *
 * Une table dédiée plutôt qu'une promotion du niveau de log — on mesure sans
 * noyer le journal. Seuls des faits sont conservés : nom, durée, issue. Jamais
 * les arguments ni la réponse.
 */

export interface ToolCallInput {
  missionId: string;
  taskRef: string | null;
  agentKey: string | null;
  tool: string;
  category: string | null;
  durationMs: number;
  ok: boolean;
  error: string | null;
  /** Vrai quand l'appel sort d'ATLAS — la part facturée ou dépendante d'un tiers. */
  external: boolean;
  /**
   * Empreinte des paramètres significatifs de l'appel.
   *
   * Permet de reconnaître un appel identique et de le refuser après un échec
   * technique. Calculée par l'appelant, qui seul sait ce qui est significatif :
   * un mot-clé change la recherche, une limite de résultats non.
   */
  signature?: string | null;
  /** L'issue métier, distincte du succès technique. */
  outcome?: string | null;
  createdAt: string;
}

export interface ToolCall extends ToolCallInput {
  id: string;
}

export interface ToolUsage {
  tool: string;
  calls: number;
  failures: number;
  durationMs: number;
  external: boolean;
}

interface Row {
  id: string;
  mission_id: string;
  task_ref: string | null;
  agent_key: string | null;
  tool: string;
  category: string | null;
  duration_ms: number;
  ok: number;
  error: string | null;
  external: number;
  signature: string | null;
  outcome: string | null;
  created_at: string;
}

const toCall = (row: Row): ToolCall => ({
  id: row.id,
  missionId: row.mission_id,
  taskRef: row.task_ref,
  agentKey: row.agent_key,
  tool: row.tool,
  category: row.category,
  durationMs: row.duration_ms,
  ok: row.ok === 1,
  error: row.error,
  external: row.external === 1,
  signature: row.signature,
  outcome: row.outcome,
  createdAt: row.created_at,
});

export class ToolCallRepository {
  constructor(private readonly db: Db) {}

  record(input: ToolCallInput): ToolCall {
    const rowId = id('tlc');
    this.db
      .prepare(
        `INSERT INTO tool_calls (id, mission_id, task_ref, agent_key, tool, category,
                                 duration_ms, ok, error, external, signature, outcome, created_at)
         VALUES (@id, @mission_id, @task_ref, @agent_key, @tool, @category,
                 @duration_ms, @ok, @error, @external, @signature, @outcome, @created_at)`,
      )
      .run({
        id: rowId,
        mission_id: input.missionId,
        task_ref: input.taskRef,
        agent_key: input.agentKey,
        tool: input.tool,
        category: input.category,
        duration_ms: input.durationMs,
        ok: input.ok ? 1 : 0,
        error: input.error,
        external: input.external ? 1 : 0,
        signature: input.signature ?? null,
        outcome: input.outcome ?? null,
        created_at: input.createdAt,
      });
    return { ...input, id: rowId };
  }

  forMission(missionId: MissionId, limit = 500): ToolCall[] {
    return (
      this.db
        .prepare('SELECT * FROM tool_calls WHERE mission_id = ? ORDER BY created_at ASC LIMIT ?')
        .all(missionId, limit) as Row[]
    ).map(toCall);
  }

  byTool(missionId: MissionId): ToolUsage[] {
    return (
      this.db
        .prepare(
          `SELECT tool,
                  COUNT(*)                                AS calls,
                  SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures,
                  SUM(duration_ms)                        AS duration_ms,
                  MAX(external)                           AS external
             FROM tool_calls
            WHERE mission_id = ?
            GROUP BY tool
            ORDER BY calls DESC`,
        )
        .all(missionId) as Array<Record<string, number | string>>
    ).map((r) => ({
      tool: String(r.tool),
      calls: Number(r.calls),
      failures: Number(r.failures),
      durationMs: Number(r.duration_ms),
      external: Number(r.external) === 1,
    }));
  }

  /** Tous les appels sortis d'ATLAS — réussis compris, c'était le manque. */
  countExternal(missionId: MissionId): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE mission_id = ? AND external = 1')
      .get(missionId) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /**
   * Cet appel exact a-t-il déjà échoué techniquement sur cette mission ?
   *
   * LIVE #004 : la recherche a expiré, l'outil a répondu « ne relancez pas, la
   * cause est technique », et l'agent a relancé deux fois. Une consigne n'est
   * pas un garde-fou — ce que le système doit empêcher, il doit l'empêcher.
   *
   * Ne bloque que sur les issues où réessayer à l'identique ne peut rien
   * changer. Un résultat vide reste rejouable : le marché a pu être mal
   * interrogé, et c'est à l'agent d'en juger.
   */
  hasFailedWithSignature(
    missionId: MissionId,
    tool: string,
    signature: string,
    blockingOutcomes: readonly string[],
  ): { outcome: string; at: string } | null {
    if (blockingOutcomes.length === 0) return null;
    const placeholders = blockingOutcomes.map(() => '?').join(', ');
    const row = this.db
      .prepare(
        `SELECT outcome, created_at FROM tool_calls
          WHERE mission_id = ? AND tool = ? AND signature = ?
            AND outcome IN (${placeholders})
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(missionId, tool, signature, ...blockingOutcomes) as
      | { outcome: string; created_at: string }
      | undefined;
    return row ? { outcome: row.outcome, at: row.created_at } : null;
  }

  /**
   * Combien de fois un outil précis a déjà servi sur cette mission.
   *
   * Sert à borner les récupérations de pages : le plafond doit tenir sur toute
   * la mission, pas sur une étape, sans quoi il suffirait de le répartir entre
   * les étapes pour le contourner.
   */
  countTool(missionId: MissionId, tool: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE mission_id = ? AND tool = ?')
      .get(missionId, tool) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }
}
