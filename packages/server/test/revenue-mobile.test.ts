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
import { setGlobalPause } from '../../runtime/src/index.ts';
import { buildRevenueMobile, buildProspectDetail, isDomainParam, outboundModeOf } from '../src/http/revenue-mobile.ts';
import { withoutEnvNames } from '../src/http/command-center.ts';
import { createSystem, type AtlasSystem } from '../src/bootstrap.ts';
import { createApp } from '../src/app.ts';

/**
 * L'écran de téléphone et la fiche prospect.
 *
 * Lus depuis un hébergeur tiers, toutes les dix secondes : exacts sur une base
 * vide, clairs sur l'état d'envoi, fidèles aux gardes du premier contact, et
 * sans jamais un identifiant.
 */

const logger = createLogger({ level: 'error', pretty: false });
const NOW = new Date('2026-09-26T12:00:00.000Z');
let dir: string;
let repos: Repositories;
let config: AtlasConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-mobile-'));
  repos = createRepositories(join(dir, 'm.db'), logger);
  config = makeTestConfig(dir);
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const view = () => buildRevenueMobile(repos, config, { now: NOW, gmailConfigured: false });

function prospect(domain: string, opts: {
  at?: string; tier?: 'PRIORITY' | 'GOOD_FIT' | 'REJECTED'; observed?: boolean; email?: string | null; facts?: number;
} = {}) {
  const { prospect: p } = repos.sales.discover({
    batchId: 'M-001', companyName: domain.split('.')[0]!.toUpperCase(), domain, website: `https://${domain}`,
    sourceUrl: `https://${domain}/`, discoveredAt: opts.at ?? '2026-09-26T08:00:00.000Z',
  });
  const tier = opts.tier ?? 'PRIORITY';
  repos.sales.setScore(p.id, { score: 80, tier, detail: {}, whyFit: 'fabricant industriel' });
  if (tier !== 'REJECTED') repos.sales.setState(p.id, 'QUALIFIED');
  if (opts.email !== null) {
    repos.sales.setContact(p.id, {
      email: opts.email ?? `contact@${domain}`, sourceUrl: `https://${domain}/contact`,
      method: 'EMAIL', observed: opts.observed ?? true,
    });
  }
  for (let i = 0; i < (opts.facts ?? 2); i++) {
    repos.sales.addEvidence({
      prospectId: p.id, field: `verbatim:${i}`, claim: `Fait commercial observé numéro ${i} sur le site.`,
      nature: 'observed', sourceUrl: `https://${domain}/page-${i}`, basis: null, confidence: 0.9,
    });
  }
  return p;
}

function relation(source: string, target: string, type: string, opts: { status?: 'VERIFIED' | 'INFERRED'; trust?: 'OFFICIAL' | 'SECONDARY'; confidence?: number } = {}) {
  repos.expansion.addRelationship({
    runId: null, sourceKey: source, sourceName: source, sourceKind: 'COMPANY',
    targetKey: target, targetName: target.split('.')[0]!.toUpperCase(), relationshipType: type,
    confidence: opts.confidence ?? 0.9, status: opts.status ?? 'VERIFIED',
    evidenceUrl: `https://${source}/partenaires`, evidenceSummary: `${target} est cité comme partenaire de ${source}.`,
    sourceMethod: 'test', sourceTrust: opts.trust ?? 'OFFICIAL', country: 'FR', sourceDate: null,
  });
}

describe('vue revenue : base vide', () => {
  test('des zéros mesurés, et des absences dites absentes', () => {
    const v = view();
    assert.equal(v.kpis.discoveredToday, 0);
    assert.equal(v.kpis.proposals, null, 'aucune proposition consignée : N/A, pas zéro');
    assert.equal(v.costs.todayUsd.total, null, 'aucun appel : coût inconnu, pas gratuit');
    assert.equal(v.header.lastRevenueActionAt, null);
    assert.deepEqual(v.priorityProspects, []);
    assert.deepEqual(v.drafts.items, []);
    assert.deepEqual(v.expansions, []);
  });

  test('l’entonnoir suit l’ordre demandé, PROPOSAL sans chiffre', () => {
    const v = view();
    assert.deepEqual(v.funnel.map((s) => s.key),
      ['DISCOVERED', 'QUALIFIED', 'CONTACT_READY', 'SENT', 'REPLY', 'MEETING', 'PROPOSAL', 'WON']);
    assert.equal(v.funnel.find((s) => s.key === 'PROPOSAL')!.count, null);
  });
});

describe('vue revenue : état d’envoi', () => {
  test('OFF tant que l’interrupteur est baissé, quel que soit le mode', () => {
    assert.equal(view().header.outbound, 'OFF');
    config.sales.engineMode = 'PRODUCTION';
    assert.equal(outboundModeOf(config), 'OFF');
  });

  test('INTERNAL_TEST et ACTIVE ne se confondent pas', () => {
    config.sales.outboundEnabled = true;
    assert.equal(outboundModeOf(config), 'INTERNAL_TEST');
    config.sales.engineMode = 'PRODUCTION';
    assert.equal(outboundModeOf(config), 'ACTIVE');
  });

  test('kill switch : affiché, signé, et l’état se dégrade', () => {
    setGlobalPause(repos, true, 'founder@test.local', 'essai');
    const v = view();
    assert.equal(v.header.killSwitch.paused, true);
    assert.equal(v.header.status, 'DEGRADED');
    assert.ok(v.header.reasons.some((r) => r.includes('kill switch')));
  });
});

