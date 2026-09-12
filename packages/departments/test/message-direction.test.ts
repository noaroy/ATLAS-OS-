import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  directionOf, sameMailbox, addressOf, classifyInbound, replyHistory,
} from '../src/index.ts';

/**
 * Nos propres messages ne sont pas des réponses.
 *
 * La panne, telle qu'elle s'est produite : la requête Gmail listait toute la
 * boîte sans filtre de direction, le rapprochement se faisait par fil — un fil
 * connu parce que *nous* l'avions ouvert — et la classification lisait le sujet
 * et le corps sans jamais regarder l'expéditeur. Nos courriers de prospection
 * revenaient donc classés `REPLIED`.
 *
 * Quatre entreprises figuraient au tableau des réponses à traiter alors que leur
 * seul message était le nôtre. Le tableau n'était pas approximatif : il
 * annonçait l'inverse de la réalité, et sur cette base on relance quelqu'un qui
 * n'a jamais répondu.
 */

const NOUS = 'noaroy210709@gmail.com';

describe('la direction d’un message', () => {
  test('notre propre envoi n’est jamais une réponse', () => {
    const verdict = directionOf({
      from: 'Noa Roy <noaroy210709@gmail.com>',
      labels: ['SENT'],
      mailbox: NOUS,
    });
    assert.equal(verdict.direction, 'OUTBOUND');
    assert.match(verdict.reason, /SENT/);
  });

  test('l’étiquette SENT tranche, même sans en-tête reconnaissable', () => {
    // Gmail pose l'étiquette lui-même : elle ne dépend ni du formatage du
    // `From`, ni d'un alias, ni d'un nom affiché fantaisiste.
    const verdict = directionOf({ from: 'Quelqu’un <ailleurs@exemple.fr>', labels: ['SENT'], mailbox: NOUS });
    assert.equal(verdict.direction, 'OUTBOUND');
  });

  test('l’adresse suffit quand le fournisseur n’étiquette pas', () => {
    const verdict = directionOf({ from: `Noa Roy <${NOUS}>`, labels: [], mailbox: NOUS });
    assert.equal(verdict.direction, 'OUTBOUND');
    assert.match(verdict.reason, /notre propre boîte/);
  });

  test('un brouillon n’a été reçu de personne', () => {
    assert.equal(
      directionOf({ from: 'x@exemple.fr', labels: ['DRAFT'], mailbox: NOUS }).direction,
      'OUTBOUND',
    );
  });

  test('une vraie réponse externe est bien entrante', () => {
    const verdict = directionOf({
      from: 'ACRN Commercial <commercial@acrn.fr>',
      labels: ['INBOX'],
      mailbox: NOUS,
    });
    assert.equal(verdict.direction, 'INBOUND');
  });

  test('un expéditeur illisible est traité comme sortant', () => {
    // Le doute penche du côté prudent. Un vrai message entrant écarté à tort
    // atterrit dans « à lire » et sera vu ; un message sortant pris pour une
    // réponse fabrique une réalité commerciale fausse que personne ne vérifie.
    assert.equal(directionOf({ from: '', labels: [], mailbox: NOUS }).direction, 'OUTBOUND');
  });

  test('un alias de notre boîte reste notre boîte', () => {
    // `+etiquette` et les points de la partie locale désignent la même boîte
    // chez Gmail : les ignorer ferait passer un envoi pour un message externe.
    assert.equal(sameMailbox('noa.roy210709+prospection@gmail.com', NOUS), true);
    assert.equal(sameMailbox('quelqu-un@exemple.fr', NOUS), false);
  });

  test('l’adresse est extraite d’un en-tête avec nom affiché', () => {
    assert.equal(addressOf('ACRN Commercial <commercial@acrn.fr>'), 'commercial@acrn.fr');
    assert.equal(addressOf('  Brut@Exemple.FR '), 'brut@exemple.fr');
  });
});

