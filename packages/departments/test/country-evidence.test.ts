import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractCountryEvidence, countryFit } from '../src/country-evidence.ts';
import { icpStatus, checkPriorityEligibility } from '../src/company-resolver.ts';
import { ATLAS_SALES_ICP } from '../src/sales-icp.ts';

/**
 * Le pays ne se suppose pas.
 *
 * Le lot écrivait `country: 'France'` sur chaque résultat, parce que la requête
 * était régionalisée en FR. Zhejiang NPC Machinery, fabricant chinois, et
 * Diversitech Equipment & Sales, société canadienne, sont entrés en base comme
 * françaises — et le profil ICP, qui vise France, Belgique et Suisse, ne les a
 * jamais écartées.
 *
 * Deux défauts se couvraient : le pays était faux, et `icpStatus` recevait le
 * champ sans jamais l'ouvrir. Ces tests tiennent les deux bouts.
 */

const page = (html: string, url = 'https://exemple.fr/mentions-legales') => [{ url, html }];

// ─── CE QUI PROUVE ──────────────────────────────────────────────────────────

describe('un pays prouvé est retenu, avec sa source', () => {
  test('société française prouvée par SIRET', () => {
    const v = extractCountryEvidence(page(
      '<p>QG Sécurité — SIRET : 92891442300019 — Villenave d’Ornon</p>',
    ));
    assert.equal(v.country, 'France');
    assert.equal(v.basis, 'OFFICIAL_ID');
    assert.match(v.quote ?? '', /SIRET/);
  });

  test('le libellé réel « SIRET / RCS : » est reconnu', () => {
    /*
     * Relevé mot pour mot sur qg-securite.fr/mentions-legales. Le motif exigeait
     * le numéro juste après le mot-clé ; « / RCS » suffisait à le manquer, et
     * une PME française publiant son immatriculation ressortait sans pays.
     */
    const v = extractCountryEvidence(page(
      '<p>Éditeur du site : QG-Sécurité Adresse : 9 Av. Roger Lapébie, 33140 '
      + 'Villenave-d’Ornon SIRET / RCS : 92891442300019 '
      + 'TVA intracommunautaire : FR17928914423</p>'
      + '<p>Hébergeur du site : OVH SAS Siège social : 2 rue Kellermann, 59100 Roubaix</p>',
    ));
    assert.equal(v.country, 'France');
    assert.equal(v.basis, 'OFFICIAL_ID');
  });

  test('société belge prouvée par son numéro BCE', () => {
    const v = extractCountryEvidence(page('<p>BCE : BE 0123.456.789</p>'));
    assert.equal(v.country, 'Belgique');
    assert.equal(v.basis, 'OFFICIAL_ID');
  });

  test('société suisse prouvée par son IDE', () => {
    const v = extractCountryEvidence(page('<p>CHE-123.456.789 TVA</p>'));
    assert.equal(v.country, 'Suisse');
  });

  test('société canadienne prouvée par son adresse', () => {
    // Le cas réel : diversitech-air.com, page « contact us ».
    const v = extractCountryEvidence(page(
      '<div>Address: 1000 Rue Sherbrooke, Montreal, Quebec, Canada</div>',
      'https://diversitech-air.com/contact-us',
    ));
    assert.equal(v.country, 'Canada');
    assert.equal(v.basis, 'POSTAL_ADDRESS');
  });

  test('société chinoise prouvée par son adresse', () => {
    // Le cas réel : npcinjection.com, Zhejiang NPC Machinery.
    const v = extractCountryEvidence(page(
      '<div>Address: No. 8 Weiwu Road, Ningbo, Zhejiang, China</div>',
      'https://www.npcinjection.com/',
    ));
    assert.equal(v.country, 'Chine');
  });

  test('une métadonnée déclarée suffit', () => {
    const v = extractCountryEvidence(page(
      '<script type="application/ld+json">{"address":{"addressCountry":"BE"}}</script>',
    ));
    assert.equal(v.country, 'Belgique');
    assert.equal(v.basis, 'DECLARED_METADATA');
  });

  test('un identifiant national prime sur une adresse qui dit autre chose', () => {
    const v = extractCountryEvidence(page(
      '<p>SIRET 92891442300019</p><p>Adresse commerciale : Genève, Suisse</p>',
    ));
    assert.equal(v.country, 'France');
    assert.equal(v.basis, 'OFFICIAL_ID');
  });
});

// ─── CE QUI NE PROUVE RIEN ──────────────────────────────────────────────────

