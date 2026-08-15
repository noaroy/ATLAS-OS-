import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Cookie handling.
 *
 * Kept dependency-free: ATLAS sets exactly one cookie and reads exactly one,
 * so a parser and a serialiser are less surface than a plugin.
 */

export const SESSION_COOKIE = 'atlas_session';

export interface CookieOptions {
  maxAgeSeconds: number;
  secure: boolean;
}

/**
 * Serialises the session cookie.
 *
 * `httpOnly` keeps the token out of reach of any script on the page, which is
 * the whole point of moving off `localStorage`. `SameSite=Strict` means the
 * cookie is never attached to a cross-site request, so no CSRF token is
 * needed for the console's same-origin calls. `secure` is set whenever the
 * deployment is served over TLS.
 */
export function serializeSessionCookie(token: string, options: CookieOptions): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Expires the cookie immediately, matching the attributes it was set with. */
export function clearSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function readCookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;

  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    if (pair.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(pair.slice(index + 1).trim()) || null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Appends a Set-Cookie header without discarding any already present.
 *
 * Fastify's `header()` replaces; a session rotation during a request that
 * already set a cookie would otherwise silently lose one of them.
 */
export function appendSetCookie(reply: FastifyReply, value: string): void {
  const existing = reply.getHeader('set-cookie');
  if (existing === undefined) {
    reply.header('set-cookie', value);
    return;
  }
  const list = Array.isArray(existing) ? existing.map(String) : [String(existing)];
  reply.header('set-cookie', [...list, value]);
}
