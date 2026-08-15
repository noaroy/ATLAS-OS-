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
