import type { MissionId } from '@atlas/contracts';
import { id } from '@atlas/core';
import type { Db } from '../database.ts';

/**
 * Ce que chaque appel au modèle a coûté.
 *
 * ATLAS n'agrégeait qu'un total de jetons par étape. Après LIVE #001 il a fallu
 * répondre « combien d'appels ? avec quel modèle ? quelle part en entrée ? » —
 * et la réponse honnête était : non mesuré. Une baseline qu'on ne peut pas
 * décomposer ne sert à rien pour décider où optimiser.
 *
 * La table décrit ce qu'un appel a coûté, jamais ce qu'il contenait : ni
 * requête, ni réponse, ni en-tête, ni clé.
 */

export interface LlmCallInput {
  missionId: string | null;
  taskRef: string | null;
  agentKey: string | null;
  purpose: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  durationMs: number;
  ok: boolean;
  error: string | null;
  toolCalls: number;
  /** Sur quoi portait l'appel : un candidat, une unité de travail. */
  subject: string | null;
  /** Le poids de ce qui est parti, avant l'appel, en caractères. */
  contextChars: number | null;
  /** Preuves versées au contexte, ou `null` quand la notion ne s'applique pas. */
  evidenceCount: number | null;
  createdAt: string;
}

export interface LlmCall extends LlmCallInput {
  id: string;
}

/** Ce qu'un modèle a coûté sur une mission. */
export interface ModelUsage {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/** Ce qu'une étape a coûté. */
export interface StepUsage extends ModelUsage {
  taskRef: string;
  durationMs: number;
  failures: number;
}

/** Ce qu'un candidat a coûté, et le contexte qu'il a fallu pour le traiter. */
export interface SubjectUsage {
  subject: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Le plus gros contexte envoyé pour ce candidat, en caractères. */
  peakContextChars: number | null;
  evidenceCount: number | null;
  firstSeenAt: string;
  failures: number;
}

export interface MissionCallTotals {
  calls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  durationMs: number;
}

interface Row {
  id: string;
  mission_id: string | null;
  task_ref: string | null;
  agent_key: string | null;
  purpose: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
  duration_ms: number;
  ok: number;
  error: string | null;
  tool_calls: number;
  subject: string | null;
  context_chars: number | null;
  evidence_count: number | null;
  created_at: string;
}

const toCall = (row: Row): LlmCall => ({
  id: row.id,
  missionId: row.mission_id,
  taskRef: row.task_ref,
  agentKey: row.agent_key,
  purpose: row.purpose,
  provider: row.provider,
  model: row.model,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  cacheReadTokens: row.cache_read_tokens,
  cacheWriteTokens: row.cache_write_tokens,
  costUsd: row.cost_usd,
  durationMs: row.duration_ms,
  ok: row.ok === 1,
  error: row.error,
  toolCalls: row.tool_calls,
  subject: row.subject,
  contextChars: row.context_chars,
  evidenceCount: row.evidence_count,
  createdAt: row.created_at,
});

export class LlmCallRepository {
  constructor(private readonly db: Db) {}

  record(input: LlmCallInput): LlmCall {
    const rowId = id('llc');
    this.db
      .prepare(
        `INSERT INTO llm_calls (id, mission_id, task_ref, agent_key, purpose, provider, model,
                                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                                cost_usd, duration_ms, ok, error, tool_calls,
                                subject, context_chars, evidence_count, created_at)
         VALUES (@id, @mission_id, @task_ref, @agent_key, @purpose, @provider, @model,
                 @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens,
                 @cost_usd, @duration_ms, @ok, @error, @tool_calls,
                 @subject, @context_chars, @evidence_count, @created_at)`,
      )
      .run({
        id: rowId,
        mission_id: input.missionId,
        task_ref: input.taskRef,
        agent_key: input.agentKey,
        purpose: input.purpose,
        provider: input.provider,
        model: input.model,
        input_tokens: input.inputTokens,
        output_tokens: input.outputTokens,
        cache_read_tokens: input.cacheReadTokens,
        cache_write_tokens: input.cacheWriteTokens,
        cost_usd: input.costUsd,
        duration_ms: input.durationMs,
        ok: input.ok ? 1 : 0,
        error: input.error,
        tool_calls: input.toolCalls,
        subject: input.subject,
        context_chars: input.contextChars,
        evidence_count: input.evidenceCount,
        created_at: input.createdAt,
      });
    return { ...input, id: rowId };
  }

  forMission(missionId: MissionId, limit = 500): LlmCall[] {
    return (
      this.db
        .prepare('SELECT * FROM llm_calls WHERE mission_id = ? ORDER BY created_at ASC LIMIT ?')
        .all(missionId, limit) as Row[]
    ).map(toCall);
  }

  /**
   * Appels et jetons par modèle.
   *
   * C'est la ventilation qui manquait à LIVE #001 : sans elle, impossible de
   * dire si router vers un modèle moins cher change quoi que ce soit.
   */
  byModel(missionId: MissionId): ModelUsage[] {
    return (
      this.db
        .prepare(
          `SELECT model,
                  COUNT(*)                       AS calls,
                  SUM(input_tokens)              AS input_tokens,
                  SUM(output_tokens)             AS output_tokens,
                  SUM(cache_read_tokens)         AS cache_read_tokens,
                  SUM(cache_write_tokens)        AS cache_write_tokens,
                  COALESCE(SUM(cost_usd), 0)     AS cost_usd
             FROM llm_calls
            WHERE mission_id = ?
            GROUP BY model
            ORDER BY cost_usd DESC`,
        )
        .all(missionId) as Array<Record<string, number | string>>
    ).map((r) => ({
      model: String(r.model),
      calls: Number(r.calls),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cacheReadTokens: Number(r.cache_read_tokens),
      cacheWriteTokens: Number(r.cache_write_tokens),
      costUsd: round6(Number(r.cost_usd)),
    }));
  }

