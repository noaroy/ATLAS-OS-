import { createHash } from 'node:crypto';
import { checkBudget, type AtlasConfig } from '@atlas/core';
import type {
  CreateTaskInput, EnsureObjectiveInput, ObjectiveSpec, Repositories, SupervisorObjective, SupervisorReview, TaskRow,
} from '@atlas/data';
import { pricingFor, type AiResponse, type ModelPricing } from '@atlas/llm';
import { redactSecrets, taskFingerprint, targetOf } from '../ai-contracts.ts';
import { HermesRouter, routeTask } from '../hermes-router.ts';
import { flagInjectionAttempt } from '../repo-guard.ts';
import { buildReviewContext, type ReviewContext } from './context.ts';
import { parseSupervisorDecision } from './decision.ts';
import {
  SUPERVISOR_LEDGER, SUPERVISOR_OBJECTIVE_SCHEMA, SUPERVISOR_TASK_TYPE,
  type SupervisorDecision, type GptSupervisorDeps, type SupervisorGuardCode, type SupervisorPollReport,
} from './types.ts';

/**
 * Le superviseur GPT : un tour de sondage.
 *
 * Trois mouvements, dans cet ordre :
 *
 * 1. **Les délais.** Un objectif actif dont l'échéance est passée s'arrête en
 *    BLOCKED, et ses tâches encore en file sont annulées.
 * 2. **Les revues.** Chaque tâche d'objectif terminée sans décision reçoit
 *    exactement une revue : d'abord les gardes déterministes (gratuites), puis,
 *    si toutes passent, GPT. La décision, l'éventuelle suite et l'avancement de
 *    l'objectif sont consignés dans une seule transaction.
 * 3. **Rien d'autre.** Pas de Claude Code lancé, pas d'apply, pas de push, pas
 *    de message : la suite est une tâche ENGINEERING_CHANGE dans la file, que la
 *    route existante confie au runner d'ingénierie.
 *
 * Tout l'état vit en base : un redémarrage reprend exactement où le tour
 * précédent s'est arrêté, et deux sondeurs concurrents sont départagés par les
 * contraintes d'unicité, pas par la mémoire d'un processus.
 */

/** Les contraintes posées sur toute tâche d'objectif, quoi que dise GPT. */
export const SUPERVISOR_FIXED_CONSTRAINTS = [
  'Ne rien appliquer au dépôt principal, ne rien commiter sur main, ne rien pousser, ne rien déployer.',
  'S’arrêter à READY_FOR_REVIEW : le diff reste dans le worktree, en attente de la revue du superviseur.',
  'Ne toucher ni aux secrets, ni à .env, ni à .git, ni à .github, ni à deployment/.',
];

/** Les états d'une tâche qui occupent encore l'objectif. */
const OPEN_STATUSES = new Set(['QUEUED', 'RUNNING', 'RETRY_SCHEDULED', 'WAITING_DEPENDENCY', 'PAUSED_QUOTA', 'PAUSED_BUDGET', 'WAITING_HUMAN']);
/** Ceux qu'on peut annuler sans interrompre un processus en cours. */
const CANCELLABLE_STATUSES = new Set(['QUEUED', 'RETRY_SCHEDULED', 'WAITING_DEPENDENCY', 'PAUSED_QUOTA', 'PAUSED_BUDGET', 'WAITING_HUMAN']);

export const objectiveIdFor = (seed: string): string =>
  `sob_${createHash('sha256').update(seed).digest('hex').slice(0, 20)}`;
export const childClaimKey = (objectiveId: string, cycle: number) => `supervisor:child:v1:${objectiveId}:${cycle}`;
export const childTaskKey = (objectiveId: string, cycle: number) => `supervisor:task:v1:${objectiveId}:${cycle}`;

interface SupervisorBlock {
  schema: string;
  objective_id: string;
  cycle: number;
  source?: string;
  stack_on_task_id?: string | null;
  base_commit?: string | null;
}

/** Le bloc `payload.supervisor`, s'il est bien formé. */
export function supervisorBlockOf(task: TaskRow): SupervisorBlock | null {
  const raw = (task.payload as Record<string, unknown>).supervisor;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (b.schema !== SUPERVISOR_OBJECTIVE_SCHEMA || typeof b.objective_id !== 'string') return null;
  const cycle = Number(b.cycle);
  if (!Number.isInteger(cycle) || cycle < 1) return null;
  return {
    schema: b.schema, objective_id: b.objective_id, cycle,
    source: typeof b.source === 'string' ? b.source : undefined,
    stack_on_task_id: typeof b.stack_on_task_id === 'string' ? b.stack_on_task_id : null,
    base_commit: typeof b.base_commit === 'string' ? b.base_commit : null,
  };
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);

