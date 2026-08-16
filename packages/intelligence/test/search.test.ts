import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '@atlas/core';
import {
  BraveSearchProvider,
  filterResults,
  fetchTargetsFor,
  planQueries,
  type DiscoveryQuery,
  type SearchResult,
} from '@atlas/intelligence';

/**
 * La recherche comme service, non comme raisonnement.
 *
 * Trois missions consécutives ont vu l'ancienne architecture expirer — 120 s,
 * 180 s, 420 s — parce qu'un seul appel LLM devait chercher, filtrer, qualifier
 * et structurer d'un même geste. Ces tests portent sur la chaîne qui remplace
 * ce geste : requêtes courtes, moteur déterministe, filtrage mécanique.
 */

const logger = createLogger({ level: 'error', pretty: false });

const QUERY: DiscoveryQuery = {
  targetTypes: [
    { key: 'distributor', label: 'Distributeur', description: 'revend' },
    { key: 'integrator', label: 'Intégrateur', description: 'intègre' },
  ],
  countries: ['Allemagne'],
  industries: ["Machines d'emballage industrielles", 'Lignes de conditionnement'],
  keywords: [],
  exclusions: ['Annuaires, places de marché, comparateurs'],
  clientOffering: "Lignes d'emballage automatisées",
  limit: 2,
};

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

