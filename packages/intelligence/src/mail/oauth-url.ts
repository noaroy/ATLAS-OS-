import { AtlasError } from '@atlas/core';
import { GMAIL_READONLY_SCOPE } from './gmail.ts';
import { GMAIL_SEND_SCOPE_URI } from './types.ts';

/**
 * L'URL de consentement Google, construite et vérifiée avant d'être ouverte.
 *
 * Le besoin d'un module séparé vient d'une panne précise. L'URL était correcte
 * — elle portait bien `response_type=code` — mais elle était ouverte sous
 * Windows par `cmd /c start`, et `cmd.exe` traite `&` comme un séparateur de
 * commandes. Le navigateur ne recevait donc que le fragment jusqu'au premier
 * `&` : `client_id` seul. Google répondait « Required parameter is missing:
 * response_type », ce qui désignait un paramètre pourtant présent, à deux
 * caractères d'être transmis.
 *
 * Deux conséquences, et la seconde explique ce fichier. Il faut ouvrir l'URL
 * sans passer par un shell — c'est l'affaire de l'appelant. Et il faut pouvoir
 * *vérifier* ce qui est produit sans ouvrir de navigateur, ce qui suppose une
 * fonction pure : une URL testée est une URL qu'on n'a pas besoin de croire.
 *
 * La vérification a lieu avant l'ouverture, jamais après. Une URL incomplète
 * ouverte dans un navigateur coûte un aller-retour vers une page d'erreur
 * Google dont le message désigne le mauvais coupable — c'est exactement ce qui
 * s'est passé.
 */

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

export interface AuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  /** Les portées demandées. Une au moins, et jamais vide. */
  scopes: readonly string[];
  state: string;
  codeChallenge: string;
  /**
   * Forcer l'écran de consentement.
   *
   * Google ne délivre un jeton de rafraîchissement qu'au premier consentement.
   * Sans cela, une seconde autorisation rend un jeton d'accès seul, et la
   * synchronisation cesse silencieusement à son expiration. À laisser à `true`
   * tant qu'aucun jeton exploitable n'est en main.
   */
  forceConsent?: boolean;
}

/** Ce qu'une URL d'autorisation doit porter pour que Google l'accepte. */
const REQUIRED_PARAMS = ['client_id', 'redirect_uri', 'response_type', 'scope', 'access_type'] as const;

/**
 * Ce qu'une URL d'autorisation ne doit jamais porter.
 *
 * Aucun de ces éléments n'a de raison d'apparaître dans une requête
 * d'autorisation : le secret client n'intervient qu'à l'échange du code, côté
 * serveur, et les jetons sont ce que le flux produit, pas ce qu'il consomme.
 * Un seul d'entre eux dans une URL signifierait qu'un secret vient de traverser
 * une barre d'adresse, un historique de navigation et les journaux de Google.
 */
const FORBIDDEN_PARAMS = ['client_secret', 'refresh_token', 'access_token', 'code_verifier'] as const;

const blank = (value: string | undefined): boolean => !value || value.trim().length === 0;

export function buildGmailAuthorizeUrl(input: AuthorizeUrlInput): string {
  if (blank(input.clientId)) {
    throw new AtlasError('BAD_REQUEST', 'client_id absent : renseignez GMAIL_CLIENT_ID');
  }
  if (blank(input.redirectUri)) {
    throw new AtlasError('BAD_REQUEST', 'redirect_uri absent : la boucle locale n’a pas démarré');
  }
  if (input.scopes.length === 0 || input.scopes.some(blank)) {
    throw new AtlasError('BAD_REQUEST', 'scope absent : rien ne serait demandé, donc rien accordé');
  }
  if (blank(input.state)) {
    throw new AtlasError('BAD_REQUEST', 'state absent : la réponse ne pourrait pas être authentifiée');
  }
  if (blank(input.codeChallenge)) {
    throw new AtlasError('BAD_REQUEST', 'code_challenge absent : PKCE ne protégerait plus l’échange');
  }

  // `URLSearchParams` encode chaque valeur : les deux-points des portées, les
  // barres obliques, le port de la boucle locale. Une concaténation à la main
  // les laisserait passer tels quels — ou les échapperait deux fois.
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: input.scopes.join(' '),
    // Sans quoi Google ne délivre aucun jeton de rafraîchissement, et l'accès
    // expire au bout d'une heure sans que rien ne l'annonce.
    access_type: 'offline',
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
  });
  if (input.forceConsent !== false) params.set('prompt', 'consent');

  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.search = params.toString();

  const verdict = validateAuthorizeUrl(url.toString());
  if (!verdict.valid) {
    throw new AtlasError('BAD_REQUEST', `URL d’autorisation invalide : ${verdict.reason}`);
  }
  return url.toString();
}

