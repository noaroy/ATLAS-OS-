import type {
  AgentDefinition,
  DecisionKind,
  Mission,
  MissionPlan,
  MissionArtifact,
  MissionId,
  MissionOutcome,
  MissionResult,
  MissionTask,
} from '@atlas/contracts';
import { TERMINAL_MISSION_STATUSES } from '@atlas/contracts';
import type { AtlasConfig, EventBus, Logger } from '@atlas/core';
import {
  AtlasError,
  Mutex,
  describeError,
  invalidState,
  notFound,
  nowIso,
  formatDuration,
  withDeadline,
} from '@atlas/core';
import type { Repositories, RuntimeSettings } from '@atlas/data';
import type { AgentRuntime } from '@atlas/agents';
import type { BudgetError, BudgetLedger, BudgetLimits, LlmProvider } from '@atlas/llm';
import { DEFAULT_BUDGET_LIMITS, proportionalCallsPerStep, textOf, totalTokens, userText } from '@atlas/llm';
import type { MemoryService } from '@atlas/memory';
import { instantiatePlaybook, missionEconomics, type OpportunityService } from '@atlas/intelligence';
import { routeObjective } from '@atlas/departments';
import { MissionPlanner } from './planner.ts';
import { extractBrief } from './brief.ts';
import { chooseReasoning } from './reasoning.ts';

/**
 * Ne garde que le modèle et l'effort d'un choix de raisonnement.
 *
 * Le niveau (`tier`) sert au diagnostic, pas à l'appel : l'étaler dans une
 * requête d'inférence n'aurait aucun sens pour le fournisseur.
 */
function pick(choice: { model: string; effort: RuntimeSettings['llmEffort'] }): {
  model: string;
  effort: RuntimeSettings['llmEffort'];
} {
  return { model: choice.model, effort: choice.effort };
}

export interface HermesDeps {
  repos: Repositories;
  events: EventBus;
  memory: MemoryService;
  provider: LlmProvider;
  runtime: AgentRuntime;
  config: AtlasConfig;
  logger: Logger;
  settings: () => RuntimeSettings;
  /** The opportunity pipeline; null in a deployment with no department. */
  intelligence: OpportunityService | null;
  /**
   * La comptabilité budgétaire.
   *
   * L'orchestrateur n'y applique aucun plafond lui-même : il ouvre et ferme le
   * périmètre d'une mission, et c'est le provider décoré qui refuse les appels.
   * Le contrôle vit sous les appels, pas au-dessus — c'est ce déplacement qui
   * distingue ce plafond de celui que LIVE #001 a dépassé de 281 %.
   */
  ledger?: BudgetLedger | null;
}

export interface SubmitInput {
  title: string;
  objective: string;
  context?: Record<string, unknown>;
  priority?: Mission['priority'];
  tags?: string[];
  createdBy: string;
  autoStart?: boolean;
  parentId?: MissionId | null;
  /** Token ceiling for this mission; omit to use the deployment default. */
  tokenBudget?: number | null;
  /**
   * The department that owns this objective. Omit to let Hermes recognise it,
   * and pass null explicitly to force a generic mission.
   */
  departmentKey?: string | null;
}

interface ActiveMission {
  controller: AbortController;
  promise: Promise<void>;
  lock: Mutex;
}

/**
 * Hermes — the operations director (SRS §2.7, §4.4, §5.6).
 *
 * Owns the full mission cycle: receive an objective, analyse it, plan, choose
 * agents, dispatch, supervise, validate, synthesise, and learn. Agents never
 * talk to each other directly; every handoff passes through here, which is
 * what makes the whole organisation auditable.
 */
export class HermesEngine {
  #log: Logger;
  #planner: MissionPlanner;
  #active = new Map<MissionId, ActiveMission>();
  #queue: MissionId[] = [];
  #stopped = false;

  constructor(private readonly deps: HermesDeps) {
    this.#log = deps.logger.child({ scope: 'hermes' });
    this.#planner = new MissionPlanner(deps.provider, deps.memory, deps.logger);
  }

  // ─── Public surface ──────────────────────────────────────────────────────

  /** Receives an objective from the founder, a schedule, or another mission. */
  async submit(input: SubmitInput): Promise<Mission> {
    // A department is chosen explicitly by the founder, or recognised from the
    // objective. Recognition is a cheap keyword match, never a model call: it
    // runs on every mission, and the console lets the founder override it.
    const departmentKey =
      input.departmentKey !== undefined
        ? input.departmentKey
        : routeObjective(input.objective, this.deps.repos.departments.list(true));

    const mission = this.deps.repos.missions.create({
      title: input.title,
      objective: input.objective,
      context: input.context ?? {},
      priority: input.priority ?? 'normal',
      createdBy: input.createdBy,
      tags: input.tags ?? [],
      parentId: input.parentId ?? null,
      tokenBudget: input.tokenBudget ?? null,
      departmentKey,
    });

    this.deps.repos.messages.record({
      missionId: mission.id,
      from: input.createdBy === 'system' ? 'system' : 'founder',
      to: 'hermes',
      kind: 'assignment',
      objective: input.objective,
      payload: { title: input.title, priority: mission.priority },
      expectedOutput: 'A completed mission with a synthesised result',
    });

    this.deps.events.publish({
      type: 'mission.created',
      severity: 'info',
      source: 'hermes',
      missionId: mission.id,
      message: `Mission ${mission.code} received: ${mission.title}`,
      payload: {
        code: mission.code,
        priority: mission.priority,
        autoStart: input.autoStart !== false,
        department: departmentKey,
      },
    });

    if (input.autoStart !== false) this.start(mission.id);
    return mission;
  }

