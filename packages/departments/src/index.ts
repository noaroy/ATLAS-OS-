import type { Department, DepartmentDefinition, DepartmentKey } from '@atlas/contracts';
import { BUSINESS_EXPANSION } from './business-expansion.ts';

/**
 * The department catalogue.
 *
 * ATLAS OS is the platform; departments are the products (Article XIV). This
 * package is where the second, third and tenth product will be declared — and
 * the fact that nothing outside it needs to change when one arrives is the test
 * of whether the platform underneath is genuinely generic.
 */
export const DEPARTMENT_DEFINITIONS: DepartmentDefinition[] = [BUSINESS_EXPANSION];

export { BUSINESS_EXPANSION };
export { DEMO_MISSION, DEMO_MISSION_TAG, type DemoMissionSpec } from './demo-mission.ts';
export { LIVE_PILOT_MISSION, LIVE_PILOT_LIMITS, LIVE_PILOT_NEED, type LivePilotLimits } from './live-pilot.ts';
export {
  VALIDATION_PRESETS,
  VALIDATION_MAX_OUTPUT_TOKENS_PER_CALL,
  type PresetGate,
  presetById,
  totalPresetBudgetUsd,
  type ValidationPreset,
  type PresetCriteria,
  type PresetVerdict,
} from './validation-presets.ts';

export {
  REVENUE_001,
  REVENUE_QUALITY_BAR,
  REVENUE_ENOUGH_PROSPECTS,
  REVENUE_TARGET_PROSPECTS,
  meetsQualityBar,
  whyBelowBar,
  shouldStopEarly,
  type RevenuePreset,
  type QualityBar,
  type ProspectQuality,
  type StopDecision,
  type StopReason,
} from './revenue-preset.ts';

export {
  buildPack,
  detectSignals,
  approachAngleFor,
  type Pack,
  type PackProspect,
  type PackClaim,
  type PackAdvice,
  type PackContact,
} from './deliverable.ts';

export { packToHtml, packToCsv } from './deliverable-render.ts';

export {
  canTransition,
  reviewVerdict,
  reportEconomics,
  REVIEW_CHECKLIST,
  PIPELINE_VERSION,
  USD_PER_EUR,
  type ReportState,
  type ReviewItem,
  type ReviewOutcome,
  type ReviewVerdict,
  type ReportCost,
  type ReportEconomics,
  type ReportProvenance,
} from './delivery.ts';

export {
  buildClientReport,
  fieldLabel,
  sectorLabel,
  looksFrench,
  isNamed,
  type ClientReport,
  type ReportProspect,
  type ReportClaim,
  type ReportDimension,
  type ReportContact,
  type ReportSummary,
  type ReportEntry,
  type ReportCheck,
  type ReportCriterion,
  type ReportVerification,
  type ReportExclusion,
  type ProspectExtras,
  EXCLUSION_LABELS,
  CRITERION_VERDICT_LABELS,
  buildSynthesis, CHANNEL_CONFIDENCE_LABELS, RECOMMENDATION_LABELS,
  type ReportChannel, type ReportSynthesis, type ReviewQueueItem,
} from './client-report.ts';

export {
  reportToHtml,
  reportToCsv,
  exclusionsToCsv,
  teaserToHtml,
  TEASER_FACT_LIMIT,
  reviewQueueToHtml, reviewQueueToCsv,
} from './client-report-render.ts';

export {
  EVIDENCE_TRANSLATIONS,
  CHECK_TRANSLATIONS,
  UNVERIFIED_POINTS,
  translationMap,
  checkTranslationMap,
  normaliseCriterion,
  type EvidenceTranslation,
  type CheckTranslation,
} from './translations.ts';

export {
  canStartProduction,
  canDeliver,
  orderEconomics,
  type CustomerOrder,
  type PaymentStatus,
  type OrderStatus,
  type DeliveryStatus,
  type ProductionDecision,
  type ProductionRefusal,
  type DeliveryFacts,
  type DeliveryDecision,
  type OrderEconomics,
} from './customer-flow.ts';

export const DEPARTMENT_KEYS: DepartmentKey[] = DEPARTMENT_DEFINITIONS.map((d) => d.key);

/**
 * Recognises which department a free-text objective belongs to.
 *
 * Deliberately a cheap keyword match rather than a model call: routing runs on
 * every mission, and a wrong guess is corrected by the founder choosing the
 * department explicitly in the console. When nothing matches, the mission stays
 * generic and Hermes plans it itself, which is the safe default.
 */
export function routeObjective(
  objective: string,
  departments: readonly Department[],
): DepartmentKey | null {
  const haystack = objective.toLowerCase();
  let best: { key: DepartmentKey; hits: number } | null = null;

  for (const department of departments) {
    if (!department.enabled) continue;
    const hits = department.triggers.filter((trigger) => haystack.includes(trigger.toLowerCase())).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { key: department.key, hits };
  }
  return best?.key ?? null;
}

