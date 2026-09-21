import type { AtlasConfig, ProviderHealth } from '@atlas/core';
import type { Repositories } from '@atlas/data';

/**
 * Ce que « fournisseur prêt » veut dire — et ce que cela ne veut pas dire.
 *
 * Une clé présente n'est pas un fournisseur qui répond : c'est CONFIGURED.
 * Un fournisseur qui a répondu à une sonde gratuite récemment est READY.
 * Une sonde ancienne est STALE : encore utilisable, mais à revérifier. Une
 * clé refusée, un quota consommé, un budget épuisé : BLOCKED — aucun délai
 * ne répare une clé refusée, et un budget se rétablit à son échéance.
 *
 * La sonde est la plus légère qui existe chez chacun : la liste des modèles,
 * un GET gratuit, sans jeton dépensé. Elle n'est rejouée qu'au-delà d'une
 * durée (six heures) : la santé enregistrée par les workers eux-mêmes —
 * limitation, quota, clé refusée — fait foi entre deux sondes. Jamais une
 * clé n'est imprimée : ni ici, ni dans un motif.
 */

export type ProviderReadinessState = 'READY' | 'STALE' | 'CONFIGURED' | 'BLOCKED' | 'ABSENT';

export interface ProviderReadinessVerdict {
  provider: 'OPENAI' | 'ANTHROPIC';
  state: ProviderReadinessState;
  /** Utilisable par un worker maintenant : READY ou STALE. */
  ready: boolean;
  detail: string;
  observedAt: string | null;
}

export const PROVIDER_VERIFY_TTL_MS = 6 * 3_600_000;

const PROBE: Record<'OPENAI' | 'ANTHROPIC', { url: string; headers: (key: string) => Record<string, string>; keyVar: string }> = {
  OPENAI: { url: 'https://api.openai.com/v1/models', headers: (key) => ({ authorization: `Bearer ${key}` }), keyVar: 'ATLAS_OPENAI_API_KEY' },
  ANTHROPIC: { url: 'https://api.anthropic.com/v1/models', headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }), keyVar: 'ANTHROPIC_API_KEY' },
};

const BLOCKING = new Set<ProviderHealth['state']>(['AUTH_ERROR', 'QUOTA_EXHAUSTED', 'BUDGET_EXHAUSTED']);

/** Le verdict, depuis la santé déjà enregistrée — sans réseau. */
export function providerReadinessOf(input: {
  provider: 'OPENAI' | 'ANTHROPIC';
  configured: boolean;
  live: boolean;
  health: ProviderHealth | null;
  now: Date;
  ttlMs?: number;
}): ProviderReadinessVerdict {
  const { provider, health } = input;
  const ttl = input.ttlMs ?? PROVIDER_VERIFY_TTL_MS;
  if (!input.live) return { provider, state: 'ABSENT', ready: false, detail: `${provider} : ATLAS_AI_LIVE=false, aucun appel payant`, observedAt: null };
  if (!input.configured) return { provider, state: 'ABSENT', ready: false, detail: `${provider} : ${PROBE[provider].keyVar} absent`, observedAt: null };
  if (!health) return { provider, state: 'CONFIGURED', ready: false, detail: `${provider} : clé présente, jamais vérifié`, observedAt: null };
  if (BLOCKING.has(health.state)) {
    return { provider, state: 'BLOCKED', ready: false, detail: `${provider} : ${health.state}${health.reason ? ` — ${health.reason}` : ''}`, observedAt: health.observedAt };
  }
  if (health.state === 'RATE_LIMITED' && health.retryAt && Date.parse(health.retryAt) > input.now.getTime()) {
    return { provider, state: 'BLOCKED', ready: false, detail: `${provider} : limité jusqu'à ${health.retryAt}`, observedAt: health.observedAt };
  }
  if (health.state === 'DEGRADED') {
    return { provider, state: 'BLOCKED', ready: false, detail: `${provider} : DEGRADED${health.reason ? ` — ${health.reason}` : ''}`, observedAt: health.observedAt };
  }
  const age = input.now.getTime() - Date.parse(health.observedAt);
  if (age > ttl) return { provider, state: 'STALE', ready: true, detail: `${provider} : vérifié il y a ${Math.round(age / 3_600_000)} h — à revérifier`, observedAt: health.observedAt };
  return { provider, state: 'READY', ready: true, detail: `${provider} : ${health.state === 'AVAILABLE' ? 'a répondu' : health.state} (${health.observedAt.slice(11, 16)} UTC)`, observedAt: health.observedAt };
}

