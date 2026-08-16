import { capabilitiesOf, type ProviderCapabilities } from '../capabilities.ts';
import type { SearchProvider, SearchProviderOutcome } from '../types.ts';
import { CircuitBreaker, type BreakerSnapshot } from './breaker.ts';

/**
 * Ce qu'ATLAS sait de chaque moteur, et comment il l'a appris.
 *
 * Une distinction gouverne tout ce fichier : **ce qui est déclaré** et **ce qui
 * est mesuré**. Les capacités d'un moteur sont déclarées — elles viennent d'une
 * table écrite à la main, parce que « Marginalia ne couvre pas l'allemand » est
 * un fait sur l'index, pas une statistique. Le score opérationnel est mesuré —
 * il ne vient que d'appels réellement passés, et vaut `null` tant qu'aucun
 * appel n'a eu lieu.
 *
 * Ce `null` est le point important. Un moteur jamais appelé n'a pas un score de
 * zéro, et il n'a pas non plus un score parfait : il n'a pas de score. Lui en
 * inventer un — même « neutre », même 0,5 — reviendrait à le classer par
 * rapport à des moteurs dont on sait des choses, sur la foi de rien.
 */

export type ProviderCostModel = 'free' | 'self-hosted' | 'metered';

export interface ProviderRegistration {
  provider: SearchProvider;
  /** Départage deux moteurs que tout le reste égalise. Plus petit = préféré. */
  priority: number;
  costModel: ProviderCostModel;
  /** Coût annoncé par requête, en USD. Zéro pour les moteurs gratuits. */
  costPerQueryUsd: number;
}

/** Ce qu'une exécution réelle a appris. Rien n'entre ici sans un appel effectué. */
export interface ProviderMetrics {
  calls: number;
  successes: number;
  emptyResponses: number;
  failures: number;
  rateLimitHits: number;
  /** Somme des durées, pour une moyenne qui ne stocke pas l'historique. */
  totalDurationMs: number;
  /** Résultats rendus, tous appels confondus — la couverture observée. */
  totalResults: number;
  totalCostUsd: number;
}

const emptyMetrics = (): ProviderMetrics => ({
  calls: 0,
  successes: 0,
  emptyResponses: 0,
  failures: 0,
  rateLimitHits: 0,
  totalDurationMs: 0,
  totalResults: 0,
  totalCostUsd: 0,
});

/**
 * Le score opérationnel d'un moteur — ou `null` s'il n'a jamais servi.
 *
 * Chaque composante est un ratio observé, jamais une estimation. `relevance`
 * est délibérément grossier : c'est le nombre moyen de résultats rendus rapporté
 * à ce qui a été demandé, ce qui mesure la couverture et non la pertinence. Le
 * nommer honnêtement importe plus que le raffiner — un score « pertinence »
 * qui mesure en fait le volume est pire qu'un score absent.
 */
export interface ProviderScore {
  successRate: number;
  errorRate: number;
  rateLimitFrequency: number;
  averageLatencyMs: number;
  /** Résultats rendus par appel réussi. */
  coverage: number;
  /** 0..1 — la synthèse qui sert au classement. */
  composite: number;
  /** Sur combien d'appels ce score repose. Un score sur deux appels ne vaut pas grand-chose. */
  sampleSize: number;
}

export interface ProviderRecord {
  id: string;
  name: string;
  capabilities: ProviderCapabilities;
  priority: number;
  costModel: ProviderCostModel;
  costPerQueryUsd: number;
  metrics: ProviderMetrics;
  breaker: CircuitBreaker;
  /** Le moteur lui-même. */
  provider: SearchProvider;
}

/**
 * L'état d'un moteur, tel que le Command Center doit le lire.
 *
 * Assemblé à la demande plutôt que maintenu : un état dupliqué diverge, et
 * celui-ci n'est lu qu'à l'affichage.
 */
export interface ProviderStatus {
  id: string;
  name: string;
  /** Le moteur répond-il ? Déduit des appels réels, jamais sondé à l'affichage. */
  health: 'healthy' | 'unhealthy' | 'unknown';
  /** Configuré et utilisable ? Distinct de la santé : une clé absente n'est pas une panne. */
  available: boolean;
  availabilityReason: string;
  circuit: BreakerSnapshot;
  capabilities: ProviderCapabilities;
  priority: number;
  costModel: ProviderCostModel;
  costPerQueryUsd: number;
  metrics: ProviderMetrics;
  score: ProviderScore | null;
}