  /** Appels, jetons et coût par étape — l'étape la plus chère en tête. */
  byStep(missionId: MissionId): StepUsage[] {
    return (
      this.db
        .prepare(
          `SELECT COALESCE(task_ref, '(hors étape)') AS task_ref,
                  model,
                  COUNT(*)                            AS calls,
                  SUM(input_tokens)                   AS input_tokens,
                  SUM(output_tokens)                  AS output_tokens,
                  SUM(cache_read_tokens)              AS cache_read_tokens,
                  SUM(cache_write_tokens)             AS cache_write_tokens,
                  COALESCE(SUM(cost_usd), 0)          AS cost_usd,
                  SUM(duration_ms)                    AS duration_ms,
                  SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures
             FROM llm_calls
            WHERE mission_id = ?
            GROUP BY task_ref, model
            ORDER BY cost_usd DESC`,
        )
        .all(missionId) as Array<Record<string, number | string>>
    ).map((r) => ({
      taskRef: String(r.task_ref),
      model: String(r.model),
      calls: Number(r.calls),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cacheReadTokens: Number(r.cache_read_tokens),
      cacheWriteTokens: Number(r.cache_write_tokens),
      costUsd: round6(Number(r.cost_usd)),
      durationMs: Number(r.duration_ms),
      failures: Number(r.failures),
    }));
  }

  /**
   * Ce que chaque candidat a coûté, dans l'ordre où il a été traité.
   *
   * L'agrégat par étape ne distingue pas dix candidats à un centime d'un
   * candidat à dix : c'est pourtant la seule lecture qui dise s'il faut
   * s'arrêter, et laquelle des deux formes de dépense on regarde.
   *
   * L'ordre est chronologique et non décroissant par coût, à dessein : la
   * question posée ici est celle de la *forme* de la croissance. Un contexte
   * qui enfle de candidat en candidat ne se voit qu'en suivant la séquence.
   *
   * Les appels sans sujet — plan, briefing, découverte — sont écartés plutôt
   * que regroupés sous une ligne fourre-tout : ils ne portent sur aucun
   * candidat, et les mêler fausserait la moyenne par candidat.
   */
  bySubject(missionId: MissionId): SubjectUsage[] {
    return (
      this.db
        .prepare(
          `SELECT subject,
                  COUNT(*)                            AS calls,
                  SUM(input_tokens)                   AS input_tokens,
                  SUM(output_tokens)                  AS output_tokens,
                  COALESCE(SUM(cost_usd), 0)          AS cost_usd,
                  MAX(context_chars)                  AS peak_context_chars,
                  MAX(evidence_count)                 AS evidence_count,
                  MIN(created_at)                     AS first_seen_at,
                  SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures
             FROM llm_calls
            WHERE mission_id = ? AND subject IS NOT NULL
            GROUP BY subject
            ORDER BY first_seen_at`,
        )
        .all(missionId) as Array<Record<string, number | string | null>>
    ).map((r) => ({
      subject: String(r.subject),
      calls: Number(r.calls),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      costUsd: round6(Number(r.cost_usd)),
      // `null` traverse : un contexte non mesuré n'est pas un contexte vide.
      peakContextChars: r.peak_context_chars === null ? null : Number(r.peak_context_chars),
      evidenceCount: r.evidence_count === null ? null : Number(r.evidence_count),
      firstSeenAt: String(r.first_seen_at),
      failures: Number(r.failures),
    }));
  }

  totals(missionId: MissionId): MissionCallTotals {
    const row = this.db
      .prepare(
        `SELECT COUNT(*)                                AS calls,
                SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed_calls,
                COALESCE(SUM(input_tokens), 0)          AS input_tokens,
                COALESCE(SUM(output_tokens), 0)         AS output_tokens,
                COALESCE(SUM(cache_read_tokens), 0)     AS cache_read_tokens,
                COALESCE(SUM(cache_write_tokens), 0)    AS cache_write_tokens,
                COALESCE(SUM(cost_usd), 0)              AS cost_usd,
                COALESCE(SUM(duration_ms), 0)           AS duration_ms
           FROM llm_calls
          WHERE mission_id = ?`,
      )
      .get(missionId) as Record<string, number> | undefined;

    return {
      calls: Number(row?.calls ?? 0),
      failedCalls: Number(row?.failed_calls ?? 0),
      inputTokens: Number(row?.input_tokens ?? 0),
      outputTokens: Number(row?.output_tokens ?? 0),
      cacheReadTokens: Number(row?.cache_read_tokens ?? 0),
      cacheWriteTokens: Number(row?.cache_write_tokens ?? 0),
      costUsd: round6(Number(row?.cost_usd ?? 0)),
      durationMs: Number(row?.duration_ms ?? 0),
    };
  }

  /** Vrai dès qu'une mission possède une comptabilité par appel. */
  hasCalls(missionId: MissionId): boolean {
    const row = this.db
      .prepare('SELECT 1 AS present FROM llm_calls WHERE mission_id = ? LIMIT 1')
      .get(missionId) as { present: number } | undefined;
    return row !== undefined;
  }
}

const round6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;
