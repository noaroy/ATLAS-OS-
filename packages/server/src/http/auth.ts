import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { User, UserRole } from '@atlas/contracts';
import { forbidden, unauthorized } from '@atlas/core';
import { UserRepository } from '@atlas/data';
import type { AtlasSystem } from '../bootstrap.ts';
import {
  SESSION_COOKIE,
  appendSetCookie,
  readCookie,
  serializeSessionCookie,
} from './cookies.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

const ROLE_RANK: Record<UserRole, number> = { viewer: 1, operator: 2, founder: 3 };

/**
 * Finds the caller's session token.
 *
 * Order matters. The browser console authenticates with an httpOnly cookie it
 * cannot read, which is what protects the token from XSS. Scripts and API
 * clients — the demo, curl, an integration — use a bearer token instead. The
 * query parameter exists only for non-browser WebSocket clients; a browser
 * sends the cookie on the handshake automatically.
 */
export function tokenFrom(request: FastifyRequest): string | null {
  const cookie = readCookie(request, SESSION_COOKIE);
  if (cookie) return cookie;

  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;

  const query = request.query as { token?: string } | undefined;
  return query?.token?.trim() || null;
}

/**
 * The path a guard decides on: the one the router resolved.
 *
 * Found in review: `GET /%61pi/cc/dashboard`. The router decodes `%61` to `a`
 * and serves /api/cc/dashboard; the guard read the raw URL, saw no "/api",
 * and let the request through unauthenticated. A prefix is judged on the
 * resolved route (`routeOptions.url`, e.g. `/api/artifacts/*`), never on the
 * URL as the client spelled it. With no route (404) the decoded path serves;
 * an undecodable URL is treated as protected.
 */
export function guardedPath(request: FastifyRequest): string {
  const route = request.routeOptions?.url;
  if (typeof route === 'string' && route.length > 0) return route;
  const raw = request.url.split('?')[0] ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return '/api/undecodable';
  }
}

/** True when the token came from the cookie, so a rotation must re-set it. */
function cameFromCookie(request: FastifyRequest): boolean {
  return readCookie(request, SESSION_COOKIE) !== null;
}

/**
 * Authentication guard.
 *
 * Registered as a hook rather than per-route wrapping so that adding a route
 * cannot accidentally leave it unprotected — public routes are opted in by
 * path, and everything else requires a session.
 */
export function installAuth(app: FastifyInstance, system: AtlasSystem, publicPaths: string[]): void {
  app.decorateRequest('user', undefined);

  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS') return;

    const path = guardedPath(request);

    // The guard protects data, not the shell. Static console assets are
    // public — they are useless without a session, and gating them would
    // leave a browser unable to load the login screen at all.
    if (!path.startsWith('/api')) return;
    if (publicPaths.some((p) => path === p || path.startsWith(`${p}/`))) return;

    const token = tokenFrom(request);
    if (!token) throw unauthorized();

    const user = system.repos.users.resolveSession(token);
    if (!user) throw unauthorized('Session expired or invalid');

    request.user = user;

    // Sliding expiry, managed entirely server-side: a console left open all
    // week keeps working, while the token itself is rotated periodically so a
    // leaked one has a bounded life. Only cookie sessions are refreshed —
    // a bearer client holds its own token and would not see the new one.
    if (cameFromCookie(request)) {
      const refreshed = system.repos.users.refreshIfNeeded(token, request.headers['user-agent']);
      if (refreshed) {
        appendSetCookie(
          reply,
          serializeSessionCookie(refreshed.token, {
            maxAgeSeconds: UserRepository.sessionTtlSeconds,
            secure: isSecureRequest(request, system),
          }),
        );
      }
    }
  });
}

/**
 * Whether the connection reaching the user is encrypted.
 *
 * Behind the reverse proxy the deployment requires, the hop into ATLAS is
 * plain HTTP while the browser's connection is TLS — so the forwarded
 * protocol decides, and production is treated as secure by default.
 */
export function isSecureRequest(request: FastifyRequest, system: AtlasSystem): boolean {
  if (system.config.isProduction) return true;
  const forwarded = request.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (proto ?? request.protocol) === 'https';
}

/** Route-level role gate for anything that changes how the system operates. */
export function requireRole(minimum: UserRole) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!request.user) throw unauthorized();
    if (ROLE_RANK[request.user.role] < ROLE_RANK[minimum]) {
      throw forbidden(`This action requires the ${minimum} role`);
    }
  };
}

export const requireOperator = requireRole('operator');
export const requireFounder = requireRole('founder');
