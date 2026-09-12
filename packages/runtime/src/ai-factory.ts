import type { AtlasConfig, Logger } from '@atlas/core';
import { FixtureAiProvider, OpenAiProvider, AnthropicAiProvider, type AiProvider } from '@atlas/llm';
import type { Repositories } from '@atlas/data';
import { OpenAiWorker, ClaudeWorker } from './ai-workers.ts';
import { ClaudeCodeWorker } from './claude-code.ts';
import { WorkerRegistry, DeterministicWorker, HumanWorker } from './workers.ts';
import { HermesRouter, type ChainLimits } from './hermes-router.ts';
import type { WorkerContext, WorkerOutcome } from './workers.ts';
import type { TaskRow } from '@atlas/data';

/**
 * Choisir les fournisseurs, et dire lequel on a choisi.
 *
 * Le point de bascule du système entier tient en une ligne de configuration.
 * `ATLAS_AI_LIVE=false` — la valeur par défaut — donne des fournisseurs figés :
 * la chaîne se déroule entièrement, rien n'est facturé. À vrai, chaque tâche
 * dépense.
 *
 * La bascule est journalisée à chaque construction. Un système qui se met à
 * dépenser doit le dire au moment où il commence, pas dans un relevé quelques
 * jours plus tard.
 */

export interface AiFactoryOptions {
  config: AtlasConfig;
  logger: Logger;
  repos: Repositories;
  /** Réponses figées, quand on veut piloter un scénario précis. */
  fixtures?: { openai?: ConstructorParameters<typeof FixtureAiProvider>[2];
               anthropic?: ConstructorParameters<typeof FixtureAiProvider>[2] };
  /** Traitements déterministes à enregistrer en plus. */
  handlers?: Record<string, (task: TaskRow, context: WorkerContext) => Promise<WorkerOutcome>>;
  workspaceRoot?: string;
}

const PLACEHOLDER_REPLY = [{
  body: {
    status: 'NEEDS_HUMAN',
    summary: 'fournisseur figé : aucun appel réel n’a été effectué',
    confidence: 0,
    findings: [],
    recommendations: [],
    next_tasks: [],
    artifacts: [],
  },
}];

export function createAiProviders(options: AiFactoryOptions): {
  openai: AiProvider;
  anthropic: AiProvider;
  live: boolean;
} {
  const { config, logger } = options;

  if (!config.ai.live) {
    logger.info('workers IA en mode figé : aucun appel payant', {
      openaiModel: config.ai.openaiModel,
      anthropicModel: config.ai.anthropicModel,
      reason: 'ATLAS_AI_LIVE=false',
    });
    return {
      openai: new FixtureAiProvider('OPENAI', config.ai.openaiModel,
        options.fixtures?.openai ?? PLACEHOLDER_REPLY),
      anthropic: new FixtureAiProvider('ANTHROPIC', config.ai.anthropicModel,
        options.fixtures?.anthropic ?? PLACEHOLDER_REPLY),
      live: false,
    };
  }

  // Le modèle retenu est journalisé, y compris quand il vient d'une valeur par
  // défaut : un modèle changé en silence ferait varier coût et qualité sans
  // qu'aucune décision n'ait été prise.
  logger.warn('workers IA en mode réel : les appels seront facturés', {
    openaiModel: config.ai.openaiReviewModel,
    anthropicModel: config.ai.anthropicEngineeringModel,
  });

  return {
    openai: new OpenAiProvider(
      config.ai.openaiReviewModel,
      process.env.ATLAS_OPENAI_API_KEY ?? '',
    ),
    anthropic: new AnthropicAiProvider(
      config.ai.anthropicEngineeringModel,
      process.env.ANTHROPIC_API_KEY ?? '',
    ),
    live: true,
  };
}

/** L'annuaire complet : déterministe, les deux modèles, et l'humain. */
export function createWorkerRegistry(options: AiFactoryOptions): {
  registry: WorkerRegistry;
  hermes: HermesRouter;
  live: boolean;
} {
  const { config, logger, repos } = options;
  const providers = createAiProviders(options);

  const registry = new WorkerRegistry()
    .register(new DeterministicWorker(options.handlers ?? {}))
    .register(new OpenAiWorker({
      repos,
      provider: providers.openai,
      timeoutMs: config.ai.openaiTimeoutMs,
    }))
    .register(new ClaudeWorker({
      repos,
      provider: providers.anthropic,
      timeoutMs: config.ai.claudeTimeoutMs,
      workspaceRoot: options.workspaceRoot ?? process.cwd(),
      worktreeRoot: config.engineering.workspaceRoot || undefined,
      maxIterations: config.engineering.maxIterations,
      maxFilesChanged: config.engineering.maxFilesChanged,
      maxDiffLines: config.engineering.maxDiffLines,
      allowFileDelete: config.engineering.allowFileDelete,
    }))
    // Claude Code : l'agent qui edite lui-meme. Enregistre meme quand le
    // binaire est absent — il rapporte alors une piece manquante du poste de
    // travail plutot qu'un echec de tache.
    .register(new ClaudeCodeWorker({
      repos,
      logger,
      repoRoot: options.workspaceRoot ?? process.cwd(),
      worktreeRoot: config.engineering.workspaceRoot || undefined,
      timeoutMs: config.engineering.claudeCodeTimeoutMs,
      maxFilesChanged: config.engineering.maxFilesChanged,
      maxDiffLines: config.engineering.maxDiffLines,
      binary: config.engineering.claudeCodeBin,
    }))
    .register(new HumanWorker());

  const limits: ChainLimits = {
    maxDepth: config.ai.maxChainDepth,
    maxTasks: config.ai.maxTasksPerChain,
    maxCostUsd: config.ai.maxChainCostUsd,
    maxRuntimeMinutes: config.ai.maxChainRuntimeMinutes,
    unknownCostPolicy: config.ai.unknownCostPolicy,
  };

  return {
    registry,
    hermes: new HermesRouter({ repos, logger, limits }),
    live: providers.live,
  };
}
