/**
 * The generic intelligence substrate.
 *
 * Everything here is department-agnostic: it knows about companies, evidence,
 * opportunities and explainable scores, and nothing at all about distributors,
 * suppliers or any other target. Departments supply that as data.
 */
export { canonicalKey, normaliseName, normaliseDomain, isSameCompany } from './identity.ts';
export {
  prepareEvidence,
  evidenceStrength,
  coveredFields,
  hasGroundedEvidence,
  evidenceAgeDays,
  DEFAULT_RELIABILITY,
  type EvidenceDraft,
} from './evidence.ts';
export {
  scoreOpportunity,
  explainScore,
  rankOpportunities,
  biggestGap,
  computeDimension,
  scoringModelVersion,
  type DimensionAssessment,
  type ScoreInput,
} from './scoring.ts';
export {
  OpportunityService,
  type CandidateDraft,
  type DiscoveryInput,
  /** Le résultat de l'enregistrement des candidats — distinct de `SearchOutcome`. */
  type DiscoveryOutcome,
  type IntelligenceDeps,
} from './opportunities.ts';
export {
  missionEconomics,
  estimateCostUsd,
  priceFor,
  MODEL_PRICES_USD_PER_MTOK,
  type EconomicsInput,
} from './economics.ts';
export { instantiatePlaybook, renderTemplate, type InstantiateInput } from './playbook.ts';
export { extractContacts, contactUrlsFor, CONTACT_PATHS, type ExtractedContact } from './contacts.ts';
export {
  fetchRawPages,
  type RawPage,
  type RawFetchOutcome,
  type RawFetchOptions,
} from './contact-fetch.ts';
export { toCsv, toPrintableHtml, type ExportInput, type ExportedFile } from './export.ts';
export * from './discovery/index.ts';

export * from './search/types.ts';
export { BraveSearchProvider, type BraveOptions } from './search/brave.ts';
export { SearxngSearchProvider, type SearxngOptions } from './search/searxng.ts';
export { DuckDuckGoSearchProvider } from './search/duckduckgo.ts';
export { MarginaliaSearchProvider } from './search/marginalia.ts';
export {
  capabilitiesOf,
  assessSuitability,
  type ProviderCapabilities,
  type MissionSearchNeed,
  type SuitabilityReport,
  type SuitabilityVerdict,
} from './search/capabilities.ts';
// ─── Search Fabric ──────────────────────────────────────────────────────────
// Le parc de moteurs, derrière le contrat d'un moteur unique. Tout ce qui
// consomme la recherche continue de voir un `SearchProvider` ; ce provider
// sait maintenant basculer, disjoncter et cadencer.
export { SearchFabric, OPEN_NEED, type FabricTrace, type FabricAttempt } from './search/fabric/fabric.ts';
export { createSearchFabric, buildRegistry, type FabricOptions } from './search/fabric/factory.ts';
export {
  SearchProviderRegistry,
  type ProviderRecord,
  type ProviderStatus,
  type ProviderScore,
  type ProviderMetrics,
  type ProviderCostModel,
  type ProviderRegistration,
} from './search/fabric/registry.ts';
export { SearchRouter, type RoutingPlan, type RoutingCandidate } from './search/fabric/router.ts';
export {
  CircuitBreaker,
  isFailoverWorthy,
  opensImmediately,
  type CircuitState,
  type BreakerSnapshot,
} from './search/fabric/breaker.ts';
export { RateLimiter, type LimiterOptions } from './search/fabric/limiter.ts';

export { planQueries, type PlannedQuery } from './search/planner.ts';
export { filterResults, fetchTargetsFor, type SearchCandidate, type FilterReport } from './search/filter.ts';
export { fetchPages, type FetchedPage } from './search/fetcher.ts';
