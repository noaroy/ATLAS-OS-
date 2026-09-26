import { AtlasError, describeError } from '@atlas/core';
import { costOfCall } from '../pricing.ts';
import type { LlmProvider, LlmRequest, LlmResponse } from '../types.ts';
import {
  classifyFailure,
  shouldFailover,
  type InferenceProviderRegistry,
  type InferenceStatus,
} from './registry.ts';
import { DEFAULT_ROUTING_POLICY, InferenceRouter, type InferencePlan, type RoutingPolicy } from './router.ts';

/**
 * L'Inference Fabric — plusieurs fournisseurs, un seul contrat.
 *
 * Il implémente {@link LlmProvider}, et ce choix porte tout le module. Le
 * registre budgétaire, la politique de modèles, le runtime des agents, Hermès —
 * tous continuent de parler à « un fournisseur ». Ce fournisseur est devenu un
 * parc, avec bascule et disjoncteurs, sans qu'une ligne en aval ait à le savoir.
 *
 * C'est la même construction que pour la recherche, et elle est justifiée par
 * le même incident. VAL-001 est morte à sa première étape : le compte Anthropic
 * était vide. Aucun repli n'existait, parce qu'il n'existait qu'un fournisseur.
 * Un système censé tourner 24 h/24 ne peut pas dépendre d'un seul compte chez
 * un seul prestataire.
 *
 * Deux garanties valent plus que la bascule elle-même :
 *
 *   **Jamais vers plus cher sans autorisation.** Une bascule se produit quand
 *   quelque chose ne va pas — le pire moment pour décider seul d'augmenter la
 *   facture.
 *
 *   **Jamais vers la simulation en mode réel.** Elle répond toujours, coûte
 *   zéro, et invente. Un repli silencieux vers elle transformerait une panne en
 *   fabrication de données métier, facturée zéro et indiscernable de vrai dans
 *   le rapport final. C'est le seul cas où basculer serait pire que tomber.
 */

export interface InferenceAttempt {
  providerId: string;
  ok: boolean;
  /** Renseigné en cas d'échec : la nature du problème, pas seulement son texte. */
  failureKind: string | null;
  detail: string;
  durationMs: number;
  /** Vrai quand cet échec a fait passer la main au fournisseur suivant. */
  failedOver: boolean;
}

export interface InferenceTrace {
  /** Le fournisseur qui a finalement répondu, ou `null` si aucun n'a abouti. */
  selected: string | null;
  attempts: InferenceAttempt[];
  blocked: boolean;
  blockedReason: string | null;
}

export interface InferenceFabricOptions {
  registry: InferenceProviderRegistry;
  policy?: Partial<RoutingPolicy>;
  /** Combien de fournisseurs essayer au maximum pour une même requête. */
  maxAttempts?: number;
  onFailover?: (attempt: InferenceAttempt, next: string | null) => void;
}

export class InferenceFabric implements LlmProvider {
  /**
   * Le `kind` du fournisseur en tête de file, pas un `kind` propre.
   *
   * La télémétrie enregistre ce champ pour chaque appel ; y écrire « fabric »
   * ferait disparaître des journaux l'information qui compte — qui a réellement
   * répondu.
   */
  readonly kind: LlmProvider['kind'];

  readonly #registry: InferenceProviderRegistry;
  readonly #router: InferenceRouter;
  readonly #policy: RoutingPolicy;
  readonly #maxAttempts: number;
  readonly #onFailover: ((attempt: InferenceAttempt, next: string | null) => void) | undefined;

  #lastTrace: InferenceTrace = { selected: null, attempts: [], blocked: false, blockedReason: null };

  constructor(options: InferenceFabricOptions) {
    this.#registry = options.registry;
    this.#policy = { ...DEFAULT_ROUTING_POLICY, ...options.policy };
    this.#router = new InferenceRouter(options.registry, this.#policy);
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#onFailover = options.onFailover;

    const first = options.registry.all()[0];
    this.kind = first?.kind ?? 'anthropic';
  }

  get registry(): InferenceProviderRegistry {
    return this.#registry;
  }

  statuses(): InferenceStatus[] {
    return this.#registry.statuses();
  }

  lastTrace(): InferenceTrace {
    return this.#lastTrace;
  }

  /** Le plan de routage pour une requête donnée, sans rien appeler. */
  plan(request: LlmRequest): InferencePlan {
    return this.#router.plan(request);
  }

