/**
 * Le relais Vercel → ATLAS.
 *
 * Le tableau de bord hébergé sur Vercel ne parle qu'à sa propre origine : ses
 * appels `/api/*` arrivent ici et sont relayés vers le serveur ATLAS. Trois
 * conséquences, voulues :
 *
 *   · Vercel ne détient aucun secret. Pas de clé, pas de jeton de service :
 *     la seule configuration est l'adresse publique d'ATLAS
 *     (`ATLAS_API_ORIGIN`), qui n'en est pas un. L'authentification reste
 *     celle d'ATLAS — le cookie de session httpOnly, posé par ATLAS et relayé
 *     tel quel, devient un cookie de première partie du domaine Vercel.
 *   · Aucun CORS à ouvrir : le navigateur ne voit qu'une origine.
 *   · Le relais est étroit. Il ne transmet que `/api/*` et `/healthz`, avec
 *     une liste fermée d'en-têtes dans chaque sens, une durée bornée et un
 *     corps borné. Tout le reste est refusé avant d'avoir quitté Vercel.
 *
 * Le module est pur — `fetch` et l'environnement sont injectés — pour être
 * testé sans réseau.
 */

export const UPSTREAM_PARAM = '__upstream';
export const TIMEOUT_MS = 15_000;
export const MAX_BODY_BYTES = 1_000_000;

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
/** Ce que le navigateur peut faire passer. Ni `authorization`, ni en-tête de relais. */
const REQUEST_HEADERS = ['accept', 'accept-language', 'content-type', 'cookie', 'user-agent'];
/** Ce qu'ATLAS peut renvoyer. `set-cookie` est traité à part : il peut être multiple. */
const RESPONSE_HEADERS = ['content-type', 'retry-after', 'content-disposition'];

export interface ProxyEnv {
  ATLAS_API_ORIGIN?: string | undefined;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** L'origine d'ATLAS, validée : HTTPS obligatoire, sauf boucle locale pour les essais. */
export function upstreamOrigin(env: ProxyEnv): URL | null {
  const raw = env.ATLAS_API_ORIGIN?.trim();
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
  if (url.username || url.password) return null;
  if (url.pathname !== '/' || url.search || url.hash) return null;
  return url;
}

/**
 * Le chemin à relayer, lu dans le paramètre posé par la réécriture.
 *
 * Seuls `/healthz` et `/api/…` passent. Un chemin qui tente de sortir de
 * l'arborescence (`..`, barres doublées, encodages) est refusé : la
 * réécriture ne produit jamais cela, un appel forgé si.
 */
export function upstreamPath(raw: string | null): string | null {
  if (!raw) return null;
  if (raw === '/healthz') return raw;
  if (!raw.startsWith('/api/')) return null;
  if (raw.includes('..') || raw.includes('//') || raw.includes('\\') || /%2e|%2f|%5c/i.test(raw)) return null;
  if (!/^\/api\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(raw)) return null;
  return raw;
}

const json = (status: number, code: string, message: string, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });

export async function relay(request: Request, env: ProxyEnv, fetchImpl: Fetch = fetch): Promise<Response> {
  const origin = upstreamOrigin(env);
  if (!origin) return json(503, 'PROXY_NOT_CONFIGURED', 'Le relais n’a pas d’adresse ATLAS valide.');

  const method = request.method.toUpperCase();
  if (!METHODS.has(method)) return json(405, 'METHOD_NOT_ALLOWED', 'Méthode refusée par le relais.');

  const incoming = new URL(request.url);
  const path = upstreamPath(incoming.searchParams.get(UPSTREAM_PARAM));
  if (!path) return json(404, 'NOT_FOUND', 'Chemin inconnu.');
  if (path === '/api/realtime') {
    // Le relais ne tient pas de connexion longue : l'écran de téléphone lit
    // par intervalle et n'en a pas besoin.
    return json(501, 'REALTIME_UNAVAILABLE', 'Temps réel indisponible via le relais ; lecture par intervalle.');
  }

  const query = new URLSearchParams(incoming.searchParams);
  query.delete(UPSTREAM_PARAM);
  const target = new URL(path, origin);
  target.search = query.toString();

  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  let body: ArrayBuffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (declared > MAX_BODY_BYTES) return json(413, 'PAYLOAD_TOO_LARGE', 'Corps trop volumineux.');
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return json(413, 'PAYLOAD_TOO_LARGE', 'Corps trop volumineux.');
  }

  let upstream: Response;
  try {
    upstream = await fetchImpl(target.toString(), {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return timeout
      ? json(504, 'UPSTREAM_TIMEOUT', 'ATLAS n’a pas répondu à temps.')
      : json(502, 'UPSTREAM_UNREACHABLE', 'ATLAS est injoignable.');
  }

  const out = new Headers({ 'cache-control': 'no-store' });
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  for (const cookie of upstream.headers.getSetCookie()) out.append('set-cookie', cookie);

  // Une redirection d'ATLAS ne doit pas emmener le navigateur hors de Vercel.
  if (upstream.status >= 300 && upstream.status < 400) {
    return json(502, 'UPSTREAM_REDIRECT', 'Redirection refusée par le relais.');
  }

  return new Response(method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: out });
}

// ─── Fonction Vercel ─────────────────────────────────────────────────────────
// Chaque appel `/api/*` et `/healthz` du tableau de bord y est réécrit par
// `vercel.json`. Un seul fichier, sans import local : le runtime Node de Vercel
// n'a ainsi aucune résolution de module à faire.

const handle = (request: Request): Promise<Response> => relay(request, process.env);

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
