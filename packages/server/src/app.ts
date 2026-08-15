import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { AtlasSystem } from './bootstrap.ts';
import { installErrorHandler, AtlasError } from './http/reply.ts';
import { installAuth } from './http/auth.ts';
import { installRateLimits } from './http/limits.ts';
import { registerRoutes } from './http/routes.ts';
import { registerRealtime } from './http/realtime.ts';

/** Routes reachable without a session. Everything else requires one. */
const PUBLIC_PATHS = ['/healthz', '/api/auth/login'];

/**
 * Builds the HTTP surface.
 *
 * In production the same process also serves the built console, so a VPS
 * deployment is one service on one port behind one reverse proxy.
 */
export async function createApp(system: AtlasSystem): Promise<FastifyInstance> {
  const app = Fastify({
    // ATLAS has its own structured logger; Fastify's would duplicate every line.
    logger: false,
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  installErrorHandler(app, system.logger);

  // Several actions are pure commands with no payload (`run evolution now`,
  // `acknowledge alert`, `back up`). Fastify's default parser rejects an empty
  // body when the content type says JSON, which turns a valid call into a 500 —
  // so an empty body is read as `{}` instead.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const raw = typeof body === 'string' ? body.trim() : '';
    if (raw === '') return done(null, {});
    try {
      done(null, JSON.parse(raw));
    } catch {
      done(new AtlasError('BAD_REQUEST', 'Request body is not valid JSON'), undefined);
    }
  });

  await app.register(cors, {
    origin: system.config.server.corsOrigins.length ? system.config.server.corsOrigins : false,
    credentials: true,
  });

  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });

  // Throttling runs before authentication, so an unauthenticated flood is
  // rejected without ever touching the session store.
  const limiters = installRateLimits(app, system.logger);

  installAuth(app, system, PUBLIC_PATHS);

  // Mission artifacts. Behind auth by virtue of the global hook — an artifact
  // may contain commercially sensitive analysis and must never be public.
  await app.register(fastifyStatic, {
    root: system.config.paths.artifactDir,
    prefix: '/api/artifacts/',
    decorateReply: false,
    index: false,
    list: false,
  });

  registerRoutes(app, system, limiters);
  registerRealtime(app, system);

  await registerConsole(app, system);

  // Request tracing at debug level only — production logs stay signal-rich.
  app.addHook('onResponse', async (request, reply) => {
    if (request.url.startsWith('/api/realtime')) return;
    system.logger.debug('request', {
      method: request.method,
      url: request.url,
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
    });
  });

  return app;
}

/**
 * Serves the built console when it exists, with SPA fallback.
 *
 * When it does not (development, where Vite serves it on its own port) the
 * server simply says so rather than 404-ing mysteriously.
 */
async function registerConsole(app: FastifyInstance, system: AtlasSystem): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), 'dist', 'console'),
    join(here, '..', '..', '..', 'apps', 'console', 'dist'),
  ];
  const consoleDir = candidates.find((path) => existsSync(join(path, 'index.html')));

  // Single not-found handler for the whole app: API paths get JSON, everything
  // else falls through to the console shell when one is present.
  app.setNotFoundHandler((request, reply) => {
    if (!consoleDir || request.url.startsWith('/api') || request.url.startsWith('/healthz')) {
      return reply.status(404).send({
        ok: false,
        error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}` },
      });
    }
    return reply.sendFile('index.html');
  });

  if (!consoleDir) {
    app.get('/', async (_request, reply) =>
      reply.type('text/html').send(
        `<!doctype html><meta charset="utf-8"><title>ATLAS OS</title>
         <body style="font-family:system-ui;background:#0b1020;color:#e2e8f0;padding:3rem;line-height:1.6">
         <h1>ATLAS OS is running</h1>
         <p>The API is live on this port. The console has not been built yet.</p>
         <p>Development: <code>npm run dev</code> &mdash; the console runs on
         <a style="color:#7dd3fc" href="http://localhost:5173">http://localhost:5173</a>.</p>
         <p>Production: <code>npm run build</code>, then restart.</p>
         </body>`,
      ),
    );
    system.logger.info('console bundle not found — serving API only');
    return;
  }

  // `decorateReply` is enabled here (and only here) so the SPA fallback above
  // can call `reply.sendFile`.
  await app.register(fastifyStatic, {
    root: consoleDir,
    prefix: '/',
    decorateReply: true,
    index: ['index.html'],
  });

  system.logger.info('serving console', { path: consoleDir });
}
