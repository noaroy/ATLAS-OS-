import type { AtlasConfig, EventBus, Logger } from '@atlas/core';
import { addMs, describeError, nowIso } from '@atlas/core';
import type { Repositories } from '@atlas/data';
import type { AutomationService } from '@atlas/automation';
import type { EvolutionEngine } from '@atlas/evolution';
import type { HermesEngine } from '@atlas/hermes';
import type { MemoryService, MemoryRetention } from '@atlas/memory';
import { assessHealth, sampleResources } from './health.ts';
import { runBackup } from './backup.ts';
import type { VillageService } from './village.ts';

/** How long an agent stays visibly in error before it settles back. */
const AGENT_ERROR_COOLDOWN_MS = 10 * 60_000;

export interface SupervisorDeps {
  repos: Repositories;
  events: EventBus;
  config: AtlasConfig;
  logger: Logger;
  hermes: HermesEngine;
  automation: AutomationService;
  evolution: EvolutionEngine;
  memory: MemoryService;
  village: VillageService;
  settings: () => { memoryRetention: MemoryRetention };
  /**
   * Le planificateur du moteur commercial, quand le système l'embarque. Il
   * ne fait que poser des tâches à clés de période ; le daemon les exécute.
   * Absent, aucun cycle commercial n'est cadencé — c'est le cas des tests.
   */
  salesScheduler?: (now: Date) => { created: string[]; existing: string[] };
  /**
   * Le cadencement de l'Autopilot, quand ATLAS_AUTOPILOT_ENABLED est vrai.
   * Même mécanisme : une tâche à clé de période, servie par le daemon.
   */
  autopilotScheduler?: (now: Date) => { created: string[]; existing: string[] };
}

/**
 * Keeps ATLAS alive and honest (SRS §2.15, §5.15, §6.10).
 *
 * One timer drives everything. Periodic work is registered as internal
 * workflows rather than hidden `setInterval`s, so every recurring job appears
 * in the Command Center with its schedule, history and last outcome — and the
 * founder can disable any of them without touching code.
 */
export class RuntimeSupervisor {
  #log: Logger;
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #ticking = false;

  constructor(private readonly deps: SupervisorDeps) {
    this.#log = deps.logger.child({ scope: 'supervisor' });
  }

  /** Registers the maintenance jobs and starts the heartbeat. */
  start(): void {
    if (this.#running) return;
    this.#running = true;

    this.#registerMaintenanceJobs();
    this.deps.automation.rescheduleAll();
    this.deps.automation.subscribeToEvents();
    this.deps.village.start();

    this.#timer = setInterval(() => {
      void this.#tick();
    }, this.deps.config.runtime.heartbeatMs);
    // A pending heartbeat must never hold the process open during shutdown.
    this.#timer.unref?.();

