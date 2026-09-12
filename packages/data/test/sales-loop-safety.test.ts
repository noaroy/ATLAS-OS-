import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '@atlas/core';
import { createRepositories, type Repositories } from '../src/index.ts';

/**
 * Ce qui doit rester vrai même quand tout se passe mal.
 *
 * La boucle commerciale peut se tromper de prospect, mal rédiger, mal classer
 * une réponse : ce sont des défauts qui se corrigent. Envoyer deux fois le même
 * message à une entreprise ne se corrige pas — il est parti. Ces tests portent
 * sur ce sous-ensemble-là : les propriétés dont la violation est définitive.
 *
 * Ils s'exécutent sur une base réelle et non sur des doubles, parce que la
 * garantie testée est tenue par SQLite — une clé primaire et un index unique
 * partiel — et non par le code appelant. Vérifier le code appelant reviendrait
 * à tester la politesse plutôt que la serrure.
 */

const logger = createLogger({ level: 'error', pretty: false });
let repos: Repositories;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-loop-'));
  repos = createRepositories(join(dir, 'loop.db'), logger);
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const message = {
  domain: 'exemple-industrie.fr',
  recipient: 'contact@exemple-industrie.fr',
  subject: 'Votre gamme de tableaux électriques',
  body: 'Bonjour, j’ai relevé ceci sur votre site : […]',
  purpose: 'FIRST_TOUCH',
  claimedBy: 'boucle-commerciale',
};

describe('un message ne part jamais deux fois', () => {
  test('la seconde réservation du même message est refusée', () => {
    const first = repos.salesLoop.claimSend(message);
    assert.equal(first.claimed, true);

    const second = repos.salesLoop.claimSend(message);
    assert.equal(second.claimed, false);
    assert.equal(second.idempotencyKey, first.idempotencyKey);
  });

  test('un retry après plantage ne renvoie pas le message', () => {
    // Le processus réserve, puis meurt avant d'appeler le fournisseur : aucune
    // issue n'est consignée.
    const first = repos.salesLoop.claimSend(message);
    assert.equal(first.claimed, true);

    // Il redémarre et rejoue exactement la même intention.
    const retry = repos.salesLoop.claimSend(message);
    assert.equal(retry.claimed, false);
    assert.match(retry.reason, /déjà engagée/);
    // Rien n'est parti, et rien ne partira sans décision humaine : c'est le
    // sens de la panne choisi. Un message bloqué se rattrape, un doublon non.
    assert.equal(repos.salesLoop.alreadySent(first.idempotencyKey), false);
  });

  test('deux succès sur la même clé sont refusés par la base', () => {
    const claim = repos.salesLoop.claimSend(message);
    const ok = repos.salesLoop.recordSendResult({
      idempotencyKey: claim.idempotencyKey,
      phase: 'SENT',
      externalMessageId: 'msg-1',
    });
    assert.equal(ok.recorded, true);

    const again = repos.salesLoop.recordSendResult({
      idempotencyKey: claim.idempotencyKey,
      phase: 'SENT',
      externalMessageId: 'msg-2',
    });
    assert.equal(again.recorded, false);
    assert.match(again.reason, /déjà consigné/);
  });

  test('un échec puis un succès restent possibles : seul le doublon est bloqué', () => {
    const claim = repos.salesLoop.claimSend(message);
    const failed = repos.salesLoop.recordSendResult({
      idempotencyKey: claim.idempotencyKey,
      phase: 'FAILED',
      error: 'timeout',
    });
    assert.equal(failed.recorded, true);
    const sent = repos.salesLoop.recordSendResult({
      idempotencyKey: claim.idempotencyKey,
      phase: 'SENT',
      externalMessageId: 'msg-1',
    });
    assert.equal(sent.recorded, true);
  });

  test('un message différent vers la même entreprise reste possible', () => {
    repos.salesLoop.claimSend(message);
    // Une relance n'est pas un doublon : corps différent, clé différente.
    const followUp = repos.salesLoop.claimSend({
      ...message,
      purpose: 'FOLLOW_UP',
      body: 'Bonjour, je me permets un mot de suite à mon message précédent.',
    });
    assert.equal(followUp.claimed, true);
  });
});

describe('les transitions sont append-only', () => {
  test('une transition consignée ne se réécrit pas', () => {
    repos.salesLoop.recordTransition({
      domain: 'exemple-industrie.fr',
      fromState: null,
      toState: 'QUALIFYING',
      actor: 'boucle',
    });
    assert.throws(
      () =>
        repos.salesLoop['db']
          .prepare("UPDATE sales_loop_transitions SET to_state = 'WON' WHERE domain = ?")
          .run('exemple-industrie.fr'),
      /append|reecrit|réécrit|ABORT/i,
    );
  });

  test("l'état courant est la dernière transition, pas la première", () => {
    const domain = 'exemple-industrie.fr';
    for (const to of ['QUALIFYING', 'READY_FOR_APPROVAL', 'APPROVED_TO_SEND'] as const) {
      repos.salesLoop.recordTransition({
        domain, fromState: repos.salesLoop.currentState(domain), toState: to, actor: 'boucle',
      });
    }
    assert.equal(repos.salesLoop.currentState(domain), 'APPROVED_TO_SEND');
    assert.equal(repos.salesLoop.historyFor(domain).length, 3);
  });
});

