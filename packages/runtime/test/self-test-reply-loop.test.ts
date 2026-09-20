import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../core/src/logger.ts';
import { createRepositories, type Repositories } from '../../data/src/index.ts';
import { FixtureInboxProvider, mailMessage, type MailInboxProvider, type MailMessage, type MailQuery } from '../../intelligence/src/index.ts';
import { evaluateManualSendLot, SELF_TEST_DOMAIN } from '../../departments/src/index.ts';
import { syncSalesInbox, selfTestReplyScope, isSelfTestReply } from '../src/sales-inbox-sync.ts';

/**
 * La boucle du self-test, fermée : envoi réel → accusé → conversation →
 * réponse à soi-même → événement REPLIED — et rejouée sans doublon.
 *
 * Relevé en production (v4.5.4) : le self-test était parti avec ses vrais
 * identifiants Gmail (message 1a0bf72634a525e5, fil 1a0bf72634a525e5) ; la
 * réponse « Re: ATLAS — self-test » (1a0bf7476dbe105a) vivait dans le même
 * fil. La synchronisation a lu 145 messages : 0 rattaché, 0 événement, rien
 * dans mail_import_log. Trois raisons, dans l'ordre où elles agissaient :
 *
 *   1. la conversation ne connaissait pas le fil — l'envoi avait été réservé
 *      avant qu'elle n'existe (`outbound_sends.conversation_id = null`) ;
 *   2. la réponse, écrite de GMAIL_USER à GMAIL_USER, porte SENT : le listing
 *      normal (`-in:sent -in:draft`) ne la rend jamais ;
 *   3. et la garde de direction l'aurait classée sortante.
 *
 * Ici, la vraie `syncSalesInbox` tourne sur une base réelle et une boîte figée
 * fidèle à Gmail sur ce qui compte (SENT écarté sans demande, `from:`/`to:`).
 * Rien ne part : ni transport, ni réseau. MESSAGES SENT réels : 0.
 */

const logger = createLogger({ level: 'error', pretty: false });
const GMAIL_USER = 'noaroy@gmail.com';
const ORIGINAL_ID = '1a0bf72634a525e5';
const THREAD_ID = '1a0bf72634a525e5';
const REPLY_ID = '1a0bf7476dbe105a';

let dir: string;
let repos: Repositories;

/** Une boîte figée qui note ce qu'on lui demande. */
class Boite implements MailInboxProvider {
  readonly id = 'gmail';
  readonly requetes: MailQuery[] = [];
  private readonly fixture: FixtureInboxProvider;
  constructor(messages: readonly MailMessage[]) { this.fixture = new FixtureInboxProvider(messages); }
  status() { return this.fixture.status(); }
  async list(query: MailQuery = {}) { this.requetes.push(query); return this.fixture.list(query); }
}

/** Le self-test tel qu'il est réellement parti : réservé sans conversation, accusé Gmail consigné, registre CONTACTED. */
function envoyerSelfTest(domain = SELF_TEST_DOMAIN, recipient = GMAIL_USER, purpose: 'FIRST_TOUCH' | 'FOLLOW_UP' = 'FIRST_TOUCH') {
  const place = repos.salesLoop.claimSend({ domain, recipient, subject: 'ATLAS — self-test', body: 'Premier envoi réel, vers moi-même.', purpose, claimedBy: 'sales-send-approved' });
  assert.equal(place.claimed, true);
  repos.salesLoop.recordSendResult({ idempotencyKey: place.idempotencyKey, phase: 'SENT', externalMessageId: ORIGINAL_ID, externalThreadId: THREAD_ID });
  repos.sales.recordOutreach({ domain, kind: 'CONTACTED', recordedBy: 'sales-send-approved', channel: 'EMAIL', recordedAt: new Date().toISOString() });
  // Puis `sales-inbox sync` ouvre la conversation depuis le registre — après l'envoi.
  const { conversation } = repos.conversations.open({ domain, companyName: 'ATLAS self-test', channel: 'email', destination: recipient, source: 'registre' });
  return conversation;
}

