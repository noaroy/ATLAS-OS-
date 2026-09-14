import { id, nowIso } from '@atlas/core';
import type { Repositories } from '@atlas/data';
import { sha256, type ClientCandidate } from '@atlas/data';
import type { ClientBrief } from '@atlas/departments';
import type { SearchReadiness } from '@atlas/intelligence';
import type { ScoringModel } from '@atlas/contracts';
import {
  runClientBatch, createClientRun, loadClientRun, adjustClientRun, spendSoFar, CLIENT_BATCH_DEFAULTS,
  type ClientMissionDeps, type BatchSummary, type ClientRunContext,
} from './client-mission.ts';
import { proposeBriefAdjustment, type BriefProposal } from './client-feedback.ts';
import { writeClientReportFiles, type WriteFile, type ReportFiles } from './client-report-files.ts';
import type { PreflightVerdict } from './client-preflight.ts';

/**
 * Le pilote automatique d'une mission client.
 *
 * Il n'invente rien du pipeline : il enchaîne les briques validées — preflight,
 * création, lots, tri, rapports — et s'arrête exactement là où le jugement
 * humain devient utile. Tout ce qu'il décide est déterministe, écrit dans le
 * contexte de la mission, journalisé dans les événements, et reprenable : deux
 * lancements de la même commande donnent le même état, pas deux missions.
 *
 * Ce qu'il ne fait jamais : envoyer, soumettre, contacter, changer un brief,
 * relever un budget, livrer. Ces gestes ont chacun une commande humaine.
 */

// ─── Les états ───────────────────────────────────────────────────────────────

export const MISSION_STATES = [
  'DRAFT', 'PREFLIGHT_REQUIRED', 'READY_TO_START', 'RUNNING_DISCOVERY', 'RUNNING_ANALYSIS', 'RETRYING',
  'HUMAN_REVIEW_REQUIRED', 'PARTIAL_READY', 'WAITING_CLIENT_FEEDBACK', 'BRIEF_UPDATE_REQUIRED', 'READY_TO_CONTINUE',
  'FINAL_REVIEW_REQUIRED', 'FINAL_READY', 'COMPLETED', 'PAUSED_BUDGET', 'PAUSED_INFRA', 'FAILED',
] as const;
export type MissionState = (typeof MISSION_STATES)[number];

/** Les transitions permises. Tout le reste est une erreur de programmation, pas une décision. */
export const MISSION_TRANSITIONS: Record<MissionState, readonly MissionState[]> = {
  DRAFT: ['PREFLIGHT_REQUIRED'],
  PREFLIGHT_REQUIRED: ['READY_TO_START', 'READY_TO_CONTINUE', 'PAUSED_INFRA', 'PAUSED_BUDGET', 'FAILED'],
  READY_TO_START: ['RUNNING_DISCOVERY', 'PREFLIGHT_REQUIRED'],
  READY_TO_CONTINUE: ['RUNNING_DISCOVERY', 'RETRYING', 'FINAL_REVIEW_REQUIRED', 'PREFLIGHT_REQUIRED', 'HUMAN_REVIEW_REQUIRED', 'PARTIAL_READY', 'BRIEF_UPDATE_REQUIRED'],
  RUNNING_DISCOVERY: ['RUNNING_ANALYSIS', 'PAUSED_INFRA', 'PAUSED_BUDGET', 'FAILED', 'READY_TO_CONTINUE'],
  RUNNING_ANALYSIS: ['RETRYING', 'HUMAN_REVIEW_REQUIRED', 'PARTIAL_READY', 'READY_TO_CONTINUE', 'FINAL_REVIEW_REQUIRED', 'PAUSED_BUDGET', 'PAUSED_INFRA', 'FAILED'],
  RETRYING: ['RUNNING_ANALYSIS', 'READY_TO_CONTINUE', 'FINAL_REVIEW_REQUIRED', 'PAUSED_BUDGET', 'PAUSED_INFRA', 'HUMAN_REVIEW_REQUIRED', 'FAILED'],
  HUMAN_REVIEW_REQUIRED: ['READY_TO_CONTINUE', 'PARTIAL_READY', 'FINAL_REVIEW_REQUIRED', 'BRIEF_UPDATE_REQUIRED'],
  PARTIAL_READY: ['WAITING_CLIENT_FEEDBACK'],
  WAITING_CLIENT_FEEDBACK: ['BRIEF_UPDATE_REQUIRED', 'READY_TO_CONTINUE', 'FINAL_REVIEW_REQUIRED'],
  BRIEF_UPDATE_REQUIRED: ['READY_TO_CONTINUE', 'WAITING_CLIENT_FEEDBACK'],
  FINAL_REVIEW_REQUIRED: ['FINAL_READY', 'READY_TO_CONTINUE', 'HUMAN_REVIEW_REQUIRED', 'BRIEF_UPDATE_REQUIRED'],
  FINAL_READY: ['COMPLETED', 'READY_TO_CONTINUE'],
  COMPLETED: [],
  PAUSED_BUDGET: ['READY_TO_CONTINUE', 'PREFLIGHT_REQUIRED', 'FINAL_REVIEW_REQUIRED'],
  PAUSED_INFRA: ['PREFLIGHT_REQUIRED', 'READY_TO_CONTINUE'],
  FAILED: ['PREFLIGHT_REQUIRED'],
};

/** Les états où le pilote rend la main : rien ne se passe sans un geste humain. */
export const HUMAN_STATES: ReadonlySet<MissionState> = new Set([
  'HUMAN_REVIEW_REQUIRED', 'WAITING_CLIENT_FEEDBACK', 'BRIEF_UPDATE_REQUIRED', 'FINAL_REVIEW_REQUIRED', 'FINAL_READY',
  'PAUSED_BUDGET', 'PAUSED_INFRA', 'FAILED', 'COMPLETED',
]);

export function canTransition(from: MissionState, to: MissionState): boolean {
  return from === to || MISSION_TRANSITIONS[from].includes(to);
}

export type AutopilotLevel = 0 | 1 | 2 | 3;
export const LEVEL_LABELS: Record<AutopilotLevel, string> = { 0: 'MANUAL', 1: 'ASSISTED', 2: 'SEMI_AUTO', 3: 'AUTO_MISSION' };

// ─── Les garde-fous ──────────────────────────────────────────────────────────

/**
 * Les bornes que rien ne franchit. Chacune est un plafond, jamais une cible :
 * une mission qui les atteint s'arrête et le dit.
 */
export interface AutopilotLimits {
  batchSizeMin: number;
  batchSizeDefault: number;
  batchSizeMax: number;
  /** Lots que ce lancement peut enchaîner avant de rendre la main. */
  maxBatchesPerInvocation: number;
  /** Lots sur toute la vie de la mission. */
  maxBatchesTotal: number;
  maxDurationMs: number;
  /** Part de « à revoir » dans un lot au-delà de laquelle le pilote s'arrête (niveau 2). */
  reviewPauseRate: number;
  /** Nombre de dossiers à revoir en attente au-delà duquel le pilote s'arrête (niveau 2). */
  reviewPauseCount: number;
  /** Au niveau 3, seule une revue « critique » arrête. */
  criticalReviewRate: number;
  /** Retenues à partir desquelles un PARTIAL est préparé. */
  partialAtRetained: number;
  /** Lots consécutifs à rendement très faible avant de déclarer le marché saturé. */
  lowYieldStreak: number;
  /** Attente entre deux lots de reprise, par tentative. */
  retryBackoffMs: number;
  /** Requêtes moteur par lot de découverte. */
  maxQueriesPerBatch: number;
}

