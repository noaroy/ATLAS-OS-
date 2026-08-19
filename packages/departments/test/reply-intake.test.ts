import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyInbound,
  extractReturnDate,
  deriveConversationState,
  requiresHumanJudgement,
  type ConversationEvent,
} from '../src/reply-intake.ts';

/**
 * Après un envoi, trois choses arrivent : un rebond, une absence, ou
 * quelqu'un qui écrit. Les deux premières se reconnaissent à des marqueurs
 * invariants. La troisième ne se devine pas — une réponse humaine dit
 * rarement « je suis intéressé », et lui prêter une intention se paie à la
 * relance suivante.
 */

describe('rebonds', () => {
  test('un code 550 suffit', () => {
    const result = classifyInbound({
      kind: 'EMAIL_REPLY',
      subject: 'Undelivered Mail Returned to Sender',
      sender: 'MAILER-DAEMON@mail.example.com',
      body: '550 5.1.1 The email account that you tried to reach does not exist.',
    });
    assert.equal(result.classification, 'BOUNCED');
    assert.ok(result.confidence >= 0.9);
    assert.ok(result.signals.some((s) => s.includes('550')));
  });

  test('mailer-daemon seul suffit aussi', () => {
    const result = classifyInbound({
      kind: 'EMAIL_REPLY',
      sender: 'mailer-daemon@relay.fr',
      subject: 'Retour de courrier',
      body: 'Votre message n’a pas pu être remis.',
    });
    assert.equal(result.classification, 'BOUNCED');
    assert.ok(result.signals.some((s) => s.includes('mailer-daemon')));
  });

  test('un code temporaire n’est pas un rebond définitif', () => {
    // 4xx veut dire « réessayez ». Le traiter comme un échec définitif
    // condamnerait une adresse qui fonctionne.
    const result = classifyInbound({
      kind: 'EMAIL_REPLY',
      sender: 'quelqu-un@usine.fr',
      subject: 'Re: votre message',
      body: 'Bonjour, merci pour votre message, je transmets à mon collègue. Cordialement.',
    });
    assert.notEqual(result.classification, 'BOUNCED');
  });

  test('un rebond déclaré reste un rebond', () => {
    const result = classifyInbound({ kind: 'BOUNCE', body: 'inconnu' });
    assert.equal(result.classification, 'BOUNCED');
    assert.equal(result.confidence, 1);
  });
});

describe('absences automatiques', () => {
  test('une absence avec date donne la date', () => {
    const result = classifyInbound({
      kind: 'EMAIL_REPLY',
      subject: 'Réponse automatique : absence du bureau',
      sender: 'contact@groupe-jlf.com',
      body: 'Je suis actuellement absente et de retour le 24 août. Pendant mon absence, contactez l’accueil.',
      receivedAt: '2026-08-18T09:00:00Z',
    });
    assert.equal(result.classification, 'AUTO_REPLY');
    assert.equal(result.returnDate, '2026-08-24');
    assert.match(result.reason, /Personne n’a lu/);
  });

  test('les formes anglaises aussi', () => {
    const result = classifyInbound({
      kind: 'EMAIL_REPLY',
      subject: 'Automatic reply: Out of office',
      body: 'I am currently away and will be back on September 2.',
      receivedAt: '2026-08-18T09:00:00Z',
    });
    assert.equal(result.classification, 'AUTO_REPLY');
    assert.equal(result.returnDate, '2026-09-02');
  });

  test('une absence sans date ne fabrique pas de date', () => {
    const result = classifyInbound({
      kind: 'EMAIL_REPLY',
      subject: 'Réponse automatique',
      body: 'Je suis absent du bureau et reviendrai prochainement.',
    });
    assert.equal(result.classification, 'AUTO_REPLY');
    assert.equal(result.returnDate, null, '« prochainement » n’est pas une date');
  });

  test('une date impossible est refusée', () => {
    assert.equal(extractReturnDate('de retour le 31 février', 2026), null);
    assert.equal(extractReturnDate('de retour le 32/13', 2026), null);
    assert.equal(extractReturnDate('de retour le 24 août', 2026), '2026-08-24');
    assert.equal(extractReturnDate('jusqu’au 24/08/2026', 2026), '2026-08-24');
  });
});

describe('réponses humaines', () => {
  test('une vraie réponse est REPLIED, et rien de plus', () => {
    const result = classifyInbound({
      kind: 'EMAIL_REPLY',
      sender: 'direction@usine.fr',
      subject: 'Re: prospection B2B',
      body:
        'Bonjour, merci pour votre message. Pourriez-vous nous en dire plus sur ' +
        'la méthode utilisée et sur le format du livrable ? Cordialement, la direction.',
    });
    assert.equal(result.classification, 'REPLIED');
    // Le point du test : l'intention n'est pas déduite.
    assert.notEqual(result.classification, 'INTERESTED' as never);
    assert.match(result.reason, /n’est pas\s+déduit/);
  });

  test('une réponse ambiguë ne devient pas une intention', () => {
    const result = classifyInbound({
      kind: 'EMAIL_REPLY',
      sender: 'x@usine.fr',
      subject: 'Re:',
      body: 'ok',
    });
    assert.equal(result.classification, 'NEEDS_REVIEW');
    assert.match(result.reason, /Le doute se dit/);
  });

  test('une note humaine attend son auteur', () => {
    const result = classifyInbound({ kind: 'MANUAL_NOTE', body: 'appelé, rappeler en septembre' });
    assert.equal(result.classification, 'NEEDS_REVIEW');
  });
});

