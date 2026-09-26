import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Ce que Vercel reçoit et relaie.
 *
 * Vercel ne sert que la console statique et relaie `/api` et `/healthz` vers
 * ATLAS. Il ne doit détenir ni secret, ni base, ni `.env` — et les écrans
 * `/m` doivent tomber sur la coquille de la console, pas sur l'API.
 */

const root = new URL('../../../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('vercel.json', root), 'utf8')) as {
  rewrites: Array<{ source: string; destination: string }>;
  outputDirectory: string;
  env?: unknown;
  build?: { env?: unknown };
};

describe('vercel.json', () => {
  test('aucun identifiant, aucune variable d’environnement déclarée', () => {
    const raw = JSON.stringify(config);
    assert.equal(/API_KEY|TOKEN|SECRET|PASSWORD|sk-[A-Za-z0-9]/i.test(raw), false);
    assert.equal(config.env, undefined);
    assert.equal(config.build?.env, undefined);
  });

  test('l’API n’est relayée qu’en HTTPS', () => {
    for (const r of config.rewrites.filter((x) => /^https?:/.test(x.destination))) {
      assert.match(r.destination, /^https:\/\//, r.source);
    }
  });

  test('les écrans /m tombent sur la coquille, /api et /healthz jamais', () => {
    const spa = config.rewrites.find((r) => r.destination === '/index.html')!;
    const pattern = new RegExp(`^${spa.source.replace(/^\//, '/')}$`);
    for (const path of ['/m', '/m/p/acme.fr', '/cc/sales', '/login']) assert.ok(pattern.test(path), path);
    for (const path of ['/api/cc/revenue', '/healthz']) assert.equal(pattern.test(path), false, path);
    assert.equal(config.outputDirectory, 'dist/console');
  });
});

describe('.vercelignore', () => {
  test('ni base, ni .env, ni jeton ne partent chez Vercel', () => {
    const lines = readFileSync(new URL('.vercelignore', root), 'utf8').split('\n').map((l) => l.trim());
    for (const required of ['.env', '.env.*', '/data/', '*.db', '*.sqlite', '*.token.json', 'client_secret*.json', 'credentials.json']) {
      assert.ok(lines.includes(required), required);
    }
  });
});