export const DEFAULT_LIMITS: AutopilotLimits = Object.freeze({
  batchSizeMin: 10, batchSizeDefault: 20, batchSizeMax: 50,
  maxBatchesPerInvocation: 6, maxBatchesTotal: 12, maxDurationMs: 45 * 60_000,
  reviewPauseRate: 0.4, reviewPauseCount: 10, criticalReviewRate: 0.6,
  partialAtRetained: 10, lowYieldStreak: 3, retryBackoffMs: 2_000, maxQueriesPerBatch: 8,
});

// ─── Ce que le pilote mesure ─────────────────────────────────────────────────

export type QualityLabel = 'QUALITY_GOOD' | 'QUALITY_WARNING' | 'QUALITY_BAD';

export interface BatchQuality {
  batch: number;
  score: number;
  label: QualityLabel;
  processed: number;
  reviewRate: number;
  errorRate: number;
  falseCandidateRate: number;
  components: Record<string, number>;
}

export interface SearchYield {
  batch: number;
  rawResults: number;
  uniqueDomains: number;
  discovered: number;
  relevant: number;
  excludedEarly: number;
  /** Nouveaux candidats par résultat brut, 0–1. */
  yield: number;
  low: boolean;
  stoppedBecause: string | null;
}

export const NEXT_ACTIONS = [
  'START_MISSION', 'RUN_NEXT_BATCH', 'RETRY_FAILED', 'REVIEW_CANDIDATES', 'GENERATE_PARTIAL', 'WAIT_FOR_CLIENT',
  'UPDATE_BRIEF', 'APPROVE_BRIEF', 'CONTINUE_SEARCH', 'GENERATE_FINAL', 'APPROVE_FINAL', 'STOP_MARKET_SATURATED',
  'FIX_INFRA', 'INCREASE_BUDGET_REQUIRED', 'NOTHING',
] as const;
export type NextActionKind = (typeof NEXT_ACTIONS)[number];

export interface NextAction {
  action: NextActionKind;
  reason: string;
  /** La commande exacte, quand c'est un humain qui doit la lancer. */
  command: string | null;
  human: boolean;
}

export interface AutopilotContext {
  state: MissionState;
  level: AutopilotLevel;
  since: string;
  history: Array<{ from: MissionState; to: MissionState; reason: string; at: string }>;
  briefKey: string;
  batchSize: number;
  batchesRun: number;
  humanInterventions: number;
  quality: BatchQuality | null;
  qualityHistory: BatchQuality[];
  yieldHistory: SearchYield[];
  saturation: { streak: number; saturated: boolean; reason: string | null };
  /** Le dernier PARTIAL écrit, et combien de retenues il portait : le suivant attend autant de nouvelles. */
  partial: { briefVersion: number; htmlPath: string; generatedAt: string; retained: number } | null;
  final: { briefVersion: number; htmlPath: string; generatedAt: string } | null;
  proposal: BriefProposal | null;
  /** Le nombre de dossiers en revue qu'un humain a déclaré avoir vus : le pilote ne les redemande pas. */
  reviewAcknowledged: number;
  stoppedBecause: string | null;
  lastError: string | null;
}

// ─── Les dépendances ─────────────────────────────────────────────────────────

export interface AutopilotDeps extends ClientMissionDeps {
  /** Le preflight réel — sondes moteurs, modèle, budget. Injectable pour les tests. */
  preflight: (brief: ClientBrief) => Promise<PreflightVerdict>;
  /** Un simple état des moteurs, sans coût, pour décider d'une pause infra après un lot muet. */
  infra: () => Promise<{ readiness: SearchReadiness; detail: string }>;
  writeFile: WriteFile;
  sleep: (ms: number) => Promise<void>;
  scoringModel: ScoringModel;
  executionMode: 'live' | 'simulation';
  notify?: (state: MissionState, message: string) => void;
  /** Le coupe-circuit : Ctrl+C, ou `client:pause`. */
  shouldStop?: () => boolean;
  clock?: () => number;
  /** Refuse un second exécutant sur la même mission ; rend une fonction qui libère. */
  lock?: (runId: string) => (() => void) | null;
}

export interface AutopilotOptions {
  brief?: ClientBrief;
  runId?: string;
  level?: AutopilotLevel;
  /** Sans `go`, rien d'irréversible : ni mission créée, ni recherche, ni appel. */
  go?: boolean;
  runBudgetUsd?: number;
  batchBudgetUsd?: number;
  dailyBudgetUsd?: number;
  concurrency?: number;
  cache?: boolean;
  limits?: Partial<AutopilotLimits>;
  createdBy?: string;
  /** Le retour du client, tel quel : produit une proposition, jamais un brief. */
  feedback?: string;
  /** Applique la proposition en attente — le geste humain d'approbation. */
  approveBrief?: boolean;
  /** Déclare la revue faite : le pilote peut reprendre. */
  reviewDone?: boolean;
  /** Prépare le rapport FINAL — après revue humaine. */
  final?: boolean;
  /** Clôt la mission une fois le rapport approuvé pour livraison. */
  complete?: boolean;
  /** Relève le plafond après une pause budget : un geste humain, tracé. */
  raiseBudget?: boolean;
}

export interface AutopilotOutcome {
  runId: string | null;
  state: MissionState;
  nextAction: NextAction;
  batchesRun: number;
  summaries: BatchSummary[];
  messages: string[];
  estimate: MissionEstimate | null;
  preflight: PreflightVerdict | null;
  created: boolean;
  dryRun: boolean;
}

// ─── L'estimation avant lancement ────────────────────────────────────────────

export interface MissionEstimate {
  maxCandidates: number;
  batchSize: number;
  expectedBatches: number;
  machineMinutes: [number, number];
  humanReviewMinutes: [number, number];
  aiCostUsd: [number, number];
  hardBudgetUsd: number;
}

/**
 * Ce que la mission devrait coûter, d'après les lots réels mesurés : 2,5 s
 * et 0,003–0,006 $ par candidat, un quart des candidats en revue à une
 * minute et demie chacun. Des ordres de grandeur, pas des engagements.
 */
export function estimateMission(brief: ClientBrief, limits: AutopilotLimits, hardBudgetUsd: number): MissionEstimate {
  const maxCandidates = brief.objective.maxCandidates;
  const batchSize = limits.batchSizeDefault;
  const expectedBatches = Math.ceil(maxCandidates / batchSize);
  const machine = maxCandidates * 2.5 + expectedBatches * 8;
  return {
    maxCandidates, batchSize, expectedBatches,
    machineMinutes: [Math.max(1, Math.round(machine / 60 * 0.7)), Math.max(1, Math.round(machine / 60 * 1.5))],
    humanReviewMinutes: [Math.round(maxCandidates * 0.15 * 1.5), Math.round(maxCandidates * 0.35 * 1.5)],
    aiCostUsd: [Math.round(maxCandidates * 0.003 * 100) / 100, Math.round(maxCandidates * 0.006 * 100) / 100],
    hardBudgetUsd,
  };
}

// ─── La qualité d'un lot ─────────────────────────────────────────────────────

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

interface Detail {
  country?: { country?: string | null };
  criteria?: Array<{ kind: string; verdict: string; evidence: Array<unknown> }>;
  generalistRisk?: { score: number };
  contacts?: { method?: string };
  triage?: { status?: string };
}

/**
 * Une note de lot, déterministe, lisible composante par composante.
 *
 * Elle ne juge pas les sociétés — le tri le fait — mais le lot : si trois
 * quarts des dossiers partent en revue, si un tiers des sites sont hors
 * sujet, si personne n'a d'adresse, le brief ou les requêtes sont en cause,
 * et continuer produirait du bruit à prix d'or.
 */
