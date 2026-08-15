import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '@atlas/core';
import { PipelineDiscoveryProvider, type DiscoveryQuery, type SearchProvider } from '@atlas/intelligence';
import { ScriptedProvider } from '@atlas/testing';

/**
 * La chaîne de découverte, de bout en bout.
 *
 * ```
 * requêtes courtes → moteur → filtrage → pages ciblées → analyse
 * ```
 *
 * Ce que ces tests doivent établir : le modèle ne cherche plus, il n'analyse
 * qu'une poignée de candidats déjà identifiés, et il ne peut pas introduire une
 * organisation que la recherche n'a pas rendue.
 */

const logger = createLogger({ level: 'error', pretty: false });

const QUERY: DiscoveryQuery = {
  targetTypes: [{ key: 'distributor', label: 'Distributeur', description: 'revend' }],
  countries: ['Allemagne'],
  industries: ["Machines d'emballage"],
  keywords: [],
  exclusions: [],
  clientOffering: "Lignes d'emballage",
  limit: 2,
};

/** Un moteur de recherche dont le test décide entièrement les réponses. */
function engine(
  byQuery: (query: string) => Array<{ title: string; url: string; snippet?: string }>,
  overrides: { outcome?: 'ok' | 'empty' | 'timeout'; costUsd?: number } = {},
): SearchProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    key: 'moteur-test',
    label: 'Moteur de test',
    calls,
    availability: () => ({ available: true, reason: 'disponible' }),
    async search(request) {
      calls.push(request.query);
      const hits = byQuery(request.query);
      return {
        results: hits.map((h, i) => ({
          title: h.title,
          url: h.url,
          snippet: h.snippet ?? '',
          provider: 'moteur-test',
          rank: i + 1,
          query: request.query,
          retrievedAt: new Date().toISOString(),
        })),
        outcome: overrides.outcome ?? (hits.length > 0 ? 'ok' : 'empty'),
        detail: 'test',
        costUsd: overrides.costUsd ?? 0.005,
        durationMs: 12,
      };
    },
  };
}

/** Empêche toute récupération réseau : le test porte sur la chaîne, pas sur le web. */
async function withoutFetch<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('réseau indisponible en test');
  }) as typeof globalThis.fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const options = {
  model: 'claude-sonnet-5',
  maxTokens: 4000,
  maxQueries: 4,
  resultsPerQuery: 10,
  maxCandidates: 4,
  maxFetchesPerCandidate: 2,
  maxCharsPerPage: 2000,
  searchTimeoutMs: 5_000,
  fetchTimeoutMs: 5_000,
};

/** Une analyse scriptée : le test décide ce que le modèle « retient ». */
const analyst = (companies: unknown[]) =>
  new ScriptedProvider(async () => ({ kind: 'json', value: { companies } }));

describe('la chaîne de découverte', () => {
  test('cherche, filtre, puis analyse — dans cet ordre', async () => {
    const search = engine(() => [
      { title: 'Nord Verpackung GmbH', url: 'https://nord-verpackung.de/' },
      { title: 'Europages', url: 'https://www.europages.fr/x' },
    ]);
    const llm = analyst([
      { domain: 'nord-verpackung.de', relevant: true, name: 'Nord Verpackung GmbH', roles: ['distributor'], confidence: 0.7 },
    ]);

    const provider = new PipelineDiscoveryProvider(search, llm, options);
    const result = await withoutFetch(() => provider.search(QUERY, { logger }));

    assert.equal(result.outcome, 'success-with-results');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]!.name, 'Nord Verpackung GmbH');
    // Le moteur a été interrogé plusieurs fois, avec des requêtes courtes.
    assert.ok(search.calls.length > 0 && search.calls.length <= 4);
    // Un seul appel au modèle, et seulement pour analyser.
    assert.equal(llm.calls.length, 1);
  });

  test('le modèle ne voit que les candidats survivants', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      title: `Société ${i}`,
      url: `https://societe-${i}.de/`,
    }));
    const search = engine(() => many);
    const llm = analyst([]);

    const provider = new PipelineDiscoveryProvider(search, llm, { ...options, maxCandidates: 4 });
    await withoutFetch(() => provider.search(QUERY, { logger }));

    const prompt = llm.calls[0]!.messages
      .flatMap((m) => m.content)
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n');

    // Quatre dossiers, pas cent pages.
    assert.match(prompt, /# Dossiers \(4\)/);
  });

  test('le modèle ne peut pas introduire une entreprise que la recherche n’a pas rendue', async () => {
    // La garantie anti-fabrication : un domaine absent des dossiers est ignoré,
    // quoi que le modèle en dise.
    const search = engine(() => [{ title: 'Réelle GmbH', url: 'https://reelle.de/' }]);
    const llm = analyst([
      { domain: 'reelle.de', relevant: true, name: 'Réelle GmbH', roles: ['distributor'] },
      { domain: 'inventee.de', relevant: true, name: 'Inventée GmbH', roles: ['distributor'] },
    ]);

    const provider = new PipelineDiscoveryProvider(search, llm, options);
    const result = await withoutFetch(() => provider.search(QUERY, { logger }));

    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]!.website, 'https://reelle.de/');
  });

  test('la provenance vient de la recherche, pas du modèle', async () => {
    const search = engine(() => [
      { title: 'Réelle GmbH', url: 'https://reelle.de/', snippet: 'Händler' },
    ]);
    const llm = analyst([{ domain: 'reelle.de', relevant: true, roles: ['distributor'] }]);

    const provider = new PipelineDiscoveryProvider(search, llm, options);
    const result = await withoutFetch(() => provider.search(QUERY, { logger }));

    const sources = result.candidates[0]!.sources;
    assert.ok(sources.length > 0);
    assert.equal(sources[0]!.ref, 'https://reelle.de/');
    assert.equal(sources[0]!.provider, 'moteur-test');
    assert.ok(sources[0]!.retrievedAt, 'chaque source porte sa date de récupération');
  });

  test('un rôle non demandé est écarté', async () => {
    const search = engine(() => [{ title: 'X GmbH', url: 'https://x.de/' }]);
    const llm = analyst([
      { domain: 'x.de', relevant: true, roles: ['distributor', 'competitor'] },
    ]);

    const provider = new PipelineDiscoveryProvider(search, llm, options);
    const result = await withoutFetch(() => provider.search(QUERY, { logger }));
    assert.deepEqual(result.candidates[0]!.roles, ['distributor']);
  });

  test('un candidat jugé non pertinent n’entre pas dans le pipeline', async () => {
    const search = engine(() => [{ title: 'X GmbH', url: 'https://x.de/' }]);
    const llm = analyst([{ domain: 'x.de', relevant: false }]);

    const provider = new PipelineDiscoveryProvider(search, llm, options);
    const result = await withoutFetch(() => provider.search(QUERY, { logger }));

    assert.equal(result.candidates.length, 0);
    assert.equal(result.outcome, 'success-empty');
  });
});

