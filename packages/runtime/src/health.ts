import { cpus, totalmem, freemem, loadavg } from 'node:os';
import { statfsSync } from 'node:fs';
import type {
  DashboardStats,
  HealthCheck,
  ResourceSnapshot,
  SystemHealth,
} from '@atlas/contracts';
import { ATLAS_VERSION } from '@atlas/contracts';
import type { AtlasConfig, EventBus } from '@atlas/core';
import { nowIso, startOfTodayIso } from '@atlas/core';
import type { Repositories } from '@atlas/data';
import { databaseSizeMb } from '@atlas/data';

/** Au-delà, une alerte relève de l'historique plutôt que de l'état courant. */
const RECENT_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Combien d'alertes graves et récentes valent un signal de dégradation.
 *
 * Trois : une mission qui échoue en produit typiquement deux — l'étape et la
 * mission — et un échec isolé est un incident, pas une dégradation du système.
 */
const RECENT_ALERT_THRESHOLD = 3;

export interface HealthDeps {
  repos: Repositories;
  events: EventBus;
  config: AtlasConfig;
  /** Reports orchestrator load so saturation shows up as a health signal. */
  hermes: { activeCount: number; queuedCount: number };
  n8nPing?: () => Promise<{ reachable: boolean; detail: string }>;
}

/** Samples live resource usage (SRS §5.17). */
export function sampleResources(config: AtlasConfig, events: EventBus): ResourceSnapshot {
  const memoryTotalMb = totalmem() / 1024 / 1024;
  const memoryUsedMb = memoryTotalMb - freemem() / 1024 / 1024;
  const cores = cpus().length || 1;

  return {
    // loadavg is 0 on Windows; process CPU time is the portable fallback.
    cpuLoad: Math.min(1, (loadavg()[0] ?? processCpuLoad()) / cores),
    memoryUsedMb: Math.round(memoryUsedMb),
    memoryTotalMb: Math.round(memoryTotalMb),
    databaseSizeMb: databaseSizeMb(config.paths.databaseFile),
    eventBacklog: events.backlog,
  };
}

let lastCpuSample = { time: Date.now(), usage: process.cpuUsage() };

function processCpuLoad(): number {
  const now = Date.now();
  const usage = process.cpuUsage(lastCpuSample.usage);
  const elapsedMs = Math.max(1, now - lastCpuSample.time);
  lastCpuSample = { time: now, usage: process.cpuUsage() };
  return (usage.user + usage.system) / 1000 / elapsedMs;
}

/**
 * Full health assessment.
 *
 * Each check reports independently and the worst result decides the overall
 * status, so a degraded subsystem is visible without masking the rest.
 */
