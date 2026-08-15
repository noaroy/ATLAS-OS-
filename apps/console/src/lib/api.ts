import type {
  Agent,
  Alert,
  ApiResponse,
  AuthSession,
  Building,
  DashboardStats,
  Improvement,
  MemoryHit,
  MemoryItem,
  MemoryTier,
  Mission,
  MissionTask,
  AgentMessage,
  SystemEvent,
  SystemHealth,
  User,
  VillageSnapshot,
  Workflow,
  WorkflowRun,
  ResourceSnapshot,
  Skill,
  SkillCategory,
  Company,
  Contact,
  CompanyRelation,
  Department,
  DepartmentStats,
  Evidence,
  MissionEconomics,
  Opportunity,
  OpportunityDetail,
  OpportunityStage,
  Source,
} from '@atlas/contracts';

/**
 * The session lives in an httpOnly cookie the browser attaches automatically
 * and this code cannot read — which is precisely the point: a token no script
 * can reach cannot be exfiltrated by an XSS flaw.
 *
 * The console therefore tracks only *whether* it believes it is signed in.
 * The server is the authority; a 401 corrects this flag immediately.
 */
const SIGNED_IN_KEY = 'atlas.signedIn';

export const auth = {
  get signedIn(): boolean {
    return localStorage.getItem(SIGNED_IN_KEY) === '1';
  },
  set signedIn(value: boolean) {
    if (value) localStorage.setItem(SIGNED_IN_KEY, '1');
    else localStorage.removeItem(SIGNED_IN_KEY);
  },
};

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Thin fetch wrapper around the ATLAS API.
 *
 * Unwraps the `{ ok, data }` envelope so callers work with domain objects, and
 * turns a 401 into a single global signal rather than leaving every screen to
 * handle an expired session on its own.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  // `same-origin` sends the session cookie; the console never handles the
  // token itself.
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });

  if (response.status === 401) {
    auth.signedIn = false;
    window.dispatchEvent(new CustomEvent('atlas:unauthorized'));
    throw new ApiError('UNAUTHORIZED', 'Your session has expired. Sign in again.', 401);
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after');
    throw new ApiError(
      'RATE_LIMITED',
      retryAfter
        ? `Too many requests. Try again in ${retryAfter} seconds.`
        : 'Too many requests. Slow down and try again shortly.',
      429,
    );
  }

  let body: ApiResponse<T>;
  try {
    body = (await response.json()) as ApiResponse<T>;
  } catch {
    throw new ApiError('INTERNAL', `The server returned an unreadable response (${response.status})`, response.status);
  }

  if (!body.ok) {
    throw new ApiError(body.error.code, body.error.message, response.status, body.error.details);
  }
  return body.data;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

export interface MissionDetail {
  mission: Mission;
  tasks: MissionTask[];
  messages: AgentMessage[];
  events: SystemEvent[];
  isActive: boolean;
  /** Jetons et dépense réelle, mesurés appel par appel. */
  economics: MissionEconomics;
  /** Ce qui a produit ces chiffres : inférence facturée, ou simulation. */
  mode: 'live' | 'simulation';
}

export interface RuntimeSettingsView {
  runtime: {
    maxConcurrentMissions: number;
    maxConcurrentTasks: number;
    taskMaxAttempts: number;
    missionTokenBudget: number;
    maxReplansPerMission: number;
    evolutionEnabled: boolean;
    evolutionAutonomy: 'observe' | 'propose' | 'apply-low-risk';
    hermesModel: string;
    agentModel: string;
    llmEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    memoryRetention: Record<string, number>;
  };
  mode: 'live' | 'simulation';
  version: string;
  n8nEnabled: boolean;
}

