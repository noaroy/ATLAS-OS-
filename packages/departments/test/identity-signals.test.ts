import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectIdentitySignals, corroborateIdentity, normalizeCompanyName,
} from '../src/identity-signals.ts';
import { collectCountrySignals, corroborateCountry } from '../src/country-evidence.ts';

/**
 * Le nom d'une entreprise vient de ses pages, jamais du moteur.
 *
 * Pour `nincar.fr`, le titre du résultat commençait par « Sous-traitance… » et
 * la base a enregistré une société appelée **« Sous »**. Treize citations
 * verbatim parfaitement vérifiées n'ont produit aucun brouillon : la garde
 * d'identité refusait — à raison — d'écrire à une entreprise dont le nom
 * n'était confirmé par rien.
 *
 * Un titre de moteur est une chaîne composée par un tiers, tronquée à longueur
 * variable. Il n'entre nulle part ici.
 */

const p = (html: string, url = 'https://harmony-beton.com/') => [{ url, html }];

// ─── LES SIGNAUX ────────────────────────────────────────────────────────────

describe('l’identité se lit dans ce que le site déclare', () => {
  test('un JSON-LD Organization compte', () => {
    const s = collectIdentitySignals(p(
      '<script type="application/ld+json">{"@type":"Organization","name":"Harmony Béton"}</script>',
    ));
    assert.equal(s.some((x) => x.sourceType === 'JSONLD_ORGANIZATION' && x.value === 'Harmony Béton'), true);
  });

  test('legalName est distingué de name', () => {
    const s = collectIdentitySignals(p(
      '<script type="application/ld+json">{"@type":"Organization","legalName":"Harmony Béton SAS","name":"Harmony Béton"}</script>',
    ));
    assert.equal(s.some((x) => x.sourceType === 'SCHEMA_LEGAL_NAME'), true);
  });

  test('og:site_name compte, dans les deux ordres d’attributs', () => {
    for (const html of [
      '<meta property="og:site_name" content="Harmony Béton">',
      '<meta content="Harmony Béton" property="og:site_name">',
    ]) {
      assert.equal(
        collectIdentitySignals(p(html)).some((x) => x.sourceType === 'OG_SITE_NAME'),
        true, html,
      );
    }
  });

  test('le copyright du pied de page compte', () => {
    const s = collectIdentitySignals(p('<footer>© 2026 Harmony Béton — Tous droits réservés</footer>'));
    const c = s.find((x) => x.sourceType === 'FOOTER_COPYRIGHT');
    assert.ok(c);
    assert.match(normalizeCompanyName(c!.value), /harmony beton/);
  });

  test('chaque signal conserve sa source et sa valeur brute', () => {
    const s = collectIdentitySignals(p('<meta property="og:site_name" content="Harmony Béton">'));
    const sig = s[0]!;
    assert.equal(sig.sourceUrl, 'https://harmony-beton.com/');
    assert.ok(sig.rawValue.length > 0);
    assert.ok(sig.confidence > 0 && sig.confidence < 1);
  });

  test('« Accueil » ou « Contact » ne sont jamais des noms', () => {
    const s = collectIdentitySignals(p('<h1>Accueil</h1><title>Contact</title>'));
    assert.equal(s.length, 0);
  });

  test('une phrase entière n’est pas un nom d’entreprise', () => {
    const s = collectIdentitySignals(p(
      '<h1>Nous concevons et fabriquons des solutions béton sur mesure depuis 1998.</h1>',
    ));
    assert.equal(s.length, 0);
  });
});

// ─── LE TITRE DU MOTEUR ─────────────────────────────────────────────────────

describe('le titre du résultat de recherche n’entre nulle part', () => {
  test('la fonction ne l’accepte pas comme paramètre', () => {
    /*
     * Garantie structurelle plutôt que comportementale : `collectIdentitySignals`
     * ne reçoit que des pages. Un titre de moteur ne peut pas entrer par
     * mégarde, parce qu'il n'y a aucun champ où le mettre.
     */
    assert.equal(collectIdentitySignals.length, 1);
  });

  test('« Sous-traitance… » sur une page sans déclaration ne donne rien', () => {
    // Le cas nincar.fr : la page existe, elle ne déclare aucun nom.
    const s = collectIdentitySignals(p('<body><p>Sous-traitance de pièces métalliques.</p></body>'));
    assert.equal(corroborateIdentity(s, 'nincar.fr').name, null);
  });
});

// ─── LA CORROBORATION ───────────────────────────────────────────────────────

