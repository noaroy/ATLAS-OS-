import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkHumanization, greetingFor, addressMatchesPerson } from '../src/humanization.ts';

/**
 * Un message doit se lire comme écrit par quelqu'un qui a regardé l'entreprise.
 *
 * La règle complète vit dans `docs/SALES_HUMANIZATION_POLICY.md`. Ces tests
 * tiennent la partie vérifiable — et surtout la retenue du contrôle : il
 * n'arrête que ce qui se lit franchement comme une machine. Une garde qui
 * bloque sur un détail de style devient un obstacle qu'on contourne.
 */

const SIGNATURE = '\n\nBien à vous,\nNoa Roy';

const BON = 'Bonjour,\n\n'
  + 'J’ai vu sur votre page distributeurs que vous cherchez actuellement des '
  + 'revendeurs pour vos bétons décoratifs, y compris sous marque propre.\n\n'
  + 'Je recherche des partenaires commerciaux pour des fabricants comme vous : '
  + 'j’identifie des entreprises correspondant précisément à votre cible et je '
  + 'vérifie chacune une par une avant de vous la proposer.\n\n'
  + 'Je peux vous préparer gratuitement trois entreprises correspondant à votre '
  + 'cible, pour que vous voyiez si le résultat est pertinent.\n\n'
  + 'Vous cherchez plutôt des distributeurs en France ou à l’étranger ?'
  + SIGNATURE;

describe('ce qui se lit comme une machine est arrêté', () => {
  test('une formule de gabarit bloque', () => {
    const v = checkHumanization({
      body: 'Bonjour,\n\nJe me permets de vous contacter afin de vous présenter mes services.' + SIGNATURE,
      kind: 'FIRST_TOUCH',
    });
    assert.equal(v.verdict, 'BLOCKED');
    assert.match(v.blockers.join(' '), /je me permets/i);
  });

  test('parler de l’outil bloque', () => {
    /*
     * Le prospect achète un résultat, pas une architecture. Lire « grâce à
     * l'intelligence artificielle » suffit à comprendre qu'on parle à une
     * machine.
     */
    for (const phrase of [
      'Grâce à l’intelligence artificielle, j’identifie vos futurs clients.',
      'Notre algorithme de scoring analyse votre marché.',
      'Notre plateforme analyse des milliers d’entreprises.',
    ]) {
      const v = checkHumanization({ body: `Bonjour,\n\n${phrase}` + SIGNATURE, kind: 'FIRST_TOUCH' });
      assert.equal(v.verdict, 'BLOCKED', phrase);
    }
  });

  test('un emoji bloque', () => {
    const v = checkHumanization({ body: 'Bonjour,\n\nJ’ai vu votre site 🚀' + SIGNATURE, kind: 'FIRST_TOUCH' });
    assert.equal(v.verdict, 'BLOCKED');
  });

  test('une ouverture centrée sur nous bloque', () => {
    // Le test le plus utile : les deux premières lignes doivent parler d'eux.
    const v = checkHumanization({
      body: 'Bonjour,\n\nJe réalise des études de prospection B2B pour des industriels.' + SIGNATURE,
      kind: 'FIRST_TOUCH',
    });
    assert.equal(v.verdict, 'BLOCKED');
    assert.match(v.blockers.join(' '), /ouverture parle de nous/);
  });

  test('une relance qui recopie le premier message bloque', () => {
    const premier = 'Bonjour,\n\nJ’ai vu que vous cherchez des distributeurs pour vos produits en France.' + SIGNATURE;
    const v = checkHumanization({
      body: 'Bonjour,\n\nJ’ai vu que vous cherchez des distributeurs pour vos produits en France.\n\nUne actualité ?' + SIGNATURE,
      kind: 'FOLLOW_UP',
      previousMessages: [premier],
    });
    assert.equal(v.verdict, 'BLOCKED');
    assert.match(v.blockers.join(' '), /mot pour mot/);
  });
});

describe('un vrai message passe', () => {
  test('le message de référence est PASS', () => {
    const v = checkHumanization({ body: BON, kind: 'FIRST_TOUCH' });
    assert.equal(v.verdict, 'PASS', [...v.blockers, ...v.remarks].join(' · '));
  });

  test('la signature ne compte pas dans la longueur', () => {
    const sans = checkHumanization({ body: BON.replace(SIGNATURE, ''), kind: 'FIRST_TOUCH' });
    const avec = checkHumanization({ body: BON, kind: 'FIRST_TOUCH' });
    assert.equal(sans.wordCount, avec.wordCount);
  });

  test('une relance courte et différente passe', () => {
    const v = checkHumanization({
      body: 'Bonjour,\n\nJe reviens simplement vers vous concernant les quelques '
        + 'distributeurs que je vous proposais de rechercher.\n\n'
        + 'Est-ce un sujet que vous souhaitez développer en ce moment ?' + SIGNATURE,
      kind: 'FOLLOW_UP',
      previousMessages: [BON],
    });
    assert.equal(v.verdict, 'PASS', [...v.blockers, ...v.remarks].join(' · '));
  });
});