export {
  RATIONALE_TRANSLATIONS,
  rationaleTranslationMap,
  type RationaleTranslation,
} from './rationale-translations.ts';

export {
  evaluateApproval,
  parseDeclaredChecks,
  HUMAN_CHECKS,
  AUTOMATIC_CHECKS,
  type ApprovalInput,
  type ApprovalDecision,
  type ApprovalRefusal,
  type RefusalCode,
  type HumanCheckKey,
} from './review-approval.ts';

export {
  ATLAS_SALES_ICP,
  filterCandidate,
  dedupeCandidates,
  domainOf,
  whyNotACompanyName,
  type SalesIcp,
  type RawCandidate,
  type FilterDecision,
} from './sales-icp.ts';

export {
  SALES_SCORING_MODEL,
  SALES_TIER_THRESHOLDS,
  scoreSalesProspect,
  evidenceQuality,
  tierFor,
  type SalesDimension,
  type SalesDimensionKey,
  type SalesAssessment,
  type SalesScore,
  type SalesScoreComponent,
  type SalesTier,
  type EvidenceSummary,
} from './sales-score.ts';

export {
  buildOutreachDraft,
  pickPersonalizationFact,
  personalizationIsGrounded,
  observationPhrase,
  customerFacingObservation,
  saysTheyAreLooking,
  elide,
  outreachFactFrom,
  isCommercialEvidence,
  canTransitionProspect,
  requiresHumanApproval,
  trimSentence,
  type OutreachDraft,
  type OutreachFact,
  type OutreachContact,
  type OutreachOutcome,
  type OutreachRefusal,
  type StoredEvidence,
  type CustomerFacingObservation,
  type ProspectState as OutreachProspectState,
} from './outreach.ts';

export {
  SALES_QUERY_VOCABULARY,
  planQueries,
  looksLikeCompanySite,
  type QueryVocabulary,
  type QueryPlan,
} from './sales-queries.ts';

export {
  classifyPageType,
  resolveCompanyIdentity,
  icpStatus,
  isGenericDescriptor,
  looksLikePageTitle,
  nameMatchesDomain,
  checkPriorityEligibility,
  type PageType,
  type PageClassification,
  type CompanyIdentity,
  type IdentityOutcome,
  type IcpStatus,
  type IcpDecision,
  type PriorityCheck,
} from './company-resolver.ts';

export {
  runSalesPipeline,
  funnelBalances,
  type PipelineCandidate,
  type PipelineSurvivor,
  type PipelineRejection,
  type PipelineOutcome,
  type PipelineOptions,
  type RejectionStage,
  type FunnelCounts,
} from './sales-pipeline.ts';

export {
  resolveContacts,
  contactPagesFor,
  contactLinksIn,
  isOfficialPage,
  brandRoot,
  brandsRelated,
  CONTACT_PATHS,
  type ContactKind,
  type ContactConfidence,
  type ContactMethod,
  type ResolvedContact,
  type ContactResolution,
  type ContactPage,
} from './contact-resolver.ts';

export {
  classifyContactIntent,
  outreachSuitability,
  selectOutreachContact,
  type ContactIntent,
  type OutreachSuitability,
  type RankableContact,
  type SelectionOutcome,
} from './contact-intent.ts';

export {
  classifyInbound,
  extractReturnDate,
  deriveConversationState,
  replyHistory,
  type ReplyHistory,
  requiresHumanJudgement,
  HUMAN_ONLY_STATUSES,
  detectOptOut,
  type InboundKind,
  type ReplyClassification,
  type ClassificationResult,
  type ConversationStatus,
  type ConversationEvent,
  type DerivedState,
} from './reply-intake.ts';

export {
  matchIncoming,
  emailAddressOf,
  domainOfAddress,
  relatedDomains,
  type MatchMethod,
  type MatchCandidate,
  type MatchResult,
  type IncomingForMatch,
} from './reply-matching.ts';

export {
  scoreConversion,
  isConversionReady,
  isForeignDomain,
  looksMultinational,
  CONVERSION_MODEL,
  CONVERSION_READY_THRESHOLD,
  MIN_GROUNDED_DIMENSIONS,
  type ConversionDimensionKey,
  type ConversionDimension,
  type ConversionInput,
  type ConversionScore,
  type ConversionComponent,
  type ObservedFact,
} from './sales-conversion.ts';

export {
  findGrowthSignals,
  cleanQuote,
  readsAsSentence,
  SIGNAL_LABELS,
  type GrowthSignal,
  type GrowthSignalKind,
} from './growth-signals.ts';

export {
  canTransitionLoop,
  nextActionFor,
  TERMINAL_STATES,
  HUMAN_ATTENTION_STATES,
  type LoopState,
  type TransitionCheck,
} from './sales-loop.ts';

export {
  evaluateSendGate,
  type BlockReason,
  type SendCandidate,
  type SendGateLimits,
  type SendGateVerdict,
} from './send-gate.ts';

