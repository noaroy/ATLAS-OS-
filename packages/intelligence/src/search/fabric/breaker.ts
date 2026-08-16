/**
 * Le disjoncteur, remonté dans `@atlas/core`.
 *
 * Il protégeait un moteur de recherche ; il protège désormais aussi un
 * fournisseur d'inférence, et `llm` précède `intelligence` dans la chaîne des
 * paquets. Le mécanisme n'avait rien de spécifique à la recherche — seule sa
 * place l'était.
 *
 * Ce fichier reste pour que les appelants du Search Fabric n'aient pas à savoir
 * que la pièce a déménagé.
 */
export {
  CircuitBreaker,
  DEFAULT_BREAKER,
  isFailoverWorthy,
  opensImmediately,
  type BreakerOptions,
  type BreakerSnapshot,
  type CircuitState,
} from '@atlas/core';
