import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '@atlas/core';
import {
  CircuitBreaker,
  RateLimiter,
  SearchFabric,
  SearchProviderRegistry,
  SearchRouter,
  isFailoverWorthy,
  type MissionSearchNeed,
  type SearchAvailability,
  type SearchProvider,
  type SearchProviderOutcome,
  type SearchRequest,
  type SearchResponse,
} from '@atlas/intelligence';

/**
 * Le Search Fabric, sans toucher au réseau.
 *
 * Aucun test de ce fichier n'ouvre une connexion. Ce n'est pas seulement une
 * question de vitesse : un test qui interroge DuckDuckGo pour vérifier la
 * bascule contribue au bridage qu'il prétend mesurer, et devient rouge pour la
 * raison même qu'il devait détecter. Les moteurs sont donc scriptés, et
 * l'horloge est injectée — un refroidissement d'une heure se traverse ici en
 * une ligne.
 */

const logger = createLogger({ level: 'error', pretty: false });
const ctx = { logger, timeoutMs: 1000 };

/** Un moteur dont le test décide chaque réponse. */
function fakeProvider(
  key: string,
  script: SearchProviderOutcome[] | (() => SearchProviderOutcome),
  options: { available?: boolean; results?: number; durationMs?: number } = {},
): SearchProvider & { calls: number } {
  let index = 0;
  const provider = {
    key,
    label: `Moteur ${key}`,
    calls: 0,
    availability(): SearchAvailability {
      return options.available === false
        ? { available: false, reason: `${key} non configuré` }
        : { available: true, reason: 'prêt' };
    },
    async search(request: SearchRequest): Promise<SearchResponse> {
      provider.calls += 1;
      const outcome = typeof script === 'function' ? script() : (script[index++] ?? script.at(-1)!);
      const count = outcome === 'ok' ? (options.results ?? 3) : 0;

      return {
        results: Array.from({ length: count }, (_, i) => ({
          title: `r${i}`,
          url: `https://${key}.test/${i}`,
          snippet: '',
          provider: key,
          rank: i + 1,
          query: request.query,
          retrievedAt: new Date().toISOString(),
        })),
        outcome,
        detail: `${key} → ${outcome}`,
        costUsd: 0,
        durationMs: options.durationMs ?? 10,
      };
    },
  };
  return provider;
}

const need = (overrides: Partial<MissionSearchNeed> = {}): MissionSearchNeed => ({
  countries: ['DE'],
  languages: ['de'],
  commercial: true,
  ...overrides,
});

/** Un registre peuplé de moteurs scriptés, avec des capacités connues. */
function registryWith(
  providers: Array<{ provider: SearchProvider; priority?: number; cost?: number }>,
): SearchProviderRegistry {
  const registry = new SearchProviderRegistry();
  for (const [i, entry] of providers.entries()) {
    registry.register({
      provider: entry.provider,
      priority: entry.priority ?? i * 10,
      costModel: (entry.cost ?? 0) > 0 ? 'metered' : 'free',
      costPerQueryUsd: entry.cost ?? 0,
    });
  }
  return registry;
}

const request: SearchRequest = { query: 'distributeurs emballage', count: 5 };

// ─── Disjoncteur ────────────────────────────────────────────────────────────

