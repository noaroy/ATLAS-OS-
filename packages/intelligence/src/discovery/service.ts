import type { Logger } from '@atlas/core';
import { canonicalKey, isSameCompany, normaliseDomain } from '../identity.ts';
import { nowIso } from '@atlas/core';
import { FAILED_SEARCH_OUTCOMES } from './types.ts';
import type {
  DiscoveredCandidate,
  SearchOutcome,
  DiscoveryProvider,
  DiscoveryQuery,
  DiscoveryProviderContext,
} from './types.ts';

/**
 * Le service de découverte : plusieurs providers, un seul résultat.
 *
 * Deux garanties tiennent ici, et nulle part ailleurs.
 *
 * La première est la séparation réel / fabriqué. En mode réel, un provider
 * marqué `synthetic` est écarté avant d'être interrogé — ce n'est pas une
 * convention que chaque provider doit respecter, c'est une règle que le service
 * applique.
 *
 * La seconde est la déduplication inter-providers, avec conservation de la
 * provenance : la même entreprise vue par la recherche web et par le registre
 * produit un candidat portant deux sources, ce qui vaut corroboration, et non
 * deux lignes dans la shortlist.
 */

export interface DiscoveryRunReport {
  candidates: DiscoveredCandidate[];
  /** Ce que chaque provider a rendu, pour que le fondateur sache d'où ça vient. */
  providers: Array<{
    key: string;
    label: string;
    used: boolean;
    reason: string;
    found: number;
    notes: string[];
    tokensUsed: number;
    /** Ce qui est réellement arrivé à cette recherche-ci. */
    outcome: SearchOutcome;
  }>;
  /**
   * L'issue de la recherche dans son ensemble.
   *
   * Distingue « nous avons cherché et le marché ne contient rien » de « nous
   * n'avons pas pu chercher ». LIVE #003 confondait les deux : trois appels
   * enregistrés en succès alors que deux recherches avaient expiré, et une
   * cause qu'il a fallu déduire des journaux après coup.
   */
  outcome: SearchOutcome;
  /** Candidats fusionnés parce qu'un autre provider les avait déjà rapportés. */
  merged: number;
  tokensUsed: number;
  /** Ce que les moteurs et API tierces ont facturé, hors inférence. */
  searchApiCostUsd: number;
  /** Vrai si au moins un provider non fabriqué a effectivement répondu. */
  usedRealSource: boolean;
}

/**
 * L'état de santé observé d'un provider.
 *
 * `unknown` tant qu'aucun appel n'a eu lieu : c'est un aveu d'ignorance, pas un
 * verdict. Un système qui prétend savoir ce qu'il n'a pas mesuré finit par se
 * tromper au moment où cela compte.
 */
export type ProviderHealth = 'unknown' | 'healthy' | 'unhealthy';

export interface ProviderCapability {
  key: string;
  label: string;
  kind: string;
  /** Le provider a ce qu'il lui faut pour être appelé. */
  configured: boolean;
  /** Le dernier appel réel a-t-il abouti ? */
  health: ProviderHealth;
  lastCheckedAt: string | null;
  /** Conservé pour compatibilité : identique à `configured`. */
  usable: boolean;
  reason: string;
}

export interface DiscoveryServiceOptions {
  /** Vrai lorsqu'ATLAS tourne sur de l'inférence réelle. */
  live: boolean;
  logger: Logger;
}

export class DiscoveryService {
  constructor(
    private readonly providers: readonly DiscoveryProvider[],
    private readonly options: DiscoveryServiceOptions,
  ) {}

  /** Ce que le déploiement est capable de faire, avant même de chercher. */
  capabilities(): ProviderCapability[] {
    return this.providers.map((provider) => {
      const availability = provider.availability();
      const blockedBySimulation = this.options.live && provider.synthetic;
      const observed = this.#health.get(provider.key);

      return {
        key: provider.key,
        label: provider.label,
        kind: provider.kind,
        // « Configuré » : le provider a ce qu'il lui faut pour être appelé.
        configured: availability.available && !blockedBySimulation,
        // « Sain » : le dernier appel réel a effectivement abouti. Tant qu'il
        // n'y a pas eu d'appel, la question reste ouverte — et le dire est plus
        // honnête que de la trancher au hasard.
        //
        // La nuance n'est pas cosmétique : une instance SearXNG éteinte reste
        // parfaitement « configurée », et l'interface l'annonçait utilisable.
        health: observed?.status ?? 'unknown',
        lastCheckedAt: observed?.at ?? null,
        // `usable` reste ce qu'il était, pour ne rien casser en aval.
        usable: availability.available && !blockedBySimulation,
        reason: blockedBySimulation
          ? 'Écarté : ATLAS tourne en mode réel et ce provider fabrique ses résultats.'
          : observed?.detail
            ? `${availability.reason} — ${observed.detail}`
            : availability.reason,
      };
    });
  }

  /**
   * Ce que le dernier appel réel a appris de chaque provider.
   *
   * Renseigné par `discover()`, jamais par une sonde dédiée : interroger un
   * moteur pour savoir s'il répond coûterait une requête à chaque affichage de
   * l'écran. On se contente de retenir ce qu'on a déjà payé pour apprendre.
   */
  #health = new Map<string, { status: ProviderHealth; at: string; detail: string }>();

