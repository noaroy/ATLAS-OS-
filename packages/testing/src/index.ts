import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition, MissionPlanStep, SystemEvent } from '@atlas/contracts';
import type { AtlasConfig, Logger } from '@atlas/core';
import { EventBus, createLogger } from '@atlas/core';
import { createRepositories, type Repositories, type RuntimeSettings } from '@atlas/data';
import { MemoryService } from '@atlas/memory';
import { BudgetLedger, BudgetedProvider } from '@atlas/llm';
import { AgentRuntime, ToolRegistry, AGENT_DEFINITIONS, BUILDINGS, SKILL_CATALOGUE } from '@atlas/agents';
import {
  OpportunityService,
  DiscoveryService,
  RegistryDiscoveryProvider,
  SimulationDiscoveryProvider,
} from '@atlas/intelligence';
import { DEPARTMENT_DEFINITIONS } from '@atlas/departments';
import { HermesEngine } from '@atlas/hermes';
import { EvolutionEngine } from '@atlas/evolution';
import { ScriptedProvider, type ScriptedHandler } from './scripted-provider.ts';

export * from './scripted-provider.ts';

/**
 * A complete ATLAS in a temporary directory, wired the same way the server
 * wires it — real SQLite, real event bus, real orchestrator — with only the
 * model replaced by a script.
 *
 * Testing against the real composition rather than mocks is deliberate: the
 * behaviour under test (concurrency, dependency resolution, retries, state
 * transitions) lives in how these pieces fit together, so replacing them with
 * doubles would test the doubles.
 */

export interface TestSystem {
  config: AtlasConfig;
  logger: Logger;
  events: EventBus;
  repos: Repositories;
  memory: MemoryService;
  registry: ToolRegistry;
  runtime: AgentRuntime;
  hermes: HermesEngine;
  evolution: EvolutionEngine;
  intelligence: OpportunityService;
  discovery: DiscoveryService;
  provider: ScriptedProvider;
  ledger: BudgetLedger;
  /** Every event published, in order. */
  captured: SystemEvent[];
  /** Events of one type, for concise assertions. */
  eventsOfType(type: SystemEvent['type']): SystemEvent[];
  settings: RuntimeSettings;
  cleanup(): void;
}

export interface TestSystemOptions {
  handler: ScriptedHandler;
  settings?: Partial<RuntimeSettings>;
  /** Replaces the seeded roster; defaults to the eight founding specialists. */
  agents?: AgentDefinition[];
  /** Overrides for the generated config. */
  config?: Partial<AtlasConfig['orchestration']>;
  /** Runs the pipeline as if inference were simulated, for provenance tests. */
  simulated?: boolean;
  /** Runs discovery as if ATLAS were live, so the synthetic provider is refused. */
  live?: boolean;
  /** Plafonds économiques ; larges par défaut pour ne pas gêner les autres tests. */
  budget?: Partial<AtlasConfig['budget']>;
}

