import type { RuntimeSettings } from '@atlas/data';
import { createRepositories, type Repositories } from '@atlas/data';
import type { AtlasConfig, Logger } from '@atlas/core';
import { EventBus, createLogger, describeError } from '@atlas/core';
import { MemoryService } from '@atlas/memory';
import { BudgetLedger, BudgetedProvider, createInferenceFabric, InferenceFabric, type LlmProvider } from '@atlas/llm';
import {
  AgentRuntime,
  ToolRegistry,
  AGENT_DEFINITIONS,
  BUILDINGS,
  SKILL_CATALOGUE,
  ALL_TOOLS,
  danglingSkills,
} from '@atlas/agents';
import { HermesEngine } from '@atlas/hermes';
import { AutomationService } from '@atlas/automation';
import { EvolutionEngine } from '@atlas/evolution';
import {
  OpportunityService,
  DiscoveryService,
  RegistryDiscoveryProvider,
  WebSearchDiscoveryProvider,
  PipelineDiscoveryProvider,
  createSearchFabric,
  SearchFabric,
  type DiscoveryProvider,
  SimulationDiscoveryProvider,
} from '@atlas/intelligence';
import { DEPARTMENT_DEFINITIONS } from '@atlas/departments';
import {
  RuntimeSupervisor,
  VillageService,
  runBackup,
  recoverInterruptedMissions,
  AtlasDaemon,
  serverWorkerTypes,
  createWorkerRegistry,
  createSalesEngineHandlers,
  scheduleSalesCycle,
  createAutopilotHandlers,
  scheduleAutopilotCycle,
  DEMO_HANDLERS,
  type RecoveryReport,
} from '@atlas/runtime';

/**
 * The assembled system.
 *
 * Every dependency is constructed exactly once, here, and passed explicitly.
 * There are no module-level singletons and no service locator, which is what
 * makes each package independently testable and replaceable (SRS §2.2).
 */
export interface AtlasSystem {
  config: AtlasConfig;
  logger: Logger;
  events: EventBus;
  repos: Repositories;
  memory: MemoryService;
  provider: LlmProvider;
  registry: ToolRegistry;
  hermes: HermesEngine;
  automation: AutomationService;
  evolution: EvolutionEngine;
  intelligence: OpportunityService;
  discovery: DiscoveryService;
  village: VillageService;
  supervisor: RuntimeSupervisor;
  /**
   * Le parc de moteurs réellement en service.
   *
   * Exposé pour que le cockpit lise l'état *vivant* — disjoncteurs ouverts,
   * refroidissements, métriques accumulées. Reconstruire un registre neuf à
   * l'affichage rendrait « inconnu » partout et laisserait croire qu'aucun
   * appel n'a jamais eu lieu.
   */
  searchFabric: SearchFabric | null;
  /**
   * Le parc de fournisseurs d'inférence réellement en service.
   *
   * Exposé pour la même raison que le parc de moteurs : le cockpit doit lire
   * l'état vivant — disjoncteurs, crédit épuisé, métriques accumulées — plutôt
   * qu'un registre neuf qui afficherait « inconnu » partout.
   */
  inferenceFabric: InferenceFabric;
  /**
   * Ce que le démarrage a trouvé en l'air, et remis en pause.
   *
   * Exposé plutôt que journalisé seulement : une mission interrompue qui a déjà
   * dépensé mérite d'être vue dans le cockpit, pas seulement dans un fichier de
   * journal que personne ne relit après un redémarrage.
   */
  recovery: RecoveryReport;
  /**
   * Le runtime d'agent, et le registre budgétaire qui le borne.
   *
   * Exposés pour les missions au plan fixe — une reprise, un sauvetage — qui
   * doivent exécuter des étapes précises sans passer par la planification
   * d'Hermès, laquelle coûte un appel au modèle avant même de commencer.
   */
  runtime: AgentRuntime;
  ledger: BudgetLedger;
  /**
   * Le daemon embarqué : le même `AtlasDaemon` que `npm run atlas:daemon`,
   * avec les workers du moteur commercial enregistrés. Un seul processus sur
   * le serveur, un seul service à surveiller. `null` quand le moteur est coupé.
   */
  daemon: AtlasDaemon | null;
  settings(): RuntimeSettings;
  shutdown(reason: string): Promise<void>;
}