export class SearchProviderRegistry {
  #records = new Map<string, ProviderRecord>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  register(registration: ProviderRegistration): this {
    const { provider } = registration;
    this.#records.set(provider.key, {
      id: provider.key,
      name: provider.label,
      capabilities: capabilitiesOf(provider.key),
      priority: registration.priority,
      costModel: registration.costModel,
      costPerQueryUsd: registration.costPerQueryUsd,
      metrics: emptyMetrics(),
      breaker: new CircuitBreaker({ now: this.#now }),
      provider,
    });
    return this;
  }

  get(id: string): ProviderRecord | undefined {
    return this.#records.get(id);
  }

  all(): ProviderRecord[] {
    return [...this.#records.values()];
  }

  get size(): number {
    return this.#records.size;
  }

  /**
   * Les moteurs qu'on peut envisager d'appeler.
   *
   * Trois refus distincts, et la distinction est le fond du sujet : un moteur
   * sans clé n'est pas en panne, un moteur en refroidissement n'est pas inadapté,
   * et un moteur inadapté n'est pas indisponible. Les confondre produit le
   * message « aucun moteur disponible » là où il fallait lire « aucune clé
   * Brave configurée ».
   */
  selectable(): ProviderRecord[] {
    return this.all().filter(
      (record) => record.provider.availability().available && record.breaker.canRequest(),
    );
  }

  /** Enregistre ce qu'un appel réel a appris. Seul point d'entrée des métriques. */
  record(
    id: string,
    outcome: SearchProviderOutcome,
    detail: { durationMs: number; results: number; costUsd: number },
  ): void {
    const record = this.#records.get(id);
    if (!record) return;

    const m = record.metrics;
    m.calls += 1;
    m.totalDurationMs += detail.durationMs;
    m.totalResults += detail.results;
    m.totalCostUsd += detail.costUsd;

    if (outcome === 'ok') m.successes += 1;
    else if (outcome === 'empty') m.emptyResponses += 1;
    else m.failures += 1;

    if (outcome === 'rate-limited') m.rateLimitHits += 1;
  }

  /**
   * La santé d'un moteur, déduite et non mesurée.
   *
   * `unknown` tant qu'aucun appel n'a eu lieu — et ce n'est pas une commodité.
   * Sonder un moteur pour afficher son état, c'est envoyer une requête que
   * personne n'a demandée, à un moteur peut-être en train de nous brider.
   * L'affichage ne doit jamais provoquer le trafic qu'il décrit.
   */
  healthOf(id: string): 'healthy' | 'unhealthy' | 'unknown' {
    const record = this.#records.get(id);
    if (!record) return 'unknown';

    const circuit = record.breaker.state;
    if (circuit === 'open') return 'unhealthy';
    if (record.metrics.calls === 0) return 'unknown';

    const snapshot = record.breaker.snapshot();
    if (snapshot.consecutiveFailures > 0) return 'unhealthy';
    return snapshot.lastSuccessAt ? 'healthy' : 'unknown';
  }

  scoreOf(id: string): ProviderScore | null {
    const record = this.#records.get(id);
    if (!record || record.metrics.calls === 0) return null;

    const m = record.metrics;
    const successRate = m.successes / m.calls;
    const errorRate = m.failures / m.calls;
    const rateLimitFrequency = m.rateLimitHits / m.calls;
    const averageLatencyMs = m.totalDurationMs / m.calls;
    const coverage = m.successes > 0 ? m.totalResults / m.successes : 0;

    // La latence entre dans le score par une décroissance douce : deux secondes
    // valent 0,5, une seconde 0,67. Un seuil dur classerait 1999 ms et 2001 ms
    // dans deux catégories, ce qui ne veut rien dire pour un moteur web.
    const latencyScore = 1 / (1 + averageLatencyMs / 2000);
    // La couverture sature à dix résultats : au-delà, en rendre davantage
    // n'aide pas — le filtrage déterministe coupe de toute façon.
    const coverageScore = Math.min(1, coverage / 10);

    const composite =
      successRate * 0.45 +
      latencyScore * 0.2 +
      coverageScore * 0.2 -
      rateLimitFrequency * 0.25 -
      errorRate * 0.1;

    return {
      successRate: round(successRate),
      errorRate: round(errorRate),
      rateLimitFrequency: round(rateLimitFrequency),
      averageLatencyMs: Math.round(averageLatencyMs),
      coverage: round(coverage),
      composite: round(Math.max(0, Math.min(1, composite))),
      sampleSize: m.calls,
    };
  }

  statusOf(id: string): ProviderStatus | null {
    const record = this.#records.get(id);
    if (!record) return null;

    const availability = record.provider.availability();
    return {
      id: record.id,
      name: record.name,
      health: this.healthOf(id),
      available: availability.available,
      availabilityReason: availability.reason,
      circuit: record.breaker.snapshot(),
      capabilities: record.capabilities,
      priority: record.priority,
      costModel: record.costModel,
      costPerQueryUsd: record.costPerQueryUsd,
      metrics: { ...record.metrics },
      score: this.scoreOf(id),
    };
  }

  statuses(): ProviderStatus[] {
    return this.all()
      .map((record) => this.statusOf(record.id))
      .filter((status): status is ProviderStatus => status !== null);
  }
}

const round = (n: number): number => Number(n.toFixed(4));
