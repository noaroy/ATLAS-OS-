import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLogger } from '../../core/src/logger.ts';
import { createRepositories } from '../../data/src/index.ts';
import type { OutboundAuthorization } from '../../intelligence/src/index.ts';
import { gmailSendReadiness, summariseReadiness, GMAIL_AUTH_AREA, GMAIL_SEND_AREA, type CheckLine } from '../src/readiness.ts';

/**
 * Le contrôle de production sépare l'autorisation d'envoi de la porte.
 *
 * Relevé sur le VPS (v4.5.2) : gmail.send accordée et constatée par
 * `gmail-check`, `ATLAS_OUTBOUND_ENABLED=false` par décision — et le contrôle
 * affichait « GMAIL_AUTH_SEND : OUTBOUND_DISABLED — la portée gmail.send doit
 * être accordée », EXTERNAL_INTEGRATIONS = ACTION_REQUIRED. Faux sur les deux
 * plans : la portée était là, et la porte fermée est un verrou d'exploitation,
 * pas un défaut d'intégration.
 *
 * Ici, chaque combinaison est jouée sur la règle pure, puis résumée comme le
 * contrôle la résume. MESSAGES SENT : 0 partout — la règle ne sait pas envoyer.
 */

const ROOT = resolve(import.meta.dirname, '../../..');
const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
const SEND = 'https://www.googleapis.com/auth/gmail.send';

const authOf = (over: Partial<OutboundAuthorization> = {}): OutboundAuthorization => ({
  credentials: true, verified: true, granted: [READONLY, SEND], readScope: 'GRANTED', sendScope: 'GRANTED',
  authReady: true, outboundEnabled: false, code: 'GMAIL_SEND_AUTH_READY', ...over,
});
const verdictsOf = (lines: CheckLine[]) => Object.fromEntries(lines.map((l) => [l.name, l.verdict]));
const lineOf = (lines: CheckLine[], name: string) => lines.find((l) => l.name === name)!;
/** Le reste d'un contrôle sain, pour résumer comme le vrai contrôle. */
const socle: CheckLine[] = [
  { area: 'CORE', name: 'file', verdict: 'PASS', detail: '' },
  { area: 'DEPLOYMENT', name: 'compose', verdict: 'PASS', detail: '' },
  { area: 'LIVE DEPLOYMENT', name: 'serveur joignable', verdict: 'PASS', detail: '' },
];

describe('gmail.send présente + ATLAS_OUTBOUND_ENABLED=false', () => {
  test('AUTH PASS sur toute la ligne, OUTBOUND_SWITCH PAUSED — et EXTERNAL_INTEGRATIONS reste COMPLETE', () => {
    const lines = gmailSendReadiness({ auth: authOf(), inboxConfigured: true, tokenError: null, engineMode: 'INTERNAL_TEST', messagesSent: 0 });
    assert.deepEqual(verdictsOf(lines), {
      GMAIL_AUTH_READ: 'PASS', GMAIL_AUTH_SEND: 'PASS', GMAIL_SEND_SCOPE: 'PASS', AUTH_READY: 'PASS',
      OUTBOUND_SWITCH: 'PAUSED', ENGINE_MODE: 'PAUSED', MESSAGES_SENT: 'PASS',
    });
    assert.equal(lineOf(lines, 'GMAIL_AUTH_SEND').area, GMAIL_AUTH_AREA);
    assert.equal(lineOf(lines, 'OUTBOUND_SWITCH').area, GMAIL_SEND_AREA);
    assert.match(lineOf(lines, 'OUTBOUND_SWITCH').detail, /ATLAS_OUTBOUND_ENABLED=false/);
    assert.match(lineOf(lines, 'OUTBOUND_SWITCH').detail, /verrou d’exploitation/);
    assert.match(lineOf(lines, 'OUTBOUND_SWITCH').detail, /ce n’est pas un défaut d’intégration Gmail/);
    assert.equal(lineOf(lines, 'OUTBOUND_SWITCH').category, 'OPERATIONAL_CONFIRMATION');
    assert.match(lineOf(lines, 'AUTH_READY').detail, /l’interrupteur ne change rien à ce fait/);
    assert.match(lineOf(lines, 'MESSAGES_SENT').detail, /^0 message\(s\) réellement parti\(s\)/);
    assert.ok(!lines.some((l) => /doit être accordée|doit etre accordee/.test(l.detail)), 'plus jamais « la portée doit être accordée » sur une portée présente');

    const r = summariseReadiness([...socle, ...lines], { kind: 'docker-cli' });
    assert.equal(r.integrations, 'COMPLETE', r.integrationsPending.join(', '));
    assert.deepEqual(r.integrationsPending, []);
    assert.deepEqual(r.operationalLocks, ['OUTBOUND_SWITCH', 'ENGINE_MODE']);
    assert.equal(r.software, 'READY');
    assert.equal(r.unknowns, 0);
  });
});

