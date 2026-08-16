import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '@atlas/core';

/**
 * Le repli vers la recherche par modèle ne doit jamais être silencieux.
 *
 * LIVE #005 a montré ce que coûte une recherche portée par un LLM : trois
 * tentatives, trois délais dépassés, 0,86 $ pour zéro candidat. Une requête
 * moteur coûte 0,005 $. Basculer de l'un à l'autre sans qu'on l'ait demandé
 * multiplierait la dépense par cent sans prévenir.
 */

/** Charge la configuration avec un environnement maîtrisé. */
function configWith(env: Record<string, string>) {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATLAS_') || key.startsWith('BRAVE_')) delete process.env[key];
    }
    process.env.ATLAS_SESSION_SECRET = 'x'.repeat(32);
    Object.assign(process.env, env);
    // Un répertoire inexistant : aucun .env réel ne vient brouiller le test.
    return loadConfig('/dossier-inexistant-pour-le-test');
  } finally {
    process.env = saved;
  }
}

describe('le choix du moteur de recherche', () => {
  test('le défaut n’est plus un moteur, mais un parc', () => {
    // Le défaut a changé deux fois, et les deux raisons méritent d'être écrites.
    //
    // SearXNG a cédé la place à DuckDuckGo parce qu'il exige Docker, et que
    // Docker ne démarre pas sur le poste de développement : ATLAS est resté des
    // semaines avec un moteur configuré, injoignable, et aucune mission réelle
    // possible.
    //
    // DuckDuckGo a cédé la place à `auto` parce qu'un moteur unique reste un
    // point de défaillance unique, quel qu'il soit. Il a bridé, et « attendre
    // quelques heures » est devenu la stratégie par défaut du système — ce qui
    // n'est pas une stratégie pour quelque chose censé tourner 24 h/24.
    assert.equal(configWith({}).search.provider, 'auto');
  });

  test('SearXNG reste choisissable quand il est disponible', () => {
    assert.equal(configWith({ ATLAS_SEARCH_PROVIDER: 'searxng' }).search.provider, 'searxng');
  });

  test('aucun service payant n’est requis', () => {
    const config = configWith({});
    assert.equal(config.search.braveApiKey, '', 'aucune clé fournie');
    assert.equal(config.search.provider, 'auto', 'et pourtant un parc utilisable');
    assert.ok(config.search.searxngBaseUrl.length > 0, 'une URL SearXNG reste préconfigurée');
  });

  test('un moteur nommé reste possible, pour reproduire un incident', () => {
    // Utile au diagnostic, et assumé : c'est alors un parc d'un seul moteur.
    assert.equal(configWith({ ATLAS_SEARCH_PROVIDER: 'duckduckgo' }).search.provider, 'duckduckgo');
  });

  test('Brave reste choisissable, en option', () => {
    assert.equal(configWith({ ATLAS_SEARCH_PROVIDER: 'brave' }).search.provider, 'brave');
  });

  test('les moteurs SearXNG sont une sélection resserrée', () => {
    // Quatre moteurs solides valent mieux que vingt dont la moitié expire.
    const engines = configWith({}).search.searxngEngines.split(',').filter(Boolean);
    assert.ok(engines.length > 0 && engines.length <= 6, `${engines.length} moteurs`);
  });

  test('le repli vers la recherche par modèle est désactivé par défaut', () => {
    // C'est la garantie : aucun basculement coûteux sans décision explicite.
    assert.equal(configWith({}).search.fallbackEnabled, false);
  });

  test('le repli ne s’active que sur demande explicite', () => {
    assert.equal(
      configWith({ ATLAS_SEARCH_FALLBACK_ENABLED: 'true' }).search.fallbackEnabled,
      true,
    );
  });

  test('la recherche par modèle reste choisissable, mais jamais par défaut', () => {
    assert.equal(configWith({ ATLAS_SEARCH_PROVIDER: 'anthropic' }).search.provider, 'anthropic');
  });

  test('le tarif par requête est configurable — le forfait varie', () => {
    assert.equal(configWith({ ATLAS_SEARCH_COST_PER_QUERY_USD: '0.012' }).search.costPerQueryUsd, 0.012);
  });

  test('le plafond de contexte de découverte a une valeur par défaut', () => {
    // LIVE #005 a produit un tour à 154 000 jetons ; le défaut doit être bien
    // en dessous.
    const ceiling = configWith({}).search.discoveryMaxContextTokens;
    assert.ok(ceiling > 0 && ceiling < 154_000);
  });
});
