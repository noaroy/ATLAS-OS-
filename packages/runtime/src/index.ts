export { RuntimeSupervisor, type SupervisorDeps } from './supervisor.ts';
export { VillageService } from './village.ts';
export { assessHealth, sampleResources, buildDashboardStats, type HealthDeps } from './health.ts';
export { runBackup, type BackupResult } from './backup.ts';
export { preflight, formatPreflight, type PreflightReport, type PreflightCheck } from './preflight.ts';
export {
  evaluatePreset,
  formatPresetVerdict,
  DEFAULT_GATE,
  type PresetVerdictReport,
  type PresetVerdictKind,
  type VerdictGate,
} from './preset-verdict.ts';
export {
  evaluatePilot,
  formatPilotReport,
  type PilotReport,
  type PilotVerdict,
  type VerdictCriterion,
} from './pilot-verdict.ts';
export {
  recoverInterruptedMissions,
  formatRecovery,
  type RecoveryReport,
  type RecoveredMission,
} from './recovery.ts';
export {
  buildMissionReport,
  formatMissionReport,
  type MissionReport,
  type Measured,
} from './mission-report.ts';

export {
  validateStagePostcondition,
  contractFor,
  STAGE_CONTRACTS,
  type StageContract,
  type StageCheck,
  type StageCheckContext,
  type PostconditionResult,
} from './stage-contract.ts';

export { DeterministicPipeline, type PipelineDeps, type StageOutcome } from './pipeline.ts';

export {
  AtlasDaemon,
  DEFAULT_WORKER_TYPES,
  ENGINEERING_WORKER_TYPES,
  serverWorkerTypes,
  PERMANENT_ERROR_CODES,
  type DaemonOptions,
  type DaemonStats,
} from './daemon.ts';

export {
  WorkerRegistry,
  DeterministicWorker,
  DisabledModelWorker,
  HumanWorker,
  type Worker,
  type WorkerContext,
  type WorkerOutcome,
  type WorkerOutcomeKind,
} from './workers.ts';

export {
  DEMO_HANDLERS,
  DEMO_TASK_TYPES,
  SALES_TASK_TYPES,
} from './demo-workers.ts';

export {
  validateAiResult,
  nextTasksOf,
  taskFingerprint,
  checkCommand,
  redactSecrets,
  ENGINEERING_COMMAND_ALLOWLIST,
  type AiTaskResult,
  type SchemaCheck,
  type CommandVerdict,
} from './ai-contracts.ts';

export {
  OpenAiWorker,
  ClaudeWorker,
  runAllowedCommand,
  killTree,
  type AiWorkerOptions,
  type ClaudeWorkerOptions,
} from './ai-workers.ts';

export {
  HermesRouter,
  routeTask,
  fallbackFor,
  ROUTED_TASK_TYPES,
  ROUTE_TARGETS,
  type RouteTarget,
  type RouteDecision,
  type ChainLimits,
  type ChainVerdict,
  type ChainBlockReason,
  type HermesOptions,
} from './hermes-router.ts';

export {
  createAiProviders,
  createWorkerRegistry,
  type AiFactoryOptions,
} from './ai-factory.ts';

export {
  checkPath,
  isDeniedPath,
  resolveReal,
  auditChangedFiles,
  flagInjectionAttempt,
  type PathVerdict,
  type PathGuardOptions,
} from './repo-guard.ts';

export {
  createWorkspace,
  removeWorkspace,
  applyEdits,
  captureDiff,
  checkChangeBudget,
  auditWorkspace,
  applyToRepo,
  revertApply,
  inspectRepo,
  readWorkspaceFile,
  repoRootOf,
  hashDiff,
  linkNodeModules,
  type Workspace,
  type FileEdit,
  type EditOutcome,
  type DiffSummary,
  type ApplyVerdict,
  type ApplyOptions,
  type RepoCleanliness,
  type ChangeBudgetVerdict,
} from './workspace.ts';

export {
  runEngineeringTask,
  measureBaseline,
  parseEdits,
  type EngineeringOutcome,
  type EngineeringOptions,
  type EngineeringPhase,
  type BaselineVerdict,
} from './engineering.ts';

export {
  collectNeedsYou,
  todaySnapshot,
  pipelineSnapshot,
  type NeedsYouItem,
  type NeedsYouKind,
  type TodaySnapshot,
  type PipelineSnapshot,
} from './needs-you.ts';

export {
  ClaudeCodeWorker,
  detectClaudeCode,
  detectClaudeCodeAuth,
  usesApiKeyBilling,
  type ClaudeCodeAuth,
  runClaudeCode,
  buildMission,
  extractLastJson,
  readQuotaFromOutput,
  normaliseBinary,
  DEFAULT_ALLOWED_TOOLS,
  type ClaudeCodeOptions,
  type ClaudeCodeAvailability,
  type ClaudeCodeRun,
} from './claude-code.ts';

export {
  createClientRun,
  loadClientRun,
  adjustClientRun,
  runClientBatch,
  spendSoFar,
  budgetStop,
  startOfUtcDay,
  titreDuSite,
  CLIENT_BATCH_DEFAULTS,
  clientBudgetLimits,
  describeClientBudgetLimits,
  type ClientBudgetLimits,
  type ClientMissionDeps,
  type ClientRunContext,
  type BatchSummary,
  type BatchMetrics,
  type CandidateTiming,
  type FetchedPages,
  type BatchSummary as ClientBatchSummary,
  type BatchOptions,
} from './client-mission.ts';