describe('vue revenue : la journée et le contact-ready', () => {
  test('aujourd’hui seulement, contact-ready seulement sur adresse observée', () => {
    prospect('hier.example', { at: '2026-09-25T10:00:00.000Z' });
    prospect('prio.example', { at: '2026-09-26T08:00:00.000Z' });
    prospect('devine.example', { at: '2026-09-26T09:00:00.000Z', tier: 'GOOD_FIT', observed: false });
    prospect('sansmail.example', { at: '2026-09-26T09:30:00.000Z', tier: 'GOOD_FIT', email: null });
    prospect('rejete.example', { at: '2026-09-26T10:00:00.000Z', tier: 'REJECTED' });

    const v = view();
    assert.equal(v.kpis.discoveredToday, 4, 'la veille ne compte pas');
    assert.equal(v.kpis.qualifiedToday, 3, 'un palier REJECTED n’est pas qualifié');
    assert.equal(v.kpis.contactReady, 2, 'adresse devinée ou absente : pas contact-ready');
    assert.equal(v.funnel.find((s) => s.key === 'CONTACT_READY')!.count, 2);
    assert.equal(v.header.lastRevenueAction, 'prospect découvert');
    const prio = v.priorityProspects.find((p) => p.domain === 'prio.example')!;
    assert.equal(prio.contactReady, true);
    assert.equal(v.priorityProspects.find((p) => p.domain === 'devine.example')!.contactReady, false);
  });

  test('les brouillons en attente apparaissent, sans leur corps', () => {
    repos.salesLoop.saveDraft({
      domain: 'acme.fr', companyName: 'ACME', recipient: 'contact@acme.fr', subject: 'Sujet',
      body: 'CORPS-CONFIDENTIEL', purpose: 'FIRST_TOUCH', sources: [], createdBy: 'test',
    });
    const v = view();
    assert.equal(v.drafts.awaitingApproval, 1);
    assert.equal(v.drafts.items[0]!.subject, 'Sujet');
    assert.equal(JSON.stringify(v).includes('CORPS-CONFIDENTIEL'), false, 'le corps reste sur la fiche');
  });
});

describe('fiche prospect : recommandations et blocages', () => {
  test('aucune recommandation : blocage dit, liste vide', () => {
    prospect('acme.fr');
    const d = buildProspectDetail(repos, 'acme.fr')!;
    assert.deepEqual(d.recommendations, []);
    assert.ok(d.blockers.includes('RECOMMENDATIONS_BELOW_2'));
    assert.equal(d.firstTouchReady, false);
  });

  test('une seule recommandation valide : aucune n’est montrée', () => {
    prospect('acme.fr');
    relation('acme.fr', 'alpha.fr', 'DISTRIBUTOR');
    const d = buildProspectDetail(repos, 'acme.fr')!;
    assert.deepEqual(d.recommendations, []);
    assert.ok(d.blockers.includes('RECOMMENDATIONS_BELOW_2'));
  });

  test('deux valides : prêtes ; concurrent, sous-domaine, inférée et tierce exclus', () => {
    prospect('acme.fr');
    relation('acme.fr', 'alpha.fr', 'DISTRIBUTOR');
    relation('acme.fr', 'beta.fr', 'RESELLER', { confidence: 0.8 });
    relation('acme.fr', 'rival.fr', 'COMPETITOR', { confidence: 0.99 });
    relation('acme.fr', 'similaire.fr', 'SIMILAR_COMPANY', { confidence: 0.99 });
    relation('acme.fr', 'shop.acme.fr', 'RESELLER', { confidence: 0.99 });
    relation('acme.fr', 'gamma.fr', 'DISTRIBUTOR', { status: 'INFERRED', confidence: 0.99 });
    relation('acme.fr', 'delta.fr', 'DISTRIBUTOR', { trust: 'SECONDARY', confidence: 0.99 });

    const d = buildProspectDetail(repos, 'acme.fr')!;
    assert.deepEqual(d.recommendations.map((r) => r.domain).sort(), ['alpha.fr', 'beta.fr']);
    assert.equal(d.firstTouchReady, true, JSON.stringify(d.blockers));
    assert.ok(d.urls.includes('https://acme.fr/partenaires'));
  });

  test('sans email observé : bloqué, et le motif est celui du premier contact', () => {
    prospect('acme.fr', { email: null });
    assert.ok(buildProspectDetail(repos, 'acme.fr')!.blockers.includes('NO_OBSERVED_EMAIL'));
  });

  test('supprimé ou opt-out : bloqué', () => {
    prospect('acme.fr');
    repos.salesEngine.suppress({ kind: 'DOMAIN', value: 'acme.fr', reason: 'OPT_OUT', createdBy: 'test' });
    assert.ok(buildProspectDetail(repos, 'acme.fr')!.blockers.includes('SUPPRESSED'));
  });

  test('un vieux brouillon ABANDONED ne bloque pas ; un brouillon actif, si', () => {
    prospect('acme.fr');
    const draft = repos.salesLoop.saveDraft({
      domain: 'acme.fr', companyName: 'ACME', recipient: 'contact@acme.fr', subject: 's', body: 'b',
      purpose: 'FIRST_TOUCH', sources: [], createdBy: 'test',
    });
    assert.ok(buildProspectDetail(repos, 'acme.fr')!.blockers.includes('PRIOR_FIRST_TOUCH'));
    repos.salesLoop.decideDraft({ draftId: draft.id, decision: 'ABANDONED', decidedBy: 'test', note: 'obsolète' });
    const d = buildProspectDetail(repos, 'acme.fr')!;
    assert.equal(d.blockers.includes('PRIOR_FIRST_TOUCH'), false);
    assert.equal(d.drafts[0]!.state, 'ABANDONED', 'l’historique reste visible');
  });

  test('la fiche ne déclenche aucune écriture', () => {
    prospect('acme.fr');
    const before = repos.salesLoop.historyFor('acme.fr').length;
    buildProspectDetail(repos, 'acme.fr');
    assert.equal(repos.salesLoop.historyFor('acme.fr').length, before);
  });

  test('domaine inconnu : null ; paramètre malformé : refusé', () => {
    assert.equal(buildProspectDetail(repos, 'inconnu.fr'), null);
    for (const bad of ['', '..', 'a', 'acme', 'acme..fr', '-acme.fr', 'acme.fr/../x', 'a b.fr', `${'a'.repeat(70)}.fr`]) {
      assert.equal(isDomainParam(bad), false, bad);
    }
    assert.equal(isDomainParam('Shop.ACME.fr'), true);
  });
});