describe('gmail.send absente', () => {
  test('lecture seule sur le jeton : AUTH_SEND, GMAIL_SEND_SCOPE et AUTH_READY MANUEL, lecture PASS — et c’est bien une intégration en attente', () => {
    const lines = gmailSendReadiness({
      auth: authOf({ granted: [READONLY], sendScope: 'MISSING', authReady: false, code: 'GMAIL_SEND_SCOPE_MISSING' }),
      inboxConfigured: true, tokenError: null, engineMode: 'INTERNAL_TEST', messagesSent: 0,
    });
    assert.deepEqual(verdictsOf(lines), {
      GMAIL_AUTH_READ: 'PASS', GMAIL_AUTH_SEND: 'MANUAL_ACTION_REQUIRED', GMAIL_SEND_SCOPE: 'MANUAL_ACTION_REQUIRED', AUTH_READY: 'MANUAL_ACTION_REQUIRED',
      OUTBOUND_SWITCH: 'PAUSED', ENGINE_MODE: 'PAUSED', MESSAGES_SENT: 'PASS',
    });
    assert.match(lineOf(lines, 'GMAIL_AUTH_SEND').detail, /GMAIL_SEND_SCOPE_MISSING — gmail\.send absente du jeton : npm run gmail:authorize -- --with-send/);
    const r = summariseReadiness([...socle, ...lines], { kind: 'docker-cli' });
    assert.equal(r.integrations, 'ACTION_REQUIRED');
    assert.deepEqual(r.integrationsPending, ['GMAIL_AUTH_SEND', 'GMAIL_SEND_SCOPE', 'AUTH_READY']);
  });

  test('jeton refusé par Google : AUTH_REQUIRED sur la lecture et l’envoi, avec le motif — jamais FAIL, le code n’est pas en cause', () => {
    const lines = gmailSendReadiness({
      auth: authOf({ verified: false, granted: [], readScope: 'UNVERIFIED', sendScope: 'UNVERIFIED', authReady: false, code: 'GMAIL_SEND_SCOPE_UNVERIFIED' }),
      inboxConfigured: true, tokenError: 'échange de jeton refusé (HTTP 400)', engineMode: 'INTERNAL_TEST', messagesSent: 0,
    });
    assert.equal(lineOf(lines, 'GMAIL_AUTH_READ').verdict, 'MANUAL_ACTION_REQUIRED');
    assert.match(lineOf(lines, 'GMAIL_AUTH_READ').detail, /AUTH_REQUIRED — échange de jeton refusé par Google : échange de jeton refusé \(HTTP 400\)/);
    assert.equal(lineOf(lines, 'GMAIL_AUTH_SEND').verdict, 'MANUAL_ACTION_REQUIRED');
    assert.match(lineOf(lines, 'GMAIL_AUTH_SEND').detail, /GMAIL_SEND_SCOPE_UNVERIFIED/);
    assert.ok(!lines.some((l) => l.verdict === 'FAIL'));
  });

  test('identifiants absents : GMAIL_NOT_CONFIGURED des deux côtés, gmail:authorize comme seule action', () => {
    const lines = gmailSendReadiness({
      auth: authOf({ credentials: false, verified: false, granted: [], readScope: 'UNVERIFIED', sendScope: 'UNVERIFIED', authReady: false, code: 'GMAIL_NOT_CONFIGURED' }),
      inboxConfigured: false, tokenError: null, engineMode: 'INTERNAL_TEST', messagesSent: 0,
    });
    assert.match(lineOf(lines, 'GMAIL_AUTH_READ').detail, /GMAIL_NOT_CONFIGURED/);
    assert.match(lineOf(lines, 'GMAIL_AUTH_SEND').detail, /GMAIL_NOT_CONFIGURED/);
    assert.equal(lineOf(lines, 'AUTH_READY').verdict, 'MANUAL_ACTION_REQUIRED');
  });
});

