import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseSourceRef, prepareEvidence } from '../src/evidence.ts';

/**
 * Deux corrections déterministes, mesurées sur VAL-003.
 *
 * Aucune des deux n'appelle le modèle : ce sont des règles de forme, elles
 * doivent être vérifiables sans dépense et sans jugement. Une déduplication
 * sémantique aurait coûté un appel par comparaison et rendu un verdict
 * inauditable ; ce n'est pas le compromis retenu.
 */

describe('normalisation des références de source', () => {
  test('un domaine nu devient une adresse', () => {
    assert.equal(normaliseSourceRef('bhs-world.com'), 'https://bhs-world.com');
    assert.equal(normaliseSourceRef('  bhs-world.com  '), 'https://bhs-world.com');
    assert.equal(normaliseSourceRef('www.bhs-world.com/about'), 'https://www.bhs-world.com/about');
    assert.equal(normaliseSourceRef('maschinenbau-mueller.de'), 'https://maschinenbau-mueller.de');
  });

  test('une adresse déjà formée n’est pas touchée', () => {
    for (const ref of [
      'https://bhs-world.com',
      'http://bhs-world.com',
      'mailto:kontakt@bhs-world.com',
      'tel:+4930123456',
    ]) {
      assert.equal(normaliseSourceRef(ref), ref);
    }
  });

  test('ce qui n’est pas un domaine est rendu tel quel', () => {
    // Le risque de cette correction est de fabriquer une adresse à partir d'une
    // phrase : une source inventée est pire qu'une source mal formée.
    for (const notADomain of [
      'Industrie 4.0',
      'page produits du site',
      'v1.2',
      'entretien téléphonique du 12 mars',
      '192.168.1.1',
      'fichier.pdf transmis par le client',
      '-mauvais-.com',
      'sanspoint',
    ]) {
      assert.equal(
        normaliseSourceRef(notADomain),
        notADomain.trim(),
        `« ${notADomain} » ne doit pas être transformé en adresse`,
      );
    }
  });

  test('les suffixes réservés ne deviennent jamais une adresse', () => {
    // RFC 2606 : ces suffixes existent pour ne jamais être résolus. Leur
    // ajouter un protocole donnerait à une source injoignable l'apparence
    // d'une source vérifiable.
    for (const reserved of [
      'acme.example',
      'serveur.local',
      'machine.internal',
      'quelquechose.invalid',
      'monsite.test',
    ]) {
      assert.equal(normaliseSourceRef(reserved), reserved);
    }
  });

  test('la normalisation traverse la préparation d’une preuve', () => {
    const prepared = prepareEvidence(
      {
        field: 'existence',
        claim: 'BHS Corrugated distribue des machines de production de carton ondulé.',
        nature: 'reported',
        sourceRef: 'bhs-world.com/unternehmen',
      },
      { simulated: false },
    );
    assert.equal(prepared.sourceRef, 'https://bhs-world.com/unternehmen');
  });
});

describe('normalisation typographique des affirmations', () => {
  test('les espaces sont unifiés, le texte ne l’est pas', () => {
    const prepared = prepareEvidence(
      {
        field: 'sector',
        claim: '  Distributeur   de machines\n  d’emballage.  ',
        nature: 'reported',
        sourceRef: 'https://exemple-reel.de',
      },
      { simulated: false },
    );
    assert.equal(prepared.claim, 'Distributeur de machines d’emballage.');
  });

  test('deux formulations différentes restent deux affirmations', () => {
    // La frontière de cette correction : elle unifie la mise en forme, elle ne
    // juge pas le sens. Rapprocher ces deux phrases demanderait de les
    // comprendre — donc un appel au modèle, donc une dépense, pour un verdict
    // qu'on ne pourrait pas rejouer.
    const a = prepareEvidence(
      {
        field: 'sector',
        claim: 'Distribue des machines d’emballage.',
        nature: 'reported',
        sourceRef: 'https://exemple-reel.de',
      },
      { simulated: false },
    );
    const b = prepareEvidence(
      {
        field: 'sector',
        claim: 'Vend des machines de conditionnement.',
        nature: 'reported',
        sourceRef: 'https://exemple-reel.de',
      },
      { simulated: false },
    );
    assert.notEqual(a.claim, b.claim);
  });
});
