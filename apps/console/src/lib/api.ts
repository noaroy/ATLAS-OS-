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
  MissionCockpit,
  MissionDecision,
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
  /** Pourquoi la mission s'est déroulée ainsi : plan, arrêts, conclusion. */
  decisions: MissionDecision[];
  /** Décisions affirmant quelque chose sans preuve. Vide est le cas normal. */
  unsupportedClaims: MissionDecision[];
  /** Tout ce que le cockpit affiche, mesuré côté serveur. */
  cockpit: MissionCockpit;
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

/** Ce que l'ecran de gestion recoit, en une seule requete. */
export interface AtlasOverview {
  status: 'ONLINE' | 'DEGRADED' | 'ACTION_REQUIRED';
  statusReason: string;
  today: {
    prospects: number; contacted: number; replies: number; positiveReplies: number;
    clients: number; revenueEur: number;
    /** `null` quand aucun appel n'a de tarif connu : l'affichage ecrit N/A. */
    aiCostUsd: number | null; aiCostUnknownCalls: number;
  };
  needsYou: Array<{
    kind: string; what: string; why: string; recommendation: string; action: string;
  }>;
  pipeline: {
    discovered: number; qualified: number; contacted: number;
    interested: number; preview: number | null; paid: number;
  };
  agents: Array<{
    name: string; status: string; currentTask: string | null;
    quota: string; lastResult: string | null;
  }>;
  system: Array<{ name: string; state: 'OK' | 'ATTENTION' | 'ABSENT'; detail: string }>;
  autonomy: { level: number; label: string; description: string };
  autopilot: {
    status: 'ACTIVE' | 'PAUSED' | 'IDLE' | 'NEVER_RAN';
    lastCycleAt: string | null;
    topObjective: string | null;
    topReason: string | null;
    inProgress: Array<{ id: string; objective: string; status: string }>;
    completedRecently: Array<{ id: string; objective: string; resolvedAt: string | null }>;
    waitingFounder: Array<{ id: string; objective: string; reason: string; command: string | null }>;
    estimatedSpendUsd: number;
    actualSpendUsd: number | null;
  };
  expansion: {
    universe: number;
    newCompanies: number;
    relationships: number;
    qualified: number;
    highPriority: number;
    evidence: number;
    costUsd: number;
    topSources: Array<{ label: string; relationships: number }>;
    topSeeds: Array<{ seed: string; companies: number; qualified: number }>;
    recentRuns: Array<{ id: string; startedAt: string; status: string; seeds: string[]; universe: number | null; qualified: number | null; highPriority: number | null; costUsd: number }>;
    nextOpportunity: string | null;
  };
  advanced: {
    taskStates: Record<string, number>;
    workspaces: Record<string, number>;
    repoWriteLock: string | null;
    aiLive: boolean;
  };
}