describe('gmail.send présente + ATLAS_OUTBOUND_ENABLED=true (valeur de test, jamais la configuration réelle)', () => {
  test('en PRODUCTION : OUTBOUND_SWITCH ARMED, aucun verrou, tout READY — et toujours 0 message', () => {
    const lines = gmailSendReadiness({ auth: authOf({ outboundEnabled: true }), inboxConfigured: true, tokenError: null, engineMode: 'PRODUCTION', messagesSent: 0 });
    assert.deepEqual(verdictsOf(lines), {
      GMAIL_AUTH_READ: 'PASS', GMAIL_AUTH_SEND: 'PASS', GMAIL_SEND_SCOPE: 'PASS', AUTH_READY: 'PASS',
      OUTBOUND_SWITCH: 'PASS', ENGINE_MODE: 'PASS', MESSAGES_SENT: 'PASS',
    });
    assert.match(lineOf(lines, 'OUTBOUND_SWITCH').detail, /^ARMED — ATLAS_OUTBOUND_ENABLED=true/);
    const r = summariseReadiness([...socle, ...lines], { kind: 'docker-cli' });
    assert.equal(r.integrations, 'COMPLETE');
    assert.deepEqual(r.operationalLocks, []);
    assert.match(lineOf(lines, 'MESSAGES_SENT').detail, /^0 message/);
    assert.notEqual(process.env.ATLAS_OUTBOUND_ENABLED, 'true', 'la configuration réelle du processus n’a pas bougé');
  });

  test('en INTERNAL_TEST : OAuth PASS, porte ARMED, mais ENGINE_MODE PAUSED — l’envoi reste bloqué par la politique', () => {
    const lines = gmailSendReadiness({ auth: authOf({ outboundEnabled: true }), inboxConfigured: true, tokenError: null, engineMode: 'INTERNAL_TEST', messagesSent: 0 });
    assert.equal(lineOf(lines, 'GMAIL_AUTH_SEND').verdict, 'PASS');
    assert.equal(lineOf(lines, 'AUTH_READY').verdict, 'PASS');
    assert.equal(lineOf(lines, 'OUTBOUND_SWITCH').verdict, 'PASS');
    assert.equal(lineOf(lines, 'ENGINE_MODE').verdict, 'PAUSED');
    assert.match(lineOf(lines, 'ENGINE_MODE').detail, /ATLAS_ENGINE_MODE=INTERNAL_TEST : la politique d’envoi refuse tout envoi réel \(INTERNAL_TEST_MODE\)/);
    assert.match(lineOf(lines, 'ENGINE_MODE').detail, /pas un problème OAuth/);
    const r = summariseReadiness([...socle, ...lines], { kind: 'docker-cli' });
    assert.equal(r.integrations, 'COMPLETE');
    assert.deepEqual(r.operationalLocks, ['ENGINE_MODE']);
  });
});

