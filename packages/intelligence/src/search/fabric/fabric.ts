import { nowIso } from '@atlas/core';
import type { MissionSearchNeed } from '../capabilities.ts';
import type {
  SearchAvailability,
  SearchProvider,
  SearchProviderContext,
  SearchRequest,
  SearchResponse,
} from '../types.ts';
import { isFailoverWorthy, opensImmediately } from './breaker.ts';
import { RateLimiter } from './limiter.ts';
import { SearchProviderRegistry, type ProviderStatus } from './registry.ts';
import { SearchRouter, type RoutingPlan } from './router.ts';

/**
 * Le Search Fabric — plusieurs moteurs, un seul contrat.
 *
 * Il implémente {@link SearchProvider}, et ce choix porte toute la valeur du
 * module. Le pipeline de découverte, le cockpit, le contrôle avant décollage et
 * les scripts continuent de parler à « un moteur » ; ce moteur est devenu un
 * parc, avec bascule automatique, disjoncteurs et cadence — sans qu'une seule
 * ligne en aval ait à le savoir. C'est aussi ce qui rend le futur runtime 24/7
 * possible sans refonte : il branchera un Fabric là où il branchait un moteur.
 *
 * Ce que le Fabric garantit, et que le moteur unique ne garantissait pas :
 *
 *   Une mission n'est bloquée que lorsque **tous** les moteurs adaptés et
 *   autorisés sont indisponibles. « Attendre que DuckDuckGo relâche » cesse
 *   d'être une stratégie ; c'est devenu un cas particulier de bascule.
 *
 * Ce qu'il ne fait pas, délibérément :
 *
 *   Il ne bascule pas sur un résultat vide. Un moteur qui répond « rien » a
 *   répondu ; interroger le suivant reviendrait à chercher jusqu'à ce qu'un
 *   index quelconque rende quelque chose, c'est-à-dire à transformer une
 *   absence honnête en découverte fabriquée.
 *
 *   Il ne contourne aucune protection. Un moteur qui bride est un moteur qui
 *   dit non ; on l'entend, on note, et on va voir ailleurs.
 */

export interface FabricAttempt {
  providerId: string;
  outcome: string;
  detail: string;
  durationMs: number;
  results: number;
  /** Vrai quand cet échec a fait passer la main au moteur suivant. */
  failedOver: boolean;
}

export interface FabricTrace {
  /** Le moteur qui a finalement répondu, ou `null` si aucun n'a abouti. */
  selected: string | null;
  attempts: FabricAttempt[];
  blocked: boolean;
  blockedReason: string | null;
}

export interface SearchFabricOptions {
  registry: SearchProviderRegistry;
  /**
   * Ce que la mission attend d'un moteur.
   *
   * Sans besoin déclaré, le Fabric ne peut pas juger l'adéquation et se
   * rabattrait sur la santé seule — exactement l'erreur qu'il existe pour
   * empêcher. Le défaut est donc volontairement exigeant.
   */
  need: MissionSearchNeed;
  limiter?: RateLimiter;
  /** Combien de moteurs essayer au maximum pour une même requête. */
  maxAttempts?: number;
}

/** Un besoin par défaut : généraliste, commercial, sans contrainte de langue. */
export const OPEN_NEED: MissionSearchNeed = { countries: [], languages: [], commercial: true };

export class SearchFabric implements SearchProvider {
  readonly key = 'fabric';
  readonly label = 'Search Fabric';

  readonly #registry: SearchProviderRegistry;
  readonly #router: SearchRouter;
  readonly #limiter: RateLimiter;
  readonly #need: MissionSearchNeed;
  readonly #maxAttempts: number;

  /** La trace du dernier appel, pour le cockpit. */
  #lastTrace: FabricTrace = { selected: null, attempts: [], blocked: false, blockedReason: null };

  constructor(options: SearchFabricOptions) {
    this.#registry = options.registry;
    this.#router = new SearchRouter(options.registry);
    this.#limiter = options.limiter ?? new RateLimiter();
    this.#need = options.need;
    this.#maxAttempts = options.maxAttempts ?? 3;
  }

  get registry(): SearchProviderRegistry {
    return this.#registry;
  }

  /** Le plan de routage courant, sans rien appeler. */
  plan(need: MissionSearchNeed = this.#need): RoutingPlan {
    return this.#router.plan(need);
  }

  statuses(): ProviderStatus[] {
    return this.#registry.statuses();
  }

  lastTrace(): FabricTrace {
    return this.#lastTrace;
  }

  /**
   * Le Fabric est disponible dès qu'un moteur peut répondre à la mission.
   *
   * C'est la question que le contrôle avant décollage doit poser désormais :
   * non pas « DuckDuckGo répond-il ? » mais « existe-t-il au moins un moteur
   * sain et adapté ? ».
   */
  availability(): SearchAvailability {
    const plan = this.#router.plan(this.#need);
    if (plan.blocked) {
      return { available: false, reason: plan.blockedReason ?? 'Aucun moteur utilisable.' };
    }

    const names = plan.order.map((c) => c.record.id).join(' → ');
    return {
      available: true,
      reason: `${plan.order.length} moteur(s) adaptés, dans l'ordre : ${names}.`,
    };
  }

