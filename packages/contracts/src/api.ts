/**
 * Wire contracts between the console and the server.
 *
 * Schemas are defined once with zod and reused for runtime validation on the
 * server and type inference on the client, so the two can never drift.
 */
import { z } from 'zod';
import { MISSION_STATUSES, EVENT_TYPES } from './domain.ts';

// ─── Auth ─────────────────────────────────────────────────────────────────

export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

// ─── Missions ─────────────────────────────────────────────────────────────

export const createMissionRequestSchema = z.object({
  title: z.string().min(3).max(200),
  objective: z.string().min(10).max(8000),
  context: z.record(z.unknown()).default({}),
  priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
  tags: z.array(z.string().max(40)).max(20).default([]),
  /** When false, the mission is planned but not dispatched until approved. */
  autoStart: z.boolean().default(true),
  /**
   * Token ceiling for this mission. Omit to use the deployment default;
   * 0 disables the ceiling for this mission specifically.
   */
  tokenBudget: z.number().int().min(0).max(10_000_000).optional(),
  /**
   * The department that owns this objective.
   *
   * Omit it and Hermes recognises the department from the objective; pass null
   * to force a generic mission it plans itself.
   */
  departmentKey: z.string().max(60).nullable().optional(),
});
export type CreateMissionRequest = z.infer<typeof createMissionRequestSchema>;

/**
 * The structured half of a department mission.
 *
 * What the founder states through a form is authoritative: Hermes fills the
 * rest by reading the objective, but never overrides a field set here.
 */
export const departmentBriefSchema = z.object({
  /** Les rôles recherchés. Une organisation peut en satisfaire plusieurs. */
  targetTypes: z.array(z.string().max(60)).min(1).max(6).optional(),
  /** Forme historique, conservée pour les missions créées avant la pluralisation. */
  targetType: z.string().max(60).optional(),
  desiredCount: z.number().int().min(1).max(100).optional(),
  markets: z
    .object({
      countries: z.array(z.string().max(60)).max(10).default([]),
      industries: z.array(z.string().max(120)).max(8).default([]),
      regions: z.array(z.string().max(80)).max(8).default([]),
    })
    .optional(),
  clientProfile: z
    .object({
      name: z.string().max(120),
      country: z.string().max(60),
      industry: z.string().max(120),
      offering: z.string().max(600),
      differentiators: z.array(z.string().max(160)).max(5).default([]),
    })
    .optional(),
  mustHave: z.array(z.string().max(160)).max(6).optional(),
  niceToHave: z.array(z.string().max(160)).max(6).optional(),
  exclusions: z.array(z.string().max(160)).max(6).optional(),
});
export type DepartmentBrief = z.infer<typeof departmentBriefSchema>;

export const listMissionsQuerySchema = z.object({
  status: z.enum(MISSION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().max(200).optional(),
});
export type ListMissionsQuery = z.infer<typeof listMissionsQuerySchema>;

export const missionActionSchema = z.object({
  action: z.enum(['start', 'pause', 'resume', 'retry', 'cancel', 'validate', 'archive']),
  note: z.string().max(1000).optional(),
});
export type MissionAction = z.infer<typeof missionActionSchema>;

// ─── Agents ───────────────────────────────────────────────────────────────

export const updateAgentRequestSchema = z.object({
  enabled: z.boolean().optional(),
  model: z.string().max(80).nullable().optional(),
  maxSteps: z.number().int().min(1).max(50).optional(),
  systemPrompt: z.string().max(20000).optional(),
});
export type UpdateAgentRequest = z.infer<typeof updateAgentRequestSchema>;

/** Enabling or disabling a shared skill withdraws its tools everywhere at once. */
export const toggleSkillRequestSchema = z.object({ enabled: z.boolean() });
export type ToggleSkillRequest = z.infer<typeof toggleSkillRequestSchema>;

/** Creating a specialist at runtime — the mechanism behind SRS §4.15. */
export const createAgentRequestSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{2,30}$/, 'lowercase kebab-case identifier'),
  name: z.string().min(2).max(60),
  role: z.string().min(2).max(120),
  tier: z.enum(['director', 'business', 'support', 'evolution']),
  building: z.string().min(2).max(40),
  mission: z.string().min(10).max(2000),
  // Declared skills are the source of truth: tools are derived from them, so a
  // new specialist can never be handed a tool no skill entitles it to.
  skills: z.array(z.string().max(60)).min(1).max(20),
  actions: z.array(z.string().max(60)).min(1).max(20),
  mandates: z
    .array(z.enum(['mission-execution', 'system-analysis', 'advisory']))
    .min(1)
    .default(['mission-execution']),
  systemPrompt: z.string().min(20).max(20000),
  model: z.string().max(80).nullable().default(null),
  maxSteps: z.number().int().min(1).max(50).default(8),
});
export type CreateAgentRequest = z.infer<typeof createAgentRequestSchema>;