describe('la classification, une fois la direction établie', () => {
  const recu = (over: Partial<Parameters<typeof classifyInbound>[0]> = {}) => classifyInbound({
    kind: 'EMAIL_REPLY',
    subject: 'Re: votre message',
    sender: 'contact@prospect.fr',
    body: 'Bonjour, merci pour votre message. Votre proposition nous intéresse et nous '
      + 'aimerions en discuter avec vous la semaine prochaine si vous êtes disponible.',
    receivedAt: '2026-08-25T09:00:00.000Z',
    ...over,
  });

  test('une vraie réponse humaine est REPLIED', () => {
    assert.equal(recu().classification, 'REPLIED');
  });

  test('un message humain trop court n’est pas deviné : NEEDS_REVIEW', () => {
    // Le classement ne comble pas les blancs. Une réponse trop brève pour être
    // affirmée passe en revue humaine plutôt que d'être rangée dans la première
    // case venue — c'est le meme principe que la garde de direction, appliqué
    // a l'intention plutot qu'a la provenance.
    const verdict = recu({ body: 'Bonjour, merci.' });
    assert.equal(verdict.classification, 'NEEDS_REVIEW');
    assert.notEqual(verdict.classification, 'REPLIED');
  });

  test('un accusé automatique est AUTO_REPLY, jamais REPLIED', () => {
    const verdict = recu({
      subject: 'Accusé de réception de votre demande',
      body: 'Ceci est un message automatique. Votre demande a bien été enregistrée. Ne pas répondre.',
    });
    assert.notEqual(verdict.classification, 'REPLIED');
    assert.equal(verdict.classification, 'AUTO_REPLY');
  });

  test('une absence du bureau est AUTO_REPLY', () => {
    const verdict = recu({
      subject: 'Absence du bureau',
      body: 'Je suis absente jusqu’au 30 août. En cas d’urgence, contactez l’accueil.',
    });
    assert.equal(verdict.classification, 'AUTO_REPLY');
  });

  test('un rebond est BOUNCED, jamais REPLIED', () => {
    const verdict = recu({
      sender: 'mailer-daemon@googlemail.com',
      subject: 'Delivery Status Notification (Failure)',
      body: 'Address not found. Your message wasn’t delivered to contact@prospect.fr.',
    });
    assert.notEqual(verdict.classification, 'REPLIED');
  });
});

describe('l’accusé de réception de formulaire', () => {
  test('le vrai message de Groupe DIS est AUTO_REPLY, pas REPLIED', () => {
    // Le message qui a mis Groupe DIS au tableau des décisions à prendre : il
    // dit « Bonjour », fait deux cents mots et recopie la demande — donc il
    // franchissait le seuil de la réponse humaine. Son sujet, lui, ne laisse
    // aucun doute : aucune personne n'intitule sa réponse « accusé de
    // réception ».
    const verdict = classifyInbound({
      kind: 'EMAIL_REPLY',
      subject: 'Confirmation de réception de votre demande - Groupe DIS',
      sender: 'Communication Groupe Dis <communication@dis-groupe.fr>',
      body: 'Bonjour Noa Roy, Nous avons bien reçu votre demande envoyée depuis notre '
        + 'site internet www.dis-groupe.fr et nous vous en remercions. Notre équipe va '
        + 'l’examiner dans les meilleurs délais et reviendra vers vous rapidement. '
        + 'Pour rappel, voici le message que vous nous avez adressé.',
      receivedAt: '2026-08-20T04:30:00.000Z',
    });
    assert.equal(verdict.classification, 'AUTO_REPLY');
    assert.notEqual(verdict.classification, 'REPLIED');
  });

  test('une vraie réponse qui accuse réception avant de parler reste REPLIED', () => {
    // Un seul marqueur dans le corps ne suffit pas : une personne peut très bien
    // commencer par accuser réception, puis dire quelque chose. C'est le report
    // — « nous reviendrons vers vous » — qui distingue l'accusé de la réponse,
    // et il en faut deux pour trancher hors du sujet.
    const verdict = classifyInbound({
      kind: 'EMAIL_REPLY',
      subject: 'Re: 3 distributeurs potentiels',
      sender: 'directeur@prospect.fr',
      body: 'Bonjour, nous avons bien reçu votre demande. Le sujet nous intéresse '
        + 'beaucoup et je souhaiterais en parler avec vous cette semaine si possible.',
      receivedAt: '2026-08-25T09:00:00.000Z',
    });
    assert.equal(verdict.classification, 'REPLIED');
  });
});

