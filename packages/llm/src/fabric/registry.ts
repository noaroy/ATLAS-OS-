import { CircuitBreaker, type BreakerSnapshot } from '@atlas/core';
import { pricingFor } from '../pricing.ts';
import type { LlmProvider, LlmResponse } from '../types.ts';
import {
  ANTHROPIC_CAPABILITIES,
  OPENAI_COMPATIBLE_CAPABILITIES,
  SIMULATION_CAPABILITIES,
  UNKNOWN_CAPABILITIES,
  type InferenceCapabilities,
} from './capabilities.ts';

/**
 * Ce qu'ATLAS sait de chaque fournisseur d'inférence.
 *
 * La même séparation que pour les moteurs de recherche : ce qui est **déclaré**
 * — les capacités, écrites à la main parce que « ce fournisseur ne produit pas
 * de JSON structuré » est un fait sur le service, pas une statistique — et ce
 * qui est **mesuré**, qui ne vient que d'appels réellement passés et vaut
 * `null` tant qu'aucun n'a eu lieu.
 *
 * S'y ajoute une notion propre à l'inférence : **l'état de crédit**. Un moteur
 * de recherche gratuit ne s'épuise pas ; un compte d'inférence, si. VAL-001 est
 * morte pour cette raison exacte, et le contrôle affichait « configuré » une
 * seconde plus tôt.
 */

export type InferenceCostModel = 'metered' | 'local' | 'free';

/**
 * L'état d'approvisionnement d'un fournisseur.
 *
 * `exhausted` est distinct de `unhealthy` : le service répond parfaitement,
 * c'est le compte qui est vide. Les confondre ferait chercher une panne réseau
 * là où il faut recharger un compte — la confusion exacte qui a fait perdre
 * une mission.
 */
export type CreditState = 'ok' | 'exhausted' | 'quota-reached' | 'unknown';

export interface InferenceRegistration {
  provider: LlmProvider;
  /** Identifiant stable, distinct de `kind` : deux instances peuvent partager un `kind`. */
  id: string;
  label: string;
  /** Départage deux fournisseurs que tout le reste égalise. Plus petit = préféré. */
  priority: number;
  costModel: InferenceCostModel;
  capabilities?: InferenceCapabilities;
  /**
   * Le modèle que ce fournisseur servirait à la place de celui demandé.
   *
   * Omis, il sert le modèle demandé tel quel. Renseigné, c'est **ce** modèle
   * dont le tarif compte pour la règle « jamais vers plus cher » — sans quoi la
   * règle comparerait le modèle demandé à lui-même et ne s'appliquerait jamais.
   * C'est exactement ce qu'elle faisait avant que le test le révèle.
   */
  substituteModel?: string;
  /** Configuré et utilisable ? Une clé absente n'est pas une panne. */
  available: () => { available: boolean; reason: string };
}

export interface InferenceMetrics {
  calls: number;
  successes: number;
  failures: number;
  rateLimitHits: number;
  totalDurationMs: number;
  totalCostUsd: number;
  /**
   * Appels réussis dont le tarif est inconnu. Leur coût n'entre pas dans
   * `totalCostUsd` — et n'y entre surtout pas comme zéro : un total qui les
   * compterait gratuits annoncerait une dépense plus faible que la vraie.
   */
  unpricedCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

const emptyMetrics = (): InferenceMetrics => ({
  calls: 0,
  successes: 0,
  failures: 0,
  rateLimitHits: 0,
  totalDurationMs: 0,
  totalCostUsd: 0,
  unpricedCalls: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
});

export interface InferenceScore {
  successRate: number;
  errorRate: number;
  averageLatencyMs: number;
  /** Coût moyen constaté par appel, en USD. */
  averageCostUsd: number;
  composite: number;
  sampleSize: number;
}

export interface InferenceRecord {
  id: string;
  label: string;
  kind: LlmProvider['kind'];
  capabilities: InferenceCapabilities;
  priority: number;
  costModel: InferenceCostModel;
  metrics: InferenceMetrics;
  breaker: CircuitBreaker;
  credit: CreditState;
  /** Le modèle réellement servi, s'il diffère de celui demandé. */
  substituteModel: string | null;
  provider: LlmProvider;
  available: () => { available: boolean; reason: string };
}

export interface InferenceStatus {
  id: string;
  label: string;
  kind: LlmProvider['kind'];
  health: 'healthy' | 'unhealthy' | 'unknown';
  credit: CreditState;
  available: boolean;
  availabilityReason: string;
  circuit: BreakerSnapshot;
  capabilities: InferenceCapabilities;
  priority: number;
  costModel: InferenceCostModel;
  metrics: InferenceMetrics;
  score: InferenceScore | null;
}

const defaultCapabilities = (kind: LlmProvider['kind'], id: string): InferenceCapabilities => {
  if (kind === 'simulation') return SIMULATION_CAPABILITIES;
  if (id === 'anthropic') return ANTHROPIC_CAPABILITIES;
  if (id.startsWith('openai-compatible')) return OPENAI_COMPATIBLE_CAPABILITIES;
  return UNKNOWN_CAPABILITIES;
};

export class InferenceProviderRegistry {
  #records = new Map<string, InferenceRecord>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  register(registration: InferenceRegistration): this {
    this.#records.set(registration.id, {
      id: registration.id,
      label: registration.label,
      kind: registration.provider.kind,
      capabilities:
        registration.capabilities ?? defaultCapabilities(registration.provider.kind, registration.id),
      priority: registration.priority,
      costModel: registration.costModel,
      metrics: emptyMetrics(),
      breaker: new CircuitBreaker({ now: this.#now }),
      credit: 'unknown',
      substituteModel: registration.substituteModel ?? null,
      provider: registration.provider,
      available: registration.available,
    });
    return this;
  }

