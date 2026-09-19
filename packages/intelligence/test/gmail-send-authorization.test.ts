import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GmailOutboundProvider, OutboundNotAuthorisedError, GMAIL_SEND_SCOPE } from '../src/mail/outbound.ts';

/**
 * L'autorisation d'envoi se lit sans l'interrupteur — et sans le transport.
 *
 * Relevé sur le VPS (v4.5.2) : `gmail-check` prouvait gmail.send accordée,
 * et le contrôle de production affichait « la portée gmail.send doit être
 * accordée ». Il lisait `status().configured`, que la porte
 * (`ATLAS_OUTBOUND_ENABLED=false`) ferme avant toute question de jeton : un
 * verrou d'exploitation pris pour un consentement manquant.
 *
 * `authorization()` répond à trois questions séparées — identifiants,
 * portées constatées, porte — et aucune ne parle pour une autre. Aucun de
 * ces tests ne touche le réseau : `fetch` est remplacé par une sentinelle qui
 * compte, et le compte reste à zéro. MESSAGES SENT : 0.
 */

const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
const CREDENTIALS = {
  GMAIL_CLIENT_ID: 'identifiant-de-test',
  GMAIL_CLIENT_SECRET: 'secret-de-test',
  GMAIL_REFRESH_TOKEN: 'jeton-de-test',
  GMAIL_USER: 'expediteur@exemple.fr',
} as NodeJS.ProcessEnv;
const PORTE_FERMEE = { ...CREDENTIALS, ATLAS_OUTBOUND_ENABLED: 'false' } as NodeJS.ProcessEnv;
// Un environnement *objet*, jamais process.env : la porte s'ouvre ici, dans le
// test, et nulle part ailleurs.
const PORTE_OUVERTE = { ...CREDENTIALS, ATLAS_OUTBOUND_ENABLED: 'true' } as NodeJS.ProcessEnv;

const originalFetch = globalThis.fetch;
let reseau: string[] = [];

beforeEach(() => {
  reseau = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    reseau.push(String(input instanceof Request ? input.url : input));
    throw new Error('aucun appel réseau attendu dans ce test');
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('gmail.send présente, porte fermée', () => {
  test('l’autorisation est complète (AUTH_READY) ; le transport, lui, dit OUTBOUND_DISABLED et refuse — sans réseau', async () => {
    const provider = new GmailOutboundProvider({ grantedScopes: [READONLY, GMAIL_SEND_SCOPE], env: PORTE_FERMEE });
    const auth = provider.authorization();
    assert.equal(auth.credentials, true);
    assert.equal(auth.verified, true);
    assert.equal(auth.readScope, 'GRANTED');
    assert.equal(auth.sendScope, 'GRANTED');
    assert.equal(auth.authReady, true, 'la porte ne change rien au jeton');
    assert.equal(auth.outboundEnabled, false);
    assert.equal(auth.code, 'GMAIL_SEND_AUTH_READY');

    const status = provider.status();
    assert.equal(status.configured, false, 'le transport ne posterait pas : la porte est fermée');
    assert.equal(status.code, 'OUTBOUND_DISABLED');
    await assert.rejects(
      () => provider.sendEmail({ to: 'a@b.fr', subject: 's', bodyText: 'b' }),
      (error: unknown) => error instanceof OutboundNotAuthorisedError && error.code === 'OUTBOUND_DISABLED',
    );
    assert.deepEqual(reseau, [], 'MESSAGES SENT: 0 — aucun appel réseau');
  });
});

describe('gmail.send absente', () => {
  test('lecture seule sur le jeton : GMAIL_SEND_SCOPE_MISSING, authReady faux, la lecture reste constatée', () => {
    const provider = new GmailOutboundProvider({ grantedScopes: [READONLY], env: PORTE_FERMEE });
    const auth = provider.authorization();
    assert.equal(auth.readScope, 'GRANTED');
    assert.equal(auth.sendScope, 'MISSING');
    assert.equal(auth.authReady, false);
    assert.equal(auth.code, 'GMAIL_SEND_SCOPE_MISSING');
    assert.deepEqual(reseau, []);
  });

  test('portées jamais constatées : UNVERIFIED — « pas encore regardé » n’est pas « refusé »', () => {
    const provider = new GmailOutboundProvider({ env: PORTE_FERMEE });
    const auth = provider.authorization();
    assert.equal(auth.verified, false);
    assert.equal(auth.sendScope, 'UNVERIFIED');
    assert.equal(auth.readScope, 'UNVERIFIED');
    assert.equal(auth.code, 'GMAIL_SEND_SCOPE_UNVERIFIED');
    assert.deepEqual(auth.granted, []);
    assert.deepEqual(reseau, []);
  });

  test('sans identifiants : GMAIL_NOT_CONFIGURED, même avec une portée déclarée', () => {
    const provider = new GmailOutboundProvider({ grantedScopes: [READONLY, GMAIL_SEND_SCOPE], env: { ATLAS_OUTBOUND_ENABLED: 'false' } as NodeJS.ProcessEnv });
    const auth = provider.authorization();
    assert.equal(auth.credentials, false);
    assert.equal(auth.sendScope, 'GRANTED');
    assert.equal(auth.authReady, false);
    assert.equal(auth.code, 'GMAIL_NOT_CONFIGURED');
  });
});

describe('gmail.send présente, porte ouverte — dans un environnement objet isolé', () => {
  test('transport READY et autorisation READY disent la même chose ; rien n’est envoyé pour le savoir', () => {
    const provider = new GmailOutboundProvider({ grantedScopes: [READONLY, GMAIL_SEND_SCOPE], env: PORTE_OUVERTE });
    const auth = provider.authorization();
    assert.equal(auth.authReady, true);
    assert.equal(auth.outboundEnabled, true);
    const status = provider.status();
    assert.equal(status.configured, true);
    assert.equal(status.code, 'GMAIL_SEND_READY');
    assert.deepEqual(reseau, [], 'MESSAGES SENT: 0 — l’état se lit sans poster');
    assert.equal(process.env.ATLAS_OUTBOUND_ENABLED === 'true', false, 'la vraie configuration n’a pas été touchée');
  });
});

describe('les portées constatées sur le vrai jeton', () => {
  test('verifyScopes() est un échange de jeton — un seul appel, vers oauth2, jamais vers Gmail — et authorization() le reflète', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      reseau.push(url);
      assert.match(url, /^https:\/\/oauth2\.googleapis\.com\/token$/, 'seul l’échange de jeton est permis');
      return new Response(JSON.stringify({ access_token: 'acces-de-test', expires_in: 3600, scope: `${READONLY} ${GMAIL_SEND_SCOPE}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const provider = new GmailOutboundProvider({ env: PORTE_FERMEE });
    assert.equal(provider.authorization().sendScope, 'UNVERIFIED');
    const verdict = await provider.verifyScopes();
    assert.equal(verdict?.canSend, true);
    const auth = provider.authorization();
    assert.equal(auth.verified, true);
    assert.equal(auth.sendScope, 'GRANTED');
    assert.equal(auth.authReady, true);
    assert.equal(auth.outboundEnabled, false, 'la porte reste fermée : constater n’est pas ouvrir');
    assert.equal(provider.status().code, 'OUTBOUND_DISABLED');
    assert.deepEqual(reseau, ['https://oauth2.googleapis.com/token']);
    assert.ok(!reseau.some((u) => u.includes('gmail.googleapis.com')), 'MESSAGES SENT: 0 — aucun appel à l’API Gmail');
  });
});