/**
 * Relit une URL déjà construite, comme le ferait Google.
 *
 * Séparée de la construction à dessein : elle vérifie le *résultat*, pas
 * l'intention. C'est ce qui permet de l'appliquer aussi à une URL venue
 * d'ailleurs, et de constater qu'une transformation en cours de route — un
 * shell, un copier-coller, un raccourci — ne l'a pas amputée.
 */
export function validateAuthorizeUrl(
  candidate: string,
): { valid: true } | { valid: false; reason: string } {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { valid: false, reason: 'ce n’est pas une URL' };
  }
  if (url.origin !== new URL(GOOGLE_AUTH_ENDPOINT).origin) {
    return { valid: false, reason: `origine inattendue : ${url.origin}` };
  }

  for (const name of REQUIRED_PARAMS) {
    const value = url.searchParams.get(name);
    if (value === null || value.trim().length === 0) {
      return { valid: false, reason: `paramètre « ${name} » absent ou vide` };
    }
  }
  if (url.searchParams.get('response_type') !== 'code') {
    return { valid: false, reason: 'response_type doit valoir « code »' };
  }
  if (url.searchParams.get('access_type') !== 'offline') {
    return { valid: false, reason: 'access_type doit valoir « offline » pour obtenir un refresh token' };
  }
  for (const name of FORBIDDEN_PARAMS) {
    if (url.searchParams.has(name)) {
      return { valid: false, reason: `« ${name} » n’a rien à faire dans une URL d’autorisation` };
    }
  }
  return { valid: true };
}

/** L'URL de boucle locale, pour un port attribué par le système. */
export const loopbackRedirectUri = (port: number): string => `http://127.0.0.1:${port}/callback`;

/**
 * Ce qu'une autorisation demande, et ce qu'elle accepte de recevoir.
 *
 * Deux modes, parce que l'envoi est une décision à part. La lecture suffit à
 * rattacher les réponses ; c'est la première phase, et elle se donne seule :
 * `readonly` ne demande que gmail.readonly et REFUSE un jeton qui porterait
 * davantage — Google reconduit parfois un consentement plus large donné
 * auparavant au même client. `with-send` ajoute gmail.send, pour le jour où
 * l'envoi approuvé sera décidé. Jamais gmail.modify, jamais mail.google.com.
 */
export type GmailAuthMode = 'readonly' | 'with-send';

export function gmailScopesFor(mode: GmailAuthMode): { requested: readonly string[]; accepted: readonly string[] } {
  const scopes = mode === 'with-send' ? [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE_URI] : [GMAIL_READONLY_SCOPE];
  return { requested: scopes, accepted: scopes };
}

/** `--with-send` ou `--scope=send` demandent l'envoi ; tout le reste est lecture seule. */
export function parseGmailAuthMode(argv: readonly string[]): GmailAuthMode {
  if (argv.includes('--with-send')) return 'with-send';
  const scope = argv.find((a) => a.startsWith('--scope='))?.slice('--scope='.length).trim().toLowerCase();
  if (scope === 'send' || scope === 'with-send' || scope === 'readonly+send') return 'with-send';
  return 'readonly';
}

export { GMAIL_READONLY_SCOPE };
