import type { AtlasConfig, Logger } from '@atlas/core';
import { AnthropicProvider } from './anthropic-provider.ts';
import { SimulationProvider } from './simulation-provider.ts';
import type { LlmProvider } from './types.ts';

export * from './types.ts';
export * from './budget.ts';
export * from './pricing.ts';
export * from './pricing-config.ts';
export * from './model-policy.ts';
export * from './json-schema.ts';
export { AnthropicProvider } from './anthropic-provider.ts';
export { SimulationProvider } from './simulation-provider.ts';
export { BudgetedProvider } from './budgeted-provider.ts';

// ─── Inference Fabric ───────────────────────────────────────────────────────
// Le parc de fournisseurs, derrière le contrat d'un fournisseur unique. Tout ce
// qui consomme l'inférence continue de voir un `LlmProvider` ; ce provider sait
// maintenant basculer, disjoncter et refuser une bascule plus chère.
export {
  InferenceFabric,
  type InferenceAttempt,
  type InferenceTrace,
} from './fabric/fabric.ts';
export {
  createInferenceFabric,
  buildInferenceRegistry,
  type InferenceFabricOptions,
} from './fabric/factory.ts';
export {
  InferenceProviderRegistry,
  classifyFailure,
  shouldFailover,
  announcedCostPerMTokens,
  type InferenceRecord,
  type InferenceStatus,
  type InferenceScore,
  type InferenceMetrics,
  type InferenceRegistration,
  type InferenceFailure,
  type InferenceFailureKind,
  type InferenceCostModel,
  type CreditState,
} from './fabric/registry.ts';
export {
  InferenceRouter,
  DEFAULT_ROUTING_POLICY,
  type InferencePlan,
  type InferenceCandidate,
  type RoutingPolicy,
} from './fabric/router.ts';
export {
  assessInferenceSuitability,
  ANTHROPIC_CAPABILITIES,
  OPENAI_COMPATIBLE_CAPABILITIES,
  SIMULATION_CAPABILITIES,
  UNKNOWN_CAPABILITIES,
  type InferenceCapabilities,
  type InferenceSuitability,
  type InferenceSuitabilityVerdict,
} from './fabric/capabilities.ts';

/**
 * Chooses the inference provider for this deployment.
 *
 * Absence of an API key is treated as an explicit mode, not an error: ATLAS is
 * designed to run — and be demonstrated — without external dependencies.
 */
export function createLlmProvider(config: AtlasConfig, logger: Logger): LlmProvider {
  if (config.llm.mode === 'live') {
    logger.info('inference: Anthropic API', {
      hermes: config.llm.hermesModel,
      agents: config.llm.agentModel,
      effort: config.llm.effort,
    });
    return new AnthropicProvider(config.llm.apiKey, logger);
  }

  logger.warn('inference: SIMULATION mode (no ANTHROPIC_API_KEY set)', {
    detail: 'Missions run end to end; agent findings are structural placeholders.',
  });
  return new SimulationProvider(logger);
}

export {
  classifyAiError,
  extractJson,
  type AiProvider,
  type AiProviderName,
  type AiProviderStatus,
  type AiCapability,
  type AiRequest,
  type AiResponse,
  type AiUsage,
  type AiErrorKind,
  type AiErrorVerdict,
} from './ai-provider.ts';

export {
  FixtureAiProvider,
  OpenAiProvider,
  AnthropicAiProvider,
  type FixtureReply,
} from './ai-providers-impl.ts';

