import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCountryEvidence, collectCountrySignals, corroborateCountry, countryFit,
} from '../src/country-evidence.ts';

/**
 * La Suède, prouvée ou pas du tout.
 *
 * Une entreprise suédoise publie son organisationsnummer et, souvent, son
 * numéro de TVA. Un indicatif +46, une adresse à Göteborg, le mot « Sverige »
 * sur une page : chacun rassure, aucun ne suffit seul. Les tests négatifs
 * comptent autant que les positifs — un motif trop large ferait entrer des
 * sociétés d'ailleurs dans une mission qui vise ce seul pays.
 */
const page = (html: string, url = 'https://exempel.se/om-oss') => [{ url, html }];

describe('ce qui prouve la Suède', () => {
  test('un organisationsnummer avec son mot-clé', () => {
    const v = extractCountryEvidence(page('<p>Nordpack AB · Org.nr 556123-4567 · Göteborg</p>'));
    assert.equal(v.country, 'Suède');
    assert.equal(v.basis, 'OFFICIAL_ID');
    assert.match(v.quote ?? '', /556123-4567/);
  });

  for (const forme of ['Organisationsnummer: 556123-4567', 'Org nr 556123-4567', 'Orgnr: 556123-4567', 'organisationsnr 969876-5432']) {
    test(`graphie « ${forme.split(/[: ]/)[0]} » reconnue`, () => {
      const v = extractCountryEvidence(page(`<p>${forme}</p>`));
      assert.equal(v.country, 'Suède', forme);
    });
  }

  test('un numéro de TVA suédois, SE + dix chiffres + 01', () => {
    const v = extractCountryEvidence(page('<p>VAT: SE556123456701</p>'));
    assert.equal(v.country, 'Suède');
    assert.equal(v.basis, 'OFFICIAL_ID');
  });

  test('la TVA avec un espace après le préfixe', () => {
    const v = extractCountryEvidence(page('<p>Momsreg.nr SE 556123456701</p>'));
    assert.equal(v.country, 'Suède');
  });

  test('un pays prouvé entre dans le profil suédois, et sort du profil français', () => {
    assert.equal(countryFit('Suède', ['Suède']).fit, 'IN_SCOPE');
    assert.equal(countryFit('Suède', ['France', 'Belgique', 'Suisse']).fit, 'OUT_OF_SCOPE');
    assert.equal(countryFit('France', ['Suède']).fit, 'OUT_OF_SCOPE');
    assert.equal(countryFit(null, ['Suède']).fit, 'NEEDS_VERIFICATION');
  });
});

describe('ce qui ne prouve pas la Suède', () => {
  test('dix chiffres et un tiret sans mot-clé : un téléphone, pas un registre', () => {
    const v = extractCountryEvidence(page('<p>Ring oss: 031-123 45 67 · Fax 556123-4567</p>'));
    assert.notEqual(v.basis, 'OFFICIAL_ID');
    assert.equal(v.country, null);
  });

  test('un préfixe SE trop court ou sans le 01 final', () => {
    for (const faux of ['SE55612345', 'SE5561234567', 'SE556123456702', 'SE 1234']) {
      const v = extractCountryEvidence(page(`<p>Ref ${faux}</p>`));
      assert.equal(v.country, null, faux);
    }
  });

  test('un +46 seul ne conclut jamais', () => {
    const v = corroborateCountry(collectCountrySignals(page('<p>Tel +46 31 123 45 67</p>', 'https://exempel.se/kontakt')));
    assert.equal(v.country, null);
  });

  test('« Sverige » seul sur une page d’identité ne conclut pas non plus', () => {
    const v = corroborateCountry(collectCountrySignals(page('<p>Vi finns i Sverige.</p>', 'https://exempel.se/om-oss')));
    assert.equal(v.country, null);
  });

  test('deux signaux faibles concordants s’épaulent : +46 et une mention Sverige', () => {
    // La règle générale du module : deux corroborations distinctes établissent.
    const v = corroborateCountry(collectCountrySignals(page(
      '<p>Nordpack AB, Sverige · Tel +46 31 123 45 67</p>', 'https://exempel.se/kontakt',
    )));
    assert.equal(v.country, 'Suède');
  });

  test('l’extension .se ne compte pas', () => {
    const v = extractCountryEvidence(page('<p>Välkommen</p>', 'https://exempel.se/'));
    assert.equal(v.country, null);
  });

  test('une société allemande citée sur une page suédoise reste allemande', () => {
    const v = extractCountryEvidence(page('<p>Impressum: Verpackung Nord GmbH, Musterstraße 1, 20095 Hamburg, Deutschland. USt-IdNr. DE123456789</p>'));
    assert.equal(v.country, 'Allemagne');
    assert.equal(v.basis, 'OFFICIAL_ID');
  });

  test('« DE » et neuf chiffres sans mot-clé ne prouvent pas l’Allemagne', () => {
    const v = extractCountryEvidence(page('<p>Artikel DE123456789 · Lager Göteborg</p>'));
    assert.equal(v.country, null);
  });

  test('les voisins nordiques sont nommés, jamais confondus avec la Suède', () => {
    for (const [texte, attendu] of [['Vi finns i Norge', 'Norvège'], ['Hovedkontor i Danmark', 'Danemark'], ['Toimipiste Suomi', 'Finlande']] as const) {
      const signaux = collectCountrySignals(page(`<p>${texte}</p>`, 'https://exempel.se/om-oss'));
      assert.ok(signaux.some((s) => s.country === attendu), texte);
      assert.ok(!signaux.some((s) => s.country === 'Suède'), texte);
    }
  });
});

describe('la corroboration par TVA fonctionne enfin', () => {
  /*
   * Régression. Les trois motifs de TVA de corroboration — FR, BE, LU —
   * contenaient un octet 0x08 (retour arrière) là où « \b » était voulu :
   * un patch passé par un shell qui réduit « \\ » en « \ ». Aucun ne pouvait
   * correspondre à une page. Le signal VAT_PREFIX n'a donc jamais existé
   * avant ce test.
   */
  test('un numéro de TVA français produit un signal VAT_PREFIX', () => {
    const signaux = collectCountrySignals(page('<p>TVA intracommunautaire : FR17928914423</p>', 'https://exemple.fr/mentions-legales'));
    assert.ok(signaux.some((s) => s.type === 'VAT_PREFIX' && s.country === 'France'), JSON.stringify(signaux));
  });

  test('un numéro de TVA suédois produit un signal VAT_PREFIX', () => {
    const signaux = collectCountrySignals(page('<p>Momsnr SE556123456701</p>', 'https://exempel.se/om-oss'));
    assert.ok(signaux.some((s) => s.type === 'VAT_PREFIX' && s.country === 'Suède'));
  });
});
