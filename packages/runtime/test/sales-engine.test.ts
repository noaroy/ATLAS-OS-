import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../core/src/logger.ts';
import type { AtlasConfig } from '../../core/src/index.ts';
import { createRepositories, type Repositories, type TaskRow } from '../../data/src/index.ts';
import { makeTestConfig } from '../../testing/src/index.ts';
import { FixtureInboxProvider, mailMessage, DryRunOutboundProvider, type MailOutboundProvider, type MailMessage } from '../../intelligence/src/index.ts';
import {
  scheduleSalesCycle,
  runSendCycle,
  createSalesEngineHandlers,
  applyReplyConsequences,
  setGlobalPause,
  readGlobalPause,
  decideRecommendation,
  rollbackStrategy,
  recordSalesOutcome,
  runOptimizationCycle,
  readStrategy,
  SALES_ENGINE_TASKS,
} from '../src/sales-engine.ts';
import { buildSalesDashboard } from '../src/sales-dashboard.ts';
import { AtlasDaemon } from '../src/daemon.ts';
import { WorkerRegistry, DeterministicWorker, type WorkerContext } from '../src/workers.ts';

/**
 * Le moteur commercial relié : base réelle (fichier temporaire), fournisseurs
 * figés, aucun réseau. Ce que ces tests tiennent, c'est ce qu'un envoi réel ne
 * permettrait pas de reprendre : un message parti deux fois, une relance après
 * une réponse, un envoi en INTERNAL_TEST, un cycle rejoué au redémarrage.
 */

const logger = createLogger({ level: 'error', pretty: false });
/** Un mardi 11 h à Paris, dans la fenêtre 09:00–17:30. */
const NOW = new Date('2026-09-15T09:00:00.000Z');

let dir: string;
let repos: Repositories;
let config: AtlasConfig;

/** La configuration « production ouverte » : tout ce qu'un envoi réel exige, sauf le transport. */
const production = (base: AtlasConfig): AtlasConfig => ({
  ...base,
  sales: { ...base.sales, outboundEnabled: true, engineMode: 'PRODUCTION' },
});

/** Un expéditeur qui compte, et peut échouer sur commande. */
class CountingOutbound implements MailOutboundProvider {
  readonly id = 'counting';
  sent: Array<{ to: string; subject: string }> = [];
  failNext = false;
  constructor(private readonly configured = true) {}
  status() {
    return { configured: this.configured, code: this.configured ? 'READY' : 'GMAIL_SEND_SCOPE_MISSING', detail: 'test', scopes: [] };
  }
  async sendEmail(message: { to: string; subject: string; bodyText: string }) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('SMTP 451 réessayer plus tard');
    }
    this.sent.push({ to: message.to, subject: message.subject });
    return { externalMessageId: `msg-${this.sent.length}`, externalThreadId: `thr-${this.sent.length}`, simulated: false, sentAt: NOW.toISOString(), provider: this.id };
  }
  async replyToThread(message: { to: string; subject: string; bodyText: string; threadId: string }) {
    return this.sendEmail(message);
  }
}

const context: WorkerContext = { logger, heartbeat: () => true, shuttingDown: () => false, correlationId: null };
const task = (taskType: string): TaskRow => ({
  taskId: 'tsk_test', taskType, department: 'sales', workerType: 'DETERMINISTIC', priority: 0, status: 'RUNNING',
  payload: {}, result: null, createdAt: NOW.toISOString(), availableAt: NOW.toISOString(), startedAt: null, finishedAt: null,
  attemptCount: 1, maxAttempts: 3, leaseOwner: null, leaseUntil: null, lastHeartbeatAt: null, parentTaskId: null,
  correlationId: null, idempotencyKey: null, estimatedCost: null, actualCost: null, errorCode: null, errorMessage: null,
  metadata: {}, chainId: null, chainDepth: 0, fingerprint: null,
});