describe('rien ne remplace une preuve', () => {
  test('pays absent donne UNKNOWN, jamais France', () => {
    const v = extractCountryEvidence(page('<p>Nous fabriquons des machines.</p>'));
    assert.equal(v.country, null);
    assert.equal(v.basis, 'NONE');
  });

  test('une extension .fr ne suffit pas', () => {
    /*
     * Un domaine `.fr` s'achète depuis n'importe où, et rien n'oblige son
     * titulaire à être établi en France.
     */
    const v = extractCountryEvidence(page(
      '<p>Bienvenue chez nous.</p>', 'https://fabricant-machines.fr/',
    ));
    assert.equal(v.country, null);
  });

  test('la langue française ne suffit pas', () => {
    // Le cas exact de NPC : un fabricant chinois traduit son site.
    const v = extractCountryEvidence(page(
      '<html lang="fr"><p>Fabricant de machines de moulage par injection. '
      + 'Nous recherchons des distributeurs.</p></html>',
      'https://www.npcinjection.com/fr/',
    ));
    assert.equal(v.country, null);
  });

  test('aucune page ne donne aucun pays', () => {
    assert.equal(extractCountryEvidence([]).country, null);
  });

  test('un pays cité hors d’un bloc d’adresse ne compte pas', () => {
    const v = extractCountryEvidence(page(
      '<p>Nos clients sont en Allemagne et en Italie depuis 1998.</p>',
    ));
    assert.equal(v.country, null);
  });

  test('l’adresse de l’hébergeur n’est pas celle de l’entreprise', () => {
    /*
     * Relevé sur qg-securite.fr : la première adresse complète des mentions
     * légales était celle d'OVH — « rue Kellermann, 59100 Roubaix ». La
     * conclusion « France » était juste par accident. Une PME française
     * hébergée en Allemagne aurait reçu « Allemagne ».
     */
    const v = extractCountryEvidence(page(
      '<p>Hébergeur : OVH, 2 rue Kellermann, 59100 Roubaix, France</p>',
      'https://exemple.de/mentions-legales',
    ));
    assert.equal(v.country, null, 'l’adresse de l’hébergeur ne doit rien prouver');
  });

  test('l’adresse de l’éditeur compte, celle de l’hébergeur non', () => {
    const v = extractCountryEvidence(page(
      '<p>Hébergeur : OVH, 2 rue Kellermann, 59100 Roubaix, France</p>'
      + '<p>Éditeur : siège social 12 avenue du Parc, 1050 Bruxelles, Belgique</p>',
    ));
    assert.equal(v.country, 'Belgique');
  });

  test('« machine » ne contient pas la Chine, « industrie » pas l’Inde', () => {
    // Sans bornes de mot, ces deux-là se déclenchaient sur des pages
    // parfaitement françaises — c'est le vocabulaire du secteur visé.
    const v = extractCountryEvidence(page(
      '<p>Adresse : 4 rue des Machines, zone industrielle de Vitry</p>',
    ));
    assert.notEqual(v.country, 'Chine');
    assert.notEqual(v.country, 'Inde');
  });
});

// ─── PLUSIEURS PAYS ─────────────────────────────────────────────────────────

describe('plusieurs pays ne se tranchent pas au hasard', () => {
  test('une liste de sites de production ne désigne pas un siège', () => {
    /*
     * Getinge nomme neuf pays de production sur sa page « devenir
     * distributeur ». En retenir un serait tirer au sort.
     */
    const v = extractCountryEvidence(page(
      '<p>Adresse : sites de production en France, Chine, Allemagne, Pologne, Suède.</p>',
      'https://www.getinge.com/fr/contact/autres/devenir-distributeur/',
    ));
    assert.equal(v.country, null);
    assert.match(v.reason, /plusieurs pays|aucune adresse/);
  });

  test('deux identifiants nationaux contradictoires annulent', () => {
    const v = extractCountryEvidence([
      { url: 'https://x.fr/a', html: '<p>SIRET 92891442300019</p>' },
      { url: 'https://x.fr/b', html: '<p>CHE-123.456.789</p>' },
    ]);
    assert.equal(v.country, null);
    assert.deepEqual(v.candidates.sort(), ['France', 'Suisse']);
  });
});

// ─── LE PROFIL ──────────────────────────────────────────────────────────────

describe('le profil traite UNKNOWN comme une vérification, pas comme la France', () => {
  const pays = ATLAS_SALES_ICP.countries;

  test('les trois pays du profil entrent', () => {
    for (const p of ['France', 'Belgique', 'Suisse']) {
      assert.equal(countryFit(p, pays).fit, 'IN_SCOPE', p);
    }
  });

  test('Canada et Chine sortent', () => {
    assert.equal(countryFit('Canada', pays).fit, 'OUT_OF_SCOPE');
    assert.equal(countryFit('Chine', pays).fit, 'OUT_OF_SCOPE');
  });

  test('null, vide et UNKNOWN demandent une vérification', () => {
    for (const p of [null, undefined, '', '  ', 'UNKNOWN']) {
      assert.equal(countryFit(p, pays).fit, 'NEEDS_VERIFICATION', String(p));
    }
  });

  test('aucune valeur ne retombe silencieusement sur la France', () => {
    // La régression exacte : `null` valait France, et personne ne le voyait.
    assert.notEqual(countryFit(null, pays).fit, 'IN_SCOPE');
  });
});

