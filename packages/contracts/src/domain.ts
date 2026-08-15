/**
 * Core domain vocabulary of ATLAS OS.
 *
 * Every layer — interface, Hermes, agents, services, automation, storage —
 * speaks these types. They are intentionally free of any runtime dependency
 * so that the contract can never drift toward one implementation.
 */

// ─── Identifiers ──────────────────────────────────────────────────────────

export type UserId = string;
export type AgentKey = string;
export type MissionId = string;
export type TaskId = string;
export type MessageId = string;
export type MemoryId = string;
export type EventId = string;
export type WorkflowId = string;
export type ImprovementId = string;
export type BuildingKey = string;

// ─── Missions (SRS §2.10) ─────────────────────────────────────────────────

/**
 * Lifecycle of a mission. Transitions are enforced by the orchestrator;
 * `MISSION_TRANSITIONS` is the single source of truth.
 */
export const MISSION_STATUSES = [
  'created',
  'planned',
  'assigned',
  'running',
  'paused',
  'completed',
  'validated',
  'failed',
  'archived',
] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

export const MISSION_TRANSITIONS: Record<MissionStatus, readonly MissionStatus[]> = {
  // A mission can be queued before it is planned, so it must be pausable from
  // `created` too — otherwise anything waiting for a free slot cannot be
  // stopped without cancelling it outright.
  created: ['planned', 'paused', 'failed', 'archived'],
  planned: ['assigned', 'running', 'failed', 'archived'],
  assigned: ['running', 'paused', 'failed', 'archived'],
  running: ['completed', 'paused', 'failed'],
  // A mission paused before planning resumes into planning, not into running.
  paused: ['planned', 'running', 'failed', 'archived'],
  completed: ['validated', 'archived', 'failed'],
  validated: ['archived'],
  failed: ['planned', 'archived'],
  archived: [],
};

export function canTransition(from: MissionStatus, to: MissionStatus): boolean {
  return MISSION_TRANSITIONS[from].includes(to);
}

/** Terminal states no supervisor should ever try to resume. */
export const TERMINAL_MISSION_STATUSES: readonly MissionStatus[] = [
  'validated',
  'archived',
  'failed',
];

export type MissionPriority = 'low' | 'normal' | 'high' | 'critical';