/**
 * The founder's verdict on one candidate.
 *
 * A note without a decision is legitimate: reading a candidate and not yet
 * deciding is a different state from not having opened it.
 */
export const reviewOpportunityRequestSchema = z.object({
  decision: z.enum(['approved', 'rejected', 'pending']),
  note: z.string().max(2000).optional(),
});
export type ReviewOpportunityRequest = z.infer<typeof reviewOpportunityRequestSchema>;

export const exportQuerySchema = z.object({
  format: z.enum(['csv', 'html']).default('csv'),
  /** Defaults to what a human signed off, because a file travels without context. */
  scope: z.enum(['approved', 'shortlist', 'all']).default('approved'),
});
export type ExportQuery = z.infer<typeof exportQuerySchema>;

// ─── Memory ───────────────────────────────────────────────────────────────

export const memorySearchQuerySchema = z.object({
  q: z.string().max(500).optional(),
  tier: z.enum(['operational', 'strategic', 'business']).optional(),
  tags: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type MemorySearchQuery = z.infer<typeof memorySearchQuerySchema>;

export const createMemoryRequestSchema = z.object({
  tier: z.enum(['operational', 'strategic', 'business']),
  kind: z.enum(['fact', 'insight', 'entity', 'procedure', 'outcome', 'preference', 'lesson']),
  title: z.string().min(2).max(200),
  content: z.string().min(1).max(20000),
  metadata: z.record(z.unknown()).default({}),
  tags: z.array(z.string().max(40)).max(20).default([]),
  importance: z.number().min(0).max(1).default(0.5),
});
export type CreateMemoryRequest = z.infer<typeof createMemoryRequestSchema>;

// ─── Events & logs ────────────────────────────────────────────────────────

export const listEventsQuerySchema = z.object({
  type: z.enum(EVENT_TYPES).optional(),
  severity: z.enum(['debug', 'info', 'success', 'warning', 'error', 'critical']).optional(),
  missionId: z.string().optional(),
  agentKey: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.string().optional(),
});
export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;

// ─── Automation ───────────────────────────────────────────────────────────

export const triggerWorkflowRequestSchema = z.object({
  payload: z.record(z.unknown()).default({}),
  missionId: z.string().nullable().default(null),
});
export type TriggerWorkflowRequest = z.infer<typeof triggerWorkflowRequestSchema>;

export const upsertWorkflowRequestSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{2,40}$/),
  name: z.string().min(2).max(120),
  description: z.string().max(2000).default(''),
  externalId: z.string().max(120).nullable().default(null),
  webhookPath: z.string().max(200).nullable().default(null),
  trigger: z.discriminatedUnion('type', [
    z.object({ type: z.literal('manual') }),
    z.object({ type: z.literal('schedule'), cron: z.string().max(100), timezone: z.string().max(60).default('UTC') }),
    z.object({ type: z.literal('event'), event: z.enum(EVENT_TYPES) }),
    z.object({ type: z.literal('webhook') }),
  ]),
  enabled: z.boolean().default(true),
});
export type UpsertWorkflowRequest = z.infer<typeof upsertWorkflowRequestSchema>;

// ─── Evolution ────────────────────────────────────────────────────────────

export const improvementDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject', 'revert']),
  note: z.string().max(1000).optional(),
});
export type ImprovementDecision = z.infer<typeof improvementDecisionSchema>;

// ─── Settings ─────────────────────────────────────────────────────────────

export const updateSettingsRequestSchema = z.object({
  maxConcurrentMissions: z.number().int().min(1).max(20).optional(),
  maxConcurrentTasks: z.number().int().min(1).max(20).optional(),
  taskMaxAttempts: z.number().int().min(1).max(10).optional(),
  evolutionEnabled: z.boolean().optional(),
  evolutionAutonomy: z.enum(['observe', 'propose', 'apply-low-risk']).optional(),
  hermesModel: z.string().max(80).optional(),
  agentModel: z.string().max(80).optional(),
  llmEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  /** Default token ceiling applied to a mission that does not set its own. 0 = unlimited. */
  missionTokenBudget: z.number().int().min(0).max(10_000_000).optional(),
  /** How many times Hermes may replan a single mission. 0 disables replanning. */
  maxReplansPerMission: z.number().int().min(0).max(5).optional(),
});
export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>;

// ─── Envelopes ────────────────────────────────────────────────────────────

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Messages pushed over the realtime channel. */
export type ServerMessage =
  | { channel: 'event'; data: import('./domain.ts').SystemEvent }
  | { channel: 'village'; data: import('./domain.ts').VillageSnapshot }
  | { channel: 'stats'; data: import('./domain.ts').DashboardStats }
  | { channel: 'health'; data: import('./domain.ts').SystemHealth }
  | { channel: 'hello'; data: { version: string; mode: 'live' | 'simulation'; serverTime: string } };

export type ClientMessage =
  | { action: 'subscribe'; channels: Array<'event' | 'village' | 'stats' | 'health'> }
  | { action: 'ping' };
