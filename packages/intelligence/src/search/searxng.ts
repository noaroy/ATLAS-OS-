import { AtlasError, describeError, nowIso, withDeadline } from '@atlas/core';
import type {
  SearchAvailability,
  SearchProvider,
  SearchProviderContext,
  SearchRequest,
  SearchResponse,
  SearchResult,
} from './types.ts';

/**
 * SearXNG — le moteur de recherche d'ATLAS, auto-hébergé.
 *
 * Un métamoteur : il interroge plusieurs moteurs publics et fusionne leurs
 * résultats. Deux propriétés le rendent préférable à une API commerciale pour
 * cet usage.
 *
 * D'abord il ne coûte rien. ATLAS dépense déjà de l'argent réel à chaque appel
 * d'inférence ; ajouter un abonnement obligatoire pour la seule brique qui
 * peut être auto-hébergée serait un coût subi sans contrepartie.
 *
 * Ensuite il tourne sur notre VPS, sur le réseau interne Docker. Pas de clé à
 * protéger, pas de quota à surveiller, pas de tiers qui décide un jour de
 * changer ses conditions.
 *
 * Le contrat reste celui de {@link SearchProvider} : une requête courte entre,
 * des URLs et des extraits sortent. Business Expansion ne sait pas que SearXNG
 * existe, et basculer vers Brave demande une variable d'environnement.
 */

export interface SearxngOptions {
  /** Racine de l'instance, typiquement `http://searxng:8080` sur le réseau Docker. */
  baseUrl: string;
  /**
   * Moteurs interrogés, séparés par des virgules. Vide = ceux configurés dans
   * l'instance.
   */
  engines: string;
}

interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
}

export class SearxngSearchProvider implements SearchProvider {
  readonly key = 'searxng';
  readonly label = 'SearXNG (auto-hébergé)';

  constructor(private readonly options: SearxngOptions) {}

  availability(): SearchAvailability {
    if (!this.options.baseUrl) {
      return {
        available: false,
        reason:
          "Aucune instance SearXNG configurée. Renseignez SEARXNG_BASE_URL — par exemple http://searxng:8080 sur le réseau Docker.",
      };
    }
    return {
      available: true,
      reason: 'Recherche auto-hébergée, sans clé ni quota, résultats sourcés.',
    };
  }

  async search(request: SearchRequest, ctx: SearchProviderContext): Promise<SearchResponse> {
    const started = Date.now();
    const retrievedAt = nowIso();

    let url: URL;
    try {
      url = new URL('/search', this.options.baseUrl);
    } catch {
      return fail('unavailable', `SEARXNG_BASE_URL est invalide : ${this.options.baseUrl}`, started);
    }

    url.searchParams.set('q', request.query);
    url.searchParams.set('format', 'json');
    // Les résultats web classiques suffisent : ni images, ni vidéos, ni
    // actualités. Une entreprise s'identifie par son site, pas par un clip.
    url.searchParams.set('categories', 'general');
    if (this.options.engines) url.searchParams.set('engines', this.options.engines);
    if (request.language) url.searchParams.set('language', request.language);
    // SearXNG pagine par dix ; une page suffit pour ce que le filtrage retient.
    url.searchParams.set('pageno', '1');

    try {
      const response = await withDeadline(
        (signal) =>
          fetch(url, {
            method: 'GET',
            signal,
            headers: {
              accept: 'application/json',
              'user-agent': 'ATLAS-OS/1.0 (+autonomous research agent)',
            },
          }),
        {
          ms: ctx.timeoutMs ?? 0,
          label: `recherche SearXNG « ${request.query.slice(0, 60)} »`,
          signal: ctx.signal,
          onOrphan: (label) =>
            ctx.logger.error("un appel de recherche n'a pas honoré son annulation", { label }),
        },
      );

      if (response.status === 429) {
        // Une instance auto-hébergée limite parfois ses propres appelants, ou
        // se fait limiter par les moteurs qu'elle interroge.
        return fail('rate-limited', 'SearXNG a répondu HTTP 429 (limite de débit).', started);
      }
      if (!response.ok) {
        return fail('http-error', `SearXNG a répondu HTTP ${response.status}.`, started);
      }

      let body: { results?: SearxngResult[] };
      try {
        body = (await response.json()) as { results?: SearxngResult[] };
      } catch {
        // Une instance mal configurée rend du HTML là où on attend du JSON :
        // le dire clairement évite une heure de recherche à côté.
        return fail(
          'http-error',
          "SearXNG n'a pas rendu de JSON. Vérifiez que le format `json` est autorisé dans settings.yml.",
          started,
        );
      }

      const results: SearchResult[] = [];
      for (const item of body.results ?? []) {
        // Sans URL, ce n'est pas un résultat de recherche : c'est du bruit.
        if (!item.url?.trim()) continue;
        results.push({
          title: (item.title ?? '').trim(),
          url: item.url.trim(),
          snippet: (item.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 600),
          // Le moteur d'origine est conservé dans la provenance : comparer
          // SearXNG à Brave n'aurait aucun sens sans savoir qui a répondu.
          provider: item.engine ? `${this.key}:${item.engine}` : this.key,
          rank: results.length + 1,
          query: request.query,
          retrievedAt,
        });
        if (results.length >= request.count) break;
      }

      return {
        results,
        outcome: results.length > 0 ? 'ok' : 'empty',
        detail:
          results.length > 0
            ? `${results.length} résultat(s) pour « ${request.query} ».`
            : `Aucun résultat pour « ${request.query} ».`,
        // Auto-hébergé : la requête ne coûte rien au-delà du VPS déjà payé.
        costUsd: 0,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      const timedOut = err instanceof AtlasError && err.code === 'TIMEOUT';
      ctx.logger.warn('la recherche a échoué', { provider: this.key, error: describeError(err) });
      return fail(
        timedOut ? 'timeout' : 'http-error',
        timedOut
          ? 'La recherche a dépassé son délai.'
          : `SearXNG injoignable : ${describeError(err)}`,
        started,
      );
    }
  }
}

function fail(
  outcome: SearchResponse['outcome'],
  detail: string,
  started: number,
): SearchResponse {
  return { results: [], outcome, detail, costUsd: 0, durationMs: Date.now() - started };
}
