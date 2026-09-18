import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { makeTestConfig } from '../../testing/src/index.ts';
import { createSystem, type AtlasSystem } from '../src/bootstrap.ts';
import { createApp } from '../src/app.ts';
import type { AtlasConfig } from '../../core/src/config.ts';

/**
 * La surface HTTP réelle — `createApp` sur un système complet, injectée —
 * contre ce qu'un client hostile écrit dans une URL ou un en-tête.
 *
 * Trois gardes, trois vérités :
 *   · l'authentification se juge sur la route résolue par le routeur, jamais
 *     sur l'URL brute : `/%61pi/cc/dashboard` EST /api/cc/dashboard ;
 *   · rien ne sort du répertoire statique, ni par `..`, ni encodé, ni par une
 *     barre oblique inverse, ni un fichier caché ; et un refus est un 403 ou
 *     un 404, jamais un 500 avec une trace dans les journaux ;
 *   · l'adresse du client est celle de la connexion : un en-tête
 *     X-Forwarded-For n'y change rien tant qu'ATLAS_TRUST_PROXY ne nomme
 *     pas un proxy — et le limiteur de connexion ne se contourne pas.
 *
 * Le dépôt de test porte sa propre console (dist/console) avec un fichier
 * caché et des fichiers hors racine : ce que la console servirait, et ce
 * qu'elle ne doit jamais servir.
 */

const SHELL = '<!doctype html><title>CONSOLE-SHELL</title>';
let sandbox: string;
let system: AtlasSystem;
let app: FastifyInstance;
let founderToken: string;
const cwdAvant = process.cwd();

async function boot(overrides: Partial<AtlasConfig['server']> = {}): Promise<{ system: AtlasSystem; app: FastifyInstance }> {
  const config = makeTestConfig(join(sandbox, `data-${Math.random().toString(36).slice(2, 8)}`));
  config.server = { ...config.server, ...overrides };
  mkdirSync(config.paths.artifactDir, { recursive: true });
  writeFileSync(join(config.paths.artifactDir, 'secret.txt'), 'ARTIFACT-SECRET');
  writeFileSync(join(config.paths.artifactDir, '.env-copie'), 'ARTIFACT-DOTFILE');
  writeFileSync(join(config.paths.dataDir, 'outside.txt'), 'OUTSIDE-DATA');
  const sys = createSystem(config);
  const a = await createApp(sys);
  // Une route de diagnostic, protégée comme les autres : ce que le serveur croit de l'adresse du client.
  a.get('/api/__test/ip', async (request) => ({ ok: true, data: { ip: request.ip, ips: request.ips ?? [], protocol: request.protocol } }));
  await a.ready();
  return { system: sys, app: a };
}

describe('la surface HTTP, injectée', () => {
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'atlas-http-sec-'));
  // Le dépôt factice : une console avec un fichier caché, et des fichiers hors racine.
  const repo = join(sandbox, 'repo');
  mkdirSync(join(repo, 'dist', 'console', 'assets'), { recursive: true });
  writeFileSync(join(repo, 'dist', 'console', 'index.html'), SHELL);
  writeFileSync(join(repo, 'dist', 'console', 'assets', 'app.js'), 'console.log("APP-JS")');
  writeFileSync(join(repo, 'dist', 'console', '.hidden'), 'HIDDEN-DOTFILE');
  writeFileSync(join(repo, 'dist', 'outside.txt'), 'OUTSIDE-DIST');
  writeFileSync(join(repo, 'secret-root.txt'), 'REPO-ROOT-SECRET');
  process.chdir(repo);
  ({ system, app } = await boot());
  // `createSystem` sème déjà le fondateur de la config ; ce compte-ci est le nôtre.
  const founder = system.repos.users.create({ email: 'revue@test.local', name: 'Revue', role: 'founder', password: 'secret-pass' });
  founderToken = system.repos.users.createSession(founder).token;
});

after(async () => {
  await app.close();
  await system.shutdown('test');
  process.chdir(cwdAvant);
  rmSync(sandbox, { recursive: true, force: true });
});

