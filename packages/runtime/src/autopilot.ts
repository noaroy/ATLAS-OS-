import { createHash } from 'node:crypto';
import type { AtlasConfig, Logger } from '@atlas/core';
import { checkBudget } from '@atlas/core';
import type { Repositories, TaskRow, AutopilotAction, AutopilotCycle, AutopilotActionStatus } from '@atlas/data';
import { buildSalesDashboard } from './sales-dashboard.ts';
import { collectNeedsYou, todaySnapshot } from './needs-you.ts';
import { readGlobalPause, SALES_ENGINE_TASKS } from './sales-engine.ts';
import { routeTask, type RouteTarget } from './hermes-router.ts';
import { inspectRepo } from './workspace.ts';
import { softwareLoopStatus, externalRunnerAlive, type SoftwareLoopStatus } from './software-loop.ts';
import type { WorkerContext, WorkerOutcome } from './workers.ts';
import { prospectExpansionSource } from './expansion/autopilot-source.ts';

/**
 * L'Autopilot : la boucle de contrôle d'ATLAS.
 *
 *   OBSERVER → DIAGNOSTIQUER → PROPOSER → PRIORISER → CONFIER → VÉRIFIER
 *   → APPRENDRE → dormir, et recommencer.
 *
 * Le but est une machine à revenu qui tourne seule ; la mesure est
 * « € générés / € investis / heure de fondateur ». Ce fichier ne contient
 * donc pas un moteur de plus, mais le plan de contrôle des moteurs existants :
 * il lit l'état réel (prospects, registre, conversations, recommandations,
 * missions, file de tâches, ingénierie, fournisseurs, dépense, santé), en tire
 * des occasions d'agir, les classe par valeur commerciale, confie aux workers
 * ce qui est sûr et ne laisse au fondateur que ce qui exige une personne.
 *
 * Trois principes tiennent tout :
 *
 *   · déterministe et explicable — le score est une formule, pas un modèle ;
 *     chaque cycle écrit ce qu'il a vu, considéré, décidé, créé, exécuté ;
 *   · fermé par défaut — un fournisseur absent, un budget épuisé, un type de
 *     tâche hors de la liste sûre, une porte (envoi, paiement, déploiement,
 *     base, sécurité) : l'action reste BLOCKED ou WAITING_HUMAN, jamais
 *     « à peu près » exécutée ;
 *   · « l'absence de problème n'est pas une raison d'arrêter de s'améliorer »
 *     — sans blocage, on cherche du revenu, de la conversion, de l'expansion,
 *     des expériences mesurables — mais jamais du travail pour remplir la file.
 *
 * Ce que l'Autopilot ne fait jamais seul : envoyer une première campagne
 * externe, lever l'interrupteur d'envoi, payer, détruire des données de
 * production, changer une politique de sécurité ou un secret, augmenter
 * un budget, déployer, engager ATLAS vis-à-vis d'un tiers.
 */

// ─── Le vocabulaire ──────────────────────────────────────────────────────────

export type AutopilotCategory =
  | 'REVENUE'        // une occasion directe de revenu
  | 'BLOCKED_WORK'   // ventes, réponses, dossiers client bloqués
  | 'DISCOVERY'      // découverte de prospects à forte valeur
  | 'CONVERSION'     // améliorer la conversion
  | 'RELIABILITY'    // produit / fiabilité, quand cela bloque le revenu
  | 'OPTIMIZATION'   // expériences mesurables
  | 'EXPLORATION';   // exploration

export type Allocation = 'EXPLOIT' | 'OPTIMIZE' | 'EXPLORE';
export type ValueBand = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'DIRECT_REVENUE';
export type Urgency = 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
export type RiskBand = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
export type Reversibility = 'REVERSIBLE' | 'PARTIAL' | 'IRREVERSIBLE';

/** Les portes qui exigent une personne, quoi que dise le reste de la proposition. */
export type HumanGate =
  | 'EXTERNAL_OUTBOUND'
  | 'OUTBOUND_ACTIVATION'
  | 'PAYMENT'
  | 'PRODUCTION_DEPLOYMENT'
  | 'DESTRUCTIVE_DB'
  | 'SECURITY_POLICY'
  | 'SECRET_CHANGE'
  | 'BUDGET_INCREASE'
  | 'BINDING_COMMITMENT';

export const HUMAN_GATES: readonly HumanGate[] = [
  'EXTERNAL_OUTBOUND', 'OUTBOUND_ACTIVATION', 'PAYMENT', 'PRODUCTION_DEPLOYMENT', 'DESTRUCTIVE_DB',
  'SECURITY_POLICY', 'SECRET_CHANGE', 'BUDGET_INCREASE', 'BINDING_COMMITMENT',
];

export type AutopilotExecution =
  /** Une tâche de la file existante, servie par les workers existants sous leurs gardes. */
  | { kind: 'INTERNAL_TASK'; taskType: string; department: string; payload?: Record<string, unknown>; priority?: number }
  /** Une décision que seule une personne prend ; la commande est ce qu'elle tapera. */
  | { kind: 'FOUNDER_DECISION'; command: string }
  | { kind: 'NONE' };

export interface AutopilotProposal {
  objective: string;
  category: AutopilotCategory;
  expectedBusinessValue: ValueBand;
  expectedCostUsd: number;
  expectedFounderTimeMinutes: number;
  /** 0 à 1. */
  confidence: number;
  urgency: Urgency;
  /** Les faits qui portent la proposition — jamais une métrique inventée. */
  evidence: string[];
  risk: RiskBand;
  reversibility: Reversibility;
  recommendedAgent: RouteTarget;
  requiresHumanApproval: boolean;
  reason: string;
  execution: AutopilotExecution;
  gate?: HumanGate;
  /** D'où vient la proposition : un moteur qui publie dans l'Autopilot se nomme. */
  source?: string;
  /** La matière de l'empreinte ; par défaut, catégorie + objectif. */
  fingerprintKey?: string;
}

export interface AutopilotDecision {
  objective: string;
  category: AutopilotCategory;
  score: number;
  decision:
    | 'CREATED'            // une action ouverte, nouvelle
    | 'DUPLICATE'          // la même action existe déjà, non résolue
    | 'RESUMED'            // une action bloquée ou reportée, reprise : confiée maintenant
    | 'STILL_BLOCKED'      // réévaluée, toujours bloquée — motif rafraîchi
    | 'DONE_RECENTLY'      // la même action vient d'être résolue
    | 'NOT_WORTH_IT'       // la valeur ne justifie pas la dépense
    | 'CAP_REACHED';       // le plafond d'actions ouvertes est atteint
  reason: string;
  actionId?: string;
}

// ─── L'observation ───────────────────────────────────────────────────────────

export interface ProviderReadiness {
  ready: boolean;
  detail: string;
  /** READY : a répondu récemment · STALE : vérifié il y a longtemps · CONFIGURED : clé présente, jamais vérifié · BLOCKED · ABSENT. */
  state?: string;
}

export interface AutopilotObservation {
  at: string;
  outbound: { enabled: boolean; engineMode: 'INTERNAL_TEST' | 'PRODUCTION'; paused: boolean; pauseReason: string | null };
  sales: {
    discovered: number; qualified: number; contacted: number; replies: number; positiveReplies: number;
    hotLeadsOpen: number; followUpsDue: number; draftsAwaitingApproval: number; recommendationsProposed: number;
    segments: number; segmentsToApprove: number; meetings: number; clientsSigned: number; revenueSigned: number;
    pipelinePotential: number | null; openInsights: number;
  };
  conversations: { awaitingReply: number };
  missions: { total: number };
  queue: { byStatus: Record<string, number>; waitingHuman: number; failedRecent: number };
  engineering: { readyForReview: number; approvedToApply: number; repoClean: boolean | null };
  providers: Record<'DETERMINISTIC' | 'OPENAI' | 'CLAUDE' | 'CLAUDE_CODE' | 'DETERMINISTIC_EXTERNAL' | 'SEARCH', ProviderReadiness>;
  spend: {
    todayUsd: number | null; unknownCalls: number;
    dailyLimitUsd: number | null; mode: 'UNLIMITED' | 'CONFIGURED' | 'DISABLED'; remainingUsd: number | null;
    salesDailyBudgetUsd: number; salesSpentTodayUsd: number; salesRemainingUsd: number;
  };
  health: { gmail: string; gmailDetail: string; daemon: string; llm: string; search: string; database: string };
  failures: Record<string, number>;
  pendingHuman: { total: number; byKind: Record<string, number> };
  /** La boucle logicielle, pièce par pièce. */
  softwareLoop: SoftwareLoopStatus | null;
  /** Ce qu'on n'a pas pu mesurer, dit tel quel — jamais remplacé par zéro. */
  absent: string[];
}

