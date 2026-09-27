import type { TaskRow } from '@atlas/data';
import type { WorkerContext, WorkerOutcome } from '../workers.ts';
import type { ExpansionDeps, ExpansionLimits, ExpansionSeed, StrategyKey, ExpansionIcp } from './types.ts';
import { EXPANSION_TASK_TYPE, runExpansion, resumeOpenExpansions, promoteCandidates, strongestSeeds } from './engine.ts';

/**
 * La tâche `PROSPECT_EXPANSION`, servie par le worker déterministe du serveur.
 *
 * Une bibliothèque, pas un script : tout ce qu'elle emprunte (recherche,
 * lecture de pages, modèle plafonné, dépôts) vit dans l'image serveur. Elle
 * n'a donc pas besoin de la voie externe réservée aux scripts en
 * sous-processus — et n'y touche pas.
 *
 * Trois formes de charge utile :
 *   { seeds | seedProspectIds, strategies?, limits?, icp? }  un tour
 *   { promote: true, runId }                                  verser les candidats qualifiés
 *   {}                                                        les graines les plus fortes du registre
 * Avant toute chose, un tour laissé RUNNING par un arrêt est repris.
 */
export function createExpansionHandlers(deps: ExpansionDeps): Record<string, (task: TaskRow, context: WorkerContext) => Promise<WorkerOutcome>> {
  const { repos } = deps;

  const handler = async (task: TaskRow, context: WorkerContext): Promise<WorkerOutcome> => {
    const payload = task.payload as {
      seeds?: ExpansionSeed[]; seedProspectIds?: string[]; strategies?: StrategyKey[]; limits?: Partial<ExpansionLimits>; icp?: ExpansionIcp;
      promote?: boolean; runId?: string; trigger?: string; purpose?: 'SALES' | 'CLIENT'; missionId?: string | null;
    };
    const heartbeat = () => { context.heartbeat(); };

    if (payload.promote) {
      if (!payload.runId) return { kind: 'FAILED', errorCode: 'EXPANSION_RUN_REQUIRED', errorMessage: 'promote exige runId' };
      const outcome = promoteCandidates(repos, payload.runId, { limit: 50 });
      return { kind: 'DONE', result: { promote: true, runId: payload.runId, promoted: outcome.promoted.length, skipped: outcome.skipped.length, messagesSent: 0 } };
    }

    const resumed = await resumeOpenExpansions(deps, { heartbeat, trigger: `daemon:${task.taskId}` });
    // Un tour repris ici est une expansion menée à son terme (ou de nouveau
    // CAPPED) : la même tâche ne doit pas en démarrer une seconde derrière —
    // la prochaine proposition de l'Autopilot s'en chargera si besoin.
    if (resumed.length > 0) {
      const last = resumed[resumed.length - 1]!;
      return {
        kind: last.status === 'FAILED' ? 'FAILED' : 'DONE',
        errorCode: last.status === 'FAILED' ? 'EXPANSION_FAILED' : undefined,
        errorMessage: last.error ?? undefined,
        result: { ran: true, resumedOnly: true, runId: last.id, status: last.status, resumed: resumed.map((r) => r.id), messagesSent: 0 },
      };
    }

    let seeds: ExpansionSeed[] = payload.seeds ?? [];
    if (seeds.length === 0 && payload.seedProspectIds?.length) {
      seeds = payload.seedProspectIds
        .map((id) => repos.sales.get(id))
        .filter((p): p is NonNullable<typeof p> => Boolean(p && p.domain))
        .map((p) => ({ name: p.companyName, domain: p.domain, website: p.website, country: p.country, prospectId: p.id, activity: p.whyFit ?? null }));
    }
    if (seeds.length === 0) seeds = strongestSeeds(repos, { limit: 3 });
    if (seeds.length === 0) {
      return { kind: 'DONE', result: { ran: false, skipped: 'aucune graine forte dans le registre commercial', resumed: resumed.map((r) => r.id), messagesSent: 0 } };
    }

    const { run, report } = await runExpansion(deps, {
      seeds, strategies: payload.strategies, limits: payload.limits, icp: payload.icp, purpose: payload.purpose ?? 'SALES', missionId: payload.missionId ?? null,
      trigger: payload.trigger ?? `daemon:${task.taskId}`, heartbeat,
    });
    // Un tour SALES mené à terme verse aussitôt ses candidats qualifiés dans
    // la file commerciale : sans cela, la fabrique qui l'a demandé ne voyait
    // jamais ce qu'il avait trouvé (QUEUE_EMPTY à répétition).
    const promoted = run.purpose === 'SALES' && (run.status === 'DONE' || run.status === 'CAPPED')
      ? promoteCandidates(repos, run.id, { limit: 50 }).promoted.length : 0;
    return {
      kind: run.status === 'FAILED' ? 'FAILED' : 'DONE',
      errorCode: run.status === 'FAILED' ? 'EXPANSION_FAILED' : undefined,
      errorMessage: run.error ?? undefined,
      result: {
        ran: true, runId: run.id, promoted, status: run.status, funnel: report.stats.funnel, uniqueCompanies: report.stats.uniqueCompanies, relationships: report.stats.relationships,
        evidence: report.stats.evidence, stoppedBy: report.stats.stoppedBy, summary: report.summary, resumed: resumed.map((r) => r.id), messagesSent: 0,
      },
      costUsd: Number((report.stats.searchCostUsd + report.stats.aiCostUsd).toFixed(5)),
    };
  };

  return { [EXPANSION_TASK_TYPE]: handler };
}