export function assessBatchQuality(batch: BatchSummary, candidates: readonly ClientCandidate[]): BatchQuality | null {
  const traites = candidates.filter((c) => ['RETAINED', 'REVIEW_REQUIRED', 'EXCLUDED', 'FAILED_RETRYABLE', 'FAILED_FINAL'].includes(c.stage));
  // Un ou deux candidats — une reprise, un reliquat — ne font pas un lot à juger.
  if (traites.length < 2) return null;
  const n = traites.length;
  const dossiers = traites.filter((c) => c.stage === 'RETAINED' || c.stage === 'REVIEW_REQUIRED');
  const qualifies = dossiers.filter((c) => Array.isArray((c.detail as Detail).criteria));
  const review = traites.filter((c) => c.stage === 'REVIEW_REQUIRED').length;
  const failed = traites.filter((c) => c.stage === 'FAILED_RETRYABLE' || c.stage === 'FAILED_FINAL').length;
  const faux = traites.filter((c) => c.stage === 'EXCLUDED' && ['DIRECTORY', 'LOW_RELEVANCE', 'WRONG_COUNTRY', 'INSUFFICIENT_EVIDENCE'].includes(c.category ?? '')).length;

  // Sans dossier lu, une composante ne vaut ni 1 ni 0 : elle est inconnue, à mi-chemin.
  const part = (liste: readonly ClientCandidate[], ok: (c: ClientCandidate) => boolean) => (liste.length === 0 ? 0.5 : liste.filter(ok).length / liste.length);
  const requisEtablis = qualifies.length === 0 ? 0.5 : qualifies.reduce((s, c) => {
    const req = ((c.detail as Detail).criteria ?? []).filter((k) => k.kind === 'required');
    return s + (req.length === 0 ? 1 : req.filter((k) => k.verdict === 'ESTABLISHED').length / req.length);
  }, 0) / qualifies.length;
  const risque = dossiers.length === 0 ? 0 : dossiers.reduce((s, c) => s + ((c.detail as Detail).generalistRisk?.score ?? 30), 0) / dossiers.length;

  const components = {
    countryCorroborated: part(dossiers, (c) => Boolean((c.detail as Detail).country?.country)),
    requiredEstablished: requisEtablis,
    reviewRate: 1 - clamp01((review / n) / 0.5),
    errorRate: 1 - clamp01((failed / n) / 0.3),
    falseCandidates: 1 - clamp01((faux / n) / 0.7),
    generalistRisk: 1 - clamp01(risque / 100),
    contactsUsable: part(dossiers, (c) => Boolean((c.detail as Detail).contacts?.method && (c.detail as Detail).contacts?.method !== 'NONE')),
    evidenceSufficient: part(dossiers, (c) => ((c.detail as Detail).criteria ?? []).reduce((s, k) => s + k.evidence.length, 0) >= 2),
  };
  const poids: Record<keyof typeof components, number> = {
    countryCorroborated: 15, requiredEstablished: 20, reviewRate: 20, errorRate: 10, falseCandidates: 10,
    generalistRisk: 5, contactsUsable: 10, evidenceSufficient: 10,
  };
  const score = Math.round((Object.keys(components) as Array<keyof typeof components>).reduce((s, k) => s + components[k] * poids[k], 0));
  return {
    batch: batch.batch, score,
    label: score >= 70 ? 'QUALITY_GOOD' : score >= 40 ? 'QUALITY_WARNING' : 'QUALITY_BAD',
    processed: n, reviewRate: review / n, errorRate: failed / n, falseCandidateRate: faux / n,
    components: Object.fromEntries(Object.entries(components).map(([k, v]) => [k, Math.round(v * 100) / 100])),
  };
}

/** Le rendement d'une recherche : ce qu'elle a apporté de neuf par rapport à ce qu'elle a rendu. */
export function assessSearchYield(batch: BatchSummary, candidates: readonly ClientCandidate[]): SearchYield {
  const m = batch.metrics;
  const raw = m?.search.rawResults ?? batch.rawResults;
  const discovered = batch.discovered;
  const duLot = candidates.filter((c) => c.batch === batch.batch);
  const relevant = duLot.filter((c) => c.stage === 'RETAINED' || c.stage === 'REVIEW_REQUIRED').length;
  const excludedEarly = duLot.filter((c) => c.stage === 'EXCLUDED' && ['DIRECTORY', 'LOW_RELEVANCE', 'WRONG_COUNTRY'].includes(c.category ?? '')).length;
  const y = raw > 0 ? discovered / raw : 0;
  const stopped = m?.search.stoppedBecause ?? null;
  const low = batch.queriesRun > 0 && (discovered <= 2 || y < 0.1 || /sans nouveau candidat/.test(stopped ?? ''));
  return { batch: batch.batch, rawResults: raw, uniqueDomains: m?.search.uniqueDomains ?? 0, discovered, relevant, excludedEarly, yield: Math.round(y * 100) / 100, low, stoppedBecause: stopped };
}

/** La taille du lot suivant, dans les bornes : elle monte quand tout va bien, descend au moindre signe. */
export function adaptBatchSize(current: number, quality: BatchQuality | null, batch: BatchSummary, limits: AutopilotLimits): number {
  const m = batch.metrics;
  const timeouts = m ? m.process.fetchTimeouts / Math.max(1, m.process.candidates) : 0;
  const rateLimited = /rate-limited|sans nouveau candidat/.test(m?.search.stoppedBecause ?? '') && batch.discovered === 0;
  let next = current;
  if (!quality) return Math.max(limits.batchSizeMin, Math.min(limits.batchSizeMax, current));
  if (timeouts > 0.2 || quality.reviewRate > 0.4 || quality.errorRate > 0.2 || rateLimited || quality.label === 'QUALITY_BAD') next = Math.round(current / 2);
  else if (quality.label === 'QUALITY_GOOD' && quality.errorRate < 0.1 && quality.reviewRate < 0.25) next = Math.round(current * 1.5);
  return Math.max(limits.batchSizeMin, Math.min(limits.batchSizeMax, next));
}

// ─── Le contexte persisté ────────────────────────────────────────────────────

export function briefKey(brief: ClientBrief): string {
  return sha256(JSON.stringify({
    client: brief.client.name, internalTest: brief.client.internalTest, market: brief.market.countryLabel,
    roles: brief.targetRoles, keywords: brief.productKeywords,
  }));
}

function nouveauContexte(brief: ClientBrief, level: AutopilotLevel, limits: AutopilotLimits, at: string): AutopilotContext {
  return {
    state: 'DRAFT', level, since: at, history: [], briefKey: briefKey(brief),
    batchSize: limits.batchSizeDefault, batchesRun: 0, humanInterventions: 0,
    quality: null, qualityHistory: [], yieldHistory: [], saturation: { streak: 0, saturated: false, reason: null },
    partial: null, final: null, proposal: null, reviewAcknowledged: 0, stoppedBecause: null, lastError: null,
  };
}

export function readAutopilot(context: ClientRunContext): AutopilotContext | null {
  const ap = context.autopilot as AutopilotContext | undefined;
  return ap && typeof ap.state === 'string' ? ap : null;
}

function saveAutopilot(repos: Repositories, runId: string, ap: AutopilotContext): void {
  // Toujours sur le contexte frais : un lot a pu écrire ses résumés entre-temps.
  const { context } = loadClientRun(repos, runId);
  repos.missions.setContext(runId, { ...context, autopilot: ap } as unknown as Record<string, unknown>);
}