/** L'objectif, tel qu'il se lit sur sa tâche racine. */
export function objectiveInputFromRoot(task: TaskRow, config: AtlasConfig): EnsureObjectiveInput | null {
  const block = supervisorBlockOf(task);
  if (!block || block.cycle !== 1) return null;
  const payload = task.payload as Record<string, unknown>;
  const limits = payload.limits && typeof payload.limits === 'object' && !Array.isArray(payload.limits)
    ? Object.fromEntries(Object.entries(payload.limits as Record<string, unknown>).filter(([, v]) => typeof v === 'number')) as Record<string, number>
    : {};
  const spec: ObjectiveSpec = {
    allowed_paths: strings(payload.allowed_paths),
    test_commands: strings(payload.test_commands),
    acceptance_criteria: strings(payload.acceptance_criteria),
    // Les contraintes fixes sont rajoutées à chaque suite : on ne garde ici
    // que celles de l'objectif, pour ne pas les doubler.
    constraints: strings(payload.constraints).filter((c) => !SUPERVISOR_FIXED_CONSTRAINTS.includes(c)),
    limits,
    repo_target: typeof payload.repo_target === 'string' ? payload.repo_target : null,
  };
  const s = config.supervisor;
  return {
    objectiveId: block.objective_id,
    rootTaskId: task.taskId,
    chainId: task.chainId ?? task.taskId,
    source: block.source ?? 'unknown',
    objective: String(payload.objective ?? '').slice(0, 4_000),
    spec,
    maxCycles: s.maxCycles,
    maxCorrections: s.maxCorrections,
    maxCostUsd: s.maxObjectiveCostUsd,
    deadlineAt: new Date(Date.parse(task.createdAt) + s.objectiveTimeoutMinutes * 60_000).toISOString(),
  };
}

function emptyReport(): SupervisorPollReport {
  return {
    ran: false, skipped: [], reviewed: [], deferred: [], timedOut: [], errors: [],
    gptCalls: 0, costUsd: 0, messagesSent: 0, applied: false,
  };
}

export interface SupervisorReadiness {
  ready: boolean;
  enabled: boolean;
  provider: string;
  model: string;
  providerConfigured: boolean;
  reasons: string[];
}

/** Le superviseur a-t-il le droit de relire ? Aucune valeur de clé n'est lue ici. */
export function supervisorReadiness(deps: Pick<GptSupervisorDeps, 'config' | 'provider' | 'pricing'>): SupervisorReadiness {
  const reasons: string[] = [];
  if (!deps.config.supervisor.enabled) reasons.push('ATLAS_SUPERVISOR_ENABLED=false');
  // Des réponses figées ne sont pas une revue : sans ATLAS_AI_LIVE, le
  // superviseur ne relit rien plutôt que d'arrêter des objectifs sur une
  // réponse de démonstration.
  if (!deps.config.ai.live) reasons.push('ATLAS_AI_LIVE=false : aucune revue réelle possible');
  const status = deps.provider.status();
  if (deps.provider.provider !== 'OPENAI') reasons.push(`le relecteur doit être OpenAI (reçu : ${deps.provider.provider})`);
  if (!status.configured) reasons.push(`${status.code} : ${status.detail}`);
  // Un relecteur sans tarif ne peut respecter aucun plafond : le superviseur
  // reste fermé — sans arrêter d'objectif pour une configuration absente.
  if (!(deps.pricing ?? pricingFor)(deps.provider.model)) {
    reasons.push(`modèle ${deps.provider.model} sans tarif déclaré (ATLAS_MODEL_PRICING_CONFIG) : dépense non chiffrable`);
  }
  return {
    ready: reasons.length === 0,
    enabled: deps.config.supervisor.enabled,
    provider: deps.provider.provider,
    model: deps.provider.model,
    providerConfigured: status.configured,
    reasons,
  };
}

interface Guard { code: SupervisorGuardCode; reason: string }

/**
 * Le coût inconnu de la chaîne est-il justifié, appel par appel ?
 *
 * La politique générale (ATLAS_UNKNOWN_COST_POLICY=BLOCK) arrête une chaîne
 * dès qu'un appel n'a pas de prix. Claude Code sur abonnement n'en a jamais :
 * il n'est pas facturé à l'appel. Une seule exception, donc, et prouvée tâche
 * par tâche : un appel `claude-code` dont la tâche atteste
 * `claude_code_billing: SUBSCRIPTION`. Tout autre appel au tarif inconnu —
 * une revue GPT sans tarif, Claude Code facturé à la clé, une attestation
 * absente — arrête l'objectif.
 */
export function unjustifiedUnknownCost(repos: Repositories, chainId: string): string | null {
  for (const call of repos.tasks.unknownCostCalls(chainId)) {
    if (call.provider === 'ANTHROPIC' && call.model === 'claude-code' && call.taskId) {
      const task = repos.tasks.byId(call.taskId);
      if (task?.chainId === chainId && task.result?.claude_code_billing === 'SUBSCRIPTION') continue;
      return `appel claude-code de ${call.taskId} sans attestation d’abonnement : sa dépense n’est pas calculable`;
    }
    return `appel ${call.provider}/${call.model}${call.taskId ? ` (${call.taskId})` : ''} au tarif inconnu : la dépense de l’objectif n’est pas calculable`;
  }
  return null;
}

