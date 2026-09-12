import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '@atlas/core';
import {
  SearchProviderRegistry, SearchFabric, classifySearchReadiness, probeSearchProviders,
  type ProviderProbe, type SearchProvider, type SearchProviderOutcome, type SearchRequest, type SearchResponse,
} from '@atlas/intelligence';

/**
 * Le verdict de préparation de la recherche, et ce qu'il refuse.
 *
 * Le 10 septembre : SearXNG en CAPTCHA sur ses quatre moteurs, DuckDuckGo en
 * page de vérification, Brave sans clé. Tout « répondait », rien ne cherchait.
 * Ces tests fixent la lecture : un moteur ne compte que s'il rend des
 * résultats, et aucun modèle ne le remplace jamais.
 */
const logger = createLogger({ level: 'error', pretty: false });
const ctx = { logger, timeoutMs: 1000 };
const need = { countries: ['SE'], languages: ['sv'], commercial: true };
const request: SearchRequest = { query: 'distributör förpackningsmaskiner Sverige', count: 10 };

function moteur(key: string, outcome: SearchProviderOutcome, results = 0, available = true): SearchProvider {
  return {
    key, label: key,
    availability: () => (available ? { available: true, reason: 'prêt' } : { available: false, reason: `${key} sans clé` }),
    async search(): Promise<SearchResponse> {
      return {
        results: Array.from({ length: results }, (_, i) => ({
          title: `r${i}`, url: `https://exempel${i}.se/`, snippet: '', provider: key, rank: i + 1, query: request.query, retrievedAt: new Date().toISOString(),
        })),
        outcome, detail: outcome === 'rate-limited' ? 'CAPTCHA' : outcome, costUsd: 0, durationMs: 5,
      };
    },
  };
}

const registre = (...moteurs: SearchProvider[]) => {
  const r = new SearchProviderRegistry();
  for (const [i, m] of moteurs.entries()) r.register({ provider: m, priority: i + 1, costModel: 'free', costPerQueryUsd: 0 });
  return r;
};

describe('classification', () => {
  const sonde = (key: string, outcome: ProviderProbe['outcome'], results: number, extra: Partial<ProviderProbe> = {}): ProviderProbe => ({
    key, label: key, available: true, suitable: true, outcome, results, durationMs: 10, detail: '', ...extra,
  });

  test('deux moteurs qui rendent des résultats : READY', () => {
    const r = classifySearchReadiness([sonde('searxng', 'ok', 8), sonde('duckduckgo', 'ok', 5)]);
    assert.equal(r.readiness, 'SEARCH_READY');
    assert.deepEqual(r.usable, ['searxng', 'duckduckgo']);
  });

  test('un seul : DEGRADED, et dit lequel', () => {
    const r = classifySearchReadiness([sonde('searxng', 'rate-limited', 0), sonde('duckduckgo', 'ok', 5)]);
    assert.equal(r.readiness, 'SEARCH_DEGRADED');
    assert.deepEqual(r.usable, ['duckduckgo']);
    assert.match(r.summary, /duckduckgo/);
  });

  test('le 10 septembre : CAPTCHA, page de vérification, clé absente → BLOCKED', () => {
    const r = classifySearchReadiness([
      sonde('searxng', 'rate-limited', 0, { detail: 'moteur(s) bridé(s) — brave (Suspended), duckduckgo (CAPTCHA)' }),
      sonde('duckduckgo', 'rate-limited', 0, { detail: 'page de vérification' }),
      sonde('brave', 'not-probed', 0, { available: false, detail: 'Aucune clé Brave configurée' }),
      sonde('marginalia', 'not-probed', 0, { suitable: false, detail: 'index anglophone' }),
    ]);
    assert.equal(r.readiness, 'SEARCH_BLOCKED');
    assert.deepEqual(r.usable, []);
    assert.match(r.summary, /CAPTCHA/);
    assert.match(r.summary, /clé Brave/);
  });

  test('« empty » n’est pas une preuve de fonctionnement', () => {
    // Un moteur qui répond zéro à une requête de marché courante ne cherche pas.
    const r = classifySearchReadiness([sonde('searxng', 'empty', 0)]);
    assert.equal(r.readiness, 'SEARCH_BLOCKED');
  });

  test('un moteur inadapté au marché ne compte pas, même s’il rend des résultats', () => {
    const r = classifySearchReadiness([sonde('marginalia', 'ok', 10, { suitable: false })]);
    assert.equal(r.readiness, 'SEARCH_BLOCKED');
  });
});

describe('sondage réel des moteurs, un par un', () => {
  test('chaque moteur est interrogé, y compris ceux que le tissu n’aurait pas appelés', async () => {
    const probes = await probeSearchProviders(
      registre(moteur('searxng', 'ok', 4), moteur('duckduckgo', 'ok', 3), moteur('brave', 'rate-limited')), request, need, ctx,
    );
    assert.equal(probes.length, 3);
    assert.equal(classifySearchReadiness(probes).readiness, 'SEARCH_READY');
  });

  test('un moteur sans clé n’est pas interrogé, et le dit', async () => {
    const probes = await probeSearchProviders(registre(moteur('brave', 'ok', 5, false)), request, need, ctx);
    assert.equal(probes[0]!.outcome, 'not-probed');
    assert.match(probes[0]!.detail, /sans clé/);
  });

  test('un moteur qui lève est compté indisponible, pas comme une panne du contrôle', async () => {
    // Une clé connue du catalogue de capacités : un moteur inconnu serait
    // écarté comme inadapté avant même d'être sondé, et c'est voulu.
    const casse: SearchProvider = {
      key: 'searxng', label: 'searxng', availability: () => ({ available: true, reason: '' }),
      async search() { throw new Error('ECONNREFUSED'); },
    };
    const probes = await probeSearchProviders(registre(casse), request, need, ctx);
    assert.equal(probes[0]!.outcome, 'unavailable');
    assert.match(probes[0]!.detail, /ECONNREFUSED/);
  });
});

describe('aucun modèle ne remplace un moteur', () => {
  test('tous les moteurs en CAPTCHA : le tissu rend zéro résultat et le dit — il n’invente rien', async () => {
    const fabric = new SearchFabric({
      registry: registre(moteur('searxng', 'rate-limited'), moteur('duckduckgo', 'rate-limited')),
      need,
    });
    const r = await fabric.search(request, ctx);
    assert.equal(r.results.length, 0);
    assert.notEqual(r.outcome, 'ok');
    const trace = fabric.lastTrace();
    assert.equal(trace.attempts.length, 2, 'les deux moteurs ont été tentés');
    assert.ok(trace.attempts.every((a) => a.failedOver), 'chacun a passé la main');
  });
});
