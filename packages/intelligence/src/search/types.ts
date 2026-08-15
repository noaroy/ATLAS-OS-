import type { Logger } from '@atlas/core';

/**
 * La recherche web, comme service et non comme raisonnement.
 *
 * Jusqu'à LIVE #005, ATLAS demandait à un modèle de *faire* la recherche : une
 * seule requête portant deux rôles, onze mots-clés, cinq secteurs et quatre
 * exclusions, chargée de chercher, filtrer, qualifier et structurer d'un seul
 * tenant. Trois délais successifs — 120 s, 180 s, 420 s — ont tous été
 * atteints. Le mur reculait à chaque fois qu'on le déplaçait, ce qui signifie
 * qu'il n'y avait pas de mur : la tâche ne convergeait pas.
 *
 * Un moteur de recherche répond en quelques centaines de millisecondes parce
 * qu'il ne fait qu'une chose. C'est ce contrat-là qu'on rétablit ici :
 *
 *   « Voici une requête courte. Rends-moi des URLs, des titres, des extraits. »
 *
 * Rien de plus. Pas de qualification, pas de RoleFit, pas de score. Le
 * raisonnement vient après, sur une poignée de candidats survivants.
 */

export interface SearchRequest {
  /** Une requête courte, dans la langue du marché. */
  query: string;
  /** Code pays ISO pour régionaliser les résultats, quand le provider sait le faire. */
  country?: string | null;
  /** Langue attendue des résultats. */
  language?: string | null;
  /** Nombre de résultats souhaités. Le provider peut en rendre moins. */
  count: number;
  signal?: AbortSignal;
}

/**
 * Un résultat brut de moteur de recherche.
 *
 * Volontairement pauvre : titre, URL, extrait. C'est tout ce qu'un moteur sait,
 * et tout ce dont le filtrage déterministe a besoin. Enrichir ici reviendrait à
 * refaire l'erreur qu'on corrige.
 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Le provider qui l'a rendu — la provenance commence ici. */
  provider: string;
  /** Rang dans la liste rendue, à partir de 1. */
  rank: number;
  /** La requête exacte qui a produit ce résultat. */
  query: string;
  retrievedAt: string;
}

/** Ce qui est arrivé à un appel de recherche. */
export const SEARCH_PROVIDER_OUTCOMES = [
  'ok',
  'empty',
  'timeout',
  'rate-limited',
  'http-error',
  'unavailable',
] as const;
export type SearchProviderOutcome = (typeof SEARCH_PROVIDER_OUTCOMES)[number];

export interface SearchResponse {
  results: SearchResult[];
  outcome: SearchProviderOutcome;
  /** Lisible par le fondateur, pas seulement par un développeur. */
  detail: string;
  /**
   * Ce que cet appel a coûté auprès du fournisseur, en USD.
   *
   * Séparé du coût d'inférence : une recherche à 0,005 $ et un raisonnement à
   * 0,50 $ ne se pilotent pas de la même manière, et les confondre a masqué
   * pendant cinq missions que la dépense partait entièrement dans le second.
   */
  costUsd: number;
  durationMs: number;
}

export interface SearchProviderContext {
  logger: Logger;
  /** Borne dure de l'appel ; 0 la désactive. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SearchAvailability {
  available: boolean;
  reason: string;
}

export interface SearchProvider {
  readonly key: string;
  readonly label: string;
  availability(): SearchAvailability;
  search(request: SearchRequest, ctx: SearchProviderContext): Promise<SearchResponse>;
}
