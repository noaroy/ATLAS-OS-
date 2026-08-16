/**
 * L'espacement des requêtes.
 *
 * Le bridage de DuckDuckGo n'est pas venu d'un volume : quatre recherches en
 * 1,3 seconde ont suffi. Un moteur public lit une rafale comme un robot, et il
 * a raison — c'en était un. Le correctif n'est donc pas de chercher moins,
 * c'est de chercher au rythme d'un usage plausible.
 *
 * Deux niveaux, parce qu'ils protègent deux choses différentes :
 *
 *   Le limiteur **par moteur** protège le moteur de nous. Chacun a sa propre
 *   tolérance ; SearXNG auto-hébergé n'a aucune raison d'attendre 1,1 s entre
 *   deux requêtes, DuckDuckGo si.
 *
 *   Le limiteur **global** nous protège de nous-mêmes. Sans lui, trois missions
 *   simultanées respecteraient chacune leur cadence par moteur tout en
 *   produisant, ensemble, exactement la rafale qu'on voulait éviter.
 *
 * La gigue n'est pas une décoration. Des requêtes espacées de 1100 ms exactement
 * sont plus reconnaissables comme automatiques que des requêtes espacées de 1000
 * à 1400 ms : une régularité parfaite est une signature.
 */

export interface LimiterOptions {
  /** Attente minimale entre deux requêtes d'un même moteur. */
  minIntervalMs: number;
  /**
   * Cadences propres à certains moteurs, qui l'emportent sur `minIntervalMs`.
   *
   * Passer `{}` ramène tout le parc à la cadence générale — ce que font les
   * tests, qui n'ont aucune raison d'attendre 1,1 s pour vérifier une bascule.
   * Une table codée en dur que l'option ne pouvait pas contourner rendait
   * `minIntervalMs` mensonger : on le posait à zéro et DuckDuckGo attendait
   * quand même.
   */
  perProvider: Record<string, number>;
  /** Gigue ajoutée, tirée dans [0, jitterMs). */
  jitterMs: number;
  /** Requêtes simultanées autorisées, tous moteurs confondus. */
  maxConcurrent: number;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    if (signal?.aborted) return reject(new Error('aborted'));

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    // Une annulation pendant l'attente doit libérer immédiatement : garder le
    // minuteur en vie ferait payer à l'appelant une seconde qu'il a annulée.
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Cadences propres à chaque moteur, quand elles diffèrent du défaut. */
export const PER_PROVIDER_INTERVAL: Record<string, number> = {
  // Auto-hébergé : la seule limite est celle de la machine qui l'exécute.
  searxng: 200,
  // Payant et contractuel : le quota est la limite, pas la politesse.
  brave: 300,
  // Petit index bénévole. Ralentir davantage relève de la courtoisie, pas de la
  // contrainte technique — mais c'est une courtoisie qui garde l'accès ouvert.
  marginalia: 1500,
  duckduckgo: 1100,
};

export const DEFAULT_LIMITER: Omit<LimiterOptions, 'now' | 'sleep' | 'random'> = {
  minIntervalMs: 1100,
  jitterMs: 400,
  maxConcurrent: 2,
  perProvider: PER_PROVIDER_INTERVAL,
};

export class RateLimiter {
  #lastRequestAt = new Map<string, number>();
  #inFlight = 0;
  #waiters: Array<() => void> = [];
  readonly #options: LimiterOptions;

  constructor(options: Partial<LimiterOptions> = {}) {
    this.#options = {
      ...DEFAULT_LIMITER,
      now: () => Date.now(),
      sleep: defaultSleep,
      random: Math.random,
      ...options,
    };
  }

  /** L'attente qu'un moteur doit encore observer, en millisecondes. */
  delayFor(providerKey: string): number {
    const interval = this.#options.perProvider[providerKey] ?? this.#options.minIntervalMs;
    const last = this.#lastRequestAt.get(providerKey);
    if (last === undefined) return 0;

    const elapsed = this.#options.now() - last;
    const jitter = Math.floor(this.#options.random() * this.#options.jitterMs);
    return Math.max(0, interval + jitter - elapsed);
  }

  /**
   * Attend son tour, puis rend la fonction qui libère la place.
   *
   * Le jeton de libération est rendu plutôt qu'appelé automatiquement : c'est
   * l'appelant qui sait quand sa requête est vraiment finie, et une libération
   * anticipée rouvrirait la porte à la rafale qu'on vient de fermer.
   */
  async acquire(providerKey: string, signal?: AbortSignal): Promise<() => void> {
    // D'abord la concurrence globale, ensuite la cadence par moteur. L'ordre
    // inverse ferait dormir un appelant pour son moteur, puis attendre encore
    // un créneau global — deux attentes empilées pour une seule requête.
    await this.#acquireSlot(signal);

    try {
      const wait = this.delayFor(providerKey);
      if (wait > 0) await this.#options.sleep(wait, signal);
    } catch (err) {
      this.#releaseSlot();
      throw err;
    }

    this.#lastRequestAt.set(providerKey, this.#options.now());

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#releaseSlot();
    };
  }

  async #acquireSlot(signal?: AbortSignal): Promise<void> {
    if (this.#inFlight < this.#options.maxConcurrent) {
      this.#inFlight += 1;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        reject(new Error('aborted'));
      };
      const waiter = (): void => {
        signal?.removeEventListener('abort', onAbort);
        this.#inFlight += 1;
        resolve();
      };
      this.#waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  #releaseSlot(): void {
    this.#inFlight = Math.max(0, this.#inFlight - 1);
    const next = this.#waiters.shift();
    if (next) next();
  }

  /** Pour les tests et pour l'observabilité. */
  get inFlight(): number {
    return this.#inFlight;
  }

  get queued(): number {
    return this.#waiters.length;
  }
}
