import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOutreachDraft, isCommercialEvidence, outreachFactFrom, personalizationIsGrounded,
  type StoredEvidence, type OutreachContact,
} from '../src/outreach.ts';
import { checkHumanization } from '../src/humanization.ts';
import { classifyActionChannel, isVerifiedFormUrl } from '../src/action-channel.ts';
import { INTERPRETATION_PREFIX } from '../src/verbatim-selection.ts';

/**
 * Trois dossiers réels, rejoués à blanc avec leurs preuves telles qu'elles
 * sont en base — citations et interprétations copiées mot pour mot.
 *
 * K2TEC et Harmony Béton ont été contactés le 8 septembre. Leurs messages ne
 * bougent pas et rien n'est renvoyé : on vérifie seulement que ce qu'ils ont
 * lu sur eux-mêmes reste vrai sous la règle nouvelle. ASYTEC, lui, avait
 * reçu du modèle une affirmation que sa page ne fait pas.
 *
 * Aucun appel modèle ici : tout est déterministe, et c'est le point.
 */

const v = (id: string, claim: string, interpretation: string, sourceUrl: string): StoredEvidence => ({
  id, field: `verbatim:${id}`, claim, sourceUrl, nature: 'observed',
  basis: `${INTERPRETATION_PREFIX}${interpretation}`,
});
const ancien = (id: string, field: string, claim: string, sourceUrl: string): StoredEvidence => ({
  id, field, claim, sourceUrl, nature: 'observed', basis: null,
});

const composer = (company: string, evidence: StoredEvidence[], contact: OutreachContact | null) =>
  buildOutreachDraft({
    company, website: null,
    facts: evidence.filter(isCommercialEvidence).map(outreachFactFrom),
    contact, whyThisCompany: '', senderName: 'Noa Roy',
    offer: { priceEur: 49, deliveryHours: 24 },
  });

const passe = (body: string, channel: 'EMAIL' | 'FORM') => {
  const r = checkHumanization({ body, kind: 'FIRST_TOUCH', channel });
  assert.equal(r.verdict, 'PASS', [...r.blockers, ...r.remarks].join(' · '));
};

