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
export { planQueries, type PlannedQuery } from './search/planner.ts';
export { filterResults, fetchTargetsFor, type SearchCandidate, type FilterReport } from './search/filter.ts';
export { fetchPages, type FetchedPage } from './search/fetcher.ts';