  #recordHealth(key: string, outcome: SearchOutcome): void {
    const failed = FAILED_SEARCH_OUTCOMES.includes(outcome);
    this.#health.set(key, {
      status: failed ? 'unhealthy' : 'healthy',
      at: nowIso(),
      detail: failed ? `dernier appel en échec (${outcome})` : 'dernier appel abouti',
    });
  }

  async discover(query: DiscoveryQuery, ctx: DiscoveryProviderContext): Promise<DiscoveryRunReport> {
    const report: DiscoveryRunReport = {
      candidates: [],
      providers: [],
      merged: 0,
      tokensUsed: 0,
      searchApiCostUsd: 0,
      usedRealSource: false,
      outcome: 'unavailable',
    };

    const accepted: DiscoveredCandidate[] = [];

    for (const provider of this.providers) {
      const availability = provider.availability();

      // La règle qui compte : en mode réel, rien de fabriqué n'entre.
      if (this.options.live && provider.synthetic) {
        report.providers.push({
          key: provider.key,
          label: provider.label,
          used: false,
          reason: 'Écarté : ATLAS tourne en mode réel et ce provider fabrique ses résultats.',
          found: 0,
          notes: [],
          tokensUsed: 0,
          outcome: 'unavailable',
        });
        continue;
      }
      // Et le symétrique : hors ligne, on n'appelle pas un service en ligne.
      if (!availability.available) {
        report.providers.push({
          key: provider.key,
          label: provider.label,
          used: false,
          reason: availability.reason,
          found: 0,
          notes: [],
          tokensUsed: 0,
          outcome: 'unavailable',
        });
        continue;
      }

      const remaining = query.limit - accepted.length;
      if (remaining <= 0) {
        report.providers.push({
          key: provider.key,
          label: provider.label,
          used: false,
          reason: 'Non interrogé : le nombre demandé était déjà atteint.',
          found: 0,
          notes: [],
          tokensUsed: 0,
          outcome: 'success-with-results',
        });
        continue;
      }

      const result = await provider.search({ ...query, limit: remaining }, ctx);
      report.tokensUsed += result.tokensUsed;
      report.searchApiCostUsd += result.externalCostUsd ?? 0;
      if (!provider.synthetic && result.candidates.length > 0) report.usedRealSource = true;

      let kept = 0;
      for (const candidate of result.candidates) {
        if (!candidate.name?.trim()) continue;

        const twin = findTwin(accepted, candidate);
        if (twin) {
          // Corroboration : on garde les deux origines et la meilleure confiance.
          twin.sources.push(...candidate.sources);
          twin.confidence = Math.max(twin.confidence, candidate.confidence);
          // Un provider peut avoir vu un rôle que l'autre a manqué.
          twin.roles = [...new Set([...twin.roles, ...candidate.roles])];
          twin.website ??= candidate.website;
          twin.description ??= candidate.description;
          twin.city ??= candidate.city;
          twin.country ??= candidate.country;
          report.merged++;
          continue;
        }
        accepted.push(candidate);
        kept++;
      }

      this.#recordHealth(provider.key, result.outcome);
      report.providers.push({
        key: provider.key,
        label: provider.label,
        used: true,
        reason: availability.reason,
        found: kept,
        notes: result.notes,
        tokensUsed: result.tokensUsed,
        outcome: result.outcome,
      });
    }

    report.candidates = accepted.slice(0, query.limit);
    report.outcome = combineOutcomes(report);
    return report;
  }
}

/**
 * L'issue de l'ensemble, à partir de celles de chaque provider.
 *
 * Des résultats l'emportent sur tout : peu importe qu'un provider ait échoué si
 * un autre a trouvé. À l'inverse, une absence de résultats *doublée* d'une panne
 * doit être rapportée comme une panne — sans quoi une recherche impossible
 * ressemblerait à un marché vide, et c'est précisément la confusion que
 * LIVE #003 a rendue coûteuse.
 */
function combineOutcomes(report: DiscoveryRunReport): SearchOutcome {
  if (report.candidates.length > 0) return 'success-with-results';

  const used = report.providers.filter((p) => p.used);
  if (used.length === 0) return 'unavailable';

  // La panne la plus explicative en premier : un refus budgétaire se corrige
  // autrement qu'un délai dépassé, et autrement qu'un rejet du fournisseur.
  for (const outcome of FAILED_SEARCH_OUTCOMES) {
    if (used.some((p) => p.outcome === outcome)) return outcome;
  }
  return 'success-empty';
}

/** Le même que la déduplication du registre, appliqué avant l'écriture. */
function findTwin(
  accepted: DiscoveredCandidate[],
  candidate: DiscoveredCandidate,
): DiscoveredCandidate | undefined {
  const identity = {
    name: candidate.name,
    domain: normaliseDomain(candidate.website),
    country: candidate.country,
  };
  const key = canonicalKey(identity);

  return accepted.find((prior) => {
    const priorIdentity = {
      name: prior.name,
      domain: normaliseDomain(prior.website),
      country: prior.country,
    };
    return canonicalKey(priorIdentity) === key || isSameCompany(priorIdentity, identity);
  });
}
