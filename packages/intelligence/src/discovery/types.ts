import type { SourceKind } from '@atlas/contracts';
import type { Logger } from '@atlas/core';

/**
 * Découverte d'entreprises — l'abstraction générique.
 *
 * ATLAS ne dépend d'aucun fournisseur en particulier. Un provider sait
 * répondre à une question de la forme « quelles organisations correspondent à
 * ce profil, dans ce pays, dans ce secteur », et rend des candidats dont
 * chacun porte sa provenance. Le pipeline en combine plusieurs, déduplique
 * leurs résultats et conserve d'où vient chaque information.
 *
 * Rien ici ne connaît la notion de distributeur : le type de cible est une
 * donnée de la requête, déclarée par le département.
 */

/** Ce que l'on cherche. Entièrement générique. */
export interface DiscoveryQuery {
  /**
   * Les rôles recherchés, déclarés par le département.
   *
   * Pluriel : une même mission peut chercher des distributeurs *et* des
   * intégrateurs, et une organisation peut correspondre aux deux.
   */
  targetTypes: Array<{ key: string; label: string; description: string }>;
  countries: string[];
  industries: string[];
  keywords: string[];
  /** Ce qui disqualifie d'emblée un candidat. */
  exclusions: string[];
  /** Ce que vend le client, pour juger la pertinence. */
  clientOffering: string | null;
  limit: number;
}

/** D'où vient un candidat. Jamais optionnel : sans origine, pas de candidat. */
export interface CandidateSource {
  kind: SourceKind;
  /** L'URL ou l'identifiant exact de l'enregistrement consulté. */
  ref: string | null;
  title: string | null;
  retrievedAt: string;
  /** Le provider qui l'a rapporté. */
  provider: string;
}

export interface DiscoveredCandidate {
  name: string;
  website: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  description: string | null;
  industries: string[];
  /** Pourquoi ce candidat correspondrait — l'avis du provider, pas un fait. */
  relevance: string | null;
  /**
   * Les rôles auxquels ce candidat semble correspondre.
   *
   * Vide lorsque le provider ne peut pas se prononcer ; la qualification
   * tranchera. Une entreprise correspondant à deux rôles reste un seul candidat.
   */
  roles: string[];
  /**
   * Toutes les origines de ce candidat. Un candidat vu par deux providers en
   * porte deux, ce qui vaut corroboration.
   */
  sources: CandidateSource[];
  /** 0..1 — la confiance du provider dans son propre résultat. */
  confidence: number;
}

export interface DiscoveryProviderContext {
  logger: Logger;
  /**
   * À qui imputer la dépense.
   *
   * LIVE #002 n'en portait que la mission : le coût de la recherche
   * apparaissait « hors étape » alors qu'il appartenait manifestement à la
   * découverte. Un coût qu'on ne sait pas rattacher ne sert à rien pour décider
   * où optimiser.
   */
  missionId?: string | null;
  taskRef?: string | null;
  agentKey?: string | null;
  departmentKey?: string | null;
  /** Combien de recherches et de pages cette découverte peut se permettre. */
  limits?: { maxSearches?: number; maxFetches?: number };
  /** Borne dure de l'appel au fournisseur ; 0 la désactive. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Ce qui est arrivé à une recherche.
 *
 * « Nous avons cherché correctement et trouvé zéro entreprise » et « nous
 * n'avons pas pu chercher » ne sont pas la même chose. Le premier est un
 * résultat commercial — le marché ne contient rien qui corresponde — et le
 * second une panne à réparer.
 *
 * LIVE #003 les a confondus : les trois appels à `discover_companies` sont
 * enregistrés en succès alors que deux recherches avaient été annulées par
 * expiration du délai. La télémétrie disait « rien trouvé » là où il fallait
 * lire « recherche impossible », et la cause a dû être déduite des journaux
 * après coup.
 */
export const SEARCH_OUTCOMES = [
  /** Des candidats documentés ont été rapportés. */
  'success-with-results',
  /** La recherche a bien eu lieu et n'a rien trouvé qui corresponde. */
  'success-empty',
  /** Le fournisseur a échoué : rejet, réponse illisible, refus du modèle. */
  'provider-failure',
  /** La recherche a dépassé son délai et a été annulée. */
  'timeout',
  /** Un plafond économique a refusé l'appel avant qu'il parte. */
  'budget-cancelled',
  /** Le provider n'était pas utilisable — hors ligne, ou écarté en mode réel. */
  'unavailable',
  /**
   * Recherche identique à une qui a déjà échoué techniquement : refusée avant
   * d'atteindre le fournisseur.
   */
  'duplicate-blocked',
] as const;
export type SearchOutcome = (typeof SEARCH_OUTCOMES)[number];

/** Les issues qui signalent une panne, par opposition à un marché vide. */
export const FAILED_SEARCH_OUTCOMES: readonly SearchOutcome[] = [
  'provider-failure',
  'timeout',
  'budget-cancelled',
  'duplicate-blocked',
];

/**
 * Les issues après lesquelles rejouer *le même* appel ne peut rien changer.
 *
 * Volontairement plus étroit que `FAILED_SEARCH_OUTCOMES` : un refus budgétaire
 * n'a pas à être mémorisé — le budget est déjà souverain et refusera de
 * lui-même. Un résultat vide reste rejouable : le marché a pu être mal
 * interrogé, et c'est à l'agent d'en juger.
 */
export const UNREPEATABLE_SEARCH_OUTCOMES: readonly SearchOutcome[] = [
  'timeout',
  'provider-failure',
];

export interface ProviderResult {
  candidates: DiscoveredCandidate[];
  /** Ce que le provider veut signaler : couverture, limites, refus. */
  notes: string[];
  tokensUsed: number;
  /** Ce qui est réellement arrivé à cette recherche. */
  outcome: SearchOutcome;
  /**
   * Ce que ce provider a facturé hors inférence — requêtes moteur, API tierce.
   *
   * Séparé des jetons parce qu'une recherche à 0,005 $ et un raisonnement à
   * 0,50 $ ne se pilotent pas de la même manière. Les confondre a masqué
   * pendant cinq missions que la dépense partait entièrement dans le second.
   */
  externalCostUsd?: number;
}

/** Pourquoi un provider est utilisable, ou ne l'est pas. */
export interface Availability {
  available: boolean;
  /** Formulé pour être lu par le fondateur, pas seulement par un développeur. */
  reason: string;
}

export interface DiscoveryProvider {
  readonly key: string;
  readonly label: string;
  readonly kind: 'registry' | 'web-search' | 'directory' | 'company-data' | 'simulation';
  /**
   * Vrai lorsque les résultats sont fabriqués et ne doivent jamais apparaître
   * dans une exécution réelle. Le service l'impose, pas le provider.
   */
  readonly synthetic: boolean;
  availability(): Availability;
  search(query: DiscoveryQuery, ctx: DiscoveryProviderContext): Promise<ProviderResult>;
}
