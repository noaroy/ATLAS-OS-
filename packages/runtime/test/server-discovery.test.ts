import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../core/src/logger.ts';
import type { AtlasConfig } from '../../core/src/index.ts';
import { createRepositories, type Repositories, type TaskRow } from '../../data/src/index.ts';
import { makeTestConfig } from '../../testing/src/index.ts';
import { createSalesEngineHandlers, SALES_ENGINE_TASKS, materializeFirstTouchDrafts, runSendCycle } from '../src/sales-engine.ts';
import { runRevenueFactory } from '../src/revenue-factory.ts';
import { promoteExpansionBacklog } from '../src/expansion/engine.ts';
import type { WorkerContext } from '../src/workers.ts';
import { site, fixtureFetch, discovered, partners } from './helpers/factory-fixtures.ts';

/**
 * La découverte sur l'image serveur (dist-only) : pas de `scripts/`, pas de
 * `tsx`. SALES_DISCOVERY ne s'arrête plus en WAITING_HUMAN ; elle verse au
 * registre commercial ce que l'expansion a déjà trouvé et qualifié — avec sa
 * provenance, sans doublon, sans coût — et la fabrique le traite au passage
 * suivant.
 */

const logger = createLogger({ level: 'error', pretty: false });
const NOW = new Date('2026-09-28T08:30:00.000Z');
let dir: string;
let emptyRoot: string;
let repos: Repositories;
let config: AtlasConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-server-discovery-'));
  emptyRoot = join(dir, 'app');
  mkdirSync(emptyRoot);
  repos = createRepositories(join(dir, 'd.db'), logger);
  config = makeTestConfig(dir);
});
afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const context: WorkerContext = { logger, heartbeat: () => true, shuttingDown: () => false, correlationId: null };
const task = (taskType: string): TaskRow => ({
  taskId: 'tsk_disc', taskType, department: 'sales', workerType: 'DETERMINISTIC', priority: 0, status: 'RUNNING',
  payload: {}, result: null, createdAt: NOW.toISOString(), availableAt: NOW.toISOString(), startedAt: null, finishedAt: null,
  attemptCount: 1, maxAttempts: 3, leaseOwner: null, leaseUntil: null, lastHeartbeatAt: null, parentTaskId: null,
  correlationId: null, idempotencyKey: null, estimatedCost: null, actualCost: null, errorCode: null, errorMessage: null,
  metadata: {}, chainId: null, chainDepth: 0, fingerprint: null,
});

/** Un tour d'expansion SALES terminé : ses candidats, leurs verdicts, leurs preuves. */
function expansionRun(candidates: Array<{ domain: string | null; name: string; stage: 'QUALIFIED' | 'HIGH_PRIORITY' | 'REJECTED' | 'UNIVERSE'; seed?: boolean }>, purpose: 'SALES' | 'CLIENT' = 'SALES', status: 'DONE' | 'CAPPED' | 'FAILED' = 'DONE') {
  const run = repos.expansion.startRun({ purpose, trigger: 'test', seeds: [{ name: 'Graine', domain: 'graine.fr' }], strategies: ['partners'], limits: {}, startedAt: NOW.toISOString() });
  for (const c of candidates) {
    const key = c.domain ?? `name:${c.name}`;
    const { candidate } = repos.expansion.upsertCandidate({
      runId: run.id, entityKey: key, companyName: c.name, canonicalDomain: c.domain, website: c.domain ? `https://${c.domain}` : null,
      country: 'FR', depth: 1, seedKey: 'graine.fr', isSeed: c.seed ?? false,
    });
    repos.expansion.setCandidateVerdict(candidate.id, { stage: c.stage, icpStatus: c.stage === 'REJECTED' ? 'REJECTED' : 'FIT', score: c.stage === 'REJECTED' ? 10 : 70, scoreDetail: {} });
    repos.expansion.addRelationship({
      runId: run.id, sourceKey: 'graine.fr', sourceName: 'Graine', sourceKind: 'COMPANY', targetKey: key, targetName: c.name,
      relationshipType: 'COMPLEMENTARY_VENDOR', confidence: 0.8, status: 'VERIFIED', evidenceUrl: 'https://graine.fr/partenaires',
      evidenceSummary: `${c.name} est présenté comme partenaire de Graine.`, sourceMethod: 'test', sourceTrust: 'OFFICIAL', country: 'FR', sourceDate: null,
    });
    repos.expansion.addEvidence({
      runId: run.id, entityKey: key, kind: 'RELATIONSHIP', claim: `COMPLEMENTARY_VENDOR de Graine`, url: 'https://graine.fr/partenaires',
      excerpt: null, trust: 'OFFICIAL', method: 'test', confidence: 0.8,
    });
  }
  repos.expansion.finishRun(run.id, { status, stats: {}, summary: null });
  return run;
}