/** Le pire coût d'une revue : toutes les tentatives, au plafond de sortie. */
export function estimateReviewCost(
  pricing: ModelPricing, context: Pick<ReviewContext, 'system' | 'prompt'>, maxOutputTokens: number, attempts: number,
): number {
  const inputTokens = Math.ceil((context.system.length + context.prompt.length) / 3);
  return attempts * ((inputTokens / 1_000_000) * pricing.input + (maxOutputTokens / 1_000_000) * pricing.output);
}

/** Les gardes qui précèdent toute dépense. La première qui tient l'emporte. */
export function preReviewGuards(input: {
  repos: Repositories;
  objective: SupervisorObjective;
  task: TaskRow;
  block: SupervisorBlock;
  reviews: readonly SupervisorReview[];
  now: Date;
}): Guard | null {
  const { objective, task, block, reviews } = input;
  if (objective.status !== 'ACTIVE') {
    return { code: 'OBJECTIVE_NOT_ACTIVE', reason: `objectif ${objective.status} (${objective.terminalCode ?? '—'}) : la tâche n’est plus relue` };
  }
  if (input.now.getTime() > Date.parse(objective.deadlineAt)) {
    return { code: 'OBJECTIVE_TIMEOUT', reason: `échéance de l’objectif dépassée (${objective.deadlineAt})` };
  }
  if (block.cycle !== objective.cycles) {
    return { code: 'CYCLE_MISMATCH', reason: `tâche du cycle ${block.cycle}, objectif au cycle ${objective.cycles}` };
  }
  const result = (task.result ?? {}) as Record<string, unknown>;
  if (task.status !== 'DONE' || result.status !== 'ENGINEERING_READY_FOR_REVIEW') {
    return {
      code: 'TASK_NOT_READY',
      reason: `tâche ${task.status}${task.errorCode ? ` ${task.errorCode}` : ''} : ${redactSecrets(String(task.errorMessage ?? result.summary ?? 'pas de READY_FOR_REVIEW')).slice(0, 500)}`,
    };
  }
  const base = typeof result.base_commit === 'string' ? result.base_commit : null;
  if (!base) return { code: 'STALE_BASE', reason: 'résultat sans commit de base : le diff ne peut pas être situé' };
  if (objective.baseCommit && base !== objective.baseCommit) {
    return { code: 'STALE_BASE', reason: `base ${base.slice(0, 12)} ≠ base de l’objectif ${objective.baseCommit.slice(0, 12)}` };
  }
  const hash = typeof result.diff_hash === 'string' ? result.diff_hash : null;
  if (hash) {
    const earlier = reviews.filter((r) => r.state === 'DECIDED' && r.taskId !== task.taskId && r.diffHash);
    const last = earlier[earlier.length - 1];
    if (last && last.diffHash === hash) {
      return { code: 'REPEATED_DIFF', reason: `diff identique à celui du cycle ${last.cycle} (${hash}) : aucun progrès` };
    }
    const older = earlier.find((r) => r.diffHash === hash);
    if (older) return { code: 'OSCILLATION', reason: `diff revenu à celui du cycle ${older.cycle} (${hash})` };
  }
  const unknown = unjustifiedUnknownCost(input.repos, objective.chainId);
  if (unknown) return { code: 'COST_UNKNOWN', reason: unknown };
  return null;
}

/** Les gardes qui précèdent la création d'une suite. */
export function childGuards(input: {
  repos: Repositories;
  hermes: HermesRouter;
  objective: SupervisorObjective;
  task: TaskRow;
  decision: SupervisorDecision;
}): Guard | null {
  const { repos, objective, task, decision } = input;
  if (objective.cycles >= objective.maxCycles) {
    return { code: 'MAX_CYCLES', reason: `${objective.cycles}/${objective.maxCycles} cycle(s) : plafond atteint, ${decision.decision} refusé` };
  }
  if (decision.decision === 'CORRECT' && objective.corrections >= objective.maxCorrections) {
    return { code: 'MAX_CORRECTIONS', reason: `${objective.corrections}/${objective.maxCorrections} correction(s) : plafond atteint` };
  }
  const route = routeTask(SUPERVISOR_TASK_TYPE);
  if (route.target !== 'CLAUDE_CODE') {
    return { code: 'ROUTE_MISMATCH', reason: `${SUPERVISOR_TASK_TYPE} routée vers ${route.target}, pas CLAUDE_CODE` };
  }
  const open = repos.tasks.chainTasks(objective.chainId).filter((t) => t.taskId !== task.taskId && OPEN_STATUSES.has(t.status));
  if (open.length > 0) {
    return { code: 'DUPLICATE_CHILD', reason: `tâche(s) encore ouverte(s) dans l’objectif : ${open.map((t) => t.taskId).join(', ')}` };
  }
  const children = repos.tasks.childrenOf(task.taskId);
  if (children.length > 0) {
    return { code: 'DUPLICATE_CHILD', reason: `la tâche relue a déjà une suite : ${children.map((t) => t.taskId).join(', ')}` };
  }
  const verdict = input.hermes.canCreateChild(task, {
    taskType: SUPERVISOR_TASK_TYPE,
    objective: decision.next_task!.objective,
    target: targetOf(objective.spec.repo_target),
  });
  if (!verdict.allowed) {
    const repeated = verdict.blockedBy === 'DUPLICATE_CHILD_BLOCKED' || verdict.blockedBy === 'ANCESTOR_IDENTICAL';
    return { code: repeated ? 'REPEATED_TASK' : 'CHAIN_LIMIT', reason: `${verdict.blockedBy} : ${verdict.reason}` };
  }
  return null;
}

