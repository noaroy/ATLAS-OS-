import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '@atlas/core';
import { createRepositories, sendKey, type Repositories } from '@atlas/data';

/**
 * Rendre une place morte, sans jamais rouvrir la porte au double envoi.
 *
 * Une réservation d'envoi se prend avant l'appel réseau : si le processus meurt
 * entre les deux, la place reste prise et personne ne renvoie le message. C'est
 * voulu — un doute sur un envoi doit bloquer, jamais se résoudre tout seul.
 *
 * Restait un cas sans issue, et il s'est produit : une simulation réservait la
 * place avant de vérifier qu'elle était une simulation. Quatre relances
 * approuvées sont devenues impossibles à envoyer, sans qu'aucun message ne soit
 * jamais parti, et la table étant append-only rien ne permettait de refermer
 * ces réservations.
 *
 * Ce qui rend l'abandon sûr n'est pas le mécanisme d'abandon : c'est l'index
 * unique partiel sur les événements `SENT`. La base ne peut pas contenir deux
 * envois pour une même clé, abandon ou non. La réservation n'est qu'un verrou
 * consultatif entre processus ; la garantie, elle, est dans le schéma.
 */

const logger = createLogger({ level: 'error', pretty: false });
let dir: string;
let repos: Repositories;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-abandon-'));
  repos = createRepositories(join(dir, 'db.sqlite'), logger);
});
afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const MESSAGE = {
  domain: 'prospect.invalid',
  recipient: 'contact@prospect.invalid',
  subject: 'Suite à mon message',
  body: 'Bonjour, je reviens vers vous.',
  purpose: 'FOLLOW_UP',
};
const claim = () => repos.salesLoop.claimSend({ ...MESSAGE, claimedBy: 'test' });
const cle = () => sendKey(MESSAGE);

describe('une réservation morte', () => {
  test('bloque tout renvoi tant qu’elle n’est pas refermée', () => {
    assert.equal(claim().claimed, true);
    const seconde = claim();
    assert.equal(seconde.claimed, false);
    assert.match(seconde.reason, /reprise interdite/);
  });

  test('se libère après une décision humaine consignée', () => {
    claim();
    const abandon = repos.salesLoop.abandonSend({
      idempotencyKey: cle(),
      actor: 'proprietaire',
      reason: 'DRY_RUN_RESERVED_BEFORE_SEND',
    });
    assert.equal(abandon.released, true);
    assert.equal(claim().claimed, true, 'la place est rendue');
  });

  test('l’abandon exige un acteur et un motif', () => {
    claim();
    assert.equal(
      repos.salesLoop.abandonSend({ idempotencyKey: cle(), actor: '', reason: 'x' }).released,
      false,
    );
    assert.equal(
      repos.salesLoop.abandonSend({ idempotencyKey: cle(), actor: 'x', reason: '  ' }).released,
      false,
    );
  });

  test('la décision reste lisible, et ne se réécrit pas', () => {
    claim();
    repos.salesLoop.abandonSend({
      idempotencyKey: cle(), actor: 'proprietaire', reason: 'motif exact',
    });
    const trace = repos.salesLoop.abandonments();
    assert.equal(trace.length, 1);
    assert.equal(trace[0]!.actor, 'proprietaire');
    assert.equal(trace[0]!.reason, 'motif exact');
    // Un second abandon de la même place ne produit pas une seconde ligne.
    assert.equal(
      repos.salesLoop.abandonSend({ idempotencyKey: cle(), actor: 'x', reason: 'y' }).released,
      false,
    );
  });
});

describe('une réservation qui a réellement servi', () => {
  test('un envoi consigné ne se libère jamais', () => {
    claim();
    repos.salesLoop.recordSendResult({
      idempotencyKey: cle(), phase: 'SENT', externalMessageId: 'msg-1',
    });
    const abandon = repos.salesLoop.abandonSend({
      idempotencyKey: cle(), actor: 'proprietaire', reason: 'peu importe',
    });
    assert.equal(abandon.released, false);
    assert.match(abandon.reason, /envoi réel/);
    assert.equal(claim().claimed, false, 'la place reste fermée');
  });

  test('même abandonnée à tort, la base refuse un second envoi', () => {
    // La garantie de fond : l'index unique partiel sur SENT. Elle tient même si
    // tout le reste échouait — c'est elle qu'on vérifie ici, pas la politique.
    claim();
    repos.salesLoop.recordSendResult({
      idempotencyKey: cle(), phase: 'SENT', externalMessageId: 'msg-1',
    });
    const second = repos.salesLoop.recordSendResult({
      idempotencyKey: cle(), phase: 'SENT', externalMessageId: 'msg-2',
    });
    assert.equal(second.recorded, false);
  });
});

