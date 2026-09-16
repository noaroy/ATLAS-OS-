import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, statSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createLogger } from '../../core/src/logger.ts';
import { createRepositories, backupDatabase, type Repositories } from '../../data/src/index.ts';
import { makeTestConfig } from '../../testing/src/index.ts';
import { runBackup } from '../src/backup.ts';

/**
 * La sauvegarde : atomique, vérifiée, bornée, et restaurable sans toucher à
 * l'original. Ce que ces tests tiennent, c'est ce qu'on découvre trop tard
 * sinon — un fichier partiel pris pour la dernière copie, une rétention qui
 * ne retient rien, une « restauration » qui écrase la base qu'elle éprouve.
 */

const logger = createLogger({ level: 'error', pretty: false });
let dir: string;
let repos: Repositories;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-backup-'));
  repos = createRepositories(join(dir, 'atlas.db'), logger);
  mkdirSync(join(dir, 'backups'), { recursive: true });
  repos.salesEngine.createSegment({ name: 'Témoin' });
});
afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const integrity = (file: string): string => {
  const db = new Database(file, { readonly: true });
  try {
    return (db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>).map((r) => r.integrity_check).join('|');
  } finally {
    db.close();
  }
};

describe('sauvegarde', () => {
  test('écrit un fichier non vide, intègre, consigné au registre — et aucun fichier temporaire ne reste', () => {
    const config = makeTestConfig(dir);
    const result = runBackup(repos, config, logger, 'manual');
    assert.ok(result.bytes > 0);
    assert.ok(existsSync(result.path));
    assert.equal(integrity(result.path), 'ok');
    assert.equal(readdirSync(config.paths.backupDir).filter((f) => f.includes('.tmp-')).length, 0, 'le temporaire a été renommé');
    assert.equal(repos.ops.listBackups(10).length, 1);
    assert.equal(repos.ops.listBackups(10)[0]!.trigger, 'manual');
  });

  test('un échec d’écriture ne laisse ni copie partielle ni entrée au registre', () => {
    const cible = join(dir, 'inexistant', 'atlas-x.db');
    assert.throws(() => backupDatabase(repos.db, cible));
    assert.ok(!existsSync(cible));
    assert.ok(!existsSync(`${cible}.tmp-${process.pid}`));
    assert.equal(repos.ops.listBackups(10).length, 0);
  });

  test('la rétention garde les N plus récentes et supprime le reste du disque et du registre', async () => {
    const config = { ...makeTestConfig(dir), backup: { retention: 2 } };
    for (let i = 0; i < 4; i += 1) {
      runBackup(repos, config, logger, 'scheduled');
      await new Promise((r) => setTimeout(r, 5));
    }
    const fichiers = readdirSync(config.paths.backupDir).filter((f) => f.startsWith('atlas-') && f.endsWith('.db'));
    assert.equal(fichiers.length, 2);
    assert.equal(repos.ops.listBackups(10).length, 2);
  });

  test('la copie se restaure dans un chemin temporaire, se lit, et la base principale n’est pas touchée', () => {
    const config = makeTestConfig(dir);
    const { path } = runBackup(repos, config, logger, 'manual');
    const avant = statSync(config.paths.databaseFile);
    const scratch = mkdtempSync(join(tmpdir(), 'atlas-restore-test-'));
    const restored = join(scratch, 'restored.db');
    copyFileSync(path, restored);
    assert.equal(integrity(restored), 'ok');
    const copie = createRepositories(restored, logger);
    try {
      assert.equal(copie.salesEngine.segments().length, 1, 'la donnée témoin est dans la copie');
      assert.equal(copie.salesEngine.segments()[0]!.name, 'Témoin');
    } finally {
      copie.close();
    }
    const apres = statSync(config.paths.databaseFile);
    assert.equal(apres.size, avant.size, 'la base principale garde sa taille');
    assert.equal(apres.mtimeMs, avant.mtimeMs, 'la base principale n’a pas été réécrite');
    rmSync(scratch, { recursive: true, force: true });
  });
});
