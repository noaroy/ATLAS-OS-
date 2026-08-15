import { readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AtlasConfig, Logger } from '@atlas/core';
import { describeError } from '@atlas/core';
import type { Repositories } from '@atlas/data';
import { backupDatabase } from '@atlas/data';

export interface BackupResult {
  path: string;
  bytes: number;
  pruned: number;
}

/**
 * Consistent online backup with retention (SRS §2.15, §5.15).
 *
 * `VACUUM INTO` writes a compacted, fully valid database while the system
 * keeps running, so nightly backups never require downtime and a restore is
 * just "put this file back".
 */
export function runBackup(
  repos: Repositories,
  config: AtlasConfig,
  logger: Logger,
  trigger: 'scheduled' | 'manual' | 'shutdown',
): BackupResult {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `atlas-${stamp}.db`;
  const destination = join(config.paths.backupDir, filename);

  const bytes = backupDatabase(repos.db, destination);
  repos.ops.recordBackup({ path: filename, bytes, trigger });

  const pruned = pruneOldBackups(repos, config, logger);
  logger.info('backup complete', { file: filename, mb: Math.round((bytes / 1024 / 1024) * 100) / 100, pruned });

  return { path: destination, bytes, pruned };
}

/** Keeps the newest N backups; deletes the rest from disk and the ledger. */
function pruneOldBackups(repos: Repositories, config: AtlasConfig, logger: Logger): number {
  const records = repos.ops.listBackups(500);
  const doomed = records.slice(config.backup.retention);
  let pruned = 0;

  for (const record of doomed) {
    try {
      const path = join(config.paths.backupDir, record.path);
      if (statSync(path).isFile()) unlinkSync(path);
      pruned++;
    } catch {
      // A file already removed by an operator is not an error worth raising.
    }
    repos.ops.forgetBackup(record.id);
  }

  // Sweep orphans: backup files with no ledger entry (e.g. a manual copy).
  try {
    const known = new Set(repos.ops.listBackups(500).map((b) => b.path));
    for (const file of readdirSync(config.paths.backupDir)) {
      if (!file.startsWith('atlas-') || !file.endsWith('.db')) continue;
      if (known.has(file)) continue;

      const path = join(config.paths.backupDir, file);
      const ageDays = (Date.now() - statSync(path).mtimeMs) / 86_400_000;
      if (ageDays > config.backup.retention) {
        unlinkSync(path);
        pruned++;
      }
    }
  } catch (err) {
    logger.warn('could not sweep orphaned backups', { error: describeError(err) });
  }

  return pruned;
}
