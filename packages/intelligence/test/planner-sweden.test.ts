import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planQueries } from '../src/search/planner.ts';
import type { DiscoveryQuery } from '../src/discovery/types.ts';

/**
 * Le marché suédois, tel qu'un brief peut le nommer.
 *
 * Avant : « Suède » n'était pas un marché connu. Le planificateur partait en
 * anglais, sans pays, avec le mot « Suède » collé en fin de requête —
 * `distributor machines contrôle Suède`. Un moteur y répond par des pages
 * françaises qui parlent de la Suède, jamais par un distributeur suédois.
 * C'est ce que la première mission client aurait cherché.
 */
const brief = (countries: string[], extra: Partial<DiscoveryQuery> = {}): DiscoveryQuery => ({
  targetTypes: [
    { key: 'distributor', label: 'Distributeur', description: '' },
    { key: 'commercial-partner', label: 'Partenaire commercial', description: '' },
  ],
  countries,
  industries: ['kosmetik', 'läkemedel'],
  keywords: ['förpackningsmaskiner', 'kontrollutrustning'],
  exclusions: [],
  clientOffering: null,
  limit: 10,
  ...extra,
});

describe('la Suède est un marché connu du planificateur', () => {
  for (const nom of ['Suède', 'suede', 'Sweden', 'Sverige', 'SE', 'sv', 'svenska']) {
    test(`« ${nom} » → langue sv, pays SE, libellé Sverige`, () => {
      const [q] = planQueries(brief([nom]), { maxQueries: 1 });
      assert.ok(q);
      assert.equal(q.language, 'sv');
      assert.equal(q.country, 'SE');
      assert.match(q.query, /Sverige/);
      assert.doesNotMatch(q.query, /Suède|Sweden/);
    });
  }

  test('un distributeur se cherche en suédois', () => {
    const queries = planQueries(brief(['Suède']), { maxQueries: 8 });
    const distributeur = queries.filter((q) => q.role === 'distributor');
    assert.ok(distributeur.length > 0);
    for (const q of distributeur) assert.match(q.query, /distributör/);
  });

  test('un partenaire commercial se cherche par agent ou representant', () => {
    const queries = planQueries(brief(['Suède']), { maxQueries: 8 });
    const partenaire = queries.filter((q) => q.role === 'commercial-partner');
    assert.ok(partenaire.length > 0);
    for (const q of partenaire) assert.match(q.query, /agent|representant|försäljningspartner/);
  });

  test('un revendeur se cherche par återförsäljare', () => {
    const [q] = planQueries(
      brief(['Sverige'], { targetTypes: [{ key: 'reseller', label: 'Revendeur', description: '' }] }),
      { maxQueries: 1 },
    );
    assert.match(q!.query, /återförsäljare/);
  });

  test('les mots-clés du brief passent tels quels, sans traduction inventée', () => {
    const queries = planQueries(brief(['Suède']), { maxQueries: 8 });
    assert.ok(queries.some((q) => /förpackningsmaskiner/.test(q.query)));
    assert.ok(queries.some((q) => /kontrollutrustning/.test(q.query)));
  });

  test('un secteur ne fait jamais une requête seul : il précise un mot-clé produit', () => {
    const queries = planQueries(brief(['Suède']), { maxQueries: 8 });
    for (const q of queries) {
      if (/kosmetik|läkemedel/.test(q.query)) assert.match(q.query, /förpackningsmaskiner/, q.query);
    }
    assert.ok(queries.some((q) => /förpackningsmaskiner kosmetik/.test(q.query)), 'le secteur précise le produit');
    assert.ok(!queries.some((q) => /^distributör kosmetik Sverige$/.test(q.query)), 'plus de requête secteur seul');
  });

  test('une requête reste courte : un rôle, un angle, un pays', () => {
    for (const q of planQueries(brief(['Suède']), { maxQueries: 8 })) {
      assert.ok(q.query.split(/\s+/).length <= 5, q.query);
    }
  });

  test('un marché inconnu part toujours sans pays — le comportement d’avant reste explicite', () => {
    // Ce n'est pas une régression, c'est le contrat : un pays absent du
    // planificateur ne peut pas être filtré. Le preflight refuse ce cas.
    const [q] = planQueries(brief(['Atlantide']), { maxQueries: 1 });
    assert.equal(q!.country, null);
    assert.equal(q!.language, 'en');
  });
});
