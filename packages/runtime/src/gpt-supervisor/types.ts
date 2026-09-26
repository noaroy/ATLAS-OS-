import type { AtlasConfig, Logger } from '@atlas/core';
import type { Repositories, SupervisorDecisionKind } from '@atlas/data';
import type { AiProvider } from '@atlas/llm';
import type { ModelPricing } from '@atlas/llm';

/**
 * Le superviseur GPT : les noms qu'il emploie, et ce qu'il rend.
 *
 * La séparation des rôles est écrite dans les types : GPT relit et décide,
 * Claude Code écrit. Le superviseur ne lance jamais Claude Code — il pose, au
 * plus, une tâche ENGINEERING_CHANGE que la route existante (Hermes →
 * CLAUDE_CODE) confie au runner d'ingénierie, dans un worktree isolé.
 */

/** Le bloc `payload.supervisor` d'une tâche d'objectif. */
export const SUPERVISOR_OBJECTIVE_SCHEMA = 'atlas.supervisor-objective.v1';
/** La seule sortie acceptée de GPT. */
export const SUPERVISOR_DECISION_SCHEMA = 'atlas.supervisor-decision.v1';
export const SUPERVISOR_POLL_TASK_TYPE = 'SUPERVISOR_REVIEW_POLL';
export const SUPERVISOR_TASK_TYPE = 'ENGINEERING_CHANGE';

export const SUPERVISOR_DECISIONS: readonly SupervisorDecisionKind[] = ['COMPLETE', 'NEXT_TASK', 'CORRECT', 'BLOCKED'];

/** Les genres consignés dans le registre des opérations externes. */
export const SUPERVISOR_LEDGER = {
  /** La tâche racine d'un objectif lancé en ligne de commande. */
  ROOT: 'SUPERVISOR_ROOT',
  /** La suite d'un cycle. Une seule par objectif et par cycle, pour toujours. */
  CHILD: 'SUPERVISOR_CHILD',
} as const;

/**
 * Pourquoi un objectif s'arrête sans GPT, ou malgré lui.
 *
 * Chaque code nomme une garde précise : une personne qui lit BLOCKED doit
 * savoir laquelle a tenu, sans relire le code.
 */
export type SupervisorGuardCode =
  | 'OBJECTIVE_TIMEOUT'
  | 'OBJECTIVE_NOT_ACTIVE'
  | 'TASK_NOT_READY'
  | 'CYCLE_MISMATCH'
  | 'STALE_BASE'
  | 'REPEATED_DIFF'
  | 'OSCILLATION'
  | 'MAX_CYCLES'
  | 'MAX_CORRECTIONS'
  | 'DUPLICATE_CHILD'
  | 'REPEATED_TASK'
  | 'CHAIN_LIMIT'
  | 'ROUTE_MISMATCH'
  | 'COST_UNKNOWN'
  | 'OBJECTIVE_COST_CAP'
  | 'MALFORMED_REVIEW'
  | 'REVIEW_STALLED'
  | 'PROVIDER_AUTH'
  | 'GPT_BLOCKED';

/** La décision telle que GPT doit l'écrire. Rien d'autre n'est lu. */
export interface SupervisorDecision {
  schema: typeof SUPERVISOR_DECISION_SCHEMA;
  objective_id: string;
  reviewed_task_id: string;
  decision: SupervisorDecisionKind;
  summary: string;
  reasons: string[];
  next_task: {
    objective: string;
    acceptance_criteria: string[];
    test_commands: string[];
  } | null;
  blocked_reason: string | null;
}

export type DecisionVerdict =
  | { ok: true; decision: SupervisorDecision }
  | { ok: false; code: 'MALFORMED_REVIEW'; reasons: string[] };

export interface GptSupervisorDeps {
  repos: Repositories;
  config: AtlasConfig;
  logger: Logger;
  /** Le fournisseur OpenAI existant (`createAiProviders(...).openai`). */
  provider: AiProvider;
  /** L'identité inscrite sur les réservations. */
  actor?: string;
  /** Le tarif d'un modèle ; `pricingFor` par défaut. `null` : inconnu, donc refus. */
  pricing?: (model: string) => ModelPricing | null;
  /** L'horloge, pour les tests. */
  now?: () => Date;
  /** L'environnement lu pour l'attestation de facturation ; `process.env` par défaut. */
  env?: NodeJS.ProcessEnv;
}

export interface SupervisorPollReport {
  ran: boolean;
  skipped: string[];
  reviewed: Array<{ taskId: string; objectiveId: string; decision: SupervisorDecisionKind; code: string; childTaskId: string | null }>;
  deferred: Array<{ taskId: string; reason: string }>;
  timedOut: string[];
  errors: string[];
  gptCalls: number;
  costUsd: number;
  /** Le superviseur n'écrit à personne, n'applique rien, ne pousse rien. */
  messagesSent: 0;
  applied: false;
}