/** Un segment approuvé, une entreprise attribuée, un brouillon approuvé : prêt à partir. */
function seedApprovedDraft(domain = 'acme-industrie.fr', purpose = 'FIRST_TOUCH') {
  const { segment } = repos.salesEngine.createSegment({ name: 'PME B2B FR', countries: ['FR'] });
  repos.salesEngine.approveSegmentForSend(segment.id, 'founder@test.local');
  repos.salesEngine.attribute({ domain, segmentId: segment.id, messageVariant: 'A' });
  const draft = repos.salesLoop.saveDraft({
    domain, companyName: 'Acme Industrie', recipient: `contact@${domain}`, subject: 'Acme Industrie — 3 prospects',
    body: 'Bonjour, j’ai vu que vous recrutez des distributeurs…', purpose, sources: [], createdBy: 'test',
  });
  repos.salesLoop.recordTransition({ domain, fromState: null, toState: 'QUALIFYING', actor: 'test' });
  repos.salesLoop.recordTransition({ domain, fromState: 'QUALIFYING', toState: 'READY_FOR_APPROVAL', actor: 'test' });
  repos.salesLoop.decideDraft({ draftId: draft.id, decision: 'APPROVED_TO_SEND', decidedBy: 'founder@test.local' });
  repos.salesLoop.recordTransition({ domain, fromState: 'READY_FOR_APPROVAL', toState: 'APPROVED_TO_SEND', actor: 'test' });
  return { segment, draft };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-sales-engine-'));
  repos = createRepositories(join(dir, 'atlas.db'), logger);
  config = makeTestConfig(dir);
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('planificateur (§37–41)', () => {
  test('un passage pose chaque cycle une fois ; un second passage ne crée rien ; la fenêtre suivante recrée', () => {
    const first = scheduleSalesCycle(repos, config, NOW);
    assert.equal(first.created.length, 6, first.created.join());
    const again = scheduleSalesCycle(repos, config, new Date(NOW.getTime() + 60_000));
    assert.equal(again.created.length, 0);
    assert.equal(again.existing.length, 6);
    const later = scheduleSalesCycle(repos, config, new Date(NOW.getTime() + 20 * 60_000));
    // Envoi (10 min) et lecture de boîte (15 min) ont changé de fenêtre ; le reste non.
    assert.deepEqual(later.created.map((k) => k.split(':')[1]).sort(), ['reply_sync', 'send']);
  });

  test('le moteur coupé ne pose rien ; la découverte désactivée ne pose pas de découverte', () => {
    assert.equal(scheduleSalesCycle(repos, { ...config, sales: { ...config.sales, engineEnabled: false } }, NOW).created.length, 0);
    const without = scheduleSalesCycle(repos, { ...config, sales: { ...config.sales, discoveryEnabled: false } }, NOW);
    assert.equal(without.created.length, 5);
    assert.ok(!without.created.some((k) => k.includes('discovery')));
  });
});

describe('cycle d’envoi (§12, §42, §65–67, §72)', () => {
  test('par défaut — interrupteur fermé, INTERNAL_TEST — rien ne part, le brouillon reste approuvé', async () => {
    const { draft } = seedApprovedDraft();
    const outbound = new CountingOutbound();
    const report = await runSendCycle({ repos, config, logger }, { outbound: async () => outbound, now: NOW });
    assert.equal(report.sent, 0);
    assert.equal(outbound.sent.length, 0);
    const reasons = report.blocked[0]!.reasons;
    assert.ok(reasons.includes('OUTBOUND_DISABLED'), reasons.join());
    assert.ok(reasons.includes('INTERNAL_TEST_MODE'));
    assert.equal(repos.salesLoop.draftById(draft.id)!.state, 'APPROVED_TO_SEND');
    assert.equal(repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z'), 0);
    assert.equal(repos.salesEngine.frictions({ kind: 'SEND_BLOCKED' }).length, 1);
  });

  test('en production, avec campagne approuvée et transport prêt : exactement un envoi, consigné partout', async () => {
    const { draft } = seedApprovedDraft();
    const outbound = new CountingOutbound();
    const prod = production(config);
    const report = await runSendCycle({ repos, config: prod, logger }, { outbound: async () => outbound, now: NOW });
    assert.equal(report.sent, 1, JSON.stringify(report));
    assert.equal(outbound.sent.length, 1);
    assert.equal(repos.salesLoop.draftById(draft.id)!.state, 'SENT');
    assert.equal(repos.sales.ledgerFor('acme-industrie.fr')?.kind, 'CONTACTED');
    assert.equal(repos.salesLoop.currentState('acme-industrie.fr'), 'CONTACTED');
    assert.ok(repos.conversations.byDomain('acme-industrie.fr'));
    assert.ok(repos.salesEngine.attributionFor('acme-industrie.fr')!.contactedAt);

    // Le cycle suivant ne trouve plus rien à envoyer.
    const again = await runSendCycle({ repos, config: prod, logger }, { outbound: async () => outbound, now: new Date(NOW.getTime() + 600_000) });
    assert.equal(again.considered, 0);
    assert.equal(outbound.sent.length, 1);
  });

  test('deux cycles concurrents sur le même brouillon : un seul message part (§72)', async () => {
    seedApprovedDraft();
    const outbound = new CountingOutbound();
    const prod = production(config);
    const deps = { repos, config: prod, logger };
    const [a, b] = await Promise.all([
      runSendCycle(deps, { outbound: async () => outbound, now: NOW }),
      runSendCycle(deps, { outbound: async () => outbound, now: NOW }),
    ]);
    assert.equal(a.sent + b.sent, 1, JSON.stringify({ a, b }));
    assert.equal(outbound.sent.length, 1);
    assert.equal(repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z'), 1);
  });

  test('le coupe-circuit arrête tout ; la reprise rouvre (§42)', async () => {
    seedApprovedDraft();
    const outbound = new CountingOutbound();
    const prod = production(config);
    setGlobalPause(repos, true, 'founder@test.local', 'test');
    const paused = await runSendCycle({ repos, config: prod, logger }, { outbound: async () => outbound, now: NOW });
    assert.equal(paused.sent, 0);
    assert.ok(paused.blocked[0]!.reasons.includes('GLOBAL_PAUSE'));
    setGlobalPause(repos, false, 'founder@test.local', null);
    assert.equal(readGlobalPause(repos).paused, false);
    const resumed = await runSendCycle({ repos, config: prod, logger }, { outbound: async () => outbound, now: NOW });
    assert.equal(resumed.sent, 1);
  });

  test('une campagne non approuvée ne part pas, même en production (§67)', async () => {
    const { segment } = seedApprovedDraft();
    repos.salesEngine.revokeSegmentApproval(segment.id, 'founder@test.local', 'test');
    const outbound = new CountingOutbound();
    const report = await runSendCycle({ repos, config: production(config), logger }, { outbound: async () => outbound, now: NOW });
    assert.equal(report.sent, 0);
    assert.ok(report.blocked[0]!.reasons.includes('CAMPAIGN_NOT_APPROVED'));
  });

  test('une suppression arrivée après l’approbation ferme le brouillon (§15)', async () => {
    const { draft } = seedApprovedDraft();
    repos.salesEngine.suppress({ kind: 'DOMAIN', value: 'acme-industrie.fr', reason: 'OPT_OUT', createdBy: 'test' });
    const outbound = new CountingOutbound();
    const report = await runSendCycle({ repos, config: production(config), logger }, { outbound: async () => outbound, now: NOW });
    assert.equal(report.sent, 0);
    assert.ok(report.blocked[0]!.reasons.includes('SUPPRESSED'));
    assert.equal(repos.salesLoop.draftById(draft.id)!.state, 'ABANDONED');
    assert.equal(repos.salesLoop.currentState('acme-industrie.fr'), 'BLOCKED');
  });

  test('hors fenêtre, le brouillon attend le prochain cycle sans être fermé (§13)', async () => {
    const { draft } = seedApprovedDraft();
    const outbound = new CountingOutbound();
    const report = await runSendCycle({ repos, config: production(config), logger }, { outbound: async () => outbound, now: new Date('2026-09-15T20:00:00.000Z') });
    assert.equal(report.sent, 0);
    assert.ok(report.blocked[0]!.reasons.includes('OUTSIDE_SEND_WINDOW'));
    assert.equal(repos.salesLoop.draftById(draft.id)!.state, 'APPROVED_TO_SEND');
  });

  test('un transport sans portée d’envoi bloque avant toute réservation', async () => {
    seedApprovedDraft();
    const outbound = new CountingOutbound(false);
    const report = await runSendCycle({ repos, config: production(config), logger }, { outbound: async () => outbound, now: NOW });
    assert.ok(report.blocked[0]!.reasons.includes('TRANSPORT_UNAVAILABLE'));
    assert.equal(repos.salesLoop.sentLog(10).length, 0, 'aucune place réservée');
  });

  test('un échec technique est consigné et la place n’est pas comptée comme envoyée', async () => {
    seedApprovedDraft();
    const outbound = new CountingOutbound();
    outbound.failNext = true;
    const report = await runSendCycle({ repos, config: production(config), logger }, { outbound: async () => outbound, now: NOW });
    assert.equal(report.failed.length, 1);
    assert.equal(repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z'), 0);
    assert.equal(repos.salesLoop.currentState('acme-industrie.fr'), 'ACTION_REQUIRED');
  });

  test('l’expéditeur à blanc simule : rien de réel, et le registre le dit', async () => {
    seedApprovedDraft();
    const report = await runSendCycle({ repos, config: production(config), logger }, { outbound: async () => new DryRunOutboundProvider(), now: NOW });
    assert.equal(report.simulated, 1);
    assert.equal(report.sent, 0);
    assert.match(repos.sales.ledgerFor('acme-industrie.fr')?.note ?? '', /simulation/);
  });
});

describe('réponses : conséquences (§14, §16–17, §64, §71)', () => {
  const reply = (over: Partial<Parameters<typeof applyReplyConsequences>[1]> = {}) => ({
    eventId: 'evt', conversationId: 'cnv', domain: 'acme-industrie.fr', companyName: 'Acme Industrie',
    classification: 'REPLIED', confidence: 0.8, subject: 'RE: 3 prospects', sender: 'jean@acme-industrie.fr',
    body: 'Oui, cela nous intéresse, planifions un appel.', receivedAt: NOW.toISOString(), ...over,
  });

  test('une réponse annule toutes les relances ouvertes et ouvre une réponse chaude (§71)', () => {
    const domain = 'acme-industrie.fr';
    seedApprovedDraft(domain, 'FOLLOW_UP');
    const pending = repos.salesLoop.saveDraft({ domain, companyName: 'Acme', recipient: `contact@${domain}`, subject: 'Relance', body: 'Relance…', purpose: 'FOLLOW_UP', sources: [], createdBy: 'test' });
    const result = applyReplyConsequences(repos, reply());
    assert.equal(result.intent, 'POSITIVE');
    assert.equal(result.cancelledFollowUps, 2);
    assert.equal(repos.salesLoop.draftById(pending.id)!.state, 'ABANDONED');
    assert.equal(result.hotLead, true);
    assert.equal(repos.salesEngine.leadReview(domain)?.status, 'OPEN');
  });

  test('un opt-out supprime l’adresse et le domaine, écarte au registre, bloque la boucle (§64)', () => {
    seedApprovedDraft();
    const result = applyReplyConsequences(repos, reply({ body: 'Merci de me désabonner.' }));
    assert.equal(result.intent, 'OPT_OUT');
    assert.equal(repos.salesEngine.isSuppressed({ email: 'jean@acme-industrie.fr' }).suppressed, true);
    assert.equal(repos.salesEngine.isSuppressed({ domain: 'acme-industrie.fr' }).suppressed, true);
    assert.equal(repos.sales.ledgerFor('acme-industrie.fr')?.kind, 'DO_NOT_CONTACT');
    assert.equal(repos.salesLoop.currentState('acme-industrie.fr'), 'BLOCKED');
    assert.equal(result.hotLead, false);
  });

  test('un rebond supprime l’adresse et appelle une décision', () => {
    seedApprovedDraft();
    const result = applyReplyConsequences(repos, reply({ classification: 'BOUNCED', sender: 'mailer-daemon@googlemail.com', body: 'Address not found' }));
    assert.equal(result.intent, 'BOUNCE');
    assert.equal(repos.salesEngine.isSuppressed({ email: 'mailer-daemon@googlemail.com' }).suppressed, true);
  });

  test('après un opt-out, le worker de relance ne relance jamais (§14)', async () => {
    const domain = 'acme-industrie.fr';
    seedApprovedDraft(domain);
    repos.salesLoop.recordTransition({ domain, fromState: 'APPROVED_TO_SEND', toState: 'SENDING', actor: 'test' });
    repos.salesLoop.recordTransition({ domain, fromState: 'SENDING', toState: 'CONTACTED', actor: 'test', });
    applyReplyConsequences(repos, reply({ body: 'STOP' }));
    const handlers = createSalesEngineHandlers({ repos, config, logger, now: () => new Date('2026-10-15T09:00:00.000Z') });
    const outcome = await handlers[SALES_ENGINE_TASKS.FOLLOW_UP]!(task(SALES_ENGINE_TASKS.FOLLOW_UP), context);
    assert.equal(outcome.kind, 'DONE');
    assert.equal(outcome.result!.due, 0);
    assert.notEqual(repos.salesLoop.currentState(domain), 'FOLLOW_UP_REQUIRED');
  });

  test('une relance due est signalée, jamais envoyée d’office', async () => {
    const domain = 'acme-industrie.fr';
    seedApprovedDraft(domain);
    repos.salesLoop.recordTransition({ domain, fromState: 'APPROVED_TO_SEND', toState: 'SENDING', actor: 'test' });
    repos.salesLoop.recordTransition({ domain, fromState: 'SENDING', toState: 'CONTACTED', actor: 'test' });
    const handlers = createSalesEngineHandlers({ repos, config, logger, now: () => new Date('2026-10-15T09:00:00.000Z') });
    const outcome = await handlers[SALES_ENGINE_TASKS.FOLLOW_UP]!(task(SALES_ENGINE_TASKS.FOLLOW_UP), context);
    assert.equal(outcome.result!.due, 1);
    assert.equal(repos.salesLoop.currentState(domain), 'FOLLOW_UP_REQUIRED');
    assert.equal(repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z'), 0);
  });
});

describe('lecture de la boîte (§16)', () => {
  test('les réponses importées produisent leurs conséquences une seule fois, même relues', async () => {
    const domain = 'acme-industrie.fr';
    seedApprovedDraft(domain, 'FOLLOW_UP');
    repos.conversations.open({ domain, companyName: 'Acme Industrie', channel: 'email', destination: `contact@${domain}` });
    const messages: MailMessage[] = [
      mailMessage({ messageId: 'm1', from: 'Jean <jean@acme-industrie.fr>', subject: 'RE: Acme Industrie — 3 prospects', bodyText: 'Oui, avec plaisir, proposez-moi un créneau.', receivedAt: NOW.toISOString() }),
    ];
    process.env.GMAIL_USER = 'commercial@atlas.example';
    const handlers = createSalesEngineHandlers({ repos, config, logger, now: () => NOW, inbox: () => new FixtureInboxProvider(messages) });
    const first = await handlers[SALES_ENGINE_TASKS.REPLY_SYNC]!(task(SALES_ENGINE_TASKS.REPLY_SYNC), context);
    assert.equal(first.kind, 'DONE');
    assert.equal(first.result!.newEvents, 1, JSON.stringify(first.result));
    assert.equal(first.result!.hotLeads, 1);
    assert.equal(first.result!.cancelledFollowUps, 1);
    const second = await handlers[SALES_ENGINE_TASKS.REPLY_SYNC]!(task(SALES_ENGINE_TASKS.REPLY_SYNC), context);
    assert.equal(second.result!.newEvents, 0);
    assert.equal(second.result!.duplicates, 1);
  });

  test('sans Gmail configuré, la friction est consignée et rien ne casse', async () => {
    const handlers = createSalesEngineHandlers({
      repos, config, logger,
      inbox: () => ({ id: 'none', status: () => ({ configured: false, code: 'GMAIL_NOT_CONFIGURED', detail: 'jeton absent', scopes: [] }), list: async () => [] }),
    });
    const outcome = await handlers[SALES_ENGINE_TASKS.REPLY_SYNC]!(task(SALES_ENGINE_TASKS.REPLY_SYNC), context);
    assert.equal(outcome.kind, 'DONE');
    assert.equal(outcome.result!.ran, false);
    assert.equal(repos.salesEngine.frictions({ kind: 'GMAIL_UNAVAILABLE' }).length, 1);
  });
});

describe('mesures et pause automatique (§69–70)', () => {
  test('trop de rebonds sur l’échantillon minimal : PAUSE automatique, alerte, et une seule fois', async () => {
    const prod = production({ ...config, sales: { ...config.sales, bounceMinSample: 5, bouncePauseRate: 0.2 } });
    for (let i = 0; i < 6; i += 1) {
      const domain = `soc${i}.fr`;
      const claim = repos.salesLoop.claimSend({ domain, recipient: `c@${domain}`, subject: `s${i}`, body: `b${i}`, purpose: 'FIRST_TOUCH', claimedBy: 'test' });
      repos.salesLoop.recordSendResult({ idempotencyKey: claim.idempotencyKey, phase: 'SENT', externalMessageId: `x${i}` });
      const { conversation } = repos.conversations.open({ domain, companyName: domain });
      if (i < 2) {
        repos.conversations.recordInboundEvent({ conversationId: conversation.id, kind: 'BOUNCE', classification: 'BOUNCED', confidence: 0.9, source: 'test', occurredAt: NOW.toISOString() });
      }
    }
    const handlers = createSalesEngineHandlers({ repos, config: prod, logger, now: () => new Date(NOW.getTime() + 60_000) });
    const outcome = await handlers[SALES_ENGINE_TASKS.ANALYTICS]!(task(SALES_ENGINE_TASKS.ANALYTICS), context);
    assert.equal(outcome.result!.autoPaused, true, JSON.stringify(outcome.result));
    assert.equal(readGlobalPause(repos).paused, true);
    assert.match(readGlobalPause(repos).reason ?? '', /AUTO_PAUSE_BOUNCE/);
    assert.ok(repos.ops.listAlerts().some((a) => a.title.includes('rebonds')));
    const again = await handlers[SALES_ENGINE_TASKS.ANALYTICS]!(task(SALES_ENGINE_TASKS.ANALYTICS), context);
    assert.equal(again.result!.autoPaused, false);
  });
});

describe('recommandations, décisions, versions (§26–36)', () => {
  /** Segment A bon, segment B mauvais : 60 contactés chacun, 6 réponses positives contre 0. */
  function seedTwoSegments() {
    const a = repos.salesEngine.createSegment({ name: 'Segment A' }).segment;
    const b = repos.salesEngine.createSegment({ name: 'Segment B' }).segment;
    for (const [segment, positives] of [[a, 6], [b, 0]] as const) {
      for (let i = 0; i < 60; i += 1) {
        const domain = `${segment.name.toLowerCase().replace(/\s/g, '')}-${i}.fr`;
        repos.salesEngine.attribute({ domain, segmentId: segment.id, messageVariant: i % 2 === 0 ? 'A' : 'B' });
        repos.salesEngine.markContacted(domain, NOW.toISOString());
        if (i < positives) {
          const { conversation } = repos.conversations.open({ domain, companyName: domain });
          repos.conversations.recordInboundEvent({ conversationId: conversation.id, kind: 'EMAIL_REPLY', classification: 'REPLIED', confidence: 0.8, source: 'test', bodyExcerpt: 'Oui, intéressé, planifions un appel', occurredAt: NOW.toISOString() });
        }
      }
    }
    return { a, b };
  }

  test('le cycle propose SCALE pour A et REDUCE pour B, sans doublon au second passage', () => {
    const { a, b } = seedTwoSegments();
    const first = runOptimizationCycle(repos, config, new Date(NOW.getTime() + 60_000));
    assert.ok(first.proposed >= 2, String(first.proposed));
    const open = repos.salesEngine.recommendations({ status: 'PROPOSED' });
    assert.ok(open.some((r) => r.kind === 'SCALE_SEGMENT' && (r.evidence.segmentId === a.id)));
    assert.ok(open.some((r) => r.kind === 'REDUCE_SEGMENT' && (r.evidence.segmentId === b.id)));
    const second = runOptimizationCycle(repos, config, new Date(NOW.getTime() + 120_000));
    assert.equal(second.proposed, 0);
  });

  test('un petit échantillon donne INSUFFICIENT_DATA, aucune recommandation', () => {
    const c = repos.salesEngine.createSegment({ name: 'Segment C' }).segment;
    for (let i = 0; i < 8; i += 1) {
      repos.salesEngine.attribute({ domain: `c${i}.fr`, segmentId: c.id });
      repos.salesEngine.markContacted(`c${i}.fr`, NOW.toISOString());
    }
    const result = runOptimizationCycle(repos, config, new Date(NOW.getTime() + 60_000));
    assert.equal(result.proposed, 0);
    assert.deepEqual(result.insufficient.map((i) => i.subject), ['segment Segment C']);
  });

  test('TESTER applique un demi-pas versionné ; VALIDER le pas entier ; ROLLBACK restaure ; REFUSER ne touche rien', () => {
    const { a, b } = seedTwoSegments();
    runOptimizationCycle(repos, config, new Date(NOW.getTime() + 60_000));
    const scale = repos.salesEngine.recommendations({ status: 'PROPOSED' }).find((r) => r.kind === 'SCALE_SEGMENT')!;
    const reduce = repos.salesEngine.recommendations({ status: 'PROPOSED' }).find((r) => r.kind === 'REDUCE_SEGMENT')!;

    const tested = decideRecommendation(repos, scale.id, 'test', 'founder@test.local');
    assert.equal(tested.applied, true, tested.reason);
    assert.equal(tested.recommendation.status, 'TESTING');
    assert.equal(readStrategy(repos).segmentWeights[a.id], 1.125);
    assert.equal(repos.salesEngine.segment(a.id)!.explorationWeight, 1.125);

    const approved = decideRecommendation(repos, scale.id, 'approve', 'founder@test.local');
    assert.equal(approved.recommendation.status, 'APPROVED');
    assert.equal(readStrategy(repos).segmentWeights[a.id], 1.375);

    const versions = repos.salesEngine.strategyVersions();
    assert.equal(versions.length, 2);
    assert.equal(versions[0]!.version, 2);
    assert.deepEqual((versions[0]!.before as { segmentWeights: Record<string, number> }).segmentWeights[a.id], 1.125);

    const rolled = rollbackStrategy(repos, versions[0]!.id, 'founder@test.local', 'trop tôt');
    assert.equal(rolled.applied, true);
    assert.equal(readStrategy(repos).segmentWeights[a.id], 1.125);
    assert.equal(repos.salesEngine.recommendation(scale.id)!.status, 'ROLLED_BACK');
    assert.equal(repos.salesEngine.strategyVersions().length, 3);

    const rejected = decideRecommendation(repos, reduce.id, 'reject', 'founder@test.local');
    assert.equal(rejected.recommendation.status, 'REJECTED');
    assert.equal(readStrategy(repos).segmentWeights[b.id], undefined);
  });
});

describe('issues commerciales : humaines (§18, §59–60)', () => {
  test('un rendez-vous puis un client gagné se consignent avec auteur, montant et transition', () => {
    seedApprovedDraft();
    const meeting = recordSalesOutcome(repos, { domain: 'acme-industrie.fr', kind: 'MEETING_BOOKED', by: 'founder@test.local' });
    assert.equal(meeting.kind, 'MEETING_BOOKED');
    const won = recordSalesOutcome(repos, { domain: 'acme-industrie.fr', kind: 'WON', revenueAmount: 1200, by: 'founder@test.local', offer: 'étude 15 prospects' });
    assert.equal(won.revenueAmount, 1200);
    assert.equal(won.currency, 'EUR');
    const events = repos.conversations.eventsFor(repos.conversations.byDomain('acme-industrie.fr')!.id);
    assert.ok(events.every((e) => e.humanReviewed));
    assert.equal(repos.salesEngine.leadReview('acme-industrie.fr')?.status, 'HANDLED');
    assert.throws(() => recordSalesOutcome(repos, { domain: 'x.fr', kind: 'WON', by: 'founder@test.local' }), /montant/);
    assert.throws(() => recordSalesOutcome(repos, { domain: 'x.fr', kind: 'LOST', by: '  ' }), /auteur/);
  });
});

describe('la page unique (§20–25, §87)', () => {
  test('simulation de bout en bout : 500 → 200 → 120 → 100 → 12 → 5 → 3 → 1, exactement', () => {
    const { segment } = repos.salesEngine.createSegment({ name: 'Simulation' });
    repos.salesEngine.approveSegmentForSend(segment.id, 'founder@test.local');
    const day = (i: number) => new Date(NOW.getTime() - (i % 20) * 3_600_000).toISOString();
    for (let i = 0; i < 500; i += 1) {
      const domain = `sim-${i}.fr`;
      const qualified = i < 200;
      const withContact = i < 120;
      repos.sales.discover({
        batchId: 'BATCH-SIM', companyName: `Sim ${i}`, domain, website: `https://${domain}`, country: 'FR',
        sourceUrl: `https://${domain}/`, discoveredAt: day(i), pageType: 'OFFICIAL_COMPANY_SITE', guardVersion: 'test',
      });
      const prospect = repos.sales.discoveredSince(null).find((p) => p.domain === domain)!;
      if (qualified) {
        repos.sales.setScore(prospect.id, { score: 70, tier: 'GOOD_FIT', detail: {}, whyFit: 'test' });
        repos.sales.setState(prospect.id, 'QUALIFIED');
      } else {
        repos.sales.setScore(prospect.id, { score: 10, tier: 'REJECTED', detail: {}, whyFit: 'test' });
        repos.sales.setState(prospect.id, 'REJECTED', { rejectReason: 'hors ICP' });
      }
      if (withContact) repos.sales.setContact(prospect.id, { email: `contact@${domain}`, sourceUrl: `https://${domain}/contact`, observed: true, method: 'EMAIL' });
      repos.salesEngine.attribute({ domain, prospectId: prospect.id, segmentId: segment.id, messageVariant: i % 2 ? 'B' : 'A' });
      if (i < 100) {
        repos.sales.recordOutreach({ domain, kind: 'CONTACTED', recordedBy: 'test', channel: 'email', recordedAt: day(i) });
        repos.salesEngine.markContacted(domain, day(i));
        const { conversation } = repos.conversations.open({ domain, companyName: `Sim ${i}`, channel: 'email', destination: `contact@${domain}`, firstContactAt: day(i) });
        if (i < 12) {
          repos.conversations.recordInboundEvent({
            conversationId: conversation.id, kind: 'EMAIL_REPLY', classification: 'REPLIED', confidence: 0.8, source: 'test',
            occurredAt: NOW.toISOString(), sender: `jean@${domain}`,
            bodyExcerpt: i < 5 ? 'Oui, cela nous intéresse, planifions un appel.' : 'Bien reçu, merci.',
          });
        }
      }
      if (i < 3) repos.salesEngine.recordOutcome({ domain, kind: 'MEETING_BOOKED', recordedBy: 'founder', occurredAt: NOW.toISOString() });
      if (i < 1) repos.salesEngine.recordOutcome({ domain, kind: 'WON', revenueAmount: 1500, recordedBy: 'founder', occurredAt: NOW.toISOString() });
    }

    const board = buildSalesDashboard(repos, config, { range: '30d', now: new Date(NOW.getTime() + 60_000), gmailConfigured: false });
    const count = (stage: string) => board.funnel.find((f) => f.stage === stage)!.count;
    assert.equal(count('discovered'), 500);
    assert.equal(count('icpQualified'), 200);
    assert.equal(count('contactsFound'), 120);
    assert.equal(count('contacted'), 100);
    assert.equal(count('replied'), 12);
    assert.equal(count('positiveReplies'), 5);
    assert.equal(count('meetings'), 3);
    assert.equal(count('clients'), 1);
    assert.equal(board.cards.clientsSigned, 1);
    assert.equal(board.cards.revenueSigned, 1500);
    assert.equal(board.cards.meetingsThisWeek, 3);
    assert.equal(board.performance.positiveReplyRate, 0.05);
    assert.equal(board.performance.meetingPerContact, 0.03);
    assert.equal(board.performance.clientPerContact, 0.01);
    assert.equal(board.performance.revenuePer100, 1500);
    assert.equal(board.performance.cac, null, 'aucune dépense IA consignée : CAC absent, jamais zéro');
    assert.equal(board.segments[0]!.contacted, 100);
    assert.equal(board.segments[0]!.positiveReplies, 5);
    assert.equal(board.hotLeadsTotal, 4, 'cinq positives, une déjà gagnée');
    assert.ok(board.hotLeads.every((h) => h.status === 'OPEN'));
    assert.equal(board.system.outbound.enabled, false);
    assert.equal(board.system.gmail.state, 'off');

    // Le filtre 7 jours voit les mêmes contacts (tous datés de la journée) ; le filtre segment aussi.
    const week = buildSalesDashboard(repos, config, { range: '7d', now: new Date(NOW.getTime() + 60_000), gmailConfigured: false });
    assert.equal(week.funnel.find((f) => f.stage === 'contacted')!.count, 100);
    const scoped = buildSalesDashboard(repos, config, { range: 'all', segmentId: segment.id, now: NOW, gmailConfigured: false });
    assert.equal(scoped.funnel.find((f) => f.stage === 'discovered')!.count, 500);
  });

  test('la page vide est vide, pas fausse', () => {
    const board = buildSalesDashboard(repos, config, { range: 'all', now: NOW, gmailConfigured: false });
    assert.equal(board.cards.pipelinePotential, null);
    assert.equal(board.performance.cac, null);
    assert.equal(board.performance.positiveReplyRate, null);
    assert.equal(board.hotLeads.length, 0);
    assert.equal(board.system.workers.state, 'down');
  });
});

describe('daemon embarqué : reprise après arrêt brutal (§40, §85)', () => {
  test('une tâche dont le bail a expiré est reprise par le daemon suivant, et l’envoi ne double pas', async () => {
    seedApprovedDraft();
    // La découverte ne doit jamais lancer le lot réel depuis un test.
    const prod = production({ ...config, sales: { ...config.sales, discoveryEnabled: false } });
    const outbound = new CountingOutbound();
    // Les tâches sont posées à l'heure réelle : le daemon ne prend que ce qui est disponible.
    scheduleSalesCycle(repos, prod, new Date());

    // Le premier daemon prend la tâche d'envoi et « meurt » : bail posé, jamais rendu.
    const sendTask = repos.tasks.list({ limit: 50 }).find((t) => t.taskType === SALES_ENGINE_TASKS.SEND)!;
    const claim = repos.tasks.claim({ owner: 'daemon-mort', leaseMs: 1, workerTypes: ['DETERMINISTIC'] });
    assert.ok(claim.task, 'une tâche est prenable');
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Le second daemon démarre : il récupère les baux morts puis traite.
    const handlers = createSalesEngineHandlers({ repos, config: prod, logger, now: () => NOW, outbound: async () => outbound });
    const registry = new WorkerRegistry().register(new DeterministicWorker(handlers));
    const daemon = new AtlasDaemon({ repos, registry, logger, owner: 'daemon-neuf', maxCycles: 8, maxIdleMs: 50, leaseMs: 5_000 });
    const stats = await daemon.run();
    assert.ok(stats.recovered >= 1, `recovered=${stats.recovered}`);
    assert.ok(stats.completed >= 1);
    assert.equal(repos.tasks.byId(sendTask.taskId)?.status, 'DONE');

    // Un troisième passage — même fenêtre — ne recrée ni la tâche ni l'envoi.
    const again = scheduleSalesCycle(repos, prod, new Date());
    assert.equal(again.created.length, 0);
    assert.equal(outbound.sent.length, 1);
    assert.equal(repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z'), 1);
    assert.ok(repos.tasks.lastDaemonRun()?.lastHeartbeatAt, 'le daemon a daté son tour');
  });
});