const handlers = (cfg: AtlasConfig = config) => createSalesEngineHandlers({ repos, config: cfg, logger, now: () => NOW, sourceRoot: emptyRoot });
const discover = (cfg?: AtlasConfig) => handlers(cfg)[SALES_ENGINE_TASKS.DISCOVERY]!(task(SALES_ENGINE_TASKS.DISCOVERY), context);
const salesDomains = () => repos.sales.discoveredSince(null).map((p) => p.domain).sort();

describe('SALES_DISCOVERY sur l’image serveur (script absent)', () => {
  test('rien à verser : DONE, jamais WAITING_HUMAN, et la friction le dit', async () => {
    const outcome = await discover();
    assert.equal(outcome.kind, 'DONE');
    assert.equal(outcome.result?.ran, false);
    assert.doesNotMatch(String(outcome.result?.reason), /script absent/);
    assert.equal(salesDomains().length, 0);
  });

  test('les candidats qualifiés deviennent des sales_prospects, avec provenance ; rien d’autre ne passe', async () => {
    discovered(repos, 'deja-connu.fr', 'Déjà Connu');
    const run = expansionRun([
      { domain: 'merand.fr', name: 'Mérand', stage: 'HIGH_PRIORITY' },
      { domain: 'fourpro.fr', name: 'FourPro', stage: 'QUALIFIED' },
      { domain: 'rejete.fr', name: 'Rejeté', stage: 'REJECTED' },
      { domain: 'brut.fr', name: 'Brut', stage: 'UNIVERSE' },
      { domain: 'deja-connu.fr', name: 'Déjà Connu', stage: 'QUALIFIED' },
      { domain: null, name: 'Sans Domaine', stage: 'QUALIFIED' },
      { domain: 'graine.fr', name: 'Graine', stage: 'QUALIFIED', seed: true },
    ]);
    expansionRun([{ domain: 'client-mission.fr', name: 'Mission', stage: 'QUALIFIED' }], 'CLIENT');
    expansionRun([{ domain: 'tour-echoue.fr', name: 'Échoué', stage: 'QUALIFIED' }], 'SALES', 'FAILED');

    const outcome = await discover();
    assert.equal(outcome.kind, 'DONE');
    assert.equal(outcome.result?.ran, true);
    assert.equal(outcome.result?.discovered, 2);
    assert.equal(outcome.result?.costUsd, 0);
    assert.deepEqual(salesDomains(), ['deja-connu.fr', 'fourpro.fr', 'merand.fr']);

    const p = repos.sales.discoveredSince(null).find((x) => x.domain === 'merand.fr')!;
    assert.equal(p.searchProvider, 'expansion');
    assert.equal(p.sourceUrl, 'https://graine.fr/partenaires');
    assert.match(p.batchId, /^xpn_/);
    assert.ok(repos.sales.evidenceFor(p.id).some((e) => e.sourceUrl === 'https://graine.fr/partenaires'));
    assert.equal(repos.expansion.candidate(run.id, 'merand.fr')!.prospectId, p.id);

    // Idempotent : un second passage ne crée rien.
    const again = await discover();
    assert.equal(again.result?.ran, false);
    assert.equal(salesDomains().length, 3);
  });

  test('budget IA du jour épuisé : la voie serveur ($0) passe quand même', async () => {
    expansionRun([{ domain: 'merand.fr', name: 'Mérand', stage: 'QUALIFIED' }]);
    const outcome = await discover({ ...config, sales: { ...config.sales, dailyAiBudgetUsd: 0 } });
    assert.equal(outcome.kind, 'DONE');
    assert.equal(outcome.result?.ran, true);
    assert.equal(repos.llmCalls.usageSince('1970-01-01T00:00:00.000Z').knownCostUsd, 0);
  });

  test('découverte désactivée : rien n’est versé', async () => {
    expansionRun([{ domain: 'merand.fr', name: 'Mérand', stage: 'QUALIFIED' }]);
    const outcome = await discover({ ...config, sales: { ...config.sales, discoveryEnabled: false } });
    assert.equal(outcome.result?.ran, false);
    assert.equal(salesDomains().length, 0);
  });
});

