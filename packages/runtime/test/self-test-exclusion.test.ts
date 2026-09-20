import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../core/src/logger.ts';
import type { AtlasConfig } from '../../core/src/index.ts';
import { createRepositories, type Repositories } from '../../data/src/index.ts';
import { makeTestConfig } from '../../testing/src/index.ts';
import { isTechnicalDomain, isTechnicalEntity, matchIncoming, SELF_TEST_DOMAIN } from '../../departments/src/index.ts';
import { buildSalesDashboard } from '../src/sales-dashboard.ts';
import { collectNeedsYou, todaySnapshot, pipelineSnapshot } from '../src/needs-you.ts';
import { runAutopilotCycle, summariseAutopilot, fingerprintOf, type AutopilotObservation } from '../src/autopilot.ts';

/**
 * Le self-test Gmail est une preuve technique, pas un prospect.
 *
 * Relevé en production (v4.6.0) : la conversation `selftest.atlas.invalid`
 * — un vrai envoi, une vraie réponse, gardés pour l'audit — comptait comme un
 * contact, une réponse, une conversation en attente ; l'Autopilot plaçait
 * « traiter 1 conversation où quelqu'un attend une réponse » en tête de ses
 * priorités, et le fondateur travaillait sur lui-même.
 *
 * Un seul prédicat, `isTechnicalEntity`, partout où l'on interprète
 * commercialement. Les données restent ; les chiffres, les listes, les
 * propositions les ignorent. Un prospect réel — même hébergé chez Gmail —
 * continue de compter, et d'être protégé comme avant. Rien ne part.
 */

const logger = createLogger({ level: 'error', pretty: false });
const NOW = new Date('2026-09-21T09:00:00.000Z');
const GMAIL_USER = 'noaroy@gmail.com';
const EPOCH = '1970-01-01T00:00:00.000Z';
let dir: string;
let repos: Repositories;
let config: AtlasConfig;

const OFFLINE: AutopilotObservation['providers'] = {
  DETERMINISTIC: { ready: true, detail: 'test' }, OPENAI: { ready: false, detail: 'clé absente' }, CLAUDE: { ready: false, detail: 'clé absente' },
  CLAUDE_CODE: { ready: false, detail: 'absent' }, SEARCH: { ready: false, detail: 'aucun moteur' },
};

/** Le self-test, tel qu'il est en base après v4.5.5 : accusé réel, registre CONTACTED, conversation, réponse REPLIED. */
function seedSelfTest() {
  const place = repos.salesLoop.claimSend({ domain: SELF_TEST_DOMAIN, recipient: GMAIL_USER, subject: 'ATLAS — self-test', body: 'Premier envoi réel, vers moi-même.', purpose: 'FIRST_TOUCH', claimedBy: 'sales-send-approved' });
  repos.salesLoop.recordSendResult({ idempotencyKey: place.idempotencyKey, phase: 'SENT', externalMessageId: '1a0bf72634a525e5', externalThreadId: '1a0bf72634a525e5' });
  repos.sales.recordOutreach({ domain: SELF_TEST_DOMAIN, kind: 'CONTACTED', recordedBy: 'sales-send-approved', channel: 'EMAIL', recordedAt: new Date(NOW.getTime() - 86_400_000).toISOString() });
  const { conversation } = repos.conversations.open({ domain: SELF_TEST_DOMAIN, companyName: 'ATLAS self-test', channel: 'email', destination: GMAIL_USER, source: 'registre' });
  repos.conversations.recordInboundEvent({
    conversationId: conversation.id, kind: 'EMAIL_REPLY', classification: 'REPLIED', confidence: 0.9, occurredAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
    source: 'gmail (THREAD)', rawSubject: 'Re: ATLAS — self-test', sender: `Noa <${GMAIL_USER}>`, bodyExcerpt: 'Bonjour, merci pour votre message. Pourriez-vous me préciser le format et le délai ? Cordialement, Noa.',
    humanReviewed: false, declaredStatus: null, externalMessageId: '1a0bf7476dbe105a', externalThreadId: '1a0bf72634a525e5',
  });
  return conversation;
}