describe('ce qui mérite une relecture sans bloquer', () => {
  test('trop d’URL est signalé, pas bloqué', () => {
    const v = checkHumanization({
      body: BON.replace('à l’étranger ?', 'à l’étranger ?\nhttps://a.fr/1\nhttps://a.fr/2'),
      kind: 'FIRST_TOUCH',
    });
    assert.equal(v.verdict, 'NEEDS_EDIT');
    assert.match(v.remarks.join(' '), /URL/);
  });

  test('la sortie comme seule question est signalée', () => {
    /*
     * Le message actuel finit sur « répondez non merci » : une porte de sortie
     * nécessaire, mais qui, seule, fait du refus la réponse évidente.
     */
    const v = checkHumanization({
      body: 'Bonjour,\n\nJ’ai vu sur votre site que vous cherchez des distributeurs.\n\n'
        + 'Si ce n’est pas le moment, répondez « non merci » ?' + SIGNATURE,
      kind: 'FIRST_TOUCH',
    });
    assert.equal(v.verdict, 'NEEDS_EDIT');
    assert.match(v.remarks.join(' '), /porte de sortie/);
  });

  test('un pavé est signalé, pas bloqué', () => {
    const long = `Bonjour,\n\nJ’ai vu sur votre site ${'que vous fabriquez des pièces industrielles sur mesure. '.repeat(20)}\n\nUne question ?${SIGNATURE}`;
    const v = checkHumanization({ body: long, kind: 'FIRST_TOUCH' });
    assert.equal(v.verdict, 'NEEDS_EDIT');
    assert.match(v.remarks.join(' '), /mots/);
  });

  test('une réponse courte n’est pas jugée trop brève', () => {
    // Une réponse s'adapte à ce qu'on lui demande.
    const v = checkHumanization({
      body: 'Bonjour,\n\nJ’ai vu votre message, je vous envoie cela demain.' + SIGNATURE,
      kind: 'REPLY',
    });
    assert.notEqual(v.verdict, 'BLOCKED');
  });
});

// ─── LA SALUTATION ──────────────────────────────────────────────────────────

describe('le prénom seulement quand il est établi', () => {
  const complet = {
    name: 'Pascal Sartori', role: 'Responsable commercial',
    observed: true, intent: 'SALES', suitability: 'HIGH',
  };

  test('un contact complet, sur SON adresse, donne le prénom seul', () => {
    // « Bonjour M. Pascal Sartori » sonne comme un publipostage.
    assert.equal(greetingFor({ ...complet, email: 'p.sartori@k2tec.com' }), 'Bonjour Pascal,');
  });

  test('une boîte générique interdit le prénom, même pour un dirigeant', () => {
    /*
     * Le cas réel k2tec.com. Pascal Sartori est bien dirigeant, son nom est
     * publié, son rôle est pertinent — mais l'adresse retenue est
     * `contact@k2tec.com`, un guichet que lit peut-être un assistant. Écrire
     * « Bonjour Pascal » à un guichet partagé se voit immédiatement.
     */
    for (const email of ['contact@k2tec.com', 'info@k2tec.com', 'commercial@k2tec.com', 'hello@k2tec.com']) {
      assert.equal(greetingFor({ ...complet, email }), 'Bonjour,', email);
    }
  });

  test('sans adresse du tout, pas de prénom', () => {
    assert.equal(greetingFor({ ...complet, email: null }), 'Bonjour,');
    assert.equal(greetingFor(complet), 'Bonjour,');
  });

  test('les formes usuelles d’adresse nominative sont reconnues', () => {
    for (const email of [
      'pascal.sartori@k2tec.com', 'psartori@k2tec.com', 'p.sartori@k2tec.com',
      'sartori@k2tec.com', 'pascal@k2tec.com', 'sartori.pascal@k2tec.com',
    ]) {
      assert.equal(addressMatchesPerson(email, 'Pascal Sartori'), true, email);
    }
  });

  test('une adresse d’une autre personne ne passe pas', () => {
    assert.equal(addressMatchesPerson('marie.dupont@k2tec.com', 'Pascal Sartori'), false);
  });

  test('sans rôle publié, la salutation redevient neutre', () => {
    assert.equal(greetingFor({ ...complet, role: null }), 'Bonjour,');
  });

  test('un nom non observé ne sert jamais', () => {
    assert.equal(greetingFor({ ...complet, observed: false }), 'Bonjour,');
  });

  test('une adresse personnelle ou impropre reste neutre', () => {
    assert.equal(greetingFor({ ...complet, intent: 'PERSONAL' }), 'Bonjour,');
    assert.equal(greetingFor({ ...complet, suitability: 'LOW' }), 'Bonjour,');
  });

  test('aucun contact donne Bonjour', () => {
    assert.equal(greetingFor(null), 'Bonjour,');
    assert.equal(greetingFor({ name: '', role: 'Directeur', observed: true }), 'Bonjour,');
  });

  test('un prénom qui n’en est pas un est refusé', () => {
    // « CONTACT », « service », une initiale : aucun n'est un prénom.
    for (const name of ['CONTACT', 'service commercial', 'P.', 'x']) {
      assert.equal(greetingFor({ ...complet, name }), 'Bonjour,', name);
    }
  });
});