  get(id: string): InferenceRecord | undefined {
    return this.#records.get(id);
  }

  all(): InferenceRecord[] {
    return [...this.#records.values()];
  }

  get size(): number {
    return this.#records.size;
  }

  /** Enregistre ce qu'un appel réel a appris. Seul point d'entrée des métriques. */
  recordSuccess(id: string, response: LlmResponse, durationMs: number, costUsd: number | null): void {
    const record = this.#records.get(id);
    if (!record) return;

    const m = record.metrics;
    m.calls += 1;
    m.successes += 1;
    m.totalDurationMs += durationMs;
    if (costUsd === null) m.unpricedCalls += 1;
    else m.totalCostUsd += costUsd;
    m.totalInputTokens += response.usage.inputTokens;
    m.totalOutputTokens += response.usage.outputTokens;

    record.breaker.recordSuccess();
    // Un appel qui aboutit prouve que le compte est approvisionné. C'est la
    // seule preuve qui vaille : un solde annoncé « suffisant » ne dit rien de
    // ce que le fournisseur acceptera au prochain appel.
    record.credit = 'ok';
  }

  recordFailure(id: string, failure: InferenceFailure, durationMs: number): void {
    const record = this.#records.get(id);
    if (!record) return;

    const m = record.metrics;
    m.calls += 1;
    m.failures += 1;
    m.totalDurationMs += durationMs;
    if (failure.kind === 'quota') m.rateLimitHits += 1;

    if (failure.kind === 'credit') record.credit = 'exhausted';
    else if (failure.kind === 'quota') record.credit = 'quota-reached';

    record.breaker.recordFailure(failure.detail, opensImmediatelyFor(failure.kind));
  }

  /**
   * La santé, déduite et non mesurée.
   *
   * `unknown` tant qu'aucun appel n'a eu lieu — et ce n'est pas une commodité.
   * Sonder un fournisseur pour afficher son état coûte un appel facturé que
   * personne n'a demandé. Le contrôle avant décollage le fait une fois,
   * volontairement ; l'affichage ne le fait jamais.
   */
  healthOf(id: string): 'healthy' | 'unhealthy' | 'unknown' {
    const record = this.#records.get(id);
    if (!record) return 'unknown';

    if (record.breaker.state === 'open') return 'unhealthy';
    if (record.metrics.calls === 0) return 'unknown';

    const snapshot = record.breaker.snapshot();
    if (snapshot.consecutiveFailures > 0) return 'unhealthy';
    return snapshot.lastSuccessAt ? 'healthy' : 'unknown';
  }

  /** Déclare l'état de crédit sans passer d'appel — utilisé par le preflight. */
  setCredit(id: string, credit: CreditState): void {
    const record = this.#records.get(id);
    if (record) record.credit = credit;
  }

  scoreOf(id: string): InferenceScore | null {
    const record = this.#records.get(id);
    if (!record || record.metrics.calls === 0) return null;

    const m = record.metrics;
    const successRate = m.successes / m.calls;
    const errorRate = m.failures / m.calls;
    const averageLatencyMs = m.totalDurationMs / m.calls;
    const priced = m.successes - m.unpricedCalls;
    const averageCostUsd = priced > 0 ? m.totalCostUsd / priced : 0;

    // La latence entre par une décroissance douce plutôt qu'un seuil : entre
    // 4 999 ms et 5 001 ms il n'y a rien à décider, et un seuil prétendrait le
    // contraire.
    const latencyScore = 1 / (1 + averageLatencyMs / 5000);
    const composite = successRate * 0.6 + latencyScore * 0.25 - errorRate * 0.15;

    return {
      successRate: round(successRate),
      errorRate: round(errorRate),
      averageLatencyMs: Math.round(averageLatencyMs),
      averageCostUsd: Number(averageCostUsd.toFixed(6)),
      composite: round(Math.max(0, Math.min(1, composite))),
      sampleSize: m.calls,
    };
  }

  statusOf(id: string): InferenceStatus | null {
    const record = this.#records.get(id);
    if (!record) return null;

    const availability = record.available();
    return {
      id: record.id,
      label: record.label,
      kind: record.kind,
      health: this.healthOf(id),
      credit: record.credit,
      available: availability.available,
      availabilityReason: availability.reason,
      circuit: record.breaker.snapshot(),
      capabilities: record.capabilities,
      priority: record.priority,
      costModel: record.costModel,
      metrics: { ...record.metrics },
      score: this.scoreOf(id),
    };
  }

  statuses(): InferenceStatus[] {
    return this.all()
      .map((r) => this.statusOf(r.id))
      .filter((s): s is InferenceStatus => s !== null);
  }
}

// ─── Classement des échecs ──────────────────────────────────────────────────

/**
 * Pourquoi un appel a échoué, et ce que cela implique.
 *
 * Le tri décide de la suite : un crédit épuisé ne se réessaie jamais, un 5xx
 * peut passer au deuxième essai, et un refus de contenu n'est pas une panne du
 * tout — c'est une réponse.
 */
export type InferenceFailureKind =
  | 'credit'
  | 'quota'
  | 'auth'
  | 'server'
  | 'timeout'
  | 'network'
  | 'request'
  | 'unknown';

export interface InferenceFailure {
  kind: InferenceFailureKind;
  detail: string;
}

/** Un crédit épuisé ou un quota atteint ouvre sans attendre le seuil. */
const opensImmediatelyFor = (kind: InferenceFailureKind): boolean =>
  kind === 'credit' || kind === 'quota' || kind === 'auth';

/**
 * Cet échec justifie-t-il d'essayer un autre fournisseur ?
 *
 * `request` ne le justifie pas : une requête malformée le restera partout, et
 * la relancer ailleurs ne ferait que payer la même erreur deux fois. C'est la
 * même règle que le résultat vide côté recherche — un échec qui vient de nous
 * ne se soigne pas en changeant d'interlocuteur.
 */
export const shouldFailover = (kind: InferenceFailureKind): boolean =>
  kind === 'credit' ||
  kind === 'quota' ||
  kind === 'auth' ||
  kind === 'server' ||
  kind === 'timeout' ||
  kind === 'network';

/**
 * Classe une erreur de fournisseur.
 *
 * Lit le message plutôt que le type, parce que c'est là que les fournisseurs
 * mettent la cause réelle : un solde épuisé arrive en HTTP 400, indiscernable
 * d'une requête invalide sans lire le texte.
 */
export function classifyFailure(err: unknown): InferenceFailure {
  const detail = err instanceof Error ? err.message : String(err);
  const lower = detail.toLowerCase();

  if (lower.includes('credit balance') || lower.includes('insufficient_quota') || lower.includes('billing')) {
    return { kind: 'credit', detail };
  }
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('quota')) {
    return { kind: 'quota', detail };
  }
  if (lower.includes('401') || lower.includes('403') || lower.includes('authentication')) {
    return { kind: 'auth', detail };
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('deadline')) {
    return { kind: 'timeout', detail };
  }
  if (/\b5\d\d\b/.test(detail) || lower.includes('overloaded')) {
    return { kind: 'server', detail };
  }
  if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('network') || lower.includes('fetch failed')) {
    return { kind: 'network', detail };
  }
  if (lower.includes('400') || lower.includes('invalid_request') || lower.includes('schema')) {
    return { kind: 'request', detail };
  }
  return { kind: 'unknown', detail };
}

/** Le coût annoncé d'un modèle, pour comparer deux fournisseurs avant d'appeler. */
export function announcedCostPerMTokens(model: string): number | null {
  const pricing = pricingFor(model);
  if (!pricing) return null;
  // Une pondération d'usage : l'entrée domine largement le volume, la sortie
  // domine le prix unitaire. 90/10 reflète ce qu'ATLAS consomme réellement —
  // 387 402 jetons sur LIVE PILOT 001, dont 92 % en entrée.
  return pricing.input * 0.9 + pricing.output * 0.1;
}

const round = (n: number): number => Number(n.toFixed(4));