/** La suite, écrite pour la route existante. Le périmètre est celui de l'objectif, jamais plus. */
export function buildChildTask(input: {
  objective: SupervisorObjective;
  task: TaskRow;
  decision: SupervisorDecision;
  reviewId: string;
}): CreateTaskInput {
  const { objective, task, decision } = input;
  const next = decision.next_task!;
  const cycle = objective.cycles + 1;
  const spec = objective.spec;
  const target = targetOf(spec.repo_target);
  const context = [
    `Objectif autonome ${objective.objectiveId}, cycle ${cycle}/${objective.maxCycles}, décidé par le superviseur GPT (${decision.decision}).`,
    `But d’ensemble : ${objective.objective.slice(0, 2_000)}`,
    `Revue du cycle précédent : ${decision.summary}`,
    decision.reasons.length ? `Raisons :\n${decision.reasons.map((r) => `- ${r}`).join('\n')}` : '',
    'Le worktree contient déjà, non commitées, les modifications du cycle précédent : pars de cet état, '
      + 'corrige-le ou complète-le. Le diff final doit être le changement cumulé complet.',
  ].filter(Boolean).join('\n');
  return {
    taskType: SUPERVISOR_TASK_TYPE,
    department: 'ENGINEERING',
    workerType: routeTask(SUPERVISOR_TASK_TYPE).target,
    priority: 10,
    // Une tentative : une suite facturée ne se relance pas seule. Une pause de
    // quota ne consomme pas de tentative.
    maxAttempts: 1,
    idempotencyKey: childTaskKey(objective.objectiveId, cycle),
    correlationId: objective.objectiveId,
    parentTaskId: task.taskId,
    chainId: objective.chainId,
    chainDepth: task.chainDepth + 1,
    fingerprint: taskFingerprint({ taskType: SUPERVISOR_TASK_TYPE, objective: next.objective, target }),
    metadata: { source: 'gpt-supervisor', objective_id: objective.objectiveId, cycle, review_id: input.reviewId },
    payload: {
      objective: next.objective,
      allowed_paths: spec.allowed_paths,
      test_commands: next.test_commands.length > 0 ? next.test_commands : spec.test_commands,
      acceptance_criteria: [...next.acceptance_criteria, ...spec.acceptance_criteria].slice(0, 20),
      constraints: [...spec.constraints, ...SUPERVISOR_FIXED_CONSTRAINTS],
      limits: spec.limits,
      ...(spec.repo_target ? { repo_target: spec.repo_target } : {}),
      context,
      supervisor: {
        schema: SUPERVISOR_OBJECTIVE_SCHEMA,
        objective_id: objective.objectiveId,
        cycle,
        source: 'gpt-supervisor',
        review_id: input.reviewId,
        decision: decision.decision,
        parent_task_id: task.taskId,
        // Le worktree de la suite part du diff relu, au même commit de base :
        // le travail s'empile sans jamais toucher au dépôt principal.
        stack_on_task_id: task.taskId,
        base_commit: objective.baseCommit,
        apply: false, push: false, deploy: false,
      },
    },
  };
}

/** Le résultat terminal d'un objectif COMPLETE : ce qui attend une personne, et rien d'appliqué. */
function completionResult(objective: SupervisorObjective, task: TaskRow, decision: SupervisorDecision): Record<string, unknown> {
  const r = (task.result ?? {}) as Record<string, unknown>;
  return {
    schema: 'atlas.supervisor-result.v1',
    objective_id: objective.objectiveId,
    final_task_id: task.taskId,
    cycles: objective.cycles,
    summary: decision.summary,
    reasons: decision.reasons,
    diff_hash: r.diff_hash ?? null,
    base_commit: r.base_commit ?? null,
    diff_lines: r.diff_lines ?? 0,
    files_changed: strings(r.files_changed),
    files_added: strings(r.files_added),
    files_deleted: strings(r.files_deleted),
    workspace_state: 'READY_FOR_REVIEW',
    applied: false, pushed: false, deployed: false,
  };
}

