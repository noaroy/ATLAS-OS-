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