    this.#log.info('supervisor started', {
      heartbeatMs: this.deps.config.runtime.heartbeatMs,
      backupRetention: this.deps.config.backup.retention,
    });
  }

  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;

    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;

    this.deps.village.stop();
    this.deps.automation.stop();
  }

  /** One heartbeat: sample, refresh, schedule, and escalate anything wrong. */
  async #tick(): Promise<void> {
    if (this.#ticking) return; // a slow tick must not overlap the next one
    this.#ticking = true;

    try {
      const resources = sampleResources(this.deps.config, this.deps.events);
      this.deps.repos.ops.recordSample(resources);

      // An agent must show its failure, but must also recover on its own —
      // otherwise one bad step leaves a department red indefinitely.
      const recovered = this.deps.repos.agents.clearStaleErrors(
        addMs(nowIso(), -AGENT_ERROR_COOLDOWN_MS),
      );
      if (recovered > 0) this.#log.debug('agents recovered from error state', { count: recovered });

      this.deps.village.refreshBuildingStatus();

      await this.deps.automation.tick();

      const health = await assessHealth({
        repos: this.deps.repos,
        events: this.deps.events,
        config: this.deps.config,
        hermes: {
          activeCount: this.deps.hermes.activeCount,
          queuedCount: this.deps.hermes.queuedCount,
        },
        n8nPing: this.deps.automation.n8n
          ? () => this.deps.automation.n8n!.ping()
          : undefined,
      });

      if (health.status !== 'healthy') {
        const failing = health.checks.filter((c) => c.status !== 'pass');
        this.deps.repos.ops.raiseAlertOnce({
          level: health.status === 'critical' ? 'critical' : 'warning',
          title: `System ${health.status}`,
          detail: failing.map((c) => `${c.name}: ${c.detail}`).join(' | '),
          source: 'supervisor',
        });
      }

      this.deps.events.publish({
        type: 'system.heartbeat',
        severity: 'debug',
        source: 'supervisor',
        message: `Heartbeat — ${health.status}`,
        payload: {
          status: health.status,
          activeMissions: this.deps.hermes.activeCount,
          queued: this.deps.hermes.queuedCount,
          cpuLoad: resources.cpuLoad,
          memoryUsedMb: resources.memoryUsedMb,
        },
      });
    } catch (err) {
      this.#log.error('heartbeat failed', { error: describeError(err) });
    } finally {
      this.#ticking = false;
    }
  }

  /**
   * ATLAS's own recurring jobs, exposed through the same workflow registry the
   * founder uses for n8n automations.
   */
  #registerMaintenanceJobs(): void {
    const { automation, repos, config, memory, evolution } = this.deps;

    automation.registerInternal(
      'atlas.backup',
      {
        name: 'Nightly backup',
        description: 'Writes a consistent, compacted copy of the database and prunes old backups.',
        trigger: { type: 'schedule', cron: '15 2 * * *', timezone: 'UTC' },
      },
      async () => {
        const result = runBackup(repos, config, this.#log, 'scheduled');
        this.deps.events.publish({
          type: 'system.backup',
          severity: 'success',
          source: 'supervisor',
          message: `Backup written (${(result.bytes / 1024 / 1024).toFixed(1)} MB)`,
          payload: { bytes: result.bytes, pruned: result.pruned },
        });
        return { bytes: result.bytes, pruned: result.pruned };
      },
    );

    automation.registerInternal(
      'atlas.memory-consolidation',
      {
        name: 'Memory consolidation',
        description:
          'Expires stale entries, promotes proven operational knowledge to strategic memory, and prunes what was never used.',
        trigger: { type: 'schedule', cron: '0 */6 * * *', timezone: 'UTC' },
      },
      async () => {
        const result = memory.consolidate(this.deps.settings().memoryRetention);
        return { ...result };
      },
    );

    automation.registerInternal(
      'atlas.evolution-cycle',
      {
        name: 'Evolution cycle',
        description:
          'Observes how ATLAS is performing and proposes controlled, reversible improvements.',
        trigger: { type: 'schedule', cron: '30 * * * *', timezone: 'UTC' },
      },
      async () => {
        const result = await evolution.runCycle();
        return {
          proposed: result.proposed.length,
          autoApplied: result.autoApplied.length,
          skipped: result.skipped,
        };
      },
    );

    if (this.deps.salesScheduler) {
      const schedule = this.deps.salesScheduler;
      automation.registerInternal(
        'atlas.sales-scheduler',
        {
          name: 'Sales engine scheduler',
          description:
            'Pose les cycles du moteur commercial (lecture de la boîte, envois approuvés, relances, découverte, mesures, recommandations) avec des clés de période : rien n’est créé deux fois.',
          trigger: { type: 'schedule', cron: '*/5 * * * *', timezone: 'UTC' },
        },
        async () => {
          const report = schedule(new Date());
          return { created: report.created.length, existing: report.existing.length };
        },
      );
    }

    if (this.deps.autopilotScheduler) {
      const schedule = this.deps.autopilotScheduler;
      automation.registerInternal(
        'atlas.autopilot-scheduler',
        {
          name: 'Autopilot scheduler',
          description:
            'Pose le cycle de contrôle de l’Autopilot (observer, proposer, prioriser, confier ce qui est sûr, vérifier, apprendre) avec une clé de période : rien n’est créé deux fois, rien n’est envoyé.',
          trigger: { type: 'schedule', cron: '*/5 * * * *', timezone: 'UTC' },
        },
        async () => {
          const report = schedule(new Date());
          return { created: report.created.length, existing: report.existing.length };
        },
      );
    }

    automation.registerInternal(
      'atlas.housekeeping',
      {
        name: 'Log and session housekeeping',
        description:
          'Prunes low-severity events and resource samples older than 30 days, and clears expired sessions.',
        trigger: { type: 'schedule', cron: '45 3 * * *', timezone: 'UTC' },
      },
      async () => {
        const cutoff = addMs(nowIso(), -30 * 86_400_000);
        const events = repos.events.prune(cutoff);
        const samples = repos.ops.pruneSamples(cutoff);
        const sessions = repos.users.purgeExpiredSessions();
        return { events, samples, sessions };
      },
    );
  }

  /** Backup taken on a clean shutdown, so the last state is always captured. */
  backupNow(trigger: 'manual' | 'shutdown' = 'manual') {
    return runBackup(this.deps.repos, this.deps.config, this.#log, trigger);
  }
}
