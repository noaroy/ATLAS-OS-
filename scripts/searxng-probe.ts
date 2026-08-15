/**
 * Une seule recherche, par le vrai provider, sans rien d'autre.
 *
 * Sert au smoke test de déploiement. Il aurait été plus simple d'écrire un
 * `fetch` de quelques lignes, mais cela n'aurait rien prouvé : ce qu'on veut
 * valider, c'est le code qu'ATLAS exécutera réellement — la normalisation, la
 * provenance, le coût, le comportement en cas de panne.
 *
 * Ne touche ni à Hermès, ni à un agent, ni à Anthropic. Une requête HTTP vers
 * l'instance SearXNG, et rien de plus.
 *
 *   node --import tsx scripts/searxng-probe.ts
 *
 * Rend du JSON sur la sortie standard, pour que le script de déploiement le
 * mette en forme sans avoir à interpréter de la prose.
 */

import { createLogger } from '@atlas/core';
import { SearxngSearchProvider } from '@atlas/intelligence';

const QUERY = process.env.PROBE_QUERY ?? 'Verpackungsmaschinen Deutschland';
const BASE_URL = process.env.SEARXNG_BASE_URL ?? 'http://searxng:8080';
const ENGINES = process.env.SEARXNG_ENGINES ?? '';
const TIMEOUT_MS = Number(process.env.ATLAS_SEARCH_TIMEOUT_MS ?? 15000);

// `error` et non `info` : la sortie standard porte le JSON, elle ne doit pas
// être polluée par des journaux.
const logger = createLogger({ level: 'error', pretty: false });

const provider = new SearxngSearchProvider({ baseUrl: BASE_URL, engines: ENGINES });
const availability = provider.availability();

const started = Date.now();
const response = await provider.search(
  { query: QUERY, count: 10, language: 'de', country: 'DE' },
  { logger, timeoutMs: TIMEOUT_MS },
);
const elapsedMs = Date.now() - started;

/** Le domaine seul : c'est ce qu'un humain lit pour juger un résultat. */
const domainOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '(url illisible)';
  }
};

const first = response.results[0];

console.log(
  JSON.stringify(
    {
      query: QUERY,
      // L'URL de l'instance, jamais un secret : SearXNG n'en a pas.
      baseUrl: BASE_URL,
      engines: ENGINES || '(ceux de l’instance)',
      configured: availability.available,
      outcome: response.outcome,
      detail: response.detail,
      elapsedMs,
      providerDurationMs: response.durationMs,
      resultCount: response.results.length,
      externalCostUsd: response.costUsd,
      // Les moteurs qui ont réellement contribué, lus dans la provenance de
      // chaque résultat.
      enginesAnswered: [
        ...new Set(response.results.map((r) => r.provider.split(':')[1] ?? r.provider)),
      ].sort(),
      topDomains: [...new Set(response.results.map((r) => domainOf(r.url)))].slice(0, 5),
      // La forme normalisée : c'est le contrat que le reste d'ATLAS consomme.
      shape: first
        ? {
            hasTitle: Boolean(first.title?.trim()),
            hasUrl: Boolean(first.url?.trim()),
            hasSnippet: Boolean(first.snippet?.trim()),
            provider: first.provider,
            rank: first.rank,
            query: first.query,
            retrievedAt: first.retrievedAt,
          }
        : null,
      sample: response.results.slice(0, 3).map((r) => ({
        title: r.title.slice(0, 90),
        url: r.url,
        snippet: r.snippet.slice(0, 120),
        provider: r.provider,
        rank: r.rank,
      })),
    },
    null,
    2,
  ),
);

// Un échec de recherche doit faire échouer le script : le déploiement ne doit
// pas se déclarer réussi sur un moteur qui ne répond pas.
process.exit(response.outcome === 'ok' ? 0 : 1);
