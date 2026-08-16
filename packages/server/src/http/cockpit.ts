import type { MissionCockpit, MissionId } from '@atlas/contracts';
import { capabilitiesOf } from '@atlas/intelligence';
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
export function buildCockpit(system: AtlasSystem, missionId: MissionId): MissionCockpit {
  const { repos, config } = system;

  const llm = repos.llmCalls.forMission(missionId);
  const tools = repos.toolCalls.forMission(missionId);
  const evidence = repos.companies.evidenceForMission(missionId);
  const opportunities = repos.opportunities.forMission(missionId);
  const events = repos.events.forMission(missionId, 500);
  const mission = repos.missions.get(missionId);

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
  const need = {
    countries,
    // La langue du marché, faute de mieux : un brief allemand cherche des
    // sources allemandes.
    languages: countries.map((c) => c.slice(0, 2).toLowerCase()),
    commercial: true,
  };

  // ── Le parc ─────────────────────────────────────────────────────────────
  // Lu sur l'instance vivante du serveur, pas reconstruit : c'est là que vivent
  // les disjoncteurs ouverts et les métriques accumulées. Un registre neuf
  // afficherait « inconnu » partout et laisserait croire qu'aucun appel n'a eu
  // lieu — précisément le mensonge que ce fichier existe pour éviter.
  const fabricInstance = system.searchFabric;
  const plan = fabricInstance && countries.length > 0 ? fabricInstance.plan(need) : null;
  const trace = fabricInstance?.lastTrace() ?? null;

  const fabric: MissionCockpit['fabric'] = !fabricInstance
    ? null
    : {
        active: plan?.order[0]?.record.id ?? null,
        providers: (plan?.considered ?? []).map((candidate) => {
          const status = fabricInstance.registry.statusOf(candidate.record.id);
          const score = status?.score ?? null;
          return {
            id: candidate.record.id,
            name: candidate.record.name,
            health: candidate.health,
            suitability: candidate.suitability.verdict,
            circuit: candidate.record.breaker.state,
            cooldownRemainingMs: candidate.record.breaker.snapshot().cooldownRemainingMs,
            excludedReason: candidate.excluded,
            selected: plan?.order[0]?.record.id === candidate.record.id,
            calls: status?.metrics.calls ?? 0,
            // `null` plutôt que zéro : un moteur jamais appelé n'a pas un taux
            // de réussite nul, il n'en a pas.
            successRate: score?.successRate ?? null,
            averageLatencyMs: score?.averageLatencyMs ?? null,
            costUsd: round4(status?.metrics.totalCostUsd ?? 0),
          };
        }),
        lastFailover: (trace?.attempts ?? [])
          .filter((attempt) => attempt.failedOver)
          .map((attempt) => ({ providerId: attempt.providerId, outcome: attempt.outcome })),
        blocked: plan?.blocked ?? false,
        blockedReason: plan?.blockedReason ?? null,
      };

  // L'adéquation affichée est celle du moteur qui répondra, pas une moyenne du
  // parc : les suivants ne servent qu'en cas de bascule, et leur couverture ne
  // dit rien de ce qui va réellement être interrogé.
  //
  // Quand le parc est bloqué, on retombe sur le moteur *examiné* — sinon
  // l'écran afficherait « inconnu » pour un moteur dont on sait précisément
  // qu'il est inadapté, et l'opérateur perdrait la seule information qui lui
  // dit quoi faire. Ne rien savoir et savoir que ça ne conviendra pas sont
  // deux états distincts, et c'est leur confusion qui a coûté une mission.
  //
  // Reste `null` tant qu'aucun marché n'est connu : juger l'adéquation sans
  // savoir à quoi reviendrait à la déclarer bonne par défaut.
  const reference = plan?.order[0] ?? plan?.considered[0] ?? null;
  const suitability = reference?.suitability ?? null;

  // Les capacités affichées sont celles de ce même moteur, pas celles de la clé
  // de configuration. Avec `auto`, cette clé n'est le nom d'aucun moteur : la
  // lire rendrait les capacités « moteur non répertorié », c'est-à-dire
  // pessimistes partout, pour un parc parfaitement capable.
  const activeKey = reference?.record.id ?? config.search.provider;
  const caps = capabilitiesOf(activeKey);

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
      // Le moteur réellement en tête, pas le mode qui l'a sélectionné : afficher
      // « auto » ne dirait pas qui répond.
      provider: activeKey,
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

    fabric,

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
