import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../core/src/logger.ts';
import type { AtlasConfig } from '../../core/src/index.ts';
import { createRepositories, type Repositories } from '../../data/src/index.ts';
import { makeTestConfig } from '../../testing/src/index.ts';
import { buildSalesDashboard } from '../src/sales-dashboard.ts';
import { recordSalesOutcome, runSendCycle } from '../src/sales-engine.ts';
import { DryRunOutboundProvider } from '../../intelligence/src/index.ts';

/**
 * Le tableau de bord est un reflet, jamais une copie.
 *
 * Chaque chiffre est recalculé depuis les tables métier à chaque lecture :
 * une base déjà remplie se lit juste dès la première fois, chaque écriture
 * change la lecture suivante, une simulation ne compte pas comme un contact,
 * et un calcul SQL direct donne exactement les mêmes valeurs.
 */

const logger = createLogger({ level: 'error', pretty: false });
const NOW = new Date('2026-09-15T09:00:00.000Z');
let dir: string;
let repos: Repositories;
let config: AtlasConfig;

const read = (range: '7d' | '30d' | 'all' = '30d') =>
  buildSalesDashboard(repos, config, { range, now: new Date(NOW.getTime() + 60_000), gmailConfigured: false });
const count = (board: ReturnType<typeof read>, stage: string) => board.funnel.find((f) => f.stage === stage)!.count;

