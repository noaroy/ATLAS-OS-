import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createLogger } from '../../core/src/logger.ts';
import { createRepositories, type Repositories } from '../src/index.ts';

/**
 * Le registre dit qu'on a écrit. Ces tests portent sur ce qui revient — et
 * surtout sur ce qui ne doit pas pouvoir arriver : une conversation en double
 * pour une même entreprise, un rebond effacé, une vente que personne n'a vue.
 */
const logger = createLogger({ level: 'error', pretty: false });
let dir: string;
let repos: Repositories;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-conv-'));
  repos = createRepositories(join(dir, 'test.db'), logger);
});

after(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('une entreprise, une conversation', () => {
  test('deux lots ne créent qu’un seul fil', () => {
    // CIRMECA figure dans trois lots et n'a qu'une histoire commerciale. Deux
    // fils produiraient deux relances — exactement ce que la déduplication
    // inter-lots empêche côté prospection.
    const first = repos.conversations.open({
      domain: 'cirmeca.com', companyName: 'CIRMECA', source: 'BATCH-003', channel: 'email',
      // Date fixée : sans elle, l'ouverture prend l'heure courante et le test
      // change de résultat selon le moment de la journée.
      firstContactAt: '2026-08-01T09:00:00Z',
    });
    const second = repos.conversations.open({
      domain: 'www.cirmeca.com', companyName: 'Cirmeca Machines', source: 'BATCH-004',
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false, 'la seconde ouverture rend la première');
    assert.equal(second.conversation.id, first.conversation.id);
    assert.equal(repos.conversations.all().length, 1);
  });

  test('le domaine est canonique : www. ne fait pas un second fil', () => {
    assert.equal(repos.conversations.byDomain('CIRMECA.com')?.canonicalDomain, 'cirmeca.com');
    assert.equal(repos.conversations.byDomain('https://www.cirmeca.com/')?.canonicalDomain, 'cirmeca.com');
  });
});

describe('les événements sont append-only', () => {
  test('un rebond puis une réponse : les deux se lisent', () => {
    const conv = repos.conversations.byDomain('cirmeca.com')!;
    repos.conversations.recordInboundEvent({
      conversationId: conv.id, kind: 'BOUNCE', classification: 'BOUNCED', confidence: 1,
      occurredAt: '2026-08-18T09:00:00Z', source: 'imap', sender: 'mailer-daemon@x',
      signals: ['code SMTP 550'],
    });
    repos.conversations.recordInboundEvent({
      conversationId: conv.id, kind: 'EMAIL_REPLY', classification: 'REPLIED', confidence: 0.85,
      occurredAt: '2026-08-19T09:00:00Z', source: 'imap', sender: 'direction@cirmeca.fr',
    });

    const events = repos.conversations.eventsFor(conv.id);
    assert.equal(events.length, 2);
    assert.equal(events[0]!.classification, 'BOUNCED', 'le rebond reste');
    assert.equal(events[1]!.classification, 'REPLIED');
  });

  test('la base refuse de modifier ou d’effacer un événement', () => {
    // Un rebond effacé est un rebond qu'on refera. La garantie est portée par
    // SQLite, pas par la discipline des appelants.
    const db = new Database(join(dir, 'test.db'));
    assert.throws(
      () => db.prepare("UPDATE sales_conversation_events SET classification = 'REPLIED'").run(),
      /append-only/,
    );
    assert.throws(
      () => db.prepare('DELETE FROM sales_conversation_events').run(),
      /rebond efface/,
    );
    db.close();

    const conv = repos.conversations.byDomain('cirmeca.com')!;
    assert.equal(repos.conversations.eventsFor(conv.id).length, 2);
  });

  test('la dernière activité suit les événements', () => {
    const conv = repos.conversations.byDomain('cirmeca.com')!;
    assert.equal(conv.lastActivityAt, '2026-08-19T09:00:00Z');
    assert.ok(conv.firstContactAt < conv.lastActivityAt, 'le premier contact précède');
  });
});

describe('aucune vente inventée', () => {
  test('poser un état commercial exige une relecture humaine', () => {
    const conv = repos.conversations.byDomain('cirmeca.com')!;
    assert.throws(
      () =>
        repos.conversations.recordInboundEvent({
          conversationId: conv.id, kind: 'MANUAL_NOTE', classification: 'NEEDS_REVIEW',
          confidence: 1, source: 'manuel', declaredStatus: 'WON',
        }),
      /relecture humaine/,
      'un WON que personne n’a constaté est une supposition',
    );
  });

  test('avec relecture, l’état posé est accepté et tracé', () => {
    const conv = repos.conversations.byDomain('cirmeca.com')!;
    const event = repos.conversations.recordInboundEvent({
      conversationId: conv.id, kind: 'MANUAL_NOTE', classification: 'NEEDS_REVIEW',
      confidence: 1, source: 'manuel', humanReviewed: true, declaredStatus: 'INTERESTED',
      note: 'appel du 20 août : demande une démonstration',
      occurredAt: '2026-08-20T09:00:00Z',
    });
    assert.equal(event.declaredStatus, 'INTERESTED');
    assert.equal(event.humanReviewed, true);
  });
});

describe('la relance du registre est lue, pas recopiée', () => {
  test('la date de retour vient de l’entrée d’outreach', () => {
    // Groupe JLF : la date a été enregistrée au moment de l'envoi. La
    // conversation la lit à travers son entrée de registre — la dupliquer
    // créerait deux vérités qui divergeraient à la première correction.
    repos.sales.recordOutreach({
      domain: 'groupe-jlf.com', kind: 'CONTACTED', recordedBy: 'noaroy',
      channel: 'email', note: 'AUTO_REPLY_RECEIVED', followUpAt: '2026-08-24',
    });
    const entry = repos.sales.ledgerHistory('groupe-jlf.com')[0]!;

    const { conversation } = repos.conversations.open({
      domain: 'groupe-jlf.com', companyName: 'Groupe JLF',
      outreachLedgerEntryId: entry.id, channel: 'email', source: 'BATCH-004',
    });

    assert.equal(repos.conversations.ledgerFollowUpFor(conversation.id), '2026-08-24');
  });

  test('sans entrée de registre, il n’y a pas de relance fantôme', () => {
    const { conversation } = repos.conversations.open({
      domain: 'sans-registre.fr', companyName: 'Sans Registre', source: 'manuel',
    });
    assert.equal(repos.conversations.ledgerFollowUpFor(conversation.id), null);
  });
});

describe('ce module n’envoie rien', () => {
  test('aucune méthode d’envoi n’existe', () => {
    // Une boîte de réception qui saurait répondre finirait par le faire.
    const methods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(repos.conversations),
    );
    for (const forbidden of ['send', 'sendEmail', 'reply', 'dispatch', 'notify']) {
      assert.equal(methods.includes(forbidden), false, `« ${forbidden} » ne doit pas exister`);
    }
    // La liste est exhaustive à dessein : toute méthode ajoutée doit passer
    // par ici, donc être remarquée. C'est le seul moyen qu'un « juste une
    // petite réponse automatique » ne s'y glisse pas un jour.
    assert.deepEqual(
      methods.filter((m) => m !== 'constructor').sort(),
      [
        'all', 'alreadyImported', 'byDomain', 'eventsFor', 'knownMessageIds',
        'knownThreadIds', 'ledgerFollowUpFor', 'logImport', 'open', 'recordInboundEvent',
      ],
    );
  });
});
