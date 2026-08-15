/**
 * Business intelligence vocabulary of ATLAS OS.
 *
 * These types are the *platform's* domain model, not one department's. They
 * describe how ATLAS represents organisations it studies, the evidence it holds
 * about them, and the opportunities it derives from them — the substrate that
 * Business Expansion, and later Procurement, Competitive or Acquisition
 * Intelligence, all build on (Constitution, Articles IV and XIV).
 *
 * Nothing here knows what a distributor is. Target types, scoring dimensions,
 * pipeline stages and team composition are all *declared by a department*, so a
 * new department is a definition rather than a schema change.
 */

import type { AgentKey, BuildingKey, MissionId, SkillKey, StagePrecondition } from './domain.ts';

// ─── Identifiers ──────────────────────────────────────────────────────────

export type DepartmentKey = string;
export type TeamKey = string;
export type CompanyId = string;
export type OpportunityId = string;
export type EvidenceId = string;
export type ContactId = string;
export type SourceKey = string;

// ─── Market scope ─────────────────────────────────────────────────────────

/**
 * Where and in what field a mission is looking.
 *
 * Countries and industries are dimensions of a search, not entities in their
 * own right, so they live here rather than in tables of their own. Codes are
 * ISO-3166-1 alpha-2 where known, free text otherwise.
 */
export interface MarketScope {
  countries: string[];
  /** Free-form industry labels — NACE/SIC codes when the source provides them. */
  industries: string[];
  /** Optional narrowing inside a country: a region, state or metro area. */
  regions: string[];
}

export const emptyMarketScope = (): MarketScope => ({ countries: [], industries: [], regions: [] });

// ─── Companies ────────────────────────────────────────────────────────────

export type CompanySizeBand = 'micro' | 'small' | 'medium' | 'large' | 'enterprise' | 'unknown';

export const COMPANY_SIZE_BANDS: readonly CompanySizeBand[] = [
  'micro',
  'small',
  'medium',
  'large',
  'enterprise',
  'unknown',
];

/**
 * An organisation ATLAS knows about.
 *
 * The registry is shared across missions and departments: a company found while
 * looking for distributors is the same company later considered as a supplier.
 * That is what makes prior work reusable instead of re-bought (Article XI).
 */