function discover(domain: string, at = NOW.toISOString()) {
  const { prospect } = repos.sales.discover({
    batchId: 'BATCH-LIVE', companyName: domain, domain, website: `https://${domain}`, country: 'FR',
    sourceUrl: `https://${domain}/`, discoveredAt: at, pageType: 'OFFICIAL_COMPANY_SITE', guardVersion: 'test',
  });
  return prospect;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-dash-live-'));
  repos = createRepositories(join(dir, 'atlas.db'), logger);
  config = makeTestConfig(dir);
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('données déjà présentes', () => {
  test('une base remplie se lit juste dès la première lecture — sans rien créer', () => {
    for (let i = 0; i < 40; i += 1) {
      const p = discover(`hist-${i}.fr`, new Date(NOW.getTime() - i * 86_400_000).toISOString());
      if (i < 25) {
        repos.sales.setScore(p.id, { score: 70, tier: 'GOOD_FIT', detail: {}, whyFit: 't' });
        repos.sales.setState(p.id, 'QUALIFIED');
      }
      if (i < 10) {
        repos.sales.recordOutreach({ domain: p.domain!, kind: 'CONTACTED', recordedBy: 'noaroy', channel: 'email', recordedAt: new Date(NOW.getTime() - i * 86_400_000).toISOString() });
      }
    }
    const before = repos.db.prepare('SELECT COUNT(*) AS n FROM sales_prospects').get() as { n: number };
    const board = read('all');
    assert.equal(count(board, 'discovered'), 40);
    assert.equal(count(board, 'icpQualified'), 25);
    assert.equal(count(board, 'contacted'), 10);
    assert.equal(count(read('7d'), 'discovered'), 7, 'sept jours : aujourd’hui et les six jours précédents');
    const after = repos.db.prepare('SELECT COUNT(*) AS n FROM sales_prospects').get() as { n: number };
    assert.equal(after.n, before.n, 'lire n’écrit rien');
  });
});

describe('chaque écriture change la lecture suivante', () => {
  test('entreprise → qualifiée → contactée → réponse → RDV → client → recommandation', () => {
    assert.equal(count(read(), 'discovered'), 0);
    assert.equal(read().todo.total, 0);

    const p = discover('acme.fr');
    assert.equal(count(read(), 'discovered'), 1);

    repos.sales.setScore(p.id, { score: 80, tier: 'PRIORITY', detail: {}, whyFit: 't' });
    repos.sales.setState(p.id, 'QUALIFIED');
    repos.sales.setContact(p.id, { email: 'jean@acme.fr', sourceUrl: 'https://acme.fr/contact', observed: true, method: 'EMAIL', name: 'Jean Dupont', role: 'Directeur Export' });
    let board = read();
    assert.equal(count(board, 'icpQualified'), 1);
    assert.equal(count(board, 'contactsFound'), 1);

    repos.sales.recordOutreach({ domain: 'acme.fr', kind: 'CONTACTED', recordedBy: 'sales-engine', channel: 'email' });
    assert.equal(count(read(), 'contacted'), 1);

    const { conversation } = repos.conversations.open({ domain: 'acme.fr', companyName: 'Acme', channel: 'email', destination: 'jean@acme.fr' });
    repos.conversations.recordInboundEvent({
      conversationId: conversation.id, kind: 'EMAIL_REPLY', classification: 'REPLIED', confidence: 0.8, source: 'test',
      sender: 'Jean Dupont <jean@acme.fr>', rawSubject: 'RE: 3 prospects', bodyExcerpt: 'Oui, cela pourrait nous intéresser, appelons-nous.',
    });
    repos.salesEngine.reopenLead('acme.fr');
    board = read();
    assert.equal(count(board, 'replied'), 1);
    assert.equal(count(board, 'positiveReplies'), 1);
    assert.equal(board.hotLeadsTotal, 1);
    assert.equal(board.hotLeads[0]!.contact, 'Jean Dupont · Directeur Export');
    assert.equal(board.todo.hotLeads, 1);

    recordSalesOutcome(repos, { domain: 'acme.fr', kind: 'MEETING_BOOKED', by: 'founder' });
    board = read();
    assert.equal(board.cards.meetings, 1);
    assert.equal(count(board, 'meetings'), 1);
    assert.equal(board.todo.hotLeads, 0, 'le rendez-vous consigné traite la réponse');

    recordSalesOutcome(repos, { domain: 'acme.fr', kind: 'WON', revenueAmount: 1190, by: 'founder' });
    board = read();
    assert.equal(board.cards.clientsSigned, 1);
    assert.equal(board.cards.revenueSigned, 1190);
    assert.equal(count(board, 'clients'), 1);
    assert.equal(board.hotLeadsTotal, 0, 'un client gagné n’est plus une réponse à traiter');
    assert.equal(board.performance.revenuePer100, 119_000);

    const { recommendation } = repos.salesEngine.propose({ kind: 'CHANGE_FOLLOWUP', title: 'Revoir la relance', reason: '40 relances, 0 réponse', fingerprint: 'CF' });
    board = read();
    assert.equal(board.todo.recommendations, 1);
    assert.equal(board.recommendations[0]!.id, recommendation.id);
    assert.ok('evidence' in board.recommendations[0]!);
  });

  test('un dossier à relire, une relance due, une campagne à approuver en PRODUCTION : « À faire » les compte', () => {
    const p = discover('todo.fr');
    repos.sales.setScore(p.id, { score: 80, tier: 'PRIORITY', detail: {}, whyFit: 't' });
    repos.sales.setState(p.id, 'QUALIFIED');
    // L'état de relecture est posé directement : les gardes d'éligibilité qui
    // le protègent ont leurs propres tests ; ici on compte ce qui attend.
    repos.db.prepare("UPDATE sales_prospects SET state = 'READY_FOR_REVIEW' WHERE id = ?").run(p.id);
    repos.salesLoop.saveDraft({ domain: 'autre.fr', companyName: 'Autre', recipient: 'c@autre.fr', subject: 's', body: 'b', purpose: 'FIRST_TOUCH', sources: [], createdBy: 't' });
    repos.salesLoop.recordTransition({ domain: 'relance.fr', fromState: null, toState: 'FOLLOW_UP_REQUIRED', actor: 't' });
    repos.salesEngine.createSegment({ name: 'Packaging' });
    assert.deepEqual(
      (({ approvals, followUps, segmentsToApprove }) => ({ approvals, followUps, segmentsToApprove }))(read().todo),
      { approvals: 2, followUps: 1, segmentsToApprove: 0 },
    );
    const prod = { ...config, sales: { ...config.sales, engineMode: 'PRODUCTION' as const } };
    assert.equal(buildSalesDashboard(repos, prod, { now: NOW, gmailConfigured: false }).todo.segmentsToApprove, 1);
  });
});

describe('INTERNAL_TEST et simulations n’entrent pas dans les chiffres', () => {
  test('un envoi simulé (expéditeur à blanc) reste au registre mais ne compte pas comme contact', async () => {
    const { segment } = repos.salesEngine.createSegment({ name: 'Test' });
    repos.salesEngine.approveSegmentForSend(segment.id, 'founder');
    repos.salesEngine.attribute({ domain: 'simu.fr', segmentId: segment.id });
    const draft = repos.salesLoop.saveDraft({ domain: 'simu.fr', companyName: 'Simu', recipient: 'c@simu.fr', subject: 's', body: 'b', purpose: 'FIRST_TOUCH', sources: [], createdBy: 't' });
    repos.salesLoop.decideDraft({ draftId: draft.id, decision: 'APPROVED_TO_SEND', decidedBy: 'founder' });
    const prod = { ...config, sales: { ...config.sales, outboundEnabled: true, engineMode: 'PRODUCTION' as const } };
    const report = await runSendCycle({ repos, config: prod, logger }, { outbound: async () => new DryRunOutboundProvider(), now: NOW });
    assert.equal(report.simulated, 1);
    assert.equal(repos.sales.ledgerFor('simu.fr')?.kind, 'CONTACTED', 'le registre garde la trace');
    assert.equal(count(read(), 'contacted'), 0, 'le tableau ne la compte pas');
  });

  test('une mission client INTERNAL_TEST ne touche pas l’entonnoir commercial', () => {
    discover('reel.fr');
    repos.missions.create({
      title: 'Client — test interne', objective: 'x', createdBy: 'test', tokenBudget: 0,
      context: { kind: 'client-mission', executionMode: 'INTERNAL_TEST', briefs: [], batches: [] },
    });
    const board = read('all');
    assert.equal(count(board, 'discovered'), 1);
    assert.equal(count(board, 'contacted'), 0);
    assert.equal(board.cards.clientsSigned, 0);
  });
});

describe('nos propres courriers ne sont pas des réponses', () => {
  test('un message de la boîte surveillée importé comme REPLIED ne compte ni en réponse ni en réponse chaude', () => {
    const { conversation } = repos.conversations.open({ domain: 'histo.fr', companyName: 'Histo' });
    repos.conversations.recordInboundEvent({
      conversationId: conversation.id, kind: 'EMAIL_REPLY', classification: 'REPLIED', confidence: 0.7, source: 'gmail (OUTREACH_ADDRESS)',
      sender: 'Noa Roy <noa.roy@gmail.com>', bodyExcerpt: 'Bonjour, j’ai vu que Histo propose… Pouvons-nous en parler ?',
    });
    const board = buildSalesDashboard(repos, config, { range: 'all', now: NOW, gmailConfigured: false, mailbox: 'noaroy@gmail.com' });
    assert.equal(count(board, 'replied'), 0);
    assert.equal(board.hotLeadsTotal, 0);
    repos.conversations.recordInboundEvent({
      conversationId: conversation.id, kind: 'EMAIL_REPLY', classification: 'REPLIED', confidence: 0.8, source: 'gmail (THREAD)',
      sender: 'Commercial <commercial@histo.fr>', bodyExcerpt: 'Oui, cela pourrait nous intéresser.',
    });
    const after = buildSalesDashboard(repos, config, { range: 'all', now: NOW, gmailConfigured: false, mailbox: 'noaroy@gmail.com' });
    assert.equal(count(after, 'replied'), 1);
    assert.equal(after.hotLeadsTotal, 1);
  });
});

describe('les opportunités', () => {
  test('les prospects à saisir, dans un ordre stable, avec ce qui est enregistré — et rien d’écrit', () => {
    const top = discover('top.fr');
    repos.sales.setScore(top.id, { score: 90, tier: 'PRIORITY', detail: {}, whyFit: 'fabricant de machines, export Europe' });
    repos.sales.setState(top.id, 'QUALIFIED');
    repos.sales.setContact(top.id, { email: 'export@top.fr', sourceUrl: 'https://top.fr/contact', observed: true, method: 'EMAIL', name: 'Marie Curie', role: 'Export' });
    const fit = discover('fit.fr');
    repos.sales.setScore(fit.id, { score: 95, tier: 'GOOD_FIT', detail: {}, whyFit: 'distributeur' });
    discover('neuf.fr');
    const contacted = discover('deja.fr');
    repos.sales.setScore(contacted.id, { score: 99, tier: 'PRIORITY', detail: {}, whyFit: 't' });
    repos.sales.recordOutreach({ domain: 'deja.fr', kind: 'CONTACTED', recordedBy: 'sales-engine', channel: 'email', recordedAt: '2026-01-01T00:00:00.000Z' });
    const rejected = discover('non.fr');
    repos.sales.setState(rejected.id, 'REJECTED');
    discover('gagne.fr');
    recordSalesOutcome(repos, { domain: 'gagne.fr', kind: 'WON', revenueAmount: 500, by: 'founder' });

    const before = repos.db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS u FROM sales_prospects').get();
    const board = read('7d');
    assert.deepEqual(board.opportunities.map((o) => o.domain), ['top.fr', 'fit.fr', 'neuf.fr'], 'palier, puis score : jamais contactés, ni rejetés, ni conclus');
    assert.equal(board.opportunitiesTotal, 3);
    const first = board.opportunities[0]!;
    assert.equal(first.state, 'QUALIFIED');
    assert.equal(first.tier, 'PRIORITY');
    assert.equal(first.score, 90);
    assert.equal(first.whyFit, 'fabricant de machines, export Europe');
    assert.equal(first.contact.email, 'export@top.fr');
    assert.equal(first.contact.name, 'Marie Curie');
    assert.equal(first.contact.observed, true);
    assert.equal(first.contact.sourceUrl, 'https://top.fr/contact');
    assert.equal(first.sourceUrl, 'https://top.fr/');
    assert.ok(first.updatedAt);
    assert.equal(board.opportunities[2]!.tier, null, 'non scoré : dernier, sans palier inventé');
    assert.deepEqual(read('7d').opportunities, board.opportunities, 'deux lectures, le même ordre');
    assert.deepEqual(repos.db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS u FROM sales_prospects').get(), before, 'lire n’écrit rien');
  });
});

describe('recalcul direct', () => {
  test('un calcul SQL depuis les tables donne les mêmes valeurs que le tableau', () => {
    for (let i = 0; i < 30; i += 1) {
      const p = discover(`sql-${i}.fr`);
      if (i < 20) {
        repos.sales.setScore(p.id, { score: 70, tier: 'GOOD_FIT', detail: {}, whyFit: 't' });
        repos.sales.setState(p.id, 'QUALIFIED');
      }
      if (i < 12) repos.sales.setContact(p.id, { email: `c@sql-${i}.fr`, sourceUrl: `https://sql-${i}.fr/contact`, observed: true });
      if (i < 10) {
        repos.sales.recordOutreach({ domain: p.domain!, kind: 'CONTACTED', recordedBy: 't', channel: 'email' });
        const { conversation } = repos.conversations.open({ domain: p.domain!, companyName: p.domain! });
        if (i < 4) {
          repos.conversations.recordInboundEvent({ conversationId: conversation.id, kind: 'EMAIL_REPLY', classification: 'REPLIED', confidence: 0.8, source: 't', bodyExcerpt: i < 2 ? 'Oui, intéressé, planifions un appel' : 'Bien reçu' });
        }
      }
      if (i < 2) repos.salesEngine.recordOutcome({ domain: p.domain!, kind: 'MEETING_BOOKED', recordedBy: 'f' });
      if (i < 1) repos.salesEngine.recordOutcome({ domain: p.domain!, kind: 'WON', revenueAmount: 900, recordedBy: 'f' });
    }
    const board = read('all');
    const q = (sql: string) => (repos.db.prepare(sql).get() as { n: number }).n;
    assert.equal(count(board, 'discovered'), q('SELECT COUNT(*) AS n FROM sales_prospects'));
    assert.equal(count(board, 'icpQualified'), q("SELECT COUNT(*) AS n FROM sales_prospects WHERE tier IS NOT NULL AND tier != 'REJECTED' AND state != 'REJECTED'"));
    assert.equal(count(board, 'contactsFound'), q('SELECT COUNT(*) AS n FROM sales_prospects WHERE contact_email IS NOT NULL OR contact_page IS NOT NULL'));
    assert.equal(count(board, 'contacted'), q("SELECT COUNT(DISTINCT canonical_domain) AS n FROM outreach_ledger WHERE kind = 'CONTACTED' AND (note IS NULL OR note NOT LIKE 'simulation%')"));
    assert.equal(count(board, 'replied'), q("SELECT COUNT(DISTINCT c.canonical_domain) AS n FROM sales_conversation_events e JOIN sales_conversations c ON c.id = e.conversation_id WHERE e.classification IN ('REPLIED','NEEDS_REVIEW')"));
    assert.equal(count(board, 'positiveReplies'), 2);
    assert.equal(count(board, 'meetings'), q("SELECT COUNT(DISTINCT domain) AS n FROM sales_outcomes WHERE kind IN ('MEETING_BOOKED','MEETING_DONE')"));
    assert.equal(count(board, 'clients'), q("SELECT COUNT(DISTINCT domain) AS n FROM sales_outcomes WHERE kind = 'WON'"));
    assert.equal(board.cards.revenueSigned, (repos.db.prepare("SELECT COALESCE(SUM(revenue_amount),0) AS n FROM sales_outcomes WHERE kind='WON'").get() as { n: number }).n);
  });
});
