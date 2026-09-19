import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '@atlas/core';

/**
 * La base que les outils de production ouvrent est celle de la config —
 * jamais un second calcul local.
 *
 * Relevé sur le VPS : `atlas-cli production-check` plantait sur « Cannot open
 * database because the directory does not exist ». Le script repliait sur
 * `data/atlas.db` relatif au cwd (/app dans le conteneur outils) alors que la
 * config, elle, savait déjà que la base est /data/atlas.db. Deux calculs, deux
 * réponses ; celui du script était faux. Ici on tient les deux vérités :
 * ce que la config répond dans le contexte du conteneur, et le fait que les
 * scripts servis par atlas-cli.sh ne portent plus le repli divergent.
 */

const ROOT = resolve(import.meta.dirname, '../../..');

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

describe('le chemin de base dans le contexte du conteneur outils', () => {
  test('cwd=/app sans data/, ATLAS_DATA_DIR=/data, ATLAS_CLI_CONTEXT=docker → <data>/atlas.db, et jamais <cwd>/data/atlas.db', () => {
    const app = mkdtempSync(join(tmpdir(), 'atlas-app-'));       // le /app du conteneur : le dépôt, sans data/
    const data = mkdtempSync(join(tmpdir(), 'atlas-data-'));     // le volume monté en /data
    mkdirSync(join(app, 'deployment'));
    try {
      const config = withEnv({ ATLAS_CLI_CONTEXT: 'docker', ATLAS_DATA_DIR: data, ATLAS_BACKUP_DIR: join(data, 'backups') }, () => loadConfig(app));
      assert.equal(config.paths.databaseFile, join(data, 'atlas.db'));
      assert.notEqual(config.paths.databaseFile, join(app, 'data', 'atlas.db'));
      assert.equal(existsSync(join(app, 'data')), false, 'le repli /app/data n’est ni ouvert ni créé');
    } finally {
      rmSync(app, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    }
  });

  test('ATLAS_DB_PATH explicite reste prioritaire, même dans le conteneur', () => {
    const app = mkdtempSync(join(tmpdir(), 'atlas-app-'));
    const data = mkdtempSync(join(tmpdir(), 'atlas-data-'));
    try {
      const archive = join(data, 'archive-2026-09.db');
      const config = withEnv({ ATLAS_CLI_CONTEXT: 'docker', ATLAS_DATA_DIR: data, ATLAS_BACKUP_DIR: join(data, 'backups'), ATLAS_DB_PATH: archive }, () => loadConfig(app));
      assert.equal(config.paths.databaseFile, archive);
    } finally {
      rmSync(app, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    }
  });
});

describe('les scripts servis par atlas-cli.sh lisent la base de la config', () => {
  /** La table de commandes du wrapper → le script npm → le fichier. */
  const wrapper = readFileSync(join(ROOT, 'deployment', 'atlas-cli.sh'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const mapped = [...wrapper.matchAll(/^\s+[a-z-]+\)\s+printf '([a-z:-]+)'/gm)].map((m) => m[1]!);

  test('la table du wrapper est lue', () => {
    assert.ok(mapped.includes('atlas:production-check') && mapped.includes('atlas:report') && mapped.includes('client:mission'), mapped.join(', '));
  });

  for (const script of mapped) {
    test(`${script} : aucun repli « data/atlas.db » relatif au cwd`, () => {
      const cmd = pkg.scripts[script];
      assert.ok(cmd, `script npm ${script} introuvable`);
      const file = /scripts\/([\w-]+\.ts)/.exec(cmd)?.[1];
      assert.ok(file, `${script} : pas un script tsx (${cmd})`);
      const source = readFileSync(join(ROOT, 'scripts', file), 'utf8');
      assert.ok(!/ATLAS_DB_PATH \?\? ['"]data\/atlas\.db['"]/.test(source), `${file} porte encore le repli divergent`);
      assert.ok(!/createRepositories\(['"]data\/atlas\.db['"]/.test(source), `${file} ouvre data/atlas.db en dur`);
    });
  }

  test('le chemin Gmail de production : sales-inbox, inbox-sync ouvrent config.paths.databaseFile ; gmail-check et gmail-read-check n’ouvrent aucune base', () => {
    // Relevé sur le VPS (v4.5.0) : le premier import Gmail (`sales-inbox sync`)
    // plantait sur /app/data/atlas.db — le repli relatif au cwd, dans le conteneur.
    for (const file of ['sales-inbox.ts', 'sales-inbox-sync.ts']) {
      const source = readFileSync(join(ROOT, 'scripts', file), 'utf8');
      assert.ok(!/'data\/atlas\.db'/.test(source), `${file} : plus aucun repli data/atlas.db`);
      assert.match(source, /const config = loadConfig\(process\.cwd\(\)\);/, `${file} charge la config`);
      assert.match(source, /createRepositories\(config\.paths\.databaseFile, logger\)|const dbPath = config\.paths\.databaseFile;/, `${file} ouvre la base de la config`);
    }
    for (const file of ['gmail-check.ts', 'gmail-read-check.ts']) {
      const source = readFileSync(join(ROOT, 'scripts', file), 'utf8');
      assert.ok(!/createRepositories\(/.test(source), `${file} ne touche aucune base`);
    }
    const wrapper = readFileSync(join(ROOT, 'deployment', 'atlas-cli.sh'), 'utf8');
    for (const cmd of ['sales-inbox)', 'inbox-sync)', 'gmail-check)', 'gmail-read-check)']) assert.ok(wrapper.includes(cmd), `atlas-cli : ${cmd}`);
    assert.match(wrapper, /inbox-initial-sync[\s\S]{0,200}npm run sales:inbox -- sync && npm run sales:inbox-sync/, 'le premier import en une commande, dans un seul conteneur');
  });

  test('atlas-production-check ouvre config.paths.databaseFile', () => {
    const source = readFileSync(join(ROOT, 'scripts', 'atlas-production-check.ts'), 'utf8');
    assert.match(source, /const dbPath = config\.paths\.databaseFile;/);
  });
});
