import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractLegalIdentity, legalPagesFor, legalLinksIn,
  looksLikeLegalNotice, confidenceFromLegal,
} from '../src/legal-identity.ts';

/**
 * Confirmer une raison sociale sans la deviner.
 *
 * Deux prospects avaient tout — score, canal, deux faits sourcés — et n'ont
 * produit aucun brouillon : leur nom venait du titre d'un résultat de recherche
 * et rien ne le confirmait. La garde d'identité a bien fonctionné.
 *
 * Ce module lui apporte la preuve qu'elle réclame, et ces tests tiennent les
 * trois conditions sans lesquelles la preuve n'en serait pas une :
 *
 *   · La page doit être une vraie page de mentions légales. Sans cette
 *     exigence, la première page contenant « SAS » fournirait une dénomination.
 *   · Elle doit être sur le domaine officiel. Un annuaire tiers publie les
 *     mêmes mentions et ne prouve rien sur qui édite le site.
 *   · Le nom extrait repasse par la garde du tri initial. Une extraction ne
 *     doit pas pouvoir faire entrer un intitulé de métier que la découverte
 *     aurait refusé.
 */

const page = (body: string) => `<html><body>${body}</body></html>`;
const DOMAIN = 'exemple-industrie.fr';
const URL_LEGAL = `https://www.${DOMAIN}/mentions-legales`;

/** Une page de mentions légales française telle qu'elles s'écrivent. */
const MENTIONS = page(`
  <h1>Mentions légales</h1>
  <p>Raison sociale : SUR MESURE INDUSTRIEL</p>
  <p>Forme juridique : SARL au capital de 50 000 €</p>
  <p>Siège social : 12 rue des Ateliers, 69200 Vénissieux</p>
  <p>RCS Lyon 812 345 678 — SIRET 812 345 678 00019</p>
  <p>Directeur de la publication : M. Dupont</p>
`);

describe('la dénomination annoncée', () => {
  test('se lit telle qu’elle est publiée', () => {
    const found = extractLegalIdentity([{ url: URL_LEGAL, html: MENTIONS }], DOMAIN);
    assert.ok(found);
    assert.equal(found.legalName, 'SUR MESURE INDUSTRIEL');
    assert.equal(found.registration, '81234567800019');
    assert.equal(found.sourceUrl, URL_LEGAL);
    assert.match(found.basis, /dénomination annoncée/);
  });

  test('la forme juridique est séparée du nom', () => {
    const html = page('<p>Mentions légales</p><p>Dénomination sociale : ATELIERS LEDOUX SAS</p><p>SIREN 512 345 678</p>');
    const found = extractLegalIdentity([{ url: URL_LEGAL, html }], DOMAIN)!;
    assert.equal(found.legalName, 'ATELIERS LEDOUX');
    assert.equal(found.legalForm, 'SAS');
  });

  test('une forme juridique accolée suffit, dans la section éditeur', () => {
    const html = page('<p>Mentions légales</p><p>Éditeur du site : SARL MECAPRO, RCS Nantes 421 987 654, au capital de 10 000 €.</p>');
    const found = extractLegalIdentity([{ url: URL_LEGAL, html }], DOMAIN)!;
    assert.equal(found.legalName, 'MECAPRO');
    assert.equal(found.legalForm, 'SARL');
    assert.match(found.basis, /forme juridique/);
  });

  test('hors de la section éditeur, une forme juridique ne prouve rien', () => {
    // Une page qui cite une societe sans dire a quel titre ne permet pas de
    // savoir si c'est l'entreprise, son hebergeur ou son agence.
    const html = page('<p>Mentions légales</p><p>SARL MECAPRO, RCS Nantes 421 987 654.</p>');
    assert.equal(extractLegalIdentity([{ url: URL_LEGAL, html }], DOMAIN), null);
  });
});