/** La boîte réelle, en petit : l'original, la réponse, et du bruit de chaque sorte. */
const boiteReelle = (over: { replyFrom?: string; replyTo?: string[]; replyThread?: string } = {}) => new Boite([
  // L'original, tel que Gmail le montre : de moi à moi, SENT et INBOX.
  mailMessage({ messageId: ORIGINAL_ID, threadId: THREAD_ID, from: `Noa <${GMAIL_USER}>`, to: [GMAIL_USER], subject: 'ATLAS — self-test', bodyText: 'Premier envoi réel, vers moi-même.', labels: ['SENT', 'INBOX'], receivedAt: '2026-09-20T10:00:00.000Z' }),
  // La réponse, dans le même fil : de moi à moi aussi.
  mailMessage({ messageId: REPLY_ID, threadId: over.replyThread ?? THREAD_ID, from: over.replyFrom ?? `Noa <${GMAIL_USER}>`, to: over.replyTo ?? [GMAIL_USER], subject: 'Re: ATLAS — self-test', bodyText: 'Bonjour, merci pour votre message. Pourriez-vous me préciser le format du livrable et le délai ? Cordialement, Noa.', labels: ['SENT', 'INBOX'], receivedAt: '2026-09-20T10:05:00.000Z' }),
  // Un message à moi-même dans un autre fil : le mien, rien d'autre.
  mailMessage({ messageId: 'self-note', threadId: 'thr-note', from: GMAIL_USER, to: [GMAIL_USER], subject: 'note pour moi', bodyText: 'penser à …', labels: ['SENT', 'INBOX'], receivedAt: '2026-09-20T10:06:00.000Z' }),
  // Un message que j'ai envoyé à quelqu'un d'autre.
  mailMessage({ messageId: 'own-to-other', threadId: 'thr-other', from: GMAIL_USER, to: ['ami@exemple.fr'], subject: 'salut', bodyText: '…', labels: ['SENT'], receivedAt: '2026-09-20T10:07:00.000Z' }),
  // Un vrai prospect hébergé chez Gmail, sans fil connu : la protection des hébergeurs partagés joue.
  mailMessage({ messageId: 'prospect-gmail', threadId: 'thr-prospect', from: 'Jean Dupont <jean.dupont@gmail.com>', to: [GMAIL_USER], subject: 'Re: votre message', bodyText: 'Intéressé, rappelez-moi.', labels: ['INBOX'], receivedAt: '2026-09-20T10:08:00.000Z' }),
  // Du bruit entrant.
  ...Array.from({ length: 5 }, (_, i) => mailMessage({ messageId: `bruit-${i}`, threadId: `thr-bruit-${i}`, from: `lettre${i}@promo.example`, to: [GMAIL_USER], subject: `offre ${i}`, bodyText: 'promo', labels: ['INBOX'], receivedAt: `2026-09-20T09:0${i}:00.000Z` })),
]);

const sync = (boite: MailInboxProvider, engineMode: 'INTERNAL_TEST' | 'PRODUCTION' = 'INTERNAL_TEST') =>
  syncSalesInbox(repos, boite, { mailbox: GMAIL_USER, since: '2026-09-20T00:00:00.000Z', engineMode });

const eventsOf = (domain: string) => repos.conversations.eventsFor(repos.conversations.byDomain(domain)!.id);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-selftest-loop-'));
  repos = createRepositories(join(dir, 'atlas.db'), logger);
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D. l’accusé d’envoi réel rattache le fil à la conversation du self-test', () => {
  test('la conversation ouverte après l’envoi connaît le message et le fil — sans aucun événement', () => {
    const conversation = envoyerSelfTest();
    assert.deepEqual(repos.conversations.eventsFor(conversation.id), []);
    const receipts = repos.conversations.outboundReceipts(conversation.id);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.externalMessageId, ORIGINAL_ID);
    assert.equal(receipts[0]!.externalThreadId, THREAD_ID);
    assert.deepEqual(repos.conversations.knownThreadIds(conversation.id), [THREAD_ID]);
    assert.deepEqual(repos.conversations.knownMessageIds(conversation.id), [ORIGINAL_ID]);
    const scope = selfTestReplyScope({ engineMode: 'INTERNAL_TEST', mailbox: GMAIL_USER, conversations: repos.conversations.all(), receiptsOf: (id) => repos.conversations.outboundReceipts(id) });
    assert.deepEqual(scope, { conversationId: conversation.id, threadIds: new Set([THREAD_ID]) });
  });
});

