import { assessSuitability, type MissionSearchNeed, type SuitabilityReport } from '../capabilities.ts';
import type { ProviderRecord, SearchProviderRegistry } from './registry.ts';

/**
 * Qui interroger, et dans quel ordre.
 *
 * Entièrement déterministe. Aucun modèle n'intervient dans ce choix, et ce
 * n'est pas une économie : demander à un modèle quel moteur employer, c'est
 * payer un appel pour obtenir une réponse qu'un tri rend exactement, plus
 * lentement, et sans garantie qu'elle soit la même deux fois de suite. Un
 * routage qui varie d'une exécution à l'autre rend tout incident irreproductible.
 *
 * L'ordre des critères est celui de la mission, et il n'est pas négociable :
 *
 *   1. ADÉQUATION — un moteur inadapté n'est jamais choisi, quel que soit le
 *      reste. C'est la règle qui a coûté deux missions à ne pas exister.
 *   2. SANTÉ — un moteur sain passe devant un moteur inconnu, qui passe devant
 *      un moteur en panne. Mais jamais devant l'adéquation.
 *   3. COÛT — à qualité égale, le gratuit d'abord.
 *   4. LATENCE et 5. HISTORIQUE — mesurés, jamais supposés.
 *   6. PRIORITÉ — le dernier mot de la configuration, quand tout le reste égalise.
 *
 * Le point le plus important tient en une phrase : **on ne choisit jamais un
 * moteur au seul motif qu'il répond.** Marginalia répondait en 300 ms et ne
 * savait rien du marché allemand ; il était le plus sain et le plus rapide de
 * tous, et c'est exactement pourquoi il a été choisi, et pourquoi la mission a
 * conclu qu'il n'existait aucun distributeur en Allemagne.
 */

export interface RoutingCandidate {
  record: ProviderRecord;
  suitability: SuitabilityReport;
  health: 'healthy' | 'unhealthy' | 'unknown';
  /** Pourquoi ce moteur a été écarté, s'il l'a été. */
  excluded: string | null;
}

export interface RoutingPlan {
  /** Les moteurs retenus, dans l'ordre où ils seront essayés. */
  order: RoutingCandidate[];
  /** Tous les moteurs examinés, retenus ou non — c'est ce que le cockpit affiche. */
  considered: RoutingCandidate[];
  /** Vrai quand aucun moteur ne peut répondre à cette mission. */
  blocked: boolean;
  /** La raison du blocage, rédigée pour être lue par le fondateur. */
  blockedReason: string | null;
}

const HEALTH_RANK: Record<string, number> = { healthy: 0, unknown: 1, unhealthy: 2 };
const SUITABILITY_RANK: Record<string, number> = { suitable: 0, degraded: 1, unsuitable: 2 };
const COST_RANK: Record<string, number> = { free: 0, 'self-hosted': 0, metered: 1 };

export class SearchRouter {
  constructor(private readonly registry: SearchProviderRegistry) {}

