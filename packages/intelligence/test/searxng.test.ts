import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '@atlas/core';
import { SearxngSearchProvider } from '@atlas/intelligence';

/**
 * Le moteur auto-hébergé.
 *
 * SearXNG remplace une API commerciale par un service qui tourne sur notre
 * VPS : pas de clé, pas de quota, pas de facture. Le contrat reste celui de
 * `SearchProvider` — Business Expansion ne sait pas lequel des deux répond.
 */

const logger = createLogger({ level: 'error', pretty: false });

/** Remplace `fetch` le temps d'un test, puis le restitue. */
async function withFetch<T>(
  impl: (input: unknown, init?: unknown) => Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof globalThis.fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const body = (results: unknown[]) =>
  new Response(JSON.stringify({ results }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const provider = () =>
  new SearxngSearchProvider({ baseUrl: 'http://searxng:8080', engines: 'duckduckgo,brave' });

describe('SearXNG', () => {
  test('rend des résultats structurés avec leur provenance', async () => {
    const response = await withFetch(
      async () =>
        body([
          {
            title: 'Verpackung Nord GmbH',
            url: 'https://verpackung-nord.de/',
            content: 'Händler   für Verpackungsmaschinen',
            engine: 'duckduckgo',
          },
        ]),
      () => provider().search({ query: 'Händler Deutschland', count: 10 }, { logger }),
    );

    assert.equal(response.outcome, 'ok');
    const first = response.results[0]!;
    assert.equal(first.url, 'https://verpackung-nord.de/');
    assert.equal(first.rank, 1);
    assert.equal(first.query, 'Händler Deutschland');
    assert.ok(first.retrievedAt);
    // Le moteur d'origine est conservé : comparer SearXNG à Brave n'aurait
    // aucun sens sans savoir qui a réellement répondu.
    assert.equal(first.provider, 'searxng:duckduckgo');
    assert.equal(first.snippet, 'Händler für Verpackungsmaschinen');
  });

  test('la recherche ne coûte rien', async () => {
    // C'est la raison d'être de ce provider : aucun service payant obligatoire.
    const response = await withFetch(
      async () => body([{ title: 'X', url: 'https://x.de/', content: '' }]),
      () => provider().search({ query: 'x', count: 10 }, { logger }),
    );
    assert.equal(response.costUsd, 0);
  });

  test('une réponse vide est un constat, pas une panne', async () => {
    const response = await withFetch(
      async () => body([]),
      () => provider().search({ query: 'rien', count: 10 }, { logger }),
    );
    assert.equal(response.outcome, 'empty');
    assert.equal(response.costUsd, 0);
  });

  test('une erreur HTTP est rapportée par son statut', async () => {
    const response = await withFetch(
      async () => new Response('', { status: 502 }),
      () => provider().search({ query: 'x', count: 10 }, { logger }),
    );
    assert.equal(response.outcome, 'http-error');
    assert.match(response.detail, /502/);
  });

  test('une limite de débit est distinguée des autres erreurs', async () => {
    const response = await withFetch(
      async () => new Response('', { status: 429 }),
      () => provider().search({ query: 'x', count: 10 }, { logger }),
    );
    assert.equal(response.outcome, 'rate-limited');
  });

  test('du HTML là où on attend du JSON dit quoi corriger', async () => {
    // Le format JSON est désactivé par défaut dans SearXNG. L'oublier est
    // l'erreur de configuration la plus probable ; le message doit y renvoyer
    // plutôt que de laisser chercher une heure.
    const response = await withFetch(
      async () =>
        new Response('<html><body>SearXNG</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      () => provider().search({ query: 'x', count: 10 }, { logger }),
    );
    assert.equal(response.outcome, 'http-error');
    assert.match(response.detail, /settings\.yml/);
  });

  test('une instance muette est annulée, pas attendue', async () => {
    const response = await withFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      () => provider().search({ query: 'x', count: 10 }, { logger, timeoutMs: 60 }),
    );
    assert.equal(response.outcome, 'timeout');
  });

  test('une annulation venue de plus haut est honorée', async () => {
    const parent = new AbortController();
    setTimeout(() => parent.abort(), 30);

    const response = await withFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      () =>
        provider().search(
          { query: 'x', count: 10 },
          { logger, timeoutMs: 60_000, signal: parent.signal },
        ),
    );
    assert.ok(['timeout', 'http-error'].includes(response.outcome));
  });

  test('une instance injoignable est signalée, pas masquée', async () => {
    const response = await withFetch(
      async () => {
        throw new Error('ECONNREFUSED');
      },
      () => provider().search({ query: 'x', count: 10 }, { logger }),
    );
    assert.equal(response.outcome, 'http-error');
    assert.match(response.detail, /injoignable/);
  });

  test('un résultat sans URL est écarté', async () => {
    const response = await withFetch(
      async () =>
        body([
          { title: 'Sans URL', content: 'rien' },
          { title: 'Bon', url: 'https://bon.de/' },
        ]),
      () => provider().search({ query: 'x', count: 10 }, { logger }),
    );
    assert.equal(response.results.length, 1);
    assert.equal(response.results[0]!.url, 'https://bon.de/');
  });

  test('le nombre de résultats demandé est respecté', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      title: `R${i}`,
      url: `https://r${i}.de/`,
      content: '',
    }));
    const response = await withFetch(
      async () => body(many),
      () => provider().search({ query: 'x', count: 5 }, { logger }),
    );
    assert.equal(response.results.length, 5);
  });

  test('la requête demande bien du JSON et la catégorie générale', async () => {
    let seen: URL | null = null;
    await withFetch(
      async (input) => {
        seen = new URL(String(input));
        return body([]);
      },
      () => provider().search({ query: 'test', count: 10, language: 'de' }, { logger }),
    );

    assert.ok(seen);
    const url = seen as unknown as URL;
    assert.equal(url.searchParams.get('format'), 'json');
    assert.equal(url.searchParams.get('categories'), 'general');
    assert.equal(url.searchParams.get('language'), 'de');
    assert.equal(url.searchParams.get('engines'), 'duckduckgo,brave');
  });

  test('sans URL de base, le provider se déclare indisponible', () => {
    const offline = new SearxngSearchProvider({ baseUrl: '', engines: '' });
    const availability = offline.availability();
    assert.equal(availability.available, false);
    assert.match(availability.reason, /SEARXNG_BASE_URL/);
  });

  test('aucune clé n’est requise pour être disponible', () => {
    // Le point de la manœuvre : ATLAS fonctionne sans service payant. Le
    // provider se déclare utilisable sans qu'aucun secret ne lui soit fourni.
    const available = new SearxngSearchProvider({
      baseUrl: 'http://searxng:8080',
      engines: '',
    }).availability();

    assert.equal(available.available, true);
    assert.match(available.reason, /sans clé ni quota/);
  });

  test('une URL de base invalide est signalée sans planter', async () => {
    const broken = new SearxngSearchProvider({ baseUrl: 'pas-une-url', engines: '' });
    const response = await broken.search({ query: 'x', count: 10 }, { logger });
    assert.equal(response.outcome, 'unavailable');
    assert.match(response.detail, /invalide/);
  });
});
