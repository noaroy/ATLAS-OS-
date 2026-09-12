import type { MissionSearchNeed } from './capabilities.ts';
import { assessSuitability } from './capabilities.ts';
import type { SearchProviderRegistry } from './fabric/registry.ts';
import type { SearchProviderContext, SearchProviderOutcome, SearchRequest } from './types.ts';

/**
 * La recherche est-elle prête pour une mission, et jusqu'à quel point ?
 *
 * Le 10 septembre, tous les moteurs répondaient — et aucun ne cherchait :
 * SearXNG rendait « zéro résultat » avec ses quatre moteurs en CAPTCHA,
 * DuckDuckGo servait sa page de vérification, Brave n'avait pas de clé. Un
 * contrôle qui se contente de « le service répond » aurait dit vert.
 *
 * Ici chaque moteur est interrogé pour de vrai, avec une requête du marché
 * visé, et compte seulement s'il rend des résultats. Trois verdicts :
 *
 *   SEARCH_READY     au moins deux moteurs rendent des résultats — l'un peut
 *                    tomber en cours de mission sans l'arrêter
 *   SEARCH_DEGRADED  un seul — la mission peut partir, sans filet
 *   SEARCH_BLOCKED   aucun — la mission ne part pas, et rien ne la remplace
 *
 * Rien ici ne parle à un modèle. Un moteur absent n'est pas remplacé par une
 * imagination : c'est la règle qui rend ce contrôle honnête.
 */
export type SearchReadiness = 'SEARCH_READY' | 'SEARCH_DEGRADED' | 'SEARCH_BLOCKED';

export interface ProviderProbe {
  key: string;
  label: string;
  /** Configuré et déclaré utilisable par le moteur lui-même. */
  available: boolean;
  /** Adapté au besoin de la mission (langue, pays, commercial). */
  suitable: boolean;
  outcome: SearchProviderOutcome | 'not-probed';
  results: number;
  durationMs: number;
  detail: string;
}

export interface SearchReadinessReport {
  readiness: SearchReadiness;
  /** Les moteurs qui rendent réellement des résultats pour ce marché. */
  usable: string[];
  probes: ProviderProbe[];
  summary: string;
}

/** Un moteur compte s'il est configuré, adapté, et a rendu au moins un résultat. */
export function isUsableProbe(p: ProviderProbe): boolean {
  return p.available && p.suitable && p.outcome === 'ok' && p.results > 0;
}

export function classifySearchReadiness(probes: readonly ProviderProbe[]): SearchReadinessReport {
  const usable = probes.filter(isUsableProbe).map((p) => p.key);
  const readiness: SearchReadiness =
    usable.length >= 2 ? 'SEARCH_READY' : usable.length === 1 ? 'SEARCH_DEGRADED' : 'SEARCH_BLOCKED';

  const lignes = probes.map((p) => {
    const etat = isUsableProbe(p)
      ? `OK (${p.results} résultat(s), ${p.durationMs} ms)`
      : !p.available ? `non configuré — ${p.detail}`
        : !p.suitable ? `inadapté au marché — ${p.detail}`
          : `${p.outcome} — ${p.detail}`;
    return `${p.key}: ${etat}`;
  });
  const summary = readiness === 'SEARCH_BLOCKED'
    ? `Aucun moteur ne rend de résultat. ${lignes.join(' · ')}`
    : readiness === 'SEARCH_DEGRADED'
      ? `Un seul moteur utilisable (${usable[0]}), sans relève. ${lignes.join(' · ')}`
      : `${usable.length} moteurs utilisables : ${usable.join(', ')}.`;

  return { readiness, usable, probes: [...probes], summary };
}

/**
 * Interroge chaque moteur du registre, un par un, hors du tissu.
 *
 * Passer par le tissu masquerait l'état des moteurs de relève : il s'arrête
 * au premier qui répond. Ici on veut savoir, avant de partir, combien peuvent
 * répondre — c'est la différence entre READY et DEGRADED.
 */
export async function probeSearchProviders(
  registry: SearchProviderRegistry,
  request: SearchRequest,
  need: MissionSearchNeed,
  ctx: SearchProviderContext,
): Promise<ProviderProbe[]> {
  const probes: ProviderProbe[] = [];
  for (const record of registry.all()) {
    const provider = record.provider;
    const availability = provider.availability();
    const suitability = assessSuitability(provider, need);
    const base = {
      key: provider.key,
      label: provider.label,
      available: availability.available,
      suitable: suitability.verdict !== 'unsuitable',
    };
    if (!availability.available) {
      probes.push({ ...base, outcome: 'not-probed', results: 0, durationMs: 0, detail: availability.reason });
      continue;
    }
    if (!base.suitable) {
      probes.push({ ...base, outcome: 'not-probed', results: 0, durationMs: 0, detail: suitability.gaps.join(' · ') });
      continue;
    }
    const started = Date.now();
    try {
      const response = await provider.search(request, ctx);
      probes.push({
        ...base,
        outcome: response.outcome,
        results: response.results.length,
        durationMs: Date.now() - started,
        detail: response.detail,
      });
    } catch (err) {
      probes.push({
        ...base,
        outcome: 'unavailable',
        results: 0,
        durationMs: Date.now() - started,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return probes;
}