describe('E + F + G. la boucle réelle, sur la boîte réelle', () => {
  test('l’original reste le nôtre, la réponse devient UN événement REPLIED rattaché par le fil, et la relecture ne double rien', async () => {
    envoyerSelfTest();
    const boite = boiteReelle();

    const premier = await sync(boite);
    assert.equal(premier.ran, true);
    // Deux lectures : la normale (sans nos messages) et celle du self-test, de ma boîte vers ma boîte seulement.
    assert.equal(boite.requetes.length, 2);
    assert.equal(boite.requetes[0]!.includeOwnMessages, undefined, 'le listing normal ne change pas');
    assert.equal(boite.requetes[1]!.includeOwnMessages, true);
    assert.equal(boite.requetes[1]!.rawFilter, `from:${GMAIL_USER} to:${GMAIL_USER}`);

    // E. L'original : identifiant d'un de nos envois → IGNORED, jamais un événement.
    const original = repos.conversations.alreadyImported('gmail', ORIGINAL_ID);
    assert.equal(original?.disposition, 'IGNORED');
    assert.match(original?.reason ?? '', /accusé d’envoi consigné/);
    assert.ok(premier.outbound >= 1, 'NOS PROPRES ENVOIS ≥ 1');

    // F. La réponse : rattachée par le fil, classée, un événement.
    const reply = repos.conversations.alreadyImported('gmail', REPLY_ID);
    assert.equal(reply?.disposition, 'IMPORTED');
    assert.equal(reply?.matchMethod, 'THREAD');
    assert.equal(premier.matched, 1, 'MATCHED TO OUTREACH 1');
    assert.equal(premier.newEvents, 1, 'NEW EVENTS 1');
    assert.equal(premier.byClassification.REPLIED, 1, 'HUMAN REPLIES 1');
    const events = eventsOf(SELF_TEST_DOMAIN);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.classification, 'REPLIED');
    assert.equal(events[0]!.externalMessageId, REPLY_ID);
    assert.equal(events[0]!.externalThreadId, THREAD_ID);
    assert.equal(events[0]!.declaredStatus, null, 'aucun état commercial déduit');
    assert.equal(events[0]!.humanReviewed, false);
    assert.ok(premier.lines.some((l) => l.kind === 'IMPORTED' && /réponse du self-test isolé/.test(l.detail)));

    // H (dans la même boîte) : la note à moi-même dans un autre fil, et le message à un ami — ignorés.
    assert.equal(repos.conversations.alreadyImported('gmail', 'self-note')?.disposition, 'IGNORED');
    assert.equal(repos.conversations.alreadyImported('gmail', 'own-to-other'), null, 'jamais listé : ni entrant, ni de ma boîte vers ma boîte');
    // K : le prospect chez Gmail sans fil connu reste non rattaché.
    const prospect = repos.conversations.alreadyImported('gmail', 'prospect-gmail');
    assert.equal(prospect?.disposition, 'UNMATCHED');
    assert.equal(premier.unmatched, 6, 'le prospect et les cinq bruits');

    // G. Même boîte, seconde lecture : tout est doublon, rien ne bouge.
    const second = await sync(boiteReelle());
    assert.equal(second.newEvents, 0, 'NEW EVENTS 0');
    assert.equal(second.matched, 0);
    assert.ok(second.duplicates >= 1, 'DUPLICATES SKIPPED ≥ 1');
    assert.equal(eventsOf(SELF_TEST_DOMAIN).length, 1, 'un seul événement');
    assert.equal(repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z'), 1, 'MESSAGES SENT reste 1 : rien n’est reparti');
  });
});

