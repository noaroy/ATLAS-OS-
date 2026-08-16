/**
 * Le disjoncteur d'un moteur.
 *
 * Un moteur qui bride une adresse bride plus longtemps si on insiste. C'est la
 * propriété qui rend le réessai naïf plus nuisible que l'attente : chaque
 * requête envoyée pendant le bridage repousse la fin du bridage, si bien qu'un
 * système qui « réessaie jusqu'à ce que ça marche » ne se rétablit jamais.
 * ATLAS a passé deux jours à attendre DuckDuckGo pour cette raison exacte.
 *
 * Trois états, et un seul chemin pour revenir :
 *
 *   CLOSED    — le moteur sert normalement.
 *   OPEN      — aucune requête ne part. On attend, sans sonder.
 *   HALF_OPEN — **une seule** sonde. Elle décide : succès → CLOSED, échec → OPEN.
 *
 * La sonde unique est ce qui distingue un disjoncteur d'une boucle de test. En
 * HALF_OPEN, la deuxième requête concurrente est refusée : sans cela, dix
 * requêtes en attente partiraient toutes à la seconde où le refroidissement
 * expire, et ce serait précisément la rafale qui a causé le bridage.
 *
 * Le refroidissement croît avec les échecs consécutifs. Un moteur qui échoue
 * une fois peut avoir eu un hoquet ; un moteur qui échoue cinq fois de suite
 * dit quelque chose de plus durable, et le sonder toutes les minutes revient à
 * le marteler poliment.
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface BreakerOptions {
  /** Échecs consécutifs avant ouverture. */
  failureThreshold: number;
  /** Premier refroidissement, en millisecondes. */
  baseCooldownMs: number;
  /** Plafond du refroidissement, quel que soit le nombre d'échecs. */
  maxCooldownMs: number;
  /** L'horloge, injectable pour que les tests n'attendent pas réellement. */
  now: () => number;
}

export const DEFAULT_BREAKER: Omit<BreakerOptions, 'now'> = {
  failureThreshold: 2,
  // Deux minutes après le premier bridage, puis 4, 8, 16… jusqu'à une heure.
  // Un moteur qui bride le fait rarement pour quelques secondes.
  baseCooldownMs: 2 * 60 * 1000,
  maxCooldownMs: 60 * 60 * 1000,
};

export interface BreakerSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  cooldownUntil: string | null;
  /** Combien de temps avant la prochaine sonde, en millisecondes. */
  cooldownRemainingMs: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
}

export class CircuitBreaker {
  #state: CircuitState = 'closed';
  #consecutiveFailures = 0;
  #cooldownUntil = 0;
  #lastSuccessAt: number | null = null;
  #lastFailureAt: number | null = null;
  #lastFailureReason: string | null = null;
  /** Vrai quand une sonde est en vol. Empêche la deuxième. */
  #probeInFlight = false;

  readonly #options: BreakerOptions;

  constructor(options: Partial<BreakerOptions> & { now?: () => number } = {}) {
    this.#options = { ...DEFAULT_BREAKER, now: () => Date.now(), ...options };
  }

  get state(): CircuitState {
    // L'état se déduit de l'horloge, il n'est pas piloté par un minuteur. Un
    // minuteur suppose un processus qui tourne sans interruption ; ATLAS doit
    // se réveiller cohérent après une pause, un arrêt, ou un redéploiement.
    if (this.#state === 'open' && this.#options.now() >= this.#cooldownUntil) {
      this.#state = 'half-open';
    }
    return this.#state;
  }

  /**
   * Ce moteur peut-il recevoir une requête maintenant ?
   *
   * En demi-ouverture, seul le premier appelant obtient l'autorisation : c'est
   * la sonde. Les autres sont refusés jusqu'à ce qu'elle ait tranché.
   */
  canRequest(): boolean {
    const state = this.state;
    if (state === 'closed') return true;
    if (state === 'open') return false;
    return !this.#probeInFlight;
  }

  /** Réserve la sonde. À appeler juste avant de partir, si l'état est demi-ouvert. */
  beginProbe(): void {
    if (this.state === 'half-open') this.#probeInFlight = true;
  }

  recordSuccess(): void {
    this.#state = 'closed';
    this.#consecutiveFailures = 0;
    this.#cooldownUntil = 0;
    this.#lastSuccessAt = this.#options.now();
    this.#lastFailureReason = null;
    this.#probeInFlight = false;
  }

  /**
   * Enregistre un échec et ouvre le circuit s'il le faut.
   *
   * `immediate` court-circuite le seuil : un HTTP 429 n'est pas un incident
   * dont on attend confirmation, c'est le moteur qui dit explicitement d'arrêter.
   * Attendre un second 429 pour le croire, c'est envoyer la requête qui aggrave
   * le bridage.
   */
  recordFailure(reason: string, immediate = false): void {
    this.#consecutiveFailures += 1;
    this.#lastFailureAt = this.#options.now();
    this.#lastFailureReason = reason;
    this.#probeInFlight = false;

    const shouldOpen = immediate || this.#consecutiveFailures >= this.#options.failureThreshold;
    if (!shouldOpen) {
      this.#state = 'closed';
      return;
    }

    // Le refroidissement double à chaque échec consécutif au-delà du premier.
    const exponent = Math.max(0, this.#consecutiveFailures - 1);
    const cooldown = Math.min(
      this.#options.maxCooldownMs,
      this.#options.baseCooldownMs * 2 ** exponent,
    );

    this.#state = 'open';
    this.#cooldownUntil = this.#options.now() + cooldown;
  }

  /** Rouvre immédiatement, pour un opérateur qui sait que la cause est levée. */
  reset(): void {
    this.#state = 'closed';
    this.#consecutiveFailures = 0;
    this.#cooldownUntil = 0;
    this.#probeInFlight = false;
  }

  snapshot(): BreakerSnapshot {
    const state = this.state;
    const remaining = Math.max(0, this.#cooldownUntil - this.#options.now());
    return {
      state,
      consecutiveFailures: this.#consecutiveFailures,
      cooldownUntil: this.#cooldownUntil > 0 ? new Date(this.#cooldownUntil).toISOString() : null,
      cooldownRemainingMs: state === 'open' ? remaining : 0,
      lastSuccessAt: this.#lastSuccessAt ? new Date(this.#lastSuccessAt).toISOString() : null,
      lastFailureAt: this.#lastFailureAt ? new Date(this.#lastFailureAt).toISOString() : null,
      lastFailureReason: this.#lastFailureReason,
    };
  }
}

/**
 * Cet échec justifie-t-il de basculer vers un autre moteur ?
 *
 * Le tri compte. `empty` n'est pas un échec : le moteur a répondu, il n'y avait
 * rien. Basculer sur un résultat vide reviendrait à interroger tous les moteurs
 * jusqu'à ce que l'un d'eux invente quelque chose — c'est-à-dire à transformer
 * une absence honnête en découverte fabriquée.
 */
export const isFailoverWorthy = (outcome: string): boolean =>
  outcome === 'timeout' ||
  outcome === 'rate-limited' ||
  outcome === 'http-error' ||
  outcome === 'unavailable';

/**
 * Cet échec doit-il ouvrir le circuit sans attendre le seuil ?
 *
 * Le bridage, oui : le moteur a dit d'arrêter. Un délai dépassé ou une erreur
 * serveur, non — ce sont des incidents dont on attend confirmation avant de
 * retirer un moteur du service.
 */
export const opensImmediately = (outcome: string): boolean => outcome === 'rate-limited';
