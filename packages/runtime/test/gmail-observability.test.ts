import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLogger } from '../../core/src/logger.ts';
import type { AtlasConfig } from '../../core/src/index.ts';
import { createRepositories, type Repositories } from '../../data/src/index.ts';
import { makeTestConfig } from '../../testing/src/index.ts';
import { FixtureInboxProvider, mailMessage, type MailInboxProvider, type MailOutboundProvider, type MailMessage } from '../../intelligence/src/index.ts';
import type { WorkerContext } from '../src/index.ts';
import { buildSalesDashboard, gmailLightOf, GMAIL_EVIDENCE_MAX_AGE_MINUTES } from '../src/sales-dashboard.ts';
import { createSalesEngineHandlers, SALES_ENGINE_TASKS } from '../src/sales-engine.ts';

/**
 * Le feu Gmail dit l'état réel — pas l'absence de travail.
 *
 * Relevé sur le VPS (v4.5.1) : Gmail authentifié, `gmail-check` et
 * `gmail-read-check` passés, `inbox-sync` répondant « aucune conversation
 * ouverte : rien à rapprocher » — et `atlas-status` affichant
 * « Gmail DOWN — synchronisation impossible dans l’heure ». Le feu confondait
 * « rien à synchroniser » avec « impossible de synchroniser » : toute friction
 * de l'heure valait panne, sans dire laquelle.
 *
 * Ici, chaque état est rejoué comme le daemon le produit — tâche créée, prise,
 * exécutée par le worker, consignée — puis lu par le tableau de bord :
 *
 *   identifiants présents + 0 conversation  → READY_IDLE, jamais DOWN
 *   synchronisation récente réussie          → READY
 *   erreur réelle (jeton refusé, API)        → DOWN, avec le motif
 *   jamais tenté                             → UNKNOWN
 *   daemon sans identifiants, présents ici   → DOWN, avec l'explication
 *   preuve trop ancienne                     → STALE
 *
 * Et à chaque fois : MESSAGES SENT = 0.
 */

const ROOT = resolve(import.meta.dirname, '../../..');
const logger = createLogger({ level: 'error', pretty: false });
const EPOCH = '1970-01-01T00:00:00.000Z';
const OWNER = 'daemon-test';
const context: WorkerContext = { logger, heartbeat: () => true, shuttingDown: () => false, correlationId: null };

let dir: string;
let repos: Repositories;
let config: AtlasConfig;
let sent = 0;

/** Un expéditeur qui compte : la seule preuve recevable que rien n'est parti. */
const outbound = async (): Promise<MailOutboundProvider> => ({
  id: 'counting',
  status: () => ({ configured: true, code: 'READY', detail: 'test', scopes: [] }),
  async sendEmail() { sent += 1; throw new Error('aucun envoi attendu'); },
  async replyToThread() { sent += 1; throw new Error('aucun envoi attendu'); },
});

/** Une boîte configurée dont la lecture échoue réellement. */
const brokenInbox = (message: string): MailInboxProvider => ({
  id: 'gmail',
  status: () => ({ configured: true, code: 'GMAIL_READY', detail: 'boîte test', scopes: [] }),
  async list() { throw new Error(message); },
});

const blindInbox = (): MailInboxProvider => ({
  id: 'gmail',
  status: () => ({ configured: false, code: 'GMAIL_NOT_CONFIGURED', detail: 'variable(s) absente(s) : GMAIL_REFRESH_TOKEN', scopes: [] }),
  async list() { return []; },
});

/**
 * Un cycle de lecture, tel que le daemon le joue : la tâche est créée, prise
 * sous bail, confiée au worker, et son issue consignée — DONE avec le résultat,
 * ou échec avec reprise puis abandon.
 */
async function daemonCycle(inbox: () => MailInboxProvider, maxAttempts = 3) {
  const { task } = repos.tasks.create({
    taskType: SALES_ENGINE_TASKS.REPLY_SYNC, department: 'sales', workerType: 'DETERMINISTIC', maxAttempts,
    availableAt: new Date(Date.now() - 1_000).toISOString(),
  });
  const claimed = repos.tasks.claim({ owner: OWNER, leaseMs: 60_000, workerTypes: ['DETERMINISTIC'] }).task;
  assert.equal(claimed?.taskId, task.taskId, 'la tâche du cycle est prise');
  const handlers = createSalesEngineHandlers({ repos, config, logger, inbox, outbound });
  const outcome = await handlers[SALES_ENGINE_TASKS.REPLY_SYNC]!(claimed!, context);
  if (outcome.kind === 'DONE') repos.tasks.complete(task.taskId, outcome.result ?? {}, OWNER, null);
  else if (outcome.kind === 'FAILED') repos.tasks.fail({ taskId: task.taskId, actor: OWNER, errorCode: outcome.errorCode ?? 'UNKNOWN', errorMessage: outcome.errorMessage ?? 'échec sans motif' });
  else assert.fail(`issue inattendue : ${outcome.kind}`);
  return { outcome, task: repos.tasks.byId(task.taskId)! };
}

