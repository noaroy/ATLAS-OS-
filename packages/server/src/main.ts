import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ATLAS_VERSION } from '@atlas/contracts';
import { loadConfig, bootLogger, describeError } from '@atlas/core';
import { createSystem } from './bootstrap.ts';
import { createApp } from './app.ts';

/**
 * Process entry point.
 *
 * Boot order matters: storage and services first, then recovery of interrupted
 * work, then the supervisor, and only then the HTTP surface — so the console
 * never observes a half-initialised system.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const system = createSystem(config, { daemon: true });
  const log = system.logger;

  log.info(`ATLAS OS ${ATLAS_VERSION} starting`, {
    env: config.env,
    mode: config.llm.mode,
    dataDir: config.paths.dataDir,
  });

  system.events.publish({
    type: 'system.boot',
    severity: 'info',
    source: 'system',
    message: `ATLAS OS ${ATLAS_VERSION} is starting`,
    payload: { version: ATLAS_VERSION, mode: config.llm.mode, env: config.env },
  });

  // Resume anything the last process left mid-flight (SRS §6.10).
  const resumed = system.hermes.recover();
  if (resumed > 0) log.info('resumed interrupted missions', { count: resumed });

  system.supervisor.start();

  const app = await createApp(system);
  await app.listen({ host: config.server.host, port: config.server.port });

  // Le fichier de pid : ce que `npm run atlas:stop` et `atlas:status` lisent
  // pour trouver le processus sans deviner. Écrit après l'écoute, jamais avant.
  const pidFile = join(config.paths.dataDir, 'atlas.pid');
  try {
    mkdirSync(config.paths.dataDir, { recursive: true });
    writeFileSync(pidFile, String(process.pid), 'utf8');
  } catch (err) {
    log.warn('pid file not written', { error: describeError(err) });
  }

  log.info('ATLAS OS is ready', {
    url: `http://${config.server.host === '0.0.0.0' ? 'localhost' : config.server.host}:${config.server.port}`,
    agents: system.repos.agents.listDefinitions(true).length,
    missionsResumed: resumed,
    salesEngine: system.daemon ? 'embarqué' : 'coupé',
    outbound: config.sales.outboundEnabled ? 'ACTIVE' : 'PAUSED',
    engineMode: config.sales.engineMode,
  });

  system.events.publish({
    type: 'system.ready',
    severity: 'success',
    source: 'system',
    message: 'ATLAS OS is online and accepting missions',
    payload: { port: config.server.port, resumed },
  });

  // ── Graceful shutdown ───────────────────────────────────────────────────
  let closing = false;
  const stop = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;

    log.info('signal received', { signal });
    // Stop accepting connections first so nothing new starts mid-teardown.
    await app.close().catch((err) => log.warn('http close failed', { error: describeError(err) }));
    await system.shutdown(signal);
    try {
      rmSync(pidFile, { force: true });
    } catch {
      /* un pid périmé se détecte au prochain démarrage */
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  // A crash must be recorded and must exit non-zero, so the process manager
  // restarts a genuinely broken process rather than leaving it wedged.
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', { error: err.message, stack: err.stack });
    system.repos.ops.raiseAlert({
      level: 'critical',
      title: 'Uncaught exception',
      detail: err.message,
      source: 'process',
    });
    void system.shutdown('uncaughtException').finally(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { reason: describeError(reason) });
    system.repos.ops.raiseAlert({
      level: 'error',
      title: 'Unhandled promise rejection',
      detail: describeError(reason),
      source: 'process',
    });
  });
}

main().catch((err) => {
  bootLogger.error('ATLAS OS failed to start', {
    error: err instanceof Error ? err.message : String(err),
  });
  if (err instanceof Error && err.stack) bootLogger.debug(err.stack);
  process.exit(1);
});