  /**
   * Établit l'ordre d'essai pour un besoin donné.
   *
   * Rend toujours un plan, même vide. Un routeur qui lève quand il ne trouve
   * rien oblige chaque appelant à distinguer « pas de moteur » d'une panne du
   * routeur lui-même ; ici l'absence de moteur est un résultat, avec sa raison.
   */
  plan(need: MissionSearchNeed): RoutingPlan {
    const considered: RoutingCandidate[] = this.registry.all().map((record) => {
      const suitability = assessSuitability(record.provider, need);
      const health = this.registry.healthOf(record.id);
      const availability = record.provider.availability();
      const circuit = record.breaker.state;

      // L'ordre des exclusions décide de ce que l'opérateur lit en premier, et
      // donc de ce qu'il ira corriger. Une clé absente se règle en une minute ;
      // une inadéquation d'index ne se règle pas du tout.
      const excluded = !availability.available
        ? availability.reason
        : suitability.verdict === 'unsuitable'
          ? `inadapté à cette mission : ${suitability.gaps.join(' · ')}`
          : circuit === 'open'
            ? `circuit ouvert — refroidissement en cours (${Math.ceil(record.breaker.snapshot().cooldownRemainingMs / 60_000)} min)`
            : null;

      return { record, suitability, health, excluded };
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

  #compare(a: RoutingCandidate, b: RoutingCandidate): number {
    // 1. Adéquation. Rien ne passe devant.
    const suitability =
      SUITABILITY_RANK[a.suitability.verdict]! - SUITABILITY_RANK[b.suitability.verdict]!;
    if (suitability !== 0) return suitability;

    // 2. Santé.
    const health = HEALTH_RANK[a.health]! - HEALTH_RANK[b.health]!;
    if (health !== 0) return health;

    // 3. Coût. Gratuit et auto-hébergé sont à égalité : les deux ne facturent rien.
    const cost = COST_RANK[a.record.costModel]! - COST_RANK[b.record.costModel]!;
    if (cost !== 0) return cost;
    if (a.record.costPerQueryUsd !== b.record.costPerQueryUsd) {
      return a.record.costPerQueryUsd - b.record.costPerQueryUsd;
    }

    // 4 et 5. Historique mesuré. Un moteur sans historique ne participe pas à
    // cette comparaison : il tombe au départage par priorité, où la
    // configuration décide. Le classer d'office devant ou derrière reviendrait
    // à lui prêter une qualité qu'on n'a pas observée.
    const scoreA = this.registry.scoreOf(a.record.id);
    const scoreB = this.registry.scoreOf(b.record.id);
    if (scoreA && scoreB) {
      if (scoreB.composite !== scoreA.composite) return scoreB.composite - scoreA.composite;
      if (scoreA.averageLatencyMs !== scoreB.averageLatencyMs) {
        return scoreA.averageLatencyMs - scoreB.averageLatencyMs;
      }
    }

    // 6. Priorité configurée.
    if (a.record.priority !== b.record.priority) return a.record.priority - b.record.priority;
    return a.record.id.localeCompare(b.record.id);
  }
}

/**
 * Pourquoi aucun moteur ne convient.
 *
 * Le message distingue les causes parce qu'elles appellent des gestes
 * différents : configurer une clé, attendre un refroidissement, ou renoncer à
 * cette mission avec ce parc de moteurs. « Aucun moteur disponible » ne dit
 * lequel des trois, et c'est la phrase qui a fait chercher une panne réseau
 * pendant que le vrai problème était une variable d'environnement.
 */
function describeBlockage(considered: RoutingCandidate[]): string {
  if (considered.length === 0) {
    return "Aucun moteur n'est enregistré dans le Search Fabric.";
  }

  const unconfigured = considered.filter((c) => !c.record.provider.availability().available);
  const cooling = considered.filter(
    (c) => c.record.provider.availability().available && c.record.breaker.state === 'open',
  );
  const unsuitable = considered.filter(
    (c) => c.record.provider.availability().available && c.suitability.verdict === 'unsuitable',
  );

  const parts: string[] = [];

  if (cooling.length > 0) {
    const soonest = Math.min(
      ...cooling.map((c) => c.record.breaker.snapshot().cooldownRemainingMs),
    );
    parts.push(
      `${cooling.length} moteur(s) en refroidissement (${cooling.map((c) => c.record.id).join(', ')}) — ` +
        `le premier redevient interrogeable dans ${Math.ceil(soonest / 60_000)} min`,
    );
  }
  if (unsuitable.length > 0) {
    parts.push(
      `${unsuitable.length} moteur(s) sains mais inadaptés à cette mission ` +
        `(${unsuitable.map((c) => c.record.id).join(', ')})`,
    );
  }
  if (unconfigured.length > 0) {
    parts.push(
      `${unconfigured.length} moteur(s) non configurés (${unconfigured.map((c) => c.record.id).join(', ')})`,
    );
  }

  return `Aucun moteur adapté et disponible : ${parts.join(' · ')}.`;
}
