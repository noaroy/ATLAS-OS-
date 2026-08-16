import { estimateInputTokens } from '../budget.ts';
import type { LlmRequest } from '../types.ts';
import { assessInferenceSuitability, type InferenceSuitability } from './capabilities.ts';
import {
  announcedCostPerMTokens,
  type InferenceProviderRegistry,
  type InferenceRecord,
} from './registry.ts';

/**
 * Quel fournisseur d'inférence interroger, et dans quel ordre.
 *
 * Entièrement déterministe, comme le routage de la recherche et pour les mêmes
 * raisons : demander à un modèle quel fournisseur employer supposerait qu'un
 * modèle réponde, ce qui est précisément la chose dont on doute quand ce
 * routage devient nécessaire.
 *
 * L'ordre des critères est celui du fondateur :
 *
 *   1. ADÉQUATION — un fournisseur incapable de servir la requête n'est jamais
 *      choisi, quel que soit le reste.
 *   2. SANTÉ — sain devant inconnu devant en panne. Jamais devant l'adéquation.
 *   3. COÛT — à qualité égale, le moins cher.
 *   4. LATENCE et 5. HISTORIQUE — mesurés, jamais supposés.
 *   6. PRIORITÉ — le dernier mot de la configuration.
 *
 * Deux règles s'ajoutent, propres à l'inférence, et elles sont plus
 * importantes que le tri lui-même.
 *
 * **On ne bascule jamais vers plus cher sans autorisation.** Un secours qui
 * coûte trois fois le prix transforme une panne en dépense imprévue, et la
 * bascule se déclenche justement quand personne ne regarde.
 *
 * **On ne bascule jamais vers la simulation en mode réel.** Elle est gratuite,
 * instantanée, capable de tout — et ses réponses sont fabriquées. Un repli
 * silencieux vers elle produirait des données métier inventées, facturées zéro,
 * indiscernables de vraies dans le rapport final. C'est le seul scénario où la
 * bascule serait pire que la panne.
 */

export interface InferenceCandidate {
  record: InferenceRecord;
  suitability: InferenceSuitability;
  health: 'healthy' | 'unhealthy' | 'unknown';
  /** Coût annoncé par million de jetons, ou `null` si le tarif est inconnu. */
  costPerMTokens: number | null;
  /** Pourquoi ce fournisseur a été écarté, s'il l'a été. */
  excluded: string | null;
}

export interface InferencePlan {
  /** Les fournisseurs retenus, dans l'ordre où ils seront essayés. */
  order: InferenceCandidate[];
  /** Tous ceux examinés, retenus ou non — c'est ce que le cockpit affiche. */
  considered: InferenceCandidate[];
  blocked: boolean;
  blockedReason: string | null;
}

export interface RoutingPolicy {
  /**
   * Le mode d'exécution du déploiement.
   *
   * En `live`, la simulation est structurellement exclue du routage. Ce n'est
   * pas un réglage : c'est ce qui empêche une panne de se transformer en
   * fabrication de données.
   */
  mode: 'simulation' | 'live';
  /**
   * Autoriser une bascule vers un fournisseur plus cher que celui d'origine.
   *
   * Faux par défaut, délibérément. Une bascule se produit quand quelque chose
   * ne va pas ; c'est le pire moment pour décider seul d'augmenter la facture.
   */
  allowCostlierFailover: boolean;
  /** Multiplicateur toléré malgré tout, pour absorber les écarts de tarification. */
  costTolerance: number;
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  mode: 'live',
  allowCostlierFailover: false,
  costTolerance: 1.0,
};

const HEALTH_RANK: Record<string, number> = { healthy: 0, unknown: 1, unhealthy: 2 };
const SUITABILITY_RANK: Record<string, number> = { suitable: 0, degraded: 1, unsuitable: 2 };

export class InferenceRouter {
  constructor(
    private readonly registry: InferenceProviderRegistry,
    private readonly policy: RoutingPolicy = DEFAULT_ROUTING_POLICY,
  ) {}