describe('quand la recherche ne donne rien', () => {
  test('un moteur muet donne success-empty, pas une panne', async () => {
    const search = engine(() => []);
    const llm = analyst([]);

    const provider = new PipelineDiscoveryProvider(search, llm, options);
    const result = await withoutFetch(() => provider.search(QUERY, { logger }));

    assert.equal(result.outcome, 'success-empty');
    assert.equal(llm.calls.length, 0, "sans candidat, le modèle n'est jamais appelé");
  });

  test('un moteur en panne donne provider-failure', async () => {
    // « Rien trouvé » et « n'a pas pu chercher » ne se corrigent pas pareil.
    const search = engine(() => [], { outcome: 'timeout' });
    const llm = analyst([]);

    const provider = new PipelineDiscoveryProvider(search, llm, options);
    const result = await withoutFetch(() => provider.search(QUERY, { logger }));

    assert.equal(result.outcome, 'provider-failure');
    assert.equal(llm.calls.length, 0);
  });
});

describe('la comptabilité du moteur', () => {
  test('le coût de recherche est compté à part de l’inférence', async () => {
    // Une recherche à 0,005 $ et un raisonnement à 0,50 $ ne se pilotent pas de
    // la même manière ; les confondre a masqué la vraie dépense pendant cinq
    // missions.
    const search = engine(() => [{ title: 'X GmbH', url: 'https://x.de/' }], { costUsd: 0.005 });
    const llm = analyst([{ domain: 'x.de', relevant: true, roles: ['distributor'] }]);

    const provider = new PipelineDiscoveryProvider(search, llm, options);
    const result = await withoutFetch(() => provider.search(QUERY, { logger }));

    assert.equal(provider.lastCost.queriesRun, search.calls.length);
    assert.equal(
      provider.lastCost.searchApiCostUsd,
      Number((0.005 * search.calls.length).toFixed(10)),
    );
    assert.equal(result.externalCostUsd, provider.lastCost.searchApiCostUsd);
  });

  test('les résultats bruts et les pages sont comptés', async () => {
    const search = engine(() => [
      { title: 'A', url: 'https://a.de/' },
      { title: 'B', url: 'https://b.de/' },
    ]);
    const llm = analyst([]);

    const provider = new PipelineDiscoveryProvider(search, llm, options);
    await withoutFetch(() => provider.search(QUERY, { logger }));

    assert.ok(provider.lastCost.rawResults > 0);
    // Le réseau est coupé dans ce test : aucune page ne peut être récupérée,
    // et la chaîne doit continuer malgré tout.
    assert.equal(provider.lastCost.pagesFetched, 0);
  });
});

describe('le modèle reçoit un contexte borné', () => {
  test('l’analyse met le prompt système en cache', async () => {
    // Les consignes d'analyse sont identiques d'un appel à l'autre : les mettre
    // en cache les rend presque gratuites dès la deuxième mission.
    const search = engine(() => [{ title: 'X GmbH', url: 'https://x.de/' }]);
    const llm = analyst([{ domain: 'x.de', relevant: true, roles: ['distributor'] }]);

    const provider = new PipelineDiscoveryProvider(search, llm, options);
    await withoutFetch(() => provider.search(QUERY, { logger }));

    assert.equal(llm.calls[0]!.cacheSystemPrompt, true);
  });

  test('l’analyse ne demande aucun outil de recherche au modèle', async () => {
    // Le point de bascule : le modèle n'est plus un moteur.
    const search = engine(() => [{ title: 'X GmbH', url: 'https://x.de/' }]);
    const llm = analyst([{ domain: 'x.de', relevant: true, roles: ['distributor'] }]);

    const provider = new PipelineDiscoveryProvider(search, llm, options);
    await withoutFetch(() => provider.search(QUERY, { logger }));

    assert.equal(llm.calls[0]!.serverTools, undefined);
    assert.equal(llm.calls[0]!.tools, undefined);
  });
});