export const api = {
  atlasOverview: () => get<AtlasOverview>('/api/atlas/overview'),
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

/**
 * Le centre de commande.
 *
 * Chaque écran a sa route : une requête ciblée plutôt qu'une charge unique que
 * tout le monde télécharge pour en lire un dixième.
 *
 * Les champs qui peuvent valoir `null` le déclarent. Ce n'est pas une précaution
 * de typage : c'est la règle du produit remontée jusqu'ici — une valeur absente
 * s'affiche N/A, jamais zéro, et un type qui l'oublierait laisserait écrire
 * `?? 0` sans que rien ne proteste.
 */
export type HealthState = 'HEALTHY' | 'DEGRADED' | 'OFFLINE' | 'BLOCKED' | 'UNKNOWN';

export interface WarRoom {
  generatedAt: string;
  ledgerTotal: number;
  funnelTotal: number;
  consistent: boolean;
  funnel: Array<{ state: string; count: number; unexpected?: boolean }>;
  metrics: {
    contacted: number;
    everReplied: number;
    replyRate: number | null;
    positiveReplies: number;
    paidClients: number;
    revenueEur: number;
    followUpsDue: number;
    messagesSent: number;
    sentToday: number;
    dailyCap: number;
    dailyRemaining: number;
    freePreviews: number | null;
    aiCostToday: number | null;
    aiCostUnknownCalls: number;
  };
  repliedCompanies: Array<{ domain: string; name: string; at: string | null }>;
  followUps: Array<{ domain: string; name: string; reason: string }>;
}

export interface Prospecting {
  generatedAt: string;
  running: boolean;
  cycles: number;
  latestBatch: string | null;
  latestBatchStartedAt: string | null;
  stages: Array<{ id: string; label: string; count: number | null }>;
  lastCycle: {
    batchId: string;
    discovered: number;
    qualified: number;
    contactable: number;
    drafts: number;
    modelCalls: number | null;
    costUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
  } | null;
  /** Total à vie des domaines connus : c'est contre lui que la déduplication travaille. */
  registryDomains: number;
  guards: {
    humanApprovalRequired: boolean;
    minConversionScore: number;
    maxNewOutreachPerDay: number;
    budgetUsd: number;
  };
}

export interface CompanyRow {
  domain: string;
  name: string;
  state: string;
  contactedOn: string;
  lastOutboundAt: string | null;
  lastHumanReplyAt: string | null;
  lastAutoReplyAt: string | null;
  followUpsSent: number;
  followUpDue: boolean;
  followUpReason: string;
  hasConversation: boolean;
}

export interface CompanyDetail {
  generatedAt: string;
  domain: string;
  name: string;
  ledger: { kind: string; note: string | null; recordedBy: string; recordedAt: string };
  history: Array<Record<string, unknown>>;
  events: Array<{
    at: string; kind: string; classification: string;
    sender: string | null; subject: string | null; excerpt: string | null;
    humanReviewed: boolean; declaredStatus: string | null; source: string;
  }>;
  followUpsSent: number;
  lastOutboundAt: string | null;
}

export interface ApprovalItem {
  id: string;
  source: 'OUTREACH_DRAFT' | 'SALES_PROSPECT';
  prospectId: string | null;
  company: string;
  domain: string;
  recipient: string | null;
  subject: string | null;
  body: string;
  createdAt: string;
  createdBy: string | null;
  score: number | null;
  facts: Array<{ quote: string; sourceUrl: string }>;
  guards: string[];
  /** Par quel canal la décision peut réellement être exécutée. Calculé, non persisté. */
  actionType: 'EMAIL' | 'FORM' | 'PHONE' | 'MANUAL' | 'UNAVAILABLE';
  channelTarget: string | null;
  actionLabel: string;
  channelReason: string;
  /** Le destinataire est-il sur le domaine du prospect ? Signalé, jamais bloquant. */
  recipientDomainMatch: 'MATCH' | 'CROSS_DOMAIN' | 'UNKNOWN';
  recipientDomain: string | null;
  relatedDomainEvidence: string | null;
  domainReason: string;
  /** L'état réel en base — jamais réécrit pour l'affichage. */
  sourceState: string;
  /** Le libellé montré à l'opérateur : une traduction, pas une valeur stockée. */
  uiStatus: 'READY FOR APPROVAL';
  canApprove: boolean;
}

export interface Approvals {
  generatedAt: string;
  humanApprovalRequired: boolean;
  canApprove: boolean;
  actionEndpoint: string;
  byDomainMatch: { MATCH: number; CROSS_DOMAIN: number; UNKNOWN: number };
  byChannel: {
    EMAIL: number; FORM: number; PHONE: number; MANUAL: number; UNAVAILABLE: number;
  };
  bySource: { OUTREACH_DRAFT: number; SALES_PROSPECT: number };
  pending: ApprovalItem[];
  excluded: Array<{
    id: string;
    source: 'OUTREACH_DRAFT' | 'SALES_PROSPECT';
    company: string;
    domain: string;
    sourceState: string;
    reason: string;
  }>;
}

export interface AgentsView {
  generatedAt: string;
  workers: Array<{
    name: string; workerType: string | null; provider: string | null;
    status: string; currentTask: string | null; startedAt: string | null;
    runningMs: number | null; attempts: number | null; quota: string;
    lastResult: { outcome: string; at: string } | null; detail?: string;
  }>;
  queue: {
    byStatus: Record<string, number>;
    running: number; queued: number; waitingHuman: number;
    servedTypes: string[];
  };
  waiting: Array<{ taskId: string; taskType: string; department: string; reason: string; errorCode: string | null }>;
  needsYou: Array<{ kind: string; what: string; why: string; recommendation: string; action: string }>;
}

export interface Organization {
  generatedAt: string;
  hermes: { role: string; departments: number; agents: number };
  departments: Array<{
    key: string; name: string; tagline: string; building: string;
    teams: Array<{ key: string; stages: Array<{ ref: string; title: string; agentKey: string; action: string }> }>;
    agents: Array<{ key: string; name: string; role: string; tier: string; status: string; activity: string | null; lastActiveAt: string | null; model: string | null; enabled: boolean }>;
  }>;
  unassigned: Organization['departments'][number]['agents'];
}

export interface AiFabric {
  generatedAt: string;
  aiLive: boolean;
  providers: Array<{
    id: string; label: string; available: boolean; auth: string;
    model: string; priced: boolean; health: string;
    usage: {
      calls: number; inputTokens: number; outputTokens: number;
      costUsd: number | null; unknownCostCalls: number;
      lastUsedAt: string | null; lastOutcome: string | null;
    };
  }>;
  claudeCode: {
    available: boolean; detail: string; auth: string; authDetail: string;
    remainingCredits: number | null; remainingCreditsNote: string;
  };
  pricing: { configuredFile: string | null; rejected: Array<{ model: string; reason: string }>; declared: string[] };
  routing: { servedWorkerTypes: string[]; multiProvider: boolean; multiProviderNote: string };
}

export interface CostWindow {
  calls: number; inputTokens: number; outputTokens: number;
  costUsd: number | null; unknownCostCalls: number;
}

export interface Costs {
  generatedAt: string;
  windows: { today: CostWindow; last24h: CostWindow; last7d: CostWindow; month: CostWindow; total: CostWindow };
  byProvider: Array<{ provider: string; calls: number; costUsd: number | null; unknownCostCalls: number }>;
  byModel: CostSlice[];
  byAgent: CostSlice[];
  byMission: CostSlice[];
  byPurpose: CostSlice[];
  byDepartment: CostSlice[];
  workerByModel: CostSlice[];
  salesLoop: {
    calls: number; costUsd: number | null; unknownCostCalls: number; purposes: string[];
  };
  budgets: {
    dailyMode: string; monthlyMode: string; maxChainCostUsd: number;
    maxMissionCostUsd: number; salesBudgetUsd: number; unknownCostPolicy: string;
  };
  unknownPriceCalls: number;
}

export interface InboxMessage {
  at: string; domain: string; company: string; classification: string;
  subject: string | null; sender: string | null; excerpt: string | null;
  humanReviewed: boolean;
}

export interface Inbox {
  generatedAt: string;
  total: number;
  categories: {
    humanReplies: InboxMessage[]; autoReplies: InboxMessage[];
    bounces: InboxMessage[]; needsAction: InboxMessage[];
  };
  unmatched: number | null;
}

export interface SystemView {
  generatedAt: string;
  overall: HealthState;
  autonomy: { level: number; label: string; description: string };
  aiLive: boolean;
  components: Array<{ id: string; label: string; state: HealthState; detail: string }>;
}

/** Une tranche de dépense, quel que soit l'axe qui l'a découpée. */
export interface CostSlice {
  label: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  knownCostUsd: number;
  unknownCostCalls: number;
  lastAt: string | null;
}

export interface SearchEngine {
  id: string;
  name: string;
  health: 'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN';
  available: boolean;
  reason: string | null;
  circuit: string | null;
  inRoutingOrder: boolean;
  sessionCalls: number | null;
  sessionFailures: number | null;
  sessionLatencyMs: number | null;
  lastSuccessAt: string | null;
}

export interface SearchFabricView {
  generatedAt: string;
  configured: boolean;
  mode: string;
  fallbackEnabled: boolean;
  blocked: boolean;
  blockedReason: string | null;
  routingOrder: string[];
  primary: string | null;
  fallback: string | null;
  engines: SearchEngine[];
  ledger: {
    queries: number;
    queryFailures: number;
    queriesToday: number;
    avgQueryMs: number | null;
    pagesVisited: number;
    pageFailures: number;
    avgPageMs: number | null;
    lastActivityAt: string | null;
    entities: number | null;
  };
  byTool: Array<{
    tool: string; category: string | null; calls: number; failures: number;
    external: number; avgDurationMs: number; lastAt: string | null;
  }>;
  recentFailures: Array<{ tool: string; error: string | null; at: string }>;
}

export interface MultiModelTrace {
  generatedAt: string;
  note: string | null;
  missions: Array<{
    missionId: string;
    title: string | null;
    status: string | null;
    providers: number;
    models: number;
    startedAt: string;
    lastAt: string;
    steps: Array<{
      provider: string; model: string; agentKey: string | null; purpose: string | null;
      calls: number; failures: number; costUsd: number | null; unknownCostCalls: number;
      firstAt: string; lastAt: string;
    }>;
  }>;
}

export interface OutreachView {
  generatedAt: string;
  metrics: {
    messagesSent: number;
    sentToday: number;
    dailyCap: number;
    dailyRemaining: number;
    readyForApproval: number;
    approvedNotSent: number;
    reservedWithoutOutcome: number;
  };
  byPurpose: Array<{ purpose: string; count: number }>;
  sent: Array<{
    domain: string; recipient: string; subject: string; purpose: string;
    at: string | null; by: string; messageId: string | null;
  }>;
  reserved: Array<{
    domain: string; recipient: string; subject: string; purpose: string;
    claimedAt: string; claimedBy: string; key: string;
  }>;
  abandonments: Array<{ idempotencyKey: string; actor: string; reason: string; at: string }>;
}

export interface FollowUpsView {
  generatedAt: string;
  afterBusinessDays: number;
  metrics: { due: number; waiting: number; replied: number; contacted: number };
  due: Array<{
    domain: string; name: string; state: string; contactedOn: string;
    lastOutboundAt: string | null; followUpsSent: number; reason: string;
  }>;
  waiting: Array<{
    domain: string; name: string; state: string; contactedOn: string;
    followUpsSent: number; reason: string;
  }>;
}

export interface AnalyticsView {
  generatedAt: string;
  windowDays: number;
  daily: Array<{
    day: string; calls: number; costUsd: number | null;
    unknownCostCalls: number; sent: number;
  }>;
  funnel: Array<{ state: string; count: number; unexpected?: boolean }>;
  conversion: {
    contacted: number;
    replied: number;
    replyRate: number | null;
    positive: number;
    positiveRate: number | null;
    paidClients: number;
    revenueEur: number;
    costPerClientUsd: number | null;
  };
  costByProvider: CostSlice[];
  costByModel: CostSlice[];
  costByAgent: CostSlice[];
  costByPurpose: CostSlice[];
  workerByModel: CostSlice[];
  workerByDepartment: CostSlice[];
}

export const cc = {
  warRoom: () => get<WarRoom>('/api/cc/war-room'),
  prospecting: () => get<Prospecting>('/api/cc/prospecting'),
  companies: () => get<{ generatedAt: string; companies: CompanyRow[] }>('/api/cc/companies'),
  company: (domain: string) => get<CompanyDetail>(`/api/cc/companies/${encodeURIComponent(domain)}`),
  approvals: () => get<Approvals>('/api/cc/approvals'),
  agents: () => get<AgentsView>('/api/cc/agents'),
  organization: () => get<Organization>('/api/cc/organization'),
  aiFabric: () => get<AiFabric>('/api/cc/ai-fabric'),
  costs: () => get<Costs>('/api/cc/costs'),
  inbox: () => get<Inbox>('/api/cc/inbox'),
  system: () => get<SystemView>('/api/cc/system'),
  searchFabric: () => get<SearchFabricView>('/api/cc/search-fabric'),
  multiModel: () => get<MultiModelTrace>('/api/cc/multi-model'),
  outreach: () => get<OutreachView>('/api/cc/outreach'),
  followUps: () => get<FollowUpsView>('/api/cc/follow-ups'),
  analytics: () => get<AnalyticsView>('/api/cc/analytics'),
  dashboard: (range: DashboardRange, segment: string | null) =>
    get<SalesDashboard>(`/api/cc/dashboard?range=${range}${segment ? `&segment=${encodeURIComponent(segment)}` : ''}`),
  revenue: () => get<RevenueMobile>('/api/cc/revenue'),
  prospect: (domain: string) => get<ProspectDetail>(`/api/cc/prospects/${encodeURIComponent(domain)}`),
};

// ─── L'écran de téléphone ────────────────────────────────────────────────────
// Miroir de `packages/server/src/http/revenue-mobile.ts`.

export type OutboundMode = 'OFF' | 'INTERNAL_TEST' | 'ACTIVE';

export interface RevenueMobile {
  generatedAt: string;
  header: {
    status: 'ONLINE' | 'DEGRADED';
    reasons: string[];
    outbound: OutboundMode;
    sendWindow: { window: string; open: boolean };
    killSwitch: { paused: boolean; reason: string | null; by: string | null; at: string | null };
    aiCostTodayUsd: number | null;
    aiCostUnknownCalls: number;
    lastRevenueActionAt: string | null;
    lastRevenueAction: string | null;
    lastSyncAt: string | null;
    lastCycleAt: string | null;
    services: Array<{ id: string; label: string; state: SystemLight['state']; detail: string }>;
  };
  kpis: {
    discoveredToday: number; qualifiedToday: number; highPriority: number; contactReady: number;
    sentToday: number; repliesToday: number; positiveRepliesToday: number; meetings: number;
    proposals: number | null; won: number; revenueSigned: number; currency: string; pipelinePotential: number | null;
  };
  funnel: Array<{ key: string; count: number | null; rate: number | null }>;
  priorityProspects: Array<{ domain: string; companyName: string; tier: string | null; score: number | null; whyFit: string | null; contactReady: boolean }>;
  drafts: {
    awaitingApproval: number;
    approvedToSend: number;
    items: Array<{ id: string; domain: string; companyName: string; recipient: string; subject: string; createdAt: string }>;
  };
  todo: SalesDashboard['todo'];
  caps: { dailyNewOutreach: number; sentToday: number; hourly: number };
  expansions: Array<{
    id: string; status: string; startedAt: string; finishedAt: string | null; seeds: number;
    universe: number | null; qualified: number | null; highPriority: number | null; costUsd: number; stopReason: string | null;
  }>;
  costs: {
    todayUsd: { openai: number | null; anthropic: number | null; search: number | null; total: number | null };
    caps: { aiDailyUsd: number | null; salesAiDailyUsd: number | null };
    perQualifiedUsd: number | null; perContactReadyUsd: number | null; perClientUsd: number | null;
  };
  definitions: Record<string, string>;
}

export interface ProspectDetail {
  generatedAt: string;
  identity: {
    prospectId: string; companyName: string; domain: string; website: string | null; country: string | null;
    industry: string | null; identityConfidence: number | null; identitySources: string[];
    discoveredAt: string; sourceUrl: string | null; query: string | null; duplicates: number;
  };
  qualification: { state: string; tier: string | null; score: number | null; whyFit: string | null; rejectReason: string | null };
  contact: {
    name: string | null; role: string | null; email: string | null; phone: string | null; page: string | null;
    method: string | null; observed: boolean; sourceUrl: string | null; confidence: number | null; suitability: string | null;
  };
  evidence: Array<{ field: string; claim: string; nature: string; sourceUrl: string | null; confidence: number; collectedAt: string }>;
  urls: string[];
  recommendations: Array<{ company: string; domain: string; fitReason: string; sourceUrl: string; evidenceQuote: string }>;
  drafts: Array<{
    id: string; purpose: string; state: string; recipient: string; subject: string; body: string;
    sources: Array<{ quote: string; sourceUrl: string }>; createdAt: string; createdBy: string;
  }>;
  history: {
    loop: Array<{ at: string; from: string | null; to: string; reason: string | null; actor: string }>;
    ledger: Array<{ at: string; kind: string; note: string | null; by: string }>;
    currentLoopState: string | null;
    lastSentAt: string | null;
  };
  blockers: string[];
  firstTouchReady: boolean;
}

// ─── Le moteur commercial : la page unique et ses décisions ──────────────────

export type DashboardRange = '7d' | '30d' | 'all';

export interface SystemLight { state: 'ok' | 'warn' | 'down' | 'off'; detail: string }
export type GmailStatusCode = 'READY' | 'READY_IDLE' | 'DOWN' | 'STALE' | 'UNKNOWN' | 'OFF';
export interface GmailLight extends SystemLight { code: GmailStatusCode; lastAttemptAt: string | null }

export interface SalesDashboard {
  generatedAt: string;
  range: DashboardRange;
  since: string | null;
  segmentId: string | null;
  cards: {
    meetings: number; meetingsThisWeek: number; clientsSigned: number; revenueSigned: number; currency: string;
    pipelinePotential: number | null; pipelineExplanation: string[];
  };
  todo: { hotLeads: number; approvals: number; followUps: number; recommendations: number; segmentsToApprove: number; total: number };
  funnel: Array<{ stage: string; label: string; count: number; rate: number | null }>;
  performance: {
    positiveReplyRate: number | null; replyRate: number | null; meetingPerContact: number | null;
    clientPerContact: number | null; cac: number | null; revenuePer100: number | null; spendUsd: number | null;
  };
  segments: Array<{
    id: string; name: string; status: string; approvedForSend: boolean; contacted: number;
    positiveReplies: number; meetings: number; clients: number; revenuePer100: number | null;
    decision: string; decisionReason: string;
  }>;
  best: {
    segment: { id: string; name: string; positiveRate: number } | null;
    messageVariant: { key: string; positiveRate: number; contacted: number } | null;
  };
  recommendations: Array<{
    id: string; kind: string; title: string; reason: string; sampleSize: number; expectedImpact: string | null;
    risk: string; status: string; humanRequired: boolean; hasChange: boolean; evidence: Record<string, unknown>; createdAt: string;
  }>;
  insufficient: Array<{ subject: string; sample: number; needed: number }>;
  hotLeads: Array<{
    domain: string; companyName: string; contact: string | null; sender: string | null; intent: string; confidence: number;
    receivedAt: string; subject: string | null; excerpt: string | null; status: 'OPEN' | 'HANDLED';
  }>;
  hotLeadsTotal: number;
  /** Les prospects encore à saisir, tels qu'enregistrés — lecture seule. */
  opportunities: SalesOpportunity[];
  opportunitiesTotal: number;
  system: {
    search: SystemLight; llm: SystemLight; gmail: GmailLight; workers: SystemLight; database: SystemLight;
    outbound: { enabled: boolean; mode: string; paused: boolean; pauseReason: string | null; window: string; windowOpen: boolean };
    lastCycleAt: string | null;
    openInsights: number;
    detail: string[];
  };
}

export interface SalesOpportunity {
  prospectId: string; companyName: string; domain: string; website: string | null;
  state: string; tier: string | null; score: number | null; whyFit: string | null;
  contact: {
    name: string | null; role: string | null; email: string | null; phone: string | null; page: string | null;
    method: string | null; observed: boolean; sourceUrl: string | null;
  };
  sourceUrl: string | null;
  updatedAt: string;
}

export const sales = {
  pause: (reason: string) => post<{ paused: boolean }>('/api/sales/pause', { reason }),
  resume: () => post<{ paused: boolean }>('/api/sales/resume'),
  decide: (id: string, decision: 'test' | 'approve' | 'reject') =>
    post<{ applied: boolean; reason: string }>(`/api/sales/recommendations/${id}/${decision}`),
  outcome: (body: {
    domain: string; kind: string; revenueAmount?: number | null; currency?: string; occurredAt?: string;
    offer?: string | null; note?: string | null;
  }) => post<{ id: string }>('/api/sales/outcomes', body),
  segmentAction: (id: string, action: string, reason?: string) =>
    post<unknown>(`/api/sales/segments/${id}/${action}`, reason ? { reason } : undefined),
  suppress: (body: { kind: 'EMAIL' | 'DOMAIN' | 'COMPANY'; value: string; reason: string }) =>
    post<{ created: boolean }>('/api/sales/suppress', body),
  leadHandled: (domain: string, note?: string) =>
    post<unknown>(`/api/sales/leads/${encodeURIComponent(domain)}/handled`, note ? { note } : undefined),
  insights: () => get<Array<{ id: string; title: string; detail: string; frequency: number; status: string; lastSeenAt: string }>>('/api/sales/insights'),
};
