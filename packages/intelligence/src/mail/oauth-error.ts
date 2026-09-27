/**
 * Un refus du point de jeton Google, dit précisément et sans fuite.
 *
 * « échange de jeton refusé (HTTP 400) » ne disait pas quoi faire : un jeton
 * de rafraîchissement expiré ou révoqué, un mauvais client OAuth et une
 * requête malformée rendent tous un 400. Google nomme la cause dans le champ
 * `error` du corps JSON (RFC 6749 §5.2) : une énumération courte, jamais un
 * secret. Seul ce champ est lu, et seulement s'il figure dans la liste
 * ci-dessous — `error_description` et le reste du corps ne sont jamais
 * recopiés.
 */

export const OAUTH_ERROR_CODES = [
  'invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_request',
  'invalid_scope', 'unsupported_grant_type', 'access_denied',
] as const;
export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number];

/** Ce qu'une personne doit faire pour chaque cause — jamais un contournement. */
const HUMAN_ACTION: Record<OAuthErrorCode, string> = {
  invalid_grant: 'jeton de rafraîchissement expiré ou révoqué (écran de consentement en « Testing » : 7 jours ; mot de passe changé ; accès retiré) — réautoriser : npm run gmail:authorize, puis recopier GMAIL_REFRESH_TOKEN',
  invalid_client: 'client OAuth inconnu ou secret faux — vérifier que GMAIL_CLIENT_ID et GMAIL_CLIENT_SECRET viennent du même client « Desktop app »',
  unauthorized_client: 'le jeton a été émis pour un autre client OAuth — réautoriser avec le GMAIL_CLIENT_ID actuel (npm run gmail:authorize)',
  invalid_request: 'requête incomplète — une variable GMAIL_* est vide ou tronquée (espaces, guillemets, retour à la ligne)',
  invalid_scope: 'portée refusée — réautoriser en lecture seule (npm run gmail:authorize, sans --with-send)',
  unsupported_grant_type: 'type d’échange refusé — défaut de code, grant_type doit valoir refresh_token',
  access_denied: 'accès refusé par le compte Google — réautoriser (npm run gmail:authorize)',
};

export interface TokenRefusal {
  status: number;
  /** Le code Google, s'il est reconnu ; null sinon (corps absent ou inattendu). */
  code: OAuthErrorCode | null;
  humanAction: string;
  message: string;
}

/** Le corps d'erreur ne sert qu'à lire `error`, et seulement une valeur connue. */
export function oauthErrorCodeOf(body: string): OAuthErrorCode | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    const code = typeof parsed.error === 'string' ? parsed.error : null;
    return code && (OAUTH_ERROR_CODES as readonly string[]).includes(code) ? (code as OAuthErrorCode) : null;
  } catch {
    return null;
  }
}

export function describeTokenRefusal(status: number, body: string): TokenRefusal {
  const code = oauthErrorCodeOf(body);
  const humanAction = code ? HUMAN_ACTION[code]
    : status === 401 ? HUMAN_ACTION.invalid_client
    : 'cause non renseignée par Google — lancer npm run gmail:check pour la relire';
  return {
    status, code, humanAction,
    message: `échange de jeton refusé (HTTP ${status}${code ? ` · ${code}` : ''}) — ${humanAction}`,
  };
}

/** Lit le corps d'une réponse refusée sans jamais le propager. */
export async function tokenRefusalOf(response: { status: number; text(): Promise<string> }): Promise<TokenRefusal> {
  let body = '';
  try { body = await response.text(); } catch { /* corps illisible : code inconnu */ }
  return describeTokenRefusal(response.status, body);
}