describe('de la découverte serveur à la fabrique', () => {
  test('SALES_DISCOVERY verse, puis la fabrique voit une file et traite ; 0 message, $0', async () => {
    const names: Array<[string, string]> = [['merand.fr', 'Mérand'], ['fourpro.fr', 'FourPro'], ['bongard.fr', 'Bongard']];
    expansionRun(names.map(([domain, name]) => ({ domain, name, stage: 'QUALIFIED' as const })));
    for (const [domain] of names) partners(repos, domain, [{ domain: 'bridor.fr', name: 'Bridor' }, { domain: 'panamar.es', name: 'Panamar' }]);
    await discover();

    const report = await runRevenueFactory({ repos, config, logger, fetchPages: fixtureFetch(names.map(([d, n]) => site(d, n))), now: () => NOW }, { limits: { batchSize: 2 } });
    assert.equal(report.processed, 2);
    assert.equal(report.queueRemaining, 1, 'la file reflète ce qui reste');
    assert.equal(report.costUsd, 0);
    const next = await runRevenueFactory({ repos, config, logger, fetchPages: fixtureFetch(names.map(([d, n]) => site(d, n))), now: () => NOW }, { limits: { batchSize: 2 } });
    assert.equal(next.processed, 1, 'reprise : le reste, et rien deux fois');
    assert.equal(repos.revenueFactory.verdicts({}).length, 3);
    assert.equal(repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z'), 0);
  });

  test('file vide : la fabrique verse elle-même le reliquat de l’expansion avant de conclure QUEUE_EMPTY', async () => {
    expansionRun([{ domain: 'merand.fr', name: 'Mérand', stage: 'HIGH_PRIORITY' }, { domain: 'fourpro.fr', name: 'FourPro', stage: 'QUALIFIED' }]);
    const report = await runRevenueFactory({ repos, config, logger, fetchPages: fixtureFetch([site('merand.fr', 'Mérand'), site('fourpro.fr', 'FourPro')]), now: () => NOW });
    assert.equal(report.promotedFromExpansion, 2);
    assert.equal(report.processed, 2);
    const again = await runRevenueFactory({ repos, config, logger, fetchPages: fixtureFetch([]), now: () => NOW });
    assert.equal(again.promotedFromExpansion, 0);
    assert.equal(again.processed, 0);
    assert.equal(salesDomains().length, 2, 'aucun doublon');
  });

  test('le reliquat respecte sa limite et reprend là où il s’est arrêté', () => {
    expansionRun(Array.from({ length: 5 }, (_, i) => ({ domain: `societe-${i}.fr`, name: `Société ${i}`, stage: 'QUALIFIED' as const })));
    assert.equal(promoteExpansionBacklog(repos, { limit: 3, now: NOW }).promoted.length, 3);
    assert.equal(promoteExpansionBacklog(repos, { limit: 3, now: NOW }).promoted.length, 2);
    assert.equal(promoteExpansionBacklog(repos, { limit: 3, now: NOW }).promoted.length, 0);
    assert.equal(salesDomains().length, 5);
  });
});

describe('E2E — découverte serveur → fabrique → brouillon personnalisé → READY_FOR_APPROVAL, stop', () => {
  test('deux entreprises éligibles, une non éligible : brouillons propres à chacune, idempotents, rien ne part', async () => {
    const names: Array<[string, string]> = [['merand.fr', 'Mérand'], ['fourpro.fr', 'FourPro']];
    expansionRun([...names.map(([domain, name]) => ({ domain, name, stage: 'QUALIFIED' as const })), { domain: 'formulaire.fr', name: 'Formulaire', stage: 'QUALIFIED' }]);
    partners(repos, 'merand.fr', [{ domain: 'bridor.fr', name: 'Bridor' }, { domain: 'panamar.es', name: 'Panamar' }]);
    partners(repos, 'fourpro.fr', [{ domain: 'greggs.co.uk', name: 'Greggs' }, { domain: 'europastry.com', name: 'Europastry' }]);
    partners(repos, 'formulaire.fr', [{ domain: 'bridor.fr', name: 'Bridor' }, { domain: 'panamar.es', name: 'Panamar' }]);

    // DISCOVERED (découverte serveur) → qualification, contact, preuves, recommandations (fabrique)
    assert.equal((await discover()).result?.discovered, 3);
    await runRevenueFactory({ repos, config, logger, fetchPages: fixtureFetch([site('merand.fr', 'Mérand'), site('fourpro.fr', 'FourPro'), site('formulaire.fr', 'Formulaire', 'FORM_ONLY')]), now: () => NOW });
    const eligible = repos.revenueFactory.verdicts({ sendEligible: true }).map((v) => v.domain).sort();
    assert.deepEqual(eligible, ['fourpro.fr', 'merand.fr']);
    assert.equal(repos.revenueFactory.verdict('formulaire.fr')!.sendEligible, false);

    // Boucle B, configuration de production réelle : approbation humaine, interrupteur fermé.
    assert.equal(config.sales.outboundEnabled, false);
    assert.equal(config.sales.engineMode, 'INTERNAL_TEST');
    const first = materializeFirstTouchDrafts(repos, { ...config, sales: { ...config.sales, humanApprovalRequired: true } }, { now: NOW, transportConfigured: true });
    const ready = repos.salesLoop.draftsInState('READY_FOR_APPROVAL');
    assert.deepEqual(ready.map((d) => d.domain).sort(), eligible, JSON.stringify(first));
    assert.equal(repos.salesLoop.draftsForDomain('formulaire.fr').length, 0, 'non éligible : aucun brouillon');

    for (const d of ready) {
      const p = repos.sales.discoveredSince(null).find((x) => x.domain === d.domain)!;
      const other = ready.find((x) => x.domain !== d.domain)!;
      assert.equal(d.recipient, p.contactEmail, 'le contact observé de CETTE entreprise');
      assert.ok(d.recipient.endsWith(`@${d.domain}`));
      const mine = d.domain === 'merand.fr' ? ['Bridor', 'Panamar'] : ['Greggs', 'Europastry'];
      const theirs = d.domain === 'merand.fr' ? ['Greggs', 'Europastry'] : ['Bridor', 'Panamar'];
      for (const n of mine) assert.match(d.body, new RegExp(n), `${d.domain} cite ses propres recommandations`);
      for (const n of theirs) assert.doesNotMatch(d.body, new RegExp(n), `${d.domain} ne cite jamais celles d’une autre entreprise`);
      assert.doesNotMatch(d.body, new RegExp(other.domain.replace('.', '\\.')), 'aucun mélange de domaines');
      assert.doesNotMatch(d.body, /\{\{|\[\[|TODO|XXX|lorem/i, 'aucun gabarit resté ouvert');
      assert.ok(d.sources.length >= 2 && d.sources.every((s) => /^https:\/\//.test(s.sourceUrl)), 'provenance conservée');
      assert.ok(d.sources.some((s) => s.sourceUrl.includes(d.domain)), 'au moins un fait lu sur le site de CETTE entreprise');
    }

    // Idempotent : un second passage ne rédige rien de plus.
    const second = materializeFirstTouchDrafts(repos, { ...config, sales: { ...config.sales, humanApprovalRequired: true } }, { now: NOW, transportConfigured: true });
    assert.equal(second.drafted, 0);
    assert.equal(repos.salesLoop.draftsInState('READY_FOR_APPROVAL').length, 2);

    // Même approuvé, un brouillon ne part pas tant que l'envoi est fermé.
    assert.equal(repos.salesLoop.decideDraft({ draftId: ready[0]!.id, decision: 'APPROVED_TO_SEND', decidedBy: 'founder@test.local' }).applied, true);
    const sent: string[] = [];
    await runSendCycle({ repos, config, logger }, {
      outbound: async () => ({ id: 'must-not-send', status: () => ({ configured: true, code: 'READY', detail: '', scopes: [] }),
        sendEmail: async (m: { to: string }) => { sent.push(m.to); throw new Error('ne doit jamais être appelé'); },
        replyToThread: async (m: { to: string }) => { sent.push(m.to); throw new Error('ne doit jamais être appelé'); } }) as never,
      now: NOW,
    });
    assert.deepEqual(sent, []);
    assert.equal(repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z'), 0);
  });
});