  plan(request: LlmRequest): InferencePlan {
    const estimatedInputTokens = estimateInputTokens(request);
    const referenceCost = announcedCostPerMTokens(request.model);

    const considered: InferenceCandidate[] = this.registry.all().map((record) => {
      const suitability = assessInferenceSuitability(record.capabilities, {
        model: request.model,
        jsonSchema: request.jsonSchema,
        tools: request.tools,
        serverTools: request.serverTools,
        maxTokens: request.maxTokens,
        estimatedInputTokens,
      });
      const health = this.registry.healthOf(record.id);
      const availability = record.available();
      // Le tarif du modèle que *ce* fournisseur servirait, pas celui demandé.
      // Les comparer tous deux au modèle demandé produisait une égalité
      // systématique, et la règle « jamais vers plus cher » ne s'appliquait
      // jamais — un garde-fou qui ne gardait rien.
      const costPerMTokens = announcedCostPerMTokens(record.substituteModel ?? request.model);

      const excluded = this.#exclusionFor(record, {
        suitability,
        availability,
        referenceCost,
        costPerMTokens,
      });

      return { record, suitability, health, costPerMTokens, excluded };
    });

    const order = considered
      .filter((candidate) => candidate.excluded === null)
      .sort((a, b) => this.#compare(a, b));

    return {
      order,
      considered,
      blocked: order.length === 0,
      blockedReason: order.length === 0 ? describeBlockage(considered) : null,
    };
  }

  #exclusionFor(
    record: InferenceRecord,
    context: {
      suitability: InferenceSuitability;
      availability: { available: boolean; reason: string };
      referenceCost: number | null;
      costPerMTokens: number | null;
    },
  ): string | null {
    // L'ordre des exclusions décide de ce que l'opérateur lit en premier, donc
    // de ce qu'il ira corriger. Une clé absente se règle en une minute ; une
    // incapacité structurelle ne se règle pas du tout.
    if (this.policy.mode === 'live' && record.kind === 'simulation') {
      return 'simulation exclue du mode réel — un repli silencieux fabriquerait des données métier';
    }
    if (!context.availability.available) return context.availability.reason;
    if (context.suitability.verdict === 'unsuitable') {
      return `inadapté à cette requête : ${context.suitability.gaps.join(' · ')}`;
    }
    if (record.credit === 'exhausted') {
      return 'compte épuisé — le service répond, mais aucun appel ne peut aboutir';
    }
    if (record.breaker.state === 'open') {
      const remaining = record.breaker.snapshot().cooldownRemainingMs;
      return `circuit ouvert — refroidissement ${Math.ceil(remaining / 60_000)} min`;
    }
    if (
      !this.policy.allowCostlierFailover &&
      context.referenceCost !== null &&
      context.costPerMTokens !== null &&
      context.costPerMTokens > context.referenceCost * this.policy.costTolerance
    ) {
      return (
        `plus cher que le fournisseur d'origine ` +
        `(${context.costPerMTokens.toFixed(2)} $ contre ${context.referenceCost.toFixed(2)} $ par million) — ` +
        `bascule non autorisée`
      );
    }
    return null;
  }

  #compare(a: InferenceCandidate, b: InferenceCandidate): number {
    const suitability =
      SUITABILITY_RANK[a.suitability.verdict]! - SUITABILITY_RANK[b.suitability.verdict]!;
    if (suitability !== 0) return suitability;

    const health = HEALTH_RANK[a.health]! - HEALTH_RANK[b.health]!;
    if (health !== 0) return health;

    // Le coût. Un fournisseur local ne facture rien : il passe devant à
    // adéquation et santé égales, ce qui est le comportement souhaité pour un
    // déploiement qui héberge son propre modèle.
    const localA = a.record.costModel === 'local' || a.record.costModel === 'free' ? 0 : 1;
    const localB = b.record.costModel === 'local' || b.record.costModel === 'free' ? 0 : 1;
    if (localA !== localB) return localA - localB;

    if (a.costPerMTokens !== null && b.costPerMTokens !== null && a.costPerMTokens !== b.costPerMTokens) {
      return a.costPerMTokens - b.costPerMTokens;
    }

    // Historique mesuré. Un fournisseur sans historique ne participe pas à
    // cette comparaison : il tombe au départage par priorité, où la
    // configuration décide. Lui prêter une qualité non observée serait inventer.
    const scoreA = this.registry.scoreOf(a.record.id);
    const scoreB = this.registry.scoreOf(b.record.id);
    if (scoreA && scoreB) {
      if (scoreB.composite !== scoreA.composite) return scoreB.composite - scoreA.composite;
      if (scoreA.averageLatencyMs !== scoreB.averageLatencyMs) {
        return scoreA.averageLatencyMs - scoreB.averageLatencyMs;
      }
    }

    if (a.record.priority !== b.record.priority) return a.record.priority - b.record.priority;
    return a.record.id.localeCompare(b.record.id);
  }
}

/**
 * Pourquoi aucun fournisseur ne convient.
 *
 * Les causes sont distinguées parce qu'elles appellent des gestes différents :
 * recharger un compte, configurer une clé, attendre un refroidissement, ou
 * renoncer à cette requête avec ce parc. « Aucun fournisseur disponible » ne dit
 * lequel des quatre — et c'est exactement la phrase qui a fait chercher une
 * panne réseau pendant que le compte était vide.
 */
function describeBlockage(considered: InferenceCandidate[]): string {
  if (considered.length === 0) {
    return "Aucun fournisseur d'inférence n'est enregistré.";
  }

  const exhausted = considered.filter((c) => c.record.credit === 'exhausted');
  const cooling = considered.filter(
    (c) => c.record.credit !== 'exhausted' && c.record.breaker.state === 'open',
  );
  const unconfigured = considered.filter((c) => !c.record.available().available);
  const unsuitable = considered.filter((c) => c.suitability.verdict === 'unsuitable');

  const parts: string[] = [];
  if (exhausted.length > 0) {
    parts.push(`${exhausted.map((c) => c.record.id).join(', ')} : compte épuisé`);
  }
  if (cooling.length > 0) {
    const soonest = Math.min(...cooling.map((c) => c.record.breaker.snapshot().cooldownRemainingMs));
    parts.push(
      `${cooling.map((c) => c.record.id).join(', ')} en refroidissement ` +
        `(${Math.ceil(soonest / 60_000)} min)`,
    );
  }
  if (unsuitable.length > 0) {
    parts.push(`${unsuitable.map((c) => c.record.id).join(', ')} : inadapté à cette requête`);
  }
  if (unconfigured.length > 0) {
    parts.push(`${unconfigured.map((c) => c.record.id).join(', ')} : non configuré`);
  }

  return `Aucun fournisseur d'inférence utilisable — ${parts.join(' · ')}.`;
}