/**
 * Sonder un fournisseur, une fois, à bon marché — et consigner.
 *
 * Rejoué seulement si la dernière observation est plus vieille que la durée,
 * ou si elle n'existe pas. Un refus (401/403) est une clé refusée ; un 429 une
 * limitation ; tout autre échec, DEGRADED. Rien n'est déduit d'un secret.
 */
export async function verifyProvider(
  repos: Repositories,
  provider: 'OPENAI' | 'ANTHROPIC',
  options: { now?: Date; ttlMs?: number; timeoutMs?: number; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<{ probed: boolean; health: ProviderHealth | null }> {
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const key = env[PROBE[provider].keyVar]?.trim();
  if (!key) return { probed: false, health: repos.tasks.providerHealth(provider) };

  const current = repos.tasks.providerHealth(provider);
  const ttl = options.ttlMs ?? PROVIDER_VERIFY_TTL_MS;
  if (current && now.getTime() - Date.parse(current.observedAt) < ttl && current.state !== 'UNKNOWN') {
    return { probed: false, health: current };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  try {
    const response = await fetchImpl(PROBE[provider].url, { method: 'GET', headers: PROBE[provider].headers(key), signal: controller.signal });
    if (response.ok) {
      return { probed: true, health: repos.tasks.recordProviderHealth({ provider, state: 'AVAILABLE', reason: 'sonde : liste des modèles, HTTP 200', retrySource: 'NONE' }) };
    }
    if (response.status === 401 || response.status === 403) {
      return { probed: true, health: repos.tasks.recordProviderHealth({ provider, state: 'AUTH_ERROR', reason: `sonde : HTTP ${response.status} — clé refusée`, retrySource: 'NONE' }) };
    }
    if (response.status === 429) {
      return { probed: true, health: repos.tasks.recordProviderHealth({ provider, state: 'RATE_LIMITED', reason: 'sonde : HTTP 429', retryAt: new Date(now.getTime() + 15 * 60_000).toISOString(), retrySource: 'BACKOFF' }) };
    }
    return { probed: true, health: repos.tasks.recordProviderHealth({ provider, state: 'DEGRADED', reason: `sonde : HTTP ${response.status}`, retrySource: 'NONE' }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { probed: true, health: repos.tasks.recordProviderHealth({ provider, state: 'DEGRADED', reason: `sonde : ${message.slice(0, 80)}`, retrySource: 'NONE' }) };
  } finally {
    clearTimeout(timer);
  }
}

/** Les deux fournisseurs de modèle, sondés si besoin, jugés. */
export async function assessModelProviders(
  repos: Repositories,
  config: AtlasConfig,
  options: { now?: Date; verify?: boolean; ttlMs?: number; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<Record<'OPENAI' | 'ANTHROPIC', ProviderReadinessVerdict>> {
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const out = {} as Record<'OPENAI' | 'ANTHROPIC', ProviderReadinessVerdict>;
  for (const provider of ['OPENAI', 'ANTHROPIC'] as const) {
    const configured = Boolean(env[PROBE[provider].keyVar]?.trim());
    if (options.verify !== false && config.ai.live && configured) {
      await verifyProvider(repos, provider, { now, ttlMs: options.ttlMs, fetchImpl: options.fetchImpl, env });
    }
    out[provider] = providerReadinessOf({ provider, configured, live: config.ai.live, health: repos.tasks.providerHealth(provider), now, ttlMs: options.ttlMs });
  }
  return out;
}
