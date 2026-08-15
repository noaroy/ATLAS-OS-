import { AtlasError, toAtlasError, timeout as timeoutError } from './errors.ts';
import { sleep } from './time.ts';

export interface RetryOptions {
  attempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Decides whether a given failure is worth another attempt. */
  shouldRetry?: (error: AtlasError, attempt: number) => boolean;
  onRetry?: (error: AtlasError, attempt: number, delayMs: number) => void;
  signal?: AbortSignal;
}

/**
 * Exponential backoff with full jitter.
 *
 * Jitter matters because agents fail in correlated bursts (a provider hiccup
 * hits every running task at once); without it they would all retry in lockstep.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const base = options.baseDelayMs ?? 500;
  const max = options.maxDelayMs ?? 15_000;
  const shouldRetry = options.shouldRetry ?? ((e) => e.retryable);

  let lastError: AtlasError | undefined;
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const error = toAtlasError(err);
      lastError = error;
      if (attempt >= options.attempts || !shouldRetry(error, attempt)) throw error;

      const ceiling = Math.min(max, base * 2 ** (attempt - 1));
      const delay = Math.round(Math.random() * ceiling);
      options.onRetry?.(error, attempt, delay);
      await sleep(delay, options.signal);
    }
  }
  throw lastError ?? new AtlasError('INTERNAL', 'retry exhausted with no error recorded');
}

/**
 * Rejects with a `TIMEOUT` AtlasError if the promise outlives `ms`.
 *
 * Attention : la promesse perdante n'est pas interrompue, seulement ignorée.
 * Réservé au travail purement local, dont l'abandon ne coûte rien. Pour tout
 * ce qui sort d'ATLAS — inférence, HTTP, provider — utilisez
 * {@link withDeadline}, qui annule réellement.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(`${label} exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface DeadlineOptions {
  /** Délai avant annulation. `0` ou moins désactive la borne. */
  ms: number;
  /** Nommé dans l'erreur et dans les journaux. */
  label: string;
  /** Annulation venue de plus haut : étape, mission, arrêt du serveur. */
  signal?: AbortSignal;
  /**
   * Combien de temps attendre, après l'annulation, que l'appel se dénoue.
   *
   * Un appelant qui honore son signal rend la main presque aussitôt. Passé ce
   * délai, on rend la main à l'orchestrateur malgré tout et on journalise le
   * manquement : mieux vaut une étape qui se termine et un avertissement
   * qu'une mission figée pour toujours.
   */
  graceMs?: number;
  onOrphan?: (label: string) => void;
}

/**
 * Borne un appel externe par une annulation réelle.
 *
 * `withTimeout` place une course entre la promesse et une minuterie : le
 * perdant est ignoré, jamais interrompu. LIVE #002 en a montré le prix — une
 * recherche web est restée en vol 1 284 secondes alors que le délai d'étape
 * était de 300, parce que personne n'avait dit à l'appel de s'arrêter.
 *
 * Ici le travail reçoit un `AbortSignal` et c'est lui qu'on déclenche. La
 * différence est de fond : la course *abandonne* une promesse qui continue de
 * consommer socket, contexte et budget ; l'annulation *arrête* le travail.
 *
 * Le signal transmis combine la borne locale et celle de l'appelant, si bien
 * qu'une annulation venue de la mission descend jusqu'au fournisseur sans que
 * chaque niveau ait à la relayer à la main.
 */
export async function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  options: DeadlineOptions,
): Promise<T> {
  const { ms, label, signal: parent, graceMs = 5_000 } = options;

  if (parent?.aborted) throw timeoutError(`${label} was cancelled before it started`);
  if (ms <= 0) return run(parent ?? new AbortController().signal);

  const controller = new AbortController();
  let expired = false;

  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, ms);

  const relay = (): void => controller.abort();
  parent?.addEventListener('abort', relay, { once: true });

  try {
    // Attendu, pas mis en course : c'est ce qui garantit qu'aucune promesse
    // ne survit à son propre délai.
    return await raceGrace(run(controller.signal), () => expired, graceMs, label, options.onOrphan);
  } catch (err) {
    if (expired) throw timeoutError(`${label} exceeded ${ms}ms and was cancelled`);
    if (parent?.aborted) throw timeoutError(`${label} was cancelled`);
    throw err;
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', relay);
  }
}

/**
 * Dernier recours : un appelant qui ignore son annulation ne doit pas pouvoir
 * bloquer la mission indéfiniment.
 *
 * La course n'est armée qu'*après* l'annulation, et seulement pour la durée de
 * grâce. Un appel qui honore son signal ne la rencontre jamais.
 */
async function raceGrace<T>(
  work: Promise<T>,
  expired: () => boolean,
  graceMs: number,
  label: string,
  onOrphan?: (label: string) => void,
): Promise<T> {
  if (graceMs <= 0) return work;

  let settled = false;
  work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      const poll = setInterval(() => {
        if (settled) {
          clearInterval(poll);
          return;
        }
        if (!expired()) return;
        clearInterval(poll);
        setTimeout(() => {
          if (settled) return;
          onOrphan?.(label);
          reject(timeoutError(`${label} did not unwind after cancellation`));
        }, graceMs).unref?.();
      }, 50).unref?.();
    }),
  ]);
}

/**
 * Runs tasks with bounded concurrency, preserving input order in the result.
 * Used wherever the orchestrator fans out independent work.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Serialises access to a resource. The orchestrator uses one per mission so
 * concurrent task completions can never interleave a status write.
 */
export class Mutex {
  #queue: Array<() => void> = [];
  #locked = false;

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await fn();
    } finally {
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (!this.#locked) {
      this.#locked = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#queue.push(resolve));
  }

  #release(): void {
    const next = this.#queue.shift();
    if (next) next();
    else this.#locked = false;
  }
}
