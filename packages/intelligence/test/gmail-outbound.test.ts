import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  GmailOutboundProvider,
  OutboundNotAuthorisedError,
  GMAIL_SEND_SCOPE,
  encodeRfc822,
  base64Url,
} from '../src/mail/outbound.ts';

/**
 * Le transport d'envoi existe et refuse de servir.
 *
 * Ces deux propriétés ne sont pas en tension : le code doit être écrit à froid,
 * relu, testé — pas improvisé le jour d'un premier envoi réel. Mais la portée
 * OAuth qui l'active appartient au propriétaire de la boîte, et ATLAS ne se
 * l'accorde pas.
 *
 * Aucun de ces tests ne touche le réseau : le refus intervient avant.
 */

const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
const CONFIGURED_ENV = {
  GMAIL_CLIENT_ID: 'identifiant-de-test',
  GMAIL_CLIENT_SECRET: 'secret-de-test',
  GMAIL_REFRESH_TOKEN: 'jeton-de-test',
  GMAIL_USER: 'expediteur@exemple.fr',
} as NodeJS.ProcessEnv;

const message = { to: 'destinataire@exemple.fr', subject: 'Sujet', bodyText: 'Corps' };

describe('la porte reste fermée sans portée d’envoi', () => {
  test('le statut nomme précisément ce qui manque', () => {
    const provider = new GmailOutboundProvider({ grantedScopes: [READONLY], env: CONFIGURED_ENV });
    const status = provider.status();
    assert.equal(status.configured, false);
    assert.equal(status.code, 'GMAIL_SEND_SCOPE_MISSING');
    assert.ok(status.detail.includes(GMAIL_SEND_SCOPE));
  });

  test('sendEmail échoue franchement, sans repli sur une simulation', async () => {
    const provider = new GmailOutboundProvider({ grantedScopes: [READONLY], env: CONFIGURED_ENV });
    await assert.rejects(
      () => provider.sendEmail(message),
      (error: unknown) =>
        error instanceof OutboundNotAuthorisedError && error.code === 'GMAIL_SEND_SCOPE_MISSING',
    );
  });

  test('replyToThread échoue de la même façon', async () => {
    const provider = new GmailOutboundProvider({ grantedScopes: [READONLY], env: CONFIGURED_ENV });
    await assert.rejects(
      () => provider.replyToThread({ ...message, threadId: 'fil-1' }),
      OutboundNotAuthorisedError,
    );
  });

  test('un jeton sans portée du tout est refusé aussi', async () => {
    const provider = new GmailOutboundProvider({ env: CONFIGURED_ENV });
    await assert.rejects(() => provider.sendEmail(message), OutboundNotAuthorisedError);
  });

  test('la portée accordée mais les identifiants absents : refus, pas de plantage', async () => {
    const provider = new GmailOutboundProvider({
      grantedScopes: [GMAIL_SEND_SCOPE],
      env: {} as NodeJS.ProcessEnv,
    });
    assert.equal(provider.status().code, 'GMAIL_NOT_CONFIGURED');
    await assert.rejects(
      () => provider.sendEmail(message),
      (error: unknown) =>
        error instanceof OutboundNotAuthorisedError && error.code === 'GMAIL_NOT_CONFIGURED',
    );
  });

  test('aucune valeur de secret ne transparaît dans le statut', () => {
    const provider = new GmailOutboundProvider({ grantedScopes: [READONLY], env: CONFIGURED_ENV });
    const rendered = JSON.stringify(provider.status());
    for (const secret of ['identifiant-de-test', 'secret-de-test', 'jeton-de-test']) {
      assert.ok(!rendered.includes(secret), `« ${secret} » ne doit pas apparaître`);
    }
  });
});

describe('l’encodage du message', () => {
  test('un sujet accentué est encodé, pas envoyé brut', () => {
    // Un accent brut dans un en-tête ressort en caractères de remplacement chez
    // une partie des destinataires. Un premier message illisible a déjà perdu.
    const raw = encodeRfc822(
      { to: 'a@b.fr', subject: 'Trois prospects, gratuitement — étanchéité', bodyText: 'Bonjour' },
      'moi@exemple.fr',
    );
    assert.ok(raw.includes('Subject: =?UTF-8?B?'), 'le sujet doit être encodé en base64 UTF-8');
    assert.ok(!raw.includes('étanchéité'), 'le sujet ne doit pas figurer en clair');
  });

  test('le corps accentué survit à l’aller-retour', () => {
    const body = 'Bonjour,\n\nJ’ai relevé ceci sur votre site : « étanchéité ».';
    const raw = encodeRfc822({ to: 'a@b.fr', subject: 'S', bodyText: body }, 'moi@exemple.fr');
    const encoded = raw.split('\r\n\r\n')[1]!;
    assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), body);
  });

  test('une réponse porte In-Reply-To et References', () => {
    const raw = encodeRfc822(
      { to: 'a@b.fr', subject: 'Re', bodyText: 'ok', inReplyTo: '<abc@mail>' },
      'moi@exemple.fr',
    );
    assert.ok(raw.includes('In-Reply-To: <abc@mail>'));
    assert.ok(raw.includes('References: <abc@mail>'));
  });

  test('un premier message ne porte pas ces en-têtes', () => {
    const raw = encodeRfc822(message, 'moi@exemple.fr');
    assert.ok(!raw.includes('In-Reply-To'));
  });

  test('le base64 est bien la variante URL-safe attendue par Gmail', () => {
    const encoded = base64Url('des caractères qui produisent + et / une fois encodés ~~~ ÿÿÿ');
    assert.ok(!encoded.includes('+'));
    assert.ok(!encoded.includes('/'));
    assert.ok(!encoded.endsWith('='));
  });
});
