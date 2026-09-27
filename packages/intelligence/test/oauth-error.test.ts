import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { describeTokenRefusal, oauthErrorCodeOf, tokenRefusalOf } from '../src/mail/oauth-error.ts';
import { GmailInboxProvider } from '../src/mail/gmail.ts';

/**
 * Un refus du point de jeton Google : la cause exacte (code RFC 6749 §5.2),
 * l'action humaine qui la répare — et jamais un fragment du corps.
 */

const SECRETISH = 'ya29.SECRET-ACCESS 1//REFRESH-SECRET GOCSPX-client-secret';

describe('le code Google, et lui seul', () => {
  test('invalid_grant : jeton expiré ou révoqué → réautoriser', () => {
    const r = describeTokenRefusal(400, JSON.stringify({ error: 'invalid_grant', error_description: `Token has been expired or revoked. ${SECRETISH}` }));
    assert.equal(r.code, 'invalid_grant');
    assert.match(r.message, /^échange de jeton refusé \(HTTP 400 · invalid_grant\)/);
    assert.match(r.humanAction, /npm run gmail:authorize/);
    assert.doesNotMatch(r.message, /SECRET|ya29|GOCSPX|expired or revoked/);
  });

  test('chaque cause a son action propre', () => {
    const actions = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_request', 'invalid_scope']
      .map((error) => describeTokenRefusal(400, JSON.stringify({ error })).humanAction));
    assert.equal(actions.size, 5);
    assert.match(describeTokenRefusal(401, JSON.stringify({ error: 'invalid_client' })).humanAction, /GMAIL_CLIENT_ID et GMAIL_CLIENT_SECRET/);
  });

  test('un code inconnu, un corps HTML ou vide : aucun code inventé, aucun écho', () => {
    assert.equal(oauthErrorCodeOf(JSON.stringify({ error: SECRETISH })), null);
    assert.equal(oauthErrorCodeOf('<html>oops</html>'), null);
    const r = describeTokenRefusal(400, JSON.stringify({ error: SECRETISH }));
    assert.equal(r.code, null);
    assert.doesNotMatch(r.message, /SECRET/);
    assert.match(r.message, /gmail:check/);
  });

  test('lecture d’une réponse dont le corps est illisible', async () => {
    const r = await tokenRefusalOf({ status: 400, text: async () => { throw new Error('boom'); } });
    assert.equal(r.code, null);
    assert.equal(r.status, 400);
  });
});

describe('le fournisseur de lecture relaie la cause', () => {
  test('HTTP 400 invalid_grant : l’erreur nomme le code et l’action, pas le secret', async () => {
    const realFetch = globalThis.fetch;
    let sent = '';
    globalThis.fetch = (async (_url: string, init?: { body?: URLSearchParams }) => {
      sent = String(init?.body ?? '');
      return new Response(JSON.stringify({ error: 'invalid_grant', error_description: SECRETISH }), { status: 400, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const provider = new GmailInboxProvider({ env: { GMAIL_CLIENT_ID: 'cid.apps.googleusercontent.com', GMAIL_CLIENT_SECRET: 'csecret', GMAIL_REFRESH_TOKEN: 'rtoken', GMAIL_USER: 'boite@example.com' } } as never);
      await assert.rejects(() => provider.list({}), (e: Error) => {
        assert.match(e.message, /HTTP 400 · invalid_grant/);
        assert.doesNotMatch(e.message, /SECRET|csecret|rtoken/);
        return true;
      });
      // La requête elle-même est conforme : échange refresh_token, sans redirect_uri.
      const body = new URLSearchParams(sent);
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('redirect_uri'), null);
      assert.ok(body.get('client_id') && body.get('client_secret') && body.get('refresh_token'));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