  /**
   * Existe-t-il au moins un fournisseur sain et adapté ?
   *
   * La question que le contrôle avant décollage doit poser — non plus
   * « la clé Anthropic est-elle renseignée ? », qui répondait oui pendant que
   * le compte était vide.
   */
  availability(request: LlmRequest): { available: boolean; reason: string } {
    const plan = this.#router.plan(request);
    if (plan.blocked) {
      return { available: false, reason: plan.blockedReason ?? 'Aucun fournisseur utilisable.' };
    }
    return {
      available: true,
      reason: `${plan.order.length} fournisseur(s) : ${plan.order.map((c) => c.record.id).join(' → ')}.`,
    };
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const plan = this.#router.plan(request);
    const attempts: InferenceAttempt[] = [];

    if (plan.blocked) {
      this.#lastTrace = { selected: null, attempts, blocked: true, blockedReason: plan.blockedReason };
      throw new AtlasError(
        'PROVIDER_ERROR',
        `Inference Fabric indisponible : ${plan.blockedReason}`,
        // Non réessayable : rejouer immédiatement retomberait sur le même parc
        // dans le même état. Ce qui débloque est un geste humain — recharger un
        // compte, poser une clé — ou l'expiration d'un refroidissement.
        { retryable: false },
      );
    }

    const queue = plan.order.slice(0, this.#maxAttempts);
    let lastError: unknown = null;

    for (const [index, candidate] of queue.entries()) {
      const { record } = candidate;

      // Ré-interroger le disjoncteur ici : un fournisseur essayé plus tôt dans
      // cette même boucle a pu s'ouvrir depuis.
      if (!record.breaker.canRequest()) continue;
      record.breaker.beginProbe();

      const started = Date.now();
      try {
        const response = await record.provider.complete(request);
        const durationMs = Date.now() - started;
        // `null` si le tarif du modèle servi est inconnu : jamais zéro.
        const costUsd = costOfCall(response.usage, response.model || request.model);

        this.#registry.recordSuccess(record.id, response, durationMs, costUsd);
        attempts.push({
          providerId: record.id,
          ok: true,
          failureKind: null,
          detail: 'ok',
          durationMs,
          failedOver: false,
        });

        this.#lastTrace = { selected: record.id, attempts, blocked: false, blockedReason: null };
        return response;
      } catch (err) {
        const durationMs = Date.now() - started;
        const failure = classifyFailure(err);
        const worthy = shouldFailover(failure.kind);

        this.#registry.recordFailure(record.id, failure, durationMs);
        lastError = err;

        const attempt: InferenceAttempt = {
          providerId: record.id,
          ok: false,
          failureKind: failure.kind,
          detail: failure.detail.slice(0, 300),
          durationMs,
          failedOver: worthy,
        };
        attempts.push(attempt);

        if (!worthy) {
          // Une requête malformée le restera partout : la relancer ailleurs ne
          // ferait que payer la même erreur une seconde fois.
          this.#lastTrace = { selected: null, attempts, blocked: false, blockedReason: null };
          throw err;
        }

        // Un secours peut n'être éligible qu'une fois le fournisseur principal
        // tombé — un compte vide ne se constate qu'en l'appelant. File épuisée,
        // le plan est donc refait : sans rejouer un fournisseur déjà en file,
        // sans dépasser le nombre de tentatives, et avec toutes les règles du
        // routeur, dont l'exclusion de la simulation en mode réel. L'itérateur
        // du tableau voit les ajouts.
        if (index === queue.length - 1 && queue.length < this.#maxAttempts) {
          const queued = new Set(queue.map((c) => c.record.id));
          const fresh = this.#router.plan(request).order.filter((c) => !queued.has(c.record.id));
          queue.push(...fresh.slice(0, this.#maxAttempts - queue.length));
        }

        this.#onFailover?.(attempt, queue[index + 1]?.record.id ?? null);
      }
    }

    this.#lastTrace = {
      selected: null,
      attempts,
      blocked: true,
      blockedReason: describeExhaustion(attempts),
    };

    throw new AtlasError('PROVIDER_ERROR', describeExhaustion(attempts), {
      retryable: false,
      cause: lastError instanceof Error ? describeError(lastError) : undefined,
    });
  }
}

function describeExhaustion(attempts: InferenceAttempt[]): string {
  if (attempts.length === 0) {
    return "Inference Fabric indisponible : aucun fournisseur n'a pu être interrogé.";
  }
  const chain = attempts.map((a) => `${a.providerId} → ${a.failureKind ?? 'échec'}`).join(' · ');
  return `Inference Fabric épuisé : ${attempts.length} fournisseur(s) essayé(s), tous en échec. ${chain}.`;
}
