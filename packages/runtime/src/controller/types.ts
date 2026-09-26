import type { AtlasConfig, Logger } from '@atlas/core';
import type { Repositories } from '@atlas/data';
import type { ControllerGithub } from './github.ts';

/**
 * Le pont contrôleur : ce qui entre, ce qui sort, et les noms qu'il emploie.
 *
 * Un seul transport — les issues GitHub — et un seul format d'entrée, versionné.
 * Le texte libre d'une issue n'est jamais lu comme une consigne : seule une
 * enveloppe `atlas.controller-task.v1` validée devient une tâche, et seule une
 * tâche `ENGINEERING_CHANGE` est acceptée. Le reste de la chaîne est celui qui
 * existe déjà : Hermes route, ClaudeCodeWorker travaille dans un worktree et
 * s'arrête à READY_FOR_REVIEW. Le pont ne lance jamais Claude Code lui-même.
 */

export const CONTROLLER_TASK_SCHEMA = 'atlas.controller-task.v1';
export const CONTROLLER_RESULT_SCHEMA = 'atlas.controller-result.v1';
export const CONTROLLER_POLL_TASK_TYPE = 'CONTROLLER_BRIDGE_POLL';
/** Le seul type de tâche que le pont accepte de poser. */
export const CONTROLLER_ACCEPTED_TASK_TYPE = 'ENGINEERING_CHANGE';

/** Les genres consignés dans le registre des opérations externes. */
export const CONTROLLER_LEDGER = {
  /** Une issue → sa tâche. Une seule, pour toujours. */
  INTAKE: 'CONTROLLER_INTAKE',
  /** Un commentaire de résultat publié, par tâche et par état. */
  RESULT: 'CONTROLLER_RESULT',
  /** Un refus publié, par issue et par contenu d'enveloppe. */
  REJECT: 'CONTROLLER_REJECT',
} as const;

export const CONTROLLER_STATES = [
  'QUEUED', 'RUNNING', 'READY_FOR_REVIEW', 'BLOCKED', 'FAILED', 'REJECTED',
] as const;
export type ControllerState = (typeof CONTROLLER_STATES)[number];

/** L'étiquette d'état posée sur l'issue. Une seule à la fois. */
export const STATE_LABELS: Readonly<Record<ControllerState, string>> = {
  QUEUED: 'atlas:queued',
  RUNNING: 'atlas:running',
  READY_FOR_REVIEW: 'atlas:ready-for-review',
  BLOCKED: 'atlas:blocked',
  FAILED: 'atlas:failed',
  REJECTED: 'atlas:rejected',
};

/** Les états qui méritent un commentaire. RUNNING ne change qu'une étiquette. */
export const COMMENTED_STATES: readonly ControllerState[] = [
  'QUEUED', 'READY_FOR_REVIEW', 'BLOCKED', 'FAILED', 'REJECTED',
];

/** Les bornes d'enveloppe : au-delà, refus — jamais une troncature silencieuse. */
export const ENVELOPE_BOUNDS = {
  maxAllowedPaths: 20,
  maxTestCommands: 6,
  maxPathLength: 200,
  maxObjectiveChars: 4_000,
  minObjectiveChars: 10,
  maxListItems: 20,
  maxListItemChars: 500,
  maxBodyChars: 60_000,
} as const;

export interface ControllerLimitsRequest {
  max_files_changed?: number;
  max_diff_lines?: number;
  timeout_minutes?: number;
}

export interface EffectiveLimits {
  requested: ControllerLimitsRequest;
  system: Required<ControllerLimitsRequest>;
  effective: Required<ControllerLimitsRequest>;
  /** Les bornes demandées au-delà du plafond, ramenées à lui. */
  clamped: Array<keyof ControllerLimitsRequest>;
}

/** L'enveloppe telle qu'elle a été validée. Rien d'autre n'entre dans la tâche. */
export interface ControllerTaskEnvelope {
  schema: typeof CONTROLLER_TASK_SCHEMA;
  task_type: typeof CONTROLLER_ACCEPTED_TASK_TYPE;
  correlation_id: string;
  objective: string;
  allowed_paths: string[];
  test_commands: string[];
  acceptance_criteria: string[];
  constraints: string[];
  limits: ControllerLimitsRequest;
  /**
   * Facultatif, faux par défaut. Vrai : la tâche ouvre un objectif autonome,
   * que le superviseur GPT relira et poursuivra (ATLAS_SUPERVISOR_ENABLED).
   */
  autonomous: boolean;
  apply: false;
  push: false;
  deploy: false;
}

export type EnvelopeRejectionCode =
  | 'NO_ENVELOPE'
  | 'AMBIGUOUS_ENVELOPE'
  | 'INVALID_JSON'
  | 'WRONG_SCHEMA'
  | 'WRONG_TASK_TYPE'
  | 'INVALID_ENVELOPE'
  | 'INVALID_PATH'
  | 'PROTECTED_PATH'
  | 'INVALID_COMMAND'
  | 'INVALID_LIMITS'
  | 'APPLY_PUSH_DEPLOY_REFUSED';

export type EnvelopeVerdict =
  | { ok: true; envelope: ControllerTaskEnvelope; limits: EffectiveLimits; fingerprint: string }
  | { ok: false; code: EnvelopeRejectionCode; reasons: string[]; correlationId: string | null };

/** Ce que le résultat publié sur l'issue contient. Rien de plus. */
export interface ControllerResult {
  schema: typeof CONTROLLER_RESULT_SCHEMA;
  state: ControllerState;
  repo: string;
  issue: number;
  correlation_id: string | null;
  fingerprint: string | null;
  task_id: string | null;
  task_type: typeof CONTROLLER_ACCEPTED_TASK_TYPE;
  worker: string | null;
  summary: string;
  error_code: string | null;
  reasons: string[];
  effective_limits: EffectiveLimits['effective'] | null;
  clamped_limits: string[];
  diff: {
    files_changed: string[];
    files_added: string[];
    files_deleted: string[];
    diff_lines: number;
    diff_hash: string | null;
    base_commit: string | null;
    workspace_state: string | null;
  } | null;
  apply_performed: false;
  commit_to_main: false;
  push_performed: false;
  deploy_performed: false;
  messages_sent: 0;
}

export interface ControllerDeps {
  repos: Repositories;
  config: AtlasConfig;
  logger: Logger;
  /** Le client GitHub. Absent : construit depuis l'environnement, à l'appel. */
  github?: ControllerGithub | null;
  /** L'identité inscrite dans le registre des opérations externes. */
  actor?: string;
  /** L'environnement où lire la présence du jeton. `process.env` par défaut. */
  env?: NodeJS.ProcessEnv;
}

export interface ControllerPollReport {
  ran: boolean;
  skipped: string[];
  issuesSeen: number;
  issuesIgnored: number;
  tasksCreated: string[];
  tasksExisting: string[];
  rejected: number[];
  commentsPosted: number;
  /** Les clés de commentaire réservées sans confirmation ni marqueur signé : retenues, jamais republiées seules. */
  held: string[];
  labelsChanged: number;
  errors: string[];
  /** Le pont n'écrit à personne : ni courriel, ni message commercial. */
  messagesSent: 0;
}