  async search(request: SearchRequest, ctx: SearchProviderContext): Promise<SearchResponse> {
    const started = Date.now();
    const plan = this.#router.plan(this.#need);
    const attempts: FabricAttempt[] = [];

    if (plan.blocked) {
      this.#lastTrace = {
        selected: null,
        attempts,
        blocked: true,
        blockedReason: plan.blockedReason,
      };
      return {
        results: [],
        outcome: 'unavailable',
        detail: plan.blockedReason ?? 'Search Fabric indisponible.',
        costUsd: 0,
        durationMs: Date.now() - started,
      };
    }

    const queue = plan.order.slice(0, this.#maxAttempts);

    for (const candidate of queue) {
      const { record } = candidate;

      // L'annulation est vérifiée avant chaque moteur, pas seulement au début :
      // une bascule après une annulation enverrait une requête que l'appelant a
      // déjà abandonnée, et la ferait payer à un second moteur.
      if (ctx.signal?.aborted) break;

      // Ré-interroger le disjoncteur ici, et pas seulement au moment du plan :
      // un moteur essayé plus tôt dans cette même boucle a pu s'ouvrir depuis.
      if (!record.breaker.canRequest()) continue;
      record.breaker.beginProbe();

      let release: (() => void) | null = null;
      try {
        release = await this.#limiter.acquire(record.id, ctx.signal);
      } catch {
        // L'attente a été annulée : on ne bascule pas, on s'arrête.
        break;
      }

      let response: SearchResponse;
      try {
        response = await record.provider.search(request, ctx);
      } catch (err) {
        // Un moteur qui lève au lieu de rendre un échec reste un échec du
        // moteur, pas du Fabric. On l'enregistre comme tel et on continue.
        const detail = err instanceof Error ? err.message : String(err);
        record.breaker.recordFailure(detail);
        this.#registry.record(record.id, 'unavailable', {
          durationMs: 0,
          results: 0,
          costUsd: 0,
        });
        attempts.push({
          providerId: record.id,
          outcome: 'unavailable',
          detail,
          durationMs: 0,
          results: 0,
          failedOver: true,
        });
        continue;
      } finally {
        release?.();
      }

      this.#registry.record(record.id, response.outcome, {
        durationMs: response.durationMs,
        results: response.results.length,
        costUsd: response.costUsd,
      });

      const worthy = isFailoverWorthy(response.outcome);

      attempts.push({
        providerId: record.id,
        outcome: response.outcome,
        detail: response.detail,
        durationMs: response.durationMs,
        results: response.results.length,
        failedOver: worthy,
      });

      if (!worthy) {
        // `ok` comme `empty` closent l'appel. Le moteur a répondu ; ce qu'il a
        // répondu appartient au monde, pas à la plomberie.
        record.breaker.recordSuccess();
        this.#lastTrace = {
          selected: record.id,
          attempts,
          blocked: false,
          blockedReason: null,
        };
        return {
          ...response,
          detail: describeSuccess(response, attempts),
          durationMs: Date.now() - started,
        };
      }

      record.breaker.recordFailure(response.detail, opensImmediately(response.outcome));
    }

    // Tous les moteurs de la file ont échoué, ou l'appel a été annulé.
    const aborted = ctx.signal?.aborted === true;
    const reason = aborted
      ? "Recherche annulée avant qu'un moteur ait pu répondre."
      : describeExhaustion(attempts);

    this.#lastTrace = {
      selected: null,
      attempts,
      blocked: !aborted,
      blockedReason: aborted ? null : reason,
    };

    ctx.logger.warn('search fabric épuisé', {
      attempts: attempts.length,
      providers: attempts.map((a) => `${a.providerId}:${a.outcome}`).join(', '),
      aborted,
    });

    return {
      results: [],
      outcome: 'unavailable',
      detail: reason,
      // Les tentatives échouées n'ont rien facturé : un moteur bridé, en délai
      // dépassé ou injoignable n'émet pas de ligne de facture. Les moteurs
      // payants comptabilisent à la réponse, et il n'y a pas eu de réponse.
      costUsd: 0,
      durationMs: Date.now() - started,
    };
  }
}

function describeSuccess(response: SearchResponse, attempts: FabricAttempt[]): string {
  const failedOver = attempts.filter((a) => a.failedOver);
  if (failedOver.length === 0) return response.detail;

  // La bascule doit se lire dans le détail, pas seulement dans les journaux :
  // un résultat obtenu au troisième moteur n'a pas la même valeur qu'un
  // résultat obtenu au premier, et le rapport final doit pouvoir le dire.
  const chain = failedOver.map((a) => `${a.providerId} (${a.outcome})`).join(' → ');
  return `${response.detail} [bascule après ${chain}]`;
}

function describeExhaustion(attempts: FabricAttempt[]): string {
  if (attempts.length === 0) {
    return 'Search Fabric indisponible : aucun moteur n’a pu être interrogé.';
  }
  const chain = attempts.map((a) => `${a.providerId} → ${a.outcome}`).join(' · ');
  return (
    `Search Fabric indisponible : ${attempts.length} moteur(s) essayés, tous en échec. ${chain}. ` +
    `Relevé à ${nowIso()}.`
  );
}