export function createTestSystem(options: TestSystemOptions): TestSystem {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-harness-'));
  const config = makeTestConfig(dir, options.config, options.budget);

  const logger = createLogger({ level: 'error', pretty: false });
  const events = new EventBus(logger);
  const repos = createRepositories(config.paths.databaseFile, logger);

  const captured: SystemEvent[] = [];
  events.on('*', (event) => {
    captured.push(event);
    repos.events.append(event);
  });

  // Skills first: an agent's tools are derived from what it declares.
  for (const skill of SKILL_CATALOGUE) repos.skills.ensure(skill);
  for (const department of DEPARTMENT_DEFINITIONS) repos.departments.ensure(department);
  for (const building of BUILDINGS) repos.buildings.ensure(building);
  for (const agent of options.agents ?? AGENT_DEFINITIONS) repos.agents.upsertDefinition(agent);

  const settings: RuntimeSettings = {
    maxConcurrentMissions: 3,
    maxConcurrentTasks: 4,
    taskMaxAttempts: 3,
    missionTokenBudget: 0,
    maxReplansPerMission: 1,
    evolutionEnabled: true,
    evolutionAutonomy: 'propose',
    hermesModel: 'test-hermes',
    agentModel: 'test-agent',
    llmEffort: 'low',
    memoryRetention: { operational: 0.2, strategic: 0.1, business: 0.1 },
    ...options.settings,
  };

  const memory = new MemoryService(repos.memory, events, logger);

  // Le harnais reproduit le montage de production : le provider est plafonné
  // et la comptabilité branchée. Tester une pile où le budget n'existe pas
  // prouverait surtout que les tests ne rencontrent jamais le garde-fou.
  const scripted = new ScriptedProvider(options.handler);
  const ledger = new BudgetLedger((record) => repos.llmCalls.record(record));
  const provider = new BudgetedProvider(scripted, ledger);
  const registry = new ToolRegistry();

  // Tests run against the real pipeline, not a stub of it — the guarantees
  // being tested (dedup, evidence discipline, scoring arithmetic) live in it.
  const intelligence = new OpportunityService({
    repos,
    memory,
    events,
    logger,
    simulated: options.simulated ?? false,
  });

  const discovery = new DiscoveryService(
    [new RegistryDiscoveryProvider(repos), new SimulationDiscoveryProvider()],
    { live: options.simulated === false && options.live === true, logger },
  );

  const runtime = new AgentRuntime({
    provider,
    registry,
    repos,
    memory,
    events,
    config,
    logger,
    automation: null,
    intelligence,
    discovery,
    resolveModel: () => ({ agentModel: settings.agentModel, effort: settings.llmEffort }),
  });

  const hermes = new HermesEngine({
    repos,
    events,
    memory,
    provider,
    runtime,
    config,
    logger,
    settings: () => settings,
    intelligence,
    ledger,
  });

  const evolution = new EvolutionEngine({
    repos,
    events,
    memory,
    logger,
    settings: () => settings,
    provider,
    maxTokens: config.llm.maxTokens,
  });

  return {
    config,
    logger,
    events,
    repos,
    intelligence,
    discovery,
    memory,
    registry,
    runtime,
    hermes,
    evolution,
    provider: scripted,
    ledger,
    captured,
    eventsOfType: (type) => captured.filter((e) => e.type === type),
    settings,
    cleanup() {
      repos.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A config built in memory rather than loaded from the environment, so tests
 * never depend on a developer's `.env`.
 */
export function makeTestConfig(
  dir: string,
  orchestration: Partial<AtlasConfig['orchestration']> = {},
  budget: Partial<AtlasConfig['budget']> = {},
): AtlasConfig {
  return {
    env: 'test',
    isProduction: false,
    server: { host: '127.0.0.1', port: 0, publicUrl: 'http://localhost', corsOrigins: [] },
    security: {
      sessionSecret: 'test-secret-value-long-enough',
      founderEmail: 'founder@test.local',
      founderPassword: 'test-password',
    },
    paths: {
      dataDir: dir,
      databaseFile: join(dir, 'atlas.db'),
      backupDir: join(dir, 'backups'),
      artifactDir: join(dir, 'artifacts'),
    },
    backup: { retention: 3 },
    llm: {
      apiKey: '',
      mode: 'simulation',
      declaredMode: 'simulation',
      forbiddenModels: [],
      allowedModels: [],
      hermesModel: 'test-hermes',
      agentModel: 'test-agent',
      effort: 'low',
      maxTokens: 4096,
    },
    // Plafonds larges par défaut : un test qui ne parle pas de budget ne doit
    // pas se faire refuser un appel. Les tests de budget passent les leurs.
    budget: {
      maxMissionTokens: 0,
      maxMissionCostUsd: 0,
      maxStepTokens: 0,
      maxCallsPerStep: 0,
      maxOutputTokensPerCall: 0,
      circuitBreakerFailures: 0,
      minViableOutputTokens: 0,
      ...budget,
    },
    search: {
      // Aucun moteur réel en test : les providers sont scriptés.
      provider: 'none',
      searxngBaseUrl: '',
      searxngEngines: '',
      braveApiKey: '',
      costPerQueryUsd: 0.005,
      fallbackEnabled: false,
      timeoutMs: 5_000,
      resultsPerQuery: 10,
      maxCandidates: 6,
      maxCharsPerPage: 6_000,
      discoveryMaxContextTokens: 40_000,
    },
    web: {
      maxSearchesPerDiscovery: 6,
      maxFetchesPerCandidate: 2,
      maxTotalFetchesPerMission: 20,
    },
    orchestration: {
      maxConcurrentMissions: 3,
      maxConcurrentTasks: 4,
      toolTimeoutMs: 5_000,
      providerTimeoutMs: 5_000,
      missionTimeoutMs: 0,
      // Short by default so a timeout test does not take five minutes.
      taskTimeoutMs: 2000,
      taskMaxAttempts: 3,
      missionTokenBudget: 0,
      maxReplansPerMission: 1,
      ...orchestration,
    },
    n8n: { enabled: false, baseUrl: '', apiKey: '', webhookSecret: '' },
    evolution: { enabled: true, autonomy: 'propose' },
    runtime: { heartbeatMs: 60_000 },
    log: { level: 'error', pretty: false },
  };
}

/** Builds a plan payload of the shape the planner's schema demands. */
export function plan(steps: Array<Partial<MissionPlanStep> & { agentKey: string }>): unknown {
  return {
    summary: 'Test plan',
    rationale: 'Constructed by the test harness',
    strategy: 'Execute the scripted steps',
    steps: steps.map((step, index) => ({
      ref: step.ref ?? `s${index + 1}`,
      title: step.title ?? `Step ${index + 1}`,
      agentKey: step.agentKey,
      action: step.action ?? 'research',
      instruction: step.instruction ?? 'Do the thing.',
      expectedOutput: step.expectedOutput ?? 'A result.',
      dependsOn: step.dependsOn ?? [],
    })),
  };
}

/** Resolves once `predicate` holds, or throws after `timeoutMs`. */
export async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 5000, label = 'condition' }: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

/** A minimal agent definition, for tests that need a bespoke roster. */
export function testAgent(overrides: Partial<AgentDefinition> & { key: string }): AgentDefinition {
  return {
    name: overrides.key,
    role: 'test specialist',
    tier: 'business',
    building: 'research-tower',
    mission: 'Do exactly what the test asks.',
    skills: [],
    actions: ['research'],
    mandates: ['mission-execution'],
    systemPrompt: 'You are a test agent.',
    model: null,
    maxSteps: 4,
    appearance: { hue: 200, accent: '#fff', silhouette: 'scout', emblem: '◆' },
    enabled: true,
    ...overrides,
  };
}