describe("aucun envoi sans approbation en V1", () => {
  const draftInput = {
    domain: 'exemple-industrie.fr',
    companyName: 'Exemple Industrie',
    recipient: 'contact@exemple-industrie.fr',
    subject: 'Votre gamme',
    body: 'Bonjour, […]',
    purpose: 'FIRST_TOUCH',
    sources: [{ quote: 'Nous fabriquons des tableaux électriques.', sourceUrl: 'https://exemple-industrie.fr/' }],
    createdBy: 'boucle',
  };

  test('un brouillon naît en attente de relecture', () => {
    const draft = repos.salesLoop.saveDraft(draftInput);
    assert.equal(draft.state, 'READY_FOR_APPROVAL');
    assert.equal(repos.salesLoop.draftsInState('APPROVED_TO_SEND').length, 0);
  });

  test('approuver exige un nom, et se consigne', () => {
    const draft = repos.salesLoop.saveDraft(draftInput);
    const decision = repos.salesLoop.decideDraft({
      draftId: draft.id, decision: 'APPROVED_TO_SEND', decidedBy: 'noaroy',
    });
    assert.equal(decision.applied, true);
    assert.equal(repos.salesLoop.draftById(draft.id)?.state, 'APPROVED_TO_SEND');
  });

  test('un brouillon déjà tranché ne se re-décide pas', () => {
    const draft = repos.salesLoop.saveDraft(draftInput);
    repos.salesLoop.decideDraft({
      draftId: draft.id, decision: 'REJECTED', decidedBy: 'noaroy',
    });
    const again = repos.salesLoop.decideDraft({
      draftId: draft.id, decision: 'APPROVED_TO_SEND', decidedBy: 'noaroy',
    });
    assert.equal(again.applied, false);
    assert.equal(repos.salesLoop.draftById(draft.id)?.state, 'REJECTED');
  });

  test("une décision d'approbation ne se réécrit pas", () => {
    const draft = repos.salesLoop.saveDraft(draftInput);
    repos.salesLoop.decideDraft({
      draftId: draft.id, decision: 'APPROVED_TO_SEND', decidedBy: 'noaroy',
    });
    assert.throws(
      () =>
        repos.salesLoop['db']
          .prepare("UPDATE outreach_draft_decisions SET decided_by = 'quelqu un' WHERE draft_id = ?")
          .run(draft.id),
      /ABORT|reecrit|réécrit/i,
    );
  });
});

describe('le quota du jour se compte sur les envois réels', () => {
  test('seuls les succès comptent, pas les réservations', () => {
    const claim = repos.salesLoop.claimSend(message);
    assert.equal(repos.salesLoop.sentSince('2000-01-01'), 0);
    repos.salesLoop.recordSendResult({
      idempotencyKey: claim.idempotencyKey, phase: 'SENT', externalMessageId: 'm1',
    });
    assert.equal(repos.salesLoop.sentSince('2000-01-01'), 1);
  });
});

describe('le plafond de relance est par entreprise', () => {
  test('une relance chez A ne bloque pas la relance chez B', () => {
    // Le compteur a d'abord ete ecrit a l'echelle du systeme. La war room
    // annoncait alors « relance deja partie » pour tout le monde des la
    // premiere : le plafond « une par entreprise » etait devenu « une en tout ».
    const relance = (domain: string) => {
      const claim = repos.salesLoop.claimSend({
        domain,
        recipient: `contact@${domain}`,
        subject: 'Suite a mon message',
        body: 'Bonjour, je me permets un mot de suite.',
        purpose: 'FOLLOW_UP',
        claimedBy: 'boucle',
      });
      repos.salesLoop.recordSendResult({
        idempotencyKey: claim.idempotencyKey, phase: 'SENT', externalMessageId: 'm',
      });
    };
    relance('societe-a.fr');
    assert.equal(repos.salesLoop.followUpsFor('societe-a.fr'), 1);
    assert.equal(repos.salesLoop.followUpsFor('societe-b.fr'), 0);
    relance('societe-b.fr');
    assert.equal(repos.salesLoop.followUpsFor('societe-b.fr'), 1);
  });

  test('un premier message ne compte pas comme une relance', () => {
    const claim = repos.salesLoop.claimSend(message);
    repos.salesLoop.recordSendResult({
      idempotencyKey: claim.idempotencyKey, phase: 'SENT', externalMessageId: 'm',
    });
    assert.equal(repos.salesLoop.followUpsFor(message.domain), 0);
  });
});

