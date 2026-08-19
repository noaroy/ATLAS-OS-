import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createLogger } from '../../core/src/logger.ts';
import { createRepositories, type Repositories } from '../src/index.ts';
import { classifyInbound, matchIncoming, type MatchCandidate } from '../../departments/src/index.ts';
import { FixtureInboxProvider, mailMessage } from '../../intelligence/src/mail/fixture.ts';

/**
 * Le pont complet, sur une boîte figée : rapprochement, idempotence,
 * classification.
 *
 * Le point de tous ces tests tient en une phrase — une réponse mal rattachée
 * est pire qu'une réponse non rattachée. La première fait relancer quelqu'un
 * qui avait dit non ; la seconde attend dans une file qu'un humain lira.
 */
const logger = createLogger({ level: 'error', pretty: false });
let dir: string;
let repos: Repositories;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-bridge-'));
  repos = createRepositories(join(dir, 'test.db'), logger);

  for (const [domain, name, destination] of [
    ['cirmeca.com', 'CIRMECA', 'contact@cirmeca.fr'],
    ['groupe-reval.com', 'France Reval', 'contact@france-reval.com'],
    ['mecapole.fr', 'Mecapole', 'https://mecapole.fr/'],
  ] as const) {
    repos.conversations.open({ domain, companyName: name, destination, source: 'test' });
  }
});

