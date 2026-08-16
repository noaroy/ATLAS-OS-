import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../core/src/logger.ts';
import { createRepositories, type Repositories } from '../../data/src/index.ts';
import type { AtlasConfig } from '../../core/src/config.ts';
import type { SearchProvider } from '../../intelligence/src/index.ts';
import { SearchFabric, SearchProviderRegistry } from '@atlas/intelligence';
import { preflight, formatPreflight } from '../src/preflight.ts';

/**
 * Le contrôle avant décollage.
 *
 * Ce que ces tests protègent : qu'une configuration incapable de produire un
 * résultat soit refusée *avant* la dépense, et non découverte pendant. Les cinq
 * missions réelles qui ont échoué pour 10,94 $ auraient toutes été arrêtées ici
 * — moteur injoignable, délais inversés, plafond absent.
 *
 * Le contrôle qui compte le plus est celui du moteur : il l'interroge vraiment.
 * « Configuré » n'a jamais empêché « injoignable ».
 */

const logger = createLogger({ level: 'error', pretty: false });
let dir: string;
let repos: Repositories;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-preflight-'));
  repos = createRepositories(join(dir, 'preflight.db'), logger);
});

after(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

function configWith(overrides: Record<string, unknown> = {}): AtlasConfig {
  return {
    env: 'test',
    llm: {
      apiKey: 'sk-test',
      mode: 'live',
      declaredMode: 'live',
      forbiddenModels: ['claude-opus'],
      allowedModels: [],
      hermesModel: 'claude-haiku-4-5-20251001',
      agentModel: 'claude-haiku-4-5-20251001',
      effort: 'low',
      maxTokens: 4000,
      ...(overrides.llm as object),
    },
    budget: {
      maxMissionTokens: 100_000,
      maxMissionCostUsd: 0.4,
      maxStepTokens: 20_000,
      maxCallsPerStep: 6,
      maxOutputTokensPerCall: 2000,
      circuitBreakerFailures: 3,
      minViableOutputTokens: 512,
      ...(overrides.budget as object),
    },
    orchestration: {
      providerTimeoutMs: 60_000,
      toolTimeoutMs: 90_000,
      taskTimeoutMs: 120_000,
      ...(overrides.orchestration as object),
    },
    search: { timeoutMs: 10_000, ...(overrides.search as object) },
  } as unknown as AtlasConfig;
}

/** Un moteur qui répond, ou qui ne répond pas — au choix du test. */
function providerThat(outcome: 'ok' | 'timeout' | 'rate-limited'): SearchProvider {
  return {
    key: 'test-engine',
    label: 'Moteur de test',
    availability: () => ({ available: true, reason: 'disponible' }),
    search: async () => ({
      results:
        outcome === 'ok'
          ? [
              {
                title: 'x',
                url: 'https://exemple.fr',
                snippet: '',
                provider: 'test-engine',
                rank: 1,
                query: 'test',
                retrievedAt: new Date().toISOString(),
              },
            ]
          : [],
      outcome,
      detail: outcome === 'ok' ? '1 résultat' : 'le moteur ne répond pas',
      costUsd: 0,
      durationMs: 12,
    }),
  };
}

// `probeInference: false` partout : un test unitaire ne doit jamais appeler
// l'API du modèle. La sonde elle-même est couverte plus bas, sans réseau.
const run = (config: AtlasConfig, search: SearchProvider | null, missionBudgetUsd?: number) =>
  preflight({
    config,
    repos,
    search,
    logger,
    probeInference: false,
    ...(missionBudgetUsd !== undefined ? { missionBudgetUsd } : {}),
  });

describe('contrôle avant décollage', () => {
  test('une configuration saine autorise le décollage', async () => {
    const report = await run(configWith(), providerThat('ok'));
    assert.equal(report.cleared, true, formatPreflight(report));
    assert.equal(report.mode, 'live');
    assert.equal(report.searchProvider, 'test-engine');
  });

  test('un moteur injoignable bloque le décollage', async () => {
    // Le contrôle qui aurait évité LIVE #005 : le moteur était configuré, et
    // n'a jamais répondu. La mission a coûté 0,86 $ pour zéro candidat.
    const report = await run(configWith(), providerThat('timeout'));
    assert.equal(report.cleared, false);
    const check = report.checks.find((c) => c.name === 'recherche')!;
    assert.equal(check.status, 'fail');
    assert.ok(check.detail.includes('timeout'));
  });

  test('aucun moteur du tout bloque une mission réelle', async () => {
    const report = await run(configWith(), null);
    assert.equal(report.cleared, false);
    assert.ok(report.checks.some((c) => c.name === 'recherche' && c.status === 'fail'));
  });

  test('aucun moteur ne bloque pas une simulation', async () => {
    const report = await run(
      configWith({ llm: { mode: 'simulation', declaredMode: 'simulation', apiKey: '' } }),
      null,
    );
    assert.equal(report.cleared, true, formatPreflight(report));
  });

  test('le mode réel sans clé est refusé', async () => {
    const report = await run(configWith({ llm: { apiKey: '' } }), providerThat('ok'));
    assert.equal(report.cleared, false);
    const check = report.checks.find((c) => c.name === 'inférence')!;
    assert.equal(check.status, 'fail');
    assert.ok(check.remedy);
  });

  test('un modèle interdit en service est refusé', async () => {
    // Le garde-fou demandé : Opus ne doit pas servir à de l'extraction.
    const report = await run(
      configWith({ llm: { agentModel: 'claude-opus-5', forbiddenModels: ['claude-opus'] } }),
      providerThat('ok'),
    );
    assert.equal(report.cleared, false);
    const check = report.checks.find((c) => c.name === 'modèles')!;
    assert.equal(check.status, 'fail');
    assert.ok(check.detail.includes('claude-opus-5'));
  });

  test("le rapport nomme ce qui est interdit, pas seulement le nombre", async () => {
    // « 1 modèle interdit » n'apprend rien à qui relit avant un lancement réel.
    // La ligne doit se vérifier d'un coup d'œil.
    const report = await run(
      configWith({
        llm: {
          agentModel: 'claude-haiku-4-5-20251001',
          hermesModel: 'claude-haiku-4-5-20251001',
          forbiddenModels: ['claude-opus'],
        },
      }),
      providerThat('ok'),
    );
    const check = report.checks.find((c) => c.name === 'modèles')!;
    assert.equal(check.status, 'pass');
    assert.ok(check.detail.includes('claude-opus'), `attendu « claude-opus » dans : ${check.detail}`);
    assert.ok(check.detail.includes('claude-haiku'), 'le modèle en service doit être nommé aussi');
  });

  test("un modèle hors liste blanche est refusé même s'il n'est pas interdit", async () => {
    // Aucune escalade implicite : Sonnet ne figure sur aucune liste noire, mais
    // une liste blanche qui ne le mentionne pas suffit à le refuser.
    const report = await run(
      configWith({
        llm: {
          agentModel: 'claude-sonnet-5',
          hermesModel: 'claude-sonnet-5',
          forbiddenModels: ['claude-opus'],
          allowedModels: ['claude-haiku'],
        },
      }),
      providerThat('ok'),
    );
    assert.equal(report.cleared, false);
    const check = report.checks.find((c) => c.name === 'modèles')!;
    assert.equal(check.status, 'fail');
    assert.ok(check.detail.includes('claude-sonnet-5'));
    assert.ok(check.remedy?.includes('claude-haiku'), 'le remède doit rappeler ce qui est autorisé');
  });

  test("l'absence totale de restriction est signalée", async () => {
    // Le cas qui a motivé le verrou : rien n'empêchait d'appeler le plus cher,
    // et le preflight le disait « conforme ».
    const report = await run(
      configWith({ llm: { forbiddenModels: [], allowedModels: [] } }),
      providerThat('ok'),
    );
    const check = report.checks.find((c) => c.name === 'modèles')!;
    assert.equal(check.status, 'warn');
    assert.equal(check.blocking, false, 'un déploiement de développement ne doit pas être bloqué');
    assert.ok(check.remedy?.includes('ATLAS_FORBIDDEN_MODELS'));
  });

  test('un plafond nul est refusé en mode réel', async () => {
    const report = await run(configWith(), providerThat('ok'), 0);
    assert.equal(report.cleared, false);
    assert.ok(report.checks.some((c) => c.name === 'budget' && c.status === 'fail'));
  });

  test('une hiérarchie de délais inversée est refusée', async () => {
    // L'erreur exacte de LIVE #003 : l'outil bornait plus court que le
    // fournisseur qu'il enveloppait.
    const report = await run(
      configWith({ orchestration: { providerTimeoutMs: 180_000, toolTimeoutMs: 120_000, taskTimeoutMs: 300_000 } }),
      providerThat('ok'),
    );
    assert.equal(report.cleared, false);
    assert.ok(report.checks.some((c) => c.name === 'délais' && c.status === 'fail'));
  });

  test('un mode déduit passe, mais est signalé', async () => {
    const report = await run(configWith({ llm: { declaredMode: 'auto' } }), providerThat('ok'));
    assert.equal(report.cleared, true);
    const check = report.checks.find((c) => c.name === 'mode')!;
    assert.equal(check.status, 'warn');
    assert.equal(check.blocking, false);
  });

  test('le rapport nomme ce qui bloque et ce qu’il faut faire', async () => {
    const report = await run(configWith({ llm: { apiKey: '' } }), providerThat('timeout'));
    const text = formatPreflight(report);

    assert.ok(text.includes('DÉCOLLAGE REFUSÉ'));
    // Chaque échec doit proposer un remède : un contrôle qui dit seulement
    // « non » oblige à relire le code pour comprendre.
    for (const check of report.checks.filter((c) => c.status === 'fail')) {
      assert.ok(check.remedy, `${check.name} échoue sans remède`);
      assert.ok(text.includes(check.remedy), 'le remède doit apparaître dans le rapport');
    }
  });

  test('le plafond de la mission prime sur celui du déploiement', async () => {
    const report = await run(configWith(), providerThat('ok'), 0.4);
    assert.equal(report.budgetUsd, 0.4);
    assert.ok(report.checks.some((c) => c.name === 'budget' && c.detail.includes('0.40')));
  });
});

/**
 * Le contrôle avant décollage face à un parc de moteurs.
 *
 * La question a changé, et c'est tout l'objet du Search Fabric. Avant :
 * « DuckDuckGo répond-il ? » — une question à laquelle un seul moteur pouvait
 * répondre non, bloquant tout, et ATLAS a passé deux jours à attendre ce non-là.
 * Maintenant : « reste-t-il au moins un moteur sain ET adapté ? »
 */
describe('contrôle avant décollage — Search Fabric', () => {
  const need = { countries: ['DE'], languages: ['de'], commercial: true };

  /** Un parc scripté, sans le moindre appel réseau. */
  function fabricWith(providers: Array<{ key: string; available?: boolean; open?: boolean }>): SearchFabric {
    const registry = new SearchProviderRegistry();
    for (const [i, entry] of providers.entries()) {
      registry.register({
        provider: {
          key: entry.key,
          label: `Moteur ${entry.key}`,
          availability: () =>
            entry.available === false
              ? { available: false, reason: `${entry.key} non configuré` }
              : { available: true, reason: 'prêt' },
          search: async () => {
            throw new Error('aucun test de ce bloc ne doit appeler un moteur');
          },
        },
        priority: i * 10,
        costModel: 'free',
        costPerQueryUsd: 0,
      });
      if (entry.open) registry.get(entry.key)!.breaker.recordFailure('429', true);
    }
    return new SearchFabric({ registry, need });
  }

  // `probeSearch: false` sur les tests de routage : ils vérifient le plan, pas
  // la santé. La sonde elle-même est couverte par ses propres tests.
  const runFabric = (fabric: SearchFabric, config = configWith()) =>
    preflight({
      config,
      repos,
      search: fabric,
      logger,
      need,
      probeInference: false,
      probeSearch: false,
    });

  test('un parc avec un moteur adapté autorise le décollage', async () => {
    const report = await runFabric(fabricWith([{ key: 'duckduckgo' }, { key: 'searxng' }]));

    assert.equal(report.cleared, true, formatPreflight(report));
    assert.equal(report.fabric?.blocked, false);
    assert.equal(report.fabric?.order.length, 2);
  });

  test('un moteur bridé ne bloque plus rien tant qu’un autre répond', async () => {
    // Le critère de la mission, exactement : « DuckDuckGo indisponible →
    // bascule vers le provider suivant », et non « attendez quelques heures ».
    const report = await runFabric(
      fabricWith([{ key: 'duckduckgo', open: true }, { key: 'searxng' }]),
    );

    assert.equal(report.cleared, true, formatPreflight(report));
    assert.deepEqual(report.fabric?.order, ['searxng']);
    assert.ok(
      report.fabric?.excluded.some((e) => e.id === 'duckduckgo' && /refroidissement/.test(e.reason)),
      'le moteur bridé doit apparaître écarté, avec sa raison',
    );
  });

  test('un parc entièrement indisponible bloque, et le dit', async () => {
    const report = await runFabric(
      fabricWith([{ key: 'duckduckgo', open: true }, { key: 'brave', available: false }]),
    );

    assert.equal(report.cleared, false);
    const check = report.checks.find((c) => c.name === 'search fabric')!;
    assert.equal(check.status, 'fail');
    assert.match(check.detail, /BLOCKED-BY-SEARCH-FABRIC/);
    assert.equal(report.fabric?.blocked, true);
  });

  test('un moteur sain mais inadapté ne sauve pas le décollage', async () => {
    // Marginalia répond parfaitement et ne sait rien du marché allemand. Le
    // compter comme un moteur disponible reviendrait à repayer la mission qui
    // a conclu qu'aucun distributeur allemand n'existait.
    const report = await runFabric(fabricWith([{ key: 'marginalia' }]));

    assert.equal(report.cleared, false);
    assert.equal(report.fabric?.blocked, true);
    assert.match(report.fabric?.blockedReason ?? '', /inadaptés/);
  });

  test('un parc réduit à un seul moteur est signalé sans bloquer', async () => {
    // C'est une configuration légitime, mais c'est un point de défaillance
    // unique. Le taire laisserait croire que la bascule protège quand elle n'a
    // nulle part où basculer.
    const report = await runFabric(fabricWith([{ key: 'duckduckgo' }]));

    assert.equal(report.cleared, true, formatPreflight(report));
    const check = report.checks.find((c) => c.name === 'redondance')!;
    assert.equal(check.status, 'warn');
    assert.equal(check.blocking, false);
  });

  test('le contrôle interroge réellement le parc avant de laisser partir', async () => {
    // Ce test affirmait l'inverse — que le preflight ne devait appeler aucun
    // moteur — et c'est ce qui a laissé passer le défaut. VAL-001 est partie
    // sur « 2 moteurs adaptés » alors que SearXNG n'écoutait nulle part et que
    // DuckDuckGo servait sa page anti-bot ; la mission a payé 0,0259 $ pour
    // découvrir un parc muet.
    //
    // Lire un plan n'est pas vérifier. « Configuré » n'a jamais empêché
    // « injoignable » — la leçon de LIVE #005, appliquée au chemin qui sert.
    let queried = 0;
    const registry = new SearchProviderRegistry();
    registry.register({
      provider: {
        key: 'duckduckgo',
        label: 'DuckDuckGo',
        availability: () => ({ available: true, reason: 'prêt' }),
        search: async () => {
          queried += 1;
          return {
            results: [],
            outcome: 'rate-limited' as const,
            detail: 'page de vérification',
            costUsd: 0,
            durationMs: 5,
          };
        },
      },
      priority: 0,
      costModel: 'free',
      costPerQueryUsd: 0,
    });

    const report = await preflight({
      config: configWith(),
      repos,
      search: new SearchFabric({ registry, need }),
      logger,
      need,
      probeInference: false,
    });

    assert.ok(queried > 0, 'le moteur doit être réellement interrogé');
    assert.equal(report.cleared, false, 'un parc muet ne doit pas laisser partir une mission');
    assert.equal(report.searchHealth, 'unhealthy');
    const check = report.checks.find((c) => c.name === 'search fabric')!;
    assert.match(check.detail, /BLOCKED-BY-SEARCH-FABRIC/);
  });

  test('la sonde peut être coupée, et le contrôle le dit', async () => {
    // Utile hors ligne : le rapport annonce alors que les moteurs n'ont pas été
    // interrogés, plutôt que de laisser croire qu'ils ont répondu.
    const report = await runFabric(fabricWith([{ key: 'duckduckgo' }, { key: 'searxng' }]));
    assert.equal(report.searchHealth, 'unknown', 'sans appel, la santé reste inconnue');
    const check = report.checks.find((c) => c.name === 'search fabric')!;
    assert.match(check.detail, /non interrogés/);
  });
});

/**
 * La sonde d'inférence.
 *
 * VAL-001 est morte à sa première étape parce que le solde du compte Anthropic
 * était épuisé — et le contrôle avant décollage venait d'afficher « ✓ inférence
 * — API Anthropic configurée ». La clé existait, elle était valide de forme, et
 * aucun appel ne pouvait aboutir.
 *
 * C'est la leçon de LIVE #005 appliquée au mauvais endroit : le moteur de
 * recherche était interrogé pour de vrai, le fournisseur du modèle était cru
 * sur parole — alors que c'est lui qui porte toute la dépense.
 */
describe('contrôle avant décollage — inférence', () => {
  const withFetch = async <T>(
    handler: (url: string) => Promise<Response>,
    run: () => Promise<T>,
  ): Promise<T> => {
    const original = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) =>
      handler(String(input))) as unknown as typeof fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = original;
    }
  };

  const probe = (config: AtlasConfig = configWith()) =>
    preflight({ config, repos, search: providerThat('ok'), logger, need: undefined as never });

  test('une clé présente ne suffit plus : l’API est interrogée', async () => {
    let called = '';
    const report = await withFetch(
      async (url) => {
        called = url;
        return new Response(JSON.stringify({ content: [] }), { status: 200 });
      },
      () => probe(),
    );

    assert.match(called, /api\.anthropic\.com/, 'le contrôle doit réellement appeler l’API');
    const check = report.checks.find((c) => c.name === 'inférence')!;
    assert.equal(check.status, 'pass');
    assert.match(check.detail, /répond en \d+ ms/);
  });

  test('un solde épuisé bloque le décollage, et dit quoi faire', async () => {
    // Le cas exact de VAL-001.
    const report = await withFetch(
      async () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'Your credit balance is too low' },
          }),
          { status: 400 },
        ),
      () => probe(),
    );

    assert.equal(report.cleared, false, 'une mission ne doit pas partir sans solde');
    const check = report.checks.find((c) => c.name === 'inférence')!;
    assert.equal(check.status, 'fail');
    assert.match(check.detail, /solde/i);
    assert.match(check.remedy ?? '', /Plans & Billing|simulation/);
  });

  test('les causes se distinguent : clé refusée, quota, modèle inconnu', async () => {
    // Recharger un compte, remplacer une clé et corriger un nom de modèle sont
    // trois gestes différents. « L'API ne répond pas » ne dit lequel.
    const cases: Array<[number, string, RegExp]> = [
      [401, '{}', /clé refusée/],
      [429, '{}', /quota/],
      [404, '{}', /inconnu du fournisseur/],
    ];

    for (const [status, body, expected] of cases) {
      const report = await withFetch(
        async () => new Response(body, { status }),
        () => probe(),
      );
      const check = report.checks.find((c) => c.name === 'inférence')!;
      assert.equal(check.status, 'fail', `HTTP ${status} doit bloquer`);
      assert.match(check.detail, expected);
    }
  });

  test('un réseau coupé est signalé comme tel', async () => {
    const report = await withFetch(
      async () => {
        throw new Error('ECONNREFUSED');
      },
      () => probe(),
    );
    const check = report.checks.find((c) => c.name === 'inférence')!;
    assert.equal(check.status, 'fail');
    assert.match(check.detail, /injoignable/);
  });

  test('la sonde ne part jamais en simulation', async () => {
    // Une démonstration ne doit rien appeler, même un jeton.
    let called = false;
    await withFetch(
      async () => {
        called = true;
        return new Response('{}', { status: 200 });
      },
      () => probe(configWith({ llm: { mode: 'simulation', declaredMode: 'simulation', apiKey: '' } })),
    );
    assert.equal(called, false);
  });

  test('la sonde peut être coupée sans faire échouer le contrôle', async () => {
    // Utile hors ligne : le contrôle prévient au lieu de bloquer.
    let called = false;
    const report = await withFetch(
      async () => {
        called = true;
        return new Response('{}', { status: 200 });
      },
      () =>
        preflight({
          config: configWith(),
          repos,
          search: providerThat('ok'),
          logger,
          probeInference: false,
        }),
    );

    assert.equal(called, false);
    const check = report.checks.find((c) => c.name === 'inférence')!;
    assert.equal(check.status, 'warn');
    assert.equal(check.blocking, false);
  });
});