export interface Company {
  id: CompanyId;
  /** Normalised identity used for deduplication. Unique. */
  canonicalKey: string;
  name: string;
  legalName: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  website: string | null;
  /** Registrable domain, normalised — the strongest dedup signal available. */
  domain: string | null;
  industries: string[];
  sizeBand: CompanySizeBand;
  employeesEstimate: number | null;
  foundedYear: number | null;
  description: string | null;
  /** Department-agnostic enrichment: products, brands, certifications, … */
  profile: Record<string, unknown>;
  /** Whether anything is known beyond the name that identified it. */
  enriched: boolean;
  firstSeenAt: string;
  /** Last time a fact about this company was observed at a source. */
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A relationship between two organisations — "distributes for", "owns", … */
export interface CompanyRelation {
  id: string;
  fromCompanyId: CompanyId;
  toCompanyId: CompanyId | null;
  /** Free-form when the counterparty is not in the registry. */
  toName: string | null;
  kind: string;
  description: string;
  confidence: number;
  evidenceId: EvidenceId | null;
  createdAt: string;
}

// ─── Sources and evidence ─────────────────────────────────────────────────

export type SourceKind =
  | 'company-website'
  | 'directory'
  | 'registry'
  | 'press'
  | 'social'
  | 'dataset'
  | 'model-inference'
  | 'founder'
  | 'simulation';

/**
 * Where information came from, and how much that origin is worth.
 *
 * Reliability is a property of the source, not of the claim, so it is stored
 * once here and reused by every piece of evidence that cites it.
 */
export interface Source {
  key: SourceKey;
  kind: SourceKind;
  label: string;
  /** Domain or dataset identifier this source resolves to. */
  reference: string | null;
  /** 0..1 — how much weight evidence from here deserves. */
  reliability: number;
  createdAt: string;
}

/**
 * How a claim came to be known. The distinction ATLAS must never blur.
 *
 * - `observed`  — an agent read it directly at a cited source.
 * - `reported`  — a third party states it; true of the source, not verified.
 * - `inferred`  — the model concluded it. Never presented as fact.
 */
export type EvidenceNature = 'observed' | 'reported' | 'inferred';

export const EVIDENCE_NATURES: readonly EvidenceNature[] = ['observed', 'reported', 'inferred'];

/** Ceiling on how confident an inference may claim to be. */
export const MAX_INFERENCE_CONFIDENCE = 0.7;

/**
 * One sourced claim about one company.
 *
 * Evidence is append-only: a later contradiction is another row, not an edit,
 * so the record of what ATLAS believed and when survives (Article XI).
 */
export interface Evidence {
  id: EvidenceId;
  companyId: CompanyId;
  opportunityId: OpportunityId | null;
  missionId: MissionId | null;
  /** The attribute this speaks to: `country`, `products`, `reach`, … */
  field: string;
  /** The claim in plain language, as it will be shown to the founder. */
  claim: string;
  /** Machine-usable form of the claim when there is one. */
  value: unknown;
  nature: EvidenceNature;
  sourceKey: SourceKey;
  /** URL or identifier of the exact page/record consulted. */
  sourceRef: string | null;
  sourceTitle: string | null;
  /** Required for `inferred`: what the inference was built on. */
  basis: string | null;
  /** 0..1 — capped for inference, see MAX_INFERENCE_CONFIDENCE. */
  confidence: number;
  /**
   * Whether this was produced while ATLAS was running on simulated inference.
   * Stamped by the platform, never by the agent, so simulated output can never
   * be presented as real data.
   */
  simulated: boolean;
  collectedAt: string;
  agentKey: AgentKey;
  createdAt: string;
}

/** A person at a company. Contacts are evidence-backed like everything else. */
export interface Contact {
  id: ContactId;
  companyId: CompanyId;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  confidence: number;
  evidenceId: EvidenceId | null;
  createdAt: string;
}

// ─── Opportunities ────────────────────────────────────────────────────────

/**
 * The pipeline every intelligence department runs, in order.
 *
 * An opportunity's stage is the honest answer to "how far has this candidate
 * actually got", which is what the console funnel and the village both read.
 */
export const OPPORTUNITY_STAGES = [
  'discovered',
  'enriched',
  'qualified',
  'scored',
  'shortlisted',
  /** A human has read it and formed a view. */
  'reviewed',
  /** The founder signed it off for delivery. Nothing reaches a client before this. */
  'approved',
  'rejected',
] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

export type QualificationVerdict = 'qualified' | 'rejected' | 'uncertain';

/**
 * The verdict on whether a candidate is worth scoring at all.
 *
 * Verification is part of qualification rather than a separate stage: a claim
 * that no evidence supports cannot be used to qualify, and the platform — not
 * the agent — enforces that.
 */
export interface Qualification {
  verdict: QualificationVerdict;
  /** Criteria checked, each with the evidence that settled it. */
  checks: QualificationCheck[];
  rationale: string;
  confidence: number;
  decidedBy: AgentKey;
  decidedAt: string;
}

export interface QualificationCheck {
  criterion: string;
  passed: boolean;
  detail: string;
  evidenceIds: EvidenceId[];
}

/**
 * How well a candidate fits one particular role.
 *
 * A company can genuinely be both a distributor and an integrator, and the two
 * fits are rarely equal. Keeping them apart is what lets the shortlist say
 * *which relationship* to propose, rather than only that the company is
 * interesting — which is the actual commercial decision.
 */
export interface RoleFit {
  /** A target type key declared by the department. */
  role: string;
  label: string;
  /** 0..100 for this role specifically. */
  value: number;
  rationale: string;
  confidence: number;
  evidenceIds: EvidenceId[];
}

/** One weighted axis of a department's scoring model. */
export interface ScoringDimension {
  key: string;
  label: string;
  description: string;
  /** Relative weight. Only ratios matter; they are normalised at scoring time. */
  weight: number;
  /**
   * When true, the platform computes this dimension from the evidence ledger
   * and an agent cannot set it — the anti-flattery guarantee.
   */
  computed?: boolean;
}

export interface ScoringModel {
  dimensions: ScoringDimension[];
  /** 0..100 — below this an opportunity is not worth shortlisting. */
  shortlistThreshold: number;
  /** Explains, in the founder's language, what the score means. */
  narrative: string;
}

/** One dimension's outcome for one opportunity. */
export interface ScoreComponent {
  dimension: string;
  label: string;
  /** 0..100 on this axis. */
  value: number;
  weight: number;
  /** value × normalised weight — what this axis actually contributed. */
  contribution: number;
  rationale: string;
  confidence: number;
  evidenceIds: EvidenceId[];
  /** True when the platform computed it rather than an agent asserting it. */
  computed: boolean;
}

/**
 * A score that can always answer "why is this one first?".
 *
 * The total is never stored as an opaque number: it is the sum of the
 * contributions below, and removing any component changes it predictably.
 */
export interface OpportunityScore {
  total: number;
  components: ScoreComponent[];
  /** 0..1 — how much the evidence behind the score supports it. */
  confidence: number;
  /**
   * Fit per role, when the mission looks for more than one.
   *
   * Deliberately kept out of the total: the ranking must stay comparable across
   * candidates, and a company that fits two roles is not automatically a better
   * partner than one that fits one role superbly. This explains *which*
   * relationship to open, not how high the candidate ranks.
   */
  roleFits: RoleFit[];
  /** The model that produced it, so a re-weighting is visibly a new score. */
  modelVersion: string;
  scoredBy: AgentKey;
  scoredAt: string;
}

/**
 * A company considered as a candidate, for one mission, by one department.
 *
 * "Target" and "Opportunity" would be two names for this one thing, so ATLAS
 * uses only Opportunity; what kind of target it is lives in `targetType`.
 */
export interface Opportunity {
  id: OpportunityId;
  missionId: MissionId;
  departmentKey: DepartmentKey;
  companyId: CompanyId;
  /**
   * The roles this company is relevant for in this mission.
   *
   * Plural because a single organisation can genuinely be both a distributor
   * and an integrator. One company is one opportunity carrying several roles,
   * never several opportunities — duplicating it would double-count the funnel
   * and put the same company twice in a shortlist.
   */
  targetTypes: string[];
  stage: OpportunityStage;
  /** 0..100, or null before scoring. */
  score: number | null;
  scoreDetail: OpportunityScore | null;
  qualification: Qualification | null;
  /** 1-based position in the final shortlist; null until ranked. */
  rank: number | null;
  /** Why this one sits where it sits, written for the founder. */
  justification: string | null;
  /** True when the company was already known and its profile was reused. */
  reusedKnowledge: boolean;
  /**
   * The founder's own verdict.
   *
   * ATLAS produces a shortlist; a human decides whether it may be shown to
   * anyone. No export marks itself deliverable without this.
   */
  review: OpportunityReview | null;
  discoveredBy: AgentKey;
  createdAt: string;
  updatedAt: string;
}

/**
 * A human decision on one candidate.
 *
 * Kept separate from qualification and scoring, which are ATLAS's judgements:
 * conflating them would make it impossible to tell what the system concluded
 * from what a person accepted.
 */
export interface OpportunityReview {
  decision: 'approved' | 'rejected' | 'pending';
  /** The founder's own words — kept verbatim, never summarised. */
  note: string | null;
  reviewedBy: string;
  reviewedAt: string;
}

/** An opportunity with everything needed to display or judge it. */
export interface OpportunityDetail {
  opportunity: Opportunity;
  company: Company;
  evidence: Evidence[];
  contacts: Contact[];
  relations: CompanyRelation[];
}

// ─── Departments and teams ────────────────────────────────────────────────

/** A kind of organisation a department knows how to look for. */
export interface TargetTypeDefinition {
  key: string;
  label: string;
  description: string;
}

/**
 * A team is the organisational level between a department and an agent
 * (Article V): a named group that owns one part of the pipeline.
 */
export interface TeamDefinition {
  key: TeamKey;
  name: string;
  purpose: string;
  /** Pipeline stages this team is accountable for. */
  stages: OpportunityStage[];
  agentKeys: AgentKey[];
}

export interface Team extends TeamDefinition {
  departmentKey: DepartmentKey;
}

/**
 * One step of a department's standard method.
 *
 * A playbook makes a department's pipeline reproducible rather than reinvented
 * per mission. Hermes still orchestrates, supervises and replans — it delegates
 * the *shape* of the work to the department that owns the method (Article IV),
 * exactly as a CEO does not redesign a division's process for every job.
 */
export interface PlaybookStage {
  ref: string;
  title: string;
  agentKey: AgentKey;
  teamKey: TeamKey;
  action: string;
  /** Skills the assigned agent must hold, or the stage cannot be dispatched. */
  requiredSkills: SkillKey[];
  /** `{{field}}` placeholders are filled from the mission brief. */
  instruction: string;
  expectedOutput: string;
  dependsOn: string[];
  /**
   * Ce que l'étape exige d'avoir reçu pour valoir la peine d'être lancée.
   *
   * Distinct de `dependsOn`, qui ne vérifie que la séquence. Une étape
   * d'enrichissement dépend de la découverte *et* exige des candidats : sans
   * eux elle est sautée, sans qu'aucun appel au modèle ne soit émis.
   */
  preconditions?: StagePrecondition[];
  /** The pipeline stage this advances opportunities to. */
  advancesTo: OpportunityStage | null;
}

export interface DepartmentKpi {
  key: string;
  label: string;
  unit: 'count' | 'percent' | 'currency' | 'duration';
  description: string;
}

/**
 * A department is a product: a domain ATLAS can sell on its own (Article IV).
 *
 * Everything that makes one department different from another is data in this
 * definition — its targets, its brief, its method, its scoring, its teams.
 */
export interface DepartmentDefinition {
  key: DepartmentKey;
  name: string;
  tagline: string;
  mission: string;
  /** The village building that represents this department. */
  building: BuildingKey;
  targetTypes: TargetTypeDefinition[];
  /** JSON Schema Hermes uses to turn a founder's request into a brief. */
  briefSchema: Record<string, unknown>;
  playbook: PlaybookStage[];
  scoringModel: ScoringModel;
  teams: TeamDefinition[];
  kpis: DepartmentKpi[];
  /** Keywords that let Hermes recognise a request as this department's work. */
  triggers: string[];
  enabled: boolean;
}

export type Department = DepartmentDefinition;

/** Live counters for a department, derived from its missions. */
export interface DepartmentStats {
  departmentKey: DepartmentKey;
  missionsTotal: number;
  missionsActive: number;
  opportunitiesDiscovered: number;
  opportunitiesQualified: number;
  opportunitiesShortlisted: number;
  companiesKnown: number;
  evidenceItems: number;
  /** Null until at least one qualified opportunity exists. */
  costPerQualifiedOpportunity: number | null;
}

// ─── Mission economics ────────────────────────────────────────────────────

/**
 * What one mission cost and produced.
 *
 * Cost per qualified opportunity is the number that decides whether this is a
 * business, so every input to it is stored rather than recomputed from logs.
 */
export interface MissionEconomics {
  missionId: MissionId;
  tokensUsed: number;
  /** Estimated spend in USD; null when no price is configured for the model. */
  estimatedCostUsd: number | null;
  /** Tool calls that reached outside ATLAS — the metered part of a real run. */
  externalCalls: number;
  durationMs: number;
  opportunitiesDiscovered: number;
  opportunitiesQualified: number;
  opportunitiesShortlisted: number;
  /** Companies answered from the registry instead of researched again. */
  knowledgeReused: number;
  costPerQualifiedOpportunity: number | null;
  /** True when any part of this mission ran on simulated inference. */
  simulated: boolean;

  /**
   * La décomposition par appel, quand la mission en possède une.
   *
   * `null` pour les missions antérieures à la télémétrie — dont LIVE #001, qui
   * garde ainsi le chiffre sous lequel il a été constaté plutôt qu'un coût
   * recalculé après coup avec une répartition inventée.
   */
  measured: MeasuredEconomics | null;
}

/** Ce qu'une mission a réellement consommé, appel par appel. */
export interface MeasuredEconomics {
  llmCalls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Coût calculé sur les tarifs entrée/sortie réels, non sur un tarif mélangé. */
  costUsd: number;
  byModel: Array<{
    model: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
  byStep: Array<{
    taskRef: string;
    model: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    durationMs: number;
    failures: number;
  }>;
  costPerDiscoveredOpportunity: number | null;
  costPerQualifiedOpportunity: number | null;
  costPerShortlistedOpportunity: number | null;
}