export interface Mission {
  id: MissionId;
  code: string;
  title: string;
  objective: string;
  /** Free-form business context supplied by the founder. */
  context: Record<string, unknown>;
  status: MissionStatus;
  priority: MissionPriority;
  createdBy: UserId | 'system' | 'scheduler' | 'evolution';
  /**
   * The department that owns this mission, or null for a generic objective.
   * A department supplies the method; Hermes still owns the orchestration.
   */
  departmentKey: string | null;
  /** Hermes' strategy for this mission — null until planning completes. */
  plan: MissionPlan | null;
  /** 0..1 — derived from task completion, never stored stale. */
  progress: number;
  result: MissionResult | null;
  error: string | null;
  tags: string[];
  parentId: MissionId | null;
  /**
   * Token ceiling for the whole mission. `null` means the deployment default
   * applies; `0` means unlimited. Enforced before each step is dispatched.
   */
  tokenBudget: number | null;
  /** How many times Hermes has replanned the remainder. Bounded. */
  replanCount: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

/** Hermes' plan: the reasoning plus the concrete steps it produced. */
export interface MissionPlan {
  summary: string;
  /** Why Hermes chose this decomposition — surfaced in the Command Center. */
  rationale: string;
  strategy: string;
  steps: MissionPlanStep[];
  /** Which model/provider produced the plan, for auditability. */
  producedBy: string;
  producedAt: string;
}

export interface MissionPlanStep {
  /** Stable within a mission; used to express dependencies. */
  ref: string;
  title: string;
  /** The agent Hermes selected, and the action it must perform. */
  agentKey: AgentKey;
  action: string;
  instruction: string;
  input: Record<string, unknown>;
  expectedOutput: string;
  /** Refs of steps that must succeed first. */
  dependsOn: string[];
  /** What must actually exist before this step is worth dispatching. */
  preconditions?: StagePrecondition[];
}

/**
 * Ce qu'une étape exige d'avoir reçu avant de mériter d'être lancée.
 *
 * `dependsOn` répond à « l'étape amont s'est-elle terminée ? ». C'est une
 * question de séquence, et LIVE #001 a montré qu'elle ne suffit pas :
 * l'étape de découverte s'est *terminée avec succès* en rapportant qu'elle
 * n'avait rien trouvé, l'enrichissement a donc été lancé sans candidats, et
 * plutôt que de s'arrêter il a improvisé pendant douze minutes.
 *
 * Une précondition répond à l'autre question — « la matière est-elle là ? ».
 * Non satisfaite, l'étape passe en `skipped` sans qu'aucun appel au modèle ne
 * soit émis. C'est un concept de plateforme : tout workflow ATLAS peut en
 * déclarer, pas seulement les départements.
 */
export interface StagePrecondition {
  /**
   * `upstream-output` — les étapes citées doivent avoir produit un résultat.
   * `pipeline-count` — le pipeline de la mission doit contenir assez d'éléments.
   */
  kind: 'upstream-output' | 'pipeline-count';
  /** Pour `upstream-output` : les refs dont la sortie est indispensable. */
  refs?: string[];
  /** Pour `pipeline-count` : le minimum exigé. */
  minCount?: number;
  /** Pour `pipeline-count` : l'étape de pipeline comptée, ou toutes si absent. */
  atStage?: string | null;
  /**
   * Pourquoi cette étape ne peut pas travailler sans cela.
   *
   * Affiché au fondateur quand la précondition bloque : une étape sautée sans
   * explication ressemble à une panne, alors que c'est souvent le résultat
   * honnête — « aucun candidat suffisamment documenté ».
   */
  because: string;
}

/**
 * Ce qu'une mission a réellement donné.
 *
 * `status` dit où en est la mission dans son cycle de vie ; il ne dit pas si
 * elle a servi à quelque chose. LIVE #001 est resté `completed` alors qu'il
 * avait coûté 9,15 $ pour zéro candidat — techniquement exact, commercialement
 * trompeur. L'issue répond à l'autre question, et les deux sont conservées.
 *
 * `no-result` mérite d'être distinct de `failed` : une recherche honnête qui ne
 * trouve aucun candidat suffisamment documenté a bien fonctionné. Les confondre
 * pousserait exactement au comportement qu'ATLAS refuse — compléter la liste
 * pour avoir l'air d'avoir réussi.
 */
export const MISSION_OUTCOMES = [
  'success',
  'partial',
  'no-result',
  'failed',
  'cancelled-budget',
] as const;
export type MissionOutcome = (typeof MISSION_OUTCOMES)[number];

export interface MissionResult {
  summary: string;
  /** Structured findings, keyed by producing step ref. */
  outputs: Record<string, unknown>;
  artifacts: MissionArtifact[];
  /** Aggregate quality score assigned during validation, 0..100. */
  quality: number;
  tokensUsed: number;
  durationMs: number;
  /** What the mission was actually worth, independent of its lifecycle status. */
  outcome?: MissionOutcome;
  /** Set when the mission stopped early because its token budget ran out. */
  budgetExhausted?: boolean;
  /** Set when Hermes replanned the remainder after a critical step failed. */
  replanned?: boolean;
  /** Steps skipped because their declared input never arrived. */
  skippedForMissingInput?: string[];
}

export interface MissionArtifact {
  name: string;
  kind: 'report' | 'dataset' | 'message' | 'analysis' | 'note';
  mediaType: string;
  path: string;
  bytes: number;
  createdBy: AgentKey;
  createdAt: string;
}

// ─── Tasks ────────────────────────────────────────────────────────────────

export const TASK_STATUSES = [
  'pending',
  'ready',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface MissionTask {
  id: TaskId;
  missionId: MissionId;
  ref: string;
  seq: number;
  title: string;
  agentKey: AgentKey;
  action: string;
  instruction: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  status: TaskStatus;
  dependsOn: string[];
  /** Evaluated before dispatch; unmet means `skipped`, never an LLM call. */
  preconditions: StagePrecondition[];
  attempts: number;
  maxAttempts: number;
  error: string | null;
  tokensUsed: number;
  durationMs: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Agents (SRS §4) ──────────────────────────────────────────────────────

export const AGENT_STATUSES = [
  'available',
  'working',
  'analyzing',
  'moving',
  'error',
  'offline',
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export type AgentTier = 'director' | 'business' | 'support' | 'evolution';

/**
 * What an agent may be *used for* — its remit inside the organisation.
 *
 * Distinct from a Skill, which is a reusable technical know-how (Article VII).
 * A mandate answers "may Hermes assign a mission step to this agent?"; a skill
 * answers "what is this agent able to do?". Keeping them apart is what lets a
 * future transverse specialist be included or excluded by its own definition
 * rather than by a rule hard-coded in the orchestrator (Article XIII).
 */
export const AGENT_MANDATES = [
  /** Hermes may assign mission steps to this agent. */
  'mission-execution',
  /** May be invoked to inspect the system's own operation. */
  'system-analysis',
  /** May be consulted for recommendations that do not belong to a mission. */
  'advisory',
] as const;
export type AgentMandate = (typeof AGENT_MANDATES)[number];

/** The mandate every ordinary specialist carries. */
export const DEFAULT_AGENT_MANDATES: readonly AgentMandate[] = ['mission-execution'];

export const hasMandate = (
  agent: { mandates: readonly AgentMandate[] },
  mandate: AgentMandate,
): boolean => agent.mandates.includes(mandate);

// ─── Skills (Article VII) ─────────────────────────────────────────────────

/**
 * A reusable technical know-how belonging to the platform, not to any one
 * department: web research, scoring, document production, and so on.
 *
 * Skills are the unit of reuse the Constitution asks for — ATLAS grows by
 * adding skills that several departments can draw on, rather than by adding
 * features to one product. A skill is *implemented* by one or more tools, and
 * *declared* by the agents that hold it.
 */
export type SkillKey = string;

export type SkillCategory =
  | 'knowledge'
  | 'research'
  | 'analysis'
  | 'production'
  | 'automation'
  | 'observation';

export interface Skill {
  key: SkillKey;
  name: string;
  description: string;
  category: SkillCategory;
  /** Tool ids that provide this skill. An agent holding it may call these. */
  tools: string[];
  /** False when the skill is registered but withdrawn from service. */
  enabled: boolean;
}

/**
 * The static identity of an agent — its manifest. Stored in the database so
 * new specialists can be added at runtime without a code deploy (SRS §4.15).
 */
export interface AgentDefinition {
  /** Identifies the role this agent fills: `explorer`, `analyst`, … */
  key: AgentKey;
  name: string;
  /** Human label for the role. */
  role: string;
  tier: AgentTier;
  /** The village building this agent inhabits. */
  building: BuildingKey;
  mission: string;
  /**
   * The skills this agent holds (Article VII).
   *
   * This is the single source of truth for what the agent can do: its tool
   * allow-list is *derived* from these, so a declared skill and a granted tool
   * can never drift apart.
   */
  skills: SkillKey[];
  /** Actions the agent advertises; Hermes may only assign these. */
  actions: string[];
  /** What this agent may be used for. Empty means it can be used for nothing. */
  mandates: AgentMandate[];
  systemPrompt: string;
  model: string | null;
  maxSteps: number;
  /** Visual identity in ATLAS Village. */
  appearance: AgentAppearance;
  enabled: boolean;
}

export interface AgentAppearance {
  /** Base hue in degrees — drives the whole character palette. */
  hue: number;
  accent: string;
  /** Silhouette variant so inhabitants stay visually distinct. */
  silhouette: 'scout' | 'scholar' | 'envoy' | 'herald' | 'maker' | 'keeper' | 'warden' | 'smith';
  emblem: string;
}

/** Live operational state of an agent — changes constantly. */
export interface AgentState {
  key: AgentKey;
  status: AgentStatus;
  currentMissionId: MissionId | null;
  currentTaskId: TaskId | null;
  currentActivity: string | null;
  /** Village coordinates; the renderer interpolates toward these. */
  location: BuildingKey;
  destination: BuildingKey | null;
  lastActiveAt: string | null;
}

export interface AgentMetrics {
  key: AgentKey;
  tasksTotal: number;
  tasksSucceeded: number;
  tasksFailed: number;
  successRate: number;
  avgDurationMs: number;
  tokensUsed: number;
  /** 0..100 — rolling quality signal from validation (SRS §4.14). */
  qualityScore: number;
  lastTaskAt: string | null;
}

export type Agent = AgentDefinition & {
  state: AgentState;
  metrics: AgentMetrics;
  /** Tool ids resolved from the agent's skills. Derived, never stored. */
  tools: string[];
};

// ─── Inter-agent communication (SRS §2.9 / §5.8) ──────────────────────────

export type AgentMessageKind = 'assignment' | 'result' | 'question' | 'handoff' | 'alert';

/**
 * Every exchange between components carries full provenance so the system can
 * always answer "who asked whom to do what, with which data, and how did it end".
 */
export interface AgentMessage {
  id: MessageId;
  missionId: MissionId | null;
  taskId: TaskId | null;
  from: AgentKey | 'hermes' | 'founder' | 'system';
  to: AgentKey | 'hermes' | 'founder' | 'system';
  kind: AgentMessageKind;
  objective: string;
  payload: Record<string, unknown>;
  expectedOutput: string | null;
  status: 'sent' | 'delivered' | 'answered' | 'failed';
  createdAt: string;
}

// ─── Memory (SRS §2.11 / §5.11) ───────────────────────────────────────────

export type MemoryTier = 'operational' | 'strategic' | 'business';

export type MemoryKind =
  | 'fact'
  | 'insight'
  | 'entity'
  | 'procedure'
  | 'outcome'
  | 'preference'
  | 'lesson';

export interface MemoryItem {
  id: MemoryId;
  tier: MemoryTier;
  kind: MemoryKind;
  title: string;
  content: string;
  /** Domain metadata — sector, country, entity ids, whatever the agent knows. */
  metadata: Record<string, unknown>;
  tags: string[];
  missionId: MissionId | null;
  agentKey: AgentKey | null;
  /** 0..1 — governs retention, promotion, and recall ranking. */
  importance: number;
  confidence: number;
  accessCount: number;
  lastAccessedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryQuery {
  text?: string;
  tier?: MemoryTier;
  kinds?: MemoryKind[];
  tags?: string[];
  missionId?: MissionId;
  agentKey?: AgentKey;
  minImportance?: number;
  limit?: number;
}

export interface MemoryHit extends MemoryItem {
  /** Combined relevance: text match × importance × recency. */
  score: number;
}

// ─── Village (SRS §3) ─────────────────────────────────────────────────────

export interface Building {
  key: BuildingKey;
  name: string;
  department: string;
  purpose: string;
  /** Isometric grid coordinates. */
  x: number;
  y: number;
  /** Grows as the department accumulates completed work (SRS §3.8). */
  level: number;
  activityScore: number;
  status: 'nominal' | 'busy' | 'alert' | 'locked';
  unlockedAt: string | null;
}

/**
 * What a department is doing right now, for the building that houses it.
 *
 * Every figure is counted from stored rows: the village grows because work
 * happened, never because it would look better if it had (Article XII).
 */
export interface VillageDepartmentActivity {
  key: string;
  name: string;
  building: BuildingKey;
  activeMissions: number;
  opportunitiesDiscovered: number;
  opportunitiesShortlisted: number;
  teams: number;
}

export interface VillageSnapshot {
  buildings: Building[];
  agents: Agent[];
  activeMissions: Mission[];
  /** Live department activity, keyed to buildings. */
  departments: VillageDepartmentActivity[];
  /** Live agent journeys between buildings, driving the walking animation. */
  journeys: VillageJourney[];
  stats: VillageStats;
  generatedAt: string;
}

export interface VillageJourney {
  agentKey: AgentKey;
  from: BuildingKey;
  to: BuildingKey;
  missionId: MissionId | null;
  reason: string;
  startedAt: string;
  /** Expected travel duration in ms — the renderer eases across this. */
  durationMs: number;
}

export interface VillageStats {
  population: number;
  activeAgents: number;
  missionsToday: number;
  missionsTotal: number;
  knowledgeItems: number;
  prosperity: number;
  /** Overall village health, 0..100 — drives ambience and alert state. */
  vitality: number;
}

// ─── Events (SRS §5.9) ────────────────────────────────────────────────────

export type EventSeverity = 'debug' | 'info' | 'success' | 'warning' | 'error' | 'critical';

/**
 * The system-wide event vocabulary. Everything observable emits one of these,
 * which is what makes the village a live view rather than a decoration.
 */
export const EVENT_TYPES = [
  'system.boot',
  'system.ready',
  'system.shutdown',
  'system.heartbeat',
  'system.backup',
  'system.alert',
  'mission.created',
  'mission.planned',
  'mission.replanned',
  'mission.budget-exhausted',
  'mission.started',
  'mission.progress',
  'mission.completed',
  'mission.validated',
  'mission.failed',
  'mission.paused',
  'mission.archived',
  'task.ready',
  'task.started',
  'task.succeeded',
  'task.failed',
  'task.retrying',
  /** Sautée faute de l'entrée qu'elle exigeait — aucun appel au modèle émis. */
  'task.skipped',
  /** Un plafond économique a refusé un appel avant qu'il parte. */
  'mission.budget-refused',
  'agent.state',
  'agent.message',
  'agent.tool',
  'agent.journey',
  'memory.stored',
  'memory.recalled',
  'workflow.triggered',
  'workflow.completed',
  'workflow.failed',
  'evolution.observed',
  'evolution.analysed',
  'evolution.proposed',
  'evolution.applied',
  'evolution.reverted',
  'village.updated',
  'department.brief',
  'opportunity.discovered',
  'opportunity.qualified',
  'opportunity.scored',
  'opportunity.shortlisted',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface SystemEvent<T = Record<string, unknown>> {
  id: EventId;
  type: EventType;
  severity: EventSeverity;
  source: string;
  missionId: MissionId | null;
  agentKey: AgentKey | null;
  message: string;
  payload: T;
  createdAt: string;
}

// ─── Automation (SRS §2.12) ───────────────────────────────────────────────

export interface Workflow {
  id: WorkflowId;
  key: string;
  name: string;
  description: string;
  /** n8n workflow id, when the workflow lives in n8n. */
  externalId: string | null;
  /** Webhook path n8n exposes for this workflow. */
  webhookPath: string | null;
  trigger: WorkflowTrigger;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: 'success' | 'failure' | 'never' | null;
  runCount: number;
}

export type WorkflowTrigger =
  | { type: 'manual' }
  | { type: 'schedule'; cron: string; timezone: string }
  | { type: 'event'; event: EventType }
  | { type: 'webhook' };

export interface WorkflowRun {
  id: string;
  workflowId: WorkflowId;
  missionId: MissionId | null;
  status: 'running' | 'success' | 'failure';
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

// ─── Evolution (SRS §3.12 / §6.8) ─────────────────────────────────────────

export type ImprovementStatus =
  | 'proposed'
  | 'approved'
  | 'applied'
  | 'rejected'
  | 'reverted'
  | 'failed';

export type ImprovementCategory =
  | 'agent-tuning'
  | 'orchestration'
  | 'workflow'
  | 'memory'
  | 'reliability'
  | 'performance';

/**
 * A proposed change to how the organisation works. Every improvement carries
 * the evidence that motivated it and the data needed to undo it (SRS §3.12).
 */
export interface Improvement {
  id: ImprovementId;
  title: string;
  category: ImprovementCategory;
  rationale: string;
  /** Observations that justify the change — always traceable. */
  evidence: Record<string, unknown>;
  /** The concrete, machine-applicable change. */
  change: ImprovementChange;
  /** Snapshot of prior state, enabling a clean revert. */
  revertData: Record<string, unknown> | null;
  impact: 'low' | 'medium' | 'high';
  risk: 'low' | 'medium' | 'high';
  status: ImprovementStatus;
  proposedBy: AgentKey | 'hermes';
  decidedBy: UserId | 'auto' | null;
  createdAt: string;
  appliedAt: string | null;
}

/**
 * Only declarative, reversible changes are representable. The system cannot
 * propose arbitrary code execution — that boundary is deliberate (SRS §3.12).
 */
export type ImprovementChange =
  | { type: 'agent.setting'; agentKey: AgentKey; field: 'maxSteps' | 'model' | 'enabled'; value: unknown }
  | { type: 'agent.prompt.append'; agentKey: AgentKey; guidance: string }
  | { type: 'orchestration.setting'; key: string; value: unknown }
  | { type: 'workflow.toggle'; workflowKey: string; enabled: boolean }
  | { type: 'memory.retention'; tier: MemoryTier; minImportance: number };

// ─── Metrics & health ─────────────────────────────────────────────────────

export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'critical';
  uptimeSeconds: number;
  version: string;
  mode: 'live' | 'simulation';
  checks: HealthCheck[];
  resources: ResourceSnapshot;
  generatedAt: string;
}

export interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  latencyMs?: number;
}

export interface ResourceSnapshot {
  cpuLoad: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  databaseSizeMb: number;
  eventBacklog: number;
}

export interface DashboardStats {
  missions: { total: number; active: number; completedToday: number; failedToday: number; successRate: number };
  agents: { total: number; active: number; available: number; error: number };
  memory: { total: number; byTier: Record<MemoryTier, number> };
  automation: { workflows: number; runsToday: number };
  evolution: { pending: number; applied: number };
  tokens: { today: number; total: number };
}

// ─── Alerts ───────────────────────────────────────────────────────────────

export interface Alert {
  id: string;
  level: 'info' | 'warning' | 'error' | 'critical';
  title: string;
  detail: string;
  source: string;
  acknowledged: boolean;
  createdAt: string;
}

// ─── Users ────────────────────────────────────────────────────────────────

export type UserRole = 'founder' | 'operator' | 'viewer';

export interface User {
  id: UserId;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AuthSession {
  token: string;
  user: User;
  expiresAt: string;
}
