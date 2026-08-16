import { describeError, nowIso, withDeadline } from '@atlas/core';
import type {
  SearchAvailability,
  SearchProvider,
  SearchProviderContext,
  SearchRequest,
  SearchResponse,
  SearchResult,
} from './types.ts';

/**
 * Marginalia — un index indépendant, en second moteur.
 *
 * ATLAS avait un seul moteur, et le jour où DuckDuckGo a bridé cette adresse,
 * plus aucune mission réelle n'était possible. Un système dont la découverte
 * repose sur une source unique n'a pas de découverte : il a une dépendance.
 *
 * Marginalia est un moteur indépendant, construit par une seule personne, dont
 * l'index privilégie les sites artisanaux et documentaires plutôt que les pages
 * optimisées pour le référencement. Son API publique est gratuite, sans clé,
 * sans compte et sans dispositif anti-robot — elle est faite pour être appelée.
 *
 * Deux limites, dites franchement. L'index est petit : environ un pour cent de
 * ce que couvre un grand moteur, et nettement plus fourni en anglais qu'en
 * allemand. Et son biais éditorial l'éloigne du commerce — il ramènera plus
 * volontiers une étude de marché qu'un distributeur régional.
 *
 * Ce n'est donc pas un remplaçant, c'est une seconde jambe. Un moteur qui
 * répond quand l'autre refuse vaut mieux qu'aucun, et deux index distincts
 * apportent une corroboration qu'un seul ne peut pas donner.
 */

const ENDPOINT = 'https://api.marginalia.nu/public/search';

interface MarginaliaResult {
  url?: string;
  title?: string;
  description?: string;
  quality?: number;
}

interface MarginaliaResponse {
  license?: string;
  results?: MarginaliaResult[];
}

export class MarginaliaSearchProvider implements SearchProvider {
  readonly key = 'marginalia';
  readonly label = 'Marginalia (index indépendant, sans clé)';

  availability(): SearchAvailability {
    return {
      available: true,
      reason: 'API publique, sans clé ni compte. Index restreint, à privilégier en anglais.',
    };
  }

  async search(request: SearchRequest, ctx: SearchProviderContext): Promise<SearchResponse> {
    const started = Date.now();
    const retrievedAt = nowIso();
    const timeoutMs = ctx.timeoutMs ?? 15_000;

    try {
      const response = await withDeadline(
        (signal) =>
          fetch(`${ENDPOINT}/${encodeURIComponent(request.query)}`, {
            headers: {
              accept: 'application/json',
              // Un agent identifiable : ce service est tenu par une personne, et
              // se présenter est la moindre des politesses envers une ressource
              // offerte gratuitement.
              'user-agent': 'ATLAS-OS/1.0 (recherche B2B ; usage faible volume)',
            },
            signal,
          }),
        {
          ms: timeoutMs,
          label: `recherche Marginalia « ${request.query} »`,
          signal: ctx.signal,
          onOrphan: (label) =>
            ctx.logger.error("une recherche n'a pas honoré son annulation", { label }),
        },
      );

      if (response.status === 429) {
        return this.#fail('rate-limited', 'Marginalia limite le débit ; espacez les requêtes.', started);
      }
      if (!response.ok) {
        return this.#fail('http-error', `Marginalia a répondu ${response.status}.`, started);
      }

      const body = (await response.json()) as MarginaliaResponse;
      const results = normalise(body, request, retrievedAt).slice(0, request.count);

      return {
        results,
        outcome: results.length > 0 ? 'ok' : 'empty',
        detail:
          results.length > 0
            ? `${results.length} résultat(s) de l'index Marginalia.`
            : "Aucun résultat. L'index est restreint et couvre mal les requêtes non anglophones.",
        costUsd: 0,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      const failure = describeError(err);
      const timedOut = /timeout|deadline|abort/i.test(failure);
      return this.#fail(
        timedOut ? 'timeout' : 'unavailable',
        timedOut ? `Recherche interrompue après ${timeoutMs} ms.` : `Recherche impossible : ${failure}`,
        started,
      );
    }
  }

  #fail(outcome: SearchResponse['outcome'], detail: string, started: number): SearchResponse {
    return { results: [], outcome, detail, costUsd: 0, durationMs: Date.now() - started };
  }
}

/**
 * Normalise vers le contrat commun.
 *
 * Deux règles strictes. Seules les URL web publiques passent — un protocole
 * exotique n'a rien à faire dans une preuve. Et un même domaine ne compte
 * qu'une fois : Marginalia rend volontiers plusieurs pages d'un même site, ce
 * qui gonflerait artificiellement le nombre de candidats.
 */
export function normalise(
  body: MarginaliaResponse,
  request: SearchRequest,
  retrievedAt: string,
): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();

  for (const raw of body.results ?? []) {
    const url = safeUrl(raw.url);
    if (!url) continue;

    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (seen.has(host)) continue;
    seen.add(host);

    const title = (raw.title ?? '').trim();
    if (!title) continue;

    out.push({
      title,
      url,
      snippet: (raw.description ?? '').replace(/\s+/g, ' ').trim(),
      provider: 'marginalia',
      rank: out.length + 1,
      query: request.query,
      retrievedAt,
    });
  }

  return out;
}

function safeUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}
