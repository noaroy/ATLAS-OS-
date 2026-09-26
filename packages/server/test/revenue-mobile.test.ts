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
import { buildRevenueMobile, outboundModeOf } from '../src/http/revenue-mobile.ts';
import { withoutEnvNames } from '../src/http/command-center.ts';
import { createSystem, type AtlasSystem } from '../src/bootstrap.ts';
import { createApp } from '../src/app.ts';

/**
 * L'écran de téléphone.
 *
 * Il est lu depuis un hébergeur tiers, toutes les dix secondes : ce qu'il
 * rend doit être exact quand la base est vide, dire l'état d'envoi sans
 * ambiguïté, et ne jamais porter un identifiant.
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

/** Un prospect qualifié, avec ou sans coordonnée observée. */
function prospect(domain: string, opts: { at: string; tier: 'PRIORITY' | 'GOOD_FIT' | 'REJECTED'; observed?: boolean; email?: string | null }) {
  const { prospect: p } = repos.sales.discover({
    batchId: 'M-001', companyName: domain.split('.')[0]!, domain, discoveredAt: opts.at,
  });
  repos.sales.setScore(p.id, { score: 70, tier: opts.tier, detail: {}, whyFit: 'test' });
  if (opts.email !== null) {
    repos.sales.setContact(p.id, {
      email: opts.email ?? `contact@${domain}`, sourceUrl: `https://${domain}/contact`,
      confidence: 0.9, method: 'EMAIL', observed: opts.observed ?? true,
    });
  }
  return p;
}

describe('base vide : des zéros mesurés, et des absences dites absentes', () => {
  test('rien ne plante, et ce qui n’est pas consigné vaut null', () => {
    const v = view();
    assert.equal(v.kpis.discoveredToday, 0);
    assert.equal(v.kpis.sentToday, 0);
    assert.equal(v.kpis.proposals, null, 'aucune proposition consignée : N/A, pas zéro');
    assert.equal(v.costs.todayUsd.total, null, 'aucun appel : coût inconnu, pas gratuit');
    assert.equal(v.costs.perQualifiedUsd, null);
    assert.equal(v.loop.lastRevenueActionAt, null);
    assert.equal(v.loop.lastExpansion, null);
    assert.deepEqual(v.hotLeads, []);
  });

  test('l’entonnoir garde l’étape « proposition », sans chiffre, juste avant les clients', () => {
    const keys = view().funnel.map((s) => s.key);
    const proposal = keys.indexOf('proposal');
    assert.ok(proposal > 0);
    assert.equal(keys[proposal + 1], 'clients');
    assert.equal(view().funnel[proposal]!.count, null);
  });
});

describe('l’état d’envoi se lit sans ambiguïté', () => {
  test('OFF tant que l’interrupteur est baissé, quel que soit le mode', () => {
    assert.equal(outboundModeOf(config), 'OFF');
    config.sales.engineMode = 'PRODUCTION';
    assert.equal(outboundModeOf(config), 'OFF');
  });

  test('INTERNAL_TEST et ACTIVE ne se confondent pas', () => {
    config.sales.outboundEnabled = true;
    assert.equal(outboundModeOf(config), 'INTERNAL_TEST');
    config.sales.engineMode = 'PRODUCTION';
    assert.equal(outboundModeOf(config), 'ACTIVE');
    assert.equal(view().header.outbound, 'ACTIVE');
  });

  test('le kill switch s’affiche, signé, et dégrade l’état', () => {
    setGlobalPause(repos, true, 'founder@test.local', 'essai');
    const v = view();
    assert.equal(v.header.killSwitch.paused, true);
    assert.equal(v.header.killSwitch.by, 'founder@test.local');
    assert.equal(v.header.status, 'DEGRADED');
    assert.ok(v.header.reasons.some((r) => r.includes('kill switch')));
  });
});

describe('la journée : aujourd’hui, rien d’autre', () => {
  test('qualifié, prioritaire et contact-ready se comptent selon leur règle', () => {
    prospect('hier.example', { at: '2026-09-25T10:00:00.000Z', tier: 'PRIORITY' });
    prospect('prio.example', { at: '2026-09-26T08:00:00.000Z', tier: 'PRIORITY' });
    prospect('devine.example', { at: '2026-09-26T09:00:00.000Z', tier: 'GOOD_FIT', observed: false });
    prospect('sansmail.example', { at: '2026-09-26T09:30:00.000Z', tier: 'GOOD_FIT', email: null });
    prospect('rejete.example', { at: '2026-09-26T10:00:00.000Z', tier: 'REJECTED' });

    const { kpis, loop } = view();
    assert.equal(kpis.discoveredToday, 4, 'la veille ne compte pas');
    assert.equal(kpis.qualifiedToday, 3, 'un tier REJECTED n’est pas qualifié');
    assert.equal(kpis.highPriorityToday, 1);
    assert.equal(kpis.contactReadyToday, 1, 'une adresse devinée ou absente n’est pas contact-ready');
    assert.equal(loop.lastRevenueAction, 'prospect découvert');
    assert.equal(loop.lastRevenueActionAt, '2026-09-26T10:00:00.000Z');
  });
});

describe('aucun identifiant ne sort', () => {
  test('ni valeur de clé, ni nom de variable d’identifiant', () => {
    const before = { key: process.env.OPENAI_API_KEY, secret: process.env.GMAIL_CLIENT_SECRET };
    process.env.OPENAI_API_KEY = 'sk-test-MOBILE-SECRET-VALUE';
    process.env.GMAIL_CLIENT_SECRET = 'gmail-MOBILE-SECRET-VALUE';
    try {
      const rendu = JSON.stringify(buildRevenueMobile(repos, config, { now: NOW }));
      for (const interdit of ['MOBILE-SECRET-VALUE', 'GMAIL_CLIENT', 'GMAIL_REFRESH', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
        assert.equal(rendu.includes(interdit), false, interdit);
      }
    } finally {
      if (before.key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before.key;
      if (before.secret === undefined) delete process.env.GMAIL_CLIENT_SECRET; else process.env.GMAIL_CLIENT_SECRET = before.secret;
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

describe('/api/cc/revenue, par HTTP', () => {
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

  test('sans session : 401, et aucune donnée', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/cc/revenue' });
    assert.equal(r.statusCode, 401);
    assert.ok(!r.body.includes('"kpis"'));
  });

  test('avec une session de simple lecture : 200 et la forme attendue', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/cc/revenue', headers: { authorization: `Bearer ${token}` } });
    assert.equal(r.statusCode, 200, r.body.slice(0, 200));
    const { data } = r.json() as { data: Record<string, unknown> };
    for (const key of ['header', 'kpis', 'funnel', 'todo', 'hotLeads', 'loop', 'costs', 'definitions']) {
      assert.ok(key in data, key);
    }
    assert.equal((data.header as { outbound: string }).outbound, 'OFF');
  });

  test('la lecture ne se transforme pas en écriture', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/cc/revenue', headers: { authorization: `Bearer ${token}` } });
    assert.ok(r.statusCode === 404 || r.statusCode === 405, String(r.statusCode));
  });
});