export interface CreateSystemOptions {
  /**
   * Embarquer le daemon et la cadence commerciale. Vrai pour le serveur, faux
   * pour tous les scripts : une commande ponctuelle qui construit le système
   * ne doit pas se mettre à prendre des tâches ni à poser des cycles.
   */
  daemon?: boolean;
}

export function createSystem(config: AtlasConfig, options: CreateSystemOptions = {}): AtlasSystem {
  const logger = createLogger({
    level: config.log.level,
    pretty: config.log.pretty,
    bindings: { scope: 'atlas' },
  });

  const events = new EventBus(logger);
  const repos = createRepositories(config.paths.databaseFile, logger);

  // Persist every event as it is published, so the durable log and the live
  // stream can never disagree about what happened.
  events.on('*', (event) => {
    try {
      repos.events.append(event);
    } catch (err) {
      logger.error('could not persist event', { type: event.type, error: describeError(err) });
    }
  });

  const defaults: RuntimeSettings = {
    maxConcurrentMissions: config.orchestration.maxConcurrentMissions,
    maxConcurrentTasks: config.orchestration.maxConcurrentTasks,
    taskMaxAttempts: config.orchestration.taskMaxAttempts,
    missionTokenBudget: config.orchestration.missionTokenBudget,
    maxReplansPerMission: config.orchestration.maxReplansPerMission,
    evolutionEnabled: config.evolution.enabled,
    evolutionAutonomy: config.evolution.autonomy,
    hermesModel: config.llm.hermesModel,
    agentModel: config.llm.agentModel,
    llmEffort: config.llm.effort,
    memoryRetention: { operational: 0.2, strategic: 0.1, business: 0.1 },
  };
  const settings = () => repos.settings.runtime(defaults);

  // La mémoire reçoit le mode : en réel, elle ne rend au raisonnement que des
  // connaissances de lignée établie. Sans cela, une leçon écrite pendant une
  // démonstration entre dans le prompt d'une mission réelle et y devient une
  // prémisse — la mémoire est relue avant toute recherche.
  const memory = new MemoryService(repos.memory, events, logger, config.llm.mode);

  // ─── Sûreté économique ──────────────────────────────────────────────────
  // Le registre est branché une seule fois, ici, et le provider brut n'est
  // plus exposé au reste du système : agents, planificateur, extraction de
  // brief et recherche web reçoivent tous la version plafonnée. C'est ce qui
  // rend le budget incontournable plutôt que consultable — la distinction qui
  // a coûté 9,15 $ lors de LIVE #001.
  const ledger = new BudgetLedger((record) => repos.llmCalls.record(record));
  // La politique de modèles voyage avec le budget, sous les appels. Un plafond
  // de dépense ne sert à rien si un modèle dix-huit fois plus cher peut être
  // choisi trois lignes plus loin — par un réglage de console, une variable
  // d'environnement, ou le `model` propre à un agent.
  // L'inférence est un parc, derrière le contrat d'un fournisseur unique.
  // VAL-001 est morte à sa première étape parce que le compte Anthropic était
  // vide et qu'aucun repli n'existait — il n'existait qu'un fournisseur. Un
  // système censé tourner 24 h/24 ne peut pas tenir à un seul compte.
  //
  // Le budget et la politique de modèles restent *au-dessus* : ils décident si
  // l'appel a le droit de partir, le Fabric décide seulement qui le sert.
  const inference = createInferenceFabric(config, logger);
  const provider = new BudgetedProvider(inference, ledger, {
    allowed: config.llm.allowedModels,
    forbidden: config.llm.forbiddenModels,
  });

  logger.info('politique de modèles', {
    allowed: config.llm.allowedModels.join(', ') || '(tous, hors interdits)',
    forbidden: config.llm.forbiddenModels.join(', ') || '(aucun)',
  });
  const registry = new ToolRegistry();
  const automation = new AutomationService({ repos, events, config, logger });

  // The opportunity pipeline. It is told whether inference is simulated once,
  // here, so no agent can decide for itself that its output counts as real data.
  const intelligence = new OpportunityService({
    repos,
    memory,
    events,
    logger,
    simulated: config.llm.mode === 'simulation',
  });

  // ─── Découverte ─────────────────────────────────────────────────────────
  // Les providers sont ordonnés du moins cher au plus cher : la mémoire
  // d'ATLAS répond gratuitement avant qu'une recherche payante ne démarre.
  // Le service écarte lui-même le provider fabriqué dès qu'ATLAS tourne en réel.
  //
  // Le moteur de recherche n'est plus un modèle. `search-pipeline` enchaîne
  // requêtes courtes → moteur → filtrage déterministe → pages ciblées →
  // analyse. L'ancienne recherche par LLM reste disponible, mais seulement si
  // le déploiement la demande explicitement : un repli silencieux vers elle
  // coûterait cent fois le prix d'une requête moteur.
  // Le registre reçoit le mode : en réel, il n'a le droit de rendre que des
  // fiches de lignée établie. Sans cela, une entreprise fabriquée pendant une
  // démonstration ressort comme candidat d'une mission réelle — c'est ce qui
  // s'est produit avec quatre d'entre elles lors de VAL-003.
  const discoveryProviders: DiscoveryProvider[] = [
    new RegistryDiscoveryProvider(repos, config.llm.mode),
  ];

  // Le moteur est un parc, derrière le contrat d'un moteur unique. Business
  // Expansion ne sait pas que la bascule existe : il reçoit un `SearchProvider`
  // comme avant, et c'est le Fabric qui décide lequel des moteurs enregistrés
  // répond, qui disjoncte celui qui bride, et qui cadence les requêtes.
  //
  // C'est ce qui retire le point de défaillance unique : « attendre que
  // DuckDuckGo relâche » n'est plus une stratégie, c'est un cas de bascule.
  const engine = createSearchFabric(config.search);

  if (engine) {
    const plan = engine.plan();
    logger.info('search fabric', {
      mode: config.search.provider,
      enregistrés: engine.statuses().length,
      utilisables: plan.order.map((c) => c.record.id),
      écartés: plan.considered
        .filter((c) => c.excluded !== null)
        .map((c) => `${c.record.id} (${c.excluded})`),
    });
  }

  if (engine) {
    discoveryProviders.push(
      new PipelineDiscoveryProvider(
        engine,
        provider,
        {
          model: config.llm.agentModel,
          maxTokens: config.llm.maxTokens,
          maxQueries: config.web.maxSearchesPerDiscovery,
          resultsPerQuery: config.search.resultsPerQuery,
          maxCandidates: config.search.maxCandidates,
          maxFetchesPerCandidate: config.web.maxFetchesPerCandidate,
          maxCharsPerPage: config.search.maxCharsPerPage,
          searchTimeoutMs: config.search.timeoutMs,
          fetchTimeoutMs: config.search.timeoutMs,
        },
      ),
    );
  }

  // Recherche par modèle : uniquement sur demande, ou en repli explicitement
  // autorisé. Jamais par défaut — c'est la leçon de LIVE #005.
  if (config.search.provider === 'anthropic' || config.search.fallbackEnabled) {
    discoveryProviders.push(
      new WebSearchDiscoveryProvider(provider, {
        model: config.llm.agentModel,
        maxTokens: config.llm.maxTokens,
      }),
    );
  }

  discoveryProviders.push(new SimulationDiscoveryProvider());

  logger.info('discovery configured', {
    searchProvider: config.search.provider,
    // L'URL, jamais une clé : SearXNG n'en a pas, et celle de Brave ne doit
    // apparaître nulle part.
    engine: engine ? engine.label : 'aucun',
    fallbackEnabled: config.search.fallbackEnabled,
    providers: discoveryProviders.map((p) => p.key).join(', '),
  });

  const discovery = new DiscoveryService(
    discoveryProviders,
    { live: config.llm.mode === 'live', logger },
  );

  const runtime = new AgentRuntime({
    provider,
    registry,
    repos,
    memory,
    events,
    config,
    logger,
    automation,
    intelligence,
    discovery,
    resolveModel: () => {
      const current = settings();
      return { agentModel: current.agentModel, effort: current.llmEffort };
    },
  });

  const hermes = new HermesEngine({
    repos,
    events,
    memory,
    provider,
    runtime,
    config,
    logger,
    settings,
    intelligence,
    ledger,
  });
  const evolution = new EvolutionEngine({
    repos,
    events,
    memory,
    logger,
    settings,
    provider,
    maxTokens: config.llm.maxTokens,
  });
  const village = new VillageService(repos, events);

  // Le moteur commercial : ses workers dans le daemon embarqué, sa cadence
  // dans le superviseur. Les deux se coupent d'un seul réglage.
  const salesEnabled = config.sales.engineEnabled && options.daemon === true;
  const salesHandlers = createSalesEngineHandlers({ repos, config, logger, sourceRoot: process.cwd() });
  // L'Autopilot : un cycle est une tâche déterministe ; son cadencement ne
  // s'active que par ATLAS_AUTOPILOT_ENABLED, dans le même daemon embarqué.
  const autopilotHandlers = createAutopilotHandlers({ repos, config, logger, cwd: process.cwd() });
  const autopilotEnabled = config.autopilot.enabled && options.daemon === true;
  const workers = createWorkerRegistry({
    config, logger, repos, handlers: { ...DEMO_HANDLERS, ...salesHandlers, ...autopilotHandlers }, workspaceRoot: process.cwd(),
  });
  // Hermes avance les chaînes (une revue qui demande une correction en crée
  // la tâche) ; en ingénierie externe, CLAUDE / CLAUDE_CODE restent en file
  // pour le service atlas-engineer, seul à porter git et le binaire.
  const daemon = salesEnabled || autopilotEnabled
    ? new AtlasDaemon({
      repos, registry: workers.registry, logger, hermes: workers.hermes,
      workerTypes: serverWorkerTypes(config.engineering.runner),
      owner: `atlas-server#${process.pid}`,
    })
    : null;

  const supervisor = new RuntimeSupervisor({
    repos,
    events,
    config,
    logger,
    hermes,
    automation,
    evolution,
    memory,
    village,
    settings,
    salesScheduler: salesEnabled ? (now) => scheduleSalesCycle(repos, config, now) : undefined,
    autopilotScheduler: autopilotEnabled ? (now) => scheduleAutopilotCycle(repos, config, now) : undefined,
  });

  seed(repos, config, logger);
  validateDepartments(repos, logger);

  // Un arrêt brutal laisse des missions `running` que plus rien ne fera
  // avancer. Elles repassent en pause ici, avant que quoi que ce soit ne
  // démarre — et elles y restent : reprendre une mission réelle est une
  // décision humaine, jamais un effet de bord du redémarrage.
  const recovery = recoverInterruptedMissions(repos, logger);

  // Le daemon démarre avec le système : sa promesse est gardée pour l'arrêt.
  const daemonRun: Promise<unknown> = daemon
    ? daemon.run().catch((err) => logger.error('daemon embarqué arrêté sur erreur', { error: describeError(err) }))
    : Promise.resolve();

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('shutting down', { reason });
    events.publish({
      type: 'system.shutdown',
      severity: 'warning',
      source: 'system',
      message: `ATLAS is shutting down: ${reason}`,
      payload: { reason },
    });

    await supervisor.stop();
    if (daemon) {
      daemon.requestStop(reason);
      // Le tour en cours se termine ; au-delà, le bail expirera et la tâche
      // sera reprise au prochain démarrage — c'est correct, rien n'est consigné.
      await Promise.race([daemonRun, new Promise((resolve) => setTimeout(resolve, 15_000).unref?.())]);
    }
    await hermes.shutdown();
    await events.drain(5000);

    // A final backup means the last running state is always recoverable.
    try {
      runBackup(repos, config, logger, 'shutdown');
    } catch (err) {
      logger.warn('shutdown backup failed', { error: describeError(err) });
    }

    repos.close();
    logger.info('shutdown complete');
  };

  return {
    config,
    logger,
    events,
    repos,
    memory,
    provider,
    registry,
    hermes,
    automation,
    evolution,
    intelligence,
    discovery,
    village,
    supervisor,
    searchFabric: engine,
    inferenceFabric: inference,
    recovery,
    runtime,
    ledger,
    daemon,
    settings,
    shutdown,
  };
}

