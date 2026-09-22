import type { AutopilotAction, TaskRow } from '@atlas/data';
import type { AutopilotProposal, OpportunityContext, OpportunitySource } from '../autopilot.ts';
import { EXPANSION_TASK_TYPE, strongestSeeds, resolveLimits, isRunStale } from './engine.ts';
import type { ExpansionStats } from './types.ts';

/**
 * L'expansion, publiée dans l'Autopilot sous son nom.
 *
 * Deux occasions, jamais plus :
 *   1. des prospects forts n'ont pas encore été explorés → « étendre autour
 *      de … » : une tâche déterministe, sûre, sous les plafonds du tour ;
 *   2. un tour terminé a laissé des candidats prioritaires hors de la file
 *      commerciale → « verser N candidats dans la file » : des prospects
 *      DISCOVERED, avec leurs preuves — jamais un message.
 *
 * Ce que la source ne propose jamais : envoyer, activer l'envoi, approuver
 * un brouillon. Ces portes ne lui appartiennent pas.
 */

const DEFAULT_RESEED_AFTER_MS = 14 * 86_400_000;

export const prospectExpansionSource: OpportunitySource = {
  name: 'prospect-expansion',

  propose(ctx: OpportunityContext): AutopilotProposal[] {
    const { repos, config, now, observation } = ctx;
    const out: AutopilotProposal[] = [];
    if (!config.sales.discoveryEnabled) return out;
    // Un tour RUNNING frais bloque une nouvelle proposition — la reprise du
    // handler s'en charge. Un tour RUNNING abandonné (crash) ne doit pas
    // geler l'expansion indéfiniment : passé le battement (updated_at), on
    // propose quand même, et le handler reprendra l'ancien tour d'abord.
    if (repos.expansion.openRuns().some((run) => !isRunStale(run, now))) return out;

    const seeds = strongestSeeds(repos, { limit: 3, excludeSeededWithinMs: DEFAULT_RESEED_AFTER_MS, now });
    if (seeds.length > 0) {
      const limits = resolveLimits({ maxDepth: 1, maxCandidates: 30, maxSearchCalls: 12, maxFetches: 30, maxAiCostUsd: 0.05 });
      const expectedCostUsd = Number((limits.maxSearchCalls * config.search.costPerQueryUsd + limits.maxAiCostUsd).toFixed(3));
      const names = seeds.map((s) => s.name).join(', ');
      const priority = seeds.some((s) => repos.sales.get(s.prospectId ?? '')?.tier === 'PRIORITY');
      out.push({
        objective: `Étendre l'univers commercial autour de ${names}`,
        category: 'DISCOVERY',
        expectedBusinessValue: priority ? 'HIGH' : 'MEDIUM',
        expectedCostUsd,
        expectedFounderTimeMinutes: 0,
        confidence: 0.6,
        urgency: 'NORMAL',
        evidence: [
          `${seeds.length} prospect(s) fort(s) jamais explorés : ${seeds.map((s) => `${s.name} (${s.domain})`).join(' · ')}`,
          `plafonds : profondeur ${limits.maxDepth}, ${limits.maxCandidates} candidats, ${limits.maxSearchCalls} requêtes, ${limits.maxAiCostUsd.toFixed(2)} $ IA`,
          `budget IA commercial du jour : ${observation.spend.salesRemainingUsd.toFixed(2)} $ restants`,
        ],
        risk: 'NONE',
        reversibility: 'REVERSIBLE',
        recommendedAgent: 'DETERMINISTIC',
        requiresHumanApproval: false,
        reason: 'une bonne entreprise en révèle d’autres : distributeurs, concurrents, exposants, membres — avec preuves',
        execution: {
          kind: 'INTERNAL_TASK', taskType: EXPANSION_TASK_TYPE, department: 'sales',
          payload: { seedProspectIds: seeds.map((s) => s.prospectId), limits, trigger: 'autopilot' },
        },
        source: 'prospect-expansion',
        fingerprintKey: `expansion:${seeds.map((s) => s.domain).sort().join(',')}`,
      });
    }

    for (const run of repos.expansion.runs(3).filter((r) => r.status === 'DONE' || r.status === 'CAPPED')) {
      if (run.purpose !== 'SALES') continue;
      const stats = run.stats as unknown as Partial<ExpansionStats>;
      const pending = repos.expansion.candidates(run.id, { kind: 'COMPANY', limit: 500 }).filter((c) => !c.isSeed && (c.stage === 'HIGH_PRIORITY' || c.stage === 'QUALIFIED') && !c.prospectId);
      if (pending.length === 0) continue;
      const high = pending.filter((c) => c.stage === 'HIGH_PRIORITY').length;
      out.push({
        objective: `Verser ${pending.length} candidat(s) d'expansion (${high} prioritaire(s)) dans la file commerciale`,
        category: 'DISCOVERY',
        expectedBusinessValue: high > 0 ? 'HIGH' : 'MEDIUM',
        expectedCostUsd: 0,
        expectedFounderTimeMinutes: 0,
        confidence: 0.7,
        urgency: high > 0 ? 'HIGH' : 'NORMAL',
        evidence: [
          `tour ${run.id} : ${stats.funnel?.universe ?? '?'} entreprise(s), ${stats.relationships ?? '?'} relation(s), preuves officielles ${stats.evidence?.OFFICIAL ?? '?'}`,
          ...pending.slice(0, 5).map((c) => `${c.companyName} (${c.canonicalDomain}) — ${c.stage}, score ${c.score ?? '?'}`),
        ],
        risk: 'NONE',
        reversibility: 'REVERSIBLE',
        recommendedAgent: 'DETERMINISTIC',
        requiresHumanApproval: false,
        reason: 'des prospects DISCOVERED avec leurs preuves ; la qualification, le contact et l’approbation restent au lot commercial',
        execution: { kind: 'INTERNAL_TASK', taskType: EXPANSION_TASK_TYPE, department: 'sales', payload: { promote: true, runId: run.id, trigger: 'autopilot' } },
        source: 'prospect-expansion',
        fingerprintKey: `expansion-promote:${run.id}`,
      });
      break;
    }
    return out;
  },

  followUp(done: AutopilotAction, task: TaskRow | null): AutopilotProposal[] {
    const result = (task?.result ?? done.result ?? {}) as { runId?: string; funnel?: { highPriority?: number; qualified?: number }; promote?: boolean };
    if (!result.runId || result.promote) return [];
    const pending = (result.funnel?.highPriority ?? 0) + (result.funnel?.qualified ?? 0);
    if (pending === 0) return [];
    return [{
      objective: `Verser ${pending} candidat(s) du tour ${result.runId} dans la file commerciale`,
      category: 'DISCOVERY', expectedBusinessValue: (result.funnel?.highPriority ?? 0) > 0 ? 'HIGH' : 'MEDIUM', expectedCostUsd: 0, expectedFounderTimeMinutes: 0,
      confidence: 0.7, urgency: 'NORMAL', evidence: [`suite de « ${done.objective} »`], risk: 'NONE', reversibility: 'REVERSIBLE',
      recommendedAgent: 'DETERMINISTIC', requiresHumanApproval: false, reason: 'les candidats qualifiés d’un tour terminé entrent dans la file, avec leurs preuves',
      execution: { kind: 'INTERNAL_TASK', taskType: EXPANSION_TASK_TYPE, department: 'sales', payload: { promote: true, runId: result.runId, trigger: 'autopilot' } },
      source: 'prospect-expansion', fingerprintKey: `expansion-promote:${result.runId}`,
    }];
  },
};