export async function assessHealth(deps: HealthDeps): Promise<SystemHealth> {
  const checks: HealthCheck[] = [];
  const resources = sampleResources(deps.config, deps.events);

  // Database
  const dbStart = Date.now();
  try {
    deps.repos.db.prepare('SELECT 1').get();
    checks.push({
      name: 'database',
      status: 'pass',
      detail: `SQLite repond (${resources.databaseSizeMb} Mo)`,
      latencyMs: Date.now() - dbStart,
    });
  } catch (err) {
    checks.push({
      name: 'database',
      status: 'fail',
      detail: `SQLite indisponible : ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Memory pressure
  const memoryRatio = resources.memoryUsedMb / Math.max(1, resources.memoryTotalMb);
  checks.push({
    name: 'memory',
    status: memoryRatio > 0.94 ? 'fail' : memoryRatio > 0.85 ? 'warn' : 'pass',
    detail: `${resources.memoryUsedMb} / ${resources.memoryTotalMb} Mo utilises (${Math.round(memoryRatio * 100)} %)`,
  });

  // CPU
  checks.push({
    name: 'cpu',
    status: resources.cpuLoad > 0.95 ? 'warn' : 'pass',
    detail: `charge ${(resources.cpuLoad * 100).toFixed(0)} % des coeurs disponibles`,
  });

  // Disk — best effort; not every platform exposes statfs.
  try {
    const stats = statfsSync(deps.config.paths.dataDir);
    const freeGb = (stats.bsize * stats.bavail) / 1024 ** 3;
    checks.push({
      name: 'disk',
      status: freeGb < 1 ? 'fail' : freeGb < 5 ? 'warn' : 'pass',
      detail: `${freeGb.toFixed(1)} Go libres dans le repertoire de donnees`,
    });
  } catch {
    checks.push({ name: 'disk', status: 'pass', detail: "occupation disque non rapportee par cette plateforme" });
  }

  // Orchestrator
  const agents = deps.repos.agents.list(true);
  const erroredAgents = agents.filter((a) => a.state.status === 'error');
  checks.push({
    name: 'orchestrator',
    status: erroredAgents.length > 0 ? 'warn' : 'pass',
    detail: `${deps.hermes.activeCount} mission(s) en cours, ${deps.hermes.queuedCount} en attente, ${agents.length} agents en service`,
  });

  // Event pipeline
  checks.push({
    name: 'events',
    status: resources.eventBacklog > 500 ? 'warn' : 'pass',
    detail: `${resources.eventBacklog} traitement(s) d'evenement en vol`,
  });

  // Inference
  checks.push({
    name: 'inference',
    status: 'pass',
    detail:
      deps.config.llm.mode === 'live'
        ? `API Anthropic (${deps.config.llm.hermesModel} / ${deps.config.llm.agentModel}) — appels factures`
        : "Mode simulation — aucune cle Anthropic configuree, aucun appel facture",
  });

  // Automation
  if (deps.n8nPing) {
    const ping = await deps.n8nPing();
    checks.push({
      name: 'automation',
      status: ping.reachable ? 'pass' : 'warn',
      detail: ping.detail,
    });
  }

  // ── Alertes ────────────────────────────────────────────────────────────
  // La santé mesure ce qui va mal *maintenant*, pas la taille de la boîte de
  // réception. La règle précédente — plus de dix alertes non acquittées — a
  // déclaré ATLAS « dégradé » sur quatorze alertes décrivant toutes des
  // missions échouées les jours précédents : un historique fidèle, mais aucune
  // panne en cours. Le fondateur lisait un système malade là où il n'avait
  // qu'un arriéré de lecture, et une vraie panne se serait perdue dans le lot.
  //
  // Ne comptent donc que les alertes graves et récentes. Le total reste écrit
  // en clair : rien n'est masqué, la sévérité est seulement ramenée à ce
  // qu'elle décrit.
  const openAlerts = deps.repos.ops.openAlertCount();
  const recentSevere = deps.repos.ops.recentSevereAlertCount(RECENT_ALERT_WINDOW_MS);
  const backlog = openAlerts - recentSevere;
  checks.push({
    name: 'alerts',
    status: recentSevere >= RECENT_ALERT_THRESHOLD ? 'warn' : 'pass',
    detail:
      openAlerts === 0
        ? 'aucune alerte ouverte'
        : recentSevere === 0
          ? `${openAlerts} alerte(s) non acquittée(s), aucune récente et grave`
          : `${recentSevere} alerte(s) grave(s) dans les dernières 24 h` +
            (backlog > 0 ? ` · ${backlog} plus ancienne(s) en attente d'acquittement` : ''),
  });

  const status = checks.some((c) => c.status === 'fail')
    ? 'critical'
    : checks.some((c) => c.status === 'warn')
      ? 'degraded'
      : 'healthy';

  return {
    status,
    uptimeSeconds: Math.round(process.uptime()),
    version: ATLAS_VERSION,
    mode: deps.config.llm.mode,
    checks,
    resources,
    generatedAt: nowIso(),
  };
}

/** Aggregates the Command Center's headline numbers. */
export function buildDashboardStats(repos: Repositories): DashboardStats {
  const counts = repos.missions.countsByStatus();
  const today = startOfTodayIso();
  const agents = repos.agents.list();

  const completedToday = repos.missions.countSince(today, ['completed', 'validated', 'archived']);
  const failedToday = repos.missions.countSince(today, ['failed']);
  const finishedToday = completedToday + failedToday;

  const improvementCounts = repos.improvements.countByStatus();

  return {
    missions: {
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      active: (counts.running ?? 0) + (counts.planned ?? 0) + (counts.assigned ?? 0),
      completedToday,
      failedToday,
      successRate: finishedToday > 0 ? Math.round((completedToday / finishedToday) * 1000) / 10 : 100,
    },
    agents: {
      total: agents.length,
      active: agents.filter((a) => ['working', 'analyzing', 'moving'].includes(a.state.status)).length,
      available: agents.filter((a) => a.state.status === 'available').length,
      error: agents.filter((a) => a.state.status === 'error').length,
    },
    memory: { total: repos.memory.total(), byTier: repos.memory.countByTier() },
    automation: {
      workflows: repos.workflows.list().filter((w) => w.enabled).length,
      runsToday: repos.workflows.countRunsSince(today),
    },
    evolution: {
      pending: improvementCounts.proposed ?? 0,
      applied: improvementCounts.applied ?? 0,
    },
    tokens: { today: repos.missions.tokensSince(today), total: repos.missions.tokensTotal() },
  };
}