/** Un prospect réel, contacté, qui a répondu avec intérêt. */
function seedRealProspect(domain = 'acme-industrie.fr', sender = 'Jean <jean@acme-industrie.fr>') {
  repos.sales.discover({ batchId: 'B1', companyName: 'Acme Industrie', domain, discoveredAt: new Date(NOW.getTime() - 2 * 86_400_000).toISOString() });
  repos.sales.recordOutreach({ domain, kind: 'CONTACTED', recordedBy: 'test', channel: 'EMAIL', recordedAt: new Date(NOW.getTime() - 86_400_000).toISOString() });
  const { conversation } = repos.conversations.open({ domain, companyName: 'Acme Industrie', channel: 'email', destination: `contact@${domain}` });
  repos.conversations.recordInboundEvent({
    conversationId: conversation.id, kind: 'EMAIL_REPLY', classification: 'REPLIED', confidence: 0.9, occurredAt: new Date(NOW.getTime() - 1_800_000).toISOString(),
    source: 'gmail (THREAD)', rawSubject: 'Re: votre message', sender, bodyExcerpt: 'Bonjour, oui cela nous intéresse, proposez-moi un créneau la semaine prochaine.',
    humanReviewed: false, declaredStatus: null,
  });
  return conversation;
}

const today = NOW.toISOString().slice(0, 10);
const board = () => buildSalesDashboard(repos, config, { range: '30d', now: NOW, gmailConfigured: true, mailbox: GMAIL_USER });
const cycle = (now = NOW) => runAutopilotCycle(repos, config, logger, { now, trigger: 'test', observe: { providers: OFFLINE, probeClaudeCode: false, cwd: dir } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-selftest-excl-'));
  repos = createRepositories(join(dir, 'atlas.db'), logger);
  config = makeTestConfig(dir);
  process.env.GMAIL_USER = GMAIL_USER;
  process.env.GMAIL_CLIENT_ID = 'test';
  process.env.GMAIL_CLIENT_SECRET = 'test';
  process.env.GMAIL_REFRESH_TOKEN = 'test';
});