const braveBody = (results: Array<{ title: string; url: string; description: string }>) =>
  new Response(JSON.stringify({ web: { results } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

// ─── Le provider Brave ─────────────────────────────────────────────────────

describe('le moteur de recherche', () => {
  test('rend des résultats structurés avec leur provenance', async () => {
    const provider = new BraveSearchProvider({ apiKey: 'clé-de-test', costPerQueryUsd: 0.005 });

    const response = await withFetch(
      async () =>
        braveBody([
          {
            title: 'Verpackung Nord GmbH',
            url: 'https://verpackung-nord.de/',
            description: 'Händler für <strong>Verpackungsmaschinen</strong>',
          },
        ]),
      () => provider.search({ query: 'Händler Deutschland', count: 10 }, { logger }),
    );

    assert.equal(response.outcome, 'ok');
    assert.equal(response.results.length, 1);
    const first = response.results[0]!;
    assert.equal(first.url, 'https://verpackung-nord.de/');
    assert.equal(first.provider, 'brave');
    assert.equal(first.rank, 1);
    assert.equal(first.query, 'Händler Deutschland');
    assert.ok(first.retrievedAt, 'la date de récupération fait partie de la provenance');
    // Le balisage de mise en gras du moteur n'a rien à faire dans un extrait.
    assert.equal(first.snippet, 'Händler für Verpackungsmaschinen');
  });

  test('une réponse vide est un constat, pas une panne', async () => {
    const provider = new BraveSearchProvider({ apiKey: 'clé', costPerQueryUsd: 0.005 });
    const response = await withFetch(
      async () => braveBody([]),
      () => provider.search({ query: 'requête sans résultat', count: 10 }, { logger }),
    );
    assert.equal(response.outcome, 'empty');
    assert.deepEqual(response.results, []);
    assert.equal(response.costUsd, 0.005, 'une requête aboutie est facturée même sans résultat');
  });

  test('un quota atteint est distingué des autres erreurs', async () => {
    const provider = new BraveSearchProvider({ apiKey: 'clé', costPerQueryUsd: 0.005 });
    const response = await withFetch(
      async () => new Response('', { status: 429 }),
      () => provider.search({ query: 'x', count: 10 }, { logger }),
    );
    assert.equal(response.outcome, 'rate-limited');
    assert.equal(response.costUsd, 0, "une requête qui n'aboutit pas ne coûte rien");
  });

  test('une erreur HTTP est rapportée par son statut', async () => {
    const provider = new BraveSearchProvider({ apiKey: 'clé', costPerQueryUsd: 0.005 });
    const response = await withFetch(
      async () => new Response('', { status: 503 }),
      () => provider.search({ query: 'x', count: 10 }, { logger }),
    );
    assert.equal(response.outcome, 'http-error');
    assert.match(response.detail, /503/);
  });

  test('un moteur qui ne répond jamais est annulé, pas attendu', async () => {
    const provider = new BraveSearchProvider({ apiKey: 'clé', costPerQueryUsd: 0.005 });
    const response = await withFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      () => provider.search({ query: 'x', count: 10 }, { logger, timeoutMs: 60 }),
    );
    assert.equal(response.outcome, 'timeout');
  });

  test('une annulation venue de plus haut est honorée', async () => {
    const provider = new BraveSearchProvider({ apiKey: 'clé', costPerQueryUsd: 0.005 });
    const parent = new AbortController();
    setTimeout(() => parent.abort(), 30);

    const response = await withFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      () => provider.search({ query: 'x', count: 10 }, { logger, timeoutMs: 60_000, signal: parent.signal }),
    );
    assert.ok(['timeout', 'http-error'].includes(response.outcome));
  });

  test('sans clé, le provider se déclare indisponible', () => {
    const provider = new BraveSearchProvider({ apiKey: '', costPerQueryUsd: 0.005 });
    const availability = provider.availability();
    assert.equal(availability.available, false);
    assert.match(availability.reason, /BRAVE_SEARCH_API_KEY/);
  });

  test('la clé ne fuit ni dans le détail ni dans les résultats', async () => {
    const secret = 'sk-secret-brave-0123456789';
    const provider = new BraveSearchProvider({ apiKey: secret, costPerQueryUsd: 0.005 });
    const response = await withFetch(
      async () => new Response('', { status: 500 }),
      () => provider.search({ query: 'x', count: 10 }, { logger }),
    );
    assert.ok(!JSON.stringify(response).includes(secret), 'aucun secret dans la réponse rendue');
  });
});

// ─── Le planificateur ──────────────────────────────────────────────────────

describe('le planificateur de requêtes', () => {
  test('produit des requêtes courtes, pas une requête-fleuve', () => {
    // LIVE #005 envoyait onze mots-clés, cinq secteurs et quatre exclusions
    // dans une seule requête. Aucun moteur ne répond à cela.
    const planned = planQueries(QUERY, { maxQueries: 4 });

    assert.ok(planned.length > 0);
    for (const plan of planned) {
      const words = plan.query.split(/\s+/).filter(Boolean);
      assert.ok(words.length <= 5, `« ${plan.query} » fait ${words.length} mots`);
    }
  });

  test('ne dépasse jamais le nombre de requêtes autorisé', () => {
    assert.ok(planQueries(QUERY, { maxQueries: 4 }).length <= 4);
    assert.ok(planQueries(QUERY, { maxQueries: 2 }).length <= 2);
  });

  test('cherche dans la langue du marché', () => {
    // « distributeur de machines d'emballage » sur le marché allemand rend
    // surtout des pages françaises.
    const planned = planQueries(QUERY, { maxQueries: 4 });
    assert.ok(
      planned.some((p) => /Händler|Systemintegrator|Anlagenbau|Vertriebspartner/.test(p.query)),
      'les termes locaux sont ce qui trouve les bons acteurs',
    );
    assert.ok(planned.every((p) => p.country === 'DE'));
    assert.ok(planned.every((p) => p.language === 'de'));
  });

  test('couvre chaque rôle demandé', () => {
    const planned = planQueries(QUERY, { maxQueries: 4 });
    const roles = new Set(planned.map((p) => p.role));
    assert.ok(roles.has('distributor'));
    assert.ok(roles.has('integrator'));
  });

  test('ne produit jamais deux fois la même requête', () => {
    const planned = planQueries(QUERY, { maxQueries: 4 });
    assert.equal(new Set(planned.map((p) => p.query)).size, planned.length);
  });

  test('un marché inconnu reste cherchable', () => {
    const planned = planQueries({ ...QUERY, countries: ['Slovénie'] }, { maxQueries: 3 });
    assert.ok(planned.length > 0);
    assert.ok(planned.every((p) => p.query.includes('Slovénie')));
  });

  test('est déterministe — deux appels, le même plan', () => {
    // Aucun modèle n'intervient : le plan doit être reproductible à l'octet.
    assert.deepEqual(planQueries(QUERY, { maxQueries: 4 }), planQueries(QUERY, { maxQueries: 4 }));
  });
});

// ─── Le filtrage ───────────────────────────────────────────────────────────

const result = (url: string, title: string, query = 'q', rank = 1, snippet = ''): SearchResult => ({
  title,
  url,
  snippet,
  provider: 'brave',
  rank,
  query,
  retrievedAt: new Date().toISOString(),
});

describe('le filtrage déterministe', () => {
  test('regroupe plusieurs résultats du même domaine', () => {
    const report = filterResults(
      [
        result('https://nord-verpackung.de/produkte', 'Produkte', 'q1', 3),
        result('https://nord-verpackung.de/', 'Nord Verpackung GmbH', 'q2', 1),
        result('https://sued-technik.de/', 'Süd Technik', 'q1', 2),
      ],
      { exclusions: [], maxCandidates: 6 },
    );

    assert.equal(report.candidates.length, 2, 'un domaine, un candidat');
    const nord = report.candidates.find((c) => c.domain === 'nord-verpackung.de')!;
    assert.equal(nord.results.length, 2);
    // La racine identifie mieux l'organisation qu'une page profonde.
    assert.equal(nord.primaryUrl, 'https://nord-verpackung.de/');
    assert.equal(nord.likelyName, 'Nord Verpackung GmbH');
  });

  test('écarte annuaires, réseaux sociaux et agrégateurs', () => {
    // Un annuaire est une source, pas une entreprise à contacter.
    const report = filterResults(
      [
        result('https://www.europages.fr/entreprises', 'Europages'),
        result('https://de.linkedin.com/company/x', 'LinkedIn'),
        result('https://www.wlw.de/de/firma/y', 'wlw'),
        result('https://vraie-entreprise.de/', 'Vraie Entreprise GmbH'),
      ],
      { exclusions: [], maxCandidates: 6 },
    );

    assert.equal(report.candidates.length, 1);
    assert.equal(report.candidates[0]!.domain, 'vraie-entreprise.de');
    assert.equal(report.rejected.length, 3);
    assert.ok(
      report.rejected.every((r) => /annuaire|réseau social|agrégateur|plateforme/.test(r.reason)),
      'chaque rejet doit dire pourquoi, et une plateforme n’est pas une URL illisible',
    );
  });

  test('une exclusion courte et littérale écarte ce qu’elle nomme', () => {
    const report = filterResults(
      [
        result('https://a.de/', 'A GmbH', 'q', 1, 'Wir sind ein Hersteller von Verpackungslinien'),
        result('https://b.de/', 'B GmbH', 'q', 2, 'Händler für Verpackungsmaschinen'),
      ],
      { exclusions: ['Hersteller'], maxCandidates: 6 },
    );

    assert.equal(report.candidates.length, 1);
    assert.equal(report.candidates[0]!.domain, 'b.de');
  });

  test('une exclusion descriptive n’écarte pas tout le marché', () => {
    // La régression qui a coûté une mission réelle. L'exclusion était découpée
    // en mots isolés, si bien que « fabricants directs de machines d'emballage »
    // produisait les motifs « machines » et « emballage » — et rejetait les dix
    // résultats bruts, y compris chaque distributeur recherché. La mission a
    // conclu « marché vide » sur un filtre qui avait tout supprimé.
    //
    // Une expression longue relève du jugement : elle est laissée à l'étape de
    // qualification, où un modèle lit réellement les pages.
    const report = filterResults(
      [
        result('https://a.de/', 'A GmbH', 'q', 1, 'Verpackungsmaschinen für die Industrie'),
        result('https://b.de/', 'B GmbH', 'q', 2, 'Händler für Verpackungsmaschinen'),
        result('https://c.de/', 'C GmbH', 'q', 3, 'Systemintegration von Verpackungsanlagen'),
      ],
      {
        exclusions: ["fabricants directs de machines d'emballage sans réseau de distribution"],
        maxCandidates: 6,
      },
    );

    assert.equal(report.candidates.length, 3, 'aucun candidat ne devait être écarté');
    assert.equal(report.rejected.length, 0);
  });

  test('borne le nombre de candidats transmis au modèle', () => {
    // Pas cent pages envoyées au modèle : quatre à six dossiers.
    const many = Array.from({ length: 30 }, (_, i) =>
      result(`https://societe-${i}.de/`, `Société ${i}`, 'q', i + 1),
    );
    const report = filterResults(many, { exclusions: [], maxCandidates: 6 });
    assert.equal(report.candidates.length, 6);
    assert.equal(report.seen, 30);
  });

  test('privilégie ce que plusieurs requêtes ont trouvé', () => {
    // Une corroboration entre angles distincts vaut mieux qu'un premier rang
    // isolé.
    const report = filterResults(
      [
        result('https://solo.de/', 'Solo', 'q1', 1),
        result('https://double.de/', 'Double', 'q1', 5),
        result('https://double.de/produkte', 'Double Produkte', 'q2', 4),
      ],
      { exclusions: [], maxCandidates: 6 },
    );
    assert.equal(report.candidates[0]!.domain, 'double.de');
  });

  test('chaque rejet porte sa raison', () => {
    const report = filterResults([result('pas-une-url', 'X')], {
      exclusions: [],
      maxCandidates: 6,
    });
    assert.equal(report.candidates.length, 0);
    assert.equal(report.rejected.length, 1);
    assert.ok(report.rejected[0]!.reason.length > 0, 'un filtre muet est indébogable');
  });
});

describe('le choix des pages à récupérer', () => {
  test('deux pages au maximum, et jamais tout le site', () => {
    const report = filterResults(
      [
        result('https://x.de/', 'X GmbH', 'q', 1),
        result('https://x.de/produkte', 'Produkte', 'q', 2),
        result('https://x.de/kontakt', 'Kontakt', 'q', 3),
        result('https://x.de/blog/artikel', 'Blog', 'q', 4),
      ],
      { exclusions: [], maxCandidates: 6 },
    );

    const targets = fetchTargetsFor(report.candidates[0]!, 2);
    assert.equal(targets.length, 2);
    assert.equal(targets[0], 'https://x.de/');
    // Une page « produits » dit ce que fait l'entreprise ; un blog non.
    assert.equal(targets[1], 'https://x.de/produkte');
  });

  test('un plafond à zéro ne récupère rien', () => {
    const report = filterResults([result('https://x.de/', 'X')], {
      exclusions: [],
      maxCandidates: 6,
    });
    assert.deepEqual(fetchTargetsFor(report.candidates[0]!, 0), []);
  });
});
