import { hostname } from 'node:os';
import {
  nowIso,
  canRunProvider,
  decideRetryAt,
  backoffDelayMs,
  type Logger,
  type ProviderState,
} from '@atlas/core';
import type { Repositories, TaskRow } from '@atlas/data';
import type { WorkerRegistry, WorkerOutcome } from './workers.ts';

/**
 * Le cœur permanent.
 *
 * Deux propriétés le définissent, et elles tirent en sens opposé : il doit
 * travailler dès qu'il y a du travail, et ne rien consommer quand il n'y en a
 * pas. Une boucle qui interroge la base toutes les cent millisecondes tient la
 * première et rate la seconde — sur des semaines, elle brûle un cœur de
 * processeur pour ne rien trouver.
 *
 * D'où l'attente calculée : la file sait à quelle date la prochaine tâche
 * devient prenable, et le daemon dort jusque-là, borné par un plafond pour
 * rester réactif à ce qu'un autre processus aurait ajouté entre-temps.
 *
 * Aucun appel de modèle n'est fait ici, ni au repos ni au travail. Les workers
 * de modèle existent et refusent.
 */

export interface DaemonOptions {
  repos: Repositories;
  registry: WorkerRegistry;
  logger: Logger;
  /** Durée d'un bail. Un worker doit battre plus souvent que cela. */
  leaseMs?: number;
  /** Intervalle entre deux battements pendant un travail long. */
  heartbeatMs?: number;
  /** Plafond de sommeil : au-delà, on revérifie même sans échéance connue. */
  maxIdleMs?: number;
  /** Types de workers que ce daemon accepte de servir. */
  workerTypes?: readonly string[];
  /** Identité du processus, pour que les baux soient attribuables. */
  owner?: string;
  /** Nombre de tours maximum. Sans valeur, le daemon tourne jusqu'à l'arrêt. */
  maxCycles?: number;
}

export interface DaemonStats {
  cycles: number;
  claimed: number;
  completed: number;
  failed: number;
  pausedQuota: number;
  pausedBudget: number;
  waitingHuman: number;
  recovered: number;
  resumed: number;
  idleMs: number;
}

/**
 * Le sommeil, réveillable.
 *
 * Deux erreurs ont été commises ici et méritent d'être dites, parce qu'elles se
 * ressemblent et se corrigent à l'opposé.
 *
 * La première : `unref()` sur le minuteur. Il ne restait alors aucune référence
 * pour retenir Node, et le processus se terminait de lui-même dès que la file
 * se vidait — un daemon qui meurt au premier instant d'inactivité, soit
 * exactement le contraire de ce qu'on lui demande. Le minuteur reste donc
 * référencé : c'est lui qui tient le processus en vie entre deux tâches.
 *
 * La seconde : un `setInterval` de 50 ms pour surveiller la demande d'arrêt.
 * Cela fonctionnait, mais ce n'était plus du repos — vingt réveils par seconde
 * pendant des semaines. Le réveil est désormais poussé, pas sondé : `requestStop`
 * appelle directement la fonction qui débloque le sommeil.
 */
type Sleeper = { promise: Promise<void>; wake: () => void };