afterEach(() => {
  for (const k of ['GMAIL_USER', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']) delete process.env[k];
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('le prédicat', () => {
  test('exact, ses sous-domaines, la casse et le www — rien d’autre', () => {
    assert.equal(isTechnicalDomain('selftest.atlas.invalid'), true);
    assert.equal(isTechnicalDomain('SELFTEST.ATLAS.INVALID '), true);
    assert.equal(isTechnicalDomain('www.selftest.atlas.invalid'), true);
    assert.equal(isTechnicalDomain('gmail-loop.selftest.atlas.invalid'), true);
    assert.equal(isTechnicalDomain('gmail.com'), false, 'un hébergeur partagé n’est pas une entité technique');
    assert.equal(isTechnicalDomain('acme-industrie.fr'), false);
    assert.equal(isTechnicalDomain('nordpack-test.invalid'), false, 'un prospect de test qui ressemble à un prospect compte comme tel');
    assert.equal(isTechnicalDomain('atlas.invalid'), false);
    assert.equal(isTechnicalDomain(null), false);
    assert.equal(isTechnicalEntity({ canonicalDomain: SELF_TEST_DOMAIN }), true);
    assert.equal(isTechnicalEntity({ domain: 'acme-industrie.fr' }), false);
  });
});

describe('les données techniques restent, les chiffres les ignorent', () => {
  test('conversation, événement, accusé, registre : intacts et lisibles', () => {
    const conversation = seedSelfTest();
    assert.equal(repos.conversations.byDomain(SELF_TEST_DOMAIN)?.id, conversation.id);
    assert.equal(repos.conversations.eventsFor(conversation.id).length, 1);
    assert.equal(repos.conversations.outboundReceipts(conversation.id)[0]?.externalThreadId, '1a0bf72634a525e5');
    assert.deepEqual(repos.conversations.knownThreadIds(conversation.id), ['1a0bf72634a525e5']);
    assert.equal(repos.sales.ledgerFor(SELF_TEST_DOMAIN)?.kind, 'CONTACTED');
    assert.equal(repos.salesLoop.sentSince(EPOCH), 1, 'le registre des envois dit toujours ce qui est parti');
    assert.ok(repos.conversations.all().some((c) => c.canonicalDomain === SELF_TEST_DOMAIN), 'toujours là pour l’audit');
  });

  test('seul en base : 0 contacté, 0 réponse, 0 réponse chaude, rien pour le fondateur, entonnoir vide', () => {
    seedSelfTest();
    const b = board();
    assert.equal(b.funnel.find((f) => f.stage === 'contacted')?.count, 0);
    assert.equal(b.funnel.find((f) => f.stage === 'replied')?.count, 0);
    assert.equal(b.todo.hotLeads, 0);
    assert.equal(b.hotLeadsTotal, 0);
    assert.deepEqual(b.hotLeads, []);
    assert.equal(b.todo.total, 0);
    const snapshot = todaySnapshot(repos, today);
    assert.equal(snapshot.contacted, 0);
    assert.equal(snapshot.replies, 0);
    assert.equal(snapshot.positiveReplies, 0);
    assert.equal(pipelineSnapshot(repos, today).contacted, 0);
    assert.equal(pipelineSnapshot(repos, today).interested, 0);
    assert.deepEqual(collectNeedsYou({ repos, today }).filter((i) => i.kind === 'CLIENT_REPLY'), []);
  });

  test('avec un vrai prospect à côté : lui seul compte, et compte entièrement', () => {
    seedSelfTest();
    seedRealProspect();
    const b = board();
    assert.equal(b.funnel.find((f) => f.stage === 'contacted')?.count, 1);
    assert.equal(b.funnel.find((f) => f.stage === 'replied')?.count, 1);
    assert.equal(b.todo.hotLeads, 1);
    assert.deepEqual(b.hotLeads.map((h) => h.domain), ['acme-industrie.fr']);
    assert.equal(todaySnapshot(repos, today).contacted, 1);
    assert.equal(todaySnapshot(repos, today).replies, 1);
    const needs = collectNeedsYou({ repos, today }).filter((i) => i.kind === 'CLIENT_REPLY');
    assert.equal(needs.length, 1);
    assert.match(needs[0]!.what, /Acme Industrie/);
  });

  test('un vrai prospect hébergé chez Gmail compte, et la protection des hébergeurs partagés ne bouge pas', () => {
    seedSelfTest();
    seedRealProspect('dupont-menuiserie.fr', 'Jean Dupont <jean.dupont@gmail.com>');
    const b = board();
    assert.equal(b.todo.hotLeads, 1);
    assert.deepEqual(b.hotLeads.map((h) => h.domain), ['dupont-menuiserie.fr']);
    // Un inconnu chez Gmail, sans fil connu, ne se rattache à personne — comme avant.
    const result = matchIncoming(
      { from: 'Quelqu’un <quelquun@gmail.com>', threadId: 'thr-inconnu' },
      repos.conversations.all().map((c) => ({ canonicalDomain: c.canonicalDomain, companyName: c.companyName, outreachDestination: c.destination, knownThreadIds: repos.conversations.knownThreadIds(c.id), knownMessageIds: repos.conversations.knownMessageIds(c.id) })),
    );
    assert.equal(result.candidate, null);
    assert.match(result.reason, /hébergeur partagé/);
  });
});

describe('l’Autopilot ne voit pas d’occasion commerciale dans le self-test', () => {
  test('seul en base : aucune action BLOCKED_WORK / REVENUE / CONVERSION, aucune relance ; le vrai prospect en crée', async () => {
    seedSelfTest();
    const seul = await cycle();
    assert.equal(seul.observation.conversations.awaitingReply, 0);
    assert.equal(seul.observation.sales.hotLeadsOpen, 0);
    assert.equal(seul.observation.sales.contacted, 0);
    assert.equal(seul.observation.sales.followUpsDue, 0);
    assert.ok(!seul.considered.some((c) => ['REVENUE', 'BLOCKED_WORK', 'CONVERSION'].includes(c.category) && !/Gmail/.test(c.objective)), JSON.stringify(seul.considered));
    assert.ok(!seul.considered.some((c) => /attend une réponse/.test(c.objective)));
    assert.ok(!seul.considered.some((c) => /relance/.test(c.objective)));

    seedRealProspect();
    const avec = await cycle(new Date(NOW.getTime() + 60_000));
    assert.equal(avec.observation.conversations.awaitingReply, 1);
    assert.equal(avec.observation.sales.hotLeadsOpen, 1);
    assert.ok(avec.considered.some((c) => c.category === 'REVENUE' && /réponse\(s\) chaude\(s\)/.test(c.objective)));
    assert.ok(avec.considered.some((c) => c.category === 'BLOCKED_WORK' && /attend une réponse/.test(c.objective)));
    assert.equal(repos.salesLoop.sentSince(EPOCH), 1, 'le seul envoi est le self-test d’avant : rien ne part');
    assert.ok(!repos.tasks.list({ limit: 100 }).some((t) => t.taskType === 'SALES_SEND'));
  });

  test('une action historique née du self-test se ferme d’elle-même quand la condition a disparu — sans toucher aux cycles passés', async () => {
    seedSelfTest();
    // L'action telle que v4.6.0 l'a créée en production, avant la correction.
    const ancien = repos.autopilot.startCycle({ trigger: 'v4.6.0', startedAt: new Date(NOW.getTime() - 3_600_000).toISOString() });
    const fp = fingerprintOf({ category: 'BLOCKED_WORK', objective: 'x', fingerprintKey: 'BLOCKED_WORK:awaiting-reply' });
    const { action } = repos.autopilot.propose({
      cycleId: ancien.id, fingerprint: fp, objective: "traiter 1 conversation(s) où quelqu'un attend une réponse", category: 'BLOCKED_WORK', allocation: 'EXPLOIT',
      score: 133.3, proposal: { execution: { kind: 'FOUNDER_DECISION', command: 'npm run sales:inbox' } }, recommendedAgent: 'HUMAN', requiresHumanApproval: true,
      reason: 'une réponse qui attend bloque un dossier client ou prospect', status: 'WAITING_HUMAN',
    });
    repos.autopilot.finishCycle(ancien.id, { status: 'DONE', decisions: [{ objective: action.objective, decision: 'CREATED' }], actionsCreated: [action.id], summary: 'avant la correction' });
    assert.equal(summariseAutopilot(repos, config, NOW).topObjective, action.objective, 'avant : en tête des priorités');

    const report = await cycle();
    const apres = repos.autopilot.action(action.id)!;
    assert.equal(apres.status, 'DONE');
    assert.equal(apres.result?.stale, true);
    assert.match(apres.reason, /condition disparue/);
    assert.ok(report.verified.some((v) => v.actionId === action.id && v.to === 'DONE'));
    assert.ok(!report.created.some((a) => a.fingerprint === fp), 'pas recréée');
    assert.notEqual(summariseAutopilot(repos, config, NOW).topObjective, action.objective, 'plus en tête');
    // Le cycle historique n'a pas bougé.
    const historique = repos.autopilot.cycle(ancien.id)!;
    assert.equal(historique.summary, 'avant la correction');
    assert.deepEqual(historique.actionsCreated, [action.id]);
    // Et si un vrai prospect répond ensuite, l'occasion revient sans attendre : une fermeture « sans objet » n'est pas un « déjà fait ».
    seedRealProspect();
    const retour = await cycle(new Date(NOW.getTime() + 120_000));
    assert.ok(retour.created.some((a) => a.fingerprint === fp && a.status === 'WAITING_HUMAN'), JSON.stringify(retour.decisions));
    assert.equal(repos.salesLoop.sentSince(EPOCH), 1);
  });
});