describe('aucun identifiant ne sort', () => {
  test('ni valeur de clé, ni nom de variable d’identifiant', () => {
    const saved = { key: process.env.OPENAI_API_KEY, secret: process.env.GMAIL_CLIENT_SECRET };
    process.env.OPENAI_API_KEY = 'sk-test-MOBILE-SECRET-VALUE';
    process.env.GMAIL_CLIENT_SECRET = 'gmail-MOBILE-SECRET-VALUE';
    try {
      const rendu = JSON.stringify(buildRevenueMobile(repos, config, { now: NOW }));
      for (const interdit of ['MOBILE-SECRET-VALUE', 'GMAIL_CLIENT', 'GMAIL_REFRESH', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
        assert.equal(rendu.includes(interdit), false, interdit);
      }
    } finally {
      if (saved.key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.key;
      if (saved.secret === undefined) delete process.env.GMAIL_CLIENT_SECRET; else process.env.GMAIL_CLIENT_SECRET = saved.secret;
    }
  });

  test('withoutEnvNames remplace une liste de noms par une seule mention', () => {
    assert.equal(
      withoutEnvNames('manquent : GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN.'),
      'manquent : identifiants de configuration.',
    );
    assert.equal(withoutEnvNames('connecté en lecture'), 'connecté en lecture');
  });
});

describe('par HTTP', () => {
  let sandbox: string;
  let system: AtlasSystem;
  let app: FastifyInstance;
  let token: string;

  before(async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'atlas-mobile-http-'));
    const cfg = makeTestConfig(join(sandbox, 'data'));
    mkdirSync(cfg.paths.artifactDir, { recursive: true });
    system = createSystem(cfg);
    app = await createApp(system);
    await app.ready();
    const viewer = system.repos.users.create({ email: 'viewer@test.local', name: 'V', role: 'viewer', password: 'secret-pass' });
    token = system.repos.users.createSession(viewer).token;
  });

  after(async () => {
    await app.close();
    await system.shutdown('test');
    rmSync(sandbox, { recursive: true, force: true });
  });

  const auth = () => ({ authorization: `Bearer ${token}` });

  test('sans session : 401 sur les deux lectures, aucune donnée', async () => {
    for (const url of ['/api/cc/revenue', '/api/cc/prospects/acme.fr']) {
      const r = await app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 401, url);
      assert.ok(!r.body.includes('"data"'), url);
    }
  });

  test('avec une session de simple lecture : la vue revenue répond, outbound OFF', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/cc/revenue', headers: auth() });
    assert.equal(r.statusCode, 200, r.body.slice(0, 200));
    const { data } = r.json() as { data: { header: { outbound: string } } };
    assert.equal(data.header.outbound, 'OFF');
  });

  test('fiche : 400 sur domaine malformé, 404 sur domaine inconnu', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/api/cc/prospects/a%20b', headers: auth() })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/cc/prospects/inconnu.fr', headers: auth() })).statusCode, 404);
  });

  test('lectures seulement : aucune écriture n’est ouverte sur ces chemins', async () => {
    for (const url of ['/api/cc/revenue', '/api/cc/prospects/acme.fr']) {
      const r = await app.inject({ method: 'POST', url, headers: auth() });
      assert.ok(r.statusCode === 404 || r.statusCode === 405, `${url} → ${r.statusCode}`);
    }
  });
});
