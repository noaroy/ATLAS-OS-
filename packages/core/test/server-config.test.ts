import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtlasError, internalUrlOf, loadConfig, trustProxyOf } from '@atlas/core';

/**
 * Deux réglages du serveur qui décident de ce qu'un outil ou un proxy peut
 * lui faire croire : où il se joint, et quels en-têtes il croit.
 */

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith('ATLAS_')) delete process.env[key];
    process.env.ATLAS_SESSION_SECRET = 'x'.repeat(32);
    Object.assign(process.env, env);
    return fn();
  } finally {
    process.env = saved;
  }
}

describe('l’adresse interne du serveur', () => {
  test('hors Docker : 127.0.0.1 sur le port ; dans le conteneur outils : le service atlas ; posée : elle l’emporte', () => {
    assert.equal(internalUrlOf(undefined, 4700, undefined), 'http://127.0.0.1:4700');
    assert.equal(internalUrlOf('', 4700, undefined), 'http://127.0.0.1:4700');
    assert.equal(internalUrlOf(undefined, 4700, 'docker'), 'http://atlas:4700');
    assert.equal(internalUrlOf('http://serveur-atlas:4701/', 4700, 'docker'), 'http://serveur-atlas:4701', 'sans barre finale');
    assert.equal(internalUrlOf('http://10.0.0.5:4700', 4700, undefined), 'http://10.0.0.5:4700');
  });

  test('loadConfig la porte : le contexte docker et l’override explicite, sans toucher à l’URL publique', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-cfg-'));
    try {
      const base = { ATLAS_DATA_DIR: join(dir, 'd'), ATLAS_BACKUP_DIR: join(dir, 'd', 'b'), ATLAS_PORT: '4700', ATLAS_PUBLIC_URL: 'http://127.0.0.1:4700' };
      const local = withEnv(base, () => loadConfig(dir));
      assert.equal(local.server.internalUrl, 'http://127.0.0.1:4700');
      const docker = withEnv({ ...base, ATLAS_CLI_CONTEXT: 'docker' }, () => loadConfig(dir));
      assert.equal(docker.server.internalUrl, 'http://atlas:4700');
      assert.equal(docker.server.publicUrl, 'http://127.0.0.1:4700', 'l’URL publique (tableau de bord) ne change pas');
      const posee = withEnv({ ...base, ATLAS_CLI_CONTEXT: 'docker', ATLAS_INTERNAL_URL: 'http://atlas-bis:4700' }, () => loadConfig(dir));
      assert.equal(posee.server.internalUrl, 'http://atlas-bis:4700');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('ATLAS_TRUST_PROXY', () => {
  test('false par défaut ; true, ou une liste d’adresses ; jamais un nombre de sauts', () => {
    assert.equal(trustProxyOf(''), false);
    assert.equal(trustProxyOf('false'), false);
    assert.equal(trustProxyOf('true'), true);
    assert.equal(trustProxyOf('loopback'), 'loopback');
    assert.equal(trustProxyOf(' uniquelocal , 172.18.0.0/16 '), 'uniquelocal,172.18.0.0/16');
    for (const n of ['0', '1', '2']) assert.throws(() => trustProxyOf(n), (e: unknown) => e instanceof AtlasError && /sauts/.test(e.message), n);
  });

  test('loadConfig : absent → false ; posé → transmis tel quel à Fastify', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-cfg-'));
    try {
      const base = { ATLAS_DATA_DIR: join(dir, 'd'), ATLAS_BACKUP_DIR: join(dir, 'd', 'b') };
      assert.equal(withEnv(base, () => loadConfig(dir)).server.trustProxy, false);
      assert.equal(withEnv({ ...base, ATLAS_TRUST_PROXY: 'uniquelocal' }, () => loadConfig(dir)).server.trustProxy, 'uniquelocal');
      assert.throws(() => withEnv({ ...base, ATLAS_TRUST_PROXY: '1' }, () => loadConfig(dir)));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
