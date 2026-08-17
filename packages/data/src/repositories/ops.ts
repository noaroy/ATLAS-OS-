import type { Alert, ResourceSnapshot } from '@atlas/contracts';
import { id, nowIso } from '@atlas/core';
import type { Db } from '../database.ts';
import { toBool, fromBool } from '../database.ts';

interface AlertRow {
  id: string;
  level: Alert['level'];
  title: string;
  detail: string;
  source: string;
  acknowledged: number;
  created_at: string;
}

const toAlert = (row: AlertRow): Alert => ({
  id: row.id,
  level: row.level,
  title: row.title,
  detail: row.detail,
  source: row.source,
  acknowledged: toBool(row.acknowledged),
  createdAt: row.created_at,
});

/** Operational surface: alerts, resource sampling, and backup bookkeeping. */
export class OpsRepository {
  constructor(private readonly db: Db) {}

  // ─── Alerts ─────────────────────────────────────────────────────────────

  raiseAlert(input: {
    level: Alert['level'];
    title: string;
    detail?: string;
    source: string;
  }): Alert {
    const row: AlertRow = {
      id: id('alr'),
      level: input.level,
      title: input.title,
      detail: input.detail ?? '',
      source: input.source,
      acknowledged: 0,
      created_at: nowIso(),
    };

    this.db
      .prepare(
        `INSERT INTO alerts (id, level, title, detail, source, acknowledged, created_at)
         VALUES (@id, @level, @title, @detail, @source, @acknowledged, @created_at)`,
      )
      .run(row);
    return toAlert(row);
  }

  /**
   * Raises an alert only if an identical one is not already open, so a
   * persistent fault produces one actionable item rather than a flood.
   */
  raiseAlertOnce(input: { level: Alert['level']; title: string; detail?: string; source: string }): Alert | null {
    const existing = this.db
      .prepare('SELECT 1 FROM alerts WHERE title = ? AND source = ? AND acknowledged = 0')
      .get(input.title, input.source);
    if (existing) return null;
    return this.raiseAlert(input);
  }

  listAlerts(includeAcknowledged = false, limit = 100): Alert[] {
    const sql = includeAcknowledged
      ? 'SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM alerts WHERE acknowledged = 0 ORDER BY created_at DESC LIMIT ?';
    return (this.db.prepare(sql).all(limit) as AlertRow[]).map(toAlert);
  }

  acknowledgeAlert(alertId: string): void {
    this.db.prepare('UPDATE alerts SET acknowledged = ? WHERE id = ?').run(fromBool(true), alertId);
  }

  acknowledgeAll(): number {
    return this.db.prepare('UPDATE alerts SET acknowledged = 1 WHERE acknowledged = 0').run().changes;
  }

  openAlertCount(): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE acknowledged = 0').get() as { n: number }
    ).n;
  }

  /**
   * Alertes graves et récentes — celles qui décrivent un problème *actuel*.
   *
   * Distinguer compte, parce que la santé du système et le nombre de messages
   * non lus sont deux choses. Quatorze alertes non acquittées, toutes issues de
   * missions échouées les jours précédents, suffisaient à déclarer ATLAS
   * « dégradé » : le tableau de bord annonçait une panne là où il n'y avait
   * qu'un arriéré de lecture. Rien n'est masqué pour autant — le total continue
   * d'être affiché, et une vraie panne se signale par une alerte récente.
   */
  recentSevereAlertCount(withinMs: number): number {
    const since = new Date(Date.now() - withinMs).toISOString();
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM alerts
           WHERE acknowledged = 0 AND created_at >= ? AND level IN ('error', 'critical')`,
        )
        .get(since) as { n: number }
    ).n;
  }

  // ─── Resource samples ───────────────────────────────────────────────────

  recordSample(snapshot: ResourceSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO resource_samples (id, cpu_load, memory_used_mb, memory_total_mb, db_size_mb, event_backlog, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id('smp'),
        snapshot.cpuLoad,
        snapshot.memoryUsedMb,
        snapshot.memoryTotalMb,
        snapshot.databaseSizeMb,
        snapshot.eventBacklog,
        nowIso(),
      );
  }

  recentSamples(limit = 120): Array<ResourceSnapshot & { createdAt: string }> {
    const rows = this.db
      .prepare('SELECT * FROM resource_samples ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<{
      cpu_load: number;
      memory_used_mb: number;
      memory_total_mb: number;
      db_size_mb: number;
      event_backlog: number;
      created_at: string;
    }>;

    return rows.reverse().map((r) => ({
      cpuLoad: r.cpu_load,
      memoryUsedMb: r.memory_used_mb,
      memoryTotalMb: r.memory_total_mb,
      databaseSizeMb: r.db_size_mb,
      eventBacklog: r.event_backlog,
      createdAt: r.created_at,
    }));
  }

  pruneSamples(olderThanIso: string): number {
    return this.db.prepare('DELETE FROM resource_samples WHERE created_at < ?').run(olderThanIso).changes;
  }

  // ─── Backups ────────────────────────────────────────────────────────────

  recordBackup(input: { path: string; bytes: number; trigger: string }): void {
    this.db
      .prepare('INSERT INTO backups (id, path, bytes, trigger, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id('bak'), input.path, input.bytes, input.trigger, nowIso());
  }

  listBackups(limit = 50): Array<{ id: string; path: string; bytes: number; trigger: string; createdAt: string }> {
    const rows = this.db
      .prepare('SELECT * FROM backups ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<{
      id: string;
      path: string;
      bytes: number;
      trigger: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      bytes: r.bytes,
      trigger: r.trigger,
      createdAt: r.created_at,
    }));
  }

  forgetBackup(backupId: string): void {
    this.db.prepare('DELETE FROM backups WHERE id = ?').run(backupId);
  }
}