/** Une transition : vérifiée, datée, journalisée dans les événements — auditable après coup. */
export function transition(repos: Repositories, runId: string, ap: AutopilotContext, to: MissionState, reason: string, at: string): AutopilotContext {
  if (!canTransition(ap.state, to)) throw new Error(`transition impossible : ${ap.state} → ${to} (${reason})`);
  if (ap.state === to) return ap;
  const suivant: AutopilotContext = {
    ...ap, state: to, since: at,
    history: [...ap.history, { from: ap.state, to, reason, at }].slice(-200),
  };
  saveAutopilot(repos, runId, suivant);
  repos.events.append({
    id: id('evt'), type: 'mission.progress', severity: HUMAN_STATES.has(to) ? 'warning' : 'info', source: 'client-autopilot',
    missionId: runId, agentKey: null, message: `${ap.state} → ${to} : ${reason}`,
    payload: { from: ap.state, to, reason, level: ap.level }, createdAt: at,
  });
  return suivant;
}

// ─── La prochaine action ─────────────────────────────────────────────────────

export interface MissionSnapshotCounts {
  discovered: number; processed: number; retained: number; excluded: number; review: number; pendingRetry: number; failedFinal: number; pending: number;
}

export function countsFor(candidates: readonly ClientCandidate[]): MissionSnapshotCounts {
  const par = (f: (c: ClientCandidate) => boolean) => candidates.filter(f).length;
  return {
    discovered: candidates.length,
    processed: par((c) => ['RETAINED', 'REVIEW_REQUIRED', 'EXCLUDED', 'FAILED_FINAL'].includes(c.stage)),
    retained: par((c) => c.stage === 'RETAINED'),
    excluded: par((c) => c.stage === 'EXCLUDED'),
    review: par((c) => c.stage === 'REVIEW_REQUIRED'),
    pendingRetry: par((c) => c.stage === 'FAILED_RETRYABLE'),
    failedFinal: par((c) => c.stage === 'FAILED_FINAL'),
    pending: par((c) => ['DISCOVERED', 'FILTERED', 'FETCHED', 'FAILED_RETRYABLE'].includes(c.stage)),
  };
}

/**
 * Une seule prochaine action, déduite de l'état et des comptes. C'est ce que
 * `client:status` affiche, et ce que le pilote exécute quand elle ne demande
 * pas un humain.
 */
export function nextAction(ap: AutopilotContext | null, counts: MissionSnapshotCounts, brief: ClientBrief, runId: string | null, limits: AutopilotLimits): NextAction {
  const run = runId ?? '<run>';
  const cmd = (s: string) => s.replaceAll('<run>', run);
  if (!ap) return { action: 'START_MISSION', reason: 'aucune mission pour ce brief', command: 'npm run client:auto -- --brief=<brief> --go', human: true };
  switch (ap.state) {
    case 'DRAFT':
    case 'PREFLIGHT_REQUIRED':
    case 'READY_TO_START':
      return { action: 'START_MISSION', reason: 'mission prête à partir', command: cmd('npm run client:auto -- --run=<run> --go'), human: ap.level === 0 };
    case 'PAUSED_INFRA':
      return { action: 'FIX_INFRA', reason: ap.stoppedBecause ?? 'aucun moteur de recherche ne répond', command: cmd('npm run searxng:up puis npm run client:auto -- --run=<run> --go'), human: true };
    case 'PAUSED_BUDGET':
      return { action: 'INCREASE_BUDGET_REQUIRED', reason: ap.stoppedBecause ?? 'plafond atteint', command: cmd('npm run client:auto -- --run=<run> --budget=<nouveau plafond> --raise-budget --go'), human: true };
    case 'FAILED':
      return { action: 'FIX_INFRA', reason: ap.lastError ?? 'mission en échec', command: cmd('npm run client:auto -- --run=<run> --go'), human: true };
    case 'HUMAN_REVIEW_REQUIRED':
      return { action: 'REVIEW_CANDIDATES', reason: `${counts.review} dossier(s) à revoir`, command: cmd('npm run client:review -- --run=<run> --interactive'), human: true };
    case 'PARTIAL_READY':
    case 'WAITING_CLIENT_FEEDBACK':
      return { action: 'WAIT_FOR_CLIENT', reason: `rapport PARTIAL prêt${ap.partial ? ` : ${ap.partial.htmlPath}` : ''} — retour client attendu`, command: cmd('npm run client:auto -- --run=<run> --feedback="…"'), human: true };
    case 'BRIEF_UPDATE_REQUIRED':
      return { action: 'APPROVE_BRIEF', reason: 'une proposition de brief attend votre relecture', command: cmd('npm run client:auto -- --run=<run> --approve-brief'), human: true };
    case 'FINAL_REVIEW_REQUIRED':
      return { action: 'GENERATE_FINAL', reason: ap.saturation.saturated ? `marché saturé (${ap.saturation.reason}) — ${counts.retained} retenue(s)` : `objectif atteint — ${counts.retained} retenue(s)`, command: cmd('npm run client:auto -- --run=<run> --final'), human: true };
    case 'FINAL_READY':
      return { action: 'APPROVE_FINAL', reason: `rapport FINAL prêt${ap.final ? ` : ${ap.final.htmlPath}` : ''} — quatre contrôles humains puis clôture`, command: cmd('npm run client:report -- --run=<run> --approve --check=… puis npm run client:auto -- --run=<run> --complete'), human: true };
    case 'COMPLETED':
      return { action: 'NOTHING', reason: 'mission close', command: null, human: false };
    case 'RUNNING_DISCOVERY':
    case 'RUNNING_ANALYSIS':
    case 'RETRYING':
    case 'READY_TO_CONTINUE':
    default: {
      if (ap.saturation.saturated) return { action: 'STOP_MARKET_SATURATED', reason: ap.saturation.reason ?? 'rendement nul', command: cmd('npm run client:auto -- --run=<run> --go'), human: false };
      if (counts.retained >= brief.objective.targetRetained) return { action: 'GENERATE_FINAL', reason: `objectif ${brief.objective.targetRetained} retenue(s) atteint`, command: cmd('npm run client:auto -- --run=<run> --go'), human: false };
      if (counts.discovered >= brief.objective.maxCandidates && counts.pending === 0) return { action: 'GENERATE_FINAL', reason: `${brief.objective.maxCandidates} candidats inspectés`, command: cmd('npm run client:auto -- --run=<run> --go'), human: false };
      if (ap.batchesRun >= limits.maxBatchesTotal) return { action: 'GENERATE_FINAL', reason: `${limits.maxBatchesTotal} lots : plafond de la mission`, command: cmd('npm run client:auto -- --run=<run> --go'), human: false };
      if (counts.pendingRetry > 0 && counts.pending === counts.pendingRetry) return { action: 'RETRY_FAILED', reason: `${counts.pendingRetry} candidat(s) en échec reprenable`, command: cmd('npm run client:auto -- --run=<run> --go'), human: ap.level === 0 };
      if (counts.pending > 0) return { action: 'RUN_NEXT_BATCH', reason: `${counts.pending} candidat(s) en attente`, command: cmd('npm run client:auto -- --run=<run> --go'), human: ap.level === 0 };
      return { action: 'CONTINUE_SEARCH', reason: 'chercher de nouveaux candidats', command: cmd('npm run client:auto -- --run=<run> --go'), human: ap.level === 0 };
    }
  }
}

// ─── Les instantanés et le journal ───────────────────────────────────────────

