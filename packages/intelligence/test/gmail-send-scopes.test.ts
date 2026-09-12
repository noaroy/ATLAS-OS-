import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  GmailOutboundProvider, GmailInboxProvider,
  ACCEPTED_GMAIL_SCOPES, scopesInExcess,
  GMAIL_READONLY_SCOPE_URI, GMAIL_SEND_SCOPE_URI,
} from '../src/index.ts';
import { createLogger } from '@atlas/core';

/**
 * Un jeton qui porte la lecture *et* l'envoi.
 *
 * C'est le cas réel, et il a cassé les trois chemins d'un coup — chacun pour une
 * raison différente, ce qui explique pourquoi la panne était si déroutante :
 *
 *   · la lecture levait « jeton trop large » et rendait la boîte illisible, au
 *     motif qu'on venait d'obtenir un droit supplémentaire ;
 *   · l'envoi refusait de son côté tout ce qui dépassait l'envoi, donc aurait
 *     levé sur le même jeton ;
 *   · et le contrôle annonçait « portée absente » parce que la liste des
 *     portées était une option de constructeur, vide par défaut, que personne
 *     ne remplissait — un verdict codé en dur, jamais une observation.
 *
 * Trois copies d'une même règle finissent par ne plus dire la même chose. Elles
 * n'en font plus qu'une, et ces tests la tiennent.
 */

const logger = createLogger({ level: 'error', pretty: false });

const IDENTIFIANTS = {
  GMAIL_CLIENT_ID: 'factice.apps.googleusercontent.com',
  GMAIL_CLIENT_SECRET: 'factice-secret',
  GMAIL_REFRESH_TOKEN: 'factice-refresh',
  GMAIL_USER: 'exploitation@exemple.invalid',
};

describe('la liste blanche des portées', () => {
  test('elle admet la lecture et l’envoi, et rien d’autre', () => {
    assert.deepEqual([...ACCEPTED_GMAIL_SCOPES].sort(), [
      GMAIL_READONLY_SCOPE_URI, GMAIL_SEND_SCOPE_URI,
    ].sort());
  });

  test('un jeton lecture + envoi ne dépasse rien', () => {
    assert.deepEqual(
      scopesInExcess([GMAIL_READONLY_SCOPE_URI, GMAIL_SEND_SCOPE_URI]), [],
    );
  });

  test('les portées trop puissantes restent dehors', () => {
    // `gmail.modify` étiquette et supprime, `mail.google.com` fait tout : aucune
    // fonction d'ATLAS ne les emploie, et un jeton qui les porte finit toujours
    // par servir à autre chose.
    for (const interdite of [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://mail.google.com/',
    ]) {
      assert.deepEqual(
        scopesInExcess([GMAIL_READONLY_SCOPE_URI, interdite]), [interdite],
        `${interdite} doit être refusée`,
      );
    }
  });
});

describe('l’état d’envoi reflète le vrai jeton', () => {
  test('portées = lecture + envoi → l’envoi est autorisé', () => {
    // Le scénario exact de la panne : la portée venait d'être accordée, et le
    // contrôle continuait d'annoncer qu'elle manquait.
    const provider = new GmailOutboundProvider({
      env: { ...IDENTIFIANTS },
      grantedScopes: [GMAIL_READONLY_SCOPE_URI, GMAIL_SEND_SCOPE_URI],
    });
    const status = provider.status();
    assert.equal(status.configured, true);
    assert.equal(status.code, 'GMAIL_SEND_READY');
  });

  test('portée de lecture seule → l’envoi reste refusé', () => {
    const provider = new GmailOutboundProvider({
      env: { ...IDENTIFIANTS },
      grantedScopes: [GMAIL_READONLY_SCOPE_URI],
    });
    const status = provider.status();
    assert.equal(status.configured, false);
    assert.equal(status.code, 'GMAIL_SEND_SCOPE_MISSING');
  });

  test('« pas encore vérifié » se distingue de « refusé »', () => {
    // La confusion des deux est la cause exacte de la panne. Sans avoir posé la
    // question, on ne peut pas répondre « la portée manque » — on peut
    // seulement répondre « je n'ai pas regardé ».
    const provider = new GmailOutboundProvider({ env: { ...IDENTIFIANTS } });
    assert.equal(provider.status().code, 'GMAIL_SEND_SCOPE_UNVERIFIED');
  });

  test('sans identifiants, il n’y a rien à interroger', async () => {
    const provider = new GmailOutboundProvider({ env: {} });
    assert.equal(await provider.verifyScopes(), null);
  });

  test('la portée accordée ne suffit pas sans identifiants', () => {
    const provider = new GmailOutboundProvider({
      env: {},
      grantedScopes: [GMAIL_SEND_SCOPE_URI],
    });
    const status = provider.status();
    assert.equal(status.configured, false);
    assert.equal(status.code, 'GMAIL_NOT_CONFIGURED');
  });
});

describe('la lecture survit à l’obtention de l’envoi', () => {
  test('les identifiants de lecture restent reconnus', () => {
    // La lecture et l'envoi partagent le meme jeton. Obtenir l'envoi ne doit pas
    // faire perdre la lecture — c'est pourtant ce qui est arrive : la boite est
    // devenue illisible parce qu'un droit avait ete ajoute.
    const inbox = new GmailInboxProvider({ logger, env: { ...IDENTIFIANTS } });
    const status = inbox.status();
    assert.equal(status.configured, true);
  });
});