const bearer = () => ({ authorization: `Bearer ${founderToken}` });
const SECRETS = ['OUTSIDE-DATA', 'OUTSIDE-DIST', 'REPO-ROOT-SECRET', 'HIDDEN-DOTFILE', 'ARTIFACT-DOTFILE', '"name": "atlas-os"'];

describe('l’authentification se juge sur la route résolue', () => {
  test('/api sans session : 401 — écrit tel quel, ou encodé (%61pi), ou vers un artefact', async () => {
    for (const url of ['/api/cc/dashboard', '/%61pi/cc/dashboard', '/api/auth/me', '/%61pi/auth/me', '/api/artifacts/secret.txt', '/%61pi/artifacts/secret.txt', '/%61%70%69/cc/dashboard', '/api/cc/dashboard?x=%61']) {
      const r = await app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 401, `${url} → ${r.statusCode} ${r.body.slice(0, 80)}`);
      assert.ok(!r.body.includes('ARTIFACT-SECRET') && !r.body.includes('"data":{'), url);
    }
  });

  test('avec session : la même route répond, encodée ou non — et l’artefact se lit', async () => {
    const plain = await app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer() });
    assert.equal(plain.statusCode, 200);
    const encoded = await app.inject({ method: 'GET', url: '/%61pi/auth/me', headers: bearer() });
    assert.equal(encoded.statusCode, 200);
    assert.equal((encoded.json() as { data: { email: string } }).data.email, 'revue@test.local');
    const artifact = await app.inject({ method: 'GET', url: '/api/artifacts/secret.txt', headers: bearer() });
    assert.equal(artifact.statusCode, 200);
    assert.equal(artifact.body, 'ARTIFACT-SECRET');
  });

  test('une casse ou des barres doublées ne trouvent aucune route de données : la coquille, jamais une réponse API', async () => {
    for (const url of ['/API/auth/me', '//api/auth/me', '/api//auth/me']) {
      const r = await app.inject({ method: 'GET', url });
      assert.ok(!r.body.includes('"data":{'), `${url} → ${r.body.slice(0, 80)}`);
      assert.ok(r.statusCode === 200 ? r.body === SHELL : r.statusCode === 404 || r.statusCode === 403 || r.statusCode === 401, `${url} → ${r.statusCode}`);
    }
  });

  test('/healthz est public ; un préfixe approchant ne l’est pas', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
    const r = await app.inject({ method: 'GET', url: '/api/auth/loginX' });
    assert.notEqual(r.statusCode, 200);
  });
});

describe('rien ne sort du répertoire statique', () => {
  const TRAVERSALS = [
    '/../outside.txt', '/..%2foutside.txt', '/%2e%2e/outside.txt', '/%2e%2e%2foutside.txt', '/..%5coutside.txt',
    '/%5c..%5coutside.txt', '/%2e%2e%5coutside.txt', '/assets/../../outside.txt', '/assets/..%2f..%2foutside.txt',
    '/assets/./../outside.txt', '/../../secret-root.txt', '/%2e%2e/%2e%2e/secret-root.txt', '//outside.txt',
    '/..%252foutside.txt', '/%252e%252e/outside.txt', '/....//outside.txt', '/C:/Windows/win.ini', '/api/../.hidden',
  ];

  test('la console : chaque traversée rend la coquille, un 403 ou un 404 — jamais le fichier, jamais un 500', async () => {
    for (const url of TRAVERSALS) {
      const r = await app.inject({ method: 'GET', url });
      assert.ok([200, 403, 404].includes(r.statusCode), `${url} → ${r.statusCode}`);
      if (r.statusCode === 200) assert.equal(r.body, SHELL, url);
      for (const s of SECRETS) assert.ok(!r.body.includes(s), `${url} a servi « ${s} »`);
    }
  });

  test('les artefacts : même avec une session, aucune traversée ne sort du dossier, et un fichier caché reste caché', async () => {
    for (const rel of ['../outside.txt', '..%2foutside.txt', '%2e%2e/outside.txt', '%2e%2e%2foutside.txt', '..%5coutside.txt', '....//outside.txt', '.env-copie', '%2e%2e/artifacts/.env-copie']) {
      const url = `/api/artifacts/${rel}`;
      const r = await app.inject({ method: 'GET', url, headers: bearer() });
      assert.ok([403, 404].includes(r.statusCode), `${url} → ${r.statusCode} ${r.body.slice(0, 60)}`);
      for (const s of SECRETS) assert.ok(!r.body.includes(s), `${url} a servi « ${s} »`);
    }
  });

  test('un fichier caché de la console n’est pas servi ; les vrais fichiers le sont', async () => {
    const hidden = await app.inject({ method: 'GET', url: '/.hidden' });
    assert.ok(!hidden.body.includes('HIDDEN-DOTFILE'));
    const js = await app.inject({ method: 'GET', url: '/assets/app.js' });
    assert.equal(js.statusCode, 200);
    assert.equal(js.body, 'console.log("APP-JS")');
    const index = await app.inject({ method: 'GET', url: '/' });
    assert.equal(index.body, SHELL);
    const spa = await app.inject({ method: 'GET', url: '/prospects/abc' });
    assert.equal(spa.statusCode, 200);
    assert.equal(spa.body, SHELL, 'le repli SPA');
  });

  test('un chemin refusé par le serveur statique est un 403 propre, pas une erreur interne', async () => {
    const r = await app.inject({ method: 'GET', url: '/..%5coutside.txt' });
    assert.equal(r.statusCode, 403);
    assert.equal((r.json() as { error: { code: string } }).error.code, 'FORBIDDEN');
  });
});

