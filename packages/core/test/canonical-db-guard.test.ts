import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AtlasError, canonicalDatabaseGuard, loadConfig } from '@atlas/core';

/**
 * La garde de la base canonique.
 *
 * Sur le serveur, la base vit dans le volume Docker ; le dépôt déployé porte
 * `deployment/docker-compose.private.yml`. Une commande lancée depuis l'hôte
 * dans ce dépôt ne doit ni ouvrir ni créer ./data/atlas.db — et doit dire
 * quoi lancer à la place. Partout ailleurs, rien ne change.
 */

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

/** Un dépôt déployé, en miniature : le fichier privé, et rien sous data/. */
function depotDeploye(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-depot-'));
  mkdirSync(join(dir, 'deployment'));
  writeFileSync(join(dir, 'deployment', 'docker-compose.private.yml'), 'services:\n  atlas:\n    ports:\n      - "127.0.0.1:4700:4700"\n');
  return dir;
}

describe('canonicalDatabaseGuard : la décision, seule', () => {
  test('le dépôt déployé, la base par défaut, aucun choix explicite : refus, avec la marche à suivre', () => {
    const cwd = depotDeploye();
    try {
      const g = canonicalDatabaseGuard({ cwd, dataDir: join(cwd, 'data'), env: {} });
      assert.equal(g.blocked, true);
      assert.match(g.reason ?? '', /docker-compose\.private\.yml/);
      assert.match(g.reason ?? '', /atlas-cli\.sh/);
      assert.match(g.reason ?? '', /ATLAS_DB_PATH/);
      assert.match(g.reason ?? '', /ATLAS_ALLOW_HOST_DB/);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('ATLAS_CANONICAL_DB=docker suffit, sans fichier privé', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'atlas-depot-'));
    try {
      assert.equal(canonicalDatabaseGuard({ cwd, dataDir: join(cwd, 'data'), env: { ATLAS_CANONICAL_DB: 'docker' } }).blocked, true);
      assert.equal(canonicalDatabaseGuard({ cwd, dataDir: join(cwd, 'data'), env: {} }).blocked, false, 'un dépôt de développement : rien ne bloque');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('la garde se tait quand le choix est explicite : conteneur outils, ATLAS_DB_PATH, ATLAS_ALLOW_HOST_DB, autre ATLAS_DATA_DIR', () => {
    const cwd = depotDeploye();
    try {
      const data = join(cwd, 'data');
      assert.equal(canonicalDatabaseGuard({ cwd, dataDir: data, env: { ATLAS_CLI_CONTEXT: 'docker' } }).blocked, false, 'dans le conteneur');
      assert.equal(canonicalDatabaseGuard({ cwd, dataDir: data, env: { ATLAS_DB_PATH: '/archive/atlas-2026-09.db' } }).blocked, false, 'un fichier choisi');
      assert.equal(canonicalDatabaseGuard({ cwd, dataDir: data, env: { ATLAS_ALLOW_HOST_DB: '1' } }).blocked, false, 'en connaissance de cause');
      assert.equal(canonicalDatabaseGuard({ cwd, dataDir: join(cwd, 'ailleurs'), env: {} }).blocked, false, 'un autre dossier de données : une copie, un test');
      assert.equal(canonicalDatabaseGuard({ cwd, dataDir: data, env: { ATLAS_ALLOW_HOST_DB: 'false' } }).blocked, true, '« false » n’autorise rien');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});

describe('loadConfig : la garde avant toute création', () => {
  test('sur le dépôt déployé, loadConfig refuse et ne crée pas data/', () => {
    const cwd = depotDeploye();
    try {
      withEnv({}, () => {
        assert.throws(() => loadConfig(cwd), (err: unknown) => err instanceof AtlasError && err.code === 'FORBIDDEN' && /atlas-cli\.sh/.test(err.message));
      });
      assert.equal(existsSync(join(cwd, 'data')), false, 'aucune seconde base, pas même un dossier');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('dans le conteneur outils (ATLAS_CLI_CONTEXT=docker, ATLAS_DATA_DIR=/data), la base est celle du volume', () => {
    const cwd = depotDeploye();
    const volume = mkdtempSync(join(tmpdir(), 'atlas-volume-'));
    try {
      const config = withEnv({ ATLAS_CLI_CONTEXT: 'docker', ATLAS_DATA_DIR: volume, ATLAS_BACKUP_DIR: join(volume, 'backups') }, () => loadConfig(cwd));
      assert.equal(config.paths.databaseFile, join(volume, 'atlas.db'));
      assert.equal(existsSync(join(cwd, 'data')), false);
    } finally { rmSync(cwd, { recursive: true, force: true }); rmSync(volume, { recursive: true, force: true }); }
  });

  test('ATLAS_DB_PATH désigne le fichier, relatif au dépôt ou absolu', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'atlas-depot-'));
    try {
      const rel = withEnv({ ATLAS_DB_PATH: 'archives/atlas-2026-09.db', ATLAS_DATA_DIR: join(cwd, 'd'), ATLAS_BACKUP_DIR: join(cwd, 'd', 'b') }, () => loadConfig(cwd));
      assert.equal(rel.paths.databaseFile, resolve(cwd, 'archives', 'atlas-2026-09.db'));
      const abs = withEnv({ ATLAS_DB_PATH: join(cwd, 'x.db'), ATLAS_DATA_DIR: join(cwd, 'd'), ATLAS_BACKUP_DIR: join(cwd, 'd', 'b') }, () => loadConfig(cwd));
      assert.equal(abs.paths.databaseFile, join(cwd, 'x.db'));
      const defaut = withEnv({ ATLAS_DATA_DIR: join(cwd, 'd'), ATLAS_BACKUP_DIR: join(cwd, 'd', 'b') }, () => loadConfig(cwd));
      assert.equal(defaut.paths.databaseFile, join(cwd, 'd', 'atlas.db'), 'sans ATLAS_DB_PATH : <ATLAS_DATA_DIR>/atlas.db, comme avant');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});

/**
 * La garde ne protège que ce qui passe par `loadConfig()`. Un script
 * d'administration qui ouvrirait `data/atlas.db` (ou `ATLAS_DB_PATH`)
 * directement, sans passer par la config, contournerait la garde en
 * silence — exactement la panne que son commentaire décrit : deux bases
 * pour un même dépôt, l'hôte et le volume Docker, sans qu'aucune erreur ne
 * le dise. L'assertion porte sur ce qui s'exécute, pas sur la prose : les
 * commentaires et chaînes documentaires sont retirés avant de chercher le
 * motif interdit.
 */
describe('les commandes d’administration passent par la base canonique', () => {
  const strip = (raw: string) => raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const atlasTask = strip(readFileSync(new URL('../../../scripts/atlas-task.ts', import.meta.url), 'utf8'));
  const atlasApply = strip(readFileSync(new URL('../../../scripts/atlas-apply.ts', import.meta.url), 'utf8'));

  test('atlas-task : loadConfig(), jamais data/atlas.db en dur', () => {
    assert.equal(atlasTask.includes("?? 'data/atlas.db'"), false, 'ouvrirait une seconde base sur l’hôte, hors garde');
    assert.match(atlasTask, /loadConfig\(/);
    assert.match(atlasTask, /createRepositories\(config\.paths\.databaseFile/);
  });

  test('atlas-apply : loadConfig(), jamais data/atlas.db en dur', () => {
    assert.equal(atlasApply.includes("?? 'data/atlas.db'"), false, 'ouvrirait une seconde base sur l’hôte, hors garde');
    assert.match(atlasApply, /loadConfig\(/);
    assert.match(atlasApply, /createRepositories\(config\.paths\.databaseFile/);
  });
});