export interface ObserveOptions {
  now?: Date;
  cwd?: string;
  /** Les fournisseurs, quand l'appelant les connaît mieux (tests, contexte conteneur). Aucune sonde n'est alors jouée. */
  providers?: Partial<AutopilotObservation['providers']>;
  /** Vrai par défaut : sonder Claude Code coûte un `--version`. */
  probeClaudeCode?: boolean;
  /** Vrai par défaut : sonder les fournisseurs de modèle si la dernière sonde est ancienne (gratuit, six heures). */
  verifyProviders?: boolean;
}

/**
 * Les fournisseurs, avec le sens réel de « prêt ».
 *
 * Un modèle est prêt quand il a *répondu* — à une sonde gratuite ou à un
 * vrai appel — et pas seulement quand sa clé existe. Claude Code et le dépôt
 * sont jugés là où ils vivent : ici en mode intégré, dans le runner isolé en
 * mode externe. Des fournisseurs fournis par l'appelant remplacent tout cela
 * sans sonde : c'est le cas des tests.
 */
/**
 * Déterministe, mais qui a besoin du dépôt complet et de `tsx` (voir
 * `EXTERNAL_TOOLS_WORKER_TYPES`) : en ingénierie intégrée, ce processus les a
 * déjà — comme pour `DETERMINISTIC`. En externe, c'est `atlas-engineer` qui
 * les sert, sous le même nom d'hôte que `CLAUDE_CODE` : sa vivacité est donc
 * le même signal.
 */
function deterministicExternalReadiness(repos: Repositories, config: AtlasConfig, now: Date): ProviderReadiness {
  if (config.engineering.runner === 'embedded') {
    return { ready: true, detail: 'workers déterministes (dépôt complet, intégré)', state: 'READY' };
  }
  const alive = externalRunnerAlive(repos, now);
  return { ready: alive.alive, detail: alive.detail, state: alive.alive ? 'READY' : 'ABSENT' };
}

async function providerReadiness(repos: Repositories, config: AtlasConfig, now: Date, options: ObserveOptions): Promise<{ providers: AutopilotObservation['providers']; softwareLoop: SoftwareLoopStatus | null }> {
  const search: ProviderReadiness = config.search.provider === 'none'
    ? { ready: false, detail: 'aucun moteur de recherche configuré', state: 'ABSENT' }
    : { ready: true, detail: `recherche : ${config.search.provider}`, state: 'CONFIGURED' };
  const deterministicExternal = deterministicExternalReadiness(repos, config, now);
  const injected = options.providers ?? {};
  const complete = ['OPENAI', 'CLAUDE', 'CLAUDE_CODE'].every((k) => k in injected);
  if (complete) {
    return {
      providers: {
        DETERMINISTIC: { ready: true, detail: 'workers déterministes', state: 'READY' },
        OPENAI: injected.OPENAI!, CLAUDE: injected.CLAUDE!, CLAUDE_CODE: injected.CLAUDE_CODE!,
        DETERMINISTIC_EXTERNAL: injected.DETERMINISTIC_EXTERNAL ?? deterministicExternal,
        SEARCH: injected.SEARCH ?? search,
      },
      softwareLoop: null,
    };
  }
  const loop = await softwareLoopStatus(repos, config, { now, cwd: options.cwd, verifyProviders: options.verifyProviders, probeClaudeCode: options.probeClaudeCode });
  return {
    providers: {
      DETERMINISTIC: { ready: true, detail: 'workers déterministes', state: 'READY' },
      OPENAI: { ready: loop.openaiReviewer.ready, detail: loop.openaiReviewer.detail, state: loop.openaiReviewer.state },
      CLAUDE: { ready: loop.claude.ready, detail: loop.claude.detail, state: loop.claude.state },
      CLAUDE_CODE: { ready: loop.claudeCodeRunner.ready, detail: loop.claudeCodeRunner.detail, state: loop.claudeCodeRunner.state },
      DETERMINISTIC_EXTERNAL: deterministicExternal,
      SEARCH: search,
      ...injected,
    },
    softwareLoop: loop,
  };
}

/**
 * Ce qu'ATLAS sait de lui-même, maintenant, sans rien estimer.
 *
 * Chaque chiffre vient d'une table. Ce qui n'est pas mesurable est `null`
 * et nommé dans `absent` — un tableau qui afficherait zéro là où l'on ne sait
 * pas ferait prendre des décisions sur du vide.
 */
export async function observeAtlas(repos: Repositories, config: AtlasConfig, options: ObserveOptions = {}): Promise<AutopilotObservation> {
  const now = options.now ?? new Date();
  const readiness = await providerReadiness(repos, config, now, options);
  const board = buildSalesDashboard(repos, config, { range: '30d', now });
  const today = todaySnapshot(repos, now.toISOString().slice(0, 10));
  const needs = collectNeedsYou({ repos, today: now.toISOString().slice(0, 10) });
  const pause = readGlobalPause(repos);
  const absent: string[] = [];

  const funnel = (stage: string): number => board.funnel.find((f) => f.stage === stage)?.count ?? 0;
  const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const salesSpent = repos.llmCalls.usageSince(dayStart).knownCostUsd;

  const byStatus = repos.tasks.countByStatus();
  const failedRecent = repos.tasks.list({ status: 'FAILED', limit: 50 })
    .filter((t) => t.finishedAt && now.getTime() - Date.parse(t.finishedAt) < 24 * 3_600_000).length;

  // Le dépôt : lu ici en ingénierie intégrée ; porté par le runner isolé en
  // externe — ce processus n'a alors ni git ni dépôt, et ne doit pas les avoir.
  let repoClean: boolean | null = null;
  if (config.engineering.runner === 'external') absent.push('état du dépôt (porté par atlas-engineer)');
  else { try { repoClean = inspectRepo(options.cwd ?? process.cwd()).clean; } catch { absent.push('état du dépôt (git absent)'); } }

  if (today.aiCostUsd === null) absent.push('coût IA du jour (aucun appel au tarif connu)');
  if (board.cards.pipelinePotential === null) absent.push('potentiel de pipeline (échantillon insuffisant)');

  const dailyLimit = config.ai.dailyBudgetMode === 'CONFIGURED' ? config.ai.dailyBudgetUsd : null;
  const frictions = repos.salesEngine.frictionCounts(new Date(now.getTime() - 24 * 3_600_000).toISOString());
  const byKind: Record<string, number> = {};
  for (const item of needs) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;

  return {
    at: now.toISOString(),
    outbound: { enabled: config.sales.outboundEnabled, engineMode: config.sales.engineMode, paused: pause.paused, pauseReason: pause.reason },
    sales: {
      discovered: funnel('discovered'), qualified: funnel('icpQualified'), contacted: funnel('contacted'),
      replies: funnel('replied'), positiveReplies: funnel('positiveReplies'),
      hotLeadsOpen: board.todo.hotLeads, followUpsDue: board.todo.followUps, draftsAwaitingApproval: board.todo.approvals,
      recommendationsProposed: board.todo.recommendations, segments: board.segments.length, segmentsToApprove: board.todo.segmentsToApprove,
      meetings: board.cards.meetings, clientsSigned: board.cards.clientsSigned, revenueSigned: board.cards.revenueSigned,
      pipelinePotential: board.cards.pipelinePotential, openInsights: board.system.openInsights,
    },
    conversations: { awaitingReply: byKind.CLIENT_REPLY ?? 0 },
    missions: { total: repos.missions.list({ limit: 200, offset: 0 }).total },
    queue: { byStatus, waitingHuman: byStatus.WAITING_HUMAN ?? 0, failedRecent },
    engineering: {
      readyForReview: repos.tasks.workspacesInState('READY_FOR_REVIEW').length,
      approvedToApply: repos.tasks.workspacesInState('APPROVED_TO_APPLY').length,
      repoClean,
    },
    providers: readiness.providers,
    spend: {
      todayUsd: today.aiCostUsd, unknownCalls: today.aiCostUnknownCalls,
      dailyLimitUsd: dailyLimit, mode: config.ai.dailyBudgetMode,
      remainingUsd: dailyLimit === null ? null : Math.max(0, dailyLimit - (today.aiCostUsd ?? 0)),
      salesDailyBudgetUsd: config.sales.dailyAiBudgetUsd, salesSpentTodayUsd: salesSpent,
      salesRemainingUsd: Math.max(0, config.sales.dailyAiBudgetUsd - salesSpent),
    },
    health: {
      gmail: board.system.gmail.code, gmailDetail: board.system.gmail.detail, daemon: board.system.workers.state,
      llm: board.system.llm.state, search: board.system.search.state, database: board.system.database.state,
    },
    failures: frictions,
    pendingHuman: { total: needs.length, byKind },
    softwareLoop: readiness.softwareLoop,
    absent,
  };
}