export function snapshotOf(ap: AutopilotContext, runId: string, brief: ClientBrief, counts: MissionSnapshotCounts, cost: number, next: NextAction, event: string, at: string): Record<string, unknown> {
  return {
    runId, event, timestamp: at, briefVersion: brief.version, client: brief.client.name, internalTest: brief.client.internalTest,
    state: ap.state, level: ap.level, counts, quality: ap.quality, cost: { usd: Math.round(cost * 10_000) / 10_000 },
    performance: { batchesRun: ap.batchesRun, batchSize: ap.batchSize, yields: ap.yieldHistory.map((y) => y.yield), saturation: ap.saturation, humanInterventions: ap.humanInterventions },
    nextAction: next,
  };
}

/**
 * Le journal des décisions : une ligne par société, avec la règle qui a
 * tranché et la preuve. Régénéré à chaque instantané depuis les candidats —
 * la base reste la seule vérité, le journal en est la lecture.
 */
export function decisionJournal(candidates: readonly ClientCandidate[], runId: string): Array<Record<string, unknown>> {
  const regle = (c: ClientCandidate): string => {
    const triage = (c.detail as Detail).triage?.status ?? null;
    if (triage === 'HUMAN_APPROVED' || triage === 'HUMAN_EXCLUDED') return 'human:adjust';
    switch (c.category) {
      case 'DIRECTORY': return 'filter:never-a-candidate';
      case 'COMPETITOR': return 'brief:competitorExclusions';
      case 'WRONG_COUNTRY': return 'country-evidence';
      case 'LOW_RELEVANCE': return triage === 'AUTO_EXCLUDED' && !(c.detail as Detail).criteria ? 'relevance-precheck' : 'client-criteria:required-contradicted';
      case 'EXCLUSION_CRITERION': return 'client-criteria:exclusion';
      case 'TOO_GENERAL': return 'client-criteria:specialisation';
      case 'INSUFFICIENT_EVIDENCE': return 'client-criteria:no-evidence';
      case 'CLIENT_EXCLUDED': return 'human:adjust';
      default: return c.stage === 'RETAINED' ? 'client-triage:auto-approved' : c.stage === 'REVIEW_REQUIRED' ? 'client-triage:human-review' : c.stage.startsWith('FAILED') ? 'fetch:unreachable' : 'pending';
    }
  };
  return candidates
    .filter((c) => !['DISCOVERED', 'FILTERED', 'FETCHED'].includes(c.stage))
    .map((c) => ({
      runId, company: c.name ?? c.domain, domain: c.domain, decision: c.stage,
      triage: (c.detail as Detail).triage?.status ?? null, category: c.category, reason: c.reason,
      evidence: c.evidenceQuote ? { quote: c.evidenceQuote, url: c.evidenceUrl } : null,
      rule: regle(c), model: (c.detail as Detail).criteria ? 'claude-haiku-4-5 (passages relus)' : null,
      briefVersion: c.briefVersion, timestamp: c.updatedAt,
    }));
}

// ─── Le pilote ───────────────────────────────────────────────────────────────

function trouverRun(repos: Repositories, key: string): string | null {
  const { items } = repos.missions.list({ limit: 300, offset: 0 });
  for (const m of items) {
    const ctx = m.context as Partial<ClientRunContext> | undefined;
    if (ctx?.kind !== 'client-mission') continue;
    const ap = ctx.autopilot as AutopilotContext | undefined;
    if (ap?.briefKey === key && ap.state !== 'COMPLETED') return m.id;
  }
  return null;
}

