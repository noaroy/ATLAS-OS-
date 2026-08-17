import type {
  Department,
  DepartmentDefinition,
  DepartmentKey,
  DepartmentKpi,
  PlaybookStage,
  ScoringModel,
  TargetTypeDefinition,
  Team,
  TeamDefinition,
} from '@atlas/contracts';
import { nowIso, notFound } from '@atlas/core';
import type { Db } from '../database.ts';
import { fromJson, toJson, toBool, fromBool } from '../database.ts';

interface DepartmentRow {
  key: string;
  name: string;
  tagline: string;
  mission: string;
  building: string;
  target_types: string;
  brief_schema: string;
  playbook: string;
  scoring_model: string;
  kpis: string;
  triggers: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface TeamRow {
  key: string;
  department_key: string;
  name: string;
  purpose: string;
  stages: string;
  agent_keys: string;
  created_at: string;
}

const toDepartment = (row: DepartmentRow): Department => ({
  key: row.key,
  name: row.name,
  tagline: row.tagline,
  mission: row.mission,
  building: row.building,
  targetTypes: fromJson<TargetTypeDefinition[]>(row.target_types, []),
  briefSchema: fromJson<Record<string, unknown>>(row.brief_schema, {}),
  playbook: fromJson<PlaybookStage[]>(row.playbook, []),
  scoringModel: fromJson<ScoringModel>(row.scoring_model, {
    dimensions: [],
    shortlistThreshold: 0,
    narrative: '',
  }),
  teams: [],
  kpis: fromJson<DepartmentKpi[]>(row.kpis, []),
  triggers: fromJson<string[]>(row.triggers, []),
  enabled: toBool(row.enabled),
});

const toTeam = (row: TeamRow): Team => ({
  key: row.key,
  departmentKey: row.department_key,
  name: row.name,
  purpose: row.purpose,
  stages: fromJson<Team['stages']>(row.stages, []),
  agentKeys: fromJson<string[]>(row.agent_keys, []),
});

/**
 * Departments and their teams (Constitution, Articles IV and V).
 *
 * A department is stored rather than compiled in so that its method, scoring
 * weights and team composition can be tuned — by the founder or by a validated
 * improvement — without a redeploy. The code ships the *initial* definition;
 * this table owns the current one.
 */
export class DepartmentRepository {
  constructor(private readonly db: Db) {}

  upsert(definition: DepartmentDefinition): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO departments (key, name, tagline, mission, building, target_types, brief_schema,
                                  playbook, scoring_model, kpis, triggers, enabled, created_at, updated_at)
         VALUES (@key, @name, @tagline, @mission, @building, @target_types, @brief_schema,
                 @playbook, @scoring_model, @kpis, @triggers, @enabled, @now, @now)
         ON CONFLICT(key) DO UPDATE SET
           name = excluded.name, tagline = excluded.tagline, mission = excluded.mission,
           building = excluded.building, target_types = excluded.target_types,
           brief_schema = excluded.brief_schema, playbook = excluded.playbook,
           scoring_model = excluded.scoring_model, kpis = excluded.kpis,
           triggers = excluded.triggers, enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run({
        key: definition.key,
        name: definition.name,
        tagline: definition.tagline,
        mission: definition.mission,
        building: definition.building,
        target_types: toJson(definition.targetTypes),
        brief_schema: toJson(definition.briefSchema),
        playbook: toJson(definition.playbook),
        scoring_model: toJson(definition.scoringModel),
        kpis: toJson(definition.kpis),
        triggers: toJson(definition.triggers),
        enabled: fromBool(definition.enabled),
        now,
      });

    this.#replaceTeams(definition.key, definition.teams);
  }

  /** Registers a department only if absent, so founder edits survive a restart. */
  ensure(definition: DepartmentDefinition): boolean {
    const exists = this.db.prepare('SELECT 1 FROM departments WHERE key = ?').get(definition.key);
    if (exists) return false;
    this.upsert(definition);
    return true;
  }

