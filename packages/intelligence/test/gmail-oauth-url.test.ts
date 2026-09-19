import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGmailAuthorizeUrl, validateAuthorizeUrl, loopbackRedirectUri,
  GMAIL_READONLY_SCOPE, GOOGLE_AUTH_ENDPOINT,
} from '../src/index.ts';
import { gmailScopesFor, parseGmailAuthMode } from '../src/mail/oauth-url.ts';
import { GMAIL_SEND_SCOPE_URI } from '../src/mail/types.ts';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * L'URL de consentement, vérifiée sans ouvrir de navigateur.
 *
 * La panne qui a motivé ces tests était insidieuse : l'URL construite était
 * correcte, et Google répondait pourtant « Required parameter is missing:
 * response_type ». Le paramètre était bien là — il n'arrivait simplement pas,
 * parce que `cmd /c start` coupe une URL au premier `&`. Le message d'erreur
 * désignait le mauvais coupable, et personne n'aurait pensé à regarder du côté
 * de l'ouverture du navigateur.
 *
 * D'où deux familles de tests. Ce que l'URL doit porter — parce qu'une URL
 * incomplète produit un message trompeur. Et ce qu'elle ne doit jamais porter,
 * parce qu'un secret dans une barre d'adresse a déjà traversé un historique de
 * navigation et les journaux d'un tiers.
 */

const valide = {
  clientId: '1234-abc.apps.googleusercontent.com',
  redirectUri: loopbackRedirectUri(51234),
  scopes: [GMAIL_READONLY_SCOPE],
  state: 'etat-aleatoire-hexadecimal',
  codeChallenge: 'defi-pkce-base64url',
};

describe('l’URL d’autorisation Gmail', () => {
  test('elle porte les paramètres que Google exige', () => {
    const params = new URL(buildGmailAuthorizeUrl(valide)).searchParams;

    assert.equal(params.get('response_type'), 'code', 'le paramètre de la panne');
    assert.equal(params.get('client_id'), valide.clientId);
    assert.ok(params.get('client_id')!.length > 0, 'client_id non vide');
    assert.equal(params.get('redirect_uri'), valide.redirectUri);
    assert.ok(params.get('redirect_uri')!.length > 0, 'redirect_uri non vide');
    assert.equal(params.get('scope'), GMAIL_READONLY_SCOPE);
    assert.equal(params.get('access_type'), 'offline', 'sans quoi aucun refresh token');
  });

  test('elle ne porte jamais de secret', () => {
    const url = buildGmailAuthorizeUrl(valide);
    for (const interdit of ['client_secret', 'refresh_token', 'access_token', 'code_verifier']) {
      assert.ok(!url.includes(interdit), `« ${interdit} » ne doit pas figurer dans l’URL`);
    }
  });

  test('elle vise bien Google, et l’endpoint d’autorisation', () => {
    const url = new URL(buildGmailAuthorizeUrl(valide));
    assert.equal(url.origin, new URL(GOOGLE_AUTH_ENDPOINT).origin);
  });

  test('PKCE accompagne la demande', () => {
    const params = new URL(buildGmailAuthorizeUrl(valide)).searchParams;
    assert.equal(params.get('code_challenge'), valide.codeChallenge);
    assert.equal(params.get('code_challenge_method'), 'S256');
    // `state` authentifie la réponse : sans lui, n'importe quelle redirection
    // vers la boucle locale serait acceptée.
    assert.equal(params.get('state'), valide.state);
  });

  test('le consentement est forcé par défaut, et peut être relâché', () => {
    // Google ne délivre un refresh token qu'au premier consentement : sans
    // `prompt=consent`, une seconde autorisation rend un jeton d'accès seul et
    // la synchronisation cesse en silence à son expiration.
    assert.equal(
      new URL(buildGmailAuthorizeUrl(valide)).searchParams.get('prompt'), 'consent',
    );
    assert.equal(
      new URL(buildGmailAuthorizeUrl({ ...valide, forceConsent: false })).searchParams.get('prompt'),
      null,
    );
  });

  test('les caractères spéciaux sont encodés, pas concaténés', () => {
    // La portée contient `://` et des barres obliques ; l'adresse de retour un
    // port et un chemin. Une concaténation à la main les laisserait passer tels
    // quels — ou les échapperait deux fois.
    const url = buildGmailAuthorizeUrl(valide);
    assert.ok(url.includes('scope=https%3A%2F%2F'), `portée non encodée : ${url}`);
    assert.ok(url.includes('redirect_uri=http%3A%2F%2F127.0.0.1%3A51234'), `retour non encodé : ${url}`);
    // Et la relecture rend bien les valeurs d'origine.
    assert.equal(new URL(url).searchParams.get('scope'), GMAIL_READONLY_SCOPE);
  });

  test('plusieurs portées se séparent par une espace, comme Google l’attend', () => {
    const url = buildGmailAuthorizeUrl({ ...valide, scopes: [GMAIL_READONLY_SCOPE, 'openid'] });
    assert.equal(new URL(url).searchParams.get('scope'), `${GMAIL_READONLY_SCOPE} openid`);
  });
});

