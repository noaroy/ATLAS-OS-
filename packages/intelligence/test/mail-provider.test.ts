import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLogger } from '../../core/src/logger.ts';
import {
  GmailInboxProvider,
  gmailCredentialsFromEnv,
  extractPlainText,
  GMAIL_READONLY_SCOPE,
} from '../src/mail/gmail.ts';
import { FixtureInboxProvider, mailMessage } from '../src/mail/fixture.ts';

const logger = createLogger({ level: 'error', pretty: false });

/**
 * Le pont Gmail est en lecture seule. Ce n'est pas une intention affichée dans
 * un commentaire : les tests suivants le vérifient sur le source, parce qu'une
 * garde qui se contente d'être promise finit par être oubliée au moment où
 * quelqu'un ajoute « juste une petite réponse automatique ».
 */
describe('le fournisseur ne peut pas écrire', () => {
  const source = readFileSync(new URL('../src/mail/gmail.ts', import.meta.url), 'utf8');

  test('aucun verbe HTTP autre que GET vers Gmail', () => {
    // Le seul POST autorisé est l'échange de jeton OAuth, qui ne touche pas la
    // boîte. Tout appel à l'API Gmail doit être un GET.
    const gmailCalls = source.split('\n').filter((line) => line.includes('GMAIL_API'));
    assert.ok(gmailCalls.length > 0, 'le fichier doit bien appeler Gmail');
    for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const pattern = new RegExp(`method:\\s*['"\`]${verb}['"\`]`, 'g');
      const uses = [...source.matchAll(pattern)];
      const outsideOauth = uses.filter(() => !source.includes('OAUTH_TOKEN_URL'));
      assert.equal(outsideOauth.length, 0, `${verb} ne doit viser que l'échange de jeton`);
    }
  });

  test('aucun chemin qui modifie la boîte', () => {
    for (const path of ['/send', '/drafts', '/modify', '/trash', '/batchModify', '/labels']) {
      assert.equal(
        source.includes(`messages${path}`) || source.includes(`'${path}'`),
        false,
        `« ${path} » ne doit pas figurer dans un fournisseur en lecture`,
      );
    }
  });

  test('aucune méthode d’envoi n’est exposée', () => {
    const provider = new GmailInboxProvider({ logger, env: {} });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(provider));
    for (const forbidden of ['send', 'sendMessage', 'reply', 'draft', 'createDraft', 'label', 'delete', 'trash']) {
      assert.equal(methods.includes(forbidden), false, `« ${forbidden} » ne doit pas exister`);
    }
    assert.deepEqual(
      methods.filter((m) => m !== 'constructor').sort(),
      ['fetchMessage', 'get', 'list', 'status', 'token'],
    );
  });

  test('la portée demandée est la lecture seule', () => {
    assert.equal(GMAIL_READONLY_SCOPE, 'https://www.googleapis.com/auth/gmail.readonly');
    assert.equal(source.includes('gmail.send'), false);
    assert.equal(source.includes('gmail.modify'), false);
    assert.equal(source.includes('mail.google.com'), false, 'la portée totale ne doit pas apparaître');
  });
});

describe('credentials absents', () => {
  test('le provider se construit quand même', () => {
    const provider = new GmailInboxProvider({ logger, env: {} });
    assert.equal(provider.id, 'gmail');
    assert.equal(provider.status().configured, false);
    assert.equal(provider.status().code, 'GMAIL_NOT_CONFIGURED');
  });

  test('le détail nomme les variables manquantes, jamais leur valeur', () => {
    const { credentials, status } = gmailCredentialsFromEnv({
      GMAIL_CLIENT_ID: 'abc', GMAIL_USER: 'x@y.fr',
    } as NodeJS.ProcessEnv);
    assert.equal(credentials, null);
    assert.match(status.detail, /GMAIL_CLIENT_SECRET/);
    assert.match(status.detail, /GMAIL_REFRESH_TOKEN/);
    assert.equal(status.detail.includes('abc'), false, 'aucune valeur ne fuit');
  });

  test('lire une boîte non configurée échoue proprement, sans planter le métier', async () => {
    const provider = new GmailInboxProvider({ logger, env: {} });
    await assert.rejects(() => provider.list(), /GMAIL_NOT_CONFIGURED/);
    // Le point du test : l'erreur est nommée et rattrapable, pas une pile
    // d'appels sur `undefined`.
    assert.equal(provider.status().configured, false);
  });

  test('une configuration complète est reconnue', () => {
    const { credentials, status } = gmailCredentialsFromEnv({
      GMAIL_CLIENT_ID: 'client-xyz.apps.googleusercontent.com',
      GMAIL_CLIENT_SECRET: 'GOCSPX-secret-a-ne-pas-divulguer',
      GMAIL_REFRESH_TOKEN: '1//refresh-token-secret',
      GMAIL_USER: 'commercial@atlas.fr',
    } as NodeJS.ProcessEnv);
    assert.ok(credentials);
    assert.equal(status.code, 'GMAIL_READY');
    assert.deepEqual(status.scopes, [GMAIL_READONLY_SCOPE]);
    assert.equal(status.detail.includes('GOCSPX'), false, 'le secret ne figure pas dans le détail');
    assert.equal(status.detail.includes('refresh-token'), false, 'le jeton non plus');
    assert.equal(status.detail, 'boîte commercial@atlas.fr');
  });
});

describe('lecture du contenu', () => {
  test('le texte brut est extrait, le HTML ignoré', () => {
    // Convertir du HTML approximativement introduit des mots qui n'y étaient
    // pas — et ces mots servent ensuite à classer la réponse.
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/html', body: { data: Buffer.from('<b>gras</b>').toString('base64url') } },
        { mimeType: 'text/plain', body: { data: Buffer.from('bonjour').toString('base64url') } },
      ],
    };
    assert.equal(extractPlainText(payload), 'bonjour');
    assert.equal(extractPlainText({ mimeType: 'text/html', body: { data: 'x' } }), null);
  });

  test('une boîte figée se lit sans réseau', async () => {
    const provider = new FixtureInboxProvider([
      mailMessage({ messageId: 'm1', receivedAt: '2026-08-19T09:00:00.000Z' }),
      mailMessage({ messageId: 'm2', receivedAt: '2026-08-20T09:00:00.000Z' }),
    ]);
    assert.equal(provider.status().configured, true);
    assert.equal((await provider.list()).length, 2);
    assert.equal((await provider.list({ since: '2026-08-20T00:00:00.000Z' })).length, 1);
    assert.equal((await provider.list({ max: 1 })).length, 1);
  });
});
