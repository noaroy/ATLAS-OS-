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
  test('le moteur par défaut fonctionne sans infrastructure', () => {
    // Le défaut a changé, et la raison mérite d'être écrite. SearXNG restait le
    // meilleur choix — un métamoteur qui fusionne plusieurs sources — mais il
    // exige Docker, et Docker ne démarre pas sur le poste de développement.
    // ATLAS s'est retrouvé des semaines avec un moteur configuré, injoignable,
    // et aucune mission réelle possible. Un défaut qui ne marche nulle part
    // n'est pas un défaut.
    assert.equal(configWith({}).search.provider, 'duckduckgo');
  });

  test('SearXNG reste choisissable quand il est disponible', () => {
    assert.equal(configWith({ ATLAS_SEARCH_PROVIDER: 'searxng' }).search.provider, 'searxng');
  });

  test('aucun service payant n’est requis', () => {
    const config = configWith({});
    assert.equal(config.search.braveApiKey, '', 'aucune clé fournie');
    assert.equal(config.search.provider, 'duckduckgo', 'et pourtant un moteur utilisable');
    assert.ok(config.search.searxngBaseUrl.length > 0, 'une URL SearXNG reste préconfigurée');
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
