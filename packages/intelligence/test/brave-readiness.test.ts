import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '@atlas/core';
import { BraveSearchProvider } from '../src/search/brave.ts';

/**
 * Brave, prêt le jour où une clé existe — et clair tant qu'elle n'existe pas.
 *
 * Aucune clé n'est créée ni achetée ici. Le test vérifie deux choses : sans
 * clé, le moteur se déclare indisponible avec la variable à renseigner ; avec
 * une clé, la requête suédoise part avec le pays et la langue du marché, et
 * un quota épuisé est classé bridage — donc bascule, pas blocage.
 */
const logger = createLogger({ level: 'error', pretty: false });

async function withFetch<T>(impl: (input: unknown) => Promise<Response>, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof globalThis.fetch;
  try { return await run(); } finally { globalThis.fetch = original; }
}

describe('Brave', () => {
  test('sans clé : indisponible, et dit quelle variable renseigner', () => {
    const a = new BraveSearchProvider({ apiKey: '', costPerQueryUsd: 0.005 }).availability();
    assert.equal(a.available, false);
    assert.match(a.reason, /BRAVE_SEARCH_API_KEY/);
  });

  test('avec une clé : la requête suédoise part avec country=SE et search_lang=sv', async () => {
    let appel: URL | null = null;
    const provider = new BraveSearchProvider({ apiKey: 'cle-de-test', costPerQueryUsd: 0.005 });
    const r = await withFetch(
      async (input) => {
        appel = new URL(String(input));
        return new Response(JSON.stringify({ web: { results: [{ title: 'Nordpack AB', url: 'https://nordpack.se/', description: 'distributör' }] } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      },
      () => provider.search({ query: 'distributör förpackningsmaskiner Sverige', count: 10, country: 'SE', language: 'sv' }, { logger, timeoutMs: 1000 }),
    );
    assert.equal(r.outcome, 'ok');
    assert.equal(r.results[0]?.url, 'https://nordpack.se/');
    assert.equal(appel!.searchParams.get('country'), 'SE');
    assert.equal(appel!.searchParams.get('search_lang'), 'sv');
  });

  test('un quota épuisé est un bridage : le tissu bascule au lieu de s’arrêter', async () => {
    const provider = new BraveSearchProvider({ apiKey: 'cle-de-test', costPerQueryUsd: 0.005 });
    const r = await withFetch(
      async () => new Response('{}', { status: 429 }),
      () => provider.search({ query: 'x', count: 5 }, { logger, timeoutMs: 1000 }),
    );
    assert.equal(r.outcome, 'rate-limited');
  });
});