function redactDecision(d: SupervisorDecision): SupervisorDecision {
  return {
    ...d,
    summary: redactSecrets(d.summary),
    reasons: d.reasons.map(redactSecrets),
    next_task: d.next_task
      ? { ...d.next_task, objective: redactSecrets(d.next_task.objective), acceptance_criteria: d.next_task.acceptance_criteria.map(redactSecrets) }
      : null,
    blocked_reason: d.blocked_reason === null ? null : redactSecrets(d.blocked_reason),
  };
}

/** Annuler ce qui attend encore dans un objectif terminé. Un processus en cours n'est pas interrompu. */
function cancelOpenTasks(repos: Repositories, objective: SupervisorObjective, actor: string, reason: string): string[] {
  const cancelled: string[] = [];
  for (const t of repos.tasks.chainTasks(objective.chainId)) {
    if (!CANCELLABLE_STATUSES.has(t.status)) continue;
    if (!supervisorBlockOf(t)) continue;
    const outcome = repos.tasks.transition({
      taskId: t.taskId, to: 'CANCELLED', actor, reason,
      patch: { finished_at: new Date().toISOString(), error_code: 'SUPERVISOR_OBJECTIVE_CLOSED', error_message: reason.slice(0, 400) },
    });
    if (outcome.applied) cancelled.push(t.taskId);
  }
  return cancelled;
}

const describe = (error: unknown): string => redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 400);

