import type { SearchConfig } from '@atlas/core';
import { BraveSearchProvider } from '../brave.ts';
import type { MissionSearchNeed } from '../capabilities.ts';
import { DuckDuckGoSearchProvider } from '../duckduckgo.ts';
import { MarginaliaSearchProvider } from '../marginalia.ts';
import { SearxngSearchProvider } from '../searxng.ts';
import type { SearchProvider } from '../types.ts';
import { OPEN_NEED, SearchFabric } from './fabric.ts';
import { RateLimiter } from './limiter.ts';
import { SearchProviderRegistry, type ProviderRegistration } from './registry.ts';

/**
 * La construction du parc, en un seul endroit.
 *
 * Elle était dupliquée cinq fois — le démarrage du serveur, le cockpit, deux
 * scripts de pilotage et une sonde — chacune avec sa propre cascade de
 * ternaires. Ajouter un moteur voulait dire les modifier toutes, et en oublier
 * une signifiait qu'un écran affichait un parc que le serveur n'utilisait pas.
 *
 * Le mode `auto` est le défaut recommandé : il enregistre tout ce qui est
 * configuré et laisse le routeur trancher à chaque requête, en fonction de
 * l'état réel des moteurs. Nommer un moteur explicitement reste possible, et
 * reste utile pour reproduire un incident — mais c'est alors un parc d'un seul
 * moteur, avec le point de défaillance unique que cela suppose.
 */

/**
 * L'ordre de préférence quand tout le reste égalise.
 *
 * SearXNG en tête parce qu'auto-hébergé : pas de quota, pas de bridage, pas de
 * tiers qui change ses conditions. DuckDuckGo ensuite — gratuit et généraliste,
 * mais il bride. Brave après, parce qu'il facture. Marginalia en dernier : son
 * index est excellent et étroit, il ne sert que les missions qu'il couvre
 * vraiment, et l'adéquation l'écartera d'elle-même partout ailleurs.
 */
const PRIORITY: Record<string, number> = {
  searxng: 10,
  duckduckgo: 20,
  brave: 30,
  marginalia: 40,
};

function registrationsFor(config: SearchConfig): ProviderRegistration[] {
  const registrations: ProviderRegistration[] = [];

  const add = (
    provider: SearchProvider,
    costModel: ProviderRegistration['costModel'],
    costPerQueryUsd = 0,
  ): void => {
    registrations.push({
      provider,
      priority: PRIORITY[provider.key] ?? 100,
      costModel,
      costPerQueryUsd,
    });
  };

  // Tous sont enregistrés, y compris ceux qui ne sont pas configurés : c'est
  // leur `availability()` qui les écarte, avec une raison lisible. Un moteur
  // absent du registre serait invisible dans le cockpit, et l'opérateur ne
  // saurait pas qu'il pourrait l'activer.
  add(new SearxngSearchProvider({
    baseUrl: config.searxngBaseUrl,
    engines: config.searxngEngines,
  }), 'self-hosted');

  add(new DuckDuckGoSearchProvider(), 'free');

  add(new BraveSearchProvider({
    apiKey: config.braveApiKey,
    costPerQueryUsd: config.costPerQueryUsd,
  }), 'metered', config.costPerQueryUsd);

  add(new MarginaliaSearchProvider(), 'free');

  return registrations;
}

/** Construit le registre correspondant à une configuration. */
export function buildRegistry(config: SearchConfig): SearchProviderRegistry {
  const registry = new SearchProviderRegistry();

  const all = registrationsFor(config);
  const selected =
    config.provider === 'auto'
      ? all
      : all.filter((registration) => registration.provider.key === config.provider);

  for (const registration of selected) registry.register(registration);
  return registry;
}

export interface FabricOptions {
  /** Ce que la mission attend du moteur. Omis, le Fabric reste généraliste. */
  need?: MissionSearchNeed;
  limiter?: RateLimiter;
  maxAttempts?: number;
}

/**
 * Le moteur de recherche du déploiement.
 *
 * Rend `null` uniquement quand la configuration demande explicitement de ne pas
 * chercher (`none`) ou délègue la recherche au modèle (`anthropic`) — deux cas
 * où il n'y a pas de moteur à piloter. Partout ailleurs le Fabric est rendu,
 * même si aucun moteur n'est utilisable : c'est lui qui saura le dire, avec sa
 * raison, plutôt qu'un `null` qui oblige chaque appelant à réinventer le message.
 */
export function createSearchFabric(
  config: SearchConfig,
  options: FabricOptions = {},
): SearchFabric | null {
  if (config.provider === 'none' || config.provider === 'anthropic') return null;

  return new SearchFabric({
    registry: buildRegistry(config),
    need: options.need ?? OPEN_NEED,
    ...(options.limiter ? { limiter: options.limiter } : {}),
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
  });
}
