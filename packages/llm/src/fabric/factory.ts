import type { AtlasConfig, Logger } from '@atlas/core';
import { AnthropicProvider } from '../anthropic-provider.ts';
import { SimulationProvider } from '../simulation-provider.ts';
import { InferenceFabric } from './fabric.ts';
import { InferenceProviderRegistry } from './registry.ts';

/**
 * Le parc de fournisseurs d'inférence du déploiement.
 *
 * Tous sont enregistrés, y compris ceux qui ne sont pas configurés : c'est leur
 * disponibilité qui les écarte, avec une raison lisible. Un fournisseur absent
 * du registre serait invisible dans le cockpit, et l'opérateur ne saurait pas
 * qu'il pourrait l'activer.
 *
 * Aucun compte n'est créé ici, aucun abonnement souscrit, aucune dépense
 * engagée. Un point d'accès compatible OpenAI se branche par variable
 * d'environnement — Ollama sur la machine, vLLM sur un serveur, ou un service
 * tiers déjà souscrit. L'architecture l'accueille ; c'est au fondateur de
 * décider s'il en veut un.
 */

/**
 * L'ordre de préférence quand tout le reste égalise.
 *
 * Un modèle local d'abord : il ne facture rien et ne s'épuise pas. Anthropic
 * ensuite, parce que c'est le seul dont les capacités sont pleinement établies.
 * La simulation en dernier — et elle ne sert jamais en mode réel.
 */
const PRIORITY: Record<string, number> = {
  'openai-compatible': 10,
  anthropic: 20,
  simulation: 90,
};

export interface InferenceFabricOptions {
  /** Combien de fournisseurs essayer au maximum pour une même requête. */
  maxAttempts?: number;
  /** Autoriser une bascule vers un fournisseur plus cher. Faux par défaut. */
  allowCostlierFailover?: boolean;
  onFailover?: InferenceFabricConstructorOptions['onFailover'];
}

type InferenceFabricConstructorOptions = ConstructorParameters<typeof InferenceFabric>[0];

export function buildInferenceRegistry(
  config: AtlasConfig,
  logger: Logger,
): InferenceProviderRegistry {
  const registry = new InferenceProviderRegistry();

  registry.register({
    id: 'anthropic',
    label: 'Anthropic',
    provider: new AnthropicProvider(config.llm.apiKey, logger),
    priority: PRIORITY.anthropic!,
    costModel: 'metered',
    available: () =>
      config.llm.apiKey
        ? { available: true, reason: 'clé présente' }
        : {
            available: false,
            reason: 'Aucune clé Anthropic. Renseignez ANTHROPIC_API_KEY.',
          },
  });

  // Un point d'accès compatible OpenAI, s'il est déclaré. Le provider concret
  // n'existe pas encore : l'enregistrer sans implémentation le ferait échouer à
  // l'appel plutôt qu'à la configuration, ce qui est le mauvais moment. Il
  // apparaît donc dans le parc comme non configuré, avec ce qu'il faut faire.
  registry.register({
    id: 'openai-compatible',
    label: 'Point d’accès compatible OpenAI',
    // Faute d'implémentation, on enregistre la simulation comme porteur : elle
    // n'est jamais routée en mode réel, et `available()` l'écarte de toute façon.
    provider: new SimulationProvider(logger),
    priority: PRIORITY['openai-compatible']!,
    costModel: 'local',
    available: () => ({
      available: false,
      reason:
        "Aucun point d'accès compatible OpenAI configuré. Posez ATLAS_OPENAI_BASE_URL " +
        "(Ollama, vLLM ou service déjà souscrit) pour donner un secours à l'inférence.",
    }),
  });

  registry.register({
    id: 'simulation',
    label: 'Simulation locale',
    provider: new SimulationProvider(logger),
    priority: PRIORITY.simulation!,
    costModel: 'free',
    available: () => ({ available: true, reason: 'toujours disponible, sans valeur informative' }),
  });

  return registry;
}

/**
 * Construit le fournisseur d'inférence du déploiement.
 *
 * Remplace `createLlmProvider` sans en changer le contrat : le résultat reste
 * un `LlmProvider`, et tout ce qui le consomme continue de fonctionner.
 */
export function createInferenceFabric(
  config: AtlasConfig,
  logger: Logger,
  options: InferenceFabricOptions = {},
): InferenceFabric {
  const registry = buildInferenceRegistry(config, logger);

  const fabric = new InferenceFabric({
    registry,
    policy: {
      mode: config.llm.mode,
      allowCostlierFailover: options.allowCostlierFailover ?? false,
      costTolerance: 1.0,
    },
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    onFailover: (attempt, next) => {
      // Une bascule d'inférence est un événement rare et coûteux à ignorer :
      // elle doit se voir dans un journal qu'on parcourt vite.
      logger.warn('bascule de fournisseur d’inférence', {
        from: attempt.providerId,
        cause: attempt.failureKind,
        to: next ?? '(aucun autre)',
        detail: attempt.detail.slice(0, 160),
      });
      options.onFailover?.(attempt, next);
    },
  });

  const statuses = fabric.statuses();
  logger.info('inference fabric', {
    mode: config.llm.mode,
    enregistrés: statuses.length,
    utilisables: statuses.filter((s) => s.available).map((s) => s.id),
    écartés: statuses.filter((s) => !s.available).map((s) => s.id),
  });

  return fabric;
}