/** Un tour de sondage. Borné : `maxReviewsPerPoll` revues au plus. */
export async function runSupervisorPoll(deps: GptSupervisorDeps): Promise<SupervisorPollReport> {
  const { repos, config, logger, provider } = deps;
  const report = emptyReport();
  const readiness = supervisorReadiness(deps);
  if (!readiness.ready) {
    report.skipped = readiness.reasons;
    logger.info('superviseur GPT : fermé, aucune revue', { reasons: readiness.reasons });
    return report;
  }
  report.ran = true;
  const clock = deps.now ?? (() => new Date());
  const actor = deps.actor ?? `gpt-supervisor#${process.pid}`;
  const s = config.supervisor;
  const price = deps.pricing ?? pricingFor;
  // Hermes vérifie profondeur, nombre, coût connu, durée et doublons. Le coût
  // inconnu est tranché plus haut, appel par appel (voir unjustifiedUnknownCost).
  const hermes = new HermesRouter({
    repos, logger,
    limits: {
      maxDepth: config.ai.maxChainDepth, maxTasks: config.ai.maxTasksPerChain, maxCostUsd: config.ai.maxChainCostUsd,
      maxRuntimeMinutes: config.ai.maxChainRuntimeMinutes, unknownCostPolicy: 'ALLOW',
    },
  });

  // 1. Les délais.
  for (const objective of repos.supervisor.objectives({ status: 'ACTIVE', limit: 200 })) {
    if (clock().getTime() <= Date.parse(objective.deadlineAt)) continue;
    const reason = `échéance de l’objectif dépassée (${objective.deadlineAt}) : ${s.objectiveTimeoutMinutes} min`;
    if (repos.supervisor.blockObjective(objective.objectiveId, 'OBJECTIVE_TIMEOUT', reason)) {
      report.timedOut.push(objective.objectiveId);
      const cancelled = cancelOpenTasks(repos, objective, actor, reason);
      logger.warn('superviseur GPT : objectif arrêté, échéance dépassée', { objectiveId: objective.objectiveId, cancelled });
    }
  }

  // 2. Les revues.
  const pending = repos.supervisor.pendingTaskIds(s.maxReviewsPerPoll * 5);
  let reviewed = 0;
  for (const taskId of pending) {
    if (reviewed >= s.maxReviewsPerPoll) {
      report.skipped.push(`plafond de ${s.maxReviewsPerPoll} revue(s) par tour atteint`);
      break;
    }
    try {
      const acted = await reviewOne(taskId);
      if (acted) reviewed += 1;
    } catch (error) {
      reviewed += 1;
      report.errors.push(`${taskId} : ${describe(error)}`);
      logger.warn('superviseur GPT : revue en erreur', { taskId, error: describe(error) });
    }
  }
  return report;

  /** Une revue. Rend vrai si quelque chose a été consigné ou dépensé. */
  async function reviewOne(taskId: string): Promise<boolean> {
    const task = repos.tasks.byId(taskId);
    if (!task) return false;
    const block = supervisorBlockOf(task);
    if (!block) {
      report.errors.push(`${taskId} : bloc supervisor illisible`);
      return false;
    }
    let objective = repos.supervisor.objective(block.objective_id);
    if (!objective) {
      // L'adoption : une racine posée par le pont contrôleur (ou une ligne de
      // commande interrompue avant l'inscription) devient un objectif ici.
      const input = task.parentTaskId === null ? objectiveInputFromRoot(task, config) : null;
      if (!input) {
        report.errors.push(`${taskId} : objectif ${block.objective_id} inconnu`);
        return false;
      }
      objective = repos.supervisor.ensureObjective(input).objective;
    }

    const now = clock();
    const result = (task.result ?? {}) as Record<string, unknown>;
    // Le commit de base se fixe sur la première tâche prête : toutes les
    // suites partent de lui.
    if (!objective.baseCommit && block.cycle === 1 && typeof result.base_commit === 'string' && objective.status === 'ACTIVE') {
      objective = repos.supervisor.pinBaseCommit(objective.objectiveId, result.base_commit) ?? objective;
    }
    const reviews = repos.supervisor.reviewsFor(objective.objectiveId);
    const leaseMs = s.reviewTimeoutMs * s.maxReviewAttempts + 60_000;

    const reserve = () => repos.supervisor.reserveReview({
      objectiveId: objective!.objectiveId, taskId, cycle: block.cycle, owner: actor, leaseMs,
      maxAttempts: s.maxReviewAttempts, now: now.toISOString(),
    });

    /** Consigner une décision de garde, sans GPT. */
    const guardDecision = (guard: Guard, extra: { calls?: number; costUsd?: number | null; model?: string | null; decisionJson?: Record<string, unknown> | null; reviewer?: 'GPT' | 'GUARD'; reviewId?: string } = {}): boolean => {
      let reviewId = extra.reviewId;
      if (!reviewId) {
        const reservation = reserve();
        if (!reservation.reserved) {
          if (reservation.review?.state === 'RESERVED' && reservation.reason.startsWith('réservation expirée')) {
            stalled(reservation.reason);
            return true;
          }
          return false;
        }
        reviewId = reservation.review.reviewId;
      }
      const decided = repos.supervisor.decide({
        reviewId, owner: actor, reviewer: extra.reviewer ?? 'GUARD', decision: 'BLOCKED',
        code: guard.code, reason: guard.reason, decisionJson: extra.decisionJson ?? null,
        diffHash: typeof result.diff_hash === 'string' ? result.diff_hash : null,
        model: extra.model ?? null, calls: extra.calls ?? 0, costUsd: extra.costUsd ?? null,
        objectiveEffect: { kind: 'BLOCKED' },
      });
      if (!decided.recorded) {
        report.errors.push(`${taskId} : décision non consignée — ${decided.reason}`);
        return false;
      }
      if (guard.code === 'OBJECTIVE_TIMEOUT') cancelOpenTasks(repos, decided.objective, actor, guard.reason);
      report.reviewed.push({ taskId, objectiveId: objective!.objectiveId, decision: 'BLOCKED', code: guard.code, childTaskId: null });
      logger.warn('superviseur GPT : objectif arrêté par une garde', { objectiveId: objective!.objectiveId, taskId, code: guard.code, reason: guard.reason });
      return true;
    };

    /** Une réservation reprise trop de fois sans décision : l'objectif s'arrête, preuve à l'appui. */
    const stalled = (why: string) => {
      const reason = `revue de ${taskId} sans décision : ${why}`;
      if (repos.supervisor.blockObjective(objective!.objectiveId, 'REVIEW_STALLED', reason)) {
        report.reviewed.push({ taskId, objectiveId: objective!.objectiveId, decision: 'BLOCKED', code: 'REVIEW_STALLED', childTaskId: null });
        logger.warn('superviseur GPT : revue bloquée', { objectiveId: objective!.objectiveId, taskId, reason });
      }
    };

    const guard = preReviewGuards({ repos, objective, task, block, reviews, now });
    if (guard) return guardDecision(guard);

    // Le contexte, puis le prix : sans tarif, aucune dépense.
    const context = buildReviewContext({ repos, objective, task, reviews, maxDiffChars: s.maxDiffChars, now });
    const pricing = price(provider.model);
    if (!pricing) {
      return guardDecision({ code: 'COST_UNKNOWN', reason: `modèle ${provider.model} sans tarif déclaré : la revue n’est pas chiffrable, aucune dépense` });
    }
    const estimate = estimateReviewCost(pricing, context, s.maxReviewOutputTokens, s.maxReviewAttempts);
    const spentObjective = repos.tasks.chainCost(objective.chainId).knownUsd;
    if (spentObjective + estimate > objective.maxCostUsd) {
      return guardDecision({
        code: 'OBJECTIVE_COST_CAP',
        reason: `${spentObjective.toFixed(4)} $ dépensés + revue estimée ${estimate.toFixed(4)} $ > plafond de l’objectif ${objective.maxCostUsd} $`,
      });
    }
    if (spentObjective + estimate > config.ai.maxChainCostUsd) {
      return guardDecision({
        code: 'CHAIN_LIMIT',
        reason: `${spentObjective.toFixed(4)} $ + ${estimate.toFixed(4)} $ > ATLAS_MAX_CHAIN_COST_USD ${config.ai.maxChainCostUsd} $`,
      });
    }
    if (config.ai.maxTaskCostUsd > 0 && estimate > config.ai.maxTaskCostUsd) {
      return guardDecision({ code: 'OBJECTIVE_COST_CAP', reason: `revue estimée ${estimate.toFixed(4)} $ > ATLAS_MAX_TASK_COST_USD ${config.ai.maxTaskCostUsd} $` });
    }

    // Les budgets du jour et du mois : une attente, pas un arrêt — le budget
    // se renouvelle, l'échéance de l'objectif borne l'attente.
    const today = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    const month = `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`;
    const daily = checkBudget({
      mode: config.ai.dailyBudgetMode,
      dailySpentUsd: repos.tasks.aiUsageSince(today).knownCostUsd + estimate,
      dailyLimitUsd: config.ai.dailyBudgetMode === 'CONFIGURED' ? config.ai.dailyBudgetUsd : null,
    });
    const monthly = checkBudget({
      mode: config.ai.monthlyBudgetMode,
      monthlySpentUsd: repos.tasks.aiUsageSince(month).knownCostUsd + estimate,
      monthlyLimitUsd: config.ai.monthlyBudgetMode === 'CONFIGURED' ? config.ai.monthlyBudgetUsd : null,
    });
    const budget = !daily.allowed ? daily : !monthly.allowed ? monthly : null;
    if (budget) {
      const reason = `budget IA — ${budget.reason} (revue estimée ${estimate.toFixed(4)} $) : revue différée`;
      repos.supervisor.note(objective.objectiveId, reason);
      report.deferred.push({ taskId, reason });
      logger.warn('superviseur GPT : revue différée, budget', { objectiveId: objective.objectiveId, taskId });
      return false;
    }

    const reservation = reserve();
    if (!reservation.reserved) {
      if (reservation.review?.state === 'RESERVED' && reservation.reason.startsWith('réservation expirée')) {
        stalled(reservation.reason);
        return true;
      }
      report.deferred.push({ taskId, reason: reservation.reason });
      return false;
    }
    const reviewId = reservation.review.reviewId;

    const injection = flagInjectionAttempt(context.prompt);
    if (injection.suspicious) {
      logger.warn('superviseur GPT : formulation d’injection dans le contexte relu, traitée comme donnée', { taskId, marker: injection.marker });
    }

    // L'appel. Chaque tentative est facturée et consignée ; une sortie
    // illisible donne droit à une seconde tentative, pas davantage.
    const efforts = ['low', 'minimal'] as const;
    let calls = 0;
    let cost = 0;
    let decision: SupervisorDecision | null = null;
    let lastProblems: string[] = [];
    let model = provider.model;
    for (let attempt = 1; attempt <= s.maxReviewAttempts; attempt++) {
      let response: AiResponse;
      try {
        response = await provider.execute({
          system: context.system,
          prompt: context.prompt,
          responseSchema: { type: 'object' },
          maxOutputTokens: s.maxReviewOutputTokens,
          timeoutMs: s.reviewTimeoutMs,
          capability: 'REVIEW',
          idempotencyKey: `${reviewId}:${reservation.review.attempts}:${attempt}`,
          reasoningEffort: efforts[Math.min(attempt - 1, efforts.length - 1)],
        });
      } catch (error) {
        const verdict = provider.classifyError(error);
        const message = describe(error);
        if (verdict.kind === 'TIMEOUT') {
          // Une requête coupée de notre côté a pu être facturée : son coût est
          // inconnu, et c'est écrit comme tel. La revue suivante s'arrêtera sur
          // COST_UNKNOWN plutôt que de dépenser à l'aveugle.
          repos.tasks.recordAiCall({
            taskId, chainId: objective.chainId, provider: provider.provider, model: provider.model, capability: 'REVIEW',
            inputTokens: 0, outputTokens: 0, costUsd: null, costBasis: 'UNKNOWN_PRICE', durationMs: s.reviewTimeoutMs,
            outcome: 'TIMEOUT', errorCode: 'TIMEOUT',
          });
        }
        if (verdict.kind === 'AUTH_ERROR') {
          return guardDecision({ code: 'PROVIDER_AUTH', reason: `${provider.provider} refuse l’authentification : ${message}` }, { reviewId, calls, costUsd: cost, model });
        }
        if (verdict.kind === 'BAD_REQUEST') {
          // Une requête refusée telle quelle le sera encore : la reprendre ne
          // coûterait que du temps. L'objectif s'arrête avec le motif.
          return guardDecision({ code: 'REVIEW_STALLED', reason: `requête refusée par ${provider.provider} : ${message}` }, { reviewId, calls, costUsd: cost, model });
        }
        if (verdict.kind === 'RATE_LIMITED' || verdict.kind === 'QUOTA_EXHAUSTED') {
          repos.supervisor.releaseReview(reviewId, actor);
          repos.supervisor.note(objective.objectiveId, `${verdict.kind} : ${message}`);
          report.deferred.push({ taskId, reason: `${verdict.kind} : ${message}` });
          return false;
        }
        // Délai, erreur serveur : la réservation reste et expire ; la reprise
        // compte une tentative, et le plafond de tentatives arrête l'objectif.
        report.errors.push(`${taskId} : ${verdict.kind} — ${message}`);
        logger.warn('superviseur GPT : appel en échec, reprise à l’expiration du bail', { taskId, kind: verdict.kind });
        return true;
      }
      calls += 1;
      report.gptCalls += 1;
      model = response.model;
      repos.tasks.recordAiCall({
        taskId, chainId: objective.chainId, provider: response.provider, model: response.model, capability: 'REVIEW',
        inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens,
        cacheReadTokens: response.usage.cacheReadTokens, costUsd: response.usage.costUsd, costBasis: response.usage.costBasis,
        durationMs: response.durationMs, outcome: 'OK',
      });
      if (response.usage.costBasis === 'UNKNOWN_PRICE') {
        return guardDecision({ code: 'COST_UNKNOWN', reason: `réponse de ${response.model} sans tarif : la dépense n’est pas calculable` }, { reviewId, calls, costUsd: null, model, reviewer: 'GPT' });
      }
      cost += response.usage.costUsd ?? 0;
      report.costUsd += response.usage.costUsd ?? 0;
      const verdict = parseSupervisorDecision(response.text, { objectiveId: objective.objectiveId, taskId });
      if (verdict.ok) {
        // La décision est une donnée venue d'un tiers : ce qu'elle recopie de
        // secret ne doit atteindre ni la base, ni la consigne de la suite.
        decision = redactDecision(verdict.decision);
        break;
      }
      lastProblems = verdict.reasons;
      logger.warn('superviseur GPT : décision illisible', { taskId, attempt, truncated: response.truncated, problems: verdict.reasons.slice(0, 3) });
    }

    if (!decision) {
      return guardDecision(
        { code: 'MALFORMED_REVIEW', reason: `sortie GPT refusée après ${calls} tentative(s) : ${lastProblems.join(' · ').slice(0, 800)}` },
        { reviewId, calls, costUsd: cost, model, reviewer: 'GPT' },
      );
    }
    const decisionJson = decision as unknown as Record<string, unknown>;
    const diffHash = typeof result.diff_hash === 'string' ? result.diff_hash : null;
    const fresh = repos.supervisor.objective(objective.objectiveId)!;

    const finish = (recorded: ReturnType<typeof repos.supervisor.decide>, code: string): boolean => {
      if (!recorded.recorded) {
        report.errors.push(`${taskId} : décision non consignée — ${recorded.reason}`);
        logger.warn('superviseur GPT : décision non consignée', { taskId, reason: recorded.reason });
        return true;
      }
      report.reviewed.push({
        taskId, objectiveId: fresh.objectiveId, decision: decision!.decision, code, childTaskId: recorded.child?.taskId ?? null,
      });
      logger.info('superviseur GPT : décision consignée', {
        objectiveId: fresh.objectiveId, taskId, decision: decision!.decision, code,
        childTaskId: recorded.child?.taskId ?? null, objectiveStatus: recorded.objective.status, cycles: recorded.objective.cycles,
      });
      return true;
    };

    const common = { reviewId, owner: actor, reviewer: 'GPT' as const, decisionJson, diffHash, model, calls, costUsd: cost };
    switch (decision.decision) {
      case 'COMPLETE':
        return finish(repos.supervisor.decide({
          ...common, decision: 'COMPLETE', code: 'COMPLETE', reason: decision.summary,
          objectiveEffect: { kind: 'COMPLETE', result: completionResult(fresh, task, decision) },
        }), 'COMPLETE');
      case 'BLOCKED':
        return finish(repos.supervisor.decide({
          ...common, decision: 'BLOCKED', code: 'GPT_BLOCKED', reason: decision.blocked_reason ?? decision.summary,
          objectiveEffect: { kind: 'BLOCKED' },
        }), 'GPT_BLOCKED');
      case 'NEXT_TASK':
      case 'CORRECT': {
        const refused = childGuards({ repos, hermes, objective: fresh, task, decision });
        if (refused) {
          return guardDecision(refused, { reviewId, calls, costUsd: cost, model, decisionJson, reviewer: 'GPT' });
        }
        const child = buildChildTask({ objective: fresh, task, decision, reviewId });
        return finish(repos.supervisor.decide({
          ...common, decision: decision.decision, code: decision.decision, reason: decision.summary,
          objectiveEffect: { kind: 'CONTINUE', correction: decision.decision === 'CORRECT' },
          child: {
            task: child, claimKey: childClaimKey(fresh.objectiveId, fresh.cycles + 1),
            claimKind: SUPERVISOR_LEDGER.CHILD, claimedBy: actor,
          },
        }), decision.decision);
      }
    }
  }
}