  /**
   * Brings a stored department back in line with the definition the code ships.
   *
   * The division of ownership is deliberate: the code owns the *method* — the
   * playbook, the targets, the brief, the teams — because those change when the
   * product changes, and a department left running last release's playbook is a
   * silent regression. The database owns whether the department is *in service*,
   * which is the founder's call and is preserved here.
   *
   * When evolution starts tuning scoring weights from outcomes, that field will
   * have to move to the database side of this line.
   */
  syncDefinition(definition: DepartmentDefinition): boolean {
    const current = this.get(definition.key);
    if (!current) return false;

    this.upsert({ ...definition, enabled: current.enabled });
    return (
      JSON.stringify(current.playbook) !== JSON.stringify(definition.playbook) ||
      JSON.stringify(current.targetTypes) !== JSON.stringify(definition.targetTypes) ||
      JSON.stringify(current.scoringModel) !== JSON.stringify(definition.scoringModel) ||
      JSON.stringify(current.teams) !== JSON.stringify(definition.teams)
    );
  }

  get(key: DepartmentKey): Department | null {
    const row = this.db.prepare('SELECT * FROM departments WHERE key = ?').get(key) as
      | DepartmentRow
      | undefined;
    if (!row) return null;
    return { ...toDepartment(row), teams: this.teamsFor(key) };
  }

  require(key: DepartmentKey): Department {
    const department = this.get(key);
    if (!department) throw notFound(`Department '${key}'`);
    return department;
  }

  list(onlyEnabled = false): Department[] {
    const sql = onlyEnabled
      ? 'SELECT * FROM departments WHERE enabled = 1 ORDER BY name'
      : 'SELECT * FROM departments ORDER BY name';
    return (this.db.prepare(sql).all() as DepartmentRow[]).map((row) => ({
      ...toDepartment(row),
      teams: this.teamsFor(row.key),
    }));
  }

  setEnabled(key: DepartmentKey, enabled: boolean): void {
    this.db
      .prepare('UPDATE departments SET enabled = ?, updated_at = ? WHERE key = ?')
      .run(fromBool(enabled), nowIso(), key);
  }

  /** Replaces only the scoring model, so re-weighting never touches the method. */
  setScoringModel(key: DepartmentKey, model: ScoringModel): void {
    this.db
      .prepare('UPDATE departments SET scoring_model = ?, updated_at = ? WHERE key = ?')
      .run(toJson(model), nowIso(), key);
  }

  // ─── Teams ──────────────────────────────────────────────────────────────

  teamsFor(departmentKey: DepartmentKey): Team[] {
    return (
      this.db
        .prepare('SELECT * FROM teams WHERE department_key = ? ORDER BY key')
        .all(departmentKey) as TeamRow[]
    ).map(toTeam);
  }

  team(departmentKey: DepartmentKey, teamKey: string): Team | null {
    const row = this.db
      .prepare('SELECT * FROM teams WHERE department_key = ? AND key = ?')
      .get(departmentKey, teamKey) as TeamRow | undefined;
    return row ? toTeam(row) : null;
  }

  /** Which team an agent belongs to, across departments. */
  teamsForAgent(agentKey: string): Team[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM teams
            WHERE EXISTS (SELECT 1 FROM json_each(teams.agent_keys) a WHERE a.value = ?)
            ORDER BY department_key, key`,
        )
        .all(agentKey) as TeamRow[]
    ).map(toTeam);
  }

  #replaceTeams(departmentKey: DepartmentKey, teams: TeamDefinition[]): void {
    const now = nowIso();
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM teams WHERE department_key = ?').run(departmentKey);
      const insert = this.db.prepare(
        `INSERT INTO teams (key, department_key, name, purpose, stages, agent_keys, created_at)
         VALUES (@key, @department_key, @name, @purpose, @stages, @agent_keys, @created_at)`,
      );
      for (const team of teams) {
        insert.run({
          key: team.key,
          department_key: departmentKey,
          name: team.name,
          purpose: team.purpose,
          stages: toJson(team.stages),
          agent_keys: toJson(team.agentKeys),
          created_at: now,
        });
      }
    });
    tx();
  }
}