describe('l’histoire d’une conversation survit à son état courant', () => {
  const evt = (over: Record<string, unknown>) => ({
    kind: 'EMAIL_REPLY',
    source: 'gmail (THREAD)',
    sender: 'commercial@acrn.fr',
    rawSubject: 'Re: 3 distributeurs potentiels',
    bodyExcerpt: 'Bonjour, merci pour votre message. Votre proposition nous intéresse '
      + 'et nous aimerions en discuter avec vous la semaine prochaine.',
    classification: 'REPLIED',
    occurredAt: '2026-08-21T07:36:00.000Z',
    humanReviewed: false,
    declaredStatus: null,
    ...over,
  });

  test('une entreprise qui a répondu le reste, même après notre réponse', () => {
    // Le défaut exact : le taux de réponse se déduisait de l'état courant. ACRN
    // avait répondu deux fois ; l'aperçu gratuit parti, son état est devenu
    // « en attente du client » — et l'entreprise a cessé de compter. Le tableau
    // annonçait 0 % là où une vraie conversation était engagée.
    const histoire = replyHistory([
      evt({}),
      // La correction d'audit qui a fait basculer l'état : elle ne doit rien
      // effacer de ce qui s'est réellement passé.
      evt({
        kind: 'CORRECTION', source: 'audit-direction', sender: null,
        classification: 'FOLLOW_UP_SCHEDULED', humanReviewed: true,
        declaredStatus: 'FOLLOW_UP_SCHEDULED', occurredAt: '2026-08-26T00:00:00.000Z',
      }),
    ], 'noaroy210709@gmail.com');

    assert.equal(histoire.everHumanReplied, true);
    assert.equal(histoire.humanReplies, 1);
    assert.equal(histoire.lastHumanReplyAt, '2026-08-21T07:36:00.000Z');
  });

  test('nos propres messages ne comptent pas dans l’histoire', () => {
    const histoire = replyHistory([
      evt({ sender: 'Noa Roy <noaroy210709@gmail.com>' }),
    ], 'noaroy210709@gmail.com');
    assert.equal(histoire.everHumanReplied, false);
  });

  test('un accusé de réception ne fabrique pas une réponse', () => {
    // Reclassé à la lecture : la règle s'est affinée, et l'histoire suit sans
    // qu'on ait eu à réécrire l'événement stocké.
    const histoire = replyHistory([
      evt({
        rawSubject: 'Confirmation de réception de votre demande - Groupe DIS',
        sender: 'communication@dis-groupe.fr',
        bodyExcerpt: 'Bonjour, nous avons bien reçu votre demande envoyée depuis notre '
          + 'site internet et reviendrons vers vous dans les meilleurs délais.',
      }),
    ], 'noaroy210709@gmail.com');
    assert.equal(histoire.everHumanReplied, false);
    assert.equal(histoire.autoReplies, 1);
  });

  test('une note du fondateur reste un constat, malgré l’absence d’expéditeur', () => {
    // Elle n'a pas d'expéditeur, et la garde de direction — prudente — la
    // classerait sortante. C'est pourtant le seul endroit où une réponse reçue
    // par téléphone est consignée.
    const histoire = replyHistory([
      evt({ source: 'note du fondateur', sender: null, classification: 'REPLIED' }),
    ], 'noaroy210709@gmail.com');
    assert.equal(histoire.everHumanReplied, true);
  });
});
