import type { MeasuredEconomics, MissionEconomics, MissionId } from '@atlas/contracts';
import type { Repositories } from '@atlas/data';
import { BLENDED_PRICES_USD_PER_MTOK } from '@atlas/llm';

/**
 * What a mission cost, and what it bought.
 *
 * Cost per qualified opportunity is the number that decides whether a
 * department is a business, so it is computed from stored facts — token
 * counters, row counts, event records — rather than estimated from logs.
 */

/**
 * Tarif mélangé, en USD par million de jetons.
 *
 * Ne sert plus qu'aux missions dépourvues de comptabilité par appel : elles
 * n'ont qu'un total de jetons, sans répartition entrée/sortie. Les tarifs
 * détaillés vivent dans `@atlas/llm`, au plus près de l'endroit où la dépense
 * est autorisée.
 */
export const MODEL_PRICES_USD_PER_MTOK = BLENDED_PRICES_USD_PER_MTOK;

/** Resolves a blended price, tolerating dated model ids. */
export function priceFor(model: string): number | null {
  if (MODEL_PRICES_USD_PER_MTOK[model] !== undefined) return MODEL_PRICES_USD_PER_MTOK[model]!;
  for (const [key, price] of Object.entries(MODEL_PRICES_USD_PER_MTOK)) {
    if (model.startsWith(key)) return price;
  }
  return null;
}

export function estimateCostUsd(tokens: number, model: string): number | null {
  const price = priceFor(model);
  if (price === null) return null;
  return round4((tokens / 1_000_000) * price);
}

export interface EconomicsInput {
  repos: Repositories;
  missionId: MissionId;
  /** The model the mission's agents ran on, for pricing. */
  model: string;
  /** True when the deployment was running simulated inference. */
  simulated: boolean;
}

/** Assembles the full economic picture of one mission. */
export function missionEconomics(input: EconomicsInput): MissionEconomics {
  const { repos, missionId } = input;
  const mission = repos.missions.require(missionId);
  const tasks = repos.missions.tasksFor(missionId);

  const tokensUsed = repos.missions.tokensUsed(missionId);
  const durationMs =
    mission.finishedAt && mission.startedAt
      ? Date.parse(mission.finishedAt) - Date.parse(mission.startedAt)
      : tasks.reduce((sum, t) => sum + t.durationMs, 0);

  const funnel = repos.opportunities.funnelFor(missionId);
  const discovered = Object.values(funnel).reduce((sum, n) => sum + n, 0);
  const qualified = repos.opportunities.countQualified(missionId);
  const shortlisted = funnel.shortlisted;

  // La mesure l'emporte sur l'estimation quand elle existe : le tarif mélangé
  // était une approximation faute de mieux, la comptabilité par appel connaît
  // la répartition entrée/sortie et le modèle réellement employé.
  const measured = measuredEconomics(repos, missionId, {
    discovered,
    qualified,
    shortlisted,
  });

  // Une mission simulée n'a rien coûté, et doit afficher zéro — pas le prix
  // qu'elle aurait eu si elle avait été réelle. L'estimation par tarif mélangé
  // ne connaît que le modèle *configuré* ; sans ce garde-fou elle chiffrerait
  // en dollars des jetons qui n'ont jamais quitté la machine, et le fondateur
  // lirait une dépense là où il n'y en a pas eu.
  const estimatedCostUsd = input.simulated
    ? 0
    : (measured?.costUsd ?? estimateCostUsd(tokensUsed, input.model));
  const costPerQualifiedOpportunity =
    estimatedCostUsd !== null && qualified > 0 ? round4(estimatedCostUsd / qualified) : null;

  return {
    missionId,
    tokensUsed,
    estimatedCostUsd,
    measured,
    externalCalls: countExternalCalls(repos, missionId),
    durationMs,
    opportunitiesDiscovered: discovered,
    opportunitiesQualified: qualified,
    opportunitiesShortlisted: shortlisted,
    knowledgeReused: repos.opportunities.countReused(missionId),
    costPerQualifiedOpportunity,
    simulated: input.simulated || repos.companies.evidenceForMission(missionId).some((e) => e.simulated),
  };
}

/**
 * La décomposition réelle d'une mission, quand elle a été mesurée.
 *
 * Rend `null` plutôt que d'extrapoler pour une mission dépourvue de
 * comptabilité par appel. Recalculer le coût de LIVE #001 avec une répartition
 * entrée/sortie qu'on n'a jamais mesurée réécrirait l'histoire de l'incident.
 */
function measuredEconomics(
  repos: Repositories,
  missionId: MissionId,
  counts: { discovered: number; qualified: number; shortlisted: number },
): MeasuredEconomics | null {
  if (!repos.llmCalls.hasCalls(missionId)) return null;

  const totals = repos.llmCalls.totals(missionId);
  const perUnit = (n: number): number | null => (n > 0 ? round4(totals.costUsd / n) : null);

  return {
    llmCalls: totals.calls,
    failedCalls: totals.failedCalls,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    costUsd: totals.costUsd,
    byModel: repos.llmCalls.byModel(missionId).map((m) => ({
      model: m.model,
      calls: m.calls,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      costUsd: m.costUsd,
    })),
    byStep: repos.llmCalls.byStep(missionId).map((s) => ({
      taskRef: s.taskRef,
      model: s.model,
      calls: s.calls,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      costUsd: s.costUsd,
      durationMs: s.durationMs,
      failures: s.failures,
    })),
    costPerDiscoveredOpportunity: perUnit(counts.discovered),
    costPerQualifiedOpportunity: perUnit(counts.qualified),
    costPerShortlistedOpportunity: perUnit(counts.shortlisted),
  };
}

/**
 * Les appels d'outils sortis d'ATLAS — réussis comme échoués.
 *
 * Lu dans `tool_calls`, plus dans le journal d'événements. La différence n'est
 * pas cosmétique : `agent.tool` est publié en sévérité `debug`, que le journal
 * écarte, si bien qu'un outil qui *réussissait* n'y laissait aucune trace. Le
 * compteur ne voyait donc que les échecs — LIVE #001 rapportait « 5 appels
 * externes » précisément parce que les cinq avaient échoué.
 */
function countExternalCalls(repos: Repositories, missionId: MissionId): number {
  return repos.toolCalls.countExternal(missionId);
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
