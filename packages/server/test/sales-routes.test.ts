import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { createLogger } from '../../core/src/logger.ts';
import { createRepositories, type Repositories } from '../../data/src/index.ts';
import { makeTestConfig } from '../../testing/src/index.ts';
import { installErrorHandler } from '../src/http/reply.ts';
import { installAuth } from '../src/http/auth.ts';
import { registerSalesRoutes } from '../src/http/sales-routes.ts';
import type { AtlasSystem } from '../src/bootstrap.ts';

/**
 * La surface HTTP du moteur commercial : protégée par la session, et les
 * décisions réservées au fondateur. Un tableau de bord lisible sans session
 * serait une fuite ; une pause posée par n'importe qui serait un sabotage.
 */

const logger = createLogger({ level: 'error', pretty: false });
let dir: string;
let repos: Repositories;
let app: FastifyInstance;
let founderToken: string;
let operatorToken: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-sales-routes-'));
  repos = createRepositories(join(dir, 'atlas.db'), logger);
  const config = makeTestConfig(dir);
  const system = { repos, config, logger } as unknown as AtlasSystem;
  app = Fastify({ logger: false });
  installErrorHandler(app, logger);
  installAuth(app, system, ['/healthz']);
  registerSalesRoutes(app, system);
  await app.ready();

  const founder = repos.users.create({ email: 'founder@test.local', name: 'Founder', role: 'founder', password: 'secret-pass' });
  const operator = repos.users.create({ email: 'ops@test.local', name: 'Ops', role: 'operator', password: 'secret-pass' });
  founderToken = repos.users.createSession(founder).token;
  operatorToken = repos.users.createSession(operator).token;
});