export async function runAutopilot(deps: AutopilotDeps, options: AutopilotOptions): Promise<AutopilotOutcome> {
  const { repos } = deps;
  const now = deps.now ?? nowIso;
  const clock = deps.clock ?? Date.now;
  const limits: AutopilotLimits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const level: AutopilotLevel = options.level ?? 2;
  const messages: string[] = [];
  const dire = (m: string) => { messages.push(m); };
  const runBudget = options.runBudgetUsd ?? CLIENT_BATCH_DEFAULTS.runBudgetUsd;
  const batchBudget = options.batchBudgetUsd ?? CLIENT_BATCH_DEFAULTS.batchBudgetUsd;
  const daily = options.dailyBudgetUsd ?? 0;
  const summaries: BatchSummary[] = [];
  const t0 = clock();

  // ── La mission : existante, ou à créer ────────────────────────────────────
  let runId = options.runId ?? null;
  let brief = options.brief ?? null;
  if (!runId && brief) runId = trouverRun(repos, briefKey(brief));
  if (runId) {
    const charge = loadClientRun(repos, runId);
    if (brief && briefKey(brief) !== briefKey(charge.brief)) {
      throw new Error(`le brief fourni n'est pas celui de la mission ${runId} (${charge.brief.client.name}${charge.brief.client.internalTest ? ', INTERNAL_TEST' : ''}) — une mission ne change pas de client`);
    }
    brief = charge.brief;
  }
  if (!brief) throw new Error('un brief (--brief) ou une mission (--run) est requis');
  if (!brief.client.internalTest && deps.executionMode !== 'live') {
    throw new Error('mode simulation : refus de conduire une mission client réelle. Seul un brief INTERNAL_TEST peut tourner en simulation.');
  }
  const estimate = estimateMission(brief, limits, runBudget);

  const resultat = (state: MissionState, next: NextAction, created = false, dryRun = false, preflight: PreflightVerdict | null = null): AutopilotOutcome =>
    ({ runId, state, nextAction: next, batchesRun: summaries.length, summaries, messages, estimate, preflight, created, dryRun });

  // ── Sans --go : le plan, rien d'autre ─────────────────────────────────────
  if (!options.go && !options.feedback && !options.approveBrief && !options.final && !options.complete && !options.reviewDone) {
    const ap = runId ? readAutopilot(loadClientRun(repos, runId).context) : null;
    const counts = runId ? countsFor(repos.clientCandidates.forRun(runId)) : countsFor([]);
    const next = nextAction(ap, counts, brief, runId, limits);
    dire(runId ? `mission existante ${runId} · état ${ap?.state ?? 'sans pilote'}` : 'aucune mission pour ce brief : --go la créerait après preflight');
    dire(`estimation : ${estimate.maxCandidates} candidats max · ${estimate.expectedBatches} lots de ${estimate.batchSize} · ${estimate.machineMinutes[0]}–${estimate.machineMinutes[1]} min machine · ${estimate.humanReviewMinutes[0]}–${estimate.humanReviewMinutes[1]} min de revue · ${estimate.aiCostUsd[0].toFixed(2)}–${estimate.aiCostUsd[1].toFixed(2)} $ · plafond ${estimate.hardBudgetUsd.toFixed(2)} $`);
    return resultat(ap?.state ?? 'DRAFT', next, false, true);
  }

  // ── Création, ou reprise ──────────────────────────────────────────────────
  let created = false;
  if (!runId) {
    if (!options.go) throw new Error('--go requis pour créer une mission');
    const pf = await deps.preflight(brief);
    if (pf.verdict === 'NO-GO') {
      dire(`preflight NO-GO : ${pf.blocked.join(', ')} — aucune mission créée`);
      return resultat('PREFLIGHT_REQUIRED', { action: pf.readiness === 'SEARCH_BLOCKED' ? 'FIX_INFRA' : 'START_MISSION', reason: `preflight NO-GO : ${pf.blocked.join(', ')}`, command: null, human: true }, false, false, pf);
    }
    runId = createClientRun(repos, brief, options.createdBy ?? 'client-auto');
    created = true;
    let ap = nouveauContexte(brief, level, limits, now());
    saveAutopilot(repos, runId, ap);
    ap = transition(repos, runId, ap, 'PREFLIGHT_REQUIRED', 'mission créée', now());
    ap = transition(repos, runId, ap, 'READY_TO_START', `preflight GO${pf.degraded.length ? ` (dégradé : ${pf.degraded.join(', ')})` : ''}`, now());
    dire(`mission créée ${runId} · niveau ${LEVEL_LABELS[level]}`);
  }

  // ── Un seul exécutant par mission ─────────────────────────────────────────
  const release = deps.lock ? deps.lock(runId) : () => {};
  if (release === null) throw new Error(`un autre exécutant traite déjà la mission ${runId} — refus (client:pause pour l'arrêter, ou attendre)`);

  try {
    let ap = readAutopilot(loadClientRun(repos, runId).context);
    if (!ap) {
      // Une mission conduite à la main jusqu'ici : le pilote la prend où elle est.
      ap = { ...nouveauContexte(brief, level, limits, now()), state: 'READY_TO_CONTINUE', batchesRun: loadClientRun(repos, runId).context.batches.length };
      saveAutopilot(repos, runId, ap);
    }
    if (ap.level !== level) { ap = { ...ap, level }; saveAutopilot(repos, runId, ap); }

    // ── Les gestes humains, chacun une commande — et chacun compté ────────
    const gestes = [options.raiseBudget, options.reviewDone, options.feedback, options.approveBrief, options.final, options.complete].filter(Boolean).length;
    if (gestes > 0) { ap = { ...ap, humanInterventions: ap.humanInterventions + gestes }; saveAutopilot(repos, runId, ap); }
    if (options.raiseBudget && ap.state === 'PAUSED_BUDGET') {
      ap = transition(repos, runId, ap, 'READY_TO_CONTINUE', `plafond relevé à ${runBudget.toFixed(2)} $`, now());
    }
    if (options.reviewDone) {
      const enRevue = countsFor(repos.clientCandidates.forRun(runId)).review;
      ap = { ...ap, reviewAcknowledged: enRevue };
      saveAutopilot(repos, runId, ap);
      if (ap.state === 'HUMAN_REVIEW_REQUIRED') ap = transition(repos, runId, ap, 'READY_TO_CONTINUE', `revue déclarée faite (${enRevue} dossier(s) laissé(s) tels quels)`, now());
    }
    if (options.feedback) {
      if (!['WAITING_CLIENT_FEEDBACK', 'PARTIAL_READY', 'BRIEF_UPDATE_REQUIRED', 'READY_TO_CONTINUE', 'HUMAN_REVIEW_REQUIRED', 'FINAL_REVIEW_REQUIRED'].includes(ap.state)) {
        throw new Error(`un retour client ne s'intègre pas depuis l'état ${ap.state}`);
      }
      const proposal = proposeBriefAdjustment(brief, options.feedback);
      ap = { ...ap, proposal };
      saveAutopilot(repos, runId, ap);
      if (ap.state === 'PARTIAL_READY') ap = transition(repos, runId, ap, 'WAITING_CLIENT_FEEDBACK', 'retour reçu', now());
      if (ap.state !== 'BRIEF_UPDATE_REQUIRED') ap = transition(repos, runId, ap, 'BRIEF_UPDATE_REQUIRED', `retour client reçu : ${proposal.rules.length} règle(s) proposée(s), ${proposal.unmapped.length} phrase(s) à traiter à la main`, now());
      dire(`proposition de brief v${proposal.toVersion} : ${proposal.rules.map((r) => r.change).join(' · ') || 'aucune règle lue'}${proposal.unmapped.length ? ` · non traduit : ${proposal.unmapped.join(' ; ')}` : ''}`);
      dire(`rien n'est appliqué : ${proposal.command} — ou --approve-brief pour appliquer cette proposition telle quelle`);
      await ecrireInstantane(deps, repos, runId, ap, brief, 'feedback', now, limits);
      return resultat(ap.state, nextAction(ap, countsFor(repos.clientCandidates.forRun(runId)), brief, runId, limits));
    }
    if (options.approveBrief) {
      if (ap.state !== 'BRIEF_UPDATE_REQUIRED' || !ap.proposal) throw new Error('aucune proposition de brief en attente d’approbation');
      const p = ap.proposal;
      const suivant = adjustClientRun(repos, runId, {
        keepDomains: p.adjustment.keepDomains, excludeDomains: p.adjustment.excludeDomains,
        addCompetitors: p.adjustment.addCompetitors, addKeywords: p.adjustment.addKeywords,
        ...(p.adjustment.preferSpecialist !== undefined ? { preferSpecialist: p.adjustment.preferSpecialist } : {}),
        notes: p.adjustment.notes,
      });
      brief = suivant;
      ap = { ...ap, proposal: null };
      saveAutopilot(repos, runId, ap);
      ap = transition(repos, runId, ap, 'READY_TO_CONTINUE', `brief v${suivant.version} approuvé et appliqué`, now());
      dire(`brief v${suivant.version} appliqué — le travail des versions précédentes est intact${p.adjustment.reweight.length ? ` · poids à modifier à la main : ${p.adjustment.reweight.map((r) => `${r.key} ${r.from}→${r.to}`).join(', ')}` : ''}`);
      await ecrireInstantane(deps, repos, runId, ap, brief, 'brief', now, limits);
      if (!options.go) return resultat(ap.state, nextAction(ap, countsFor(repos.clientCandidates.forRun(runId)), brief, runId, limits));
    }
    if (options.final) {
      if (!['FINAL_REVIEW_REQUIRED', 'READY_TO_CONTINUE', 'HUMAN_REVIEW_REQUIRED', 'WAITING_CLIENT_FEEDBACK'].includes(ap.state)) throw new Error(`un rapport FINAL ne se prépare pas depuis l'état ${ap.state}`);
      const counts = countsFor(repos.clientCandidates.forRun(runId));
      if (counts.pendingRetry > 0 || counts.pending > 0) dire(`${counts.pending} candidat(s) encore en attente : ils ne sont pas dans le rapport`);
      const files = writeClientReportFiles(repos, runId, { status: 'FINAL', generatedAt: now(), scoringModel: deps.scoringModel, executionMode: deps.executionMode, submit: true }, deps.writeFile);
      ap = { ...ap, final: { briefVersion: brief.version, htmlPath: files.htmlPath, generatedAt: now() } };
      saveAutopilot(repos, runId, ap);
      if (ap.state !== 'FINAL_REVIEW_REQUIRED') ap = transition(repos, runId, ap, 'FINAL_REVIEW_REQUIRED', 'rapport final demandé', now());
      ap = transition(repos, runId, ap, 'FINAL_READY', `rapport FINAL écrit : ${files.htmlPath} (${files.built.retained.length} retenue(s)${counts.retained < brief.objective.targetRetainedMin ? `, sous l'objectif minimal de ${brief.objective.targetRetainedMin}` : ''})`, now());
      dire(`FINAL_READY — ${files.htmlPath} · ${files.csvPath} · ${files.exclusionsPath} — rien n'est envoyé`);
      deps.notify?.('FINAL_READY', files.htmlPath);
      await ecrireInstantane(deps, repos, runId, ap, brief, 'final', now, limits);
      return resultat(ap.state, nextAction(ap, counts, brief, runId, limits));
    }
    if (options.complete) {
      if (ap.state !== 'FINAL_READY') throw new Error(`la mission ne se clôt que depuis FINAL_READY (état : ${ap.state})`);
      ap = transition(repos, runId, ap, 'COMPLETED', 'mission close par le fondateur', now());
      await ecrireInstantane(deps, repos, runId, ap, brief, 'completed', now, limits);
      return resultat(ap.state, nextAction(ap, countsFor(repos.clientCandidates.forRun(runId)), brief, runId, limits));
    }
    if (!options.go) return resultat(ap.state, nextAction(ap, countsFor(repos.clientCandidates.forRun(runId)), brief, runId, limits));

    // ── Reprise : preflight d'abord si la mission était en pause ──────────
    if (['PAUSED_INFRA', 'PAUSED_BUDGET', 'FAILED', 'PREFLIGHT_REQUIRED'].includes(ap.state) || (ap.state === 'READY_TO_CONTINUE' && !created)) {
      if (ap.state !== 'PREFLIGHT_REQUIRED') ap = transition(repos, runId, ap, 'PREFLIGHT_REQUIRED', 'reprise : preflight', now());
      const pf = await deps.preflight(brief);
      if (pf.verdict === 'NO-GO') {
        const infra = pf.readiness === 'SEARCH_BLOCKED' || pf.blocked.some((b) => /recherche|modèle|base|mode|marché/.test(b));
        const budget = pf.blocked.includes('budget');
        ap = { ...ap, stoppedBecause: `preflight NO-GO : ${pf.blocked.join(', ')}` };
        ap = transition(repos, runId, ap, budget && !infra ? 'PAUSED_BUDGET' : infra ? 'PAUSED_INFRA' : 'FAILED', ap.stoppedBecause!, now());
        deps.notify?.(ap.state, ap.stoppedBecause!);
        await ecrireInstantane(deps, repos, runId, ap, brief, 'preflight', now, limits);
        return resultat(ap.state, nextAction(ap, countsFor(repos.clientCandidates.forRun(runId)), brief, runId, limits), created, false, pf);
      }
      ap = transition(repos, runId, ap, created ? 'READY_TO_START' : 'READY_TO_CONTINUE', `preflight GO${pf.degraded.length ? ` (dégradé : ${pf.degraded.join(', ')})` : ''}`, now());
    }
    if (level === 0) {
      dire('niveau MANUAL : le pilote ne lance rien ; il recommande');
      return resultat(ap.state, nextAction(ap, countsFor(repos.clientCandidates.forRun(runId)), brief, runId, limits), created);
    }

    // ── La boucle : tant que la prochaine action n'exige pas un humain ────
    let lotsCeLancement = 0;
    for (;;) {
      if (deps.shouldStop?.()) {
        ap = transition(repos, runId, ap, 'READY_TO_CONTINUE', 'arrêt demandé', now());
        dire('arrêt demandé : état sauvegardé, reprise par --go');
        break;
      }
      if (lotsCeLancement >= limits.maxBatchesPerInvocation) { dire(`${limits.maxBatchesPerInvocation} lots dans ce lancement : le pilote rend la main (relancer pour continuer)`); break; }
      if (clock() - t0 > limits.maxDurationMs) { dire('durée maximale du lancement atteinte : le pilote rend la main'); break; }
      const tous = repos.clientCandidates.forRun(runId);
      const counts = countsFor(tous);
      const next = nextAction(ap, counts, brief, runId, limits);
      if (next.human) break;
      if (level === 1) { dire(`niveau ASSISTED : prochaine action ${next.action} — ${next.reason}`); break; }

      if (next.action === 'GENERATE_FINAL' || next.action === 'STOP_MARKET_SATURATED') {
        if (counts.review > (ap.reviewAcknowledged ?? 0) && level < 3) {
          ap = transition(repos, runId, ap, 'HUMAN_REVIEW_REQUIRED', `${next.reason} — ${counts.review} dossier(s) à revoir avant le rapport final`, now());
        } else {
          ap = transition(repos, runId, ap, 'FINAL_REVIEW_REQUIRED', next.reason, now());
        }
        deps.notify?.(ap.state, next.reason);
        await ecrireInstantane(deps, repos, runId, ap, brief, 'stop', now, limits);
        break;
      }

      // Un lot.
      const reprise = next.action === 'RETRY_FAILED';
      if (reprise) {
        const tentatives = Math.max(1, ...tous.filter((c) => c.stage === 'FAILED_RETRYABLE').map((c) => c.attempts));
        ap = transition(repos, runId, ap, 'RETRYING', `${counts.pendingRetry} reprise(s), attente ${limits.retryBackoffMs * tentatives} ms`, now());
        await deps.sleep(limits.retryBackoffMs * tentatives);
      } else {
        ap = transition(repos, runId, ap, 'RUNNING_DISCOVERY', `lot de ${ap.batchSize}`, now());
      }
      let summary: BatchSummary;
      try {
        summary = await runClientBatch(deps, {
          runId, batchSize: ap.batchSize, maxQueries: limits.maxQueriesPerBatch, runBudgetUsd: runBudget, batchBudgetUsd: batchBudget, dailyBudgetUsd: daily,
          resumeOnly: reprise, concurrency: options.concurrency, cache: options.cache ?? true, createdBy: 'client-auto',
          shouldStop: deps.shouldStop,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ap = { ...ap, lastError: message };
        ap = transition(repos, runId, ap, 'FAILED', `lot en erreur : ${message.slice(0, 160)}`, now());
        deps.notify?.('FAILED', message);
        await ecrireInstantane(deps, repos, runId, ap, brief, 'error', now, limits);
        break;
      }
      summaries.push(summary);
      lotsCeLancement += 1;
      if (ap.state === 'RUNNING_DISCOVERY') ap = transition(repos, runId, ap, 'RUNNING_ANALYSIS', `${summary.processed} traité(s)`, now());
      else if (ap.state === 'RETRYING') ap = transition(repos, runId, ap, 'RUNNING_ANALYSIS', `${summary.processed} repris`, now());

      // Mesures, tri, taille suivante.
      const apres = repos.clientCandidates.forRun(runId);
      const duLot = apres.filter((c) => c.updatedAt >= summary.startedAt && !['DISCOVERED', 'FILTERED', 'FETCHED'].includes(c.stage));
      const quality = assessBatchQuality(summary, duLot);
      const y = assessSearchYield(summary, apres);
      const streak = reprise ? ap.saturation.streak : y.low ? ap.saturation.streak + 1 : 0;
      const saturated = streak >= limits.lowYieldStreak && countsFor(apres).pending === 0;
      ap = {
        ...ap, batchesRun: ap.batchesRun + 1,
        batchSize: adaptBatchSize(ap.batchSize, quality, summary, limits),
        quality: quality ?? ap.quality, qualityHistory: [...ap.qualityHistory, ...(quality ? [quality] : [])].slice(-50),
        yieldHistory: reprise ? ap.yieldHistory : [...ap.yieldHistory, y].slice(-50),
        saturation: { streak, saturated, reason: saturated ? `${streak} lots de suite à rendement très faible` : null },
        stoppedBecause: summary.stoppedBecause,
      };
      saveAutopilot(repos, runId, ap);
      const c2 = countsFor(apres);
      dire(`lot #${summary.batch} : ${summary.processed} traité(s) · ${summary.retained} retenu(s) · ${summary.reviewRequired} à revoir · ${summary.excluded} écarté(s) · ${summary.failed} en échec · ${summary.costUsd.toFixed(4)} $ · qualité ${quality ? `${quality.label} (${quality.score})` : '—'} · rendement ${y.yield}${y.low ? ' (faible)' : ''} · lot suivant ${ap.batchSize}`);

      // Ce qui arrête, dans l'ordre : le budget, l'infra, la qualité, la revue, le partial.
      if (summary.stoppedBecause && /plafond/.test(summary.stoppedBecause)) {
        ap = transition(repos, runId, ap, 'PAUSED_BUDGET', summary.stoppedBecause, now());
        deps.notify?.('PAUSED_BUDGET', summary.stoppedBecause);
        await ecrireInstantane(deps, repos, runId, ap, brief, 'batch', now, limits);
        break;
      }
      if (summary.stoppedBecause === 'arrêt demandé') {
        ap = transition(repos, runId, ap, 'READY_TO_CONTINUE', 'arrêt demandé pendant le lot', now());
        await ecrireInstantane(deps, repos, runId, ap, brief, 'batch', now, limits);
        dire('arrêt demandé : lot interrompu proprement, reprise par --go');
        break;
      }
      if (!reprise && summary.discovered === 0 && summary.rawResults === 0) {
        const infra = await deps.infra();
        if (infra.readiness === 'SEARCH_BLOCKED') {
          ap = { ...ap, stoppedBecause: `aucun moteur ne répond : ${infra.detail}` };
          ap = transition(repos, runId, ap, 'PAUSED_INFRA', ap.stoppedBecause!, now());
          deps.notify?.('PAUSED_INFRA', infra.detail);
          await ecrireInstantane(deps, repos, runId, ap, brief, 'batch', now, limits);
          break;
        }
      }
      await ecrireInstantane(deps, repos, runId, ap, brief, 'batch', now, limits);

      const tauxRevue = quality?.reviewRate ?? 0;
      const seuilRevue = level >= 3 ? limits.criticalReviewRate : limits.reviewPauseRate;
      const revueLourde = (summary.processed >= 5 && tauxRevue > seuilRevue) || (level < 3 && c2.review - (ap.reviewAcknowledged ?? 0) >= limits.reviewPauseCount);
      /*
       * Un PARTIAL quand assez de retenues sont là ; le suivant seulement
       * quand autant de nouvelles se sont ajoutées — pas à chaque lot, sinon
       * le client recevrait une liste par jour.
       */
      const partialPossible = c2.retained >= limits.partialAtRetained
        && (!ap.partial || c2.retained >= ap.partial.retained + limits.partialAtRetained)
        && quality?.label !== 'QUALITY_BAD';
      if (partialPossible) {
        const files = writeClientReportFiles(repos, runId, { status: 'PARTIAL', generatedAt: now(), scoringModel: deps.scoringModel, executionMode: deps.executionMode }, deps.writeFile);
        ap = { ...ap, partial: { briefVersion: brief.version, htmlPath: files.htmlPath, generatedAt: now(), retained: c2.retained } };
        saveAutopilot(repos, runId, ap);
        ap = transition(repos, runId, ap, 'PARTIAL_READY', `${c2.retained} retenue(s) : rapport PARTIAL écrit — ${files.htmlPath}`, now());
        ap = transition(repos, runId, ap, 'WAITING_CLIENT_FEEDBACK', 'retour client attendu — aucune dépense en attendant', now());
        dire(`PARTIAL_READY — ${files.htmlPath}${files.reviewPath ? ` · revue interne : ${files.reviewPath}` : ''} — rien n'est envoyé`);
        deps.notify?.('PARTIAL_READY', files.htmlPath);
        await ecrireInstantane(deps, repos, runId, ap, brief, 'partial', now, limits);
        break;
      }
      if (quality?.label === 'QUALITY_BAD') {
        ap = transition(repos, runId, ap, 'HUMAN_REVIEW_REQUIRED', `qualité du lot ${quality.score}/100 : brief, requêtes ou marché à revoir avant de continuer`, now());
        deps.notify?.('HUMAN_REVIEW_REQUIRED', `qualité ${quality.score}/100`);
        break;
      }
      if (revueLourde) {
        ap = transition(repos, runId, ap, 'HUMAN_REVIEW_REQUIRED', `${c2.review} dossier(s) à revoir (${Math.round(tauxRevue * 100)} % du lot)`, now());
        deps.notify?.('HUMAN_REVIEW_REQUIRED', `${c2.review} dossiers`);
        break;
      }
      ap = transition(repos, runId, ap, 'READY_TO_CONTINUE', 'lot terminé, conditions réunies', now());
    }

    const counts = countsFor(repos.clientCandidates.forRun(runId));
    const next = nextAction(ap, counts, brief, runId, limits);
    await ecrireInstantane(deps, repos, runId, ap, brief, 'end', now, limits);
    return resultat(ap.state, next, created);
  } finally {
    release();
  }
}

async function ecrireInstantane(deps: AutopilotDeps, repos: Repositories, runId: string, ap: AutopilotContext, brief: ClientBrief, event: string, now: () => string, limits: AutopilotLimits): Promise<void> {
  const candidates = repos.clientCandidates.forRun(runId);
  const counts = countsFor(candidates);
  const cost = spendSoFar(repos, { runId, batchStartedAt: '1970-01-01T00:00:00.000Z' }, now()).run;
  const at = now();
  const stamp = at.slice(0, 19).replace(/[:T]/g, '-');
  deps.writeFile(`client/${runId}/snapshots/${stamp}-${event}.json`, JSON.stringify(snapshotOf(ap, runId, brief, counts, cost, nextAction(ap, counts, brief, runId, limits), event, at), null, 2));
  const journal = decisionJournal(candidates, runId);
  deps.writeFile(`client/${runId}/decisions.jsonl`, journal.map((l) => JSON.stringify(l)).join('\n'));
}

// ─── Les mesures d'une mission entière ───────────────────────────────────────

export interface MissionMetrics {
  discovered: number; processed: number; retained: number; excluded: number; reviewed: number; failed: number;
  searchQueries: number; uniqueDomains: number; yield: number;
  pagesNetwork: number; cacheHits: number;
  llmCalls: number; tokens: number; costUsd: number;
  machineSeconds: number; humanActions: number;
  qualityScore: number | null;
  batches: number;
}

export function missionMetrics(context: ClientRunContext, candidates: readonly ClientCandidate[], costUsd: number): MissionMetrics {
  const counts = countsFor(candidates);
  const ap = readAutopilot(context);
  const batches = context.batches;
  const m = batches.map((b) => b.metrics).filter((x): x is NonNullable<typeof x> => Boolean(x));
  const sum = (f: (x: (typeof m)[number]) => number) => m.reduce((s, x) => s + f(x), 0);
  const raw = batches.reduce((s, b) => s + b.rawResults, 0);
  const discovered = batches.reduce((s, b) => s + b.discovered, 0);
  const qualities = ap?.qualityHistory ?? [];
  return {
    discovered: counts.discovered, processed: counts.processed, retained: counts.retained, excluded: counts.excluded,
    reviewed: counts.review, failed: counts.failedFinal + counts.pendingRetry,
    searchQueries: batches.reduce((s, b) => s + b.queriesRun, 0), uniqueDomains: sum((x) => x.search.uniqueDomains),
    yield: raw > 0 ? Math.round((discovered / raw) * 100) / 100 : 0,
    pagesNetwork: sum((x) => x.process.pagesFetched), cacheHits: sum((x) => x.process.cacheHits),
    llmCalls: sum((x) => x.process.llmCalls), tokens: sum((x) => x.process.inputTokens + x.process.outputTokens), costUsd,
    machineSeconds: Math.round(sum((x) => x.timing.batchMs) / 1000),
    humanActions: ap?.humanInterventions ?? 0,
    qualityScore: qualities.length ? Math.round(qualities.reduce((s, q) => s + q.score, 0) / qualities.length) : null,
    batches: batches.length,
  };
}
