import type { RuntimeSettings } from '@atlas/data';
import { createRepositories, type Repositories } from '@atlas/data';
import type { AtlasConfig, Logger } from '@atlas/core';
import { EventBus, createLogger, describeError } from '@atlas/core';
import { MemoryService } from '@atlas/memory';
import { BudgetLedger, BudgetedProvider, createLlmProvider, type LlmProvider } from '@atlas/llm';
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
  BraveSearchProvider,
  SearxngSearchProvider,
  type DiscoveryProvider,
  SimulationDiscoveryProvider,
} from '@atlas/intelligence';
import { DEPARTMENT_DEFINITIONS } from '@atlas/departments';
import { RuntimeSupervisor, VillageService, runBackup } from '@atlas/runtime';

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
  settings(): RuntimeSettings;
  shutdown(reason: string): Promise<void>;
}

export function createSystem(config: AtlasConfig): AtlasSystem {
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

  const memory = new MemoryService(repos.memory, events, logger);

  // ─── Sûreté économique ──────────────────────────────────────────────────
  // Le registre est branché une seule fois, ici, et le provider brut n'est
  // plus exposé au reste du système : agents, planificateur, extraction de
  // brief et recherche web reçoivent tous la version plafonnée. C'est ce qui
  // rend le budget incontournable plutôt que consultable — la distinction qui
  // a coûté 9,15 $ lors de LIVE #001.
  const ledger = new BudgetLedger((record) => repos.llmCalls.record(record));
  const provider = new BudgetedProvider(createLlmProvider(config, logger), ledger);
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
  const discoveryProviders: DiscoveryProvider[] = [new RegistryDiscoveryProvider(repos)];

  // Le moteur est choisi par configuration ; le pipeline qui l'entoure est le
  // même quel qu'il soit. C'est tout l'intérêt de l'abstraction : passer de
  // SearXNG à Brave ne touche pas une ligne de Business Expansion.
  const engine =
    config.search.provider === 'searxng'
      ? new SearxngSearchProvider({
          baseUrl: config.search.searxngBaseUrl,
          engines: config.search.searxngEngines,
        })
      : config.search.provider === 'brave'
        ? new BraveSearchProvider({
            apiKey: config.search.braveApiKey,
            costPerQueryUsd: config.search.costPerQueryUsd,
          })
        : null;

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
  });

  seed(repos, config, logger);
  validateDepartments(repos, logger);

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
  for (const building of BUILDINGS) {
    if (repos.buildings.ensure(building)) createdBuildings++;
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

  if (createdSkills || createdDepartments || refreshedDepartments || createdBuildings || createdAgents || renamedAgents || reset) {
    logger.info('village seeded', { skills: createdSkills, departments: createdDepartments, departmentsRefreshed: refreshedDepartments, agentsRenamed: renamedAgents, buildings: createdBuildings, agents: createdAgents, statesReset: reset });
  }
}