describe('une issue ambiguë', () => {
  test('un échec consigné bloque l’abandon et appelle un humain', () => {
    // Un échec de transport n'est pas une preuve de non-envoi : Google a pu
    // accepter le message avant que quelque chose casse en aval. Le doute ne se
    // résout pas tout seul, il se signale.
    claim();
    repos.salesLoop.recordSendResult({
      idempotencyKey: cle(), phase: 'FAILED', error: 'timeout',
    });
    const abandon = repos.salesLoop.abandonSend({
      idempotencyKey: cle(), actor: 'proprietaire', reason: 'je crois que ça n’est pas parti',
    });
    assert.equal(abandon.released, false);
    assert.match(abandon.reason, /ambigu/);
  });

  test('l’état d’une réservation se lit sans interpréter', () => {
    claim();
    const avant = repos.salesLoop.sendOutcome(cle());
    assert.deepEqual(avant, {
      exists: true, sent: false, ambiguous: false, abandoned: false, events: 0,
    });

    repos.salesLoop.recordSendResult({ idempotencyKey: cle(), phase: 'SENT', externalMessageId: 'm' });
    assert.equal(repos.salesLoop.sendOutcome(cle()).sent, true);
  });

  test('une réservation inconnue ne se libère pas', () => {
    assert.equal(
      repos.salesLoop.abandonSend({
        idempotencyKey: 'jamais-vue', actor: 'x', reason: 'y',
      }).released,
      false,
    );
  });
});

