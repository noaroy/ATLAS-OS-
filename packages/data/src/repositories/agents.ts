import type {
  Agent,
  AgentMandate,
  AgentDefinition,
  AgentKey,
  AgentMetrics,
  AgentState,
  AgentStatus,
  AgentAppearance,
  AgentTier,
  Building,
  BuildingKey,
} from '@atlas/contracts';
import { DEFAULT_AGENT_MANDATES } from '@atlas/contracts';
import { nowIso, notFound } from '@atlas/core';
import type { Db } from '../database.ts';
import { fromJson, toJson, toBool, fromBool } from '../database.ts';

interface AgentRow {
  key: string;
  name: string;
  role: string;
  tier: AgentTier;
  building: string;
  mission: string;
  skills: string;
  actions: string;
  mandates: string;
  system_prompt: string;
  model: string | null;
  max_steps: number;
  appearance: string;
  enabled: number;
  status: AgentStatus;
  current_mission: string | null;
  current_task: string | null;
  current_activity: string | null;
  location: string;
  destination: string | null;
  last_active_at: string | null;
  quality_score: number;
  created_at: string;
  updated_at: string;
}

function toDefinition(row: AgentRow): AgentDefinition {
  return {
    key: row.key,
    name: row.name,
    role: row.role,
    tier: row.tier,
    building: row.building,
    mission: row.mission,
    skills: fromJson<string[]>(row.skills, []),
    actions: fromJson<string[]>(row.actions, []),
    // A row written before migration 2 has no mandates; treat it as an
    // ordinary specialist rather than an agent that can do nothing.
    mandates: fromJson<AgentMandate[]>(row.mandates, [...DEFAULT_AGENT_MANDATES]),
    systemPrompt: row.system_prompt,
    model: row.model,
    maxSteps: row.max_steps,
    appearance: fromJson<AgentAppearance>(row.appearance, {
      hue: 200,
      accent: '#7dd3fc',
      silhouette: 'scout',
      emblem: '◆',
    }),
    enabled: toBool(row.enabled),
  };
}

function toState(row: AgentRow): AgentState {
  return {
    key: row.key,
    status: row.status,
    currentMissionId: row.current_mission,
    currentTaskId: row.current_task,
    currentActivity: row.current_activity,
    location: row.location,
    destination: row.destination,
    lastActiveAt: row.last_active_at,
  };
}

export class AgentRepository {
  /**
   * `resolveTools` turns an agent's declared skills into the tools it may
   * call. It is injected rather than imported so this repository keeps
   * knowing nothing about the skill catalogue's contents (Article XV).
   */
  constructor(
    private readonly db: Db,
    private readonly resolveTools: (skills: readonly string[]) => string[] = () => [],
  ) {}

  // ─── Definitions ────────────────────────────────────────────────────────

