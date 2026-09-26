import { test, describe, beforeEach, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createLogger } from '../../core/src/logger.ts';
import type { AtlasConfig } from '../../core/src/config.ts';
import { createRepositories, type Repositories } from '../../data/src/index.ts';
import { makeTestConfig } from '../../testing/src/index.ts';
import { runRevenueFactory, runSendCycle, applyReplyConsequences } from '../../runtime/src/index.ts';
import { materializeFirstTouchDrafts } from '../../runtime/src/sales-engine.ts';
import { site, fixtureFetch, discovered, partners } from '../../runtime/test/helpers/factory-fixtures.ts';
import { buildMobileTrends, buildMobileActivity, buildProspectList, buildOutreachInbox, factoryVerdictOf } from '../src/http/mobile-feed.ts';
import { buildRevenueMobile } from '../src/http/revenue-mobile.ts';
import { createSystem, type AtlasSystem } from '../src/bootstrap.ts';
import { createApp } from '../src/app.ts';

/**
 * Les lectures de l'application mobile. Elles ne calculent rien qui ne soit
 * consigné : une base vide rend des listes vides et des séries de zéros, une
 * base peuplée rend exactement ce qui y est.
 */

const logger = createLogger({ level: 'error', pretty: false });
/** Lundi 28 septembre 2026, 10 h 30 à Paris. */
const NOW = new Date('2026-09-28T08:30:00.000Z');
let dir: string;
let repos: Repositories;
let config: AtlasConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-mobile-feed-'));
  repos = createRepositories(join(dir, 'm.db'), logger);
  config = makeTestConfig(dir);
});
afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const bench = (base: AtlasConfig): AtlasConfig => ({ ...base, sales: { ...base.sales, outboundEnabled: true, engineMode: 'PRODUCTION', humanApprovalRequired: false } });
const transport = () => ({
  id: 'recording', messages: [] as string[],
  status() { return { configured: true, code: 'READY', detail: 'banc', scopes: [] }; },
  async sendEmail(m: { to: string }) { this.messages.push(m.to); return { externalMessageId: `x-${this.messages.length}`, externalThreadId: null, simulated: true, sentAt: NOW.toISOString(), provider: 'recording' }; },
  async replyToThread(m: { to: string }) { return this.sendEmail(m); },
});

/** Deux entreprises éligibles, une à enrichir ; l'une est contactée et répond. */
async function seed() {
  const { segment } = repos.salesEngine.createSegment({ name: 'Équipementiers', countries: ['FR'] });
  repos.salesEngine.approveSegmentForSend(segment.id, 'founder@test.local');
  repos.salesEngine.attribute({ domain: 'graine.fr', segmentId: segment.id, messageVariant: 'A' });
  for (const d of ['merand.fr', 'fourpro.fr', 'formulaire.fr']) {
    repos.expansion.addRelationship({ runId: null, sourceKey: 'graine.fr', sourceName: 'Graine', sourceKind: 'COMPANY', targetKey: d, targetName: d,
      relationshipType: 'COMPLEMENTARY_VENDOR', confidence: 0.8, status: 'VERIFIED', evidenceUrl: 'https://graine.fr/p', evidenceSummary: `${d} est partenaire de Graine.`,
      sourceMethod: 'test', sourceTrust: 'OFFICIAL', country: 'FR', sourceDate: null });
  }
  discovered(repos, 'merand.fr', 'Mérand', '2026-09-28T07:00:00.000Z');
  discovered(repos, 'fourpro.fr', 'FourPro', '2026-09-27T07:00:00.000Z');
  discovered(repos, 'formulaire.fr', 'Formulaire', '2026-09-26T07:00:00.000Z');
  partners(repos, 'merand.fr', [{ domain: 'bridor.fr', name: 'Bridor' }, { domain: 'panamar.es', name: 'Panamar' }]);
  partners(repos, 'fourpro.fr', [{ domain: 'greggs.co.uk', name: 'Greggs' }, { domain: 'europastry.com', name: 'Europastry' }]);
  await runRevenueFactory({ repos, config, logger, now: () => NOW,
    fetchPages: fixtureFetch([site('merand.fr', 'Mérand'), site('fourpro.fr', 'FourPro'), site('formulaire.fr', 'Formulaire', 'FORM_ONLY')]) });
  materializeFirstTouchDrafts(repos, bench(config), { now: NOW, transportConfigured: true });
  const t = transport();
  await runSendCycle({ repos, config: bench(config), logger }, { outbound: async () => t, now: NOW, limit: 1 });
  const sentDomain = t.messages[0]!.split('@')[1]!;
  const conversation = repos.conversations.byDomain(sentDomain)!;
  repos.conversations.recordInboundEvent({ conversationId: conversation.id, kind: 'EMAIL_REPLY', classification: 'REPLIED', confidence: 0.9, source: 'test',
    sender: `commercial@${sentDomain}`, rawSubject: 'RE: distributeurs', bodyExcerpt: 'Oui, cela nous intéresse.', occurredAt: '2026-09-28T09:00:00.000Z' });
  applyReplyConsequences(repos, { eventId: 'e', conversationId: conversation.id, domain: sentDomain, companyName: sentDomain, classification: 'REPLIED', confidence: 0.9,
    subject: 'RE: distributeurs', sender: `commercial@${sentDomain}`, body: 'Oui, cela nous intéresse.', receivedAt: '2026-09-28T09:00:00.000Z' });
  return sentDomain;
}

