import type { MemoryHit, MemoryItem, MemoryKind, MemoryQuery, MemoryTier } from '@atlas/contracts';
import { id, nowIso } from '@atlas/core';
import type { Db } from '../database.ts';
import { fromJson, toJson } from '../database.ts';

interface MemoryRow {
  id: string;
  tier: MemoryTier;
  data_origin: string;
  kind: MemoryKind;
  title: string;
  content: string;
  metadata: string;
  tags: string;
  mission_id: string | null;
  agent_key: string | null;
  importance: number;
  confidence: number;
  access_count: number;
  last_accessed_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

const toItem = (row: MemoryRow): MemoryItem => ({
  id: row.id,
  tier: row.tier,
  dataOrigin: (row.data_origin ?? 'unknown') as MemoryItem['dataOrigin'],
  kind: row.kind,
  title: row.title,
  content: row.content,
  metadata: fromJson<Record<string, unknown>>(row.metadata, {}),
  tags: fromJson<string[]>(row.tags, []),
  missionId: row.mission_id,
  agentKey: row.agent_key,
  importance: row.importance,
  confidence: row.confidence,
  accessCount: row.access_count,
  lastAccessedAt: row.last_accessed_at,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Escapes a user query for FTS5 MATCH.
 *
 * FTS5 treats many characters as operators; passing raw user text straight
 * through is both a syntax-error and an injection risk. Every term is quoted
 * and ORed, which gives forgiving recall for natural-language recall queries.
 */
function toFtsQuery(text: string): string | null {
  const terms = text
    .replace(/["*()^:-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1)
    .slice(0, 12);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"*`).join(' OR ');
}

export class MemoryRepository {
  constructor(private readonly db: Db) {}

  insert(input: {
    tier: MemoryTier;
    dataOrigin?: MemoryItem['dataOrigin'];
    kind: MemoryKind;
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
    missionId?: string | null;
    agentKey?: string | null;
    importance?: number;
    confidence?: number;
    expiresAt?: string | null;
  }): MemoryItem {
    const now = nowIso();
    const row: MemoryRow = {
      id: id('mem'),
      tier: input.tier,
      data_origin: input.dataOrigin ?? 'unknown',
      kind: input.kind,
      title: input.title,
      content: input.content,
      metadata: toJson(input.metadata ?? {}),
      tags: toJson(input.tags ?? []),
      mission_id: input.missionId ?? null,
      agent_key: input.agentKey ?? null,
      importance: clamp01(input.importance ?? 0.5),
      confidence: clamp01(input.confidence ?? 0.7),
      access_count: 0,
      last_accessed_at: null,
      expires_at: input.expiresAt ?? null,
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO memory_items (id, tier, data_origin, kind, title, content, metadata, tags, mission_id,
                                   agent_key, importance, confidence, access_count,
                                   last_accessed_at, expires_at, created_at, updated_at)
         VALUES (@id, @tier, @data_origin, @kind, @title, @content, @metadata, @tags, @mission_id,
                 @agent_key, @importance, @confidence, @access_count,
                 @last_accessed_at, @expires_at, @created_at, @updated_at)`,
      )
      .run(row);
    return toItem(row);
  }

  /**
   * Les connaissances écrites par une mission donnée.
   *
   * Sert au verdict : une mémoire de lignée douteuse produite par une mission
   * réelle signale qu'une prémisse non établie a traversé le raisonnement.
   */
  forMission(missionId: string): MemoryItem[] {
    return (
      this.db
        .prepare('SELECT * FROM memory_items WHERE mission_id = ? ORDER BY created_at')
        .all(missionId) as MemoryRow[]
    ).map(toItem);
  }

  get(memoryId: string): MemoryItem | null {
    const row = this.db.prepare('SELECT * FROM memory_items WHERE id = ?').get(memoryId) as
      | MemoryRow
      | undefined;
    return row ? toItem(row) : null;
  }

  /** Detects a near-duplicate so repeated missions don't bloat the library. */
  findSimilar(tier: MemoryTier, title: string): MemoryItem | null {
    const row = this.db
      .prepare('SELECT * FROM memory_items WHERE tier = ? AND lower(title) = lower(?) LIMIT 1')
      .get(tier, title) as MemoryRow | undefined;
    return row ? toItem(row) : null;
  }

  update(
    memoryId: string,
    patch: Partial<Pick<MemoryItem, 'content' | 'importance' | 'confidence' | 'tags' | 'metadata' | 'tier'>>,
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id: memoryId, now: nowIso() };

    if (patch.content !== undefined) {
      sets.push('content = @content');
      params.content = patch.content;
    }
    if (patch.importance !== undefined) {
      sets.push('importance = @importance');
      params.importance = clamp01(patch.importance);
    }
    if (patch.confidence !== undefined) {
      sets.push('confidence = @confidence');
      params.confidence = clamp01(patch.confidence);
    }
    if (patch.tags !== undefined) {
      sets.push('tags = @tags');
      params.tags = toJson(patch.tags);
    }
    if (patch.metadata !== undefined) {
      sets.push('metadata = @metadata');
      params.metadata = toJson(patch.metadata);
    }
    if (patch.tier !== undefined) {
      sets.push('tier = @tier');
      params.tier = patch.tier;
    }
    if (sets.length === 0) return;

    this.db
      .prepare(`UPDATE memory_items SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`)
      .run(params);
  }

  /**
   * Ranked recall.
   *
   * Score blends three signals: textual relevance (BM25), curated importance,
   * and recency. A perfect keyword match on a stale, unimportant note should
   * not outrank a slightly weaker match on a strategic lesson.
   */
  search(query: MemoryQuery): MemoryHit[] {
    const limit = query.limit ?? 20;
    const params: Record<string, unknown> = { limit };
    const where: string[] = ['(m.expires_at IS NULL OR m.expires_at > @now)'];
    params.now = nowIso();

    if (query.tier) {
      where.push('m.tier = @tier');
      params.tier = query.tier;
    }
    if (query.missionId) {
      where.push('m.mission_id = @missionId');
      params.missionId = query.missionId;
    }
    if (query.agentKey) {
      where.push('m.agent_key = @agentKey');
      params.agentKey = query.agentKey;
    }
    if (query.minImportance !== undefined) {
      where.push('m.importance >= @minImportance');
      params.minImportance = query.minImportance;
    }
    if (query.kinds?.length) {
      where.push(`m.kind IN (${query.kinds.map((_, i) => `@kind${i}`).join(',')})`);
      query.kinds.forEach((k, i) => {
        params[`kind${i}`] = k;
      });
    }
    if (query.tags?.length) {
      // Tags are a JSON array; EXISTS over json_each keeps this indexable-ish
      // and avoids brittle LIKE matching on serialized JSON.
      where.push(
        `EXISTS (SELECT 1 FROM json_each(m.tags) t WHERE t.value IN (${query.tags
          .map((_, i) => `@tag${i}`)
          .join(',')}))`,
      );
      query.tags.forEach((t, i) => {
        params[`tag${i}`] = t;
      });
    }

    const ftsQuery = query.text ? toFtsQuery(query.text) : null;

    if (ftsQuery) {
      params.fts = ftsQuery;
      const rows = this.db
        .prepare(
          `SELECT m.*, bm25(memory_fts) AS rank
           FROM memory_fts
           JOIN memory_items m ON m.rowid = memory_fts.rowid
           WHERE memory_fts MATCH @fts AND ${where.join(' AND ')}
           ORDER BY rank
           LIMIT @limit`,
        )
        .all(params) as Array<MemoryRow & { rank: number }>;

      return rows
        .map((row) => {
          const item = toItem(row);
          // bm25 returns a negative score where lower is better.
          const relevance = 1 / (1 + Math.max(0, -row.rank));
          return { ...item, score: combineScore(relevance, item) };
        })
        .sort((a, b) => b.score - a.score);
    }

    const rows = this.db
      .prepare(
        `SELECT m.* FROM memory_items m
         WHERE ${where.join(' AND ')}
         ORDER BY m.importance DESC, m.created_at DESC
         LIMIT @limit`,
      )
      .all(params) as MemoryRow[];

    return rows.map((row) => {
      const item = toItem(row);
      return { ...item, score: combineScore(0.5, item) };
    });
  }

  /** Records that memories were used — feeds importance reinforcement. */
  markAccessed(ids: string[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      'UPDATE memory_items SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?',
    );
    const now = nowIso();
    const run = this.db.transaction(() => {
      for (const memoryId of ids) stmt.run(now, memoryId);
    });
    run();
  }

  delete(memoryId: string): void {
    this.db.prepare('DELETE FROM memory_items WHERE id = ?').run(memoryId);
  }

  countByTier(): Record<MemoryTier, number> {
    const rows = this.db.prepare('SELECT tier, COUNT(*) AS n FROM memory_items GROUP BY tier').all() as
      Array<{ tier: MemoryTier; n: number }>;
    const result: Record<MemoryTier, number> = { operational: 0, strategic: 0, business: 0 };
    for (const row of rows) result[row.tier] = row.n;
    return result;
  }

  total(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM memory_items').get() as { n: number }).n;
  }

  /** Removes expired entries. Run by the consolidation job. */
  purgeExpired(): number {
    return this.db
      .prepare('DELETE FROM memory_items WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .run(nowIso()).changes;
  }

  /** Drops low-value operational noise once a mission is long finished. */
  purgeLowValue(tier: MemoryTier, minImportance: number, olderThanIso: string): number {
    return this.db
      .prepare(
        `DELETE FROM memory_items
         WHERE tier = ? AND importance < ? AND created_at < ? AND access_count = 0`,
      )
      .run(tier, minImportance, olderThanIso).changes;
  }

  /** Candidates for promotion into long-term memory. */
  promotionCandidates(minAccessCount: number, minImportance: number, limit = 25): MemoryItem[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM memory_items
           WHERE tier = 'operational' AND (access_count >= ? OR importance >= ?)
           ORDER BY access_count DESC, importance DESC
           LIMIT ?`,
        )
        .all(minAccessCount, minImportance, limit) as MemoryRow[]
    ).map(toItem);
  }

  recent(limit = 20): MemoryItem[] {
    return (
      this.db
        .prepare('SELECT * FROM memory_items ORDER BY created_at DESC LIMIT ?')
        .all(limit) as MemoryRow[]
    ).map(toItem);
  }
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Relevance × importance × recency, weighted so no single signal dominates. */
function combineScore(relevance: number, item: MemoryItem): number {
  const ageDays = (Date.now() - Date.parse(item.createdAt)) / 86_400_000;
  // Half-life of 45 days: old knowledge stays reachable but yields to fresh work.
  const recency = Math.exp(-ageDays / 45);
  const reinforcement = Math.min(1, item.accessCount / 10);
  const score =
    relevance * 0.5 + item.importance * 0.3 + recency * 0.12 + reinforcement * 0.08;
  return Math.round(score * 1000) / 1000;
}