const gmail = (options: { now?: Date; configured?: boolean } = {}) =>
  buildSalesDashboard(repos, config, { range: '7d', now: options.now, gmailConfigured: options.configured ?? true, mailbox: 'commercial@atlas.example' }).system.gmail;

const assertNothingSent = () => {
  assert.equal(sent, 0, 'MESSAGES SENT: 0 — l’expéditeur n’a jamais été sollicité');
  assert.equal(repos.salesLoop.sentSince(EPOCH), 0, 'MESSAGES SENT: 0 — aucun envoi consigné');
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-gmail-obs-'));
  repos = createRepositories(join(dir, 'atlas.db'), logger);
  config = makeTestConfig(dir);
  sent = 0;
  process.env.GMAIL_USER = 'commercial@atlas.example';
});

afterEach(() => {
  delete process.env.GMAIL_USER;
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('identifiants présents, aucune conversation ouverte', () => {
  test('le passage est consigné comme oisif : aucune friction, READY_IDLE, jamais DOWN — même répété', async () => {
    assert.equal(repos.conversations.all().length, 0);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const { outcome, task } = await daemonCycle(() => new FixtureInboxProvider([]));
      assert.equal(outcome.kind, 'DONE');
      assert.equal(task.status, 'DONE');
      assert.equal(task.result?.ran, false);
      assert.equal(task.result?.configured, true, 'le résultat dit que la boîte était configurée');
      assert.match(String(task.result?.skipped), /aucune conversation ouverte/);
      assert.equal(repos.salesEngine.frictions({ kind: 'GMAIL_UNAVAILABLE' }).length, 0, 'rien à faire n’est pas une friction');
      const light = gmail();
      assert.equal(light.code, 'READY_IDLE', light.detail);
      assert.equal(light.state, 'ok');
      assert.notEqual(light.state, 'down');
      assert.match(light.detail, /identifiants présents · aucune conversation ouverte/);
      assert.ok(light.lastAttemptAt, 'la tentative qui fonde le verdict est datée');
    }
    assertNothingSent();
  });
});

describe('synchronisation récente réussie', () => {
  test('le daemon a lu la boîte jusqu’au bout : READY, avec le nombre de messages lus', async () => {
    repos.conversations.open({ domain: 'acme-industrie.fr', companyName: 'Acme Industrie', channel: 'email', destination: 'contact@acme-industrie.fr' });
    const messages: MailMessage[] = [
      mailMessage({ messageId: 'm1', from: 'Jean <jean@acme-industrie.fr>', subject: 'RE: Acme Industrie', bodyText: 'Merci, rappelez-moi.', receivedAt: new Date().toISOString() }),
    ];
    const { task } = await daemonCycle(() => new FixtureInboxProvider(messages));
    assert.equal(task.status, 'DONE');
    assert.equal(task.result?.ran, true);
    const light = gmail();
    assert.equal(light.code, 'READY', light.detail);
    assert.equal(light.state, 'ok');
    assert.match(light.detail, /synchronisation réussie il y a 0 min · 1 message\(s\) lu\(s\)/);
    assertNothingSent();
  });

  test('une lecture faite par la commande inbox-sync (curseur avancé, sans tâche du daemon) vaut aussi READY', () => {
    repos.conversations.advanceSyncCheckpoint({ provider: 'gmail', mailbox: 'commercial@atlas.example', lastReceivedAt: new Date().toISOString(), messagesSeen: 4 });
    const light = gmail();
    assert.equal(light.code, 'READY', light.detail);
    assert.match(light.detail, /4 message\(s\) vu\(s\)/);
    assertNothingSent();
  });

  test('un échec puis une lecture réussie : READY, mais dégradé tant que l’échec est dans l’heure', async () => {
    repos.conversations.open({ domain: 'acme-industrie.fr', companyName: 'Acme Industrie', channel: 'email', destination: 'contact@acme-industrie.fr' });
    await daemonCycle(() => brokenInbox('HTTP 503 — Gmail indisponible'));
    assert.equal(gmail().code, 'DOWN');
    await daemonCycle(() => new FixtureInboxProvider([]));
    const light = gmail();
    assert.equal(light.code, 'READY', light.detail);
    assert.equal(light.state, 'warn');
    assert.match(light.detail, /1 échec\(s\) dans l’heure/);
    assertNothingSent();
  });
});

describe('erreur réelle : jeton refusé, API injoignable', () => {
  test('la lecture échoue : friction consignée, tâche en échec, DOWN avec le motif — dès la première tentative', async () => {
    repos.conversations.open({ domain: 'acme-industrie.fr', companyName: 'Acme Industrie', channel: 'email', destination: 'contact@acme-industrie.fr' });
    const { outcome, task } = await daemonCycle(() => brokenInbox('HTTP 401 — invalid_grant : jeton révoqué ou expiré'));
    assert.equal(outcome.kind, 'FAILED');
    assert.equal(task.status, 'RETRY_SCHEDULED', 'la tâche sera reprise : elle n’est pas terminée');
    assert.equal(repos.salesEngine.frictions({ kind: 'GMAIL_UNAVAILABLE' }).length, 1);
    const light = gmail();
    assert.equal(light.code, 'DOWN', light.detail);
    assert.equal(light.state, 'down');
    assert.match(light.detail, /dernière tentative échouée il y a 0 min : .*HTTP 401 — invalid_grant/);
    assert.ok(!/GMAIL_REFRESH_TOKEN=|ya29|refresh_token=/.test(light.detail), 'aucun secret dans le détail');
    assertNothingSent();
  });

  test('après la dernière tentative, la tâche abandonnée porte le motif : DOWN', async () => {
    repos.conversations.open({ domain: 'acme-industrie.fr', companyName: 'Acme Industrie', channel: 'email', destination: 'contact@acme-industrie.fr' });
    const { task } = await daemonCycle(() => brokenInbox('ECONNRESET — réseau'), 1);
    assert.equal(task.status, 'FAILED');
    assert.equal(task.errorCode, 'GMAIL_SYNC_FAILED');
    assert.equal(repos.tasks.lastFinishedOfType(SALES_ENGINE_TASKS.REPLY_SYNC)?.taskId, task.taskId);
    const light = gmail();
    assert.equal(light.code, 'DOWN');
    assert.match(light.detail, /ECONNRESET/);
    assertNothingSent();
  });

  test('le daemon ne voit pas les identifiants alors qu’ils sont présents ici : DOWN, et le feu dit pourquoi', async () => {
    const { task } = await daemonCycle(blindInbox);
    assert.equal(task.status, 'DONE');
    assert.equal(task.result?.configured, false);
    assert.equal(repos.salesEngine.frictions({ kind: 'GMAIL_UNAVAILABLE' }).length, 1);
    const light = gmail({ configured: true });
    assert.equal(light.code, 'DOWN', light.detail);
    assert.match(light.detail, /le daemon ne voit pas les identifiants \(GMAIL_NOT_CONFIGURED — variable\(s\) absente\(s\) : GMAIL_REFRESH_TOKEN\)/);
    assert.match(light.detail, /environnement antérieur/);
    assertNothingSent();
  });
});

describe('jamais vérifié', () => {
  test('identifiants présents, aucune tentative consignée : UNKNOWN — ni READY ni DOWN', () => {
    const light = gmail();
    assert.equal(light.code, 'UNKNOWN', light.detail);
    assert.equal(light.state, 'warn');
    assert.equal(light.lastAttemptAt, null);
    assert.match(light.detail, /jamais vérifié/);
    assertNothingSent();
  });

  test('sans identifiants ici : OFF, quoi que dise la base', async () => {
    await daemonCycle(() => new FixtureInboxProvider([]));
    const light = gmail({ configured: false });
    assert.equal(light.code, 'OFF');
    assert.equal(light.state, 'off');
  });
});

describe('preuve trop ancienne', () => {
  test('un passage oisif il y a trois heures ne prouve plus rien : STALE, pas DOWN, pas READY_IDLE', async () => {
    await daemonCycle(() => new FixtureInboxProvider([]));
    const later = new Date(Date.now() + (GMAIL_EVIDENCE_MAX_AGE_MINUTES + 90) * 60_000);
    const light = gmail({ now: later });
    assert.equal(light.code, 'STALE', light.detail);
    assert.equal(light.state, 'warn');
    assert.match(light.detail, /aucune lecture depuis 3 h .* dernier constat : rien à synchroniser/);
    assertNothingSent();
  });
});

describe('la règle, isolée des tables', () => {
  const now = new Date('2026-09-19T10:00:00.000Z');
  const minutes = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
  const doneTask = (finishedAt: string, result: Record<string, unknown>) => ({
    taskId: 'tsk', taskType: SALES_ENGINE_TASKS.REPLY_SYNC, department: 'sales', workerType: 'DETERMINISTIC', priority: 0, status: 'DONE' as const,
    payload: {}, result, createdAt: finishedAt, availableAt: finishedAt, startedAt: finishedAt, finishedAt,
    attemptCount: 1, maxAttempts: 3, leaseOwner: null, leaseUntil: null, lastHeartbeatAt: null, parentTaskId: null,
    correlationId: null, idempotencyKey: null, estimatedCost: null, actualCost: null, errorCode: null, errorMessage: null,
    metadata: {}, chainId: null, chainDepth: 0, fingerprint: null,
  });
  const failure = (createdAt: string, detail: string) => ({ id: 'frc', kind: 'GMAIL_UNAVAILABLE' as const, domain: null, segmentId: null, detail, createdAt });
  const base = { configured: true, lastTask: null, lastFailure: null, failuresInHour: 0, checkpoint: null, now };

  test('c’est la dernière tentative qui décide, pas la fenêtre d’une heure', () => {
    // Un échec il y a 50 min, un passage oisif il y a 10 min : la boîte va bien.
    const idleAfterFailure = gmailLightOf({ ...base, lastTask: doneTask(minutes(10), { ran: false, configured: true, skipped: 'aucune conversation ouverte : rien à rapprocher' }), lastFailure: failure(minutes(50), 'HTTP 503'), failuresInHour: 1 });
    assert.equal(idleAfterFailure.code, 'READY_IDLE');
    assert.equal(idleAfterFailure.state, 'warn', 'dégradé : un échec dans l’heure');
    // L'inverse — un passage réussi puis un échec — est une panne.
    const failureAfterIdle = gmailLightOf({ ...base, lastTask: doneTask(minutes(50), { ran: false, configured: true, skipped: 'aucune conversation ouverte : rien à rapprocher' }), lastFailure: failure(minutes(10), 'HTTP 401'), failuresInHour: 1 });
    assert.equal(failureAfterIdle.code, 'DOWN');
    assert.match(failureAfterIdle.detail, /HTTP 401/);
  });

  test('un résultat d’avant cette version (sans `configured`) se lit par son motif', () => {
    const blind = gmailLightOf({ ...base, lastTask: doneTask(minutes(5), { ran: false, skipped: 'GMAIL_NOT_CONFIGURED — variable(s) absente(s) : GMAIL_USER' }) });
    assert.equal(blind.code, 'DOWN');
    const idle = gmailLightOf({ ...base, lastTask: doneTask(minutes(5), { ran: false, skipped: 'aucune conversation ouverte : rien à rapprocher' }) });
    assert.equal(idle.code, 'READY_IDLE');
  });

  test('le curseur de lecture, plus récent que la tâche, fait foi', () => {
    const light = gmailLightOf({ ...base, lastTask: doneTask(minutes(30), { ran: false, configured: true, skipped: 'aucune conversation ouverte : rien à rapprocher' }), checkpoint: { lastSyncedAt: minutes(2), messagesSeen: 12 } });
    assert.equal(light.code, 'READY');
    assert.match(light.detail, /12 message\(s\) vu\(s\)/);
  });
});

describe('ce que l’opérateur lit', () => {
  test('atlas-status imprime le code Gmail en toutes lettres, avec le détail — plus jamais le seul feu', () => {
    const source = readFileSync(join(ROOT, 'scripts', 'atlas-status.ts'), 'utf8');
    assert.match(source, /board\.system\.gmail\.code/);
    assert.match(source, /board\.system\.gmail\.detail/);
    assert.ok(!/feu\(board\.system\.gmail\.state\)/.test(source), 'le feu générique READY/DEGRADED/DOWN ne suffit plus pour Gmail');
    assert.ok(!source.includes('synchronisation impossible dans l’heure'));
  });

  test('le worker ne consigne pas de friction pour « rien à rapprocher »', () => {
    const source = readFileSync(join(ROOT, 'packages', 'runtime', 'src', 'sales-engine.ts'), 'utf8');
    assert.match(source, /const configured = provider\.status\(\)\.configured;\s*\n\s*if \(!configured\) \{\s*\n\s*repos\.salesEngine\.recordFriction\(\{ kind: 'GMAIL_UNAVAILABLE'/);
    assert.match(source, /result: \{ ran: false, configured, skipped: report\.skipped \}/);
  });
});