// ─── Le score, déterministe ──────────────────────────────────────────────────

const CATEGORY_BASE: Record<AutopilotCategory, number> = {
  REVENUE: 100, BLOCKED_WORK: 90, DISCOVERY: 70, CONVERSION: 60, RELIABILITY: 50, OPTIMIZATION: 30, EXPLORATION: 10,
};
const VALUE_BONUS: Record<ValueBand, number> = { DIRECT_REVENUE: 40, HIGH: 25, MEDIUM: 12, LOW: 4, NONE: -60 };
const URGENCY_BONUS: Record<Urgency, number> = { CRITICAL: 25, HIGH: 12, NORMAL: 0, LOW: -5 };
const RISK_PENALTY: Record<RiskBand, number> = { NONE: 0, LOW: 3, MEDIUM: 10, HIGH: 25 };
const REVERSIBILITY_PENALTY: Record<Reversibility, number> = { REVERSIBLE: 0, PARTIAL: 5, IRREVERSIBLE: 15 };

export const ALLOCATION_OF: Record<AutopilotCategory, Allocation> = {
  REVENUE: 'EXPLOIT', BLOCKED_WORK: 'EXPLOIT', DISCOVERY: 'EXPLOIT', CONVERSION: 'EXPLOIT',
  RELIABILITY: 'OPTIMIZE', OPTIMIZATION: 'OPTIMIZE', EXPLORATION: 'EXPLORE',
};

/** Les cibles glissantes : 70 % exploiter, 20 % optimiser, 10 % explorer. */
export const ALLOCATION_TARGET: Record<Allocation, number> = { EXPLOIT: 0.7, OPTIMIZE: 0.2, EXPLORE: 0.1 };

/**
 * Le score de base : une formule, lisible, sans modèle.
 *
 * Revenu direct et travail bloqué d'abord, puis découverte, conversion,
 * fiabilité, optimisation, exploration. La valeur attendue et l'urgence
 * montent le score ; le coût, le temps de fondateur, le risque et
 * l'irréversibilité le descendent. Fort impact + faible coût + peu de temps
 * de fondateur gagne — c'est la mesure.
 */
export function priorityScore(p: AutopilotProposal): number {
  const confidence = Math.max(0, Math.min(1, p.confidence));
  const cost = Math.min(20, Math.max(0, p.expectedCostUsd) * 10);
  const founder = Math.min(20, Math.max(0, p.expectedFounderTimeMinutes) / 3);
  const score = CATEGORY_BASE[p.category] + VALUE_BONUS[p.expectedBusinessValue] + URGENCY_BONUS[p.urgency]
    + Math.round(20 * confidence) - cost - founder - RISK_PENALTY[p.risk] - REVERSIBILITY_PENALTY[p.reversibility];
  return Math.round(score * 10) / 10;
}

/**
 * Cela vaut-il la peine ?
 *
 * Pas de précision financière feinte : des paliers. Aucune valeur plausible
 * ne justifie aucune dépense ; une faible valeur ne justifie pas une dépense
 * de modèle ; une confiance quasi nulle non plus.
 */
export function worthDoing(p: AutopilotProposal): { worth: boolean; reason: string } {
  if (p.expectedBusinessValue === 'NONE') return { worth: false, reason: 'aucune valeur commerciale plausible' };
  if (p.expectedBusinessValue === 'LOW' && p.expectedCostUsd > 0.2) return { worth: false, reason: `faible valeur pour ${p.expectedCostUsd.toFixed(2)} $ de modèle` };
  if (p.confidence < 0.2) return { worth: false, reason: 'confiance trop faible pour engager quoi que ce soit' };
  return { worth: true, reason: 'valeur, coût et confiance cohérents' };
}

/**
 * L'ajustement d'allocation, glissant.
 *
 * On ne force pas 70/20/10 à chaque cycle : on regarde ce qui a été créé
 * récemment, et l'on pénalise légèrement une famille qui dépasse sa cible de
 * plus de quinze points, on favorise légèrement une famille en dessous. Une
 * famille sans candidat valable ne reçoit rien : la cible ne fabrique pas
 * de travail.
 */
export function allocationShares(actions: readonly Pick<AutopilotAction, 'allocation'>[]): Record<Allocation, number> {
  const counts: Record<Allocation, number> = { EXPLOIT: 0, OPTIMIZE: 0, EXPLORE: 0 };
  for (const a of actions) if (a.allocation in counts) counts[a.allocation as Allocation] += 1;
  const total = counts.EXPLOIT + counts.OPTIMIZE + counts.EXPLORE;
  if (total === 0) return { EXPLOIT: 0, OPTIMIZE: 0, EXPLORE: 0 };
  return { EXPLOIT: counts.EXPLOIT / total, OPTIMIZE: counts.OPTIMIZE / total, EXPLORE: counts.EXPLORE / total };
}

export function allocationAdjustment(allocation: Allocation, shares: Record<Allocation, number>, sampled: number): number {
  if (sampled < 5) return 0;
  const target = ALLOCATION_TARGET[allocation];
  // Au-dessus de la cible de quinze points : légère pénalité. En dessous de la
  // moitié de la cible : léger bonus — en valeur relative, sinon l'exploration
  // (cible 10 %) ne pourrait jamais être « en dessous ».
  if (shares[allocation] > target + 0.15) return -15;
  if (shares[allocation] < target * 0.5) return 5;
  return 0;
}