describe('disjoncteur', () => {
  test('un moteur sain laisse passer', () => {
    const breaker = new CircuitBreaker({ now: () => 0 });
    assert.equal(breaker.state, 'closed');
    assert.equal(breaker.canRequest(), true);
  });

  test('un bridage ouvre immédiatement, sans attendre un second', () => {
    // Attendre confirmation d'un 429, c'est envoyer la requête qui aggrave le
    // bridage. Le moteur a déjà dit d'arrêter.
    let clock = 0;
    const breaker = new CircuitBreaker({ now: () => clock });

    breaker.recordFailure('HTTP 429', true);

    assert.equal(breaker.state, 'open');
    assert.equal(breaker.canRequest(), false);
  });

  test('un échec ordinaire attend le seuil', () => {
    const breaker = new CircuitBreaker({ now: () => 0, failureThreshold: 2 });
    breaker.recordFailure('timeout');
    assert.equal(breaker.state, 'closed', 'un incident isolé ne retire pas un moteur du service');

    breaker.recordFailure('timeout');
    assert.equal(breaker.state, 'open');
  });

  test('aucune requête ne part pendant le refroidissement', () => {
    let clock = 0;
    const breaker = new CircuitBreaker({ now: () => clock, baseCooldownMs: 60_000 });
    breaker.recordFailure('429', true);

    clock = 59_000;
    assert.equal(breaker.canRequest(), false, 'le refroidissement doit être respecté');
    assert.equal(breaker.snapshot().cooldownRemainingMs, 1000);
  });

  test('le refroidissement expiré ouvre à moitié, pour une seule sonde', () => {
    let clock = 0;
    const breaker = new CircuitBreaker({ now: () => clock, baseCooldownMs: 60_000 });
    breaker.recordFailure('429', true);

    clock = 61_000;
    assert.equal(breaker.state, 'half-open');
    assert.equal(breaker.canRequest(), true, 'la première sonde passe');

    breaker.beginProbe();
    assert.equal(breaker.canRequest(), false, 'la seconde est refusée tant que la sonde est en vol');
  });

  test('une sonde réussie referme le circuit', () => {
    let clock = 0;
    const breaker = new CircuitBreaker({ now: () => clock, baseCooldownMs: 1000 });
    breaker.recordFailure('429', true);
    clock = 2000;
    breaker.beginProbe();
    breaker.recordSuccess();

    assert.equal(breaker.state, 'closed');
    assert.equal(breaker.snapshot().consecutiveFailures, 0);
  });

  test('une sonde échouée rouvre, plus longtemps', () => {
    let clock = 0;
    const breaker = new CircuitBreaker({ now: () => clock, baseCooldownMs: 1000, failureThreshold: 1 });

    breaker.recordFailure('429', true);
    const first = breaker.snapshot().cooldownRemainingMs;

    clock = 2000;
    breaker.beginProbe();
    breaker.recordFailure('429 encore', true);

    assert.equal(breaker.state, 'open');
    assert.ok(
      breaker.snapshot().cooldownRemainingMs > first,
      'un moteur qui échoue deux fois doit être sondé moins souvent, pas autant',
    );
  });

  test('le refroidissement est plafonné', () => {
    let clock = 0;
    const breaker = new CircuitBreaker({
      now: () => clock,
      baseCooldownMs: 60_000,
      maxCooldownMs: 300_000,
      failureThreshold: 1,
    });
    for (let i = 0; i < 20; i++) breaker.recordFailure('429', true);

    assert.equal(breaker.snapshot().cooldownRemainingMs, 300_000);
  });

  test('un résultat vide n’est pas un échec', () => {
    // Sinon ATLAS interrogerait tous les moteurs jusqu'à ce qu'un index rende
    // quelque chose — c'est-à-dire transformerait une absence en découverte.
    assert.equal(isFailoverWorthy('empty'), false);
    assert.equal(isFailoverWorthy('ok'), false);
    assert.equal(isFailoverWorthy('rate-limited'), true);
    assert.equal(isFailoverWorthy('timeout'), true);
    assert.equal(isFailoverWorthy('http-error'), true);
  });
});

// ─── Routeur ────────────────────────────────────────────────────────────────