describe('l’état déduit d’un historique', () => {
  const event = (over: Partial<ConversationEvent>): ConversationEvent => ({
    kind: 'EMAIL_REPLY',
    classification: 'REPLIED',
    occurredAt: '2026-08-18T09:00:00Z',
    returnDate: null,
    humanReviewed: false,
    ...over,
  });

  test('sans événement : contacté, rien de plus', () => {
    const state = deriveConversationState([]);
    assert.equal(state.status, 'CONTACTED');
  });

  test('une absence datée programme la relance', () => {
    const state = deriveConversationState(
      [event({ classification: 'AUTO_REPLY', returnDate: '2026-08-24' })],
      { today: '2026-08-19' },
    );
    assert.equal(state.status, 'FOLLOW_UP_SCHEDULED');
    assert.equal(state.followUpAt, '2026-08-24');
    assert.match(state.nextAction, /relancer le 2026-08-24/);
  });

  test('la même absence, une fois la date atteinte, demande l’action', () => {
    const state = deriveConversationState(
      [event({ classification: 'AUTO_REPLY', returnDate: '2026-08-24' })],
      { today: '2026-08-25' },
    );
    assert.equal(state.status, 'FOLLOW_UP_REQUIRED');
  });

  test('une absence sans date exige qu’on en fixe une', () => {
    const state = deriveConversationState([event({ classification: 'AUTO_REPLY' })]);
    assert.equal(state.status, 'FOLLOW_UP_REQUIRED');
    assert.equal(state.followUpAt, null);
  });

  test('une auto-réponse ne vaut pas réponse commerciale', () => {
    const state = deriveConversationState(
      [event({ classification: 'AUTO_REPLY', returnDate: '2026-09-01' })],
      { today: '2026-08-19' },
    );
    assert.notEqual(state.status, 'REPLIED');
    assert.match(state.reason, /pas une réponse commerciale/);
  });

  test('une réponse humaine prime sur un rebond antérieur', () => {
    // Le premier envoi a rebondi, la personne a écrit depuis une autre
    // adresse : un chemin fonctionne, même si le premier était mauvais.
    const state = deriveConversationState([
      event({ classification: 'BOUNCED', occurredAt: '2026-08-18T09:00:00Z' }),
      event({ classification: 'REPLIED', occurredAt: '2026-08-19T09:00:00Z' }),
    ]);
    assert.equal(state.status, 'REPLIED');
  });

  test('le rebond reste dans l’historique même quand l’état change', () => {
    const events = [
      event({ classification: 'BOUNCED', occurredAt: '2026-08-18T09:00:00Z' }),
      event({ classification: 'REPLIED', occurredAt: '2026-08-19T09:00:00Z' }),
    ];
    assert.equal(events.filter((e) => e.classification === 'BOUNCED').length, 1);
    assert.equal(deriveConversationState(events).status, 'REPLIED');
  });

  test('un jugement humain l’emporte sur les règles', () => {
    const state = deriveConversationState([
      event({ classification: 'REPLIED', occurredAt: '2026-08-19T09:00:00Z' }),
      event({
        kind: 'MANUAL_NOTE', classification: 'NEEDS_REVIEW', occurredAt: '2026-08-20T09:00:00Z',
        humanReviewed: true, declaredStatus: 'NOT_INTERESTED',
      }),
    ]);
    assert.equal(state.status, 'NOT_INTERESTED');
    assert.equal(state.followUpAt, null, 'un refus ne se relance pas tout seul');
  });

  test('les états commerciaux ne s’atteignent pas par règle', () => {
    for (const status of ['INTERESTED', 'NOT_INTERESTED', 'WON', 'LOST', 'MEETING_REQUESTED'] as const) {
      assert.equal(requiresHumanJudgement(status), true, status);
    }
    for (const status of ['CONTACTED', 'BOUNCED', 'AUTO_REPLY', 'REPLIED'] as const) {
      assert.equal(requiresHumanJudgement(status), false, status);
    }
  });

  test('la relance du registre est lue quand la conversation n’en a pas', () => {
    const state = deriveConversationState([], { ledgerFollowUpAt: '2026-08-24' });
    assert.equal(state.followUpAt, '2026-08-24');
    assert.match(state.nextAction, /2026-08-24/);
  });
});

test('les deux ordres de date se lisent', () => {
  // « 24 août » et « September 2 » : n'en lire qu'un faisait perdre la
  // relance sur les absences en anglais.
  assert.equal(extractReturnDate('de retour le 24 aout', 2026), '2026-08-24');
  assert.equal(extractReturnDate('back on September 2', 2026), '2026-09-02');
  assert.equal(extractReturnDate('back on September 2, 2027', 2026), '2027-09-02');
  assert.equal(extractReturnDate('back on February 30', 2026), null);
});