after(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const candidates = (): MatchCandidate[] =>
  repos.conversations.all().map((c) => ({
    canonicalDomain: c.canonicalDomain,
    companyName: c.companyName,
    outreachDestination: c.destination,
    knownThreadIds: repos.conversations.knownThreadIds(c.id),
    knownMessageIds: repos.conversations.knownMessageIds(c.id),
  }));

/** La boucle du script de synchronisation, réduite à son essentiel. */
function sync(messages: readonly ReturnType<typeof mailMessage>[]) {
  const counts = { scanned: 0, matched: 0, events: 0, duplicates: 0, unmatched: 0 };
  const seen = candidates();

  for (const message of messages) {
    counts.scanned += 1;
    if (repos.conversations.alreadyImported('fixture', message.messageId)) {
      counts.duplicates += 1;
      continue;
    }
    const match = matchIncoming(
      {
        from: message.from, to: message.to, threadId: message.threadId,
        headers: message.headers, bodyText: message.bodyText,
      },
      seen,
    );
    if (!match.candidate) {
      counts.unmatched += 1;
      repos.conversations.logImport({
        provider: 'fixture', externalMessageId: message.messageId,
        externalThreadId: message.threadId, disposition: 'UNMATCHED', matchMethod: null,
        conversationId: null, eventId: null, reason: match.reason,
        fromAddress: message.from, subject: message.subject, receivedAt: message.receivedAt,
      });
      continue;
    }
    counts.matched += 1;
    const conversation = repos.conversations.byDomain(match.candidate.canonicalDomain)!;
    const verdict = classifyInbound({
      kind: 'EMAIL_REPLY', subject: message.subject, sender: message.from,
      body: message.bodyText ?? message.snippet, receivedAt: message.receivedAt,
    });
    const event = repos.conversations.recordInboundEvent({
      conversationId: conversation.id,
      kind: verdict.classification === 'BOUNCED' ? 'BOUNCE'
        : verdict.classification === 'AUTO_REPLY' ? 'AUTO_REPLY' : 'EMAIL_REPLY',
      classification: verdict.classification, confidence: verdict.confidence,
      occurredAt: message.receivedAt, source: `fixture (${match.method})`,
      rawSubject: message.subject, sender: message.from,
      bodyExcerpt: message.bodyText, signals: verdict.signals, returnDate: verdict.returnDate,
      humanReviewed: false, declaredStatus: null,
      externalMessageId: message.messageId, externalThreadId: message.threadId,
    });
    counts.events += 1;
    repos.conversations.logImport({
      provider: 'fixture', externalMessageId: message.messageId,
      externalThreadId: message.threadId, disposition: 'IMPORTED', matchMethod: match.method,
      conversationId: conversation.id, eventId: event.id, reason: match.reason,
      fromAddress: message.from, subject: message.subject, receivedAt: message.receivedAt,
    });
  }
  return counts;
}

describe('rapprochement', () => {
  test('l’adresse contactée rattache la réponse', () => {
    const result = matchIncoming({ from: 'Direction <contact@cirmeca.fr>' }, candidates());
    assert.equal(result.candidate?.companyName, 'CIRMECA');
    assert.equal(result.method, 'OUTREACH_ADDRESS');
  });

  test('le domaine officiel rattache aussi, avec moins d’assurance', () => {
    const result = matchIncoming({ from: 'jean@cirmeca.com' }, candidates());
    assert.equal(result.candidate?.companyName, 'CIRMECA');
    assert.equal(result.method, 'SENDER_DOMAIN');
    assert.ok(result.confidence < 0.92, 'moins sûr que l’adresse exacte');
  });

  test('une marque proche est reconnue à travers l’extension', () => {
    const result = matchIncoming({ from: 'compta@france-reval.com' }, candidates());
    assert.equal(result.candidate?.companyName, 'France Reval');
  });

  test('un hébergeur partagé ne rattache personne', () => {
    // Rapprocher par gmail.com rattacherait tous les particuliers à la même
    // société — l'erreur la plus coûteuse de tout le pont.
    const result = matchIncoming({ from: 'jean.dupont@gmail.com' }, candidates());
    assert.equal(result.candidate, null);
    assert.match(result.reason, /hébergeur partagé/);
  });

  test('un inconnu complet reste non rattaché', () => {
    const result = matchIncoming({ from: 'newsletter@quelque-part.fr' }, candidates());
    assert.equal(result.candidate, null);
    assert.equal(result.method, 'NONE');
  });
});

describe('synchronisation', () => {
  const inbox = [
    mailMessage({
      messageId: 'g-bounce', from: 'MAILER-DAEMON@googlemail.com',
      to: ['commercial@atlas.example'], subject: 'Delivery Status Notification (Failure)',
      bodyText: '550 5.1.1 The email account that you tried to reach does not exist.',
      headers: { 'x-failed-recipients': 'contact@cirmeca.fr' },
      receivedAt: '2026-08-19T08:00:00.000Z', threadId: 't-1',
    }),
    mailMessage({
      messageId: 'g-auto', from: 'contact@france-reval.com',
      subject: 'Réponse automatique : absence du bureau',
      bodyText: 'Je suis actuellement absente et de retour le 24 août.',
      receivedAt: '2026-08-19T09:00:00.000Z', threadId: 't-2',
    }),
    mailMessage({
      messageId: 'g-human', from: 'Sophie <direction@mecapole.fr>',
      subject: 'Re: prospection',
      bodyText:
        'Bonjour, merci pour votre message. Pourriez-vous nous préciser le format ' +
        'du livrable et le délai ? Cordialement, Sophie.',
      receivedAt: '2026-08-19T10:00:00.000Z', threadId: 't-3',
    }),
    mailMessage({
      messageId: 'g-vague', from: 'contact@cirmeca.fr', subject: 'Re:',
      bodyText: 'ok', receivedAt: '2026-08-19T11:00:00.000Z',
    }),
    mailMessage({
      messageId: 'g-noise', from: 'promo@newsletter-btp.fr',
      subject: 'Nos offres du mois', bodyText: 'Bonjour, découvrez nos promotions.',
      receivedAt: '2026-08-19T12:00:00.000Z',
    }),
  ];

  test('une boîte figée se synchronise sans réseau', async () => {
    const provider = new FixtureInboxProvider(inbox);
    const messages = await provider.list();
    const counts = sync(messages);

    assert.equal(counts.scanned, 5);
    assert.equal(counts.matched, 4);
    assert.equal(counts.events, 4);
    assert.equal(counts.unmatched, 1, 'la newsletter n’est rattachée à personne');
    assert.equal(counts.duplicates, 0);
  });

  test('chaque message est classé par les règles du Reply Intake', () => {
    const events = repos.conversations
      .all()
      .flatMap((c) => repos.conversations.eventsFor(c.id));
    const byId = new Map(events.map((e) => [e.externalMessageId, e]));

    assert.equal(byId.get('g-bounce')?.classification, 'BOUNCED');
    assert.equal(byId.get('g-auto')?.classification, 'AUTO_REPLY');
    assert.equal(byId.get('g-auto')?.returnDate, '2026-08-24');
    assert.equal(byId.get('g-human')?.classification, 'REPLIED');
    assert.equal(byId.get('g-vague')?.classification, 'NEEDS_REVIEW');
  });

  test('aucun état commercial n’est posé par la synchronisation', () => {
    const events = repos.conversations
      .all()
      .flatMap((c) => repos.conversations.eventsFor(c.id));
    for (const event of events) {
      assert.equal(event.declaredStatus, null, 'INTERESTED, WON, LOST restent humains');
      assert.equal(event.humanReviewed, false);
    }
  });

  test('une seconde synchronisation ne crée aucun doublon', async () => {
    const before = repos.conversations
      .all()
      .flatMap((c) => repos.conversations.eventsFor(c.id)).length;

    const provider = new FixtureInboxProvider(inbox);
    const counts = sync(await provider.list());

    assert.equal(counts.duplicates, 5, 'les cinq messages sont reconnus comme déjà lus');
    assert.equal(counts.events, 0);
    const after = repos.conversations
      .all()
      .flatMap((c) => repos.conversations.eventsFor(c.id)).length;
    assert.equal(after, before, 'aucun événement ajouté');
  });

  test('le message non rattaché reste consigné, il ne se rescanne pas', () => {
    const entry = repos.conversations.alreadyImported('fixture', 'g-noise');
    assert.equal(entry?.disposition, 'UNMATCHED');
    assert.equal(entry?.conversationId, null);
    assert.ok(entry?.reason);
  });

  test('le registre d’import est append-only', () => {
    const db = new Database(join(dir, 'test.db'));
    assert.throws(
      () => db.prepare("UPDATE mail_import_log SET disposition = 'IMPORTED'").run(),
      /append-only/,
    );
    assert.throws(() => db.prepare('DELETE FROM mail_import_log').run(), /reimporter/);
    db.close();
  });
});

describe('une entreprise, une conversation', () => {
  test('deux lots et deux réponses n’ouvrent qu’un fil', () => {
    // La même société est redécouverte dans un autre lot : `open` rend le fil
    // existant, et les deux réponses s'y accumulent.
    const reopened = repos.conversations.open({
      domain: 'www.cirmeca.com', companyName: 'Cirmeca Machines', source: 'BATCH-006',
    });
    assert.equal(reopened.created, false);
    assert.equal(repos.conversations.all().filter((c) => c.canonicalDomain === 'cirmeca.com').length, 1);

    const events = repos.conversations.eventsFor(reopened.conversation.id);
    assert.equal(events.length, 2, 'le rebond et la réponse vague, sur un seul fil');
  });

  test('le fil connu rattache une réponse ultérieure', () => {
    // Le premier message a laissé son `threadId` : la piste la plus sûre.
    const result = matchIncoming(
      { from: 'quelqu-un-dautre@ailleurs.fr', threadId: 't-1' },
      candidates(),
    );
    assert.equal(result.candidate?.companyName, 'CIRMECA');
    assert.equal(result.method, 'THREAD');
    assert.ok(result.confidence > 0.95);
  });
});
