import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiResponse } from '@atlas/contracts';
import { AtlasError, toAtlasError, type Logger } from '@atlas/core';
import { ZodError } from 'zod';

/** Every successful response uses the same envelope. */
export function sendOk<T>(reply: FastifyReply, data: T, status = 200): FastifyReply {
  const body: ApiResponse<T> = { ok: true, data };
  return reply.status(status).send(body);
}

/**
 * Single error boundary for the API.
 *
 * Client mistakes are echoed with detail; server faults are logged in full and
 * reported without internals, so a stack trace can never leak to the console.
 */
export function installErrorHandler(app: {
  setErrorHandler(handler: (error: Error, request: FastifyRequest, reply: FastifyReply) => void): void;
}, logger: Logger): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      const details = error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      reply.status(400).send({
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'Request validation failed', details },
      });
      return;
    }

    // Transport-level client errors — the static plugin's 403 on a path it
    // refuses, Fastify's 413 on an oversized body, 415 on a media type — carry
    // an HTTP status of their own. They are the client's mistake, not a fault:
    // answer with that status, no stack in the logs. Found in review: a
    // backslash in a static path came back as a 500 with a stack trace.
    const carried = (error as { statusCode?: unknown }).statusCode;
    if (!(error instanceof AtlasError) && typeof carried === 'number' && carried >= 400 && carried < 500) {
      const code = carried === 401 ? 'UNAUTHORIZED' : carried === 403 ? 'FORBIDDEN' : carried === 404 ? 'NOT_FOUND' : carried === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST';
      reply.status(carried).send({ ok: false, error: { code, message: error.message || 'Request refused' } });
      return;
    }

    const atlas = toAtlasError(error);

    if (atlas.status >= 500) {
      logger.error('request failed', {
        method: request.method,
        url: request.url,
        code: atlas.code,
        message: atlas.message,
        stack: error.stack,
      });
      reply.status(atlas.status).send({
        ok: false,
        error: { code: atlas.code, message: 'An internal error occurred. Check the server logs.' },
      });
      return;
    }

    reply.status(atlas.status).send({ ok: false, error: atlas.toJSON() });
  });
}

export { AtlasError };