describe('base vide', () => {
  test('séries de zéros sur sept jours, listes vides, aucune activité inventée', () => {
    const trends = buildMobileTrends(repos, NOW);
    assert.deepEqual(trends.days, ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28']);
    assert.deepEqual(trends.found, [0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(buildMobileActivity(repos), []);
    assert.deepEqual(buildProspectList(repos, NOW), { total: 0, rows: [] });
    const inbox = buildOutreachInbox(repos, NOW);
    for (const tab of ['toApprove', 'ready', 'sent', 'replies', 'blocked'] as const) assert.deepEqual(inbox[tab], [], tab);
  });
});

describe('base peuplée', () => {
  test('tendances : découvertes par jour, qualifiées selon le KPI, réponses', async () => {
    await seed();
    const t = buildMobileTrends(repos, NOW);
    assert.deepEqual(t.found.slice(-3), [1, 1, 1]);
    const v = buildRevenueMobile(repos, config, { now: NOW, gmailConfigured: false });
    assert.equal(t.qualified.at(-1), v.kpis.qualifiedToday, 'le dernier point de la courbe est le chiffre affiché');
    assert.equal(t.found.at(-1), v.kpis.discoveredToday);
    assert.equal(t.replies.at(-1), 1);
  });

  test('liste des prospects : la réponse d’abord, puis ce qui est prêt, puis le reste — une ligne par entreprise', async () => {
    const replied = await seed();
    const { total, rows } = buildProspectList(repos, NOW);
    assert.equal(total, 3);
    assert.equal(rows[0]!.domain, replied);
    assert.equal(rows[0]!.commercialState, 'POSITIVE_REPLY');
    const form = rows.find((r) => r.domain === 'formulaire.fr')!;
    assert.equal(form.factoryClass, 'NEEDS_ENRICHMENT');
    assert.equal(form.contactReady, false);
    assert.equal(form.mainBlocker, 'NO_OBSERVED_EMAIL');
    assert.equal(rows.at(-1)!.domain, 'formulaire.fr');
  });

  test('verdict de la fabrique pour la fiche : lu tel quel, null sans passage', async () => {
    await seed();
    const form = factoryVerdictOf(repos, 'www.formulaire.fr')!;
    assert.equal(form.sendEligible, false);
    assert.equal(form.classification, 'NEEDS_ENRICHMENT');
    assert.ok(form.blockers.includes('NO_OBSERVED_EMAIL'));
    assert.equal(factoryVerdictOf(repos, 'jamais-vu.fr'), null);
  });

  test('boîte d’envoi : prêts, envoyés, réponses — chacun dans son onglet', async () => {
    const replied = await seed();
    const inbox = buildOutreachInbox(repos, NOW);
    assert.equal(inbox.sent.length, 1);
    assert.equal(inbox.sent[0]!.domain, replied);
    assert.equal(inbox.replies.length, 1);
    assert.equal(inbox.replies[0]!.state, 'POSITIVE');
    assert.equal(inbox.ready.length, 1, 'le second brouillon approuvé attend le cycle suivant');
  });

  test('activité : les plus récents d’abord, quatre au plus', async () => {
    await seed();
    const a = buildMobileActivity(repos);
    assert.ok(a.length > 0 && a.length <= 4);
    assert.equal(a[0]!.kind, 'REPLY');
    for (let i = 1; i < a.length; i++) assert.ok(a[i - 1]!.at >= a[i]!.at);
  });

  test('la vue revenue porte tendances et activité, sans nouvelle requête', async () => {
    await seed();
    const v = buildRevenueMobile(repos, config, { now: NOW, gmailConfigured: false });
    assert.equal(v.trends.days.length, 7);
    assert.ok(v.activity.length > 0);
  });
});

describe('par HTTP', () => {
  let sandbox: string;
  let system: AtlasSystem;
  let app: FastifyInstance;
  let token: string;
  before(async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'atlas-mobile-feed-http-'));
    const cfg = makeTestConfig(join(sandbox, 'data'));
    mkdirSync(cfg.paths.artifactDir, { recursive: true });
    system = createSystem(cfg);
    app = await createApp(system);
    await app.ready();
    token = system.repos.users.createSession(system.repos.users.create({ email: 'v@test.local', name: 'V', role: 'viewer', password: 'secret-pass' })).token;
  });
  after(async () => {
    await app.close();
    await system.shutdown('test');
    rmSync(sandbox, { recursive: true, force: true });
  });

  test('sans session : 401 ; avec : 200 et la forme attendue ; aucune écriture ouverte', async () => {
    for (const url of ['/api/cc/prospects', '/api/cc/outreach-inbox']) {
      assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401, url);
      const ok = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
      assert.equal(ok.statusCode, 200, url);
      assert.equal(/GMAIL_|sk-|SESSION_SECRET/.test(ok.body), false, url);
      const post = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` } });
      assert.ok(post.statusCode === 404 || post.statusCode === 405, `${url} → ${post.statusCode}`);
    }
  });
});
