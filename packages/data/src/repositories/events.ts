import type { EventSeverity, EventType, SystemEvent } from '@atlas/contracts';
import type { Db } from '../database.ts';
import { fromJson, toJson } from '../database.ts';

interface EventRow {
  id: string;
  type: EventType;
  severity: EventSeverity;
  source: string;
  mission_id: string | null;
  agent_key: string | null;
  message: string;
  payload: string;
  created_at: string;
}

const toEvent = (row: EventRow): SystemEvent => ({
  id: row.id,
  type: row.type,
  severity: row.severity,
  source: row.source,
  missionId: row.mission_id,
  agentKey: row.agent_key,
  message: row.message,
  payload: fromJson<Record<string, unknown>>(row.payload, {}),
  createdAt: row.created_at,
});

/**
 * Durable event log (SRS §2.14).
 *
 * Writes are batched by the caller where possible; `debug` events are dropped
 * at the persistence boundary so the log stays diagnosable rather than noisy.
 */
export class EventRepository {
  #insert;

  constructor(private readonly db: Db) {
    this.#insert = db.prepare(
      `INSERT INTO events (id, type, severity, source, mission_id, agent_key, message, payload, created_at)
       VALUES (@id, @type, @severity, @source, @mission_id, @agent_key, @message, @payload, @created_at)`,
    );
  }

  append(event: SystemEvent): void {
    if (event.severity === 'debug') return;
    this.#insert.run({
      id: event.id,
      type: event.type,
      severity: event.severity,
      source: event.source,
      mission_id: event.missionId,
      agent_key: event.agentKey,
      message: event.message,
      payload: toJson(event.payload),
      created_at: event.createdAt,
    });
  }

  list(options: {
    type?: EventType;
    severity?: EventSeverity;
    missionId?: string;
    agentKey?: string;
    before?: string;
    limit: number;
  }): SystemEvent[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: options.limit };

    if (options.type) {
      where.push('type = @type');
      params.type = options.type;
    }
    if (options.severity) {
      where.push('severity = @severity');
      params.severity = options.severity;
    }
    if (options.missionId) {
      where.push('mission_id = @missionId');
      params.missionId = options.missionId;
    }
    if (options.agentKey) {
      where.push('agent_key = @agentKey');
      params.agentKey = options.agentKey;
    }
    if (options.before) {
      where.push('created_at < @before');
      params.before = options.before;
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return (
      this.db
        .prepare(`SELECT * FROM events ${clause} ORDER BY created_at DESC, id DESC LIMIT @limit`)
        .all(params) as EventRow[]
    ).map(toEvent);
  }

  forMission(missionId: string, limit = 200): SystemEvent[] {
    return this.list({ missionId, limit });
  }

  countBySeverity(since: string): Record<string, number> {
    const rows = this.db
      .prepare('SELECT severity, COUNT(*) AS n FROM events WHERE created_at >= ? GROUP BY severity')
      .all(since) as Array<{ severity: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.severity, r.n]));
  }

  /** Retention: keeps the log useful without letting it grow without bound. */
  prune(olderThanIso: string, keepSeverities: EventSeverity[] = ['error', 'critical']): number {
    const placeholders = keepSeverities.map(() => '?').join(',');
    return this.db
      .prepare(`DELETE FROM events WHERE created_at < ? AND severity NOT IN (${placeholders})`)
      .run(olderThanIso, ...keepSeverities).changes;
  }
}
