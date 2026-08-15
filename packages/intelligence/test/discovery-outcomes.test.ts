import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError, createLogger, withDeadline } from '@atlas/core';
import {
  DiscoveryService,
  FAILED_SEARCH_OUTCOMES,
  type SearchOutcome,
  type DiscoveryProvider,
  type DiscoveryQuery,
} from '@atlas/intelligence';

/**
 * « Rien trouvé » n'est pas « n'a pas pu chercher ».
 *
 * LIVE #003 confondait les deux : les trois appels à `discover_companies` sont
 * enregistrés en succès alors que deux recherches avaient été annulées par
 * expiration du délai. L'agent croyait le marché vide et relançait, chaque
 * tentative repayant un contexte grandissant — jusqu'au plafond d'étape.
 *
 * La distinction porte pour trois raisons : un délai dépassé se corrige en
 * desserrant une borne, un refus budgétaire en ajustant un plafond, un marché
 * vide en changeant de marché.
 */

const logger = createLogger({ level: 'error', pretty: false });

const QUERY: DiscoveryQuery = {
  targetTypes: [{ key: 'distributor', label: 'Distributeur', description: 'revend' }],
  countries: ['Allemagne'],
  industries: [],
  keywords: [],
  exclusions: [],
  clientOffering: null,
  limit: 2,
};

/** Un provider dont le test décide entièrement le comportement. */
function provider(key: string, search: DiscoveryProvider['search']): DiscoveryProvider {
  return {
    key,
    label: `Source ${key}`,
    kind: 'directory',
    synthetic: false,
    availability: () => ({ available: true, reason: 'disponible' }),
    search,
  };
}

const candidate = (name: string) => ({
  name,
  website: `https://${name.toLowerCase()}.de`,
  country: 'Allemagne',
  region: null,
  city: null,
  description: null,
  industries: [],
  relevance: null,
  roles: ['distributor'],
  sources: [
    {
      kind: 'directory' as const,
      ref: `https://annuaire.example/${name}`,
      title: 'Annuaire',
      retrievedAt: new Date().toISOString(),
      provider: 'test',
    },
  ],
  confidence: 0.6,
});

const run = (providers: DiscoveryProvider[]) =>
  new DiscoveryService(providers, { live: true, logger }).discover(QUERY, { logger });

describe('les issues de recherche', () => {
  test('des résultats donnent success-with-results', async () => {
    const report = await run([
      provider('a', async () => ({
        candidates: [candidate('Alpha')],
        notes: [],
        tokensUsed: 0,
        outcome: 'success-with-results',
      })),
    ]);
    assert.equal(report.outcome, 'success-with-results');
    assert.equal(report.candidates.length, 1);
  });

  test('une recherche aboutie sans résultat donne success-empty', async () => {
    // Le marché ne contenait rien de documenté. La recherche a fonctionné.
    const report = await run([
      provider('a', async () => ({
        candidates: [],
        notes: ['Rien de documenté.'],
        tokensUsed: 0,
        outcome: 'success-empty',
      })),
    ]);
    assert.equal(report.outcome, 'success-empty');
    assert.ok(!FAILED_SEARCH_OUTCOMES.includes(report.outcome));
  });

  test('un délai dépassé donne timeout, pas success-empty', async () => {
    // La distinction que LIVE #003 ne faisait pas.
    const report = await run([
      provider('a', async () => ({
        candidates: [],
        notes: ['Annulée.'],
        tokensUsed: 0,
        outcome: 'timeout',
      })),
    ]);
    assert.equal(report.outcome, 'timeout');
    assert.ok(FAILED_SEARCH_OUTCOMES.includes(report.outcome));
  });

  test('un refus budgétaire donne budget-cancelled', async () => {
    const report = await run([
      provider('a', async () => ({
        candidates: [],
        notes: [],
        tokensUsed: 0,
        outcome: 'budget-cancelled',
      })),
    ]);
    assert.equal(report.outcome, 'budget-cancelled');
  });

  test('un provider en panne n’efface pas les résultats d’un autre', async () => {
    // Peu importe qu'une source ait échoué si une autre a trouvé : le
    // fondateur a ses candidats.
    const report = await run([
      provider('cassé', async () => ({
        candidates: [],
        notes: [],
        tokensUsed: 0,
        outcome: 'provider-failure',
      })),
      provider('bon', async () => ({
        candidates: [candidate('Beta')],
        notes: [],
        tokensUsed: 0,
        outcome: 'success-with-results',
      })),
    ]);
    assert.equal(report.outcome, 'success-with-results');
  });

  test('zéro résultat doublé d’une panne est rapporté comme une panne', async () => {
    // Sinon une recherche impossible ressemblerait à un marché vide — et
    // c'est exactement la confusion qui a coûté 0,38 $.
    const report = await run([
      provider('vide', async () => ({
        candidates: [],
        notes: [],
        tokensUsed: 0,
        outcome: 'success-empty',
      })),
      provider('cassé', async () => ({
        candidates: [],
        notes: [],
        tokensUsed: 0,
        outcome: 'timeout',
      })),
    ]);
    assert.equal(report.outcome, 'timeout');
  });

  test('l’issue de chaque provider reste consultable séparément', async () => {
    const report = await run([
      provider('vide', async () => ({
        candidates: [],
        notes: [],
        tokensUsed: 0,
        outcome: 'success-empty',
      })),
      provider('cassé', async () => ({
        candidates: [],
        notes: [],
        tokensUsed: 0,
        outcome: 'provider-failure',
      })),
    ]);
    assert.deepEqual(
      report.providers.map((p) => p.outcome),
      ['success-empty', 'provider-failure'],
    );
  });

  test('aucun provider utilisable donne unavailable', async () => {
    const offline: DiscoveryProvider = {
      key: 'hors-ligne',
      label: 'Hors ligne',
      kind: 'web-search',
      synthetic: false,
      availability: () => ({ available: false, reason: 'clé absente' }),
      search: async () => {
        throw new Error('ne doit jamais être appelé');
      },
    };
    const report = await run([offline]);
    assert.equal(report.outcome, 'unavailable');
  });
});

