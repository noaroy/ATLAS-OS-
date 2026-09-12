/**
 * Le processus qui tourne.
 *
 * On le lance et on le laisse. Il prend le travail quand il y en a, dort quand
 * il n'y en a pas, reprend ce qu'un arrêt brutal avait laissé en l'air, et
 * s'arrête proprement quand on le lui demande.
 *
 * Au repos, il n'appelle rien : la file vide se traduit par un sommeil, pas par
 * une interrogation. En travail, il appelle les modèles seulement si
 * `ATLAS_AI_LIVE` est vrai ; à faux — la valeur par défaut — les fournisseurs
 * sont figés et la chaîne se déroule entièrement sans qu'un centime soit
 * dépensé. Le mode retenu est journalisé au démarrage.
 *
 *   npm run atlas:daemon
 *   npm run atlas:daemon -- --cycles=20        s'arrête après 20 tours
 *   npm run atlas:daemon -- --owner=worker-b   pour lancer deux daemons
 */
import { createLogger, loadConfig } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import {
  AtlasDaemon,
  createWorkerRegistry,
  DEMO_HANDLERS,
} from '../packages/runtime/src/index.ts';

const flag = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const num = (name: string, fallback: number) => Number(flag(name) ?? fallback);

const logger = createLogger({
  level: (flag('log') as 'debug' | 'info' | 'warn' | 'error') ?? 'info',
  pretty: true,
});
const repos = createRepositories(process.env.ATLAS_DB_PATH ?? 'data/atlas.db', logger);

const config = loadConfig(process.cwd());

// Les workers de modèle sont branchés, mais figés tant que ATLAS_AI_LIVE est
// faux — ce qui est la valeur par défaut. La fabrique journalise le mode
// retenu : un système qui se met à dépenser doit le dire en commençant.
const { registry, live } = createWorkerRegistry({
  config, logger, repos, handlers: DEMO_HANDLERS, workspaceRoot: process.cwd(),
});

const daemon = new AtlasDaemon({
  repos,
  registry,
  logger,
  leaseMs: num('lease', 30_000),
  heartbeatMs: num('heartbeat', 10_000),
  maxIdleMs: num('idle', 60_000),
  owner: flag('owner') ?? undefined,
  maxCycles: flag('cycles') ? num('cycles', 0) : undefined,
});

/**
 * L'arrêt propre.
 *
 * Un second signal ne force rien : il redit la même chose. Sortir en force
 * laisserait des baux posés que personne ne libère, et la reprise devrait
 * attendre leur expiration — plus long que de finir la tâche en cours.
 */
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) {
      logger.warn('arrêt déjà en cours : on laisse la tâche courante se terminer');
      return;
    }
    stopping = true;
    daemon.requestStop(`signal ${signal}`);
  });
}

try {
  const stats = await daemon.run();
  console.log(
    `\n  ${stats.cycles} tour(s) · ${stats.completed} terminée(s) · ${stats.failed} échec(s) · ` +
      `${stats.pausedQuota} pause(s) quota · ${stats.recovered} récupérée(s)`,
  );
  console.log(`  Aucun appel de modèle. MESSAGES SENT: 0\n`);
} finally {
  repos.close();
}