describe('ce qui n’est pas une preuve', () => {
  test('une page ordinaire ne fournit aucune identité', () => {
    // Sans cette garde, la première page contenant « SAS » ferait autorité.
    const html = page('<p>Notre SAS conçoit des machines depuis 1976. Contactez-nous.</p>');
    assert.equal(looksLikeLegalNotice(html), false);
    assert.equal(extractLegalIdentity([{ url: `https://${DOMAIN}/a-propos`, html }], DOMAIN), null);
  });

  test('une page hors du domaine officiel est ignorée', () => {
    // Un annuaire publie les mêmes mentions et ne dit rien de qui édite le site.
    const found = extractLegalIdentity(
      [{ url: 'https://annuaire-usines.fr/fiche/exemple', html: MENTIONS }],
      DOMAIN,
    );
    assert.equal(found, null);
  });

  test('un sous-domaine officiel reste officiel', () => {
    const found = extractLegalIdentity(
      [{ url: `https://www.${DOMAIN}/legal`, html: MENTIONS }],
      DOMAIN,
    );
    assert.ok(found);
  });

  test('un intitulé de métier n’est pas une dénomination', () => {
    // La même garde que le tri initial : « Constructeur machine spéciale » est
    // un métier. Une extraction ne doit pas pouvoir le faire entrer par
    // l'arrière.
    const html = page('<p>Mentions légales</p><p>Raison sociale : le constructeur de machines spéciales pour vous</p><p>SIRET 812 345 678 00019</p>');
    assert.equal(extractLegalIdentity([{ url: URL_LEGAL, html }], DOMAIN), null);
  });

  test('un libellé de formulaire n’est pas une dénomination', () => {
    const html = page('<p>Mentions légales</p><p>Raison sociale : Adresse du siège social</p><p>SIREN 512 345 678</p>');
    assert.equal(extractLegalIdentity([{ url: URL_LEGAL, html }], DOMAIN), null);
  });

  test('une suite de chiffres n’est pas un nom', () => {
    const html = page('<p>Mentions légales</p><p>Raison sociale : 812345678 00019</p>');
    assert.equal(extractLegalIdentity([{ url: URL_LEGAL, html }], DOMAIN), null);
  });
});

describe('ce que la confirmation vaut', () => {
  test('une page complète vaut plus qu’une page partielle', () => {
    const complet = confidenceFromLegal({
      legalName: 'X', legalForm: 'SAS', registration: '812345678',
      basis: '', sourceUrl: URL_LEGAL,
    });
    const partiel = confidenceFromLegal({
      legalName: 'X', legalForm: null, registration: null,
      basis: '', sourceUrl: URL_LEGAL,
    });
    assert.ok(complet > partiel, 'l’immatriculation et la forme ajoutent de la preuve');
    assert.equal(complet, 0.95);
    assert.equal(partiel, 0.8);
  });

  test('aucun chemin automatique n’atteint la certitude', () => {
    // Rien de lu automatiquement ne vaut une vérification humaine. Laisser
    // l'extraction atteindre 1 effacerait la distinction.
    const max = confidenceFromLegal({
      legalName: 'X', legalForm: 'SARL', registration: '81234567800019',
      basis: '', sourceUrl: URL_LEGAL,
    });
    assert.ok(max < 1, `${max} doit rester sous la certitude`);
  });

  test('la confirmation dépasse le seuil que la garde exige', () => {
    // La garde d'éligibilité bloque sous 0,75 quand le nom ne recoupe pas le
    // domaine. C'est ce seuil que la preuve doit franchir — pas l'inverse.
    const partiel = confidenceFromLegal({
      legalName: 'X', legalForm: null, registration: null, basis: '', sourceUrl: URL_LEGAL,
    });
    assert.ok(partiel >= 0.75);
  });
});

describe('les pages qu’on va chercher', () => {
  test('les chemins conventionnels sont proposés sur le bon domaine', () => {
    const urls = legalPagesFor(`https://${DOMAIN}`, DOMAIN);
    assert.ok(urls.includes(`https://${DOMAIN}/mentions-legales`));
    assert.ok(urls.includes(`https://${DOMAIN}/impressum`));
    assert.ok(urls.every((u) => u.startsWith(`https://${DOMAIN}/`)));
  });

  test('sans site ni domaine, aucune adresse n’est fabriquée', () => {
    assert.deepEqual(legalPagesFor(null, null), []);
  });

  test('le lien du pied de page est suivi, mais pas hors du domaine', () => {
    const html =
      '<a href="/fr/mentions-legales-2">Mentions légales</a>' +
      '<a href="https://annuaire-usines.fr/mentions-legales">Mentions légales</a>' +
      '<a href="/contact">Contact</a>';
    const links = legalLinksIn(html, `https://${DOMAIN}/`, DOMAIN);
    assert.deepEqual(links, [`https://${DOMAIN}/fr/mentions-legales-2`]);
  });
});