export const api = {
  // Auth
  login: (email: string, password: string) =>
    post<AuthSession>('/api/auth/login', { email, password }),
  logout: () => post<{ loggedOut: boolean }>('/api/auth/logout'),
  me: () => get<User>('/api/auth/me'),

  // System
  health: () => get<SystemHealth>('/api/health'),
  stats: () => get<DashboardStats>('/api/stats'),
  resources: () => get<Array<ResourceSnapshot & { createdAt: string }>>('/api/resources'),
  settings: () => get<RuntimeSettingsView>('/api/settings'),
  updateSettings: (patchBody: Partial<RuntimeSettingsView['runtime']>) =>
    patch<RuntimeSettingsView['runtime']>('/api/settings', patchBody),
  alerts: (all = false) => get<Alert[]>(`/api/alerts?all=${all}`),
  acknowledgeAlert: (id: string) => post<{ acknowledged: boolean }>(`/api/alerts/${id}/acknowledge`),
  acknowledgeAllAlerts: () => post<{ acknowledged: number }>('/api/alerts/acknowledge-all'),
  backup: () => post<{ bytes: number; pruned: number }>('/api/system/backup'),
  backups: () => get<Array<{ id: string; path: string; bytes: number; trigger: string; createdAt: string }>>('/api/system/backups'),

  // Missions
  missions: (params: { status?: string; limit?: number; offset?: number; search?: string } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') query.set(key, String(value));
    }
    return get<{ items: Mission[]; total: number; limit: number; offset: number }>(
      `/api/missions?${query}`,
    );
  },
  mission: (id: string) => get<MissionDetail>(`/api/missions/${id}`),
  createMission: (body: {
    title: string;
    objective: string;
    context?: Record<string, unknown>;
    priority?: string;
    tags?: string[];
    autoStart?: boolean;
    tokenBudget?: number;
    departmentKey?: string | null;
  }) => post<Mission>('/api/missions', body),
  /**
   * La mission de démonstration locale, en un appel.
   *
   * Le serveur la refuse hors simulation ; la console n'a donc pas à décider si
   * elle est permise, seulement à rapporter fidèlement le refus.
   */
  createDemoMission: () => post<Mission>('/api/missions/demo'),
  missionAction: (id: string, action: string) =>
    post<Mission>(`/api/missions/${id}/actions`, { action }),

  // Agents
  agents: () => get<Agent[]>('/api/agents'),
  agent: (key: string) =>
    get<{
      agent: Agent;
      recentEvents: SystemEvent[];
      tools: Array<{ name: string; description: string; category: SkillCategory }>;
    }>(`/api/agents/${key}`),
  updateAgent: (key: string, body: Record<string, unknown>) => patch<Agent>(`/api/agents/${key}`, body),
  createAgent: (body: Record<string, unknown>) => post<Agent>('/api/agents', body),
  disableAgent: (key: string) => del<{ disabled: boolean }>(`/api/agents/${key}`),

  // Memory
  memory: (params: { q?: string; tier?: MemoryTier; limit?: number } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') query.set(key, String(value));
    }
    return get<{ items: MemoryHit[]; stats: { total: number; byTier: Record<string, number> } }>(
      `/api/memory?${query}`,
    );
  },
  createMemory: (body: Record<string, unknown>) => post<MemoryItem>('/api/memory', body),
  forgetMemory: (id: string) => del<{ forgotten: boolean }>(`/api/memory/${id}`),
  consolidateMemory: () =>
    post<{ expired: number; promoted: number; pruned: number }>('/api/memory/consolidate'),

  // Village
  village: () => get<VillageSnapshot>('/api/village'),
  buildings: (): Promise<Building[]> => get<VillageSnapshot>('/api/village').then((v) => v.buildings),

  // Events
  events: (params: { type?: string; severity?: string; limit?: number; agentKey?: string } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') query.set(key, String(value));
    }
    return get<SystemEvent[]>(`/api/events?${query}`);
  },
  messages: () => get<AgentMessage[]>('/api/messages'),

  // Automation
  workflows: () => get<{ workflows: Workflow[]; n8nEnabled: boolean }>('/api/workflows'),
  upsertWorkflow: (body: Record<string, unknown>) => post<Workflow>('/api/workflows', body),
  triggerWorkflow: (key: string, payload: Record<string, unknown> = {}) =>
    post<{ status: string; output: unknown; error?: string }>(`/api/workflows/${key}/trigger`, {
      payload,
      missionId: null,
    }),
  toggleWorkflow: (key: string) => post<Workflow>(`/api/workflows/${key}/toggle`),
  workflowRuns: (id: string) => get<WorkflowRun[]>(`/api/workflows/${id}/runs`),

  // Evolution
  improvements: (status?: string) =>
    get<{ items: Improvement[]; counts: Record<string, number> }>(
      `/api/improvements${status ? `?status=${status}` : ''}`,
    ),
  decideImprovement: (id: string, decision: 'approve' | 'reject' | 'revert') =>
    post<Improvement>(`/api/improvements/${id}/decision`, { decision }),
  runEvolution: () =>
    post<{ proposed: number; autoApplied: number; skipped: number }>('/api/evolution/run'),

  // Departments
  departments: () =>
    get<Array<{ department: Department; stats: DepartmentStats }>>('/api/departments'),
  department: (key: string) =>
    get<{
      department: Department;
      stats: DepartmentStats;
      missions: Mission[];
      readiness: Array<{
        ref: string;
        title: string;
        team: string;
        agentKey: string;
        agentName: string | null;
        requiredSkills: string[];
        ready: boolean;
      }>;
    }>(`/api/departments/${key}`),

  // Opportunities
  missionOpportunities: (missionId: string) =>
    get<{
      funnel: Record<OpportunityStage, number>;
      shortlist: string[];
      opportunities: OpportunityDetail[];
      economics: MissionEconomics | null;
    }>(`/api/missions/${missionId}/opportunities`),
  opportunity: (id: string) =>
    get<
      OpportunityDetail & {
        sources: Source[];
        alsoSeenIn: Array<{ opportunityId: string; missionId: string; stage: OpportunityStage; score: number | null }>;
      }
    >(`/api/opportunities/${id}`),
  reviewOpportunity: (id: string, body: { decision: 'approved' | 'rejected' | 'pending'; note?: string }) =>
    post<Opportunity>(`/api/opportunities/${id}/review`, body),
  discoveryCapabilities: () =>
    get<{
      mode: 'live' | 'simulation';
      providers: Array<{ key: string; label: string; kind: string; usable: boolean; reason: string }>;
    }>('/api/discovery/capabilities'),

  companies: (params: { q?: string; country?: string } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) query.set(key, String(value));
    return get<Company[]>(`/api/companies?${query.toString()}`);
  },
  company: (id: string) =>
    get<{
      company: Company;
      evidence: Evidence[];
      contacts: Contact[];
      relations: CompanyRelation[];
      opportunities: Opportunity[];
    }>(`/api/companies/${id}`),

  // Skills and tools
  skills: () => get<Array<Skill & { holders: string[] }>>('/api/skills'),
  toggleSkill: (key: string, enabled: boolean) => patch<Skill>('/api/skills/' + key, { enabled }),
  tools: () => get<Array<{ name: string; description: string; category: SkillCategory }>>('/api/tools'),
};
