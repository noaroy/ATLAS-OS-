import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AtlasError, RateLimiter, type Logger } from '@atlas/core';

/**
 * Request throttling.
 *
 * Two limiters with different jobs:
 *
 *  • **Authentication** — strict, and keyed on the source address *and* the
 *    email being tried. Keying on the address alone lets one attacker lock out
 *    a shared office; keying on the email alone lets a botnet lock out a
 *    specific founder. Both together throttle the attack, not the victim.
 *
 *  • **General API** — generous, and only there to stop a runaway client or a
 *    scraper from saturating a single-founder VPS.
 */

const AUTH_LIMIT = 8;
const AUTH_WINDOW_MS = 15 * 60_000;

const API_LIMIT = 600;
const API_WINDOW_MS = 60_000;

export interface Limiters {
  auth: RateLimiter;
  api: RateLimiter;
}

export function installRateLimits(app: FastifyInstance, logger: Logger): Limiters {
  const log = logger.child({ scope: 'rate-limit' });

  const limiters: Limiters = {
    auth: new RateLimiter({ limit: AUTH_LIMIT, windowMs: AUTH_WINDOW_MS, maxKeys: 20_000 }),
    api: new RateLimiter({ limit: API_LIMIT, windowMs: API_WINDOW_MS, maxKeys: 20_000 }),
  };

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api')) return;
    // The realtime socket is one long-lived connection, not a request stream.
    if (request.url.startsWith('/api/realtime')) return;

    const result = limiters.api.consume(`api:${clientIp(request)}`);
    if (!result.allowed) {
      log.warn('API rate limit hit', { ip: clientIp(request), url: request.url });
      throttle(reply, result.retryAfterMs);
      throw new AtlasError('RATE_LIMITED', 'Too many requests. Slow down and try again shortly.');
    }
  });

  return limiters;
}

/**
 * Guards a login attempt. Call before verifying credentials, and call
 * `limiters.auth.reset(...)` on success so a legitimate user who mistyped
 * once is not punished for the rest of the window.
 */
export function guardLogin(
  limiters: Limiters,
  request: FastifyRequest,
  reply: FastifyReply,
  email: string,
  logger: Logger,
): { key: string } {
  const key = `login:${clientIp(request)}:${email.toLowerCase()}`;
  const result = limiters.auth.consume(key);

  if (!result.allowed) {
    logger.warn('login rate limit hit', { ip: clientIp(request), email });
    throttle(reply, result.retryAfterMs);
    const seconds = Math.ceil(result.retryAfterMs / 1000);
    throw new AtlasError(
      'RATE_LIMITED',
      `Too many sign-in attempts. Try again in ${seconds > 60 ? `${Math.ceil(seconds / 60)} minutes` : `${seconds} seconds`}.`,
    );
  }

  return { key };
}

function throttle(reply: FastifyReply, retryAfterMs: number): void {
  reply.header('retry-after', String(Math.ceil(retryAfterMs / 1000)));
}

/**
 * The caller's address.
 *
 * Fastify is configured with `trustProxy`, so `request.ip` already reflects
 * `X-Forwarded-For` when ATLAS sits behind the reverse proxy the deployment
 * docs require.
 */
function clientIp(request: FastifyRequest): string {
  return request.ip || 'unknown';
}