/**
 * Checks that each department's method can actually be run.
 *
 * A playbook naming a missing agent, or a skill its agent does not hold, is a
 * broken product — and it must be visible at boot rather than discovered
 * halfway through a founder's first mission.
 */
function validateDepartments(repos: Repositories, logger: Logger): void {
  for (const department of repos.departments.list(true)) {
    const problems: string[] = [];

    for (const stage of department.playbook) {
      const agent = repos.agents.getDefinition(stage.agentKey);
      if (!agent) {
        problems.push(`stage '${stage.ref}' needs agent '${stage.agentKey}', which does not exist`);
        continue;
      }
      if (!agent.enabled) problems.push(`stage '${stage.ref}' needs '${agent.key}', which is disabled`);

      const missing = stage.requiredSkills.filter((skill) => !agent.skills.includes(skill));
      if (missing.length > 0) {
        problems.push(`stage '${stage.ref}': ${agent.name} lacks ${missing.join(', ')}`);
      }
    }

    if (problems.length > 0) {
      logger.warn('department cannot run its own method', {
        department: department.key,
        problems,
      });
      repos.ops.raiseAlertOnce({
        level: 'error',
        title: `${department.name} cannot run`,
        detail: problems.join('; '),
        source: 'bootstrap',
      });
    } else {
      logger.info('department ready', {
        department: department.key,
        stages: department.playbook.length,
        teams: department.teams.length,
      });
    }
  }
}

