import type { AtlasConfig, Logger } from '@atlas/core';
import { AnthropicProvider } from '../anthropic-provider.ts';
import { OpenAiProvider } from '../ai-providers-impl.ts';
import { pricingFor } from '../pricing.ts';
import { SimulationProvider } from '../simulation-provider.ts';
import { textOf, type LlmProvider, type LlmRequest, type LlmResponse } from '../types.ts';
import type { InferenceCapabilities } from './capabilities.ts';
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
  openai: 30,
  simulation: 90,
};

/**
 * OpenAI, tel que le parc peut l'employer : texte et JSON, sans outils.
 *
 * `structuredOutput` est vrai parce que le schéma est remis au modèle et la
 * réponse forcée en objet JSON ; les outils ne le sont pas, faute de
 * traduction — une requête qui en porte reste chez Anthropic ou échoue.
 */
const OPENAI_CAPABILITIES: InferenceCapabilities = {
  structuredOutput: true,
  toolUse: false,
  serverTools: false,
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  // Le modèle demandé est un Claude ; c'est `substituteModel` qui est servi.
  models: ['*'],
  caveat: 'Secours sans outils : schéma JSON transmis dans la consigne, sortie en objet JSON.',
};

/**
 * Le fournisseur OpenAI existant, présenté au contrat du parc.
 *
 * Aucune seconde implémentation : l'appel, le délai, l'idempotence et le
 * classement d'erreur restent ceux d'`OpenAiProvider`. Ce n'est qu'une
 * traduction de forme. `kind` reste celui que le contrat connaît ; ce qui
 * attribue l'appel à OpenAI est l'identifiant `openai` du registre et le
 * modèle réellement servi, rendu tel quel dans `response.model`.
 */
class OpenAiInferenceProvider implements LlmProvider {
  readonly kind = 'anthropic' as const;

  constructor(
    readonly inner: OpenAiProvider,
    private readonly timeoutMs: number,
  ) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const prompt = request.messages
      .map((m) => (request.messages.length > 1 ? `[${m.role}]\n${textOf(m.content)}` : textOf(m.content)))
      .join('\n\n');
    const system = request.jsonSchema
      ? `${request.system}\n\nRéponds uniquement par un objet JSON conforme à ce schéma :\n${JSON.stringify(request.jsonSchema)}`
      : request.system;

    const reply = await this.inner.execute({
      system,
      prompt,
      ...(request.jsonSchema ? { responseSchema: request.jsonSchema } : {}),
      maxOutputTokens: request.maxTokens,
      timeoutMs: this.timeoutMs,
      capability: 'STRUCTURED_EXTRACTION',
    });

    // OpenAI compte les jetons relus en cache *dans* l'entrée ; le contrat les
    // veut à part, pour qu'ils soient facturés une fois, à leur tarif.
    const cached = Math.min(reply.usage.cacheReadTokens, reply.usage.inputTokens);
    return {
      content: [{ type: 'text', text: reply.text }],
      stopReason: reply.truncated ? 'max_tokens' : 'end_turn',
      usage: {
        inputTokens: reply.usage.inputTokens - cached,
        outputTokens: reply.usage.outputTokens,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      },
      model: reply.model,
      refusal: null,
    };
  }
}

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

  // OpenAI, secours seulement. Anthropic reste le fournisseur principal : ce
  // secours n'est éligible que lorsque son compte est vide, ou que son quota
  // atteint a ouvert le disjoncteur. Le refroidissement passé, Anthropic est
  // de nouveau essayé en premier. Un modèle sans tarif connu n'est jamais
  // routé : une dépense qu'on ne sait pas chiffrer ne se plafonne pas.
  const openai = new OpenAiProvider(config.ai.openaiModel, process.env.ATLAS_OPENAI_API_KEY ?? '');
  registry.register({
    id: 'openai',
    label: 'OpenAI',
    provider: new OpenAiInferenceProvider(openai, config.ai.openaiTimeoutMs),
    priority: PRIORITY.openai!,
    costModel: 'metered',
    capabilities: OPENAI_CAPABILITIES,
    substituteModel: config.ai.openaiModel,
    available: () => {
      const status = openai.status();
      if (!status.configured) return { available: false, reason: status.detail };
      if (!pricingFor(config.ai.openaiModel)) {
        return {
          available: false,
          reason: `tarif inconnu pour « ${config.ai.openaiModel} » — déclarez-le (ATLAS_MODEL_PRICING_CONFIG) avant tout secours`,
        };
      }
      const primary = registry.get('anthropic');
      const primaryDown =
        primary !== undefined &&
        (primary.credit === 'exhausted' ||
          (primary.credit === 'quota-reached' && primary.breaker.state === 'open'));
      return primaryDown
        ? { available: true, reason: `secours d'Anthropic (${primary.credit}) · ${status.detail}` }
        : { available: false, reason: 'secours seulement : Anthropic reste prioritaire tant que son compte répond' };
    },
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
