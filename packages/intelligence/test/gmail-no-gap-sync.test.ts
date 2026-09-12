import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';

/**
 * Aucune réponse ne se perd entre deux synchronisations.
 *
 * La garantie manquait, et son absence était invisible. La synchronisation
 * demandait les cinquante messages les plus récents, sans curseur : une réponse
 * de prospect arrivée en cinquante-et-unième position n'était pas « en retard »,
 * elle n'existait pas — et le passage suivant reprenant lui aussi les cinquante
 * plus récents, elle n'aurait jamais existé. Rien ne manquait nulle part : ni
 * erreur, ni message non lu, ni trace.
 *
 * Deux propriétés se tiennent ici, et il faut les deux. Sans trou : tout message
 * postérieur au curseur finit par être traité, quel qu'en soit le volume. Sans
 * doublon : un message déjà traité ne produit pas un second événement, même
 * relu dix fois — sans quoi la protection contre les trous fabriquerait des
 * réponses fantômes.
 */

const logger = createLogger({ level: 'error', pretty: false });
let dir: string;
let repos: Repositories;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-nogap-'));
  repos = createRepositories(join(dir, 'db.sqlite'), logger);
});
afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const PROVIDER = 'gmail';
const BOITE = 'exploitation@exemple.invalid';

/** Une boîte factice : `n` messages, du plus ancien au plus récent. */
const boite = (n: number, depuis = Date.parse('2026-08-01T00:00:00.000Z')) =>
  Array.from({ length: n }, (_, i) => ({
    messageId: `msg-${String(i + 1).padStart(3, '0')}`,
    // Une minute d'écart : l'ordre est total, sans ex æquo à départager.
    receivedAt: new Date(depuis + i * 60_000).toISOString(),
  }));

/**
 * Ce que le fournisseur rendrait pour une fenêtre donnée.
 *
 * Reproduit le comportement de Gmail : du plus récent au plus ancien, plafonné.
 * C'est ce plafond, appliqué sans curseur, qui produisait le trou.
 */
const fenetre = (
  tous: ReturnType<typeof boite>,
  options: { since?: string; max: number },
) => tous
  .filter((m) => (options.since ? m.receivedAt > options.since : true))
  .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1))
  .slice(0, options.max);

/** Le traitement d'un lot, avec la déduplication réelle du dépôt. */
const traiter = (lot: ReturnType<typeof boite>, conversationId: string) => {
  let nouveaux = 0;
  for (const message of lot) {
    if (repos.conversations.alreadyImported(PROVIDER, message.messageId)) continue;
    repos.conversations.recordInboundEvent({
      conversationId,
      kind: 'EMAIL_REPLY',
      classification: 'REPLIED',
      confidence: 0.9,
      occurredAt: message.receivedAt,
      source: PROVIDER,
      externalMessageId: message.messageId,
      humanReviewed: false,
    });
    repos.conversations.logImport({
      provider: PROVIDER,
      externalMessageId: message.messageId,
      externalThreadId: null,
      disposition: 'IMPORTED',
      matchMethod: 'test',
      conversationId,
      eventId: null,
      reason: null,
      fromAddress: 'prospect@prospect.invalid',
      subject: `sujet ${message.messageId}`,
      receivedAt: message.receivedAt,
    });
    nouveaux += 1;
  }
  return nouveaux;
};

const ouvrirConversation = () => repos.conversations.open({
  domain: 'prospect.invalid',
  companyName: 'Prospect',
  source: 'test',
  firstContactAt: '2026-08-01T00:00:00.000Z',
}).conversation.id;

describe('le curseur de synchronisation', () => {
  test('sans curseur, « jamais lu » se distingue de « à jour »', () => {
    assert.equal(repos.conversations.syncCheckpoint(PROVIDER, BOITE), null);
  });

  test('il ne recule jamais, même après une relecture volontaire', () => {
    // Relire une ancienne fenêtre à la main ne doit pas faire oublier ce qui a
    // déjà été lu depuis, sans quoi la relecture rouvrirait le trou.
    repos.conversations.advanceSyncCheckpoint({
      provider: PROVIDER, mailbox: BOITE,
      lastReceivedAt: '2026-08-20T00:00:00.000Z', messagesSeen: 10,
    });
    const recul = repos.conversations.advanceSyncCheckpoint({
      provider: PROVIDER, mailbox: BOITE,
      lastReceivedAt: '2026-08-10T00:00:00.000Z', messagesSeen: 5,
    });
    assert.equal(recul.advanced, false);
    assert.equal(recul.lastReceivedAt, '2026-08-20T00:00:00.000Z');
    // Les messages relus comptent quand même : le total dit l'effort fourni.
    assert.equal(repos.conversations.syncCheckpoint(PROVIDER, BOITE)!.messagesSeen, 15);
  });

  test('deux boîtes ont deux curseurs indépendants', () => {
    repos.conversations.advanceSyncCheckpoint({
      provider: PROVIDER, mailbox: BOITE,
      lastReceivedAt: '2026-08-20T00:00:00.000Z', messagesSeen: 1,
    });
    assert.equal(repos.conversations.syncCheckpoint(PROVIDER, 'autre@exemple.invalid'), null);
  });
});

