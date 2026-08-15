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
 * Brave Search — le premier moteur réel d'ATLAS.
 *
 * Une API de recherche ordinaire : une requête courte entre, des URLs et des
 * extraits sortent, en quelques centaines de millisecondes. C'est exactement ce
 * qui manquait — LIVE #005 attendait sept minutes qu'un modèle fasse ce travail
 * et ne l'obtenait jamais.
 *
 * La clé ne quitte jamais l'en-tête de la requête : elle n'apparaît ni dans les
 * journaux, ni dans les erreurs, ni dans la télémétrie. Les messages d'erreur
 * ci-dessous ne citent que des codes de statut.
 */

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

/**
 * Tarif indicatif par requête, en USD.
 *
 * Configurable parce qu'il dépend du forfait souscrit. Ce n'est pas une
 * estimation d'inférence : une recherche a un prix fixe et connu, et c'est
 * précisément ce qui la rend pilotable.
 */
export interface BraveOptions {
  apiKey: string;
  costPerQueryUsd: number;
}

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

export class BraveSearchProvider implements SearchProvider {
  readonly key = 'brave';
  readonly label = 'Brave Search';

  constructor(private readonly options: BraveOptions) {}

  availability(): SearchAvailability {
    if (!this.options.apiKey) {
      return {
        available: false,
        reason:
          'Aucune clé Brave configurée. Renseignez BRAVE_SEARCH_API_KEY pour activer la recherche réelle.',
      };
    }
    return { available: true, reason: 'Recherche web déterministe, résultats sourcés.' };
  }

  async search(request: SearchRequest, ctx: SearchProviderContext): Promise<SearchResponse> {
    const started = Date.now();
    const retrievedAt = nowIso();

    const url = new URL(ENDPOINT);
    url.searchParams.set('q', request.query);
    url.searchParams.set('count', String(Math.min(Math.max(request.count, 1), 20)));
    if (request.country) url.searchParams.set('country', request.country);
    if (request.language) url.searchParams.set('search_lang', request.language);

    try {
      const response = await withDeadline(
        (signal) =>
          fetch(url, {
            method: 'GET',
            signal,
            headers: {
              accept: 'application/json',
              'accept-encoding': 'gzip',
              // Le seul endroit où la clé apparaît, et elle n'en sort pas.
              'x-subscription-token': this.options.apiKey,
            },
          }),
        {
          ms: ctx.timeoutMs ?? 0,
          label: `recherche Brave « ${request.query.slice(0, 60)} »`,
          signal: ctx.signal,
          onOrphan: (label) =>
            ctx.logger.error("un appel de recherche n'a pas honoré son annulation", { label }),
        },
      );

      if (response.status === 429) {
        return fail('rate-limited', 'Quota Brave atteint (HTTP 429).', started);
      }
      if (!response.ok) {
        // Le statut suffit à diagnostiquer ; le corps peut contenir la requête.
        return fail('http-error', `Brave a répondu HTTP ${response.status}.`, started);
      }

      const body = (await response.json()) as { web?: { results?: BraveWebResult[] } };
      const raw = body.web?.results ?? [];

      const results: SearchResult[] = [];
      for (const item of raw) {
        // Sans URL, ce n'est pas un résultat de recherche : c'est du bruit.
        if (!item.url?.trim()) continue;
        results.push({
          title: (item.title ?? '').trim(),
          url: item.url.trim(),
          snippet: stripTags(item.description ?? '').slice(0, 600),
          provider: this.key,
          rank: results.length + 1,
          query: request.query,
          retrievedAt,
        });
      }

      return {
        results,
        outcome: results.length > 0 ? 'ok' : 'empty',
        detail:
          results.length > 0
            ? `${results.length} résultat(s) pour « ${request.query} ».`
            : `Aucun résultat pour « ${request.query} ».`,
        // Facturé à la requête, aboutie ou non : c'est l'appel qui compte.
        costUsd: this.options.costPerQueryUsd,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      const timedOut = err instanceof AtlasError && err.code === 'TIMEOUT';
      ctx.logger.warn('la recherche a échoué', { provider: this.key, error: describeError(err) });
      return fail(
        timedOut ? 'timeout' : 'http-error',
        timedOut ? 'La recherche a dépassé son délai.' : `Recherche impossible : ${describeError(err)}`,
        started,
      );
    }
  }
}

/** Un échec de recherche ne coûte rien : la requête n'a pas abouti. */
function fail(
  outcome: SearchResponse['outcome'],
  detail: string,
  started: number,
): SearchResponse {
  return { results: [], outcome, detail, costUsd: 0, durationMs: Date.now() - started };
}

/** Brave met les termes trouvés en gras ; le texte brut suffit au filtrage. */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