afterEach(async () => {
  await app.close();
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const as = (token: string) => ({ authorization: `Bearer ${token}` });

describe('/api/cc/dashboard', () => {
  test('exige une session ; rend la page complète avec ses sept sections', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/api/cc/dashboard' });
    assert.equal(anonymous.statusCode, 401);

    const ok = await app.inject({ method: 'GET', url: '/api/cc/dashboard?range=7d', headers: as(operatorToken) });
    assert.equal(ok.statusCode, 200, ok.body);
    const { data } = ok.json() as { data: Record<string, unknown> };
    for (const key of ['cards', 'funnel', 'performance', 'segments', 'recommendations', 'hotLeads', 'system']) {
      assert.ok(key in data, key);
    }
    assert.equal(data.range, '7d');
    const bad = await app.inject({ method: 'GET', url: '/api/cc/dashboard?range=1y', headers: as(operatorToken) });
    assert.equal(bad.statusCode, 400);
    const missing = await app.inject({ method: 'GET', url: '/api/cc/dashboard?segment=seg_inconnu', headers: as(operatorToken) });
    assert.equal(missing.statusCode, 404);
  });
});

describe('décisions', () => {
  test('la pause et la reprise sont réservées au fondateur, et signées', async () => {
    const refused = await app.inject({ method: 'POST', url: '/api/sales/pause', headers: as(operatorToken), payload: { reason: 'x' } });
    assert.equal(refused.statusCode, 403);
    const paused = await app.inject({ method: 'POST', url: '/api/sales/pause', headers: as(founderToken), payload: { reason: 'incident' } });
    assert.equal(paused.statusCode, 200, paused.body);
    const state = await app.inject({ method: 'GET', url: '/api/sales/pause', headers: as(operatorToken) });
    assert.deepEqual((state.json() as { data: { paused: boolean; by: string; reason: string } }).data.paused, true);
    assert.equal((state.json() as { data: { by: string } }).data.by, 'founder@test.local');
    const resumed = await app.inject({ method: 'POST', url: '/api/sales/resume', headers: as(founderToken) });
    assert.equal(resumed.statusCode, 200);
  });

  test('un segment se crée, s’approuve pour l’envoi, se met en pause — par le fondateur seulement', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/sales/segments', headers: as(founderToken), payload: { name: 'PME B2B FR', countries: ['FR'] } });
    assert.equal(created.statusCode, 201, created.body);
    const { segment } = (created.json() as { data: { segment: { id: string; approvedForSend: boolean } } }).data;
    assert.equal(segment.approvedForSend, false);
    const forbidden = await app.inject({ method: 'POST', url: `/api/sales/segments/${segment.id}/approve`, headers: as(operatorToken) });
    assert.equal(forbidden.statusCode, 403);
    const approved = await app.inject({ method: 'POST', url: `/api/sales/segments/${segment.id}/approve`, headers: as(founderToken) });
    assert.equal((approved.json() as { data: { approvedForSend: boolean } }).data.approvedForSend, true);
    const paused = await app.inject({ method: 'POST', url: `/api/sales/segments/${segment.id}/pause`, headers: as(founderToken) });
    assert.equal((paused.json() as { data: { status: string } }).data.status, 'PAUSED');
    const unknown = await app.inject({ method: 'POST', url: `/api/sales/segments/${segment.id}/explode`, headers: as(founderToken) });
    assert.equal(unknown.statusCode, 400);
  });

  test('une issue commerciale se consigne avec le fondateur comme auteur ; un montant négatif est refusé', async () => {
    const refused = await app.inject({ method: 'POST', url: '/api/sales/outcomes', headers: as(founderToken), payload: { domain: 'acme.fr', kind: 'WON', revenueAmount: -1 } });
    assert.equal(refused.statusCode, 400);
    const won = await app.inject({ method: 'POST', url: '/api/sales/outcomes', headers: as(founderToken), payload: { domain: 'acme.fr', kind: 'WON', revenueAmount: 900, offer: 'étude' } });
    assert.equal(won.statusCode, 201, won.body);
    assert.equal((won.json() as { data: { recordedBy: string } }).data.recordedBy, 'founder@test.local');
    const list = await app.inject({ method: 'GET', url: '/api/sales/outcomes?domain=acme.fr', headers: as(operatorToken) });
    assert.equal((list.json() as { data: unknown[] }).data.length, 1);
  });

  test('la suppression d’un domaine l’écarte aussi au registre ; une réponse chaude se marque traitée par un opérateur', async () => {
    const suppressed = await app.inject({ method: 'POST', url: '/api/sales/suppress', headers: as(founderToken), payload: { kind: 'DOMAIN', value: 'bloque.fr', reason: 'LEGAL' } });
    assert.equal(suppressed.statusCode, 201, suppressed.body);
    assert.equal(repos.sales.ledgerFor('bloque.fr')?.kind, 'DO_NOT_CONTACT');
    const handled = await app.inject({ method: 'POST', url: '/api/sales/leads/acme.fr/handled', headers: as(operatorToken), payload: { note: 'rappelé' } });
    assert.equal(handled.statusCode, 200, handled.body);
    assert.equal((handled.json() as { data: { status: string } }).data.status, 'HANDLED');
  });

  test('une recommandation inconnue ou une décision inconnue sont refusées proprement', async () => {
    const unknown = await app.inject({ method: 'POST', url: '/api/sales/recommendations/rec_x/approve', headers: as(founderToken) });
    assert.equal(unknown.statusCode, 404);
    const { recommendation } = repos.salesEngine.propose({ kind: 'CHANGE_FOLLOWUP', title: 'x', reason: 'y', fingerprint: 'f' });
    const bad = await app.inject({ method: 'POST', url: `/api/sales/recommendations/${recommendation.id}/maybe`, headers: as(founderToken) });
    assert.equal(bad.statusCode, 400);
    const rejected = await app.inject({ method: 'POST', url: `/api/sales/recommendations/${recommendation.id}/reject`, headers: as(founderToken) });
    assert.equal((rejected.json() as { data: { recommendation: { status: string } } }).data.recommendation.status, 'REJECTED');
  });
});