describe('la confiance monte par concordance, pas par autorité', () => {
  test('un signal déclarant isolé ne franchit pas 0,75', () => {
    const s = collectIdentitySignals(p('<meta property="og:site_name" content="Harmony Béton">'));
    const v = corroborateIdentity(s, 'harmony-beton.com');
    assert.ok(v.confidence < 0.75, `${v.confidence}`);
  });

  test('deux sources déclarantes concordantes franchissent le seuil', () => {
    const v = corroborateIdentity(collectIdentitySignals(p(
      '<meta property="og:site_name" content="Harmony Béton">'
      + '<footer>© 2026 Harmony Béton</footer>'
      + '<h1>Harmony Béton</h1>',
    )), 'harmony-beton.com');
    assert.equal(normalizeCompanyName(v.name ?? ''), 'harmony beton');
    assert.ok(v.confidence >= 0.75, `${v.confidence}`);
  });

  test('la forme juridique ne fait pas deux entreprises', () => {
    const v = corroborateIdentity(collectIdentitySignals(p(
      '<script type="application/ld+json">{"@type":"Organization","legalName":"Harmony Béton SAS"}</script>'
      + '<meta property="og:site_name" content="Harmony Béton">',
    )), 'harmony-beton.com');
    assert.ok(v.confidence >= 0.75);
    assert.equal(v.conflicting.length, 0);
  });

  test('des signaux contradictoires ne font monter personne', () => {
    /*
     * Choisir le premier reviendrait à tirer au sort, et un message adressé à
     * la mauvaise société est pire qu'un message non écrit.
     */
    const v = corroborateIdentity([
      { value: 'Alpha', rawValue: 'Alpha', sourceType: 'OG_SITE_NAME', sourceUrl: 'https://x.fr/', confidence: 0.6 },
      { value: 'Beta', rawValue: 'Beta', sourceType: 'FOOTER_COPYRIGHT', sourceUrl: 'https://x.fr/', confidence: 0.6 },
    ], 'x.fr');
    assert.equal(v.name, null);
    assert.match(v.reason, /contradictoires/);
  });

  test('un titre seul n’établit aucune identité', () => {
    const v = corroborateIdentity([
      { value: 'Harmony Béton', rawValue: 'Harmony Béton', sourceType: 'HOMEPAGE_HEADING', sourceUrl: 'https://x.fr/', confidence: 0.4 },
    ], 'harmony-beton.com');
    assert.equal(v.name, null);
    assert.match(v.reason, /titres de page|aucun signal/);
  });

  test('aucun signal laisse le blocage en place', () => {
    const v = corroborateIdentity([], 'inconnu.fr');
    assert.equal(v.name, null);
    assert.equal(v.confidence, 0);
  });

  test('le domaine seul ne suffit jamais', () => {
    // Aucune déclaration : le nom du domaine ne devient pas une identité.
    assert.equal(corroborateIdentity(collectIdentitySignals(p('<p>Bienvenue.</p>')), 'harmony-beton.com').name, null);
  });
});

// ─── LE PAYS ────────────────────────────────────────────────────────────────

describe('le pays se corrobore, et .fr ne prouve rien', () => {
  test('une extension .fr seule laisse UNKNOWN', () => {
    const v = corroborateCountry(collectCountrySignals(p('<p>Nos ateliers.</p>', 'https://nincar.fr/')));
    assert.equal(v.country, null);
  });

  test('un SIRET établit la France', () => {
    const v = corroborateCountry(collectCountrySignals(p('<p>SIRET : 92891442300019</p>')));
    assert.equal(v.country, 'France');
  });

  test('une TVA FR établit la France', () => {
    const v = corroborateCountry(collectCountrySignals(p(
      '<p>TVA intracommunautaire : FR17928914423</p>', 'https://x.fr/mentions-legales',
    )));
    assert.equal(v.country, 'France');
  });

  test('une adresse France explicite établit la France', () => {
    const v = corroborateCountry(collectCountrySignals(p(
      '<p>Adresse : 9 Av. Roger Lapébie, 33140 Villenave-d’Ornon, France</p>',
    )));
    assert.equal(v.country, 'France');
  });

  test('un +33 seul ne suffit pas', () => {
    /*
     * Un indicatif est une corroboration : beaucoup de sociétés étrangères
     * publient un numéro français pour leur service commercial.
     */
    const v = corroborateCountry(collectCountrySignals(p('<p>Tel : +33 4 78 00 00 00</p>', 'https://x.com/')));
    assert.equal(v.country, null);
    assert.match(v.reason, /secondaire/);
  });

  test('un +33 et une mention France sur une page contact suffisent', () => {
    const v = corroborateCountry(collectCountrySignals(p(
      '<p>Nous contacter — Tel : +33 4 78 00 00 00 — nos bureaux en France</p>',
      'https://x.com/contact',
    )));
    assert.equal(v.country, 'France');
  });

  test('aucune preuve laisse le blocage en place', () => {
    assert.equal(corroborateCountry(collectCountrySignals(p('<p>Rien.</p>'))).country, null);
    assert.equal(corroborateCountry([]).country, null);
  });
});