describe('la simulation ne réserve rien', () => {
  test('lire l’issue d’une clé ne crée aucune réservation', () => {
    // Le défaut exact : calculer la clé et interroger son état doit être une
    // lecture. La version fautive réservait la place pour la consulter.
    const issue = repos.salesLoop.sendOutcome(cle());
    assert.equal(issue.exists, false);
    assert.equal(repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z'), 0);

    // Répétée, elle ne crée toujours rien.
    repos.salesLoop.sendOutcome(cle());
    repos.salesLoop.sendOutcome(cle());
    assert.equal(repos.salesLoop.sendOutcome(cle()).exists, false);

    // Et l'envoi reste possible une fois, ensuite jamais.
    assert.equal(claim().claimed, true);
    assert.equal(claim().claimed, false);
  });
});

describe('un brouillon qui ne partira pas', () => {
  const brouillon = () => repos.salesLoop.saveDraft({
    domain: 'prospect.invalid',
    companyName: 'Prospect',
    recipient: 'contact@prospect.invalid',
    subject: 'Suite à mon message',
    body: 'Bonjour, je reviens vers vous.',
    purpose: 'FOLLOW_UP',
    sources: [],
    createdBy: 'proprietaire',
  });

  test('un brouillon approuvé mais jamais envoyé s’abandonne', () => {
    // Le cas exact : une simulation fautive créait et approuvait sans envoyer.
    // Laissé en APPROVED_TO_SEND, le brouillon reste « prêt à partir » — un
    // état qui finit par produire un envoi que personne n'a redemandé.
    const d = brouillon();
    repos.salesLoop.decideDraft({
      draftId: d.id, decision: 'APPROVED_TO_SEND', decidedBy: 'proprietaire',
    });
    const abandon = repos.salesLoop.decideDraft({
      draftId: d.id, decision: 'ABANDONED', decidedBy: 'proprietaire',
      note: 'STALE_DRY_RUN_DRAFT',
    });
    assert.equal(abandon.applied, true);
    assert.equal(repos.salesLoop.draftById(d.id)!.state, 'ABANDONED');
  });

  test('il ne compte plus parmi ceux qui attendent de partir', () => {
    const d = brouillon();
    repos.salesLoop.decideDraft({
      draftId: d.id, decision: 'APPROVED_TO_SEND', decidedBy: 'proprietaire',
    });
    assert.equal(repos.salesLoop.draftsInState('APPROVED_TO_SEND').length, 1);

    repos.salesLoop.decideDraft({
      draftId: d.id, decision: 'ABANDONED', decidedBy: 'proprietaire', note: 'caduc',
    });
    assert.equal(repos.salesLoop.draftsInState('APPROVED_TO_SEND').length, 0);
    assert.equal(repos.salesLoop.draftsInState('READY_FOR_APPROVAL').length, 0);
    assert.equal(repos.salesLoop.draftsInState('ABANDONED').length, 1);
  });

  test('un brouillon envoyé ne s’abandonne pas : un fait n’est pas une intention', () => {
    const d = brouillon();
    repos.salesLoop.decideDraft({
      draftId: d.id, decision: 'APPROVED_TO_SEND', decidedBy: 'proprietaire',
    });
    repos.salesLoop.markDraftSent(d.id);
    const abandon = repos.salesLoop.decideDraft({
      draftId: d.id, decision: 'ABANDONED', decidedBy: 'proprietaire', note: 'trop tard',
    });
    assert.equal(abandon.applied, false);
    assert.match(abandon.reason, /déjà envoyé/);
    assert.equal(repos.salesLoop.draftById(d.id)!.state, 'SENT');
  });

  test('la décision est consignée, et le contenu reste lisible', () => {
    // Rien n'est supprimé : le brouillon abandonné se relit avec son texte.
    const d = brouillon();
    repos.salesLoop.decideDraft({
      draftId: d.id, decision: 'ABANDONED', decidedBy: 'proprietaire', note: 'motif exact',
    });
    const relu = repos.salesLoop.draftById(d.id)!;
    assert.equal(relu.state, 'ABANDONED');
    assert.equal(relu.body, 'Bonjour, je reviens vers vous.');
  });

  test('un abandon sans auteur est refusé', () => {
    const d = brouillon();
    assert.equal(
      repos.salesLoop.decideDraft({
        draftId: d.id, decision: 'ABANDONED', decidedBy: '   ', note: 'x',
      }).applied,
      false,
    );
  });
});

describe('l’abandon ne défait la garde qu’une fois', () => {
  test('un échec après abandon referme la place', () => {
    // L'abandon est permanent. Sans borne, il défaisait la garde d'ambiguïté
    // pour toujours : un échec de transport — où Google a pu délivrer avant que
    // quelque chose casse en aval — laissait renvoyer indéfiniment.
    claim();
    repos.salesLoop.abandonSend({ idempotencyKey: cle(), actor: 'a', reason: 'r' });
    assert.equal(claim().claimed, true, 'la place est rendue une fois');

    repos.salesLoop.recordSendResult({ idempotencyKey: cle(), phase: 'FAILED', error: 'timeout' });
    const apres = claim();
    assert.equal(apres.claimed, false);
    assert.match(apres.reason, /reprise interdite/);
  });
});

describe('le curseur de synchronisation, normalisé', () => {
  test('la casse de la boîte ne crée pas un second curseur', () => {
    // `Moi@Gmail.com` et `moi@gmail.com` désignent la même boîte. Deux curseurs
    // distincts remettaient la synchronisation à zéro — et rouvraient le trou
    // que le curseur existe précisément pour empêcher.
    repos.conversations.advanceSyncCheckpoint({
      provider: 'gmail', mailbox: 'Moi@Gmail.com',
      lastReceivedAt: '2026-08-20T00:00:00.000Z', messagesSeen: 5,
    });
    const relu = repos.conversations.syncCheckpoint('gmail', '  moi@GMAIL.com ');
    assert.ok(relu, 'le curseur doit se retrouver quelle que soit la casse');
    assert.equal(relu.lastReceivedAt, '2026-08-20T00:00:00.000Z');
    assert.equal(relu.messagesSeen, 5);
  });

  test('deux boîtes différentes gardent bien deux curseurs', () => {
    repos.conversations.advanceSyncCheckpoint({
      provider: 'gmail', mailbox: 'a@exemple.fr',
      lastReceivedAt: '2026-08-20T00:00:00.000Z', messagesSeen: 1,
    });
    assert.equal(repos.conversations.syncCheckpoint('gmail', 'b@exemple.fr'), null);
  });
});

describe('la date du dernier envoi', () => {
  test('elle se lit en base, sans réseau, et sans souci de casse', () => {
    // Le War Room calculait l'échéance de relance à partir des seuls messages
    // reçus : une entreprise à qui l'on venait d'écrire apparaissait « à
    // relancer », parce que rien dans son calcul ne savait que nous avions écrit.
    assert.equal(repos.salesLoop.lastSentTo('prospect.invalid'), null);

    claim();
    repos.salesLoop.recordSendResult({
      idempotencyKey: cle(), phase: 'SENT', externalMessageId: 'm1',
    });
    const date = repos.salesLoop.lastSentTo('PROSPECT.INVALID');
    assert.ok(date, 'la date doit se lire quelle que soit la casse du domaine');
    assert.match(date, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('un envoi échoué ne compte pas comme un envoi', () => {
    claim();
    repos.salesLoop.recordSendResult({ idempotencyKey: cle(), phase: 'FAILED', error: 'x' });
    assert.equal(repos.salesLoop.lastSentTo('prospect.invalid'), null);
  });
});