describe('le refus avant ouverture du navigateur', () => {
  // Une URL invalide ouverte coûte un aller-retour vers une page d'erreur
  // Google dont le message désigne le mauvais coupable. Mieux vaut échouer ici.
  const cas: Array<[string, Partial<typeof valide>, RegExp]> = [
    ['client_id vide', { clientId: '   ' }, /client_id/],
    ['redirect_uri vide', { redirectUri: '' }, /redirect_uri/],
    ['aucune portée', { scopes: [] }, /scope/],
    ['portée vide', { scopes: [''] }, /scope/],
    ['state absent', { state: '' }, /state/],
    ['défi PKCE absent', { codeChallenge: '' }, /code_challenge/],
  ];

  for (const [nom, patch, motif] of cas) {
    test(`${nom} : échec local, message clair`, () => {
      assert.throws(() => buildGmailAuthorizeUrl({ ...valide, ...patch }), motif);
    });
  }
});

describe('la relecture d’une URL déjà construite', () => {
  test('une URL amputée au premier « & » est refusée', () => {
    // Exactement ce que le navigateur recevait : `cmd.exe` traite `&` comme un
    // séparateur de commandes, et ne transmettait que le premier fragment.
    const complete = buildGmailAuthorizeUrl(valide);
    const amputee = complete.split('&')[0]!;

    assert.equal(validateAuthorizeUrl(complete).valid, true);
    const verdict = validateAuthorizeUrl(amputee);
    assert.equal(verdict.valid, false);
    assert.match(verdict.valid === false ? verdict.reason : '', /redirect_uri|response_type/);
  });

  test('un access_type absent est refusé : pas de refresh token sans lui', () => {
    const url = new URL(buildGmailAuthorizeUrl(valide));
    url.searchParams.delete('access_type');
    const verdict = validateAuthorizeUrl(url.toString());
    assert.equal(verdict.valid, false);
    assert.match(verdict.valid === false ? verdict.reason : '', /access_type/);
  });

  test('un response_type autre que « code » est refusé', () => {
    // Le flux implicite rend un jeton dans le fragment d'URL. ATLAS fait du
    // code d'autorisation, et rien d'autre.
    const url = new URL(buildGmailAuthorizeUrl(valide));
    url.searchParams.set('response_type', 'token');
    assert.equal(validateAuthorizeUrl(url.toString()).valid, false);
  });

  test('un secret glissé dans l’URL la rend invalide', () => {
    const url = new URL(buildGmailAuthorizeUrl(valide));
    url.searchParams.set('client_secret', 'peu-importe');
    const verdict = validateAuthorizeUrl(url.toString());
    assert.equal(verdict.valid, false);
    assert.match(verdict.valid === false ? verdict.reason : '', /client_secret/);
  });

  test('une origine qui n’est pas Google est refusée', () => {
    assert.equal(
      validateAuthorizeUrl('https://exemple.invalid/auth?response_type=code').valid, false,
    );
  });
});

describe('l’adresse de retour en boucle locale', () => {
  test('elle vise 127.0.0.1, jamais un hôte distant', () => {
    const uri = loopbackRedirectUri(49876);
    assert.equal(uri, 'http://127.0.0.1:49876/callback');
    // Le code d'autorisation ne transite par aucun serveur tiers, et le flux
    // OOB déprécié n'est pas utilisé.
    assert.ok(!uri.includes('urn:ietf:wg:oauth:2.0:oob'));
  });
});

describe('les modes d’autorisation : la lecture seule d’abord, l’envoi sur demande explicite', () => {
  test('par défaut, seule gmail.readonly est demandée — et seule elle est acceptée', () => {
    const mode = parseGmailAuthMode(['node', 'gmail-authorize.ts']);
    assert.equal(mode, 'readonly');
    const { requested, accepted } = gmailScopesFor(mode);
    assert.deepEqual([...requested], [GMAIL_READONLY_SCOPE]);
    assert.deepEqual([...accepted], [GMAIL_READONLY_SCOPE]);
    assert.ok(!accepted.includes(GMAIL_SEND_SCOPE_URI), 'un jeton portant l’envoi sera refusé en phase lecture seule');
  });

  test('--with-send (ou --scope=send) ajoute gmail.send, et rien d’autre', () => {
    for (const argv of [['--with-send'], ['--scope=send'], ['--scope=readonly+send']]) {
      const { requested, accepted } = gmailScopesFor(parseGmailAuthMode(argv));
      assert.deepEqual([...requested], [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE_URI], argv.join(' '));
      assert.deepEqual([...accepted], [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE_URI]);
      assert.ok(!requested.some((s) => /gmail\.modify|mail\.google\.com/.test(s)));
    }
    assert.equal(parseGmailAuthMode(['--scope=readonly']), 'readonly');
  });

  test('gmail:authorize construit sa demande à partir du mode, pas d’une liste figée avec l’envoi', () => {
    const source = readFileSync(join(resolve(import.meta.dirname, '../../..'), 'scripts', 'gmail-authorize.ts'), 'utf8');
    assert.match(source, /const MODE = parseGmailAuthMode\(process\.argv\);/);
    assert.match(source, /gmailScopesFor\(MODE\)\.accepted/);
    assert.ok(!/const ACCEPTED_SCOPES = \[GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE\]/.test(source), 'plus de liste figée lecture+envoi');
    assert.ok(!/process\.exit\(1\)/.test(source), 'aucune sortie forcée après le réseau');
  });
});