describe('routeur', () => {
  test('un moteur sain mais inadapté n’est jamais choisi', () => {
    // Le test le plus important du fichier. Marginalia répondait en 300 ms et
    // ne savait rien du marché allemand : il était le plus sain de tous, et
    // c'est exactement pourquoi la mission a conclu qu'aucun distributeur
    // allemand n'existait.
    const registry = registryWith([
      { provider: fakeProvider('marginalia', ['ok']), priority: 1 },
      { provider: fakeProvider('duckduckgo', ['ok']), priority: 99 },
    ]);

    const plan = new SearchRouter(registry).plan(need());

    assert.equal(plan.order[0]?.record.id, 'duckduckgo');
    assert.ok(
      !plan.order.some((c) => c.record.id === 'marginalia'),
      'même avec la meilleure priorité, un moteur inadapté reste exclu',
    );
  });

  test('un moteur adapté passe devant un moteur mieux classé', () => {
    const registry = registryWith([
      { provider: fakeProvider('searxng', ['ok']), priority: 50 },
      { provider: fakeProvider('marginalia', ['ok']), priority: 1 },
    ]);

    const plan = new SearchRouter(registry).plan(need());
    assert.equal(plan.order[0]?.record.id, 'searxng');
  });

  test('à adéquation égale, le gratuit passe devant le payant', () => {
    const registry = registryWith([
      { provider: fakeProvider('brave', ['ok']), priority: 1, cost: 0.005 },
      { provider: fakeProvider('duckduckgo', ['ok']), priority: 2 },
    ]);

    const plan = new SearchRouter(registry).plan(need());
    assert.equal(plan.order[0]?.record.id, 'duckduckgo');
  });

  test('un moteur non configuré est écarté, avec sa raison', () => {
    const registry = registryWith([
      { provider: fakeProvider('brave', ['ok'], { available: false }) },
      { provider: fakeProvider('duckduckgo', ['ok']) },
    ]);

    const plan = new SearchRouter(registry).plan(need());
    const brave = plan.considered.find((c) => c.record.id === 'brave');

    assert.match(brave?.excluded ?? '', /non configuré/);
    assert.equal(plan.order.length, 1);
  });

  test('un circuit ouvert écarte le moteur, en disant combien de temps', () => {
    const registry = registryWith([{ provider: fakeProvider('duckduckgo', ['ok']) }]);
    registry.get('duckduckgo')!.breaker.recordFailure('429', true);

    const plan = new SearchRouter(registry).plan(need());

    assert.equal(plan.blocked, true);
    assert.match(plan.blockedReason ?? '', /refroidissement/);
  });

  test('le blocage distingue ses causes', () => {
    // « Aucun moteur disponible » ne dit pas s'il faut configurer une clé,
    // attendre, ou changer de marché. Les trois gestes sont différents.
    const registry = registryWith([
      { provider: fakeProvider('brave', ['ok'], { available: false }) },
      { provider: fakeProvider('marginalia', ['ok']) },
    ]);

    const plan = new SearchRouter(registry).plan(need());

    assert.equal(plan.blocked, true);
    assert.match(plan.blockedReason ?? '', /inadaptés/);
    assert.match(plan.blockedReason ?? '', /non configurés/);
  });

  test('un historique mesuré départage deux moteurs équivalents', () => {
    const registry = registryWith([
      { provider: fakeProvider('duckduckgo', ['ok']), priority: 1 },
      { provider: fakeProvider('searxng', ['ok']), priority: 1 },
    ]);

    // DuckDuckGo a échoué la moitié du temps ; SearXNG jamais.
    for (let i = 0; i < 4; i++) {
      registry.record('duckduckgo', i % 2 === 0 ? 'ok' : 'http-error', {
        durationMs: 500,
        results: 3,
        costUsd: 0,
      });
      registry.record('searxng', 'ok', { durationMs: 500, results: 3, costUsd: 0 });
    }

    const plan = new SearchRouter(registry).plan(need());
    assert.equal(plan.order[0]?.record.id, 'searxng');
  });
});

// ─── Score ──────────────────────────────────────────────────────────────────

describe('score opérationnel', () => {
  test('un moteur jamais appelé n’a pas de score', () => {
    // Ni zéro ni parfait : pas de score. Lui en inventer un le classerait par
    // rapport à des moteurs dont on sait des choses, sur la foi de rien.
    const registry = registryWith([{ provider: fakeProvider('searxng', ['ok']) }]);
    assert.equal(registry.scoreOf('searxng'), null);
  });

  test('le score ne vient que d’appels réels', () => {
    const registry = registryWith([{ provider: fakeProvider('duckduckgo', ['ok']) }]);
    registry.record('duckduckgo', 'ok', { durationMs: 400, results: 8, costUsd: 0 });
    registry.record('duckduckgo', 'rate-limited', { durationMs: 100, results: 0, costUsd: 0 });

    const score = registry.scoreOf('duckduckgo')!;
    assert.equal(score.sampleSize, 2);
    assert.equal(score.successRate, 0.5);
    assert.equal(score.rateLimitFrequency, 0.5);
    assert.equal(score.averageLatencyMs, 250);
  });

  test('la santé reste inconnue tant qu’aucun appel n’a eu lieu', () => {
    // Sonder pour afficher enverrait, à chaque rafraîchissement du cockpit, le
    // trafic qui a causé le bridage.
    const registry = registryWith([{ provider: fakeProvider('searxng', ['ok']) }]);
    assert.equal(registry.healthOf('searxng'), 'unknown');
  });
});

// ─── Bascule ────────────────────────────────────────────────────────────────

