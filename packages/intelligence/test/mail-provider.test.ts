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

describe('le bootstrap d’autorisation', () => {
  const raw = readFileSync(new URL('../../../scripts/gmail-authorize.ts', import.meta.url), 'utf8');
  // Les commentaires nomment les portées interdites pour expliquer pourquoi
  // elles le sont. L'assertion porte sur ce qui s'exécute, pas sur la prose.
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  test('ne demande que la lecture — et l’envoi seulement sur demande explicite', () => {
    // La liste blanche vient du mode : lecture seule par défaut (la phase 1),
    // lecture et envoi sur --with-send. Celles qui restent interdites
    // donneraient sur la boîte entière un pouvoir qu'aucune fonction d'ATLAS
    // ne demande — étiqueter, supprimer, tout lire.
    assert.equal(source.includes('gmail.modify'), false);
    assert.equal(source.includes('gmail.compose'), false);
    assert.equal(source.includes('mail.google.com'), false);

    // Les portées viennent des constantes partagées, par le mode, jamais d'une
    // chaîne recopiée ici : deux littéraux finiraient par diverger.
    assert.ok(
      /const MODE = parseGmailAuthMode\(process\.argv\);/.test(source)
        && /const ACCEPTED_SCOPES = \[\.\.\.gmailScopesFor\(MODE\)\.accepted\]/.test(source),
      'la liste blanche est celle du mode, depuis les constantes',
    );
    assert.ok(
      /scopes:\s*ACCEPTED_SCOPES/.test(source),
      'la demande porte sur la liste blanche, pas sur autre chose',
    );
    assert.equal(
      /scopes?:\s*\[?\s*'/.test(source),
      false,
      'aucune portée écrite en dur dans la requête',
    );
    // Le refus porte sur ce que Google a réellement accordé : il reconduit
    // parfois un consentement plus large donné auparavant au même client.
    assert.ok(
      /granted\.filter\(\(scope\) => !ACCEPTED_SCOPES\.includes\(scope\)\)/.test(source),
      'un jeton plus large que la liste blanche doit être refusé',
    );
  });

  test('refuse une portée plus large que celle demandée', () => {
    // Google reconduit parfois un consentement plus large donné auparavant au
    // même client. Demander la lecture ne suffit donc pas : il faut vérifier
    // ce qui est rendu.
    assert.ok(raw.includes('CONNEXION REFUSÉE'));
    assert.ok(/extra\.length > 0/.test(source));
    assert.ok(raw.includes('Rien n’a été écrit'), 'un refus n’écrit rien');
  });

  test('n’affiche jamais le jeton', () => {
    // Un secret qui passe dans un terminal finit dans un historique.
    const printsToken = /console\.(log|error)\([^)]*(refresh_token|access_token)/.test(source);
    assert.equal(printsToken, false);
  });

  test('écrit dans un fichier ignoré par Git', () => {
    assert.ok(raw.includes('.env.local'));
    const ignored = readFileSync(new URL('../../../.gitignore', import.meta.url), 'utf8');
    assert.ok(ignored.includes('.env.local'));
    assert.ok(ignored.includes('client_secret*.json'));
  });

  test('la vérification lit sans rien modifier', () => {
    const check = readFileSync(new URL('../../../scripts/gmail-check.ts', import.meta.url), 'utf8');
    for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const calls = [...check.matchAll(new RegExp(`method:\s*'${verb}'`, 'g'))];
      // Le seul POST est l'échange de jeton OAuth, qui ne touche pas la boîte.
      assert.ok(calls.length <= (verb === 'POST' ? 1 : 0), `${verb} de trop dans gmail-check`);
    }
    assert.equal(check.includes('/messages/send'), false);
  });
});

describe('le plafond du fournisseur de fixture', () => {
  test('max: 0 ne rend aucun message', () => {
    // `if (query.max)` traitait zéro comme une absence de plafond : une demande
    // de zéro message rendait toute la boîte. Un fixture qui ne respecte pas son
    // contrat fait mentir tous les tests qui s'appuient sur lui.
    const provider = new FixtureInboxProvider([
      mailMessage({ messageId: 'a' }),
      mailMessage({ messageId: 'b' }),
    ]);
    return provider.list({ max: 0 }).then((messages) => {
      assert.equal(messages.length, 0);
    });
  });

  test('un plafond ordinaire coupe toujours', async () => {
    const provider = new FixtureInboxProvider([
      mailMessage({ messageId: 'a' }),
      mailMessage({ messageId: 'b' }),
      mailMessage({ messageId: 'c' }),
    ]);
    assert.equal((await provider.list({ max: 2 })).length, 2);
    assert.equal((await provider.list({})).length, 3);
  });
});