describe('120 messages arrivent, la réponse est au 87e', () => {
  test('elle est retrouvée — sans curseur, elle était perdue pour toujours', () => {
    const conversationId = ouvrirConversation();
    const tous = boite(120);

    // La reponse commerciale, au 87e message arrive. Elle a 33 messages plus
    // recents qu'elle : l'ancienne fenetre de cinquante l'attrapait donc de
    // justesse. C'est le scenario demande, et il faut le dire tel qu'il est.
    const reponse87 = tous[86]!;
    const ancienne = fenetre(tous, { max: 50 });
    assert.equal(
      ancienne.some((m) => m.messageId === reponse87.messageId), true,
      'le 87e sur 120 tombe dans les cinquante plus recents — 33 messages le suivent',
    );

    // Le trou commence a partir du 70e : au-dela de cinquante messages plus
    // recents, l'ancien comportement ne voyait plus rien, et ne le verrait
    // jamais. C'est ce message-la qui prouve la garantie.
    const reponsePerdue = tous[12]!;
    assert.equal(
      ancienne.some((m) => m.messageId === reponsePerdue.messageId), false,
      'le 13e sur 120 est hors de toute fenetre de cinquante : sinon le test ne prouve rien',
    );

    // --- Le comportement corrigé : depuis le curseur, sans plafond bas.
    const depart = tous[0]!.receivedAt;
    repos.conversations.advanceSyncCheckpoint({
      provider: PROVIDER, mailbox: BOITE, lastReceivedAt: depart, messagesSeen: 1,
    });

    const curseur = repos.conversations.syncCheckpoint(PROVIDER, BOITE)!;
    const lot = fenetre(tous, { since: curseur.lastReceivedAt, max: 2000 });
    traiter(lot, conversationId);

    const evenements = repos.conversations.eventsFor(conversationId);
    const ids = evenements.map((e) => e.externalMessageId);
    assert.ok(ids.includes(reponse87.messageId), 'la reponse du 87e message est retrouvee');
    assert.ok(
      ids.includes(reponsePerdue.messageId),
      'la reponse que l ancienne fenetre perdait definitivement est retrouvee',
    );
    assert.equal(evenements.length, 119, 'tous les messages posterieurs au curseur');
  });

  test('après le lot, le curseur porte le message le plus récent traité', () => {
    const conversationId = ouvrirConversation();
    const tous = boite(120);
    const lot = fenetre(tous, { max: 2000 });
    traiter(lot, conversationId);

    const plusRecent = lot.map((m) => m.receivedAt).reduce((a, b) => (a >= b ? a : b));
    repos.conversations.advanceSyncCheckpoint({
      provider: PROVIDER, mailbox: BOITE, lastReceivedAt: plusRecent, messagesSeen: lot.length,
    });

    assert.equal(
      repos.conversations.syncCheckpoint(PROVIDER, BOITE)!.lastReceivedAt,
      tous[119]!.receivedAt,
    );
  });
});

describe('un plantage au milieu de la pagination', () => {
  test('la reprise ne laisse ni trou ni doublon', () => {
    const conversationId = ouvrirConversation();
    const tous = boite(120);

    // --- Premier passage : interrompu après 40 messages sur 120.
    //
    // Le curseur n'a pas bougé : il n'avance qu'une fois le lot entier traité.
    // C'est précisément ce qui rend la reprise sûre — l'avancer message par
    // message aurait laissé le curseur au-delà du travail réellement fait, et
    // les 80 messages sautés n'auraient jamais été relus.
    const lotComplet = fenetre(tous, { max: 2000 });
    const interrompu = lotComplet.slice(0, 40);
    traiter(interrompu, conversationId);

    assert.equal(
      repos.conversations.syncCheckpoint(PROVIDER, BOITE), null,
      'un plantage ne doit pas avoir avancé le curseur',
    );

    // --- Reprise : la fenêtre entière est relue.
    const reprise = fenetre(tous, { max: 2000 });
    const nouveaux = traiter(reprise, conversationId);

    const evenements = repos.conversations.eventsFor(conversationId);
    const ids = evenements.map((e) => e.externalMessageId);

    // Aucun trou : les 120 messages sont là.
    assert.equal(evenements.length, 120, 'aucun trou');
    for (const message of tous) {
      assert.ok(ids.includes(message.messageId), `${message.messageId} manquant`);
    }
    // Aucun doublon : les 40 déjà traités n'ont pas produit un second événement.
    assert.equal(new Set(ids).size, 120, 'aucun doublon');
    assert.equal(nouveaux, 80, 'seuls les 80 restants sont nouveaux');

    repos.conversations.advanceSyncCheckpoint({
      provider: PROVIDER, mailbox: BOITE,
      lastReceivedAt: tous[119]!.receivedAt, messagesSeen: 120,
    });
    assert.equal(
      repos.conversations.syncCheckpoint(PROVIDER, BOITE)!.lastReceivedAt,
      tous[119]!.receivedAt,
    );
  });

  test('une troisième lecture de la même fenêtre ne crée rien', () => {
    // L'idempotence est ce qui autorise le recouvrement volontaire : relire un
    // peu trop doit être sans conséquence, sinon la protection contre les trous
    // fabriquerait des réponses fantômes.
    const conversationId = ouvrirConversation();
    const tous = boite(30);
    traiter(tous, conversationId);
    traiter(tous, conversationId);
    assert.equal(traiter(tous, conversationId), 0);
    assert.equal(repos.conversations.eventsFor(conversationId).length, 30);
  });
});