/**
 * Idempotent first-boot seeding.
 *
 * Everything here uses `ensure*` semantics: the founder's edits, and any
 * guidance the evolution loop has appended to an agent, survive every restart.
 */
function seed(repos: Repositories, config: AtlasConfig, logger: Logger): void {
  // Skills come first: an agent's tools are derived from the skills it
  // declares, so the catalogue must exist before any agent is read back.
  let createdSkills = 0;
  for (const skill of SKILL_CATALOGUE) {
    if (repos.skills.ensure(skill)) createdSkills++;
  }

  // A skill promising a tool the registry does not have would silently grant
  // nothing, so say so loudly rather than debug it later through an agent.
  const dangling = danglingSkills(repos.skills.list(false), ALL_TOOLS.map((t) => t.name));
  if (dangling.length > 0) {
    logger.warn('skills reference unknown tools', { skills: dangling });
  }

  // Departments are seeded after skills and before the roster is read back:
  // a playbook stage names the skills its agent must hold, and that check is
  // only meaningful once both exist.
  let createdDepartments = 0;
  let refreshedDepartments = 0;
  for (const department of DEPARTMENT_DEFINITIONS) {
    if (repos.departments.ensure(department)) createdDepartments++;
    // A department already in the database keeps its in-service flag but takes
    // the method this release ships: running last release's playbook would be a
    // silent regression nobody would think to look for.
    else if (repos.departments.syncDefinition(department)) refreshedDepartments++;
  }

  let createdBuildings = 0;
  let remappedBuildings = 0;
  for (const building of BUILDINGS) {
    // Créer ce qui manque, réaligner le reste. Le plan de la ville appartient
    // au code ; le niveau et l'activité appartiennent au travail accompli, et
    // `syncLayout` ne touche pas à ceux-là.
    if (repos.buildings.ensure(building)) createdBuildings++;
    else if (repos.buildings.syncLayout(building)) remappedBuildings++;
  }

  let createdAgents = 0;
  let renamedAgents = 0;
  for (const agent of AGENT_DEFINITIONS) {
    if (repos.agents.ensureDefinition(agent)) createdAgents++;
    // Only the identity the founder sees; the prompt stays as evolution left it.
    else if (repos.agents.syncPresentation(agent)) renamedAgents++;
  }

  // An unclean stop can leave agents marked as working; nothing is running yet.
  const reset = repos.agents.resetAllStates();

  if (repos.users.count() === 0) {
    repos.users.create({
      email: config.security.founderEmail,
      name: 'Founder',
      role: 'founder',
      password: config.security.founderPassword,
    });
    logger.info('founder account created', { email: config.security.founderEmail });

    // Le compte est créé quoi qu'il arrive — refuser de démarrer laisserait un
    // ATLAS inaccessible et sans moyen de se réparer. Mais un mot de passe
    // d'exemple est public : on dit où le remplacer, plutôt que quoi éditer.
    if (config.security.founderPassword === 'atlas-founder' || config.security.founderPassword === 'change-me') {
      logger.warn('le compte fondateur utilise un mot de passe d’exemple, connu publiquement', {
        action: 'npm run founder:reset',
      });
    }
  }

  if (createdSkills || createdDepartments || refreshedDepartments || createdBuildings || remappedBuildings || createdAgents || renamedAgents || reset) {
    logger.info('village seeded', { skills: createdSkills, departments: createdDepartments, departmentsRefreshed: refreshedDepartments, agentsRenamed: renamedAgents, buildings: createdBuildings, buildingsRemapped: remappedBuildings, agents: createdAgents, statesReset: reset });
  }
}