export {
  shouldNotify,
  recommendedActionFor,
  summarise,
  draftReplyFor,
  type NotifyDecision,
  type NotifyInput,
  type Notification,
} from './sales-notify.ts';

export {
  evaluateFollowUp,
  addBusinessDays,
  MAX_FOLLOW_UPS_PER_COMPANY,
  MIN_FOLLOW_UP_BUSINESS_DAYS,
  type FollowUpVerdict,
  type FollowUpInput,
  type FollowUpDecision,
} from './follow-up.ts';
export * from './message-direction.ts';

export {
  collectSourcedFacts,
  enrichmentPagesFor,
  enrichmentLinksIn,
  ENRICHMENT_PATHS,
  type SourcedFact,
  type EnrichmentStop,
  type EnrichmentOutcome,
  type EnrichmentInput,
} from './prospect-enrichment.ts';

export {
  extractLegalIdentity,
  legalPagesFor,
  legalLinksIn,
  looksLikeLegalNotice,
  confidenceFromLegal,
  LEGAL_PATHS,
  type LegalIdentity,
} from './legal-identity.ts';

export {
  classifyActionChannel,
  classifyRecipientString,
  actionLabelFor,
  classifyRecipientDomain,
  canonicalUrl,
  type ActionChannel,
  type DomainMatch,
  type DomainVerdict,
  type ChannelInput,
  type ChannelVerdict,
} from './action-channel.ts';

export {
  verifyClaimAgainstSource,
  decodeEntities,
  readableText,
  type ClaimCheck,
} from './claim-verification.ts';

export {
  REVENUE_STEPS,
  CYCLE_INNER_STEPS,
  SENDING_STEPS,
  REPLY_PRIORITY_ORDER,
  decideSearchGate,
  decideBudgetGate,
  classifyReply,
  prioritizeInbox,
  classifyDraft,
  revenueMomentum,
  topActions,
  type RevenueStepId,
  type SearchVerdict,
  type SearchProbe,
  type SearchGate,
  type BudgetSnapshot,
  type BudgetGate,
  type ReplyPriority,
  type InboxSignal,
  type DraftClass,
  type DraftFacts,
  type DraftVerdict,
  type Momentum,
  type MomentumInput,
  type MomentumVerdict,
  type ActionsInput,
} from './revenue-mode.ts';

export {
  extractCountryEvidence,
  countryFit,
  type CountryVerdict,
  type CountryFit,
} from './country-evidence.ts';

export {
  splitIntoBlocks,
  cleanedText,
  pageTitle,
  resolveSelection,
  quoteExistsInSource,
  areNearDuplicates,
  distinctCommercialFacts,
  hasEnoughCommercialFacts,
  MIN_COMMERCIAL_FACTS,
  type EvidenceType,
  type SourceBlock,
  type SourcedEvidence,
  type BlockSelection,
  // `SelectionOutcome` est deja pris par la selection de contact : celui-ci
  // porte donc son domaine dans son nom.
  type SelectionOutcome as BlockSelectionOutcome,
} from './evidence-blocks.ts';

export {
  buildBlockCatalogue,
  resolveSelections,
  readNormalizedClaim,
  INTERPRETATION_PREFIX,
  VERBATIM_SYSTEM,
  VERBATIM_SCHEMA,
  type ReadPage,
  type BlockCatalogue,
  type ResolvedSelections,
} from './verbatim-selection.ts';

export {
  collectIdentitySignals,
  corroborateIdentity,
  normalizeCompanyName,
  type IdentitySignal,
  type IdentitySourceType,
  type CorroboratedIdentity,
} from './identity-signals.ts';

export {
  collectCountrySignals,
  corroborateCountry,
  type CountrySignal,
  type CountrySignalType,
  type CorroboratedCountry,
} from './country-evidence.ts';

export {
  checkHumanization,
  greetingFor,
  addressMatchesPerson,
  type HumanizationVerdict,
  type HumanizationCheck,
  type MessageToCheck,
  type MessageChannel,
} from './humanization.ts';

export {
  ClientBriefSchema,
  CriterionSchema,
  parseClientBrief,
  allCriteria,
  normaliseDomain,
  adjustBrief,
  type ClientBrief,
  type ClientCriterion,
  type BriefValidation,
} from './client-brief.ts';

export {
  criteriaSchema,
  criteriaPrompt,
  CRITERIA_SYSTEM,
  resolveQualification,
  scanCompetitors,
  decideCandidate,
  scoreCriteria,
  type CriterionVerdict,
  type CriterionResult,
  type SpecialisationVerdict,
  type SpecialisationResult,
  type ExclusionCategory,
  type CompetitorHit,
  type CandidateDecision,
  type CriteriaScore,
  type ResolvedQualification,
} from './client-criteria.ts';
export * from './nordic-address.ts';
export * from './client-pages.ts';
export * from './client-triage.ts';

export * from './sales-engine.ts';
