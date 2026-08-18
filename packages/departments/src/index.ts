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
} from './client-report.ts';

export {
  reportToHtml,
  reportToCsv,
  teaserToHtml,
  TEASER_FACT_LIMIT,
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
  canTransitionProspect,
  requiresHumanApproval,
  trimSentence,
  type OutreachDraft,
  type OutreachFact,
  type OutreachContact,
  type OutreachOutcome,
  type OutreachRefusal,
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
