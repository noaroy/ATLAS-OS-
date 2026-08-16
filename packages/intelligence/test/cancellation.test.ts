import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '@atlas/core';
import { DuckDuckGoSearchProvider } from '../src/search/duckduckgo.ts';
import { MarginaliaSearchProvider } from '../src/search/marginalia.ts';
import type { SearchProvider } from '../src/search/types.ts';

/**
 * L'annulation, jusqu'aux appels externes.
 *
 * Une annulation qui ne descend pas jusqu'au réseau n'annule rien : elle rend
 * la main au fondateur pendant qu'une requête continue de partir, d'occuper une
 * socket et de consommer un budget qu'il croit fermé. LIVE #002 en a donné la
 * version extrême — une recherche restée en vol 1 284 secondes sous un délai
 * d'étape de 300, parce que le délai abandonnait la promesse au lieu de
 * l'annuler.
 *
 * Ces tests vérifient la propriété qui compte : **après une annulation, aucun
 * appel réseau ne part**. Ils comptent les appels réellement émis plutôt que de
 * faire confiance à un drapeau.
 */

const logger = createLogger({ level: 'error', pretty: false });

/** Compte les appels réseau réellement émis pendant un scénario. */
async function countFetches(run: () => Promise<unknown>): Promise<number> {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    calls++;
    return original(...args);
  }) as typeof fetch;

  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
  return calls;
}

const PROVIDERS: Array<[string, () => SearchProvider]> = [
  ['DuckDuckGo', () => new DuckDuckGoSearchProvider()],
  ['Marginalia', () => new MarginaliaSearchProvider()],
];

for (const [name, make] of PROVIDERS) {
  describe(`annulation — ${name}`, () => {
    test('aucun appel réseau après une annulation déjà signalée', async () => {
      // Le cas le plus simple, et celui qui doit tenir absolument : le signal
      // est déjà levé quand la recherche est demandée.
      const controller = new AbortController();
      controller.abort();

      const calls = await countFetches(() =>
        make().search({ query: 'test', count: 5 }, { logger, timeoutMs: 15_000, signal: controller.signal }),
      );

      assert.equal(calls, 0, `${calls} appel(s) émis malgré une annulation préalable`);
    });

    test('une annulation rend la main sans attendre le délai', async () => {
      const controller = new AbortController();
      controller.abort();

      const started = Date.now();
      const response = await make().search(
        { query: 'test', count: 5 },
        { logger, timeoutMs: 30_000, signal: controller.signal },
      );

      // Trois secondes pour un délai de trente : la borne prouve que le
      // provider n'a pas attendu son échéance.
      assert.ok(Date.now() - started < 3000, "l'annulation doit être immédiate");
      assert.equal(response.results.length, 0);
    });

    test('une annulation ne coûte rien et ne rend aucun résultat', async () => {
      const controller = new AbortController();
      controller.abort();

      const response = await make().search(
        { query: 'test', count: 5 },
        { logger, timeoutMs: 15_000, signal: controller.signal },
      );

      assert.equal(response.costUsd, 0);
      assert.deepEqual(response.results, []);
      assert.ok(response.detail.length > 0, 'une annulation doit être expliquée');
    });

    test('une annulation en cours de vol coupe la recherche', async () => {
      // Le cas réel : le fondateur annule pendant que la requête est partie.
      const controller = new AbortController();
      const provider = make();

      const started = Date.now();
      const pending = provider.search(
        { query: 'verpackungsmaschinen hersteller deutschland', count: 10 },
        { logger, timeoutMs: 30_000, signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 50);

      const response = await pending;
      assert.ok(
        Date.now() - started < 5000,
        "une annulation en vol doit interrompre, pas laisser courir jusqu'au délai",
      );
      assert.equal(response.results.length, 0);
      assert.equal(response.costUsd, 0);
    });
  });
}

describe('délai dur', () => {
  test('un délai très court interrompt sans laisser de promesse orpheline', async () => {
    // `withDeadline` annule réellement au lieu d'abandonner : c'est la
    // différence entre rendre la main et arrêter le travail.
    const response = await new DuckDuckGoSearchProvider().search(
      { query: 'test', count: 5 },
      { logger, timeoutMs: 1 },
    );

    assert.equal(response.results.length, 0);
    assert.equal(response.costUsd, 0);
    assert.ok(['timeout', 'unavailable'].includes(response.outcome));
  });
});
