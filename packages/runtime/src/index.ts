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