describe('K2TEC — reste PASS', () => {
  const site = 'https://www.k2tec.com/fr/';
  const preuves: StoredEvidence[] = [
    ancien('a1', 'Modèle commercial', 'Conception de machines filtrantes standards, customisées ou spéciales', site),
    ancien('a2', 'Distribution', "Mention de 'Distributeurs' sur le site", site),
    v('1', 'K2TEC - Solutions de filtration industrielle liquide sur mesure', 'K2TEC propose des solutions de filtration industrielle liquide sur mesure.', site),
    v('26', 'A l’origine, K2TEC est d’abord spécialisé dans la fabrication de filtres pour les applications complexes telles que la haute et très haute viscosité. Nous avons lancé en 2005 le filtre automatique autonettoyant à racleur en inox.', 'K2TEC fabrique des filtres pour applications complexes à haute viscosité.', site),
    v('33', "Découvrez les solutions de filtration K2TEC pour l'industrie automobile.", "K2TEC fournit des solutions de filtration pour l'industrie automobile.", site),
    v('6', 'Nous sommes à la recherche de distributeurs !', 'K2TEC recherche des distributeurs.', 'https://www.k2tec.com/fr/contact/'),
  ];
  const contact: OutreachContact = {
    name: 'Pascal Sartori', role: 'Dirigeant', email: 'contact@k2tec.com', phone: null,
    contactPage: null, sourceUrl: 'https://www.k2tec.com/fr/contact/', confidence: 0.9, named: true,
  };

  test('le message dit exactement ce que la page contact publie', () => {
    const s = composer('K2TEC', preuves, contact);
    assert.ok(s.draft, s.reason);
    assert.equal(s.draft.evidenceExcerpt, 'Nous sommes à la recherche de distributeurs');
    assert.match(s.draft.messageEmail, /^Bonjour,\n\nJ'ai vu sur votre page contact que vous indiquez être à la recherche de distributeurs\./);
    assert.equal(s.draft.subject, 'Recherche de distributeurs');
    assert.equal(personalizationIsGrounded(s.draft), true);
    passe(s.draft.messageEmail, 'EMAIL');
  });

  test('l’ancienne reformulation « Mention de Distributeurs » ne parle jamais au client', () => {
    const s = composer('K2TEC', preuves, contact);
    assert.doesNotMatch(s.draft!.messageEmail, /Mention de/);
  });
});

describe('Harmony Béton — reste PASS', () => {
  const site = 'https://www.harmony-beton.com/fr/';
  const distributeurs = 'https://www.harmony-beton.com/fr/content/15-devenir-distributeur';
  const preuves: StoredEvidence[] = [
    ancien('a1', 'stratégie_commerciale', 'Page dédiée « Devenir distributeur » avec option de distribution sous marque propre', distributeurs),
    ancien('a2', 'position_marche', 'Entreprise industrielle avec usines de production certifiées', distributeurs),
    v('5', 'Harmony Béton est né de la volonté de rendre le béton décoratif accessible à tous, particuliers comme professionnels de la sphère btp. Fabricant et distributeur de béton décoratif, notre métier depuis plus de 20 ans est de vous conseiller.', 'Harmony Béton est fabricant et distributeur de béton décoratif depuis plus de 20 ans.', site),
    v('6', 'Notre savoir-faire, notre totale maîtrise de la chaîne de valeur ainsi que notre qualité de service nous a permis de nous imposer comme leader du béton ciré en France et à l’international.', "Harmony Béton est leader du béton ciré en France et à l'international.", site),
    v('2', 'Vous êtes un magasin de revêtement de sol , de peinture , marchand de matériaux et vous souhaitez compléter votre gamme en commercialisant du béton décoratif.', 'Harmony Béton cherche des distributeurs parmi les magasins de revêtement de sol, de peinture et marchands de matériaux.', distributeurs),
    v('3', 'Nous vous proposons soit une distribution exclusive de nos produits soit de créer votre gamme afin que vous puissiez la distribuer sous votre nom (MDD).', 'Harmony Béton propose une distribution exclusive de ses produits ou une création de gamme MDD aux distributeurs.', distributeurs),
  ];
  const contact: OutreachContact = {
    name: null, role: null, email: 'contact@harmony-beton.com', phone: null,
    contactPage: null, sourceUrl: distributeurs, confidence: 0.8, named: false,
  };

  test('le message cite la page distributeurs, mot pour mot', () => {
    const s = composer('Harmony Béton', preuves, contact);
    assert.ok(s.draft, s.reason);
    assert.equal(s.draft.sourceUsedForPersonalization, distributeurs);
    // L'espace avant la virgule est retiré ; aucun mot ne change.
    assert.equal(s.draft.evidenceExcerpt, 'Vous êtes un magasin de revêtement de sol, de peinture, marchand de matériaux et vous souhaitez compléter votre gamme en commercialisant du béton décoratif');
    assert.match(s.draft.messageEmail, /^Bonjour,\n\nJ'ai vu sur votre page distributeurs que vous écrivez « Vous êtes un magasin/);
    assert.equal(personalizationIsGrounded(s.draft), true);
    passe(s.draft.messageEmail, 'EMAIL');
  });

  test('« Page dédiée » — une description du modèle — ne parle jamais au client', () => {
    // Elle gagne le classement (« Devenir distributeur » est un signal d'achat)
    // mais n'a jamais été relue à sa source : une reformulation.
    const s = composer('Harmony Béton', preuves, contact);
    assert.doesNotMatch(s.draft!.messageEmail, /Page dédiée/);
  });

  test('l’objet et la question s’appuient sur la page « devenir distributeur »', () => {
    const s = composer('Harmony Béton', preuves, contact);
    assert.equal(s.draft!.subject, 'Recherche de distributeurs');
    assert.match(s.draft!.messageEmail, /distributeurs spécialisés ou plus généralistes \?/);
  });
});

describe('ASYTEC — le modèle affirmait ce que la page ne dit pas', () => {
  const site = 'https://asytec.fr/';
  const preuves: StoredEvidence[] = [
    ancien('a1', 'Modèle commercial', 'Asytec propose du sous-traitance industrielle low-cost avec accompagnement complet (de A à Z)', site),
    ancien('a2', 'Cible client', "Asytec s'adresse à des entreprises cherchant un sous-traitant industriel", site),
    v('3', 'INJECTION PLASTIQUE SOUS-TRAITANCE MÉTAL', "ASYTEC propose des services d'injection plastique et de sous-traitance métal.", site),
    v('5', 'Asytec fabricant industriel français disposant de sa propre usine de production en Chine et proposant une solution de sous-traitance industrielle COMPÉTITIVE et SÉCURISÉE.', "ASYTEC est un fabricant industriel français disposant d'une usine de production en Chine.", site),
    v('6', 'ASYTEC dispose de son propre atelier de moulage pour l’injection plastique et d\'un atelier de tôlerie industrielle en Chine', "ASYTEC dispose d'un atelier de moulage pour injection plastique et d'un atelier de tôlerie industrielle en Chine.", site),
    v('12', 'Spécialistes de la transformation des plastiques, nous assurons le moulage par injection plastique en Chine de vos pièces ainsi que la réalisation de vos moules d’injection et outillages de plasturgie.', "ASYTEC réalise le moulage par injection plastique de pièces et la fabrication de moules d'injection.", site),
    v('13', 'L’atelier de tôlerie industrielle est notre second pôle de compétences. Nous réalisons vos pièces métal en découpe et emboutissage , vos pièces aluminium de fonderie, vos pièces métal en usinage et leurs parachèvements.', 'ASYTEC réalise des pièces métal en découpe et emboutissage, pièces aluminium de fonderie.', site),
    v('14', 'L’usine de production intègre le montage et la fabrication OEM complète de produits. Depuis l’industrialisation jusqu’à l’intégration finale nous maitrisons la fabrication des sous-ensembles techniques et leurs conditionnements.', 'ASYTEC intègre le montage et la fabrication OEM complète de produits avec conditionnement.', site),
    v('15', "La Soudure TIG sur Inox La soudure TIG sur inox, alliée à l'automatisation, incarne l'apogée de la technique dans la production des capots de véhicules. Cette méthode, caractérisée par un arc électrique contrôlé, un gaz inerte et une électrode en tungstène, offre une qualité de soudure exceptionnelle.", 'ASYTEC produit des capots de véhicules par soudure TIG sur inox.', site),
    v('2', 'Conditionnement et logistique internationale', 'ASYTEC propose des services de conditionnement et logistique internationale.', site),
  ];
  const contact: OutreachContact = {
    name: null, role: null, email: null, phone: null,
    contactPage: 'https://asytec.fr/', sourceUrl: 'https://asytec.fr/', confidence: 0.7, named: false,
  };

  test('« ASYTEC produit des capots de véhicules » est rejeté, et un fait sûr est retenu', () => {
    const s = composer('ASYTEC', preuves, contact);
    assert.ok(s.draft, s.reason);
    assert.doesNotMatch(s.draft.messageEmail, /capots/);
    assert.doesNotMatch(s.draft.messageEmail, /cherchant un sous-traitant/);
    assert.notEqual(s.draft.personalizationFact.evidenceId, '15');
    assert.ok(s.draft.personalizationFact.claim.includes(s.draft.evidenceExcerpt));
    assert.equal(personalizationIsGrounded(s.draft), true);
    passe(s.draft.messageEmail, 'EMAIL');
    passe(s.draft.messageShort, 'FORM');
  });

  test('ni l’objet ni la question n’inventent une recherche de distributeurs', () => {
    const s = composer('ASYTEC', preuves, contact);
    assert.doesNotMatch(s.draft!.subject, /Recherche de/);
    assert.doesNotMatch(s.draft!.messageEmail, /Vous cherchez surtout/);
  });

  test('sans adresse, ASYTEC ne devient jamais un destinataire courriel', () => {
    const verdict = classifyActionChannel({
      email: null, phone: null, formUrl: 'https://asytec.fr/', recordedMethod: 'FORM', observed: true,
    });
    assert.notEqual(verdict.channel, 'EMAIL');
  });

  test('la racine du site n’est pas un formulaire observé : aucun canal écrit vérifié', () => {
    assert.equal(isVerifiedFormUrl('https://asytec.fr/'), false);
    assert.equal(isVerifiedFormUrl('https://asytec.fr'), false);
    assert.equal(isVerifiedFormUrl('https://asytec.fr/contact/'), true);
    assert.equal(isVerifiedFormUrl('https://www.k2tec.com/fr/contact/'), true);

    const verdict = classifyActionChannel({
      email: null, phone: null, formUrl: 'https://asytec.fr/', recordedMethod: 'FORM', observed: true,
    });
    assert.equal(verdict.channel, 'UNAVAILABLE');
    assert.equal(verdict.target, null);
  });
});