export function fingerprintOf(p: Pick<AutopilotProposal, 'category' | 'objective' | 'fingerprintKey'>): string {
  const material = (p.fingerprintKey ?? `${p.category}:${p.objective}`).trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

// ─── La politique d'autonomie ────────────────────────────────────────────────

/**
 * Ce qu'un cycle a le droit de confier sans personne.
 *
 * Une liste fermée de types de tâche, tous servis par les workers existants
 * sous leurs gardes existantes : lecture de boîte, mesures, relances (qui ne
 * font que signaler), découverte (sous budget), analyses, revues, et la
 * chaîne d'ingénierie — dont la fin est un diff en attente d'une personne,
 * jamais un dépôt modifié. `SALES_SEND` n'y figure pas : l'Autopilot ne pose
 * jamais un envoi, même à blanc.
 */
export const SAFE_AUTONOMOUS_TASK_TYPES: readonly string[] = [
  'SALES_REPLY_CHECK', 'SALES_ANALYTICS', 'SALES_FOLLOW_UP', 'SALES_OPTIMIZATION', 'SALES_DISCOVERY', 'PROSPECT_EXPANSION',
  'REPO_ANALYSIS', 'ARCHITECTURE_REVIEW', 'PLANNING', 'COMMERCIAL_ANALYSIS', 'CODE_REVIEW',
  'ENGINEERING_CHANGE', 'BUILD_VALIDATION',
];

export type AutonomyVerdict =
  | { verdict: 'AUTO'; agent: RouteTarget; reason: string }
  | { verdict: 'WAITING_HUMAN'; reason: string }
  | { verdict: 'BLOCKED'; reason: string }
  | { verdict: 'DEFERRED'; reason: string };

export function decideAutonomy(p: AutopilotProposal, ctx: {
  observation: AutopilotObservation;
  config: AtlasConfig;
  cycleSpentUsd: number;
}): AutonomyVerdict {
  if (p.gate) return { verdict: 'WAITING_HUMAN', reason: `porte ${p.gate} : une personne décide, toujours` };
  if (p.requiresHumanApproval) return { verdict: 'WAITING_HUMAN', reason: 'approbation humaine exigée par la proposition' };
  if (p.execution.kind !== 'INTERNAL_TASK') return { verdict: 'WAITING_HUMAN', reason: 'pas de tâche interne : décision du fondateur' };

  const { taskType } = p.execution;
  if (!SAFE_AUTONOMOUS_TASK_TYPES.includes(taskType)) {
    return { verdict: 'WAITING_HUMAN', reason: `${taskType} n'est pas dans la liste des tâches confiables sans personne` };
  }
  const agent = routeTask(taskType).target;
  if (agent === 'HUMAN') return { verdict: 'WAITING_HUMAN', reason: `${taskType} est routé vers une personne` };

  const readiness = ctx.observation.providers[agent];
  if (!readiness?.ready) return { verdict: 'BLOCKED', reason: `fournisseur indisponible — ${readiness?.detail ?? agent}` };

  if (taskType === 'SALES_DISCOVERY') {
    if (!ctx.config.sales.discoveryEnabled) return { verdict: 'BLOCKED', reason: 'découverte désactivée (ATLAS_SALES_DISCOVERY_ENABLED=false)' };
    if (!ctx.observation.providers.SEARCH.ready) return { verdict: 'BLOCKED', reason: `découverte sans moteur — ${ctx.observation.providers.SEARCH.detail}` };
    if (!ctx.config.ai.live) return { verdict: 'BLOCKED', reason: 'découverte sans modèle vivant (ATLAS_AI_LIVE=false)' };
    if (ctx.observation.spend.salesRemainingUsd < 0.05) return { verdict: 'BLOCKED', reason: `budget IA commercial du jour épuisé (${ctx.observation.spend.salesSpentTodayUsd.toFixed(2)} $ / ${ctx.observation.spend.salesDailyBudgetUsd.toFixed(2)} $)` };
  }
  if (taskType.startsWith('SALES_') && ctx.observation.outbound.paused) {
    return { verdict: 'BLOCKED', reason: `pause générale du moteur commercial${ctx.observation.outbound.pauseReason ? ` — ${ctx.observation.outbound.pauseReason}` : ''}` };
  }

  // Une tâche de modèle coûte : les plafonds existants s'appliquent d'abord,
  // puis le plafond du cycle. Un coût inconnu n'est pas un coût nul.
  if (agent !== 'DETERMINISTIC') {
    const budget = checkBudget({
      mode: ctx.config.ai.dailyBudgetMode,
      dailySpentUsd: ctx.observation.spend.todayUsd ?? 0,
      dailyLimitUsd: ctx.observation.spend.dailyLimitUsd,
      taskCostUsd: p.expectedCostUsd,
      maxTaskCostUsd: ctx.config.ai.maxTaskCostUsd > 0 ? ctx.config.ai.maxTaskCostUsd : null,
    });
    if (!budget.allowed) return { verdict: 'BLOCKED', reason: `budget — ${budget.reason}` };
    if (ctx.observation.spend.unknownCalls > 0 && ctx.config.ai.unknownCostPolicy === 'BLOCK' && ctx.config.ai.dailyBudgetMode === 'CONFIGURED') {
      return { verdict: 'BLOCKED', reason: `${ctx.observation.spend.unknownCalls} appel(s) au tarif inconnu aujourd'hui : la dépense n'est pas calculable` };
    }
    if (ctx.cycleSpentUsd + p.expectedCostUsd > ctx.config.autopilot.maxCycleCostUsd) {
      return { verdict: 'DEFERRED', reason: `plafond du cycle (${ctx.config.autopilot.maxCycleCostUsd.toFixed(2)} $) atteint : reporté au prochain cycle` };
    }
  }
  return { verdict: 'AUTO', agent, reason: `${taskType} → ${agent}, sous les gardes existantes` };
}

// ─── Les sources d'occasions ─────────────────────────────────────────────────

export interface OpportunityContext {
  observation: AutopilotObservation;
  repos: Repositories;
  config: AtlasConfig;
  now: Date;
}

/**
 * Une source publie des occasions dans l'Autopilot.
 *
 * C'est le point d'extension : le moteur d'expansion de prospects, le moteur
 * de déclencheurs et l'apprentissage du revenu publieront ici, chacun sous
 * son nom, sans toucher au cycle. Une source peut aussi proposer une suite à
 * une action terminée — bornée en profondeur, jamais récursive à l'infini.
 */
export interface OpportunitySource {
  name: string;
  propose(ctx: OpportunityContext): AutopilotProposal[];
  followUp?(done: AutopilotAction, task: TaskRow | null, ctx: OpportunityContext): AutopilotProposal[];
}

const FIFTEEN_MINUTES = 15;

/** Les occasions que l'état réel d'ATLAS révèle aujourd'hui. */
export const revenueLoopSource: OpportunitySource = {
  name: 'revenue-loop',
  propose({ observation: o, config }): AutopilotProposal[] {
    const out: AutopilotProposal[] = [];

    if (o.sales.hotLeadsOpen > 0) {
      out.push({
        objective: `répondre à ${o.sales.hotLeadsOpen} réponse(s) chaude(s) de prospects`,
        category: 'REVENUE', expectedBusinessValue: 'DIRECT_REVENUE', expectedCostUsd: 0, expectedFounderTimeMinutes: 10 * o.sales.hotLeadsOpen,
        confidence: 0.9, urgency: 'CRITICAL', evidence: [`${o.sales.hotLeadsOpen} réponse(s) chaude(s) ouverte(s)`],
        risk: 'LOW', reversibility: 'PARTIAL', recommendedAgent: 'HUMAN', requiresHumanApproval: true,
        reason: 'un prospect intéressé qui attend perd son intérêt : c’est le revenu le plus proche',
        execution: { kind: 'FOUNDER_DECISION', command: 'npm run sales:inbox' }, fingerprintKey: 'REVENUE:hot-leads',
      });
    }
    if (o.conversations.awaitingReply > 0) {
      out.push({
        objective: `traiter ${o.conversations.awaitingReply} conversation(s) où quelqu'un attend une réponse`,
        category: 'BLOCKED_WORK', expectedBusinessValue: 'HIGH', expectedCostUsd: 0, expectedFounderTimeMinutes: 8 * o.conversations.awaitingReply,
        confidence: 0.85, urgency: 'HIGH', evidence: [`${o.conversations.awaitingReply} conversation(s) en attente de votre réponse`],
        risk: 'LOW', reversibility: 'PARTIAL', recommendedAgent: 'HUMAN', requiresHumanApproval: true,
        reason: 'une réponse qui attend bloque un dossier client ou prospect',
        execution: { kind: 'FOUNDER_DECISION', command: 'npm run sales:inbox' }, fingerprintKey: 'BLOCKED_WORK:awaiting-reply',
      });
    }
    if (o.sales.draftsAwaitingApproval > 0) {
      out.push({
        objective: `relire et approuver ${o.sales.draftsAwaitingApproval} message(s) commerciaux rédigés`,
        category: 'BLOCKED_WORK', expectedBusinessValue: 'HIGH', expectedCostUsd: 0, expectedFounderTimeMinutes: 3 * o.sales.draftsAwaitingApproval,
        confidence: 0.8, urgency: 'HIGH', evidence: [`${o.sales.draftsAwaitingApproval} brouillon(s) READY_FOR_APPROVAL`],
        risk: 'MEDIUM', reversibility: 'IRREVERSIBLE', recommendedAgent: 'HUMAN', requiresHumanApproval: true,
        reason: 'aucun message ne part sans relecture : la file d’envoi est bloquée sur vous',
        // `draftsAwaitingApproval` vient de `board.todo.approvals`, qui compte
        // DEUX magasins (outreach_drafts + sales_prospects READY_FOR_REVIEW).
        // `sales:loop -- drafts` n'en lit qu'un : il peut afficher 0 pendant
        // que ce chiffre-ci en montre 3 — relevé en conditions réelles.
        // `approvals:audit` (lecture seule) est le seul à montrer les deux.
        execution: { kind: 'FOUNDER_DECISION', command: 'npm run approvals:audit' }, fingerprintKey: 'BLOCKED_WORK:drafts-approval',
      });
    }
    if (o.sales.followUpsDue > 0) {
      out.push({
        objective: `préparer ${o.sales.followUpsDue} relance(s) due(s)`,
        category: 'CONVERSION', expectedBusinessValue: 'MEDIUM', expectedCostUsd: 0, expectedFounderTimeMinutes: 0,
        confidence: 0.75, urgency: 'NORMAL', evidence: [`${o.sales.followUpsDue} relance(s) due(s) au registre`],
        risk: 'NONE', reversibility: 'REVERSIBLE', recommendedAgent: 'DETERMINISTIC', requiresHumanApproval: false,
        reason: 'une relance due qui n’est pas signalée est une conversion perdue ; le cycle ne fait que la signaler, l’envoi reste soumis à approbation',
        execution: { kind: 'INTERNAL_TASK', taskType: SALES_ENGINE_TASKS.FOLLOW_UP, department: 'sales' }, fingerprintKey: 'CONVERSION:follow-ups-due',
      });
    }
    if (o.sales.recommendationsProposed > 0) {
      out.push({
        objective: `décider de ${o.sales.recommendationsProposed} recommandation(s) d'optimisation proposée(s)`,
        category: 'OPTIMIZATION', expectedBusinessValue: 'MEDIUM', expectedCostUsd: 0, expectedFounderTimeMinutes: 4 * o.sales.recommendationsProposed,
        confidence: 0.7, urgency: 'NORMAL', evidence: [`${o.sales.recommendationsProposed} recommandation(s) PROPOSED`],
        risk: 'LOW', reversibility: 'REVERSIBLE', recommendedAgent: 'HUMAN', requiresHumanApproval: true,
        reason: 'ATLAS a mesuré quelque chose et propose un réglage : la décision vous revient',
        // `npm run sales:engine` n'existe pas (aucun script de ce nom, et
        // `sales-engine.ts` n'a pas de verbe « recommendations ») : la
        // commande affichée ne pouvait jamais s'exécuter. `sales:status`
        // liste chaque recommandation (id, titre, raison) ; `campaign --
        // decide` est la seule commande qui en décide.
        execution: { kind: 'FOUNDER_DECISION', command: 'npm run sales:status  puis  npm run sales:campaign -- decide <recId> test|approve|reject' }, fingerprintKey: 'OPTIMIZATION:recommendations',
      });
    }
    if (o.health.gmail === 'DOWN' || o.health.gmail === 'STALE' || o.health.gmail === 'UNKNOWN') {
      out.push({
        objective: `relire la boîte Gmail (état ${o.health.gmail})`,
        category: 'BLOCKED_WORK', expectedBusinessValue: 'HIGH', expectedCostUsd: 0, expectedFounderTimeMinutes: 0,
        confidence: 0.8, urgency: o.health.gmail === 'DOWN' ? 'HIGH' : 'NORMAL', evidence: [`Gmail ${o.health.gmail} — ${o.health.gmailDetail}`],
        risk: 'NONE', reversibility: 'REVERSIBLE', recommendedAgent: 'DETERMINISTIC', requiresHumanApproval: false,
        reason: 'une réponse non lue est une réponse perdue : la lecture est gratuite et sans effet de bord',
        execution: { kind: 'INTERNAL_TASK', taskType: SALES_ENGINE_TASKS.REPLY_SYNC, department: 'sales' }, fingerprintKey: 'BLOCKED_WORK:gmail-sync',
      });
    }
    if (o.engineering.readyForReview > 0 || o.engineering.approvedToApply > 0) {
      const n = o.engineering.readyForReview + o.engineering.approvedToApply;
      out.push({
        objective: `décider de ${n} changement(s) de code prêt(s) (READY_FOR_HUMAN_DEPLOYMENT)`,
        category: 'RELIABILITY', expectedBusinessValue: 'MEDIUM', expectedCostUsd: 0, expectedFounderTimeMinutes: 10 * n,
        confidence: 0.8, urgency: 'NORMAL', evidence: [`${o.engineering.readyForReview} diff(s) à relire, ${o.engineering.approvedToApply} approuvé(s) non appliqué(s)`],
        risk: 'MEDIUM', reversibility: 'REVERSIBLE', recommendedAgent: 'HUMAN', requiresHumanApproval: true, gate: 'PRODUCTION_DEPLOYMENT',
        reason: 'le dépôt ne bouge pas sans vous : le travail validé attend',
        execution: { kind: 'FOUNDER_DECISION', command: 'npm run atlas:apply -- list' }, fingerprintKey: 'RELIABILITY:ready-for-deployment',
      });
    }
    if (o.queue.waitingHuman > 0) {
      out.push({
        objective: `débloquer ${o.queue.waitingHuman} tâche(s) en attente d'une décision`,
        category: 'BLOCKED_WORK', expectedBusinessValue: 'MEDIUM', expectedCostUsd: 0, expectedFounderTimeMinutes: 5 * o.queue.waitingHuman,
        confidence: 0.7, urgency: 'NORMAL', evidence: [`${o.queue.waitingHuman} tâche(s) WAITING_HUMAN`],
        risk: 'LOW', reversibility: 'REVERSIBLE', recommendedAgent: 'HUMAN', requiresHumanApproval: true,
        reason: 'une tâche en attente ne reprend pas d’elle-même',
        execution: { kind: 'FOUNDER_DECISION', command: 'npm run atlas:task -- list --status=WAITING_HUMAN' }, fingerprintKey: 'BLOCKED_WORK:tasks-waiting-human',
      });
    }
    // Pipeline maigre : découvrir, sous budget et sous moteur. Le seuil est
    // volontairement bas — la découverte coûte, et un pipeline qui a déjà de
    // quoi contacter n'a pas besoin de plus de prospects, mais de conversion.
    if (o.sales.qualified < 10 && config.sales.discoveryEnabled) {
      out.push({
        objective: `découvrir de nouveaux prospects (${o.sales.qualified} qualifié(s) seulement sur 30 jours)`,
        category: 'DISCOVERY', expectedBusinessValue: 'HIGH', expectedCostUsd: Math.min(0.3, o.spend.salesRemainingUsd), expectedFounderTimeMinutes: 0,
        confidence: 0.6, urgency: 'NORMAL', evidence: [`${o.sales.qualified} prospect(s) qualifié(s), ${o.sales.discovered} découvert(s) sur 30 jours`, `budget commercial restant ${o.spend.salesRemainingUsd.toFixed(2)} $`],
        risk: 'LOW', reversibility: 'REVERSIBLE', recommendedAgent: 'DETERMINISTIC', requiresHumanApproval: false,
        reason: 'sans prospects qualifiés, rien n’entre dans l’entonnoir ; la découverte tourne sous le budget du jour et n’écrit à personne',
        execution: { kind: 'INTERNAL_TASK', taskType: SALES_ENGINE_TASKS.DISCOVERY, department: 'sales' }, fingerprintKey: 'DISCOVERY:thin-pipeline',
      });
    }
    // Contacts sans mesure récente : mesurer est gratuit, et c'est ce qui
    // nourrit les recommandations.
    if (o.sales.contacted > 0) {
      out.push({
        objective: 'mesurer la boucle commerciale (réponses, rebonds, segments) et produire les recommandations',
        category: 'OPTIMIZATION', expectedBusinessValue: 'MEDIUM', expectedCostUsd: 0, expectedFounderTimeMinutes: 0,
        confidence: 0.7, urgency: 'LOW', evidence: [`${o.sales.contacted} entreprise(s) contactée(s) sur 30 jours`],
        risk: 'NONE', reversibility: 'REVERSIBLE', recommendedAgent: 'DETERMINISTIC', requiresHumanApproval: false,
        reason: 'ce qui n’est pas mesuré ne s’améliore pas ; la mesure ne coûte rien',
        execution: { kind: 'INTERNAL_TASK', taskType: SALES_ENGINE_TASKS.ANALYTICS, department: 'sales' }, fingerprintKey: 'OPTIMIZATION:measure-loop',
      });
    }
    if (o.sales.openInsights > 0) {
      out.push({
        objective: `analyser ${o.sales.openInsights} friction(s) d'ingénierie répétée(s) et proposer un correctif`,
        category: 'RELIABILITY', expectedBusinessValue: 'MEDIUM', expectedCostUsd: 0.1, expectedFounderTimeMinutes: 0,
        confidence: 0.6, urgency: 'NORMAL', evidence: [`${o.sales.openInsights} insight(s) d'ingénierie OPEN`],
        risk: 'LOW', reversibility: 'REVERSIBLE', recommendedAgent: 'OPENAI', requiresHumanApproval: false,
        reason: 'une friction qui se répète coûte à chaque cycle ; la chaîne d’ingénierie s’arrête à un diff en attente de vous',
        execution: {
          kind: 'INTERNAL_TASK', taskType: 'ARCHITECTURE_REVIEW', department: 'ENGINEERING',
          payload: { objective: `analyser les ${o.sales.openInsights} friction(s) d'ingénierie ouvertes et proposer le correctif le plus petit`, allowed_paths: ['packages', 'scripts'], test_commands: ['npm test'] },
        },
        fingerprintKey: 'RELIABILITY:engineering-insights',
      });
    }
    // Explorer, seulement sur une preuve : un segment qui marche mieux que
    // les autres est une raison d'en chercher un voisin. Sans preuve, rien.
    if (o.sales.segments >= 2 && o.sales.positiveReplies >= 3) {
      out.push({
        objective: 'proposer un segment adjacent au meilleur segment mesuré',
        category: 'EXPLORATION', expectedBusinessValue: 'MEDIUM', expectedCostUsd: 0.1, expectedFounderTimeMinutes: 5,
        confidence: 0.5, urgency: 'LOW', evidence: [`${o.sales.segments} segment(s), ${o.sales.positiveReplies} réponse(s) positive(s) sur 30 jours`],
        risk: 'LOW', reversibility: 'REVERSIBLE', recommendedAgent: 'OPENAI', requiresHumanApproval: false,
        reason: 'ce qui marche quelque part marche souvent à côté ; l’analyse ne contacte personne',
        execution: { kind: 'INTERNAL_TASK', taskType: 'COMMERCIAL_ANALYSIS', department: 'sales', payload: { objective: 'proposer un segment adjacent au meilleur segment, avec les critères et la taille estimée' } },
        fingerprintKey: 'EXPLORATION:adjacent-segment',
      });
    }
    return out;
  },
};

export const DEFAULT_OPPORTUNITY_SOURCES: readonly OpportunitySource[] = [revenueLoopSource, prospectExpansionSource];

// ─── Le cycle ────────────────────────────────────────────────────────────────

export interface AutopilotCycleOptions {
  now?: Date;
  trigger?: string;
  sources?: readonly OpportunitySource[];
  observe?: ObserveOptions;
  /** Le nombre maximal d'actions confiées dans ce cycle ; la config sinon. */
  maxDispatch?: number;
}

export interface ExecutedRecord { actionId: string; objective: string; taskId: string; taskType: string; agent: string; estimatedCostUsd: number }

export interface AutopilotCycleReport {
  cycle: AutopilotCycle;
  observation: AutopilotObservation;
  considered: Array<{ objective: string; category: AutopilotCategory; score: number; allocation: Allocation }>;
  decisions: AutopilotDecision[];
  created: AutopilotAction[];
  executed: ExecutedRecord[];
  verified: Array<{ actionId: string; objective: string; from: AutopilotActionStatus; to: AutopilotActionStatus; reason: string }>;
  needsFounder: AutopilotAction[];
  blocked: AutopilotAction[];
  estimatedSpendUsd: number;
  learned: string[];
  paused: boolean;
}

export const AUTOPILOT_SETTINGS = { PAUSE: 'autopilot.pause' } as const;
export const AUTOPILOT_TASK_TYPE = 'AUTOPILOT_CYCLE';
export const MAX_ACTION_DEPTH = 2;
const DONE_RECENTLY_MS = 6 * 3_600_000;

export interface AutopilotPause { paused: boolean; reason: string | null; by: string | null; at: string | null }

export const readAutopilotPause = (repos: Repositories): AutopilotPause =>
  repos.settings.get<AutopilotPause>(AUTOPILOT_SETTINGS.PAUSE, { paused: false, reason: null, by: null, at: null });

export function setAutopilotPause(repos: Repositories, paused: boolean, by: string, reason: string | null): AutopilotPause {
  if (!by.trim()) throw new Error('une pause ou une reprise sans auteur ne se consigne pas');
  const value: AutopilotPause = { paused, reason, by, at: new Date().toISOString() };
  repos.settings.set(AUTOPILOT_SETTINGS.PAUSE, value, by);
  return value;
}

/** Ce qu'une chaîne de tâches dit d'une action confiée. */
export function verdictFromTasks(repos: Repositories, root: TaskRow): { status: AutopilotActionStatus; reason: string; result: Record<string, unknown> | null; costUsd: number | null } {
  const chainId = root.chainId ?? root.taskId;
  const chain = repos.tasks.chainTasks(chainId);
  const tasks = chain.length > 0 ? chain : [root];
  const cost = tasks.reduce((sum, t) => sum + (t.actualCost ?? 0), 0);
  // Un diff prêt quelque part dans la chaîne : le travail est arrivé au bout
  // de ce qu'une machine peut faire — READY_FOR_HUMAN_DEPLOYMENT.
  for (const t of tasks) {
    const workspace = repos.tasks.workspaceFor(t.taskId);
    if (workspace && (workspace.state === 'READY_FOR_REVIEW' || workspace.state === 'APPROVED_TO_APPLY')) {
      return { status: 'WAITING_HUMAN', reason: `READY_FOR_HUMAN_DEPLOYMENT — diff prêt sur ${t.taskId} (${workspace.state})`, result: t.result, costUsd: cost };
    }
  }
  if (tasks.some((t) => t.status === 'WAITING_HUMAN')) {
    const t = tasks.find((x) => x.status === 'WAITING_HUMAN')!;
    return { status: 'WAITING_HUMAN', reason: `${t.taskType} attend une décision : ${t.errorMessage ?? 'sans détail'}`, result: t.result, costUsd: cost };
  }
  if (tasks.some((t) => t.status === 'FAILED')) {
    const t = tasks.find((x) => x.status === 'FAILED')!;
    return { status: 'BLOCKED', reason: `${t.taskType} en échec : ${t.errorCode ?? '?'} — ${t.errorMessage ?? 'sans détail'}`, result: t.result, costUsd: cost };
  }
  if (tasks.some((t) => t.status === 'PAUSED_QUOTA' || t.status === 'PAUSED_BUDGET')) {
    const t = tasks.find((x) => x.status === 'PAUSED_QUOTA' || x.status === 'PAUSED_BUDGET')!;
    return { status: 'BLOCKED', reason: `${t.taskType} en pause (${t.status}) : ${t.errorMessage ?? 'fournisseur ou budget'}`, result: t.result, costUsd: cost };
  }
  if (tasks.some((t) => t.status === 'RUNNING')) return { status: 'RUNNING', reason: 'en cours chez un worker', result: null, costUsd: cost };
  if (tasks.every((t) => t.status === 'DONE')) return { status: 'DONE', reason: `${tasks.length} tâche(s) terminée(s)`, result: root.result, costUsd: cost };
  return { status: 'QUEUED', reason: 'en file, pas encore prise', result: null, costUsd: cost };
}

/**
 * Un cycle, borné, explicable.
 *
 * Il commence par reprendre ce qu'un cycle interrompu a laissé (vérifier les
 * actions confiées, marquer le cycle ouvert), observe, propose, priorise,
 * confie ce qui est sûr dans les plafonds, et écrit tout avant de rendre la
 * main. Aucun appel de modèle n'est fait par le cycle lui-même : il pose des
 * tâches, ce sont les workers qui dépensent — sous leurs plafonds.
 */
export async function runAutopilotCycle(
  repos: Repositories,
  config: AtlasConfig,
  logger: Logger,
  options: AutopilotCycleOptions = {},
): Promise<AutopilotCycleReport> {
  const now = options.now ?? new Date();
  const sources = options.sources ?? DEFAULT_OPPORTUNITY_SOURCES;
  const interrupted = repos.autopilot.interruptOpenCycles();
  const cycle = repos.autopilot.startCycle({ trigger: options.trigger ?? 'manual', startedAt: now.toISOString() });
  const learned: string[] = [];
  if (interrupted.length > 0) learned.push(`${interrupted.length} cycle(s) laissé(s) ouvert(s) par un arrêt : marqué(s) INTERRUPTED, file reprise`);

  try {
    // ── VÉRIFIER ce qui avait été confié ────────────────────────────────────
    const verified: AutopilotCycleReport['verified'] = [];
    const doneNow: Array<{ action: AutopilotAction; task: TaskRow | null }> = [];
    for (const action of repos.autopilot.openActions()) {
      if (!action.taskId) continue;
      const task = repos.tasks.byId(action.taskId);
      if (!task) { verified.push({ actionId: action.id, objective: action.objective, from: action.status, to: 'BLOCKED', reason: 'tâche introuvable' }); repos.autopilot.transition(action.id, 'BLOCKED', { rejectionReason: 'tâche introuvable' }); continue; }
      const verdict = verdictFromTasks(repos, task);
      if (verdict.status !== action.status) {
        const updated = repos.autopilot.transition(action.id, verdict.status, { result: verdict.result, actualCostUsd: verdict.costUsd, reason: verdict.reason, at: now.toISOString(), ...(verdict.status === 'BLOCKED' ? { rejectionReason: verdict.reason } : {}) });
        verified.push({ actionId: action.id, objective: action.objective, from: action.status, to: verdict.status, reason: verdict.reason });
        if (verdict.status === 'DONE') doneNow.push({ action: updated, task });
      }
    }

    // ── OBSERVER ────────────────────────────────────────────────────────────
    const observation = await observeAtlas(repos, config, { ...options.observe, now });
    const pause = readAutopilotPause(repos);
    const ctx: OpportunityContext = { observation, repos, config, now };

    // ── DIAGNOSTIQUER / PROPOSER ────────────────────────────────────────────
    const proposals: Array<AutopilotProposal & { parentActionId?: string | null; depth: number }> = [];
    for (const source of sources) {
      for (const p of source.propose(ctx)) proposals.push({ ...p, source: p.source ?? source.name, depth: 0 });
      if (source.followUp) {
        for (const { action, task } of doneNow) {
          if (action.depth + 1 > MAX_ACTION_DEPTH) { learned.push(`suite de « ${action.objective} » refusée : profondeur ${action.depth + 1} au-delà de ${MAX_ACTION_DEPTH}`); continue; }
          for (const p of source.followUp(action, task, ctx)) proposals.push({ ...p, source: p.source ?? source.name, parentActionId: action.id, depth: action.depth + 1 });
        }
      }
    }

    // ── Les actions dont la condition a disparu ─────────────────────────────
    //
    // Une action sans tâche — décision du fondateur, proposée, bloquée — ne
    // vit que par l'occasion qui l'a créée. Si plus aucune source ne la
    // propose, la condition a disparu : traitée par quelqu'un, ou devenue sans
    // objet. Elle se ferme avec ce motif, et n'entre pas dans le délai de
    // « déjà fait » : si l'occasion revient, elle est reproposée. Rien n'est
    // effacé — relevé en production : le self-test Gmail restait en tête des
    // priorités après avoir cessé d'être une occasion commerciale.
    const proposedFingerprints = new Set(proposals.map((p) => fingerprintOf(p)));
    for (const action of repos.autopilot.openActions()) {
      if (action.taskId || proposedFingerprints.has(action.fingerprint)) continue;
      const reason = 'condition disparue : plus proposée par aucune source (traitée, ou sans objet)';
      repos.autopilot.transition(action.id, 'DONE', { reason, result: { resolvedBy: 'autopilot', stale: true }, at: now.toISOString() });
      verified.push({ actionId: action.id, objective: action.objective, from: action.status, to: 'DONE', reason });
    }

    // ── PRIORISER ───────────────────────────────────────────────────────────
    const recent = [...repos.autopilot.openActions(), ...repos.autopilot.resolvedSince(new Date(now.getTime() - 7 * 86_400_000).toISOString(), 50)];
    const shares = allocationShares(recent);
    const ranked = proposals
      .map((p) => {
        const allocation = ALLOCATION_OF[p.category];
        return { p, allocation, score: priorityScore(p) + allocationAdjustment(allocation, shares, recent.length) };
      })
      .sort((a, b) => b.score - a.score);
    const considered = ranked.map(({ p, allocation, score }) => ({ objective: p.objective, category: p.category, score, allocation }));

    // ── CRÉER / CONFIER ─────────────────────────────────────────────────────
    const decisions: AutopilotDecision[] = [];
    const created: AutopilotAction[] = [];
    const executed: ExecutedRecord[] = [];
    let cycleSpentUsd = 0;
    let dispatched = 0;
    const maxDispatch = options.maxDispatch ?? config.autopilot.maxDispatchPerCycle;

    /**
     * Confier une action à la file — la même mécanique pour une action née
     * ici et pour une action bloquée qui reprend. La clé d'idempotence tient
     * à l'empreinte et à l'heure : un redémarrage dans la même heure ne pose
     * pas la tâche deux fois.
     */
    const dispatch = (action: AutopilotAction, p: AutopilotProposal & { execution: { kind: 'INTERNAL_TASK' } }, autonomyReason: string): ExecutedRecord => {
      const route = routeTask(p.execution.taskType);
      const outcome = repos.tasks.create({
        taskType: p.execution.taskType, department: p.execution.department, workerType: route.target,
        priority: p.execution.priority ?? 30,
        payload: { ...(p.execution.payload ?? {}), autopilot_action_id: action.id, autopilot_objective: p.objective, scheduledBy: 'autopilot' },
        idempotencyKey: `autopilot:${action.fingerprint}:${now.toISOString().slice(0, 13)}`,
        correlationId: action.id,
      });
      repos.autopilot.transition(action.id, 'QUEUED', { taskId: outcome.task.taskId, reason: autonomyReason, rejectionReason: null, at: now.toISOString() });
      cycleSpentUsd += p.expectedCostUsd;
      dispatched += 1;
      return { actionId: action.id, objective: p.objective, taskId: outcome.task.taskId, taskType: p.execution.taskType, agent: route.target, estimatedCostUsd: p.expectedCostUsd };
    };

    for (const { p, allocation, score } of ranked) {
      const fingerprint = fingerprintOf(p);
      const worth = worthDoing(p);
      if (!worth.worth) { decisions.push({ objective: p.objective, category: p.category, score, decision: 'NOT_WORTH_IT', reason: worth.reason }); continue; }
      const open = repos.autopilot.openByFingerprint(fingerprint);
      if (open) {
        /**
         * La même occasion, déjà ouverte. Une action confiée suit sa tâche ;
         * une action qui attend une personne attend encore. Mais une action
         * BLOCKED ou reportée, sans tâche, se réévalue à chaque cycle sur
         * l'état d'aujourd'hui — fournisseur revenu, budget rendu, plafond
         * levé — et reprend, *elle*, sans doublon : le blocage d'hier n'est
         * pas une décision. Relevé en production : « OPENAI : clé absente »
         * restait écrit alors que la clé était là.
         */
        if (open.taskId || (open.status !== 'BLOCKED' && open.status !== 'PROPOSED')) {
          decisions.push({ objective: p.objective, category: p.category, score, decision: 'DUPLICATE', reason: `déjà ouverte (${open.status}, ${open.id})`, actionId: open.id });
          continue;
        }
        const autonomy = pause.paused
          ? { verdict: 'DEFERRED' as const, reason: `Autopilot en pause${pause.reason ? ` — ${pause.reason}` : ''} (${pause.by ?? '?'})` }
          : decideAutonomy(p, { observation, config, cycleSpentUsd });
        if (autonomy.verdict === 'AUTO' && p.execution.kind === 'INTERNAL_TASK') {
          if (dispatched >= maxDispatch) {
            repos.autopilot.transition(open.id, 'PROPOSED', { reason: `${autonomy.reason} · plafond de ${maxDispatch} action(s) confiée(s) par cycle : au prochain cycle`, rejectionReason: null, at: now.toISOString() });
            decisions.push({ objective: p.objective, category: p.category, score, decision: 'STILL_BLOCKED', reason: 'reprise possible, plafond du cycle atteint : au prochain cycle', actionId: open.id });
            continue;
          }
          executed.push(dispatch(open, p as AutopilotProposal & { execution: { kind: 'INTERNAL_TASK' } }, autonomy.reason));
          decisions.push({ objective: p.objective, category: p.category, score, decision: 'RESUMED', reason: `reprise : ${autonomy.reason} (était ${open.status} — ${open.rejectionReason ?? open.reason})`, actionId: open.id });
          continue;
        }
        if (autonomy.verdict === 'WAITING_HUMAN') {
          repos.autopilot.transition(open.id, 'WAITING_HUMAN', { reason: autonomy.reason, rejectionReason: null, at: now.toISOString() });
          decisions.push({ objective: p.objective, category: p.category, score, decision: 'STILL_BLOCKED', reason: `attend une personne : ${autonomy.reason}`, actionId: open.id });
          continue;
        }
        const status: AutopilotActionStatus = autonomy.verdict === 'BLOCKED' ? 'BLOCKED' : 'PROPOSED';
        if (status !== open.status || (open.rejectionReason ?? open.reason) !== autonomy.reason) {
          repos.autopilot.transition(open.id, status, { reason: autonomy.reason, rejectionReason: status === 'BLOCKED' ? autonomy.reason : null, at: now.toISOString() });
        }
        decisions.push({ objective: p.objective, category: p.category, score, decision: 'STILL_BLOCKED', reason: autonomy.reason, actionId: open.id });
        continue;
      }
      const last = repos.autopilot.lastResolvedByFingerprint(fingerprint);
      if (last?.status === 'DONE' && !last.result?.stale && last.resolvedAt && now.getTime() - Date.parse(last.resolvedAt) < DONE_RECENTLY_MS) {
        decisions.push({ objective: p.objective, category: p.category, score, decision: 'DONE_RECENTLY', reason: `terminée ${last.resolvedAt.slice(11, 16)} UTC : inutile de refaire`, actionId: last.id });
        continue;
      }
      if (repos.autopilot.openActions().length >= config.autopilot.maxOpenActions) {
        decisions.push({ objective: p.objective, category: p.category, score, decision: 'CAP_REACHED', reason: `${config.autopilot.maxOpenActions} action(s) déjà ouvertes` });
        continue;
      }

      const autonomy = pause.paused
        ? { verdict: 'DEFERRED' as const, reason: `Autopilot en pause${pause.reason ? ` — ${pause.reason}` : ''} (${pause.by ?? '?'})` }
        : decideAutonomy(p, { observation, config, cycleSpentUsd });
      const status: AutopilotActionStatus = autonomy.verdict === 'WAITING_HUMAN' ? 'WAITING_HUMAN' : autonomy.verdict === 'BLOCKED' ? 'BLOCKED' : 'PROPOSED';
      const { action } = repos.autopilot.propose({
        cycleId: cycle.id, fingerprint, objective: p.objective, category: p.category, allocation, score,
        proposal: { ...p, autonomy: autonomy.reason },
        recommendedAgent: p.recommendedAgent, requiresHumanApproval: p.requiresHumanApproval || autonomy.verdict === 'WAITING_HUMAN',
        reason: p.reason, status, estimatedCostUsd: p.expectedCostUsd, parentActionId: p.parentActionId ?? null, depth: p.depth,
        rejectionReason: autonomy.verdict === 'BLOCKED' ? autonomy.reason : null,
      });
      created.push(action);
      decisions.push({ objective: p.objective, category: p.category, score, decision: 'CREATED', reason: `${status} — ${autonomy.reason}`, actionId: action.id });

      if (autonomy.verdict !== 'AUTO' || p.execution.kind !== 'INTERNAL_TASK') continue;
      if (dispatched >= maxDispatch) { repos.autopilot.transition(action.id, 'PROPOSED', { reason: `${autonomy.reason} · plafond de ${maxDispatch} action(s) confiée(s) par cycle : au prochain cycle` }); continue; }
      executed.push(dispatch(action, p as AutopilotProposal & { execution: { kind: 'INTERNAL_TASK' } }, autonomy.reason));
    }

    // ── APPRENDRE ───────────────────────────────────────────────────────────
    const resolved7d = repos.autopilot.resolvedSince(new Date(now.getTime() - 7 * 86_400_000).toISOString(), 200);
    const done7d = resolved7d.filter((a) => a.status === 'DONE').length;
    const blocked7d = resolved7d.filter((a) => a.status === 'REJECTED').length;
    const pct = (x: number) => `${Math.round(x * 100)} %`;
    learned.push(`7 jours : ${done7d} action(s) terminée(s), ${blocked7d} rejetée(s) · allocation EXPLOIT ${pct(shares.EXPLOIT)} / OPTIMIZE ${pct(shares.OPTIMIZE)} / EXPLORE ${pct(shares.EXPLORE)} (cibles 70/20/10, sur ${recent.length} action(s))`);
    if (doneNow.length > 0) learned.push(`${doneNow.length} action(s) terminée(s) depuis le dernier cycle : ${doneNow.map((d) => d.action.objective).join(' · ')}`);
    if (observation.absent.length > 0) learned.push(`non mesurable, non inventé : ${observation.absent.join(' ; ')}`);
    if (proposals.length === 0) learned.push('aucune occasion révélée par l’état réel : rien n’a été créé pour remplir la file');

    const needsFounder = repos.autopilot.actions({ status: 'WAITING_HUMAN', limit: 50 });
    const blocked = repos.autopilot.actions({ status: 'BLOCKED', limit: 50 });
    const estimatedSpendUsd = Math.round(executed.reduce((s, e) => s + e.estimatedCostUsd, 0) * 10_000) / 10_000;
    const top = ranked[0];
    const summary = top
      ? `${created.length} action(s) créée(s), ${executed.length} confiée(s), ${needsFounder.length} pour le fondateur · objectif du moment : ${top.p.objective}`
      : `rien à faire de plus : ${needsFounder.length} décision(s) attendent le fondateur`;

    // Les actions telles qu'elles sont maintenant — confiées, en attente, bloquées — pas telles qu'elles sont nées.
    const createdNow = created.map((a) => repos.autopilot.action(a.id) ?? a);
    const finished = repos.autopilot.finishCycle(cycle.id, {
      status: 'DONE',
      observations: observation as unknown as Record<string, unknown>,
      opportunities: considered,
      decisions,
      actionsCreated: created.map((a) => a.id),
      executed,
      estimatedCostUsd: estimatedSpendUsd,
      actualCostUsd: null,
      summary,
    });
    logger.info('cycle Autopilot terminé', { cycleId: cycle.id, created: created.length, executed: executed.length, needsFounder: needsFounder.length });
    return { cycle: finished, observation, considered, decisions, created: createdNow, executed, verified, needsFounder, blocked, estimatedSpendUsd, learned, paused: pause.paused };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    repos.autopilot.finishCycle(cycle.id, { status: 'FAILED', error: message });
    throw error;
  }
}

// ─── Le résumé, pour l'écran et le daemon ────────────────────────────────────

export interface AutopilotSummary {
  status: 'ACTIVE' | 'PAUSED' | 'IDLE' | 'NEVER_RAN';
  enabled: boolean;
  paused: AutopilotPause;
  lastCycleAt: string | null;
  lastCycleSummary: string | null;
  topObjective: string | null;
  topReason: string | null;
  inProgress: Array<{ id: string; objective: string; status: string; agent: string }>;
  completedRecently: Array<{ id: string; objective: string; resolvedAt: string | null }>;
  waitingFounder: Array<{ id: string; objective: string; reason: string; command: string | null }>;
  blocked: Array<{ id: string; objective: string; reason: string }>;
  estimatedSpendUsd: number;
  actualSpendUsd: number | null;
}

export function summariseAutopilot(repos: Repositories, config: AtlasConfig, now: Date = new Date()): AutopilotSummary {
  const last = repos.autopilot.lastCycle();
  const pause = readAutopilotPause(repos);
  const open = repos.autopilot.openActions();
  const inProgress = open.filter((a) => ['QUEUED', 'RUNNING', 'VERIFYING', 'APPROVED'].includes(a.status));
  const waiting = open.filter((a) => a.status === 'WAITING_HUMAN');
  const blocked = open.filter((a) => a.status === 'BLOCKED');
  const recent = repos.autopilot.resolvedSince(new Date(now.getTime() - 7 * 86_400_000).toISOString(), 10).filter((a) => a.status === 'DONE');
  const top = [...open].sort((a, b) => b.score - a.score)[0] ?? null;
  const commandOf = (a: AutopilotAction): string | null => {
    const execution = a.proposal.execution as AutopilotExecution | undefined;
    return execution?.kind === 'FOUNDER_DECISION' ? execution.command : null;
  };
  const actualKnown = [...open, ...recent].map((a) => a.actualCostUsd).filter((c): c is number => c !== null);
  return {
    status: !last ? 'NEVER_RAN' : pause.paused ? 'PAUSED' : inProgress.length > 0 ? 'ACTIVE' : 'IDLE',
    enabled: config.autopilot.enabled,
    paused: pause,
    lastCycleAt: last?.finishedAt ?? last?.startedAt ?? null,
    lastCycleSummary: last?.summary ?? null,
    topObjective: top?.objective ?? null,
    topReason: top?.reason ?? null,
    inProgress: inProgress.map((a) => ({ id: a.id, objective: a.objective, status: a.status, agent: a.recommendedAgent })),
    completedRecently: recent.map((a) => ({ id: a.id, objective: a.objective, resolvedAt: a.resolvedAt })),
    waitingFounder: waiting.map((a) => ({ id: a.id, objective: a.objective, reason: a.reason, command: commandOf(a) })),
    blocked: blocked.map((a) => ({ id: a.id, objective: a.objective, reason: a.rejectionReason ?? a.reason })),
    estimatedSpendUsd: Math.round(open.reduce((s, a) => s + a.estimatedCostUsd, 0) * 10_000) / 10_000,
    actualSpendUsd: actualKnown.length > 0 ? Math.round(actualKnown.reduce((s, c) => s + c, 0) * 10_000) / 10_000 : null,
  };
}

// ─── Le daemon : un cycle comme une tâche ────────────────────────────────────

/** Le traitement déterministe d'un cycle, servi par le daemon existant. */
export function createAutopilotHandlers(deps: { repos: Repositories; config: AtlasConfig; logger: Logger; cwd?: string }): Record<string, (task: TaskRow, context: WorkerContext) => Promise<WorkerOutcome>> {
  return {
    [AUTOPILOT_TASK_TYPE]: async (task: TaskRow): Promise<WorkerOutcome> => {
      const report = await runAutopilotCycle(deps.repos, deps.config, deps.logger, {
        trigger: `daemon:${task.taskId}`, observe: { cwd: deps.cwd, probeClaudeCode: false },
      });
      return {
        kind: 'DONE',
        result: {
          cycleId: report.cycle.id, created: report.created.length, executed: report.executed.length,
          needsFounder: report.needsFounder.length, estimatedSpendUsd: report.estimatedSpendUsd, paused: report.paused,
        },
      };
    },
  };
}

/**
 * Poser le cycle courant, à clé de période : repasser ne crée rien deux fois,
 * et un redémarrage ne rejoue pas un cycle déjà consigné.
 */
export function scheduleAutopilotCycle(repos: Repositories, config: AtlasConfig, now: Date): { created: string[]; existing: string[] } {
  if (!config.autopilot.enabled) return { created: [], existing: [] };
  const every = config.autopilot.cycleMinutes;
  const key = `autopilot:cycle:${every}m:${Math.floor(now.getTime() / (every * 60_000))}`;
  const { created } = repos.tasks.create({
    taskType: AUTOPILOT_TASK_TYPE, department: 'autopilot', workerType: 'DETERMINISTIC', priority: 20,
    payload: { scheduledBy: 'autopilot-scheduler', period: key }, availableAt: now.toISOString(), maxAttempts: 1,
    idempotencyKey: key, correlationId: key,
  });
  return created ? { created: [key], existing: [] } : { created: [], existing: [key] };
}