describe('ce que la requête Gmail écarte, et quand elle ne l’écarte pas', () => {
  /**
   * `-in:sent -in:draft` économise et protège : nos propres messages ne
   * remontent pas. C'est le chemin par défaut, et il ne bouge pas. Seul un
   * appelant qui le demande explicitement (`includeOwnMessages`) les obtient —
   * la synchronisation ne le fait que pour le self-test isolé, en INTERNAL_TEST.
   */
  const ENV = {
    GMAIL_CLIENT_ID: 'id', GMAIL_CLIENT_SECRET: 'secret', GMAIL_REFRESH_TOKEN: 'jeton', GMAIL_USER: 'noaroy@gmail.com',
  } as NodeJS.ProcessEnv;
  const originalFetch = globalThis.fetch;

  /** Un Gmail factice qui n'a aucun message, et qui note la requête `q` reçue. */
  const captureQueries = () => {
    const queries: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.href === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'acces', expires_in: 3600, scope: GMAIL_READONLY_SCOPE }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.pathname.endsWith('/messages')) {
        queries.push(url.searchParams.get('q') ?? '');
        return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`appel inattendu : ${url.href}`);
    }) as typeof fetch;
    return queries;
  };

  test('par défaut, la requête porte -in:sent -in:draft ; avec includeOwnMessages elle ne le porte plus — et seulement alors', async () => {
    const queries = captureQueries();
    try {
      const provider = new GmailInboxProvider({ logger, env: ENV });
      await provider.list({ since: '2026-09-20T00:00:00.000Z' });
      await provider.list({ since: '2026-09-20T00:00:00.000Z', includeOwnMessages: true, rawFilter: 'from:noaroy@gmail.com to:noaroy@gmail.com' });
      await provider.list({});
      assert.equal(queries.length, 3);
      assert.match(queries[0]!, /^-in:sent -in:draft after:\d+$/);
      assert.ok(!queries[1]!.includes('-in:sent'), 'le self-test lit aussi nos propres messages');
      assert.match(queries[1]!, /^from:noaroy@gmail\.com to:noaroy@gmail\.com after:\d+$/, 'et seulement ceux de notre boîte vers notre boîte');
      assert.equal(queries[2], '-in:sent -in:draft', 'sans option, le filtre revient : rien de global n’a bougé');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('la boîte figée se comporte comme Gmail sur ce qui compte', () => {
  const messages = [
    mailMessage({ messageId: 'in-1', from: 'jean@acme.fr', to: ['noaroy@gmail.com'], labels: ['INBOX'] }),
    mailMessage({ messageId: 'own-1', from: 'noaroy@gmail.com', to: ['jean@acme.fr'], labels: ['SENT'] }),
    mailMessage({ messageId: 'self-1', from: 'noaroy@gmail.com', to: ['noaroy@gmail.com'], labels: ['SENT', 'INBOX'] }),
    mailMessage({ messageId: 'draft-1', from: 'noaroy@gmail.com', to: ['x@y.fr'], labels: ['DRAFT'] }),
  ];

  test('sans includeOwnMessages, SENT et DRAFT ne remontent pas ; avec, ils remontent', async () => {
    const provider = new FixtureInboxProvider(messages);
    assert.deepEqual((await provider.list()).map((m) => m.messageId), ['in-1']);
    assert.deepEqual((await provider.list({ includeOwnMessages: true })).map((m) => m.messageId), ['in-1', 'own-1', 'self-1', 'draft-1']);
  });

  test('`from:` et `to:` restreignent comme Gmail — la lecture du self-test ne ramène que la boîte vers elle-même', async () => {
    const provider = new FixtureInboxProvider(messages);
    const selfAddressed = await provider.list({ includeOwnMessages: true, rawFilter: 'from:noaroy@gmail.com to:noaroy@gmail.com' });
    assert.deepEqual(selfAddressed.map((m) => m.messageId), ['self-1']);
    assert.deepEqual((await provider.list({ rawFilter: 'from:acme.fr' })).map((m) => m.messageId), ['in-1']);
  });
});
