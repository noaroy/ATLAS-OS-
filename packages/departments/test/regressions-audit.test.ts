import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractReturnDate, directionOf, replyHistory, evaluateFollowUp,
} from '../src/index.ts';

/**
 * Dix défauts trouvés en relisant le code, et les cas qui les révèlent.
 *
 * Aucun ne faisait échouer un test : ils vivaient dans les angles — un mois de
 * décembre, une variable d'environnement absente, une espace en fin de nom.
 * C'est la marque de ce genre de bug : il ne casse rien, il ment.
 */

describe('une absence annoncée à cheval sur deux années', () => {
  test('« de retour le 5 janvier », écrit en décembre, vise l’année suivante', () => {
    // Sans cela : 2026-01-05, une date déjà passée. La relance était jugée due
    // sur-le-champ, en pleines vacances de la personne.
    assert.equal(extractReturnDate('de retour le 5 janvier', 2026, '2026-12-20'), '2027-01-05');
  });

  test('une année écrite noir sur blanc fait foi', () => {
    assert.equal(extractReturnDate('de retour le 5 janvier 2026', 2026, '2026-12-20'), '2026-01-05');
  });

  test('dans le même mois, rien ne bascule', () => {
    assert.equal(extractReturnDate('de retour le 30 août', 2026, '2026-08-20'), '2026-08-30');
  });
});

describe('la garde de direction sans configuration', () => {
  test('une boîte de référence inconnue ferme la garde', () => {
    // `GMAIL_USER` absent rendait INBOUND pour tout : la garde se désactivait en
    // silence et nos propres messages redevenaient des réponses.
    assert.equal(
      directionOf({ from: 'x@exterieur.fr', labels: [], mailbox: '' }).direction,
      'OUTBOUND',
    );
    assert.equal(
      directionOf({ from: 'x@exterieur.fr', labels: [], mailbox: '   ' }).direction,
      'OUTBOUND',
    );
  });
});

describe('l’histoire d’une conversation et le jugement humain', () => {
  const evt = (over: Record<string, unknown>) => ({
    kind: 'EMAIL_REPLY', source: 'gmail (THREAD)', sender: 'client@exterieur.fr',
    rawSubject: 'ok', bodyExcerpt: 'ok', classification: 'REPLIED',
    occurredAt: '2026-08-20T10:00:00.000Z', humanReviewed: false,
    declaredStatus: null, ...over,
  });

  test('une réponse courte confirmée à la main compte quand même', () => {
    // La reclassification à la lecture écrasait le jugement d'une personne qui
    // avait lu le message — l'inverse du principe posé pour l'état dérivé.
    const h = replyHistory([evt({ humanReviewed: true, declaredStatus: 'REPLIED' })], 'moi@gmail.com');
    assert.equal(h.everHumanReplied, true);
    assert.equal(h.lastHumanReplyAt, '2026-08-20T10:00:00.000Z');
  });

  test('un humain qui déclare AUTO_REPLY est suivi aussi', () => {
    const h = replyHistory([evt({ humanReviewed: true, declaredStatus: 'AUTO_REPLY' })], 'moi@gmail.com');
    assert.equal(h.everHumanReplied, false);
    assert.equal(h.autoReplies, 1);
  });

  test('sans jugement, la règle tranche comme avant', () => {
    // « ok » est trop court pour prouver une réponse humaine.
    assert.equal(replyHistory([evt({})], 'moi@gmail.com').everHumanReplied, false);
  });
});

describe('une échéance de relance', () => {
  const base = {
    domain: 'x.fr', status: 'CONTACTED' as const, contactedOn: '2026-08-01',
    followUpsSent: 0, doNotContact: false, afterBusinessDays: 3, today: '2026-08-26',
  };

  test('une activité datée du futur ne repousse rien', () => {
    // Une horloge déréglée ou une donnée fausse suspendait la relance pour des
    // années, sans que rien ne le signale.
    assert.equal(evaluateFollowUp({ ...base, lastActivityOn: '2099-01-01' }).verdict, 'DUE');
  });

  test('une activité récente repousse, elle', () => {
    const v = evaluateFollowUp({ ...base, lastActivityOn: '2026-08-25' });
    assert.equal(v.verdict, 'TOO_EARLY');
    assert.match(v.reason, /dernière activité du 2026-08-25/);
  });
});
