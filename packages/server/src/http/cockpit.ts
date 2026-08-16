import type { MissionCockpit, MissionId } from '@atlas/contracts';
import {
  assessSuitability,
  capabilitiesOf,
  DuckDuckGoSearchProvider,
  MarginaliaSearchProvider,
  type SearchProvider,
} from '@atlas/intelligence';
import type { AtlasSystem } from '../bootstrap.ts';

/**
 * Ce que le Command Center affiche pendant une mission.
 *
 * Un seul principe, et il gouverne tout ce fichier : **chaque nombre est lu
 * dans la base, jamais recalculé côté navigateur**. Un compteur estimé par
 * l'interface a exactement la même apparence qu'un compteur mesuré, et rien ne
 * permet plus ensuite de distinguer les deux. Sur un tableau de bord qui pilote
 * une dépense réelle, c'est inacceptable.
 *
 * Rassemblé côté serveur pour une seconde raison : la console demande la fiche
 * d'une mission toutes les deux secondes et demie. Vingt requêtes séparées à
 * cette cadence coûteraient plus cher que la mission observée.
 */
/**
 * Le moteur configuré, pour évaluer son adéquation.
 *
 * Instancié sans être appelé : `assessSuitability` ne lit que des capacités
 * déclarées. Aucune requête ne part d'ici.
 */
function engineFor(key: string): SearchProvider | null {
  if (key === 'duckduckgo') return new DuckDuckGoSearchProvider();
  if (key === 'marginalia') return new MarginaliaSearchProvider();
  return null;
}

export function buildCockpit(system: AtlasSystem, missionId: MissionId): MissionCockpit {
  const { repos, config } = system;

  const llm = repos.llmCalls.forMission(missionId);
  const tools = repos.toolCalls.forMission(missionId);
  const evidence = repos.companies.evidenceForMission(missionId);
  const opportunities = repos.opportunities.forMission(missionId);
  const events = repos.events.forMission(missionId, 500);
  const mission = repos.missions.get(missionId);
  const engine = engineFor(config.search.provider);

  const spentUsd = llm.reduce((sum, call) => sum + (call.costUsd ?? 0), 0);
  const tokensUsed = llm.reduce((sum, call) => sum + call.inputTokens + call.outputTokens, 0);

  // Le plafond effectif : celui de la mission s'il est plus serré que celui du
  // déploiement. C'est la même règle que celle appliquée par l'orchestrateur —
  // l'afficher autrement mentirait sur ce qui va réellement arrêter la mission.
  const declared = (mission?.context as { budgetUsd?: unknown } | null)?.budgetUsd;
  const maxUsd =
    typeof declared === 'number' && declared > 0
      ? Math.min(config.budget.maxMissionCostUsd || declared, declared)
      : config.budget.maxMissionCostUsd;

  const caps = capabilitiesOf(config.search.provider);
  const searchCalls = tools.filter((call) => call.external);

  // ── Santé : lue, jamais mesurée ─────────────────────────────────────────
  // Sonder le moteur à chaque rafraîchissement de la console le ferait brider
  // en quelques minutes — précisément ce qui bloque le pilote aujourd'hui. On
  // se contente donc du dernier appel réellement effectué, et l'on assume de
  // ne rien savoir tant qu'aucun n'a eu lieu.
  const lastExternal = searchCalls[searchCalls.length - 1];
  const health: 'healthy' | 'unhealthy' | 'unknown' = !lastExternal
    ? 'unknown'
    : lastExternal.ok && lastExternal.outcome !== 'rate-limited'
      ? 'healthy'
      : 'unhealthy';

  // ── Adéquation : déduite du brief, sans aucun appel ─────────────────────
  const brief = (mission?.context as { brief?: { markets?: { countries?: string[] } } } | null)?.brief;
  const countries = brief?.markets?.countries?.filter(Boolean) ?? [];
  const suitability =
    engine && countries.length > 0
      ? assessSuitability(engine, {
          countries,
          // La langue du marché, faute de mieux : un brief allemand cherche des
          // sources allemandes.
          languages: countries.map((c) => c.slice(0, 2).toLowerCase()),
          commercial: true,
        })
      : null;

  return {
    missionId,
    mode: config.llm.mode,

    budget: {
      maxUsd,
      spentUsd: round4(spentUsd),
      remainingUsd: round4(Math.max(0, maxUsd - spentUsd)),
      maxTokens: mission?.tokenBudget ?? config.budget.maxMissionTokens,
      tokensUsed,
    },

    search: {
      provider: config.search.provider,
      health,
      suitability: suitability?.verdict ?? 'unknown',
      suitabilityGaps: suitability?.gaps ?? [],
      commercialDiscovery: caps.commercialDiscovery,
      geographicCoverage: caps.geographicCoverage,
      languageCoverage: caps.languageCoverage,
      caveat: caps.caveat,
      queries: searchCalls.length,
      rateLimited: tools.filter((call) => call.outcome === 'rate-limited').length,
      failures: tools.filter((call) => !call.ok).length,
    },

    pipeline: {
      candidates: opportunities.length,
      shortlisted: opportunities.filter((o) => o.stage === 'shortlisted').length,
      approved: opportunities.filter((o) => o.stage === 'approved').length,
      rejected: opportunities.filter((o) => o.stage === 'rejected').length,
      pagesFetched: tools.filter((call) => call.tool === 'http_fetch' || call.tool === 'fetch_page').length,
      evidence: {
        total: evidence.length,
        observed: evidence.filter((e) => e.nature === 'observed').length,
        reported: evidence.filter((e) => e.nature === 'reported').length,
        inferred: evidence.filter((e) => e.nature === 'inferred').length,
        sourced: evidence.filter((e) => Boolean(e.sourceRef)).length,
      },
    },

    inference: {
      calls: llm.length,
      failedCalls: llm.filter((call) => !call.ok).length,
      inputTokens: llm.reduce((sum, call) => sum + call.inputTokens, 0),
      outputTokens: llm.reduce((sum, call) => sum + call.outputTokens, 0),
      models: [...new Set(llm.map((call) => call.model))],
    },

    reliability: {
      // Une tentative au-delà de la première est un réessai : le compte se lit
      // dans les étapes, pas dans une estimation.
      retries: repos.missions
        .tasksFor(missionId)
        .reduce((sum, task) => sum + Math.max(0, task.attempts - 1), 0),
      timeouts: llm.filter((call) => /timeout|deadline/i.test(call.error ?? '')).length,
      warnings: events.filter((event) => event.severity === 'warning').length,
      errors: events.filter((event) => event.severity === 'error' || event.severity === 'critical').length,
    },

    review: repos.opportunities.reviewedFor(missionId),
  };
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;