describe('les bords de l’exception', () => {
  test('C. en PRODUCTION, rien ne change : une seule lecture, sans nos messages, aucun événement', async () => {
    envoyerSelfTest();
    const boite = boiteReelle();
    const rapport = await sync(boite, 'PRODUCTION');
    assert.equal(boite.requetes.length, 1);
    assert.equal(boite.requetes[0]!.includeOwnMessages, undefined);
    assert.equal(rapport.newEvents, 0);
    assert.equal(repos.conversations.alreadyImported('gmail', REPLY_ID), null, 'la réponse à soi-même n’a jamais été lue');
    assert.equal(selfTestReplyScope({ engineMode: 'PRODUCTION', mailbox: GMAIL_USER, conversations: repos.conversations.all(), receiptsOf: (id) => repos.conversations.outboundReceipts(id) }), null);
    // Sans mode du tout : comme en PRODUCTION.
    const muet = boiteReelle();
    await syncSalesInbox(repos, muet, { mailbox: GMAIL_USER, since: '2026-09-20T00:00:00.000Z' });
    assert.equal(muet.requetes.length, 1);
  });

  test('H. une réponse à soi-même dans un autre fil que celui du self-test : ignorée', async () => {
    envoyerSelfTest();
    const rapport = await sync(boiteReelle({ replyThread: 'thr-ailleurs' }));
    assert.equal(rapport.newEvents, 0);
    assert.equal(repos.conversations.alreadyImported('gmail', REPLY_ID)?.disposition, 'IGNORED');
    assert.equal(isSelfTestReply({ scope: { conversationId: 'c', threadIds: new Set([THREAD_ID]) }, mailbox: GMAIL_USER, ownSentIds: new Set([ORIGINAL_ID]), message: { messageId: REPLY_ID, threadId: 'thr-ailleurs', from: GMAIL_USER, to: [GMAIL_USER] } }), false);
  });

  test('un message du fil du self-test qui porte l’identifiant de notre envoi n’est jamais une réponse, même relu comme entrant', () => {
    assert.equal(isSelfTestReply({ scope: { conversationId: 'c', threadIds: new Set([THREAD_ID]) }, mailbox: GMAIL_USER, ownSentIds: new Set([ORIGINAL_ID]), message: { messageId: ORIGINAL_ID, threadId: THREAD_ID, from: GMAIL_USER, to: [GMAIL_USER] } }), false);
    // Et un message du fil venu d'ailleurs, ou vers ailleurs, n'est pas « la réponse à soi-même » (il suivrait la voie entrante normale).
    assert.equal(isSelfTestReply({ scope: { conversationId: 'c', threadIds: new Set([THREAD_ID]) }, mailbox: GMAIL_USER, ownSentIds: new Set(), message: { messageId: 'x', threadId: THREAD_ID, from: 'tiers@exemple.fr', to: [GMAIL_USER] } }), false);
    assert.equal(isSelfTestReply({ scope: { conversationId: 'c', threadIds: new Set([THREAD_ID]) }, mailbox: GMAIL_USER, ownSentIds: new Set(), message: { messageId: 'x', threadId: THREAD_ID, from: GMAIL_USER, to: ['ami@exemple.fr'] } }), false);
    assert.equal(isSelfTestReply({ scope: null, mailbox: GMAIL_USER, ownSentIds: new Set(), message: { messageId: REPLY_ID, threadId: THREAD_ID, from: GMAIL_USER, to: [GMAIL_USER] } }), false);
  });

  test('I. GMAIL_USER contacté sous un autre domaine que selftest.atlas.invalid : pas d’exception, nos messages ne sont pas lus', async () => {
    envoyerSelfTest('moi.exemple');
    const boite = boiteReelle();
    const rapport = await sync(boite);
    assert.equal(boite.requetes.length, 1, 'aucune seconde lecture');
    assert.equal(rapport.newEvents, 0);
    assert.equal(repos.conversations.alreadyImported('gmail', REPLY_ID), null);
  });

  test('J. domaine selftest.atlas.invalid mais envoi vers un autre destinataire : pas d’exception', async () => {
    envoyerSelfTest(SELF_TEST_DOMAIN, 'contact@acme-industrie.fr');
    const boite = boiteReelle();
    const rapport = await sync(boite);
    assert.equal(boite.requetes.length, 1);
    assert.equal(rapport.newEvents, 0);
  });

  test('un self-test en FOLLOW_UP n’ouvre pas l’exception', async () => {
    envoyerSelfTest(SELF_TEST_DOMAIN, GMAIL_USER, 'FOLLOW_UP');
    const boite = boiteReelle();
    await sync(boite);
    assert.equal(boite.requetes.length, 1);
  });

  test('K. un prospect réel hébergé chez Gmail : la protection des hébergeurs partagés est intacte', async () => {
    envoyerSelfTest();
    repos.conversations.open({ domain: 'acme-industrie.fr', companyName: 'Acme Industrie', channel: 'email', destination: 'contact@acme-industrie.fr', source: 'test' });
    const rapport = await sync(boiteReelle());
    const prospect = repos.conversations.alreadyImported('gmail', 'prospect-gmail');
    assert.equal(prospect?.disposition, 'UNMATCHED');
    assert.match(prospect?.reason ?? '', /hébergeur|partagé|gmail\.com/i);
    assert.equal(rapport.matched, 1, 'seule la réponse du self-test, par son fil');
    assert.deepEqual(repos.conversations.eventsFor(repos.conversations.byDomain('acme-industrie.fr')!.id), []);
  });

  test('L. les gardes d’envoi ne bougent pas : porte fermée et destinataire externe refusent toujours', () => {
    assert.deepEqual(evaluateManualSendLot({ send: true, engineMode: 'INTERNAL_TEST', outboundEnabled: false, gmailUser: GMAIL_USER, recipients: [GMAIL_USER] }).blocks.map((b) => b.code), ['OUTBOUND_DISABLED']);
    assert.deepEqual(evaluateManualSendLot({ send: true, engineMode: 'INTERNAL_TEST', outboundEnabled: true, gmailUser: GMAIL_USER, recipients: ['contact@acme-industrie.fr'] }).blocks.map((b) => b.code), ['INTERNAL_TEST_RECIPIENT_BLOCKED']);
  });
});