describe('l’adresse du client est celle de la connexion', () => {
  test('par défaut (ATLAS_TRUST_PROXY=false) : X-Forwarded-For et X-Forwarded-Proto sont ignorés', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/__test/ip', headers: { ...bearer(), 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'x-forwarded-proto': 'https', 'x-real-ip': '198.51.100.7' } });
    assert.equal(r.statusCode, 200);
    const { data } = r.json() as { data: { ip: string; protocol: string } };
    assert.equal(data.ip, '127.0.0.1');
    assert.equal(data.protocol, 'http');
  });

  test('le limiteur de connexion ne se contourne pas en faisant tourner X-Forwarded-For', async () => {
    let dernier = 0;
    for (let i = 0; i < 12; i += 1) {
      const r = await app.inject({
        method: 'POST', url: '/api/auth/login',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i}` },
        payload: { email: 'revue@test.local', password: 'mauvais-mot-de-passe' },
      });
      dernier = r.statusCode;
      if (dernier === 429) break;
    }
    assert.equal(dernier, 429, 'après huit échecs, la neuvième tentative est refusée quelle que soit l’adresse annoncée');
  });

  test('avec ATLAS_TRUST_PROXY=loopback : seule la connexion venant du proxy nommé est crue, et l’adresse retenue est le dernier saut non fiable', async () => {
    const { system: s2, app: a2 } = await boot({ trustProxy: 'loopback' });
    try {
      const f = s2.repos.users.create({ email: 'f2@test.local', name: 'F2', role: 'founder', password: 'secret-pass' });
      const t = s2.repos.users.createSession(f).token;
      // inject() se connecte depuis 127.0.0.1 : c'est le proxy de confiance.
      const chain = await a2.inject({ method: 'GET', url: '/api/__test/ip', headers: { authorization: `Bearer ${t}`, 'x-forwarded-for': '203.0.113.9, 198.51.100.7' } });
      assert.equal((chain.json() as { data: { ip: string } }).data.ip, '198.51.100.7', 'le saut le plus proche du proxy, pas ce que le client a écrit en tête');
      const single = await a2.inject({ method: 'GET', url: '/api/__test/ip', headers: { authorization: `Bearer ${t}`, 'x-forwarded-for': '203.0.113.9' } });
      assert.equal((single.json() as { data: { ip: string } }).data.ip, '203.0.113.9');
      const none = await a2.inject({ method: 'GET', url: '/api/__test/ip', headers: { authorization: `Bearer ${t}` } });
      assert.equal((none.json() as { data: { ip: string } }).data.ip, '127.0.0.1');
    } finally {
      await a2.close();
      await s2.shutdown('test');
    }
  });
});
});
