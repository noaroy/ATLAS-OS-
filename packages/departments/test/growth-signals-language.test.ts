import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readsAsSentence } from '../src/growth-signals.ts';

/**
 * `readsAsSentence` decide si une phrase relevee sur un site est de la prose ou
 * une enumeration recopiee d'un menu. Son dernier test cherchait un mot de
 * liaison — mais la liste ne contenait que du francais. Sur un corpus etranger,
 * la fonction mesurait la langue au lieu de la syntaxe, et eliminait en silence
 * tout ce qui n'etait pas roman : aucun site anglais, allemand ou turc ne
 * pouvait produire un seul fait citable.
 */
describe('readsAsSentence sur un corpus multilingue', () => {
  test('accepte une phrase anglaise correcte, depourvue de mot francais', () => {
    // Relevee sur genequsa.com, un distributeur reel ecarte a tort faute de
    // deux faits citables.
    assert.equal(
      readsAsSentence("Our specialists routinely propose money-saving adjustments to customers' orders."),
      true,
    );
  });

  test('accepte une phrase allemande et une phrase turque', () => {
    assert.equal(
      readsAsSentence('Wir vertreten mehrere Hersteller von Verpackungsmaschinen und bieten dazu Kalibrierung an.'),
      true,
    );
    assert.equal(
      readsAsSentence('Ambalaj makineleri ve laboratuvar cihazlari icin bir yetkili temsilcisi olarak calisiyoruz.'),
      true,
    );
  });

  test('continue de rejeter un menu anglais, malgre ses mots de liaison', () => {
    assert.equal(readsAsSentence('About Us Our Products Contact Us Services Solutions Read More'), false);
  });

  test('continue de rejeter une enumeration sans verbe ni liaison', () => {
    assert.equal(readsAsSentence('Centrifuges Gas Detectors Balances Weather Stations Lab Freezers'), false);
  });
});

/**
 * Le decor d'un site n'est pas un fait sur l'entreprise. Ces deux phrases ont
 * ete relevees telles quelles et presentees comme « faits observes » a un
 * prospect payant : c'est ce qui decredibilise une livraison.
 */
describe('le decor du site n\'est jamais un fait', () => {
  test('rejette une banniere cookies collee au nom de la societe', () => {
    assert.equal(
      readsAsSentence('Geneq USA testing instruments - authorized distributor The store will not work correctly when cookies are disabled.'),
      false,
    );
  });

  test('rejette une phrase qui traine un « Saber mas » de menu', () => {
    assert.equal(
      readsAsSentence('Mantenimiento Saber mas Ofrecemos el servicio de mantenimiento para las soluciones completas para el proceso.'),
      false,
    );
  });

  test('rejette la meme phrase accentuee, sous sa forme reelle', () => {
    // La liste de navigation est ecrite sans diacritiques ; la comparaison se
    // faisait avec accents. « Saber mas » passait donc, mais pas « Saber mas »
    // accentue — c'est la forme reelle du site imco.es.
    assert.equal(
      readsAsSentence('Mantenimiento Saber más Ofrecemos el servicio de mantenimiento para las soluciones completas para el proceso.'),
      false,
    );
    assert.equal(
      readsAsSentence('Nos réalisations en menuiserie et agencement pour les particuliers de la region.'),
      false,
    );
  });
});