describe('la base de production, telle qu’elle est : curseur en place, réponse jamais consignée', () => {
  test('sans toucher au curseur ni au journal, le passage suivant découvre la réponse dans le recouvrement', async () => {
    envoyerSelfTest();
    // Le premier import (v4.5.4) : le listing normal seulement — la réponse n'est pas rendue, le curseur avance sur le bruit.
    const avant = new Boite([
      mailMessage({ messageId: 'bruit-0', threadId: 'thr-bruit-0', from: 'lettre0@promo.example', to: [GMAIL_USER], subject: 'offre 0', bodyText: 'promo', labels: ['INBOX'], receivedAt: '2026-09-20T10:09:00.000Z' }),
    ]);
    const premier = await syncSalesInbox(repos, avant, { mailbox: GMAIL_USER, engineMode: 'PRODUCTION', since: '2026-09-20T00:00:00.000Z' });
    assert.equal(premier.newEvents, 0);
    const curseur = repos.conversations.syncCheckpoint('gmail', GMAIL_USER);
    assert.equal(curseur?.lastReceivedAt, '2026-09-20T10:09:00.000Z');
    assert.equal(repos.conversations.alreadyImported('gmail', REPLY_ID), null, 'la réponse n’a jamais été consignée');

    // Le passage suivant, avec la correction déployée : même base, même curseur, recouvrement de 6 h.
    const apres = await syncSalesInbox(repos, boiteReelle(), { mailbox: GMAIL_USER, engineMode: 'INTERNAL_TEST' });
    assert.equal(apres.newEvents, 1);
    assert.equal(apres.byClassification.REPLIED, 1);
    assert.ok(apres.duplicates >= 1, 'le bruit déjà lu est un doublon, pas un événement');
    assert.equal(eventsOf(SELF_TEST_DOMAIN).length, 1);
  });
});