describe('bascule automatique', () => {
  const fabricWith = (registry: SearchProviderRegistry, maxAttempts = 3): SearchFabric =>
    new SearchFabric({
      registry,
      need: need(),
      // Sans attente réelle : la cadence est testée séparément.
      limiter: new RateLimiter({ minIntervalMs: 0, jitterMs: 0, maxConcurrent: 4, perProvider: {} }),
      maxAttempts,
    });

  test('le moteur principal répond, aucun autre n’est appelé', async () => {
    const primary = fakeProvider('searxng', ['ok']);
    const backup = fakeProvider('duckduckgo', ['ok']);
    const fabric = fabricWith(registryWith([{ provider: primary }, { provider: backup }]));

    const response = await fabric.search(request, ctx);

    assert.equal(response.outcome, 'ok');
    assert.equal(primary.calls, 1);
    assert.equal(backup.calls, 0, 'un moteur qui répond ne doit pas en réveiller un second');
  });

  test('A bridé → B prend la relève', async () => {
    const a = fakeProvider('searxng', ['rate-limited']);
    const b = fakeProvider('duckduckgo', ['ok']);
    const fabric = fabricWith(registryWith([{ provider: a }, { provider: b }]));

    const response = await fabric.search(request, ctx);

    assert.equal(response.outcome, 'ok');
    assert.equal(a.calls, 1);
    assert.equal(b.calls, 1);
    assert.equal(fabric.lastTrace().selected, 'duckduckgo');
    assert.match(response.detail, /bascule/);
  });

  test('A et B tombés → C répond', async () => {
    const a = fakeProvider('searxng', ['timeout']);
    const b = fakeProvider('duckduckgo', ['http-error']);
    const c = fakeProvider('brave', ['ok']);
    const fabric = fabricWith(
      registryWith([{ provider: a }, { provider: b }, { provider: c, cost: 0.005 }]),
    );

    const response = await fabric.search(request, ctx);

    assert.equal(response.outcome, 'ok');
    assert.equal(fabric.lastTrace().selected, 'brave');
    assert.equal(fabric.lastTrace().attempts.length, 3);
  });

  test('un moteur bridé est retiré du service pour les appels suivants', async () => {
    // C'est ce qui distingue une bascule d'un simple réessai : le second appel
    // ne doit pas retourner marteler le moteur qui vient de dire non.
    const a = fakeProvider('searxng', ['rate-limited', 'ok']);
    const b = fakeProvider('duckduckgo', ['ok']);
    const fabric = fabricWith(registryWith([{ provider: a }, { provider: b }]));

    await fabric.search(request, ctx);
    await fabric.search(request, ctx);

    assert.equal(a.calls, 1, 'aucune nouvelle requête vers le moteur en refroidissement');
    assert.equal(b.calls, 2);
  });

  test('un résultat vide ne déclenche pas de bascule', async () => {
    const a = fakeProvider('searxng', ['empty']);
    const b = fakeProvider('duckduckgo', ['ok']);
    const fabric = fabricWith(registryWith([{ provider: a }, { provider: b }]));

    const response = await fabric.search(request, ctx);

    assert.equal(response.outcome, 'empty');
    assert.equal(b.calls, 0, 'chercher ailleurs jusqu’à trouver reviendrait à fabriquer un résultat');
  });

  test('un moteur qui lève est traité comme un échec, pas comme une panne du Fabric', async () => {
    const a: SearchProvider = {
      key: 'searxng',
      label: 'qui lève',
      availability: () => ({ available: true, reason: 'prêt' }),
      search: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    const b = fakeProvider('duckduckgo', ['ok']);
    const fabric = fabricWith(registryWith([{ provider: a }, { provider: b }]));

    const response = await fabric.search(request, ctx);
    assert.equal(response.outcome, 'ok');
    assert.equal(b.calls, 1);
  });

  test('tous les moteurs épuisés rend un blocage explicite', async () => {
    const a = fakeProvider('searxng', ['timeout']);
    const b = fakeProvider('duckduckgo', ['timeout']);
    const fabric = fabricWith(registryWith([{ provider: a }, { provider: b }]));

    const response = await fabric.search(request, ctx);

    assert.equal(response.outcome, 'unavailable');
    assert.match(response.detail, /Search Fabric indisponible/);
    assert.equal(fabric.lastTrace().blocked, true);
  });

  test('le nombre de tentatives est borné', async () => {
    const providers = ['searxng', 'duckduckgo', 'brave'].map((k) =>
      fakeProvider(k, ['timeout']),
    );
    const fabric = fabricWith(
      registryWith(providers.map((p) => ({ provider: p }))),
      2,
    );

    await fabric.search(request, ctx);
    assert.equal(fabric.lastTrace().attempts.length, 2, 'essayer tout le parc à chaque requête serait une rafale');
  });
});

// ─── Annulation ─────────────────────────────────────────────────────────────

describe('annulation', () => {
  test('aucun moteur n’est appelé après une annulation', async () => {
    const controller = new AbortController();
    const a = fakeProvider('searxng', ['timeout']);
    const b = fakeProvider('duckduckgo', ['ok']);

    const fabric = new SearchFabric({
      registry: registryWith([{ provider: a }, { provider: b }]),
      need: need(),
      limiter: new RateLimiter({ minIntervalMs: 0, jitterMs: 0, maxConcurrent: 4, perProvider: {} }),
    });

    controller.abort();
    const response = await fabric.search(request, { ...ctx, signal: controller.signal });

    assert.equal(a.calls, 0);
    assert.equal(b.calls, 0);
    assert.match(response.detail, /annulée|indisponible/);
  });

  test('une annulation en cours de bascule arrête la chaîne', async () => {
    const controller = new AbortController();
    const a = fakeProvider('searxng', () => {
      // Le premier moteur échoue et l'appelant renonce pendant ce temps.
      controller.abort();
      return 'timeout';
    });
    const b = fakeProvider('duckduckgo', ['ok']);

    const fabric = new SearchFabric({
      registry: registryWith([{ provider: a }, { provider: b }]),
      need: need(),
      limiter: new RateLimiter({ minIntervalMs: 0, jitterMs: 0, maxConcurrent: 4, perProvider: {} }),
    });

    await fabric.search(request, { ...ctx, signal: controller.signal });

    assert.equal(a.calls, 1);
    assert.equal(b.calls, 0, 'une bascule après annulation ferait payer un second moteur pour rien');
  });
});

// ─── Cadence ────────────────────────────────────────────────────────────────

describe('cadence', () => {
  test('deux requêtes au même moteur sont espacées', async () => {
    let clock = 0;
    const slept: number[] = [];
    const limiter = new RateLimiter({
      minIntervalMs: 1100,
      jitterMs: 0,
      maxConcurrent: 4,
      now: () => clock,
      random: () => 0,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });

    (await limiter.acquire('duckduckgo'))();
    (await limiter.acquire('duckduckgo'))();

    assert.deepEqual(slept, [1100], 'la seconde requête doit attendre la cadence du moteur');
  });

  test('quatre requêtes en rafale ne partent pas en 1,3 seconde', async () => {
    // Le scénario exact qui a causé le bridage.
    let clock = 0;
    const limiter = new RateLimiter({
      minIntervalMs: 1100,
      jitterMs: 0,
      maxConcurrent: 4,
      now: () => clock,
      random: () => 0,
      sleep: async (ms) => {
        clock += ms;
      },
    });

    for (let i = 0; i < 4; i++) (await limiter.acquire('duckduckgo'))();

    assert.ok(clock >= 3300, `quatre requêtes doivent couvrir au moins 3,3 s, pas ${clock} ms`);
  });

  test('des moteurs différents ne s’attendent pas', async () => {
    let clock = 0;
    const limiter = new RateLimiter({
      minIntervalMs: 1100,
      jitterMs: 0,
      maxConcurrent: 4,
      now: () => clock,
      random: () => 0,
      sleep: async (ms) => {
        clock += ms;
      },
    });

    (await limiter.acquire('duckduckgo'))();
    (await limiter.acquire('searxng'))();

    assert.equal(clock, 0, 'la cadence protège chaque moteur, pas le parc entier');
  });

  test('la concurrence globale est bornée', async () => {
    const limiter = new RateLimiter({ minIntervalMs: 0, jitterMs: 0, maxConcurrent: 2 });

    const a = await limiter.acquire('x');
    await limiter.acquire('y');
    assert.equal(limiter.inFlight, 2);

    // Le troisième attend qu'une place se libère.
    let granted = false;
    const pending = limiter.acquire('z').then((release) => {
      granted = true;
      release();
    });

    await Promise.resolve();
    assert.equal(granted, false, 'la troisième requête doit patienter');

    a();
    await pending;
    assert.equal(granted, true);
  });

  test('une annulation libère la place au lieu de la garder', async () => {
    const controller = new AbortController();
    const limiter = new RateLimiter({ minIntervalMs: 5000, jitterMs: 0, maxConcurrent: 1 });

    (await limiter.acquire('duckduckgo'))();

    controller.abort();
    await assert.rejects(() => limiter.acquire('duckduckgo', controller.signal));

    // La place doit être rendue : sinon une annulation gèlerait le parc.
    assert.equal(limiter.inFlight, 0);
  });
});
