import type { Skill, SkillCategory, SkillKey } from '@atlas/contracts';
import { nowIso, notFound } from '@atlas/core';
import type { Db } from '../database.ts';
import { fromJson, toJson, toBool, fromBool } from '../database.ts';

interface SkillRow {
  key: string;
  name: string;
  description: string;
  category: SkillCategory;
  tools: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

const toSkill = (row: SkillRow): Skill => ({
  key: row.key,
  name: row.name,
  description: row.description,
  category: row.category,
  tools: fromJson<string[]>(row.tools, []),
  enabled: toBool(row.enabled),
});

/**
 * The skill registry (Article VII).
 *
 * Skills live in the database rather than only in code so that a new
 * reusable know-how can be registered at runtime — the same property that lets
 * agents and, later, departments be added without a redeploy.
 */
export class SkillRepository {
  constructor(private readonly db: Db) {}

  upsert(skill: Skill): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO skills (key, name, description, category, tools, enabled, created_at, updated_at)
         VALUES (@key, @name, @description, @category, @tools, @enabled, @now, @now)
         ON CONFLICT(key) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           category = excluded.category,
           tools = excluded.tools,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run({
        key: skill.key,
        name: skill.name,
        description: skill.description,
        category: skill.category,
        tools: toJson(skill.tools),
        enabled: fromBool(skill.enabled),
        now,
      });
  }

  /** Registers a skill only if absent, so founder edits survive a restart. */
  ensure(skill: Skill): boolean {
    const exists = this.db.prepare('SELECT 1 FROM skills WHERE key = ?').get(skill.key);
    if (exists) return false;
    this.upsert(skill);
    return true;
  }

  get(key: SkillKey): Skill | null {
    const row = this.db.prepare('SELECT * FROM skills WHERE key = ?').get(key) as SkillRow | undefined;
    return row ? toSkill(row) : null;
  }

  require(key: SkillKey): Skill {
    const skill = this.get(key);
    if (!skill) throw notFound(`Skill '${key}'`);
    return skill;
  }

  list(onlyEnabled = false): Skill[] {
    const sql = onlyEnabled
      ? 'SELECT * FROM skills WHERE enabled = 1 ORDER BY category, name'
      : 'SELECT * FROM skills ORDER BY category, name';
    return (this.db.prepare(sql).all() as SkillRow[]).map(toSkill);
  }

  setEnabled(key: SkillKey, enabled: boolean): void {
    this.db
      .prepare('UPDATE skills SET enabled = ?, updated_at = ? WHERE key = ?')
      .run(fromBool(enabled), nowIso(), key);
  }

  /**
   * Which agents hold a given skill — the reuse the Constitution asks for is
   * only real if it can be counted.
   */
  holders(key: SkillKey): string[] {
    return (
      this.db
        .prepare(
          `SELECT key FROM agents
            WHERE enabled = 1
              AND EXISTS (SELECT 1 FROM json_each(agents.skills) s WHERE s.value = ?)
            ORDER BY key`,
        )
        .all(key) as Array<{ key: string }>
    ).map((r) => r.key);
  }
}
