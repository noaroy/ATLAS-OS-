import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relay, upstreamOrigin, upstreamPath, MAX_BODY_BYTES } from '../../../api/atlas-proxy.ts';

/**
 * Le relais Vercel → ATLAS.
 *
 * Il est la seule chose qui tourne chez Vercel : ce qu'il laisse passer,
 * dans un sens comme dans l'autre, est toute la surface exposée.
 */

const ENV = { ATLAS_API_ORIGIN: 'https://atlas.example.test' };
const at = (upstream: string, init: RequestInit = {}) =>
  new Request(`https://dash.example.test/api/atlas-proxy?__upstream=${encodeURIComponent(upstream)}`, init);

type Call = { url: string; init: RequestInit };
function fakeFetch(response: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = async (url: string, init: RequestInit) => { calls.push({ url, init }); return response(); };
  return { calls, impl };
}

describe('l’adresse d’ATLAS', () => {
  test('HTTPS exigé ; http seulement en boucle locale ; ni identifiants ni chemin', () => {
    assert.equal(upstreamOrigin({}), null);
    assert.equal(upstreamOrigin({ ATLAS_API_ORIGIN: 'http://atlas.example.test' }), null);
    assert.equal(upstreamOrigin({ ATLAS_API_ORIGIN: 'https://u:p@atlas.example.test' }), null);
    assert.equal(upstreamOrigin({ ATLAS_API_ORIGIN: 'https://atlas.example.test/x' }), null);
    assert.ok(upstreamOrigin({ ATLAS_API_ORIGIN: 'http://127.0.0.1:4700' }));
    assert.ok(upstreamOrigin(ENV));
  });

  test('non configuré : 503 propre, rien n’est appelé', async () => {
    const f = fakeFetch(() => new Response('x'));
    const r = await relay(at('/api/cc/revenue'), {}, f.impl);
    assert.equal(r.status, 503);
    assert.equal(f.calls.length, 0);
    assert.equal(((await r.json()) as { error: { code: string } }).error.code, 'PROXY_NOT_CONFIGURED');
  });
});

describe('seuls /api/* et /healthz passent', () => {
  test('chemins refusés', () => {
    for (const bad of [null, '', '/', '/admin', '/api', '/api/../etc/passwd', '/api//x', '/api/%2e%2e/x', '/api/a%2fb', '/api/\\x', 'https://evil.test/api/x']) {
      assert.equal(upstreamPath(bad), null, String(bad));
    }
    assert.equal(upstreamPath('/healthz'), '/healthz');
    assert.equal(upstreamPath('/api/cc/companies/acme.fr'), '/api/cc/companies/acme.fr');
  });

  test('un chemin forgé ne quitte pas Vercel', async () => {
    const f = fakeFetch(() => new Response('x'));
    const r = await relay(at('/api/../../secret'), ENV, f.impl);
    assert.equal(r.status, 404);
    assert.equal(f.calls.length, 0);
  });

  test('le paramètre de relais est retiré ; la requête d’origine est conservée', async () => {
    const f = fakeFetch(() => Response.json({ ok: true, data: 1 }));
    await relay(new Request('https://dash.example.test/api/atlas-proxy?__upstream=/api/cc/dashboard&range=7d'), ENV, f.impl);
    assert.equal(f.calls[0]!.url, 'https://atlas.example.test/api/cc/dashboard?range=7d');
  });

  test('temps réel : 501, le téléphone lit par intervalle', async () => {
    const f = fakeFetch(() => new Response('x'));
    assert.equal((await relay(at('/api/realtime'), ENV, f.impl)).status, 501);
    assert.equal(f.calls.length, 0);
  });
});