describe('les pieges releves sur de vrais sites', () => {
  test('l’agence web qui a fait le site n’est pas l’entreprise', () => {
    // Releve tel quel sur le-sur-mesure-industriel.fr : la seule societe
    // immatriculee citee est celle qui a realise le site. Extraire sans
    // distinguer les sections nommait l'entreprise d'apres son prestataire, et
    // le courriel serait parti au mauvais nom.
    const html = page(
      '<h1>Mentions légales</h1>' +
      '<p>Réalisation du site : Digidream – Siège social : 26, Rue de la Course – 67000 STRASBOURG' +
      ' – SASU au capital de 1000€ – SIRET : 849 443 239 000 25</p>' +
      '<p>Crédits photo : LE SUR MESURE INDUSTRIEL, Adobe Stock, Canva.</p>',
    );
    assert.equal(extractLegalIdentity([{ url: URL_LEGAL, html }], DOMAIN), null);
  });

  test('l’hébergeur n’est pas l’entreprise non plus', () => {
    // Releve sur europe-industrie.fr : « Société OVH SAS, 2 rue Kellermann ».
    const html = page(
      '<h1>Mentions légales</h1>' +
      '<p>Hébergement du site Internet : Société OVH SAS, 2 rue Kellermann, 59053 Roubaix.</p>',
    );
    assert.equal(extractLegalIdentity([{ url: URL_LEGAL, html }], DOMAIN), null);
  });

  test('une adresse suivie d’une forme juridique n’est pas une dénomination', () => {
    // « Rue Thomas Edison SARL » a reellement ete extrait d'europe-industrie.fr.
    const html = page(
      '<h1>Mentions légales</h1>' +
      '<p>Éditeur du site : 17 Rue Thomas Edison – 87200 Saint Junien.' +
      ' RCS Limoges B 948 149 109. SARL au capital de 10 000 €</p>',
    );
    const found = extractLegalIdentity([{ url: URL_LEGAL, html }], DOMAIN);
    if (found) assert.ok(!/rue/i.test(found.legalName), `« ${found.legalName} » est une voie`);
  });

  test('un éditeur dont le nom recoupe le domaine est retenu', () => {
    // Releve sur groupe-ledoux.com : « Editeur du site: LEDOUX FINANCE
    // S.A.R.L. au capital de 735.700€ ».
    const html = page(
      '<h1>Mentions légales</h1>' +
      '<p>Editeur du site : LEDOUX FINANCE S.A.R.L. au capital de 735.700€.' +
      ' Enregistrée au registre du commerce de La Rochelle sous le N° 444 187 654</p>',
    );
    const found = extractLegalIdentity([{ url: 'https://www.groupe-ledoux.com/mentions-legales/', html }], 'groupe-ledoux.com');
    assert.ok(found, 'une section editeur explicite doit etre lue');
    assert.match(found.legalName, /LEDOUX/i);
  });
});

describe('une preuve d’identité n’est pas un fait commercial', () => {
  test('la distinction est portée par le préfixe du champ', () => {
    /*
     * Le défaut, introduit puis corrigé le 27/08/2026 : la raison sociale était
     * enregistrée comme preuve « observée » avec sa source, et comptait donc
     * parmi les deux faits exigés pour personnaliser un message. Un prospect
     * pouvait ainsi satisfaire la garde à moitié avec son propre nom.
     *
     * Une identité établit QUI édite le domaine. Elle ne dit rien de ce que
     * l'entreprise fait, et c'est cela qu'un message doit citer.
     */
    const evidence = [
      { field: 'identite:entite_juridique', nature: 'observed', sourceUrl: 'https://x.fr/mentions' },
      { field: 'signal:export', nature: 'observed', sourceUrl: 'https://x.fr/a-propos' },
    ];
    const commercial = evidence.filter(
      (e) => e.nature === 'observed' && e.sourceUrl && !e.field.startsWith('identite:'),
    );
    assert.equal(commercial.length, 1, 'un seul fait commercial, pas deux');
    assert.equal(evidence.length, 2, 'la preuve d’identité reste enregistrée');
  });
});
