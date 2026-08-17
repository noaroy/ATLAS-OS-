import { nowIso } from '@atlas/core';
import type { Db } from '../database.ts';
import { fromJson, toJson } from '../database.ts';

/**
 * Mutable runtime settings (SRS §6.5).
 *
 * These are the knobs the founder — and, within limits, the evolution loop —
 * may change while the system runs. Environment configuration stays immutable;
 * anything tunable lives here so that changing it is auditable and reversible.
 */
export interface RuntimeSettings {
  maxConcurrentMissions: number;
  maxConcurrentTasks: number;
  taskMaxAttempts: number;
  /** Default token ceiling per mission. 0 disables the ceiling. */
  missionTokenBudget: number;
  /** How many times Hermes may replan one mission. 0 disables replanning. */
  maxReplansPerMission: number;
  evolutionEnabled: boolean;
  evolutionAutonomy: 'observe' | 'propose' | 'apply-low-risk';
  hermesModel: string;
  agentModel: string;
  llmEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Memory below this importance is pruned during consolidation, per tier. */
  memoryRetention: { operational: number; strategic: number; business: number };
}

export class SettingsRepository {
  constructor(private readonly db: Db) {}

  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? fromJson<T>(row.value, fallback) : fallback;
  }

  set(key: string, value: unknown, updatedBy = 'system'): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                        updated_at = excluded.updated_at,
                                        updated_by = excluded.updated_by`,
      )
      .run(key, toJson(value), nowIso(), updatedBy);
  }

  all(): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{
      key: string;
      value: string;
    }>;
    return Object.fromEntries(rows.map((r) => [r.key, fromJson<unknown>(r.value, null)]));
  }

  /** Reads the full settings object, falling back to boot defaults per field. */
  runtime(defaults: RuntimeSettings): RuntimeSettings {
    return {
      maxConcurrentMissions: this.get('orchestration.maxConcurrentMissions', defaults.maxConcurrentMissions),
      maxConcurrentTasks: this.get('orchestration.maxConcurrentTasks', defaults.maxConcurrentTasks),
      taskMaxAttempts: this.get('orchestration.taskMaxAttempts', defaults.taskMaxAttempts),
      missionTokenBudget: this.get('orchestration.missionTokenBudget', defaults.missionTokenBudget),
      maxReplansPerMission: this.get(
        'orchestration.maxReplansPerMission',
        defaults.maxReplansPerMission,
      ),
      evolutionEnabled: this.get('evolution.enabled', defaults.evolutionEnabled),
      evolutionAutonomy: this.get('evolution.autonomy', defaults.evolutionAutonomy),
      hermesModel: this.get('llm.hermesModel', defaults.hermesModel),
      agentModel: this.get('llm.agentModel', defaults.agentModel),
      llmEffort: this.get('llm.effort', defaults.llmEffort),
      memoryRetention: this.get('memory.retention', defaults.memoryRetention),
    };
  }

  /** Maps the settings object back onto individual keys. */
  updateRuntime(patch: Partial<RuntimeSettings>, updatedBy: string): void {
    const keyMap: Record<keyof RuntimeSettings, string> = {
      maxConcurrentMissions: 'orchestration.maxConcurrentMissions',
      maxConcurrentTasks: 'orchestration.maxConcurrentTasks',
      taskMaxAttempts: 'orchestration.taskMaxAttempts',
      missionTokenBudget: 'orchestration.missionTokenBudget',
      maxReplansPerMission: 'orchestration.maxReplansPerMission',
      evolutionEnabled: 'evolution.enabled',
      evolutionAutonomy: 'evolution.autonomy',
      hermesModel: 'llm.hermesModel',
      agentModel: 'llm.agentModel',
      llmEffort: 'llm.effort',
      memoryRetention: 'memory.retention',
    };

    const write = this.db.transaction(() => {
      for (const [field, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        const key = keyMap[field as keyof RuntimeSettings];
        if (key) this.set(key, value, updatedBy);
      }
    });
    write();
  }
}