// ─── LE FILTRE ICP, QUI LISAIT ENFIN LE PAYS ────────────────────────────────

describe('icpStatus consulte le pays avant le métier', () => {
  const fabricant = { companyName: 'Machines Untel', industry: 'fabricant de machines' };

  test('un fabricant français entre', () => {
    assert.equal(icpStatus({ ...fabricant, country: 'France' }).status, 'MATCH');
  });

  test('le même fabricant, chinois, sort', () => {
    /*
     * Le faux positif d'origine. Un fabricant chinois EST un fabricant : le
     * reconnaître comme tel avant de regarder où il se trouve donnait
     * exactement le résultat qu'on cherche à supprimer.
     */
    const v = icpStatus({ ...fabricant, country: 'Chine' });
    assert.equal(v.status, 'OUT_OF_ICP');
    assert.match(v.reason, /Chine/);
  });

  test('le même fabricant, canadien, sort', () => {
    assert.equal(icpStatus({ ...fabricant, country: 'Canada' }).status, 'OUT_OF_ICP');
  });

  test('sans pays, la découverte laisse passer — elle ne peut pas savoir', () => {
    /*
     * Le tri ICP s'exécute sur un titre et un extrait, avant toute lecture de
     * page : aucun pays ne peut y être établi. Refuser tout candidat sans pays
     * n'en retiendrait aucun. La première version de cette garde faisait
     * exactement cela, et douze tests d'intégration l'ont dit.
     *
     * L'exigence de pays vit une étape plus loin, dans
     * `checkPriorityEligibility`, quand les pages ont été lues.
     */
    assert.equal(icpStatus({ ...fabricant, country: null }).status, 'MATCH');
  });

  test('le pays tranche avant le métier, dans les deux sens', () => {
    // Une agence de communication française reste hors profil pour son métier.
    assert.equal(
      icpStatus({ companyName: 'Agence de communication Untel', country: 'France' }).status,
      'OUT_OF_ICP',
    );
    // Et un pays hors profil sort quel que soit le métier.
    assert.equal(
      icpStatus({ companyName: 'Agence de communication Untel', country: 'Chine' }).status,
      'OUT_OF_ICP',
    );
  });

  test('le profil accepté peut être passé explicitement', () => {
    assert.equal(
      icpStatus({ ...fabricant, country: 'Canada', acceptedCountries: ['Canada'] }).status,
      'MATCH',
    );
  });
});

// ─── LA GARDE, LÀ OÙ LE PAYS EST CONNAISSABLE ───────────────────────────────

describe('aucun brouillon pour une entreprise non localisée', () => {
  const base = {
    identity: {
      companyName: 'QG Sécurité',
      canonicalDomain: 'qg-securite.fr',
      officialWebsite: 'https://qg-securite.fr',
      country: null,
      identityConfidence: 0.9,
      identitySources: ['mentions legales'],
    },
    pageType: 'OFFICIAL_COMPANY_SITE' as const,
    icp: 'MATCH' as const,
    observedFacts: 3,
    score: 72,
    scoreThreshold: 70,
    hasSourcedPersonalization: true,
  };

  test('un pays prouvé et dans le profil rend éligible', () => {
    assert.equal(checkPriorityEligibility({ ...base, country: 'France' }).eligible, true);
  });

  test('un pays prouvé hors profil bloque', () => {
    const v = checkPriorityEligibility({ ...base, country: 'Chine' });
    assert.equal(v.eligible, false);
    assert.match(v.blockers.join(' '), /Chine/);
  });

  test('un pays non établi bloque, après enrichissement', () => {
    /*
     * Ici les pages ont été lues. Si aucune ne publie d'adresse, d'identifiant
     * national ni de métadonnée, l'entreprise reste non localisée — et on ne
     * démarche pas une entreprise dont on ignore le pays quand le profil en
     * nomme trois.
     */
    const v = checkPriorityEligibility({ ...base, country: null });
    assert.equal(v.eligible, false);
    assert.match(v.blockers.join(' '), /pays non établi/);
  });

  test('aucun défaut France ne rend éligible en silence', () => {
    // La régression exacte : `country` absent valait France, et le dossier
    // passait sans que rien ne le signale.
    assert.equal(checkPriorityEligibility({ ...base }).eligible, false);
  });
});