  /** Queues a mission for execution; the pump respects the concurrency limit. */
  start(missionId: MissionId): void {
    if (this.#stopped) throw invalidState('ATLAS is shutting down');
    if (this.#active.has(missionId) || this.#queue.includes(missionId)) return;

    const mission = this.deps.repos.missions.require(missionId);
    if (TERMINAL_MISSION_STATUSES.includes(mission.status)) {
      throw invalidState(`Mission ${mission.code} is ${mission.status} and cannot be started`);
    }

    this.#queue.push(missionId);
    this.#pump();
  }

  pause(missionId: MissionId): Mission {
    const active = this.#active.get(missionId);
    if (active) active.controller.abort();
    else this.#queue = this.#queue.filter((q) => q !== missionId);

    const mission = this.deps.repos.missions.transition(missionId, 'paused');
    this.deps.events.publish({
      type: 'mission.paused',
      severity: 'warning',
      source: 'hermes',
      missionId,
      message: `Mission ${mission.code} paused`,
      payload: {},
    });
    return mission;
  }

  cancel(missionId: MissionId, reason = 'Cancelled by the founder'): Mission {
    const active = this.#active.get(missionId);
    if (active) active.controller.abort();
    this.#queue = this.#queue.filter((q) => q !== missionId);

    this.deps.repos.missions.cancelPendingTasks(missionId, reason);
    const mission = this.deps.repos.missions.transition(missionId, 'failed', { error: reason });

    this.deps.events.publish({
      type: 'mission.failed',
      severity: 'warning',
      source: 'hermes',
      missionId,
      message: `Mission ${mission.code} cancelled`,
      payload: { reason },
    });
    return mission;
  }

  /** Re-plans and re-runs a failed mission from scratch. */
  retry(missionId: MissionId): Mission {
    const mission = this.deps.repos.missions.require(missionId);
    if (mission.status !== 'failed') {
      throw invalidState(`Only a failed mission can be retried (${mission.code} is ${mission.status})`);
    }
    const reset = this.deps.repos.missions.transition(missionId, 'planned', { error: null, progress: 0 });
    this.start(missionId);
    return reset;
  }

  /** Founder sign-off on a completed mission (SRS §2.10). */
  validate(missionId: MissionId, decidedBy: string): Mission {
    const mission = this.deps.repos.missions.transition(missionId, 'validated');
    this.deps.events.publish({
      type: 'mission.validated',
      severity: 'success',
      source: 'hermes',
      missionId,
      message: `Mission ${mission.code} validated`,
      payload: { decidedBy },
    });
    this.#reinforceAgentQuality(missionId, +3);
    return mission;
  }

  archive(missionId: MissionId): Mission {
    return this.deps.repos.missions.transition(missionId, 'archived');
  }

  isActive(missionId: MissionId): boolean {
    return this.#active.has(missionId);
  }

  get activeCount(): number {
    return this.#active.size;
  }

  get queuedCount(): number {
    return this.#queue.length;
  }

  /**
   * Recovers after a restart (SRS §2.15, §6.10).
   *
   * Any mission left mid-flight is re-queued and its in-progress tasks are
   * returned to the ready pool, so an unclean stop costs at most the work of
   * the steps that were actually running.
   */
  recover(): number {
    const interrupted = this.deps.repos.missions.listByStatus('running', 'assigned', 'planned');
    for (const mission of interrupted) {
      const requeued = this.deps.repos.missions.requeueUnfinishedTasks(mission.id);
      this.#log.info('resuming interrupted mission', { code: mission.code, requeued });
      this.deps.events.publish({
        type: 'mission.started',
        severity: 'warning',
        source: 'hermes',
        missionId: mission.id,
        message: `Resuming mission ${mission.code} after restart`,
        payload: { requeuedTasks: requeued },
      });
      this.#queue.push(mission.id);
    }
    this.#pump();
    return interrupted.length;
  }

  /** Stops accepting work and waits for in-flight missions to settle. */
  async shutdown(timeoutMs = 20_000): Promise<void> {
    this.#stopped = true;
    this.#queue = [];
    for (const active of this.#active.values()) active.controller.abort();

    await Promise.race([
      Promise.allSettled([...this.#active.values()].map((a) => a.promise)),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
  }

  // ─── Execution ───────────────────────────────────────────────────────────

  #pump(): void {
    const limit = this.deps.settings().maxConcurrentMissions;
    while (!this.#stopped && this.#active.size < limit && this.#queue.length > 0) {
      const missionId = this.#queue.shift()!;
      if (this.#active.has(missionId)) continue;

      const controller = new AbortController();
      const lock = new Mutex();

      // ── Borne de mission ──────────────────────────────────────────────────
      // Le dernier filet. Les délais d'outil et de fournisseur couvrent chacun
      // un appel ; celui-ci couvre l'enlisement — une succession d'appels
      // légitimes qui n'aboutit jamais. Il annule réellement, donc tout ce qui
      // est en vol s'arrête avec lui.
      const missionTimeoutMs = this.deps.config.orchestration.missionTimeoutMs;
      const missionTimer =
        missionTimeoutMs > 0
          ? setTimeout(() => {
              this.#log.warn('mission exceeded its wall-clock limit; cancelling', {
                missionId,
                missionTimeoutMs,
              });
              controller.abort();
            }, missionTimeoutMs)
          : null;

      const promise = this.#runMission(missionId, controller.signal)
        .catch((err) => {
          this.#log.error('mission crashed', { missionId, error: describeError(err) });
        })
        .finally(() => {
          if (missionTimer) clearTimeout(missionTimer);
          this.#active.delete(missionId);
          // Free the slot, then let the next mission in.
          if (!this.#stopped) this.#pump();
        });

      this.#active.set(missionId, { controller, promise, lock });
    }
  }

  async #runMission(missionId: MissionId, signal: AbortSignal): Promise<void> {
    const started = Date.now();
    let mission = this.deps.repos.missions.require(missionId);

    // Le périmètre budgétaire est ouvert avant le premier appel et fermé quoi
    // qu'il arrive : une mission interrompue ne doit pas laisser sa
    // comptabilité ouverte, sans quoi les plafonds fuiraient d'une mission à
    // la suivante.
    this.deps.ledger?.open(missionId, this.#limitsFor(mission));

    try {
      // ── Plan ────────────────────────────────────────────────────────────
      if (!mission.plan || this.deps.repos.missions.tasksFor(missionId).length === 0) {
        mission = await this.#planMission(mission, signal);
      }

      // Une annulation survenue *pendant* la planification doit tenir. Sans
      // cette vérification, le chemin de planification encore en vol remettait
      // la mission en marche après coup et effaçait la décision du fondateur.
      if (signal.aborted) {
        this.#log.info('mission cancelled during planning', { code: mission.code });
        return;
      }

      mission = this.deps.repos.missions.transition(missionId, 'running');
      this.deps.events.publish({
        type: 'mission.started',
        severity: 'info',
        source: 'hermes',
        missionId,
        message: `Mission ${mission.code} is running`,
        payload: { steps: this.deps.repos.missions.tasksFor(missionId).length },
      });

      // ── Dispatch ────────────────────────────────────────────────────────
      const { artifacts, budgetExhausted, replanned } = await this.#dispatchLoop(mission, signal);

      // ── Conclude ────────────────────────────────────────────────────────
      const tasks = this.deps.repos.missions.tasksFor(missionId);
      const failed = tasks.filter((t) => t.status === 'failed');
      const succeeded = tasks.filter((t) => t.status === 'succeeded');

      if (signal.aborted) {
        this.#log.info('mission halted', { code: mission.code });
        return;
      }

      if (succeeded.length === 0) {
        const reason = failed[0]?.error ?? 'No step produced a result';
        this.#failMission(missionId, reason);
        return;
      }

      const starved = tasks.filter(
        (t) => t.status === 'skipped' && (t.error ?? '').startsWith('SKIPPED_NO_INPUT'),
      );

      const result = await this.#synthesise(mission, tasks, artifacts, Date.now() - started, signal);
      result.budgetExhausted = budgetExhausted;

      // ── La conclusion, et ce sur quoi elle repose ────────────────────────
      // C'est la seule décision d'Hermès qui porte sur le monde plutôt que sur
      // l'organisation du travail. Elle doit donc citer les preuves qui la
      // soutiennent — et lorsqu'il n'y en a aucune, cela se voit dans le
      // journal au lieu de se deviner.
      const supporting = this.deps.repos.companies
        .evidenceForMission(mission.id)
        .filter((item) => !item.simulated)
        .map((item) => item.id);

      this.#decide({
        missionId: mission.id,
        kind: 'conclude',
        decision: `Mission ${mission.code} conclue : ${result.summary.slice(0, 160)}`,
        rationale:
          supporting.length > 0
            ? `${supporting.length} preuve(s) sourcée(s) soutiennent cette synthèse.`
            : "Aucune preuve sourcée : la synthèse rend compte du déroulement, pas d'un constat de marché.",
        evidenceIds: supporting,
        estimatedCostUsd: null,
        impact: `${starved.length} étape(s) sans entrée · ${tasks.filter((t) => t.status === 'succeeded').length}/${tasks.length} réussies`,
      });
      result.replanned = replanned;
      result.skippedForMissingInput = starved.map((t) => t.ref);
      result.outcome = this.#classifyOutcome({
        missionId,
        failed: failed.length,
        skippedForMissingInput: starved.length,
        budgetExhausted,
      });

      // ── Le statut doit dire si le pipeline a abouti ────────────────────────
      //
      // Toute mission se terminait en `completed`, y compris celle dont une
      // seule étape sur six avait réussi. Un opérateur lisait « terminée » pour
      // une mission arrêtée net par une garde, sans opportunité, sans revue —
      // et le tableau de bord la comptait dans son taux de réussite.
      //
      // La distinction n'est pas le résultat métier, c'est le déroulement.
      // Une mission qui cherche honnêtement et ne trouve rien a fait son
      // travail : elle est terminée, avec `no-result`. Une mission dont une
      // étape a été *annulée* par une garde n'est jamais allée au bout : elle
      // ne peut pas porter le même mot.
      const cancelled = tasks.filter((t) => t.status === 'cancelled');
      const reachedConclusion = cancelled.length === 0;

      const notes = [
        failed.length > 0 ? `${failed.length} step(s) failed` : null,
        cancelled.length > 0
          ? `${cancelled.length} étape(s) annulée(s) : ${cancelled.map((t) => t.ref).join(', ')}`
          : null,
        starved.length > 0 ? `${starved.length} étape(s) sautée(s) faute d'entrée` : null,
        budgetExhausted ? 'stopped at its token budget' : null,
      ].filter(Boolean);

      mission = this.deps.repos.missions.transition(
        missionId,
        reachedConclusion ? 'completed' : 'failed',
        {
          result,
          // Le progrès suit les étapes réellement terminées : afficher 100 %
          // pour une mission interrompue serait le même mensonge que
          // « completed ».
          progress: reachedConclusion ? 1 : tasks.filter((t) => t.status === 'succeeded').length / Math.max(1, tasks.length),
          error: notes.length > 0 ? notes.join('; ') : null,
        },
      );

      this.deps.events.publish({
        type: 'mission.completed',
        severity: reachedConclusion && failed.length === 0 ? 'success' : 'warning',
        source: 'hermes',
        missionId,
        // Le mot doit correspondre au statut réellement écrit : un journal qui
        // annonce « completed » pour une mission passée en échec est la
        // première chose qu'on relit après un incident, et la dernière qu'on
        // devrait avoir à corriger de tête.
        message: `Mission ${mission.code} ${reachedConclusion ? 'completed' : 'interrompue'}${
          notes.length ? ` (${notes.join('; ')})` : ''
        }`,
        payload: {
          quality: result.quality,
          durationMs: result.durationMs,
          artifacts: result.artifacts.length,
          failedSteps: failed.length,
          cancelledSteps: cancelled.map((t) => t.ref),
          reachedConclusion,
          outcome: result.outcome,
          skippedForMissingInput: result.skippedForMissingInput,
          budgetExhausted,
          replanned,
        },
      });

      this.#learn(mission, tasks, result);
      this.#reinforceAgentQuality(missionId, failed.length > 0 ? -1 : +1);
    } catch (err) {
      if (signal.aborted) return;
      this.#failMission(missionId, describeError(err));
    } finally {
      this.deps.ledger?.close(missionId);
    }
  }

  /**
   * Les plafonds applicables à cette mission.
   *
   * Le budget propre à la mission l'emporte sur le défaut du déploiement, et
   * les plafonds d'étape en découlent : une étape n'a jamais le droit de
   * consommer plus du tiers de la mission. C'est ce rapport qui manquait — la
   * seule étape d'enrichissement de LIVE #001 a consommé 343 % du budget total.
   */
  /** Les modèles entre lesquels la politique de raisonnement arbitre. */
  #reasoningModels(): { routine: string; strategic: string; effort: RuntimeSettings['llmEffort'] } {
    const settings = this.deps.settings();
    return {
      routine: settings.agentModel,
      strategic: settings.hermesModel,
      effort: settings.llmEffort,
    };
  }

  /**
   * Consigne une décision d'orchestration.
   *
   * Volontairement tolérante : si l'écriture échoue, la mission continue. Un
   * journal est un moyen de comprendre après coup, pas une condition de
   * fonctionnement — le perdre serait regrettable, faire échouer la mission
   * pour cela serait absurde.
   */
  #decide(input: {
    missionId: MissionId;
    taskRef?: string | null;
    kind: DecisionKind;
    decision: string;
    rationale: string;
    evidenceIds?: string[];
    estimatedCostUsd?: number | null;
    impact?: string | null;
  }): void {
    try {
      this.deps.repos.decisions.record(input);
    } catch (err) {
      this.#log.warn('decision not recorded', { error: describeError(err) });
    }
  }

  #limitsFor(mission: Mission): BudgetLimits {
    const settings = this.deps.settings();
    const missionTokens = mission.tokenBudget ?? settings.missionTokenBudget;
    const base = this.deps.config.budget ?? DEFAULT_BUDGET_LIMITS;

    // Une mission peut porter son propre plafond en dollars, dans son contexte.
    // Il ne peut que *resserrer* celui du déploiement, jamais l'élargir : un
    // pilote à 0,40 $ doit rester à 0,40 $ même si la configuration en autorise
    // cinq, et aucune mission ne doit pouvoir s'octroyer plus que le cadre.
    const declared = (mission.context as { budgetUsd?: unknown } | null)?.budgetUsd;
    const missionCostUsd =
      typeof declared === 'number' && Number.isFinite(declared) && declared > 0
        ? base.maxMissionCostUsd > 0
          ? Math.min(base.maxMissionCostUsd, declared)
          : declared
        : base.maxMissionCostUsd;

    return {
      ...base,
      maxMissionCostUsd: missionCostUsd,
      // Le plafond d'appels suit le travail réel : douze appels forfaitaires
      // ont laissé l'enrichissement de trois candidats en passer onze.
      maxCallsPerStep: proportionalCallsPerStep(
        this.deps.repos.opportunities.forMission(mission.id).length,
        base.maxCallsPerStep,
      ),
      maxMissionTokens: missionTokens > 0 ? missionTokens : 0,
      // ── Le plafond d'étape, en valeur absolue ──────────────────────────────
      //
      // Il était exprimé en fraction du budget de la mission — d'abord le
      // tiers, puis la moitié. Les deux ont cassé une mission qui avait encore
      // du budget :
      //
      //   LIVE-001  enrichissement refusé à 30 713/40 000, mission à 62 132/120 000
      //   VAL-001   enrichissement refusé à 27 597/40 000, mission à 53 153/80 000
      //
      // Déplacer la fraction ne corrigeait pas la nature du défaut. **Un
      // plafond d'étape exprimé en fraction du plafond de mission bindera
      // toujours en premier dès qu'une étape domine** — et l'enrichissement
      // domine par construction, puisqu'il analyse chaque candidat. Une garde
      // qui fait échouer le pipeline en laissant un tiers du budget inutilisé
      // ne protège pas ce budget, elle le gaspille.
      //
      // Le plafond redevient donc absolu : la valeur configurée, jamais plus
      // que la mission entière — une étape ne peut de toute façon pas dépasser
      // ce que la mission a le droit de dépenser.
      //
      // Ce que cela protège encore : une étape pathologique dans une grande
      // mission. LIVE #001 a consommé 1 372 673 jetons dans une seule étape ;
      // sous ce plafond elle s'arrêtait à 120 000. Ce que cela cesse de faire :
      // couper une étape normale dans une petite mission, où c'est le plafond
      // de mission — vérifié avant *chaque* appel — qui est la vraie barrière.
      maxStepTokens:
        base.maxStepTokens > 0
          ? missionTokens > 0
            ? Math.min(base.maxStepTokens, missionTokens)
            : base.maxStepTokens
          : 0,
    };
  }

  async #planMission(mission: Mission, signal: AbortSignal): Promise<Mission> {
    const settings = this.deps.settings();

    // Who may receive a mission step is answered by a declared mandate, so
    // a future transverse specialist is included or excluded by its own
    // definition rather than by a rule hard-coded here.
    const agents = this.deps.repos.agents.listByMandate('mission-execution');

    if (agents.length === 0) {
      throw new AtlasError(
        'INVALID_STATE',
        'No enabled agent carries the mission-execution mandate',
      );
    }

    const outcome = mission.departmentKey
      ? await this.#planFromDepartment(mission, agents, signal)
      : await this.#planner.plan({
          mission,
          agents,
          ...pick(chooseReasoning('plan', this.#reasoningModels())),
          maxTokens: this.deps.config.llm.maxTokens,
          signal,
        });

    this.deps.repos.missions.addTokens(mission.id, outcome.tokensUsed);
    this.deps.repos.missions.replaceTasks(
      mission.id,
      outcome.plan.steps.map((step) => ({
        ref: step.ref,
        title: step.title,
        agentKey: step.agentKey,
        action: step.action,
        instruction: step.instruction,
        input: { ...step.input, expectedOutput: step.expectedOutput },
        dependsOn: step.dependsOn,
        preconditions: step.preconditions ?? [],
        maxAttempts: settings.taskMaxAttempts,
      })),
    );

    // Record the assignment for every specialist, so the audit trail shows who
    // was asked to do what before any work begins.
    for (const step of outcome.plan.steps) {
      this.deps.repos.messages.record({
        missionId: mission.id,
        from: 'hermes',
        to: step.agentKey,
        kind: 'assignment',
        objective: step.title,
        payload: { ref: step.ref, action: step.action, dependsOn: step.dependsOn },
        expectedOutput: step.expectedOutput,
      });
    }

    // Une annulation reçue pendant la planification est définitive : le plan
    // est conservé — il a été payé — mais le cycle de vie n'avance plus. Sans
    // cela, le travail encore en vol faisait repasser une mission annulée en
    // « planned », puis en « running », effaçant la décision du fondateur.
    if (signal.aborted) {
      this.deps.repos.missions.savePlan(mission.id, outcome.plan);
      throw new AtlasError('TIMEOUT', `Mission ${mission.code} cancelled during planning`, {
        retryable: false,
      });
    }

    // The plan is recorded independently of the lifecycle, so a mission
    // recovered mid-flight can be replanned while it is already running.
    this.deps.repos.missions.savePlan(mission.id, outcome.plan);
    const planned =
      this.deps.repos.missions.require(mission.id).status === 'running'
        ? this.deps.repos.missions.require(mission.id)
        : this.deps.repos.missions.transition(mission.id, 'planned');

    this.deps.events.publish({
      type: 'mission.planned',
      severity: outcome.degraded ? 'warning' : 'info',
      source: 'hermes',
      missionId: mission.id,
      message: outcome.degraded
        ? `Mission ${mission.code} planned with the fallback decomposition`
        : `Hermes planned mission ${mission.code} in ${outcome.plan.steps.length} step(s)`,
      payload: {
        steps: outcome.plan.steps.map((s) => ({ ref: s.ref, agent: s.agentKey, title: s.title })),
        rationale: outcome.plan.rationale,
        degraded: outcome.degraded,
      },
    });

    return planned;
  }

  /**
   * Plans a mission that belongs to a department (Article IV).
   *
   * Two things happen that a generic mission does not get: the objective is
   * first turned into the department's structured brief, and the plan comes
   * from the department's declared method rather than from Hermes improvising
   * a decomposition. Hermes still owns everything after this — dispatch,
   * supervision, replanning, synthesis — which is the division of labour a CEO
   * has with a division that owns its own process (Article III).
   */
  async #planFromDepartment(
    mission: Mission,
    agents: AgentDefinition[],
    signal: AbortSignal,
  ): Promise<{ plan: MissionPlan; tokensUsed: number; degraded: boolean }> {
    const settings = this.deps.settings();
    const department = this.deps.repos.departments.require(mission.departmentKey!);

    // A resumed mission already has its brief; re-extracting would cost tokens
    // and risk a different reading of the same objective.
    const existing = (mission.context as { brief?: Record<string, unknown> }).brief;
    const outcome = existing
      ? { brief: existing, tokensUsed: 0, degraded: false }
      : await extractBrief({
          mission,
          department,
          provider: this.deps.provider,
          // Structurer un objectif est un travail de lecture, pas d'arbitrage.
          // Le modèle premium n'y apporte rien et rendait chaque petite mission
          // incompatible avec un budget serré.
          ...pick(chooseReasoning('brief', this.#reasoningModels())),
          maxTokens: this.deps.config.llm.maxTokens,
          signal,
          logger: this.#log,
        });

    if (!existing) {
      this.deps.repos.missions.setContext(mission.id, { ...mission.context, brief: outcome.brief });
      this.deps.events.publish({
        type: 'department.brief',
        severity: outcome.degraded ? 'warning' : 'info',
        source: 'hermes',
        missionId: mission.id,
        message: outcome.degraded
          ? `Hermes could not fully read the objective for ${mission.code}; using the stated fields only`
          : `Hermes read ${mission.code} as ${department.name} work`,
        payload: { department: department.key, brief: outcome.brief, degraded: outcome.degraded },
      });
    }

    const plan = instantiatePlaybook({
      playbook: department.playbook,
      brief: outcome.brief,
      agents,
      departmentName: department.name,
      producedBy: `department:${department.key}`,
      producedAt: nowIso(),
    });

    this.#decide({
      missionId: mission.id,
      kind: 'plan',
      decision: `Méthode du département « ${department.name} » : ${plan.steps.length} étape(s).`,
      rationale: outcome.degraded
        ? "Le brief n'a pas pu être extrait ; le plan retient les champs déclarés tels quels."
        : "L'objectif relève de ce département, dont la méthode est déclarée et éprouvée. " +
          'Improviser une décomposition coûterait un raisonnement pour un résultat moins vérifiable.',
      estimatedCostUsd: null,
      impact: plan.steps.map((step) => `${step.ref}→${step.agentKey}`).join(', '),
    });

    // L'allocation est une décision à part entière : qui reçoit quoi, et
    // pourquoi ce spécialiste plutôt qu'un autre.
    for (const step of plan.steps) {
      this.#decide({
        missionId: mission.id,
        taskRef: step.ref,
        kind: 'allocation',
        decision: `${step.ref} confiée à ${step.agentKey}.`,
        rationale: `L'étape demande la compétence portée par ce spécialiste dans la méthode du département.`,
        impact: step.title,
      });
    }

    return { plan, tokensUsed: outcome.tokensUsed, degraded: outcome.degraded };
  }

  /**
   * Runs steps as their dependencies clear, up to the task concurrency limit.
   *
   * The loop is dependency-driven rather than sequential: independent steps
   * genuinely run at the same time, which is what the parallel journeys in the
   * village are showing.
   */
  async #dispatchLoop(
    mission: Mission,
    signal: AbortSignal,
  ): Promise<{ artifacts: MissionArtifact[]; budgetExhausted: boolean; replanned: boolean }> {
    const artifacts: MissionArtifact[] = [];
    const inFlight = new Map<string, Promise<void>>();
    const repos = this.deps.repos;

    /**
     * Levé par la première étape à qui le registre refuse un appel.
     *
     * Le plafond agit désormais sous les appels, donc l'arrêt commence à
     * l'intérieur d'une étape et doit remonter jusqu'ici. Sans ce relais, un
     * refus budgétaire ressemblerait à une panne d'agent et déclencherait des
     * retries — c'est-à-dire exactement la dépense que le refus vient d'éviter.
     */
    const refused = { hit: false };
    let budgetExhausted = false;
    let replanned = false;
    /** Refs whose permanent failure has already been considered for replanning. */
    const replanConsidered = new Set<string>();

    repos.missions.refreshReadyTasks(mission.id);

    while (!signal.aborted) {
      const settings = this.deps.settings();
      const limit = settings.maxConcurrentTasks;

      // Les plafonds qui dépendent du travail réel sont recalculés ici, entre
      // deux vagues. Le nombre d'appels que mérite une étape suit le nombre de
      // candidats, et il n'y en avait aucun à l'ouverture de la mission : figé
      // au démarrage, ce plafond serait resté forfaitaire — et c'est un plafond
      // forfaitaire qui a laissé l'enrichissement passer onze appels pour trois
      // candidats. Le dépensé n'est jamais remis à zéro par ce réajustement.
      this.deps.ledger?.retune(mission.id, this.#limitsFor(repos.missions.require(mission.id)));

      // ── Cost ceiling ──────────────────────────────────────────────────
      // Checked before dispatching, never mid-step: a step already running is
      // allowed to finish so its work is not wasted.
      if (refused.hit || this.#budgetExceeded(mission, settings.missionTokenBudget)) {
        budgetExhausted = true;
        const cancelled = repos.missions.cancelPendingTasks(
          mission.id,
          'Stopped early: the mission reached its token budget',
        );

        // La décision qui coûte le plus cher est celle de continuer. Elle est
        // donc consignée avec ce qu'elle a évité, pas seulement ce qu'elle a
        // interrompu.
        this.#decide({
          missionId: mission.id,
          kind: 'budget',
          decision: `Mission arrêtée : plafond atteint. ${cancelled} étape(s) annulée(s).`,
          rationale:
            refused.hit
              ? "Un appel a été refusé avant d'être émis : le plafond de dépense est atteint. " +
                'Le travail déjà accompli est conservé.'
              : 'Le budget de jetons de la mission est épuisé. Poursuivre coûterait sans garantie de résultat.',
          impact: `${cancelled} étape(s) non exécutée(s)`,
        });
        this.deps.events.publish({
          type: 'mission.budget-exhausted',
          severity: 'warning',
          source: 'hermes',
          missionId: mission.id,
          message: `Mission ${mission.code} reached its token budget and stopped cleanly`,
          payload: {
            tokensUsed: repos.missions.tokensUsed(mission.id),
            budget: mission.tokenBudget ?? settings.missionTokenBudget,
            cancelledSteps: cancelled,
          },
        });
        repos.ops.raiseAlertOnce({
          level: 'warning',
          title: `Budget reached: ${mission.title}`,
          detail: `Mission ${mission.code} stopped after using its full token budget. Any completed steps are kept.`,
          source: 'hermes',
        });
        break;
      }

      const tasks = repos.missions.tasksFor(mission.id);
      const ready = tasks.filter((t) => t.status === 'ready');

      while (ready.length > 0 && inFlight.size < limit) {
        // Re-check per step, not once per round: with several steps ready at
        // once, checking only between rounds would let a whole batch start
        // after the ceiling was already reached.
        if (refused.hit || this.#budgetExceeded(mission, settings.missionTokenBudget)) break;

        const task = ready.shift()!;
        const promise = this.#executeTask(mission, task, artifacts, signal, refused).finally(() => {
          inFlight.delete(task.id);
        });
        inFlight.set(task.id, promise);
      }

      if (inFlight.size === 0) {
        // ── Replanning ──────────────────────────────────────────────────
        // Nothing is running. If a step that others depended on has failed for
        // good, the rest of the plan is now built on a result that will never
        // arrive — so Hermes reconsiders the remainder rather than marching on.
        const blocking = this.#findPlanBreakingFailure(mission.id, replanConsidered);
        if (blocking) {
          // Consider each failure once, whether or not replanning goes ahead,
          // so a refused replan can never spin the loop.
          replanConsidered.add(blocking.ref);
          if (await this.#tryReplan(mission, blocking, signal)) {
            replanned = true;
            continue;
          }
        }

        const unlocked = repos.missions.refreshReadyTasks(mission.id);
        if (unlocked.length === 0) {
          const remaining = repos.missions
            .tasksFor(mission.id)
            .some((t) => t.status === 'ready' || t.status === 'pending');
          if (!remaining) break;
        }
        continue;
      }

      await Promise.race(inFlight.values());
      repos.missions.refreshReadyTasks(mission.id);

      const progress = repos.missions.computeProgress(mission.id);
      repos.missions.setProgress(mission.id, progress);
      this.deps.events.publish({
        type: 'mission.progress',
        severity: 'debug',
        source: 'hermes',
        missionId: mission.id,
        message: `Mission ${mission.code} ${Math.round(progress * 100)}% complete`,
        payload: { progress },
      });
    }

    await Promise.allSettled(inFlight.values());
    return { artifacts, budgetExhausted, replanned };
  }

  /**
   * Whether the mission has spent its allowance.
   *
   * A mission's own budget wins; `0` means unlimited, and a missing budget
   * falls back to the deployment default.
   */
  #budgetExceeded(mission: Mission, defaultBudget: number): boolean {
    const budget = mission.tokenBudget ?? defaultBudget;
    if (!budget || budget <= 0) return false;
    return this.deps.repos.missions.tokensUsed(mission.id) >= budget;
  }

  /**
   * Ce qui manque à une étape pour valoir la peine d'être lancée, ou `null`.
   *
   * Volontairement séparé de `dependsOn`, qui ne répond qu'à « l'étape amont
   * s'est-elle terminée ? ». Une étape peut se terminer avec succès en
   * rapportant honnêtement qu'elle n'a rien trouvé — et c'est exactement ce
   * qui s'est produit pendant LIVE #001.
   */
  #unmetPrecondition(mission: Mission, task: MissionTask): string | null {
    const repos = this.deps.repos;

    for (const rule of task.preconditions ?? []) {
      if (rule.kind === 'upstream-output') {
        const tasks = repos.missions.tasksFor(mission.id);
        for (const ref of rule.refs ?? []) {
          const upstream = tasks.find((t) => t.ref === ref);
          const produced =
            upstream?.status === 'succeeded' &&
            upstream.output !== null &&
            Object.keys(upstream.output).length > 0;
          if (!produced) return `${rule.because} (étape « ${ref} » sans résultat exploitable)`;
        }
        continue;
      }

      if (rule.kind === 'pipeline-count') {
        const funnel = repos.opportunities.funnelFor(mission.id) as Record<string, number>;
        // Sans étape précisée, on compte tout ce qui reste actionnable : une
        // candidature rejetée n'est pas de la matière pour l'étape suivante.
        const count = rule.atStage
          ? (funnel[rule.atStage] ?? 0)
          : Object.entries(funnel)
              .filter(([stage]) => stage !== 'rejected')
              .reduce((sum, [, n]) => sum + n, 0);

        const required = rule.minCount ?? 1;
        if (count < required) {
          return `${rule.because} (${count} élément(s) disponible(s), ${required} requis)`;
        }
      }
    }
    return null;
  }

  /**
   * Ce que la mission a réellement donné, indépendamment de son statut.
   *
   * LIVE #001 est resté « completed » après avoir coûté 9,15 $ pour zéro
   * candidat. L'issue répond à la question que le statut esquive.
   */
  #classifyOutcome(input: {
    missionId: MissionId;
    failed: number;
    skippedForMissingInput: number;
    budgetExhausted: boolean;
  }): MissionOutcome {
    if (input.budgetExhausted) return 'cancelled-budget';

    // Une étape sautée faute d'entrée n'est pas une panne : c'est le pipeline
    // qui s'est arrêté honnêtement. Le distinguer d'un échec est ce qui évite
    // de pousser ATLAS à remplir une liste pour avoir l'air d'avoir réussi.
    const opportunities = this.deps.repos.opportunities.forMission(input.missionId);
    if (input.skippedForMissingInput > 0 && opportunities.length === 0) return 'no-result';
    if (input.failed > 0 || input.skippedForMissingInput > 0) return 'partial';
    return 'success';
  }

  /**
   * Finds a permanently failed step that other steps were depending on.
   *
   * Only such a failure invalidates the plan. A failed leaf step is a gap in
   * the result, not a broken plan, and does not justify replanning.
   */
  #findPlanBreakingFailure(missionId: MissionId, considered: Set<string>): MissionTask | null {
    const tasks = this.deps.repos.missions.tasksFor(missionId);
    for (const task of tasks) {
      if (task.status !== 'failed' || considered.has(task.ref)) continue;
      const hasDependants = tasks.some((other) => other.dependsOn.includes(task.ref));
      if (hasDependants) return task;
    }
    return null;
  }

  async #executeTask(
    mission: Mission,
    task: MissionTask,
    artifacts: MissionArtifact[],
    signal: AbortSignal,
    refused: { hit: boolean },
  ): Promise<void> {
    const repos = this.deps.repos;
    const agent = repos.agents.getDefinition(task.agentKey);

    if (!agent || !agent.enabled) {
      repos.missions.setTaskStatus(task.id, 'failed', {
        error: `Agent '${task.agentKey}' is unavailable`,
        incrementAttempt: true,
      });
      return;
    }

    // ── Préconditions ─────────────────────────────────────────────────────
    // Avant toute chose, et surtout avant le moindre appel au modèle. C'est le
    // correctif direct de LIVE #001 : la découverte s'était terminée « avec
    // succès » sans produire un seul candidat, l'enrichissement avait été
    // lancé quand même, et faute d'entrée il a improvisé pendant douze minutes
    // pour 1,37 million de jetons. Une étape privée de sa matière est sautée,
    // pas confiée à un agent qui trouvera toujours quelque chose à faire.
    const unmet = this.#unmetPrecondition(mission, task);
    if (unmet) {
      repos.missions.setTaskStatus(task.id, 'skipped', { error: `SKIPPED_NO_INPUT — ${unmet}` });

      // Arrêter une branche sans entrée est la décision la plus rentable
      // qu'ATLAS prenne : c'est elle qui a empêché l'enrichissement de
      // LIVE #001 de consommer 343 % du budget de la mission pour documenter
      // une liste vide.
      this.#decide({
        missionId: mission.id,
        taskRef: task.ref,
        kind: 'stop-branch',
        decision: `Étape ${task.ref} non lancée.`,
        rationale: unmet,
        impact: "Aucun appel de modèle engagé pour une étape sans matière.",
      });
      this.deps.events.publish({
        type: 'task.skipped',
        severity: 'warning',
        source: 'hermes',
        missionId: mission.id,
        agentKey: agent.key,
        message: `Étape « ${task.title} » sautée : ${unmet}`,
        payload: { taskRef: task.ref, reason: unmet, cause: 'missing-input' },
      });
      this.#log.info('step skipped for missing input', { code: mission.code, ref: task.ref });
      return;
    }

    repos.missions.setTaskStatus(task.id, 'running', { incrementAttempt: true });

    /** Set only when the step is abandoned for good, never on a retry. */
    let permanentFailure: string | undefined;

    // The agent collects the assignment and travels to its building — a real
    // state change the village renders.
    this.#setAgentDispatched(agent, mission, task);

    this.deps.events.publish({
      type: 'task.started',
      severity: 'info',
      source: 'hermes',
      missionId: mission.id,
      agentKey: agent.key,
      message: `${agent.name} started "${task.title}"`,
      payload: { taskRef: task.ref, action: task.action, attempt: task.attempts + 1 },
    });

    try {
      const upstream = this.#upstreamOutputs(mission.id, task);

      // ── Borne d'étape ─────────────────────────────────────────────────────
      // Le niveau qui manquait à l'appel : les délais d'outil et de fournisseur
      // bornent chacun *un* appel, celui-ci borne la boucle entière. Sans lui,
      // une étape pouvait enchaîner indéfiniment des appels individuellement
      // dans les temps.
      const result = await withDeadline(
        (stepSignal) =>
          this.deps.runtime.run({
            agent,
            mission,
            task,
            upstream,
            upstreamFailures: this.#upstreamFailures(mission.id, task),
            signal: stepSignal,
            onPhase: (phase) => this.#setAgentPhase(agent, phase, task),
          }),
        {
          ms: this.deps.config.orchestration.taskTimeoutMs,
          label: `étape ${task.ref}`,
          signal,
          onOrphan: (label) => this.#log.error("une étape n'a pas honoré son annulation", { label }),
        },
      );

      // ── Une étape qui n'a rien pu faire n'a pas réussi ───────────────────
      // Un agent termine toujours par du texte, y compris lorsque chacun de ses
      // outils l'a refusé — et ce texte conclut volontiers que « l'étape a
      // produit un résultat exploitable ». La démonstration locale l'a montré :
      // `discover_companies` rejetait des rôles inconnus du département, aucun
      // candidat n'était enregistré, et l'étape s'affichait en vert pendant que
      // les cinq suivantes étaient sautées faute d'entrée. Le tableau de bord
      // montrait alors une réussite et un blocage inexplicable côte à côte.
      //
      // Zéro appel d'outil reste légitime : toutes les étapes n'en demandent
      // pas. Ce qui ne l'est pas, c'est de n'avoir passé que des appels refusés.
      if (result.toolCalls > 0 && result.toolFailures === result.toolCalls) {
        throw new AtlasError(
          'PROVIDER_ERROR',
          `Aucun des ${result.toolCalls} appel(s) d'outil de cette étape n'a abouti ; ` +
            "elle ne peut pas être tenue pour réussie. Dernier compte rendu de l'agent : " +
            result.summary.slice(0, 300),
          // Rejouer à l'identique une étape dont tous les outils ont refusé
          // coûterait autant et n'apprendrait rien : c'est la leçon que
          // LIVE #004 a payée deux fois.
          { retryable: false },
        );
      }

      artifacts.push(...result.artifacts);
      repos.missions.setTaskStatus(task.id, 'succeeded', {
        output: { ...result.output, artifacts: result.artifacts },
        tokensUsed: result.tokensUsed,
        durationMs: result.durationMs,
        error: null,
      });
      repos.missions.addTokens(mission.id, result.tokensUsed);
      repos.buildings.recordActivity(agent.building, 1);

      repos.messages.record({
        missionId: mission.id,
        taskId: task.id,
        from: agent.key,
        to: 'hermes',
        kind: 'result',
        objective: task.title,
        payload: { summary: result.summary.slice(0, 2000), toolCalls: result.toolCalls },
        status: 'answered',
      });

      this.deps.events.publish({
        type: 'task.succeeded',
        severity: 'success',
        source: agent.key,
        missionId: mission.id,
        agentKey: agent.key,
        message: `${agent.name} finished "${task.title}" in ${formatDuration(result.durationMs)}`,
        payload: {
          taskRef: task.ref,
          tokensUsed: result.tokensUsed,
          toolCalls: result.toolCalls,
          artifacts: result.artifacts.length,
        },
      });
    } catch (err) {
      const error = describeError(err);

      // ── Refus budgétaire ────────────────────────────────────────────────
      // Ce n'est pas une défaillance de l'agent : le plafond a fait son
      // travail. L'étape est annulée plutôt que mise en échec, aucun retry
      // n'est tenté — réessayer coûterait ce que le refus vient d'éviter — et
      // la mission s'arrête proprement au lieu de brûler ce qui lui reste en
      // relançant la même étape trois fois.
      if (err instanceof AtlasError && err.code === 'BUDGET_EXCEEDED') {
        refused.hit = true;
        repos.missions.setTaskStatus(task.id, 'cancelled', { error });

        // « refused by the budget » a coûté une enquête entière : le message ne
        // disait ni quelle garde s'était déclenchée ni sur quelle valeur, et
        // l'on a cherché du côté du plafond en dollars — 0,0652 $ sur 0,40 $ —
        // alors que le refus venait du plafond de l'étape. On doit pouvoir lire
        // « X > Y » sans ouvrir le code.
        const budget = (err as BudgetError).budget;

        this.deps.events.publish({
          type: 'mission.budget-refused',
          severity: 'warning',
          source: 'hermes',
          missionId: mission.id,
          agentKey: agent.key,
          message: `Appel refusé pour ${mission.code} : ${error}`,
          payload: { taskRef: task.ref, reason: error, budget: budget ?? null },
        });
        this.#log.warn('llm call refused by the budget', {
          code: mission.code,
          ref: task.ref,
          ...(budget
            ? {
                budgetGuard: budget.guard,
                current: budget.current,
                limit: budget.limit,
                projected: budget.projected,
                remaining: budget.remaining,
                unit: budget.unit,
                reason: budget.reason,
              }
            : {}),
        });
        return;
      }

      const attempts = task.attempts + 1;
      const retryable = err instanceof AtlasError ? err.retryable : true;
      const canRetry = retryable && attempts < task.maxAttempts && !signal.aborted;

      repos.missions.setTaskStatus(task.id, canRetry ? 'ready' : 'failed', { error });

      this.deps.events.publish({
        type: canRetry ? 'task.retrying' : 'task.failed',
        severity: canRetry ? 'warning' : 'error',
        source: agent.key,
        missionId: mission.id,
        agentKey: agent.key,
        message: canRetry
          ? `${agent.name} will retry "${task.title}" (attempt ${attempts + 1}/${task.maxAttempts})`
          : `${agent.name} failed "${task.title}": ${error}`,
        payload: { taskRef: task.ref, error, attempts },
      });

      if (!canRetry) {
        repos.ops.raiseAlertOnce({
          level: 'warning',
          title: `Step failed: ${task.title}`,
          detail: `${agent.name} could not complete this step of ${mission.code}. ${error}`,
          source: 'hermes',
        });
        repos.buildings.setStatus(agent.building, 'alert');
        this.#reinforceAgentQuality(mission.id, -2, agent.key);
        // A permanent failure leaves the agent visibly in error, unlike a
        // retry, which is an ordinary part of doing the work.
        permanentFailure = error;
      }
    } finally {
      this.#settleAgent(agent, permanentFailure ? 'error' : 'available', permanentFailure);
    }
  }

  /**
   * Replans the unfinished remainder after a step the plan depended on failed.
   *
   * Bounded on purpose (SRS §3.12): replanning is capped per mission, keeps
   * everything that already succeeded, and is recorded as an event so the
   * founder can see that Hermes changed its mind and why.
   */
  async #tryReplan(mission: Mission, failed: MissionTask, signal: AbortSignal): Promise<boolean> {
    const settings = this.deps.settings();
    const repos = this.deps.repos;

    if (settings.maxReplansPerMission <= 0) return false;

    const current = repos.missions.require(mission.id);
    if (current.replanCount >= settings.maxReplansPerMission) {
      this.#log.info('replan limit reached', {
        code: mission.code,
        replans: current.replanCount,
      });
      return false;
    }
    if (this.#budgetExceeded(current, settings.missionTokenBudget)) return false;

    const tasks = repos.missions.tasksFor(mission.id);
    const succeeded = tasks.filter((t) => t.status === 'succeeded');
    const abandoned = tasks.filter((t) => ['failed', 'skipped', 'cancelled'].includes(t.status));

    const agents = repos.agents.listByMandate('mission-execution');
    if (agents.length === 0) return false;

    const outcome = await this.#planner.replan({
      mission: current,
      agents,
      completed: succeeded.map((t) => ({
        ref: t.ref,
        title: t.title,
        agentKey: t.agentKey,
        summary: summaryOf(t.output).slice(0, 1500),
      })),
      abandoned: abandoned.map((t) => ({
        ref: t.ref,
        title: t.title,
        agentKey: t.agentKey,
        error: t.error ?? 'unknown',
      })),
      failedStep: { ref: failed.ref, title: failed.title, error: failed.error ?? 'unknown' },
      // Reconsidérer un plan après un échec est un vrai arbitrage : c'est là
      // que le modèle premium gagne sa place.
      ...pick(chooseReasoning('replan', this.#reasoningModels())),
      maxTokens: this.deps.config.llm.maxTokens,
      signal,
    });

    repos.missions.addTokens(mission.id, outcome.tokensUsed);

    // Hermes may legitimately conclude that nothing more can usefully be done.
    if (outcome.plan.steps.length === 0) {
      this.#log.info('replan produced no further steps', { code: mission.code });
      return false;
    }

    repos.missions.replaceUnfinishedTasks(
      mission.id,
      outcome.plan.steps.map((step) => ({
        ref: step.ref,
        title: step.title,
        agentKey: step.agentKey,
        action: step.action,
        instruction: step.instruction,
        input: { ...step.input, expectedOutput: step.expectedOutput },
        dependsOn: step.dependsOn,
        preconditions: step.preconditions ?? [],
        maxAttempts: settings.taskMaxAttempts,
      })),
    );

    const replans = repos.missions.incrementReplanCount(mission.id);

    for (const step of outcome.plan.steps) {
      repos.messages.record({
        missionId: mission.id,
        from: 'hermes',
        to: step.agentKey,
        kind: 'assignment',
        objective: step.title,
        payload: { ref: step.ref, action: step.action, replan: replans },
        expectedOutput: step.expectedOutput,
      });
    }

    this.deps.events.publish({
      type: 'mission.replanned',
      severity: 'warning',
      source: 'hermes',
      missionId: mission.id,
      message: `Hermes replanned ${mission.code} after "${failed.title}" failed`,
      payload: {
        replanCount: replans,
        trigger: { ref: failed.ref, error: failed.error },
        rationale: outcome.plan.rationale,
        steps: outcome.plan.steps.map((s) => ({ ref: s.ref, agent: s.agentKey, title: s.title })),
      },
    });

    return true;
  }

  /** Collects the outputs this step declared it depends on. */
  #upstreamOutputs(missionId: MissionId, task: MissionTask): Record<string, unknown> {
    if (task.dependsOn.length === 0) return {};
    const byRef = new Map(this.deps.repos.missions.tasksFor(missionId).map((t) => [t.ref, t]));
    const upstream: Record<string, unknown> = {};
    for (const ref of task.dependsOn) {
      const dep = byRef.get(ref);
      if (dep?.output) upstream[ref] = dep.output;
    }
    return upstream;
  }

  /**
   * Les étapes amont qui n'ont rien livré.
   *
   * Transmises explicitement à l'agent, avec l'interdiction d'en refaire le
   * travail. Sans cela il se comporte exactement comme l'Explorateur de
   * LIVE #001 : ne recevant pas la liste de candidats attendue, il en a
   * reconstitué une lui-même — hors pipeline, à la main, pour 8,24 $. Un
   * agent consciencieux comble un vide ; c'est à l'orchestrateur de lui dire
   * que ce vide ne le regarde pas.
   */
  #upstreamFailures(
    missionId: MissionId,
    task: MissionTask,
  ): Array<{ ref: string; title: string; status: string; error: string | null }> {
    if (task.dependsOn.length === 0) return [];
    const byRef = new Map(this.deps.repos.missions.tasksFor(missionId).map((t) => [t.ref, t]));
    const failures = [];
    for (const ref of task.dependsOn) {
      const dep = byRef.get(ref);
      if (!dep) continue;
      const empty = !dep.output || Object.keys(dep.output).length === 0;
      if (dep.status === 'succeeded' && !empty) continue;
      failures.push({
        ref,
        title: dep.title,
        status: dep.status,
        error: dep.error,
      });
    }
    return failures;
  }

  // ─── Synthesis and learning (SRS §5.6, steps 6–7) ────────────────────────

  /**
   * Consolidates the mission into one answer for the founder. Hermes reviews
   * the whole run — this is the "validation" half of its supervision role.
   */
  async #synthesise(
    mission: Mission,
    tasks: MissionTask[],
    artifacts: MissionArtifact[],
    durationMs: number,
    signal: AbortSignal,
  ): Promise<MissionResult> {
    const succeeded = tasks.filter((t) => t.status === 'succeeded');
    const failed = tasks.filter((t) => t.status === 'failed');
    // Sautées faute d'entrée : ce n'est pas un échec, c'est le pipeline qui
    // s'est arrêté honnêtement. Hermès doit le dire ainsi, sinon le rapport
    // laisse croire à une panne — ou pire, passe la chose sous silence.
    const starved = tasks.filter(
      (t) => t.status === 'skipped' && (t.error ?? '').startsWith('SKIPPED_NO_INPUT'),
    );
    const settings = this.deps.settings();

    const outputs: Record<string, unknown> = {};
    for (const task of succeeded) outputs[task.ref] = task.output;

    const digest = succeeded
      .map((t) => `## ${t.ref} — ${t.title} (${t.agentKey})\n${summaryOf(t.output).slice(0, 3000)}`)
      .join('\n\n');

    // A department mission produced structured results, not only prose. Hermes
    // reports against those rather than against the agents' own accounts of
    // what they did — the shortlist is a fact in the database.
    const pipeline = this.#pipelineOutcome(mission);

    let summary = '';
    let quality = failed.length === 0 ? 80 : 60;
    let tokensUsed = 0;

    try {
      const response = await this.deps.provider.complete({
        model: settings.hermesModel,
        system: [
          "Vous êtes Hermès, directeur des opérations d'ATLAS. Une mission vient de s'achever et vous rendez compte au fondateur.",
          '',
          "Commencez par la réponse à l'objectif. Puis le raisonnement qui la soutient, puis ce que le fondateur doit décider ou ce qui reste ouvert.",
          "Attribuez chaque constat à l'étape qui l'a produit. Nommez les manques comme des manques — ne lissez pas une étape en échec.",
          "Jugez aussi la qualité de cette exécution de 0 à 100, où 100 signifie que l'objectif a été pleinement et solidement atteint.",
          'Rédigez en français.',
        ].join('\n'),
        messages: [
          userText(
            [
              `# Objectif\n${mission.objective}`,
              // La shortlist vient du stockage, pas du récit des agents : c'est
              // le fait, et c'est ce sur quoi Hermès doit rendre compte.
              pipeline ? `# Shortlist produite\n${pipeline.digest}` : '',
              `# Étapes réalisées\n${digest || '(aucune)'}`,
              failed.length
                ? `# Étapes en échec\n${failed.map((f) => `- ${f.ref} ${f.title} : ${f.error}`).join('\n')}`
                : '',
              starved.length
                ? [
                    '# Étapes non exécutées faute de matière',
                    starved.map((t) => `- ${t.ref} ${t.title} : ${t.error}`).join('\n'),
                    '',
                    "Ces étapes n'ont pas été lancées parce que l'étape amont n'a produit aucun élément à traiter.",
                    "Dites-le franchement : « aucun candidat suffisamment documenté » est une réponse valable et honnête.",
                    "N'inventez aucun résultat pour combler ce vide, et ne présentez pas cet arrêt comme une défaillance technique s'il n'en est pas une.",
                  ].join('\n')
                : '',
              artifacts.length
                ? `# Livrables produits\n${artifacts.map((a) => `- ${a.name} (${a.path})`).join('\n')}`
                : '',
              'Rédigez le rapport maintenant.',
            ]
              .filter(Boolean)
              .join('\n\n'),
          ),
        ],
        maxTokens: this.deps.config.llm.maxTokens,
        effort: settings.llmEffort,
        meta: { missionId: mission.id, purpose: 'synthesis' },
        jsonSchema: {
          type: 'object',
          properties: {
            report: { type: 'string', description: 'Le rapport destiné au fondateur, en Markdown, rédigé en français' },
            quality: { type: 'integer', description: 'Entre 0 et 100' },
          },
          required: ['report', 'quality'],
          additionalProperties: false,
        },
        signal,
      });

      tokensUsed = totalTokens(response.usage);
      const parsed = safeJson<{ report?: string; quality?: number }>(textOf(response.content));
      summary = parsed?.report?.trim() ?? textOf(response.content).trim();
      if (typeof parsed?.quality === 'number') quality = Math.max(0, Math.min(100, parsed.quality));
    } catch (err) {
      this.#log.warn('synthesis failed; falling back to a mechanical summary', {
        error: describeError(err),
      });
      summary = [
        `# ${mission.title}`,
        '',
        "Hermès n'a pas pu produire de synthèse rédigée pour cette mission ; voici le relevé brut.",
        '',
        digest || '(aucune étape achevée)',
      ].join('\n');
    }

    this.deps.repos.missions.addTokens(mission.id, tokensUsed);

    if (pipeline) {
      outputs.shortlist = pipeline.shortlist;
      outputs.funnel = pipeline.funnel;
      outputs.economics = pipeline.economics;
    }

    return {
      summary,
      outputs,
      artifacts,
      quality,
      tokensUsed: this.deps.repos.missions.tokensUsed(mission.id),
      durationMs,
    };
  }

  /**
   * Reads what a department mission actually produced.
   *
   * Deliberately read from storage rather than from the agents' summaries: an
   * agent describing its own success is a claim, whereas the opportunity rows
   * are the record. Returns null for a generic mission.
   */
  #pipelineOutcome(mission: Mission): {
    digest: string;
    shortlist: unknown[];
    funnel: Record<string, number>;
    economics: unknown;
  } | null {
    if (!mission.departmentKey) return null;

    const repos = this.deps.repos;
    const shortlist = repos.opportunities.shortlistFor(mission.id);
    const funnel = repos.opportunities.funnelFor(mission.id);
    const economics = missionEconomics({
      repos,
      missionId: mission.id,
      model: this.deps.settings().agentModel,
      simulated: this.deps.config.llm.mode === 'simulation',
    });

    const rows = shortlist.map((opportunity) => {
      const company = repos.companies.get(opportunity.companyId);
      return {
        rank: opportunity.rank,
        opportunityId: opportunity.id,
        name: company?.name ?? opportunity.companyId,
        country: company?.country ?? null,
        website: company?.website ?? null,
        score: opportunity.score,
        confidence: opportunity.scoreDetail?.confidence ?? null,
        targetTypes: opportunity.targetTypes,
        justification: opportunity.justification,
      };
    });

    const digest =
      rows.length === 0
        ? `No candidate reached the shortlist threshold. Funnel: ${JSON.stringify(funnel)}.`
        : rows
            .map(
              (r) =>
                `${r.rank}. ${r.name} (${r.country ?? 'country unknown'}) — ${r.score?.toFixed(1)}/100\n${r.justification ?? ''}`,
            )
            .join('\n\n');

    return { digest, shortlist: rows, funnel, economics };
  }

  /**
   * Turns the finished mission into knowledge (SRS §5.6, step 7).
   *
   * The outcome goes into memory so the next similar objective starts from
   * what was learned rather than from nothing.
   */
  #learn(mission: Mission, tasks: MissionTask[], result: MissionResult): void {
    // ── Ce qu'une mission a le droit de laisser en mémoire ─────────────────
    //
    // La synthèse d'une mission est écrite par un modèle. Elle décrit le
    // déroulement, et elle peut aussi affirmer des choses sur le monde — « le
    // marché allemand compte peu d'intégrateurs indépendants » — sans qu'aucune
    // source ne l'étaye. Mémoriser cela tel quel transformerait une phrase
    // plausible en connaissance d'ATLAS, réutilisée par toutes les missions
    // suivantes comme si elle avait été vérifiée.
    //
    // La règle se lit donc dans le code : une mission sans preuve sourcée
    // n'enregistre que de l'opérationnel — comment le travail s'est passé —
    // jamais un constat de marché. Une mission avec preuves enregistre un
    // constat métier, en disant sur combien de sources il repose.
    const sourced = this.deps.repos.companies
      .evidenceForMission(mission.id)
      .filter((item) => !item.simulated && Boolean(item.sourceRef));

    this.deps.memory.remember({
      kind: 'outcome',
      title: `Déroulement de mission : ${mission.title}`,
      content: [
        `Objectif : ${mission.objective}`,
        `Qualité ${result.quality}/100 en ${formatDuration(result.durationMs)}.`,
        `Étapes réussies : ${tasks.filter((t) => t.status === 'succeeded').length}/${tasks.length}.`,
        `Preuves sourcées : ${sourced.length}.`,
        '',
        sourced.length > 0
          ? result.summary.slice(0, 4000)
          : "Aucune preuve sourcée. La synthèse rend compte du déroulement et n'établit " +
            "rien du marché : une absence de résultat peut venir de la recherche, pas du terrain.",
      ].join('\n'),
      // Opérationnel quand rien n'est sourcé : ce souvenir parle du système,
      // pas du monde.
      tier: sourced.length > 0 ? 'business' : 'operational',
      tags: ['mission', ...mission.tags],
      missionId: mission.id,
      importance: sourced.length > 0 && result.quality >= 80 ? 0.7 : 0.4,
    });

    const failed = tasks.filter((t) => t.status === 'failed');
    if (failed.length > 0) {
      this.deps.memory.remember({
        kind: 'lesson',
        title: `Failure pattern: ${failed[0]!.action} by ${failed[0]!.agentKey}`,
        content: [
          `During "${mission.title}", ${failed.length} step(s) failed.`,
          ...failed.map((f) => `- ${f.agentKey} / ${f.action}: ${f.error ?? 'unknown error'}`),
          '',
          'Consider this when planning similar objectives.',
        ].join('\n'),
        tags: ['failure', 'planning'],
        missionId: mission.id,
        importance: 0.8,
      });
    }
  }

  /** Nudges the rolling quality score that feeds agent performance (SRS §4.14). */
  #reinforceAgentQuality(missionId: MissionId, delta: number, onlyAgent?: string): void {
    const agentKeys = onlyAgent
      ? [onlyAgent]
      : [...new Set(this.deps.repos.missions.tasksFor(missionId).map((t) => t.agentKey))];

    for (const key of agentKeys) {
      const current = this.deps.repos.agents.metricsFor(key).qualityScore;
      this.deps.repos.agents.setQualityScore(key, current + delta);
    }
  }

  #failMission(missionId: MissionId, reason: string): void {
    const mission = this.deps.repos.missions.transition(missionId, 'failed', { error: reason });
    this.deps.repos.ops.raiseAlertOnce({
      level: 'error',
      title: `Mission failed: ${mission.title}`,
      detail: reason,
      source: 'hermes',
    });
    this.deps.events.publish({
      type: 'mission.failed',
      severity: 'error',
      source: 'hermes',
      missionId,
      message: `Mission ${mission.code} failed: ${reason}`,
      payload: { reason },
    });
  }

  // ─── Village state transitions ───────────────────────────────────────────

  /**
   * The agent collects its assignment and travels to its building. It is
   * genuinely `moving` until the runtime reports it has started work.
   */
  #setAgentDispatched(agent: AgentDefinition, mission: Mission, task: MissionTask): void {
    this.deps.repos.agents.setState(agent.key, {
      status: 'moving',
      currentMissionId: mission.id,
      currentTaskId: task.id,
      currentActivity: task.title,
      location: 'command-center',
      destination: agent.building,
      lastActiveAt: nowIso(),
    });

    this.deps.events.publish({
      type: 'agent.journey',
      severity: 'debug',
      source: 'hermes',
      missionId: mission.id,
      agentKey: agent.key,
      message: `${agent.name} is heading to the ${agent.building}`,
      payload: {
        from: 'command-center',
        to: agent.building,
        reason: task.title,
        durationMs: 2600,
      },
    });

    this.deps.events.publish({
      type: 'agent.state',
      severity: 'debug',
      source: 'hermes',
      missionId: mission.id,
      agentKey: agent.key,
      message: `${agent.name} is on the way to the ${agent.building}`,
      payload: { status: 'moving', activity: task.title },
    });
  }

  /** Reflects what the runtime reports it is actually doing. */
  #setAgentPhase(agent: AgentDefinition, phase: 'working' | 'analyzing', task: MissionTask): void {
    this.deps.repos.agents.setState(agent.key, {
      status: phase,
      location: agent.building,
      destination: null,
      lastActiveAt: nowIso(),
    });

    this.deps.events.publish({
      type: 'agent.state',
      severity: 'debug',
      source: 'hermes',
      agentKey: agent.key,
      message: `${agent.name} is ${phase === 'analyzing' ? 'analysing results' : 'working'}`,
      payload: { status: phase, activity: task.title },
    });
  }

  /**
   * Settles the agent once its step is over.
   *
   * A permanent failure leaves the agent in `error`, so the village and the
   * health check show it. The supervisor clears that state after a cooldown,
   * so a department recovers on its own rather than staying red forever.
   */
  #settleAgent(agent: AgentDefinition, outcome: 'available' | 'error', reason?: string): void {
    this.deps.repos.agents.setState(agent.key, {
      status: outcome,
      currentMissionId: null,
      currentTaskId: null,
      currentActivity: outcome === 'error' ? (reason ?? 'Step failed') : null,
      destination: null,
      location: agent.building,
      lastActiveAt: nowIso(),
    });

    this.deps.events.publish({
      type: 'agent.state',
      severity: outcome === 'error' ? 'warning' : 'debug',
      source: 'hermes',
      agentKey: agent.key,
      message: outcome === 'error' ? `${agent.name} is in error` : `${agent.name} is available`,
      payload: { status: outcome, ...(reason ? { reason } : {}) },
    });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function summaryOf(output: Record<string, unknown> | null): string {
  if (!output) return '(no output)';
  if (typeof output.summary === 'string') return output.summary;
  try {
    return JSON.stringify(output).slice(0, 3000);
  } catch {
    return '(unserialisable output)';
  }
}

function safeJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      return null;
    }
  }
}

export { notFound };
