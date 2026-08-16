import type { AtlasConfig, Logger } from '@atlas/core';
import { AnthropicProvider } from './anthropic-provider.ts';
import { SimulationProvider } from './simulation-provider.ts';
import type { LlmProvider } from './types.ts';

export * from './types.ts';
export * from './budget.ts';
export * from './pricing.ts';
export * from './model-policy.ts';
export * from './json-schema.ts';
export { AnthropicProvider } from './anthropic-provider.ts';
export { SimulationProvider } from './simulation-provider.ts';
export { BudgetedProvider } from './budgeted-provider.ts';

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
