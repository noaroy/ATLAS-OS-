import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyClaimAgainstSource, decodeEntities, readableText,
} from '../src/claim-verification.ts';
import { canonicalUrl } from '../src/action-channel.ts';

/**
 * Une phrase annoncée comme publiée sur un site doit s'y trouver.
 *
 * Le message écrit « j'ai relevé ceci, publié sur votre site : … ». C'est
 * l'argument central de l'offre — chaque affirmation est vérifiable d'un clic.
 * Une seule qui ne l'est pas rend tout le reste douteux, et le destinataire qui
 * ouvre la source le voit en dix secondes.
 *
 * Le défaut relevé sur Fujielectric : « Intégrateur d'automatisme industriel
 * avec solutions IOT et maintenance prédictive » était enregistré comme
 * `observed` avec une adresse source. C'est un résumé de modèle. Introuvable
 * tel quel sur la page.
 */

describe('une citation se retrouve dans sa source', () => {
  const page = 'Nous accompagnons depuis 1976 des industriels à l’international, '
    + 'avec une équipe de quarante-deux personnes basée à Lyon. Notre atelier '
    + 'est équipé d’une découpe laser.';

  test('une phrase réellement présente passe', () => {
    const v = verifyClaimAgainstSource(
      'Nous accompagnons depuis 1976 des industriels à l’international', page,
    );
    assert.equal(v.verifiable, true);
    assert.equal(v.overlap, 1);
  });

  test('une paraphrase de modèle est rejetée', () => {
    // Le cas exact : juste, peut-être ; introuvable, sûrement.
    const v = verifyClaimAgainstSource(
      'Intégrateur d’automatisme industriel avec solutions IOT et maintenance prédictive',
      page,
    );
    assert.equal(v.verifiable, false);
    assert.match(v.reason, /reformulation/);
  });

  test('la ponctuation et la casse ne comptent pas', () => {
    const v = verifyClaimAgainstSource(
      '« NOUS ACCOMPAGNONS, DEPUIS 1976, DES INDUSTRIELS… »', page,
    );
    assert.equal(v.verifiable, true);
  });

  test('les accents ne comptent pas non plus', () => {
    const v = verifyClaimAgainstSource(
      'une equipe de quarante-deux personnes basee a Lyon', page,
    );
    assert.equal(v.verifiable, true);
  });

  test('une source vide ne valide jamais', () => {
    assert.equal(verifyClaimAgainstSource('une phrase quelconque', '').verifiable, false);
  });

  test('une citation sans mot porteur ne valide pas', () => {
    assert.equal(verifyClaimAgainstSource('de la et le', page).verifiable, false);
  });
});

describe('les entités HTML sont décodées avant comparaison', () => {
  test('la forme échappée d’une vraie page est reconnue', () => {
    // Relevé tel quel sur europe-industrie.fr : le texte utile est encodé.
    const html = '<p>Fabricant&#x20;de&#x20;machines&#x20;pour&#x20;l&#x2019;industrie&#x20;du&#x20;bois.</p>';
    const texte = readableText(html);
    assert.match(texte, /Fabricant de machines pour l’industrie du bois/);

    const v = verifyClaimAgainstSource('Fabricant de machines pour l’industrie du bois', texte);
    assert.equal(v.verifiable, true, 'sans décodage, cette citation exacte serait rejetée');
  });

  test('les entités nommées et numériques passent toutes les deux', () => {
    assert.equal(decodeEntities('caf&eacute; &amp; th&#233;'), 'café & thé');
    assert.equal(decodeEntities('l&rsquo;atelier'), "l'atelier");
  });
});

describe('les adresses citées sont nettoyées de leur suivi', () => {
  test('le paramètre de suivi de Fujielectric disparaît', () => {
    assert.equal(
      canonicalUrl('https://www.fujielectric.fr/services-et-solutions/integrateur-automatisme-industriel/?srsltid=AfmBOoqTIzwHmPR3qVWa-2Iz'),
      'https://www.fujielectric.fr/services-et-solutions/integrateur-automatisme-industriel/',
    );
  });

  test('utm, gclid et fbclid aussi', () => {
    assert.equal(
      canonicalUrl('https://x.fr/a?utm_source=google&utm_medium=cpc&gclid=abc&fbclid=def'),
      'https://x.fr/a',
    );
  });

  test('un paramètre fonctionnel n’est jamais retiré', () => {
    // Les enlever casserait le lien, ce qui est pire qu'un paramètre laid.
    assert.equal(canonicalUrl('https://x.fr/p?id=42&lang=fr'), 'https://x.fr/p?id=42&lang=fr');
    assert.equal(
      canonicalUrl('https://x.fr/p?id=42&utm_source=google'),
      'https://x.fr/p?id=42',
    );
  });

  test('une adresse illisible est rendue telle quelle', () => {
    assert.equal(canonicalUrl('pas-une-url'), 'pas-une-url');
    assert.equal(canonicalUrl(null), null);
  });
});