const sleep = (ms: number): Sleeper => {
  let wake = () => {};
  const promise = new Promise<void>((resolve) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  return { promise, wake };
};

/**
 * Les types de worker qu'un daemon sert par défaut.
 *
 * Exporté, et non écrit en clair à l'usage : une tâche destinée à un type
 * absent de cette liste reste QUEUED indéfiniment — sans erreur, sans journal,
 * sans que rien ne signale qu'elle ne sera jamais prise. C'est arrivé avec
 * `CLAUDE_CODE`. Une constante partagée permet de vérifier ailleurs que la
 * liste couvre bien tout ce vers quoi Hermes sait router ; une liste recopiée
 * dans le test aurait passé pendant que le bug était là.
 */
/**
 * Les pannes qu'un réessai ne résoudra jamais.
 *
 * Distinguer le passager du permanent est ce qui sépare un système qui se
 * répare seul d'un système qui tourne à vide. Une limitation de débit s'efface
 * en attendant ; un traitement non enregistré, non.
 */
export const PERMANENT_ERROR_CODES = new Set<string>([
  'NO_HANDLER',
  'NO_WORKER',
]);

export const DEFAULT_WORKER_TYPES = [
  'DETERMINISTIC', 'OPENAI', 'CLAUDE', 'CLAUDE_CODE', 'HUMAN',
] as const;

export class AtlasDaemon {
  private readonly repos: Repositories;
  private readonly registry: WorkerRegistry;
  private readonly logger: Logger;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly maxIdleMs: number;
  private readonly workerTypes: readonly string[];
  readonly owner: string;

  private readonly signal = { aborted: false };
  /** Débloque le sommeil en cours, s'il y en a un. */
  private wake: (() => void) | null = null;
  private runId: string | null = null;
  private stopReason = 'arrêt demandé';

  readonly stats: DaemonStats = {
    cycles: 0, claimed: 0, completed: 0, failed: 0,
    pausedQuota: 0, pausedBudget: 0, waitingHuman: 0,
    recovered: 0, resumed: 0, idleMs: 0,
  };

  constructor(private readonly options: DaemonOptions) {
    this.repos = options.repos;
    this.registry = options.registry;
    this.logger = options.logger;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.heartbeatMs = options.heartbeatMs ?? 10_000;
    this.maxIdleMs = options.maxIdleMs ?? 60_000;
    this.workerTypes = options.workerTypes ?? DEFAULT_WORKER_TYPES;
    this.owner = options.owner ?? `${hostname()}#${process.pid}`;
  }

  /**
   * L'arrêt demandé.
   *
   * Il ne coupe rien : il empêche de prendre de nouvelles tâches et signale aux
   * workers en cours qu'ils devraient s'arrêter. Une tâche courte finit ; une
   * tâche longue perd son bail et sera reprise — ce qui est correct, puisque
   * son travail n'a pas été consigné.
   */
  requestStop(reason: string): void {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    this.stopReason = reason;
    // Réveiller tout de suite : attendre la fin d'un sommeil d'une minute pour
    // constater qu'on doit s'arrêter donnerait un arrêt d'une lenteur absurde.
    this.wake?.();
    this.logger.info('arrêt demandé : plus aucune tâche ne sera prise', { reason });
  }

  get stopping(): boolean {
    return this.signal.aborted;
  }

  /**
   * Le démarrage : remettre d'aplomb ce qu'un arrêt brutal a laissé en l'air.
   *
   * L'ordre compte. On récupère d'abord les baux morts, ensuite seulement on
   * relève les pauses : l'inverse pourrait rendre à la file une tâche qu'un
   * worker fantôme tient encore d'après la base.
   */
  boot(): { recovered: number; resumed: number; released: number } {
    this.runId = this.repos.tasks.startDaemonRun(hostname(), process.pid);
    this.logger.info('daemon démarré', {
      owner: this.owner, runId: this.runId, workerTypes: this.workerTypes.join(','),
    });

    const recovered = this.repos.tasks.recoverStaleLeases(this.owner);
    for (const item of recovered) {
      this.logger.warn('tâche récupérée : le bail avait expiré', {
        taskId: item.taskId, state: item.to,
      });
    }
    const resumed = this.repos.tasks.resumeEligible(this.owner);
    const released = this.repos.tasks.releaseSatisfiedDependencies(this.owner);

    this.stats.recovered += recovered.length;
    this.stats.resumed += resumed.length;
    return { recovered: recovered.length, resumed: resumed.length, released: released.length };
  }

  async run(): Promise<DaemonStats> {
    this.boot();
    const maxCycles = this.options.maxCycles ?? Infinity;

    while (!this.signal.aborted && this.stats.cycles < maxCycles) {
      this.stats.cycles += 1;

      // Chaque tour relève d'abord ce qui est redevenu éligible. Bon marché :
      // deux requêtes indexées, aucun appel externe.
      this.stats.resumed += this.repos.tasks.resumeEligible(this.owner).length;
      this.repos.tasks.releaseSatisfiedDependencies(this.owner);
      this.stats.recovered += this.repos.tasks.recoverStaleLeases(this.owner).length;

      const claim = this.repos.tasks.claim({
        owner: this.owner,
        leaseMs: this.leaseMs,
        workerTypes: this.workerTypes,
      });

      if (!claim.task) {
        const waited = await this.idle();
        this.stats.idleMs += waited;
        continue;
      }

      this.stats.claimed += 1;
      await this.execute(claim.task);
    }

    if (this.runId) this.repos.tasks.stopDaemonRun(this.runId, this.stopReason);
    this.logger.info('daemon arrêté', { ...this.stats, reason: this.stopReason });
    return this.stats;
  }

  /**
   * L'attente, dimensionnée sur ce qui est réellement attendu.
   *
   * Quand rien n'est programmé, on dort le plafond entier. Quand une échéance
   * existe, on dort jusqu'à elle. Dans les deux cas le processeur est à zéro :
   * c'est un `setTimeout`, pas une boucle.
   */
  private async idle(): Promise<number> {
    if (this.signal.aborted) return 0;
    const next = this.repos.tasks.msUntilNextWork();
    const wait = next === null ? this.maxIdleMs : Math.min(Math.max(next, 250), this.maxIdleMs);
    const sleeper = sleep(wait);
    this.wake = sleeper.wake;
    try {
      await sleeper.promise;
    } finally {
      this.wake = null;
    }
    return wait;
  }

  /** Exécuter une tâche, en tenant son bail pendant qu'elle travaille. */
  private async execute(task: TaskRow): Promise<void> {
    const startedAt = Date.now();
    const worker = this.registry.find(task);

    const log = (level: 'info' | 'warn' | 'error', message: string, extra: object = {}) => {
      this.logger[level](message, {
        taskId: task.taskId,
        taskType: task.taskType,
        worker: worker?.type ?? 'aucun',
        attempt: task.attemptCount,
        correlationId: task.correlationId ?? undefined,
        durationMs: Date.now() - startedAt,
        ...extra,
      });
    };

    if (!worker) {
      // Permanent, comme `NO_HANDLER` : aucun réessai n'inscrira le worker
      // manquant au registre. La tâche appelle donc une personne au lieu de
      // consommer ses tentatives contre un mur.
      this.repos.tasks.waitForHuman(
        task.taskId, this.owner,
        `aucun worker pour le type ${task.workerType} : `
        + `types servis — ${this.workerTypes.join(', ')}`,
        'NO_WORKER',
      );
      this.stats.waitingHuman += 1;
      log('error', 'aucun worker ne sait traiter cette tâche : elle attend une personne', {
        state: 'WAITING_HUMAN', errorCode: 'NO_WORKER',
      });
      return;
    }

    // Le bail est renouvelé pendant le travail. S'il cesse de l'être — le
    // processus meurt — la tâche redevient prenable d'elle-même.
    const beat = setInterval(() => {
      this.repos.tasks.heartbeat(task.taskId, this.owner, this.leaseMs);
    }, this.heartbeatMs);
    if (typeof beat.unref === 'function') beat.unref();

    let outcome: WorkerOutcome;
    try {
      outcome = await worker.execute(task, {
        logger: this.logger,
        heartbeat: () => this.repos.tasks.heartbeat(task.taskId, this.owner, this.leaseMs),
        shuttingDown: () => this.signal.aborted,
        correlationId: task.correlationId,
      });
    } catch (error) {
      outcome = {
        kind: 'FAILED',
        errorCode: 'WORKER_THREW',
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearInterval(beat);
    }

    this.persist(task, outcome, log);
  }

  /** Consigner l'issue, et ce qu'elle implique pour le fournisseur. */
  private persist(
    task: TaskRow,
    outcome: WorkerOutcome,
    log: (level: 'info' | 'warn' | 'error', message: string, extra?: object) => void,
  ): void {
    switch (outcome.kind) {
      case 'DONE': {
        this.repos.tasks.complete(
          task.taskId, outcome.result ?? {}, this.owner, outcome.costUsd ?? null,
        );
        this.stats.completed += 1;
        log('info', 'tâche terminée', { state: 'DONE' });
        return;
      }

      case 'PAUSED_QUOTA': {
        const provider = outcome.provider ?? 'INCONNU';
        // L'échéance vient du fournisseur quand il l'a donnée ; d'un backoff
        // borné sinon. Jamais d'une heure de reset supposée.
        const decision = decideRetryAt({
          retryAfterHeader: outcome.retryAfterHeader,
          rateLimitResetHeader: outcome.rateLimitResetHeader,
          attempt: task.attemptCount,
        });
        const state: ProviderState =
          outcome.errorCode === 'QUOTA_EXHAUSTED' ? 'QUOTA_EXHAUSTED' : 'RATE_LIMITED';
        this.repos.tasks.recordProviderHealth({
          provider,
          state,
          reason: outcome.errorMessage ?? null,
          retryAt: decision.retryAt,
          retrySource: decision.source,
        });
        this.repos.tasks.pauseForQuota({
          taskId: task.taskId,
          actor: this.owner,
          provider,
          retryAt: decision.retryAt,
          reason: outcome.errorMessage ?? decision.reason,
        });
        this.stats.pausedQuota += 1;
        log('warn', 'tâche mise en pause : fournisseur indisponible', {
          state: 'PAUSED_QUOTA', provider, retryAt: decision.retryAt, retrySource: decision.source,
        });
        return;
      }

      case 'PAUSED_BUDGET': {
        const retryAt = new Date(Date.now() + backoffDelayMs(task.attemptCount)).toISOString();
        this.repos.tasks.pauseForBudget({
          taskId: task.taskId,
          actor: this.owner,
          reason: outcome.errorMessage ?? 'budget épuisé',
          retryAt,
        });
        this.stats.pausedBudget += 1;
        log('warn', 'tâche mise en pause : budget', { state: 'PAUSED_BUDGET', retryAt });
        return;
      }

      case 'WAITING_HUMAN': {
        this.repos.tasks.waitForHuman(
          task.taskId, this.owner, outcome.errorMessage ?? 'décision humaine attendue',
        );
        this.stats.waitingHuman += 1;
        log('info', 'tâche en attente de décision humaine', { state: 'WAITING_HUMAN' });
        return;
      }

      case 'FAILED':
      default: {
        /**
         * Certaines pannes ne guérissent pas en attendant.
         *
         * `NO_HANDLER` veut dire qu'aucun worker ne sait traiter ce type de
         * tâche. Réessayer trois fois à une minute d'intervalle n'enregistrera
         * pas le traitement manquant : cela consomme les tentatives, puis pose
         * la tâche en `FAILED` — un état qui se lit « le travail a échoué »
         * alors qu'il faut lire « personne n'a été chargé de le faire ». Le
         * premier se cherche dans les journaux, le second se corrige en une
         * ligne, à condition que quelqu'un soit prévenu.
         *
         * C'est le même raisonnement que pour le binaire Claude Code absent :
         * la tâche est bonne, c'est le poste qui est incomplet.
         */
        if (outcome.errorCode && PERMANENT_ERROR_CODES.has(outcome.errorCode)) {
          this.repos.tasks.waitForHuman(
            task.taskId, this.owner,
            outcome.errorMessage ?? `condition permanente : ${outcome.errorCode}`,
          );
          this.stats.waitingHuman += 1;
          log('error', 'tâche sans traitement possible : elle attend une personne', {
            state: 'WAITING_HUMAN', errorCode: outcome.errorCode,
          });
          return;
        }

        const result = this.repos.tasks.fail({
          taskId: task.taskId,
          actor: this.owner,
          errorCode: outcome.errorCode ?? 'UNKNOWN',
          errorMessage: outcome.errorMessage ?? 'échec sans motif',
          retryDelayMs: backoffDelayMs(task.attemptCount),
        });
        if (result.to === 'FAILED') this.stats.failed += 1;
        log(result.to === 'FAILED' ? 'error' : 'warn', 'tâche en échec', {
          state: result.to, errorCode: outcome.errorCode,
        });
      }
    }
  }

  /**
   * Un fournisseur est-il utilisable maintenant ?
   *
   * Exposé pour que les workers le demandent avant de dépenser un appel, plutôt
   * que de découvrir la limitation en la provoquant.
   */
  providerUsable(provider: string): { allowed: boolean; reason: string } {
    const health = this.repos.tasks.providerHealth(provider);
    const verdict = canRunProvider(health, Date.parse(nowIso()));
    return { allowed: verdict.allowed, reason: verdict.reason };
  }
}
