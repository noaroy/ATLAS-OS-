import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '@atlas/core';
import { MarginaliaSearchProvider, normalise } from '../src/search/marginalia.ts';

/**
 * Le second moteur.
 *
 * ATLAS avait une seule source de découverte, et le jour où elle a bridé cette
 * adresse, plus aucune mission réelle n'était possible. Ces tests protègent la
 * normalisation du second index — un moteur de secours qui rendrait des données
 * mal formées serait pire qu'aucun.
 *
 * Aucun appel réseau : une suite qui dépend d'un service tiers échoue les jours
 * où ce service tousse, et on finit par ignorer ses échecs.
 */

const logger = createLogger({ level: 'error', pretty: false });
const REQUEST = { query: 'packaging machinery germany', count: 10 };
const AT = '2026-08-16T00:00:00.000Z';

const BODY = {
  license: 'CC-BY-NC-SA 4.0',
  results: [
    { url: 'https://www.exemple-gmbh.de/', title: 'Exemple GmbH', description: 'Verpackungsmaschinen  aus\nDeutschland' },
    { url: 'https://exemple-gmbh.de/produkte', title: 'Produits', description: 'Doublon de domaine' },
    { url: 'javascript:alert(1)', title: 'Piégé', description: '' },
    { url: 'https://autre.de/', title: '   ', description: 'Titre vide' },
    { url: 'https://troisieme.de/', title: 'Troisième GmbH', description: 'Systemintegration' },
    { url: 'pas-une-url', title: 'Cassé', description: '' },
  ],
};

describe('normalisation Marginalia', () => {
  const results = normalise(BODY, REQUEST as never, AT);

  test('un domaine ne compte qu’une fois', () => {
    // Marginalia rend volontiers plusieurs pages d'un même site ; les compter
    // séparément gonflerait le nombre de candidats sans ajouter d'entreprise.
    const hosts = results.map((r) => new URL(r.url).hostname.replace(/^www\./, ''));
    assert.equal(new Set(hosts).size, hosts.length, `doublons : ${hosts.join(', ')}`);
  });

  test('les protocoles non web sont rejetés', () => {
    assert.ok(!results.some((r) => r.url.startsWith('javascript:')));
    assert.ok(results.every((r) => /^https?:\/\//.test(r.url)));
  });

  test('un résultat sans titre est écarté', () => {
    assert.ok(!results.some((r) => r.title.trim().length === 0));
    assert.ok(!results.some((r) => r.url.includes('autre.de')));
  });

  test('une URL illisible est écartée', () => {
    assert.equal(results.length, 2, `attendu 2, obtenu ${results.map((r) => r.url).join(', ')}`);
  });

  test('les espaces des extraits sont normalisés', () => {
    const first = results[0]!;
    assert.ok(!/\s{2,}|\n/.test(first.snippet), `extrait mal nettoyé : « ${first.snippet} »`);
  });

  test('la provenance et le rang sont renseignés', () => {
    results.forEach((result, index) => {
      assert.equal(result.provider, 'marginalia');
      assert.equal(result.rank, index + 1);
      assert.equal(result.query, REQUEST.query);
      assert.equal(result.retrievedAt, AT);
    });
  });

  test('une réponse vide ne casse rien', () => {
    assert.deepEqual(normalise({}, REQUEST as never, AT), []);
    assert.deepEqual(normalise({ results: [] }, REQUEST as never, AT), []);
  });
});

describe('comportement du provider', () => {
  test('il est disponible sans configuration, et le dit franchement', () => {
    const availability = new MarginaliaSearchProvider().availability();
    assert.equal(availability.available, true);
    // La limite doit être écrite : un index restreint qu'on croit complet
    // produit des conclusions fausses sur un marché.
    assert.match(availability.reason, /restreint|anglais/i);
  });

  test('un échec ne coûte rien et reste expliqué', async () => {
    const response = await new MarginaliaSearchProvider().search(
      { query: 'test', count: 5 },
      { logger, timeoutMs: 1 },
    );
    assert.equal(response.results.length, 0);
    assert.equal(response.costUsd, 0);
    assert.ok(response.detail.length > 0);
  });

  test("une annulation déjà signalée n'attend pas le délai", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const response = await new MarginaliaSearchProvider().search(
      { query: 'test', count: 5 },
      { logger, timeoutMs: 15_000, signal: controller.signal },
    );
    assert.ok(Date.now() - started < 3000);
    assert.equal(response.results.length, 0);
  });
});