describe('MESSAGES SENT, d’après le registre', () => {
  test('les issues SENT de l’expéditeur à blanc (dry-run-N) ne sont pas des messages partis', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-sent-'));
    const repos = createRepositories(join(dir, 'atlas.db'), createLogger({ level: 'error', pretty: false }));
    try {
      const EPOCH = '1970-01-01T00:00:00.000Z';
      assert.deepEqual(repos.salesLoop.realSentSince(EPOCH), { real: 0, simulated: 0, unattributed: 0 });
      const simule = repos.salesLoop.claimSend({ domain: 'a.fr', recipient: 'a@a.fr', subject: 's', body: 'b', purpose: 'FIRST_TOUCH', claimedBy: 'test' });
      repos.salesLoop.recordSendResult({ idempotencyKey: simule.idempotencyKey, phase: 'SENT', externalMessageId: 'dry-run-1' });
      assert.deepEqual(repos.salesLoop.realSentSince(EPOCH), { real: 0, simulated: 1, unattributed: 0 });
      assert.equal(repos.salesLoop.sentSince(EPOCH), 1, 'le compte du registre, lui, plafonne la cadence et garde la simulation');
      const lines = gmailSendReadiness({ auth: authOf(), inboxConfigured: true, tokenError: null, engineMode: 'INTERNAL_TEST', ...(() => { const e = repos.salesLoop.realSentSince(EPOCH); return { messagesSent: e.real, simulatedSends: e.simulated }; })() });
      assert.match(lineOf(lines, 'MESSAGES_SENT').detail, /^0 message\(s\) réellement parti\(s\) d’après le registre des envois · 1 envoi\(s\) simulé\(s\)/);
      const reel = repos.salesLoop.claimSend({ domain: 'b.fr', recipient: 'b@b.fr', subject: 's', body: 'b', purpose: 'FIRST_TOUCH', claimedBy: 'test' });
      repos.salesLoop.recordSendResult({ idempotencyKey: reel.idempotencyKey, phase: 'SENT', externalMessageId: '18f2c3a9e1b7d4f0' });
      assert.deepEqual(repos.salesLoop.realSentSince(EPOCH), { real: 1, simulated: 1, unattributed: 0 });
      // Une issue sans accusé n'est ni réelle ni simulée : de provenance inconnue, dite telle quelle.
      const inconnu = repos.salesLoop.claimSend({ domain: 'c.fr', recipient: 'c@c.fr', subject: 's', body: 'b', purpose: 'FIRST_TOUCH', claimedBy: 'test' });
      repos.salesLoop.recordSendResult({ idempotencyKey: inconnu.idempotencyKey, phase: 'SENT' });
      assert.deepEqual(repos.salesLoop.realSentSince(EPOCH), { real: 1, simulated: 1, unattributed: 1 });
      const e = repos.salesLoop.realSentSince(EPOCH);
      const ligne = lineOf(gmailSendReadiness({ auth: authOf(), inboxConfigured: true, tokenError: null, engineMode: 'INTERNAL_TEST', messagesSent: e.real, simulatedSends: e.simulated, unattributedSends: e.unattributed }), 'MESSAGES_SENT').detail;
      assert.match(ligne, /^1 message\(s\) réellement parti\(s\)/);
      assert.match(ligne, / · 1 envoi\(s\) simulé\(s\) par l’expéditeur à blanc, jamais partis/);
      assert.match(ligne, / · 1 issue\(s\) SENT sans accusé, provenance inconnue/);
    } finally {
      repos.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ce que le contrôle lit, et ce qu’il ne fait pas', () => {
  const source = readFileSync(join(ROOT, 'scripts', 'atlas-production-check.ts'), 'utf8');

  test('l’autorisation vient de authorization() après verifyScopes() — jamais de status().configured, jamais du transport', () => {
    assert.match(source, /await expediteur\.verifyScopes\(\);/);
    assert.match(source, /const autorisation = expediteur\.authorization\(\);/);
    assert.match(source, /gmailSendReadiness\(\{/);
    assert.ok(!/outbound\.configured \? 'PASS' : 'MANUAL_ACTION_REQUIRED'/.test(source), 'GMAIL_AUTH_SEND et AUTH_READY ne se lisent plus sur la porte');
    assert.ok(!/\.sendEmail\(|\.replyToThread\(/.test(source), 'le contrôle n’appelle jamais le transport : MESSAGES SENT 0 par construction');
    assert.ok(!/la portee gmail\.send doit etre accordee/.test(source));
    assert.match(source, /realSentSince\('1970-01-01T00:00:00\.000Z'\)/, 'MESSAGES SENT compte les messages partis, pas les simulations');
  });

  test('PAUSED est un verdict du contrôle : rendu, compté à part, jamais dans les actions manuelles', () => {
    assert.match(source, /PAUSED: `\$\{c\.amber\}PAUSED\$\{c\.reset\}`/);
    assert.match(source, /OPERATIONAL LOCKS\s+= \$\{locks\.length\}/);
    assert.match(source, /VERROUS D’EXPLOITATION/);
    assert.match(source, /GMAIL_SEND\s+= /, 'la ligne de synthèse GMAIL_SEND existe');
  });
});
