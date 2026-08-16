import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '@atlas/core';
import { DuckDuckGoSearchProvider, parseResults } from '../src/search/duckduckgo.ts';

/**
 * L'analyse de la page de résultats.
 *
 * Ces tests portent sur du HTML figé, capturé sur une vraie réponse. Ils ne
 * touchent pas au réseau : une suite de tests qui dépend d'un service tiers
 * échoue les jours où ce service tousse, et on finit par ignorer ses échecs.
 *
 * Ce qu'ils protègent avant tout : le filtrage des annonces. DuckDuckGo place
 * ses publicités dans la même liste que les résultats organiques, sous la même
 * classe CSS, et enveloppe l'URL dans une redirection qui l'encode. Le premier
 * filtre cherchait la marque publicitaire dans le lien brut — où elle apparaît
 * sous forme percent-encodée — et ne mordait donc sur rien. Deux annonceurs
 * sont entrés dans la liste des candidats comme s'ils avaient été découverts
 * par la recherche.
 */

const logger = createLogger({ level: 'error', pretty: false });

const REQUEST = { query: 'Verpackungsmaschinen Hersteller Deutschland', count: 10 };
const AT = '2026-08-15T00:00:00.000Z';

/** Structure réelle : deux annonces en tête, puis des résultats organiques. */
const PAGE = `
<div class="results">
  <div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_domain%3Dstatec%2Dbinder.com%26ad_provider%3Dbingv7aa&amp;rut=abc">STATEC BINDER Bagging Systems</a>
      </h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Annonce payante</a>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.lilie%2Dgmbh.de%2F&amp;rut=def">Lilie GmbH &ndash; Verpackungsmaschinen</a>
      </h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=y">Hersteller von <b>Verpackungsmaschinen</b> in Deutschland.</a>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.bedo.de%2F&amp;rut=ghi">bedo&reg; Verpackungsmaschinen</a>
      </h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=z">Maschinen f&#252;r die Verpackung.</a>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.lilie%2Dgmbh.de&amp;rut=jkl">Lilie GmbH (doublon)</a>
      </h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=w">Doublon.</a>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=javascript%3Aalert(1)&amp;rut=mno">Lien piégé</a>
      </h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=v">Protocole interdit.</a>
    </div>
  </div>
</div>`;

describe('analyse des résultats DuckDuckGo', () => {
  const results = parseResults(PAGE, REQUEST as never, AT);

  test('les annonces sont écartées', () => {
    // Le cœur du sujet : une entreprise qui a payé pour apparaître n'a pas été
    // découverte. La présenter au fondateur comme un candidat serait faux.
    for (const result of results) {
      assert.ok(!result.url.includes('y.js'), `annonce retenue : ${result.url}`);
      assert.ok(!result.url.includes('ad_domain'), `annonce retenue : ${result.url}`);
    }
    assert.ok(
      !results.some((r) => r.title.includes('STATEC')),
      "l'annonce en tête de page est passée",
    );
  });

  test('les redirections sont déballées vers la source réelle', () => {
    // Une preuve doit citer la page, pas le chemin de suivi qui y mène.
    for (const result of results) {
      assert.ok(
        !result.url.includes('duckduckgo.com'),
        `lien de redirection conservé : ${result.url}`,
      );
      assert.match(result.url, /^https?:\/\//);
    }
  });

  test('les doublons de domaine sont fusionnés', () => {
    const hosts = results.map((r) => new URL(r.url).hostname.replace(/^www\./, ''));
    assert.equal(new Set(hosts).size, hosts.length, `doublons : ${hosts.join(', ')}`);
  });

  test('un protocole non web est rejeté', () => {
    assert.ok(
      !results.some((r) => r.title.includes('piégé')),
      'un lien javascript: a été accepté',
    );
  });

  test('les entités HTML sont décodées', () => {
    const lilie = results.find((r) => r.url.includes('lilie'));
    assert.ok(lilie);
    assert.ok(!lilie.title.includes('&'), `entité non décodée : ${lilie.title}`);
    const bedo = results.find((r) => r.url.includes('bedo'));
    assert.ok(bedo);
    assert.ok(bedo.snippet.includes('für'), `entité numérique non décodée : ${bedo.snippet}`);
    assert.ok(!bedo.snippet.includes('<b>'), 'balises non retirées');
  });

  test('la provenance et le rang sont renseignés', () => {
    results.forEach((result, index) => {
      assert.equal(result.provider, 'duckduckgo');
      assert.equal(result.rank, index + 1);
      assert.equal(result.query, REQUEST.query);
      assert.equal(result.retrievedAt, AT);
    });
  });

  test('seuls les résultats organiques survivent', () => {
    // Cinq blocs : une annonce, deux vrais, un doublon, un lien piégé.
    assert.equal(results.length, 2);
  });
});

describe('comportement du provider', () => {
  test('il se déclare disponible sans configuration', () => {
    const availability = new DuckDuckGoSearchProvider().availability();
    assert.equal(availability.available, true);
    assert.match(availability.reason, /sans|ni clé/i);
  });

  test("une annulation déjà signalée n'attend pas le délai", async () => {
    const provider = new DuckDuckGoSearchProvider();
    const controller = new AbortController();
    controller.abort();

    const started = Date.now();
    const response = await provider.search(
      { query: 'test', count: 5 },
      { logger, timeoutMs: 15_000, signal: controller.signal },
    );

    assert.ok(Date.now() - started < 3000, "l'annulation doit être immédiate");
    assert.equal(response.results.length, 0);
    assert.equal(response.costUsd, 0);
    assert.ok(['timeout', 'unavailable'].includes(response.outcome));
  });

  test('un échec ne coûte rien et ne rend aucun résultat', async () => {
    const provider = new DuckDuckGoSearchProvider();
    const response = await provider.search(
      { query: 'test', count: 5 },
      { logger, timeoutMs: 1 },
    );
    assert.equal(response.results.length, 0);
    assert.equal(response.costUsd, 0);
    assert.ok(response.detail.length > 0, 'un échec doit être expliqué');
  });
});