  upsertDefinition(def: AgentDefinition): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO agents (
           key, name, role, tier, building, mission, skills, actions,
           mandates, system_prompt, model, max_steps, appearance, enabled,
           status, location, created_at, updated_at
         ) VALUES (
           @key, @name, @role, @tier, @building, @mission, @skills, @actions,
           @mandates, @system_prompt, @model, @max_steps, @appearance, @enabled,
           'available', @building, @now, @now
         )
         ON CONFLICT(key) DO UPDATE SET
           name = excluded.name,
           role = excluded.role,
           tier = excluded.tier,
           building = excluded.building,
           mission = excluded.mission,
           skills = excluded.skills,
           actions = excluded.actions,
           mandates = excluded.mandates,
           system_prompt = excluded.system_prompt,
           model = excluded.model,
           max_steps = excluded.max_steps,
           appearance = excluded.appearance,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run({
        key: def.key,
        name: def.name,
        role: def.role,
        tier: def.tier,
        building: def.building,
        mission: def.mission,
        skills: toJson(def.skills),
        actions: toJson(def.actions),
        mandates: toJson(def.mandates?.length ? def.mandates : DEFAULT_AGENT_MANDATES),
        system_prompt: def.systemPrompt,
        model: def.model,
        max_steps: def.maxSteps,
        appearance: toJson(def.appearance),
        enabled: fromBool(def.enabled),
        now,
      });
  }

  /**
   * Seeds a definition only if absent. Used at boot so founder edits and
   * evolution-applied prompt guidance survive every restart.
   */
  ensureDefinition(def: AgentDefinition): boolean {
    const exists = this.db.prepare('SELECT 1 FROM agents WHERE key = ?').get(def.key);
    if (exists) return false;
    this.upsertDefinition(def);
    return true;
  }

  /**
   * Brings an existing agent's presentation back in line with the code.
   *
   * Deliberately narrow: name, role and specialism only. The system prompt is
   * left alone because the evolution loop appends validated guidance to it, and
   * `maxSteps` and `model` because a founder or an applied improvement may have
   * tuned them. Rewriting either would silently discard a decision the system
   * recorded — the identity an agent shows the founder is the only part the
   * code still owns after first boot.
   */
  syncPresentation(def: AgentDefinition): boolean {
    const current = this.getDefinition(def.key);
    if (!current) return false;
    if (current.name === def.name && current.role === def.role && current.mission === def.mission) {
      return false;
    }

    this.db
      .prepare('UPDATE agents SET name = ?, role = ?, mission = ?, updated_at = ? WHERE key = ?')
      .run(def.name, def.role, def.mission, nowIso(), def.key);
    return true;
  }

  updateDefinition(
    key: AgentKey,
    patch: Partial<Pick<AgentDefinition, 'enabled' | 'model' | 'maxSteps' | 'systemPrompt'>>,
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { key, now: nowIso() };

    if (patch.enabled !== undefined) {
      sets.push('enabled = @enabled');
      params.enabled = fromBool(patch.enabled);
      // Enabling and disabling must move the live state too, or a disabled
      // agent keeps showing as 'available' in the village and the health check.
      sets.push('status = @statusForEnabled');
      params.statusForEnabled = patch.enabled ? 'available' : 'offline';
      if (!patch.enabled) {
        sets.push('current_mission = NULL, current_task = NULL, current_activity = NULL');
      }
    }
    if (patch.model !== undefined) {
      sets.push('model = @model');
      params.model = patch.model;
    }
    if (patch.maxSteps !== undefined) {
      sets.push('max_steps = @maxSteps');
      params.maxSteps = patch.maxSteps;
    }
    if (patch.systemPrompt !== undefined) {
      sets.push('system_prompt = @systemPrompt');
      params.systemPrompt = patch.systemPrompt;
    }
    if (sets.length === 0) return;

    const changes = this.db
      .prepare(`UPDATE agents SET ${sets.join(', ')}, updated_at = @now WHERE key = @key`)
      .run(params).changes;
    if (changes === 0) throw notFound(`Agent '${key}'`);
  }

  getDefinition(key: AgentKey): AgentDefinition | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE key = ?').get(key) as AgentRow | undefined;
    return row ? toDefinition(row) : null;
  }

  listDefinitions(onlyEnabled = false): AgentDefinition[] {
    const sql = onlyEnabled
      ? 'SELECT * FROM agents WHERE enabled = 1 ORDER BY tier, name'
      : 'SELECT * FROM agents ORDER BY tier, name';
    return (this.db.prepare(sql).all() as AgentRow[]).map(toDefinition);
  }

  /**
   * Enabled agents holding a given mandate.
   *
   * This is how every consumer asks "who may do this kind of work" — the
   * question is answered by a declared mandate, never by inferring from
   * the agent's tier or key.
   */
  listByMandate(mandate: AgentMandate): AgentDefinition[] {
    return this.listDefinitions(true).filter((agent) => agent.mandates.includes(mandate));
  }

  // ─── Live state ─────────────────────────────────────────────────────────

  setState(key: AgentKey, patch: Partial<Omit<AgentState, 'key'>>): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { key, now: nowIso() };
    const columns: Record<string, string> = {
      status: 'status',
      currentMissionId: 'current_mission',
      currentTaskId: 'current_task',
      currentActivity: 'current_activity',
      location: 'location',
      destination: 'destination',
      lastActiveAt: 'last_active_at',
    };

    for (const [field, column] of Object.entries(columns)) {
      const value = (patch as Record<string, unknown>)[field];
      if (value === undefined) continue;
      sets.push(`${column} = @${field}`);
      params[field] = value;
    }
    if (sets.length === 0) return;

    this.db.prepare(`UPDATE agents SET ${sets.join(', ')}, updated_at = @now WHERE key = @key`).run(params);
  }

  /**
   * Settles every live state on boot after an unclean stop.
   *
   * Nothing is running yet, so an agent left mid-flight is returned home. A
   * disabled agent settles to `offline`, not `available`, so the village and
   * the health check agree with the roster.
   */
  resetAllStates(): number {
    return this.db
      .prepare(
        `UPDATE agents
            SET status = CASE WHEN enabled = 1 THEN 'available' ELSE 'offline' END,
                current_mission = NULL, current_task = NULL, current_activity = NULL,
                destination = NULL, location = building, updated_at = ?
          WHERE status IN ('working','analyzing','moving','error')
             OR (enabled = 0 AND status <> 'offline')
             OR (enabled = 1 AND status = 'offline')`,
      )
      .run(nowIso()).changes;
  }

  /**
   * Returns agents that have been sitting in `error` longer than the cooldown
   * to `available`.
   *
   * An agent must show its failure — but it must also recover on its own, or
   * one bad step would leave a department permanently red in the village.
   */
  clearStaleErrors(olderThanIso: string): number {
    return this.db
      .prepare(
        `UPDATE agents
            SET status = 'available', current_activity = NULL, updated_at = ?
          WHERE status = 'error' AND (last_active_at IS NULL OR last_active_at < ?)`,
      )
      .run(nowIso(), olderThanIso).changes;
  }

  setQualityScore(key: AgentKey, score: number): void {
    this.db
      .prepare('UPDATE agents SET quality_score = ?, updated_at = ? WHERE key = ?')
      .run(Math.max(0, Math.min(100, score)), nowIso(), key);
  }

  // ─── Metrics (SRS §4.14) ────────────────────────────────────────────────

  /**
   * Derived from the task log rather than incremented counters, so metrics can
   * never drift out of sync with what actually happened.
   */
  metricsFor(key: AgentKey): AgentMetrics {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*)                                              AS total,
           SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
           SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed,
           COALESCE(AVG(CASE WHEN status = 'succeeded' THEN duration_ms END), 0) AS avg_duration,
           COALESCE(SUM(tokens_used), 0)                         AS tokens,
           MAX(finished_at)                                      AS last_task_at
         FROM mission_tasks
         WHERE agent_key = ? AND status IN ('succeeded','failed')`,
      )
      .get(key) as {
      total: number;
      succeeded: number | null;
      failed: number | null;
      avg_duration: number;
      tokens: number;
      last_task_at: string | null;
    };

    const quality = (
      this.db.prepare('SELECT quality_score AS q FROM agents WHERE key = ?').get(key) as
        | { q: number }
        | undefined
    )?.q ?? 75;

    const total = row.total ?? 0;
    const succeeded = row.succeeded ?? 0;

    return {
      key,
      tasksTotal: total,
      tasksSucceeded: succeeded,
      tasksFailed: row.failed ?? 0,
      successRate: total > 0 ? Math.round((succeeded / total) * 1000) / 10 : 100,
      avgDurationMs: Math.round(row.avg_duration),
      tokensUsed: row.tokens,
      qualityScore: Math.round(quality * 10) / 10,
      lastTaskAt: row.last_task_at,
    };
  }

  /** Full agent view — definition + state + metrics — for the console/village. */
  list(onlyEnabled = false): Agent[] {
    const sql = onlyEnabled
      ? 'SELECT * FROM agents WHERE enabled = 1 ORDER BY tier, name'
      : 'SELECT * FROM agents ORDER BY tier, name';
    return (this.db.prepare(sql).all() as AgentRow[]).map((row) => {
      const definition = toDefinition(row);
      return {
        ...definition,
        state: toState(row),
        metrics: this.metricsFor(row.key),
        tools: this.resolveTools(definition.skills),
      };
    });
  }

  get(key: AgentKey): Agent | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE key = ?').get(key) as AgentRow | undefined;
    if (!row) return null;

    const definition = toDefinition(row);
    return {
      ...definition,
      state: toState(row),
      metrics: this.metricsFor(row.key),
      tools: this.resolveTools(definition.skills),
    };
  }

  /** The tools an agent may call, derived from the skills it declares. */
  toolsFor(key: AgentKey): string[] {
    const definition = this.getDefinition(key);
    return definition ? this.resolveTools(definition.skills) : [];
  }

  delete(key: AgentKey): void {
    this.db.prepare('DELETE FROM agents WHERE key = ?').run(key);
  }
}

// ─── Buildings ──────────────────────────────────────────────────────────────

interface BuildingRow {
  key: string;
  name: string;
  department: string;
  purpose: string;
  x: number;
  y: number;
  level: number;
  activity_score: number;
  status: Building['status'];
  unlocked_at: string | null;
  sort_order: number;
}

const toBuilding = (row: BuildingRow): Building => ({
  key: row.key,
  name: row.name,
  department: row.department,
  purpose: row.purpose,
  x: row.x,
  y: row.y,
  level: row.level,
  activityScore: row.activity_score,
  status: row.status,
  unlockedAt: row.unlocked_at,
});

export class BuildingRepository {
  constructor(private readonly db: Db) {}

  ensure(building: Building & { sortOrder: number }): boolean {
    const exists = this.db.prepare('SELECT 1 FROM buildings WHERE key = ?').get(building.key);
    if (exists) return false;

    this.db
      .prepare(
        `INSERT INTO buildings (key, name, department, purpose, x, y, level, activity_score, status, unlocked_at, sort_order)
         VALUES (@key, @name, @department, @purpose, @x, @y, @level, @activityScore, @status, @unlockedAt, @sortOrder)`,
      )
      .run({ ...building, unlockedAt: building.unlockedAt ?? nowIso() });
    return true;
  }

  /**
   * Aligne un bâtiment existant sur sa définition, sans toucher à ce qu'il a
   * gagné.
   *
   * La distinction est la même que pour les agents : le plan de la ville — nom,
   * emplacement, vocation, rang d'affichage — est une déclaration du code, alors
   * que le niveau, l'activité accumulée et le statut sont de l'état mérité par
   * le travail réel. Redessiner la carte ne doit pas remettre un quartier à
   * zéro, et laisser un bâtiment à son ancienne place parce qu'il existait déjà
   * casserait la ville sur toute base antérieure au nouveau plan.
   *
   * Rend vrai lorsque quelque chose a réellement changé.
   */
  syncLayout(building: Building & { sortOrder: number }): boolean {
    const result = this.db
      .prepare(
        `UPDATE buildings
            SET name = @name, department = @department, purpose = @purpose,
                x = @x, y = @y, sort_order = @sortOrder
          WHERE key = @key
            AND (name <> @name OR department <> @department OR purpose <> @purpose
                 OR x <> @x OR y <> @y OR sort_order <> @sortOrder)`,
      )
      .run(building);
    return result.changes > 0;
  }

  list(): Building[] {
    return (
      this.db.prepare('SELECT * FROM buildings ORDER BY sort_order, key').all() as BuildingRow[]
    ).map(toBuilding);
  }

  get(key: BuildingKey): Building | null {
    const row = this.db.prepare('SELECT * FROM buildings WHERE key = ?').get(key) as
      | BuildingRow
      | undefined;
    return row ? toBuilding(row) : null;
  }

  setStatus(key: BuildingKey, status: Building['status']): void {
    this.db.prepare('UPDATE buildings SET status = ? WHERE key = ?').run(status, key);
  }

  /**
   * Records activity in a department. Buildings level up as real work
   * accumulates, which is what makes village growth mean something (SRS §3.8).
   */
  recordActivity(key: BuildingKey, delta: number): { level: number; leveledUp: boolean } {
    const row = this.db
      .prepare('SELECT level, activity_score FROM buildings WHERE key = ?')
      .get(key) as { level: number; activity_score: number } | undefined;
    if (!row) return { level: 1, leveledUp: false };

    const score = row.activity_score + delta;
    // Each level costs progressively more activity: 25, 60, 105, 160, ...
    const threshold = (level: number) => 25 * level + 5 * level * (level - 1);
    let level = row.level;
    while (level < 10 && score >= threshold(level)) level++;

    this.db
      .prepare('UPDATE buildings SET activity_score = ?, level = ? WHERE key = ?')
      .run(score, level, key);

    return { level, leveledUp: level > row.level };
  }

  decayActivity(factor = 0.995): void {
    this.db.prepare('UPDATE buildings SET activity_score = activity_score * ?').run(factor);
  }
}