describe('un fournisseur lent survit à une borne plus large', () => {
  test('150 s de travail sous une borne de 300 s aboutit', async () => {
    // Le cas réel de LIVE #003, à l'échelle du test : la recherche demandait
    // plus que la borne d'outil qui l'enveloppait. Avec l'ordre corrigé, un
    // appel plus long que la borne *intérieure* aboutit quand même.
    const providerMs = 150;
    const toolMs = 300;

    const result = await withDeadline(
      async () => {
        await new Promise((r) => setTimeout(r, providerMs));
        return 'candidats trouvés';
      },
      { ms: toolMs, label: 'outil enveloppant' },
    );

    assert.equal(result, 'candidats trouvés');
  });

  test('l’ordre inverse tue le travail — la régression de LIVE #003', async () => {
    // 150 s de travail sous une borne de 120 s : la démonstration de ce que
    // la validation au démarrage empêche désormais.
    await assert.rejects(
      () =>
        withDeadline(
          (signal) =>
            new Promise((resolve, reject) => {
              const timer = setTimeout(() => resolve('candidats trouvés'), 150);
              signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new Error('aborted'));
              });
            }),
          { ms: 120, label: 'outil trop serré' },
        ),
      (err: unknown) => err instanceof AtlasError && err.code === 'TIMEOUT',
    );
  });
});

describe('la taxonomie est exhaustive', () => {
  test('toute issue est soit une réussite, soit une panne, soit une indisponibilité', () => {
    const outcomes: SearchOutcome[] = [
      'success-with-results',
      'success-empty',
      'provider-failure',
      'timeout',
      'budget-cancelled',
      'unavailable',
    ];
    for (const outcome of outcomes) {
      const failed = FAILED_SEARCH_OUTCOMES.includes(outcome);
      const succeeded = outcome.startsWith('success');
      const unavailable = outcome === 'unavailable';
      assert.equal(
        [failed, succeeded, unavailable].filter(Boolean).length,
        1,
        `${outcome} doit tomber dans exactement une catégorie`,
      );
    }
  });
});

// ─── Configuré n'est pas sain ─────────────────────────────────────────────

describe('configuré et sain sont deux questions distinctes', () => {
  test('sans appel, la santé reste inconnue — pas « en bonne santé »', () => {
    // Un système qui prétend savoir ce qu'il n'a pas mesuré finit par se
    // tromper au moment où cela compte.
    const service = new DiscoveryService(
      [provider('a', async () => ({ candidates: [], notes: [], tokensUsed: 0, outcome: 'success-empty' }))],
      { live: true, logger },
    );
    const [capability] = service.capabilities();
    assert.equal(capability!.configured, true);
    assert.equal(capability!.health, 'unknown');
    assert.equal(capability!.lastCheckedAt, null);
  });

  test('un appel abouti rend le provider sain', async () => {
    const service = new DiscoveryService(
      [
        provider('a', async () => ({
          candidates: [candidate('Alpha')],
          notes: [],
          tokensUsed: 0,
          outcome: 'success-with-results',
        })),
      ],
      { live: true, logger },
    );
    await service.discover(QUERY, { logger });

    const [capability] = service.capabilities();
    assert.equal(capability!.health, 'healthy');
    assert.ok(capability!.lastCheckedAt);
  });

  test('un provider éteint reste configuré mais devient malsain', async () => {
    // Le cas exact relevé lors du smoke test : une instance SearXNG injoignable
    // s'affichait « utilisable » parce que son URL était renseignée.
    const service = new DiscoveryService(
      [
        provider('a', async () => ({
          candidates: [],
          notes: [],
          tokensUsed: 0,
          outcome: 'provider-failure',
        })),
      ],
      { live: true, logger },
    );
    await service.discover(QUERY, { logger });

    const [capability] = service.capabilities();
    assert.equal(capability!.configured, true, 'la configuration est bien là');
    assert.equal(capability!.health, 'unhealthy', 'mais le moteur ne répond pas');
    assert.match(capability!.reason, /dernier appel en échec/);
  });

  test('la santé n’exige aucune requête supplémentaire', async () => {
    // Elle se déduit de ce qu'on a déjà payé pour apprendre : interroger un
    // moteur à chaque affichage d'écran coûterait une requête pour rien.
    let calls = 0;
    const service = new DiscoveryService(
      [
        provider('a', async () => {
          calls++;
          return { candidates: [], notes: [], tokensUsed: 0, outcome: 'success-empty' };
        }),
      ],
      { live: true, logger },
    );

    await service.discover(QUERY, { logger });
    const before = calls;
    service.capabilities();
    service.capabilities();

    assert.equal(calls, before, 'consulter les capacités ne déclenche aucune recherche');
  });
});
