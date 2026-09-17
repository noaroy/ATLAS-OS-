import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { AtlasError, createLogger, loadConfig } from '@atlas/core';
import { createRepositories } from '@atlas/data';
import { BUSINESS_EXPANSION } from '@atlas/departments';
import { createClientRun, loadClientRun } from '../src/client-mission.ts';
import { brief } from './fixtures/sweden-mission.ts';

/**
 * Une seule base en production : celle du volume.
 *
 * Le serveur (conteneur `atlas`) et les outils (conteneur `atlas-cli`) montent
 * le même volume en /data et reçoivent ATLAS_DATA_DIR=/data : ils ouvrent le
 * même fichier, /data/atlas.db. Ce test rejoue la topologie avec un dossier
 * temporaire pour volume — deux configurations, deux connexions, un fichier —
 * et vérifie que ce qu'un côté écrit, l'autre le lit ; qu'aucune base ne naît
 * ailleurs ; que le fichier reste intègre. Aucune base réelle n'est touchée.
 */

const logger = createLogger({ level: 'error', pretty: false });

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith('ATLAS_')) delete process.env[key];
    process.env.ATLAS_SESSION_SECRET = 'x'.repeat(32);
    Object.assign(process.env, env);
    return fn();
  } finally {
    process.env = saved;
  }
}

describe('serveur et atlas-cli : une base, un fichier', () => {
  test('même volume, même ATLAS_DATA_DIR → même fichier ; une mission créée côté outils est visible côté serveur ; integrity_check ok', () => {
    const volume = mkdtempSync(join(tmpdir(), 'atlas-data-volume-'));
    const depot = mkdtempSync(join(tmpdir(), 'atlas-depot-'));
    mkdirSync(join(depot, 'deployment'));
    writeFileSync(join(depot, 'deployment', 'docker-compose.private.yml'), 'services: {}\n');
    try {
      // Les deux conteneurs, tels que Compose les configure.
      const serveur = withEnv({ ATLAS_DATA_DIR: volume, ATLAS_BACKUP_DIR: join(volume, 'backups') }, () => loadConfig(depot));
      const outils = withEnv({ ATLAS_DATA_DIR: volume, ATLAS_BACKUP_DIR: join(volume, 'backups'), ATLAS_CLI_CONTEXT: 'docker' }, () => loadConfig(depot));
      assert.equal(serveur.paths.databaseFile, join(volume, 'atlas.db'));
      assert.equal(outils.paths.databaseFile, serveur.paths.databaseFile, 'le même fichier logique');

      // Deux connexions, comme deux processus.
      const cli = createRepositories(outils.paths.databaseFile, logger);
      const srv = createRepositories(serveur.paths.databaseFile, logger);
      try {
        cli.departments.ensure(BUSINESS_EXPANSION);
        const runId = createClientRun(cli, brief(), 'atlas-cli');
        // Le serveur la voit, sans redémarrer, sans copier.
        const vue = loadClientRun(srv, runId);
        assert.equal(vue.brief.client.name, brief().client.name);
        assert.equal(srv.missions.get(runId)?.id, runId);
      } finally {
        cli.close();
        srv.close();
      }

      // Une base sous data/ du dépôt ? Jamais : ni par le serveur, ni par les outils.
      assert.equal(existsSync(join(depot, 'data')), false);
      // Le volume porte une base, et une seule (WAL compris, c'est le même fichier).
      const fichiers = readdirSync(volume).filter((f) => f.endsWith('.db'));
      assert.deepEqual(fichiers, ['atlas.db']);

      const verif = new Database(join(volume, 'atlas.db'), { readonly: true });
      try {
        assert.deepEqual(verif.prepare('PRAGMA integrity_check').all(), [{ integrity_check: 'ok' }]);
      } finally { verif.close(); }
    } finally {
      rmSync(volume, { recursive: true, force: true });
      rmSync(depot, { recursive: true, force: true });
    }
  });

  test('depuis l’hôte du dépôt déployé, sans choix explicite : refus, et data/atlas.db n’apparaît pas', () => {
    const depot = mkdtempSync(join(tmpdir(), 'atlas-depot-'));
    mkdirSync(join(depot, 'deployment'));
    writeFileSync(join(depot, 'deployment', 'docker-compose.private.yml'), 'services: {}\n');
    try {
      withEnv({}, () => {
        assert.throws(() => loadConfig(depot), (err: unknown) => err instanceof AtlasError && (err.details as { reason?: string } | undefined)?.reason === 'HOST_DB_GUARD');
      });
      assert.equal(existsSync(join(depot, 'data', 'atlas.db')), false);
      assert.equal(existsSync(join(depot, 'data')), false);
    } finally { rmSync(depot, { recursive: true, force: true }); }
  });
});