describe('les en-têtes, dans les deux sens', () => {
  test('vers ATLAS : le cookie passe, aucun en-tête de relais ni d’autorisation', async () => {
    const f = fakeFetch(() => Response.json({ ok: true }));
    await relay(at('/api/auth/me', {
      headers: {
        cookie: 'atlas_session=abc', authorization: 'Bearer forged', 'x-forwarded-for': '6.6.6.6',
        'x-forwarded-proto': 'http', host: 'evil.test', accept: 'application/json',
      },
    }), ENV, f.impl);
    const sent = new Headers(f.calls[0]!.init.headers);
    assert.equal(sent.get('cookie'), 'atlas_session=abc');
    assert.equal(sent.get('accept'), 'application/json');
    for (const name of ['authorization', 'x-forwarded-for', 'x-forwarded-proto', 'host']) {
      assert.equal(sent.get(name), null, name);
    }
    assert.equal(f.calls[0]!.init.redirect, 'manual');
  });

  test('vers le navigateur : chaque Set-Cookie est relayé, jamais mis en cache', async () => {
    const f = fakeFetch(() => {
      const h = new Headers({ 'content-type': 'application/json', server: 'fastify', 'x-powered-by': 'x' });
      h.append('set-cookie', 'atlas_session=new; Path=/; HttpOnly; SameSite=Strict; Secure');
      h.append('set-cookie', 'other=1; Path=/');
      return new Response('{"ok":true,"data":{}}', { status: 200, headers: h });
    });
    const r = await relay(at('/api/auth/login', { method: 'POST', body: '{}' }), ENV, f.impl);
    assert.equal(r.status, 200);
    assert.equal(r.headers.getSetCookie().length, 2);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('server'), null);
    assert.equal(r.headers.get('x-powered-by'), null);
  });

  test('une redirection d’ATLAS est refusée', async () => {
    const f = fakeFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.test' } }));
    const r = await relay(at('/api/x'), ENV, f.impl);
    assert.equal(r.status, 502);
    assert.equal(r.headers.get('location'), null);
  });
});

describe('les pannes se disent, bornées', () => {
  test('ATLAS injoignable : 502 au format de l’API', async () => {
    const r = await relay(at('/api/cc/revenue'), ENV, async () => { throw new TypeError('fetch failed'); });
    assert.equal(r.status, 502);
    const body = (await r.json()) as { ok: boolean; error: { code: string } };
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'UPSTREAM_UNREACHABLE');
  });

  test('ATLAS trop lent : 504', async () => {
    const r = await relay(at('/api/cc/revenue'), ENV, async () => {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    });
    assert.equal(r.status, 504);
  });

  test('un 401 d’ATLAS reste un 401 : le navigateur redemande la connexion', async () => {
    const r = await relay(at('/api/cc/revenue'), ENV, async () =>
      Response.json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'x' } }, { status: 401 }));
    assert.equal(r.status, 401);
  });

  test('corps trop gros et méthode inconnue : refusés avant ATLAS', async () => {
    const f = fakeFetch(() => new Response('x'));
    const big = await relay(at('/api/x', { method: 'POST', body: 'a'.repeat(MAX_BODY_BYTES + 1) }), ENV, f.impl);
    assert.equal(big.status, 413);
    const odd = await relay(at('/api/x', { method: 'OPTIONS' }), ENV, f.impl);
    assert.equal(odd.status, 405);
    assert.equal(f.calls.length, 0);
  });
});

describe('vercel.json', () => {
  const config = JSON.parse(readFileSync(new URL('../../../vercel.json', import.meta.url), 'utf8')) as {
    rewrites: Array<{ source: string; destination: string }>;
    outputDirectory: string;
  };

  test('aucun secret ni adresse d’ATLAS en dur', () => {
    const raw = JSON.stringify(config);
    assert.equal(/https?:\/\/(?!openapi\.vercel\.sh)/.test(raw), false, 'aucune URL externe en dur');
    assert.equal(/API_KEY|TOKEN|SECRET|PASSWORD|sk-[A-Za-z0-9]/i.test(raw), false, 'aucun identifiant');
  });

  test('la réécriture /api exclut la fonction elle-même (pas de boucle)', () => {
    const api = config.rewrites.find((r) => r.source.startsWith('/api/'))!;
    const pattern = new RegExp(`^/api/${api.source.slice('/api/:path'.length).replace(/^\(/, '(')}$`);
    assert.equal(pattern.test('/api/atlas-proxy'), false);
    assert.equal(pattern.test('/api/cc/revenue'), true);
    assert.equal(config.outputDirectory, 'dist/console');
  });
});

describe('.vercelignore', () => {
  test('ni base, ni .env, ni jeton ne partent chez Vercel', () => {
    const lines = readFileSync(new URL('../../../.vercelignore', import.meta.url), 'utf8').split('\n').map((l) => l.trim());
    for (const required of ['.env', '.env.*', '/data/', '*.db', '*.sqlite', '*.token.json', 'client_secret*.json']) {
      assert.ok(lines.includes(required), required);
    }
  });
});
