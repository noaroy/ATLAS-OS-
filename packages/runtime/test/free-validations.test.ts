import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { createLogger } from '@atlas/core';
import { backupDatabase, createRepositories, snapshotDatabase } from '@atlas/data';
import { BUSINESS_EXPANSION } from '@atlas/departments';
import { createClientRun } from '../src/client-mission.ts';
import { brief } from './fixtures/sweden-mission.ts';

/**
 * Les deux épreuves gratuites — restauration et daemon — jouées comme
 * atlas-cli les joue, contre une base qui ne doit pas bouger.
 *
 * Sur le serveur, la base canonique est vivante et unique. Une épreuve qui y
 * déposerait une tâche, y lancerait un second daemon ou la comparerait à une
 * sauvegarde d'hier soir mentirait ou nuirait. Ici on tient les garanties :
 * la source n'est ouverte qu'en lecture (même empreinte avant et après),
 * aucune tâche n'y apparaît, aucun tour de daemon ne s'y inscrit, les reçus
 * disent « instantané », et les verdicts sont vrais.
 */

const ROOT = resolve(import.meta.dirname, '../../..');
const logger = createLogger({ level: 'error', pretty: false });
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

let dir: string;
let dataDir: string;
let db: string;
let hashAvant: string;
let missionId: string;

/** Lance un script du dépôt contre ce jeu de données, comme le wrapper le ferait. */
function runScript(script: string, extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ATLAS_DATA_DIR: dataDir, ATLAS_BACKUP_DIR: join(dataDir, 'backups'), ATLAS_AI_LIVE: 'false', ATLAS_LOG_LEVEL: 'error', ...extraEnv };
  delete env.ATLAS_DB_PATH;
  return spawnSync(process.execPath, ['--import', 'tsx', join('scripts', script)], { cwd: ROOT, encoding: 'utf8', env, timeout: 120_000 });
}

function compte(file: string, table: string): number {
  const d = new Database(file, { readonly: true });
  try { return (d.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n; } finally { d.close(); }
}

describe('épreuves gratuites sur une base vivante', () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-free-checks-'));
    dataDir = join(dir, 'data');
    mkdirSync(join(dataDir, 'backups'), { recursive: true });
    db = join(dataDir, 'atlas.db');
    // Une base avec de la matière : une mission client et une sauvegarde « d'hier ».
    const repos = createRepositories(db, logger);
    repos.departments.ensure(BUSINESS_EXPANSION);
    missionId = createClientRun(repos, brief(), 'test');
    // De la matière mesurable : restore-check refuse une source entièrement vide.
    repos.tasks.create({ taskType: 'DEMO_SLEEP', department: 'BACKGROUND', workerType: 'DETERMINISTIC', payload: { durationMs: 1 } });
    backupDatabase(repos.db, join(dataDir, 'backups', 'atlas-2026-09-18T02-15-00-000Z.db'));
    repos.close();
    hashAvant = sha256(db);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('snapshotDatabase : une image intègre, la source ouverte en lecture seule et inchangée', () => {
    const cible = join(dir, 'snap.db');
    const bytes = snapshotDatabase(db, cible);
    assert.ok(bytes > 0);
    assert.equal(sha256(db), hashAvant);
    const d = new Database(cible, { readonly: true });
    try {
      assert.deepEqual(d.prepare('PRAGMA integrity_check').all(), [{ integrity_check: 'ok' }]);
      assert.equal((d.prepare('SELECT COUNT(*) n FROM missions WHERE id = ?').get(missionId) as { n: number }).n, 1, 'la mission est dans l’instantané');
    } finally { d.close(); }
  });

  test('restore-check : la sauvegarde stockée est restaurable, l’instantané frais est fidèle, la source ne bouge pas', () => {
    const r = runScript('restore-check.ts');
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /RESTAURATION VÉRIFIÉE/);
    assert.match(r.stdout, /sauvegarde stockée restaurable/);
    assert.equal(sha256(db), hashAvant, 'la base source est identique octet pour octet');
    const recu = JSON.parse(readFileSync(join(dataDir, 'backups', 'restore-check.json'), 'utf8')) as { ok: boolean; detail: string };
    assert.equal(recu.ok, true, recu.detail);
    assert.ok(!existsSync(join(dataDir, 'restored.db')), 'rien n’est restauré à côté de la base');
  });

  test('daemon-check : tourne sur un instantané — aucune tâche ni tour de daemon n’entre dans la source, le reçu le dit', () => {
    const tachesAvant = compte(db, 'tasks');
    const toursAvant = compte(db, 'daemon_runs');
    const r = runScript('daemon-main-db-check.ts');
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /DAEMON ÉPROUVÉ SUR UN INSTANTANÉ/);
    assert.match(r.stdout, /12\/12/);
    assert.equal(sha256(db), hashAvant, 'la base source est identique octet pour octet');
    assert.equal(compte(db, 'tasks'), tachesAvant, 'la sonde n’a pas été déposée dans la source');
    assert.equal(compte(db, 'daemon_runs'), toursAvant, 'aucun tour de daemon inscrit dans la source');
    const recu = JSON.parse(readFileSync(join(dataDir, 'backups', 'daemon-main-db-check.json'), 'utf8')) as { ok: boolean; mode: string; db: string };
    assert.equal(recu.ok, true);
    assert.equal(recu.mode, 'snapshot');
    assert.equal(recu.db, db);
  });
});