export { buildClientRunReport, buildReviewQueue, renderReviewQueue, type ClientRunReport, type ClientRunReportInput } from './client-report-run.ts';
export { proposeBriefAdjustment, type BriefProposal } from './client-feedback.ts';
export { runClientPreflight, type PreflightVerdict, type PreflightDeps, type PreflightInput, type PreflightLine, type PreflightState } from './client-preflight.ts';
export { writeClientReportFiles, type ReportFiles, type ReportFilesInput, type WriteFile } from './client-report-files.ts';
export {
  runAutopilot, nextAction, countsFor, assessBatchQuality, assessSearchYield, adaptBatchSize, estimateMission, transition, canTransition,
  readAutopilot, briefKey, decisionJournal, snapshotOf, missionMetrics,
  MISSION_STATES, MISSION_TRANSITIONS, HUMAN_STATES, NEXT_ACTIONS, DEFAULT_LIMITS, LEVEL_LABELS,
  type MissionState, type AutopilotLevel, type AutopilotLimits, type AutopilotContext, type AutopilotDeps, type AutopilotOptions,
  type AutopilotOutcome, type NextAction, type NextActionKind, type BatchQuality, type SearchYield, type MissionEstimate, type MissionMetrics, type MissionSnapshotCounts,
} from './client-autopilot.ts';
export {
  syncSalesInbox, INBOX_SYNC_OVERLAP_MS, INBOX_FIRST_PASS_DAYS,
  type InboxSyncReport, type InboxSyncLine, type InboxSyncOptions,
} from './sales-inbox-sync.ts';
export {
  SALES_ENGINE_TASKS, SALES_SCHEDULE, SALES_SETTINGS,
  readGlobalPause, setGlobalPause, readStrategy, sendPolicyOf, bounceCounts, replyReceivedFor, policyStateFor,
  defaultOutbound, defaultDiscovery, segmentSupportedByBatch, pickSegmentForDiscovery,
  cancelFollowUps, applyReplyConsequences, createSalesEngineHandlers, runSendCycle, scheduleSalesCycle,
  gatherSalesStats, runOptimizationCycle, decideRecommendation, rollbackStrategy, recordSalesOutcome,
  type GlobalPause, type DiscoveryResult, type SalesEngineDeps, type SendCycleReport, type ScheduleReport,
  type RecommendationDecision,
} from './sales-engine.ts';
export {
  buildSalesDashboard, gmailLightOf, GMAIL_EVIDENCE_MAX_AGE_MINUTES,
  type SalesDashboard, type DashboardRange, type SystemLight, type GmailLight, type GmailStatusCode, type GmailEvidence,
} from './sales-dashboard.ts';
export { runManualSendLot, type ManualSendItem, type ManualSendResult, type ManualSendOptions, type ManualSendReport } from './manual-send.ts';
export { selfTestReplyScope, isSelfTestReply, type SelfTestReplyScope } from './sales-inbox-sync.ts';
export {
  classifyDaemonRun, deploymentEvidence, summariseReadiness, gmailSendReadiness, DAEMON_STALE_AFTER_MS, DEPLOYMENT_AREAS, LIVE_AREA, GMAIL_AUTH_AREA, GMAIL_SEND_AREA,
  type DaemonRunView, type DaemonRunState, type DeploymentArtefacts, type EvidenceItem, type CheckVerdict, type CheckLine, type LiveContext, type ReadinessSummary, type GmailSendReadinessInput,
} from './readiness.ts';
export {
  runAutopilotCycle, observeAtlas, summariseAutopilot, createAutopilotHandlers, scheduleAutopilotCycle,
  priorityScore, worthDoing, decideAutonomy, fingerprintOf, allocationShares, allocationAdjustment, verdictFromTasks,
  readAutopilotPause, setAutopilotPause,
  DEFAULT_OPPORTUNITY_SOURCES, revenueLoopSource, SAFE_AUTONOMOUS_TASK_TYPES, HUMAN_GATES, ALLOCATION_OF, ALLOCATION_TARGET,
  AUTOPILOT_TASK_TYPE, AUTOPILOT_SETTINGS, MAX_ACTION_DEPTH,
  type AutopilotProposal, type AutopilotObservation, type AutopilotCycleReport, type AutopilotSummary, type OpportunitySource,
  type OpportunityContext, type AutopilotCategory, type Allocation, type ValueBand, type Urgency, type RiskBand, type Reversibility,
  type HumanGate, type AutopilotExecution, type AutopilotDecision, type AutonomyVerdict, type AutopilotPause, type ProviderReadiness,
} from './autopilot.ts';

export {
  runCollabLoop,
  type CollabLoopDeps, type CollabLoopOptions, type CollabLoopReport, type CollabTurn,
} from './collab-loop.ts';

export {
  runLocalObjectiveLoop,
  type LocalLoopDeps, type LocalLoopOptions, type LocalLoopReport, type LocalLoopVerdict,
  type LocalLoopWorkspace, type LocalLoopStopReason,
} from './local-loop.ts';

export {
  runMasterLoop,
  type MasterLoopDeps, type MasterLoopOptions, type MasterLoopReport,
  type MasterCycleRecord, type MasterDecision, type MasterFinalStatus,
} from './master-loop.ts';

export {
  providerReadinessOf, verifyProvider, assessModelProviders, PROVIDER_VERIFY_TTL_MS,
  type ProviderReadinessState, type ProviderReadinessVerdict,
} from './provider-readiness.ts';
export {
  softwareLoopStatus, externalRunnerAlive, ENGINEER_HOST_LABEL,
  type SoftwareLoopStatus, type SoftwareLoopPiece, type SoftwareLoopOptions,
} from './software-loop.ts';
