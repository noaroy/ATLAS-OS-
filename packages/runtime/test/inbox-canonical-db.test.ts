import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLogger } from '@atlas/core';
import { createRepositories } from '@atlas/data';

/**
 * Le premier import Gmail, tel qu'atlas-cli le lance, sur la base canonique.
 *
 * Relevé sur le VPS (v4.5.0) : `sales-inbox sync` ouvrait `data/atlas.db`
 * relatif au cwd — /app/data/atlas.db dans le conteneur, un dossier qui
 * n'existe pas — au lieu de la base que la configuration désigne. Ici, la
 * topologie du conteneur est rejouée : ATLAS_CLI_CONTEXT=docker, un
 * ATLAS_DATA_DIR temporaire pour /data, et les deux étapes de l'import
 * doivent écrire là, et seulement là. La base de développement du dépôt
 * (data/atlas.db) reste octet pour octet ce qu'elle était.
 */

const ROOT = resolve(import.meta.dirname, '../../..');
const logger = createLogger({ level: 'error', pretty: false });
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

let volume: string;
let db: string;
const devDb = join(ROOT, 'data', 'atlas.db');
const devDbHash = existsSync(devDb) ? sha256(devDb) : null;

function runInContainerLike(script: string, args: string[] = []) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ATLAS_CLI_CONTEXT: 'docker',
    ATLAS_DATA_DIR: volume,
    ATLAS_BACKUP_DIR: join(volume, 'backups'),
    ATLAS_LOG_LEVEL: 'error',
    ATLAS_AI_LIVE: 'false',
  };
  delete env.ATLAS_DB_PATH;
  for (const k of ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'GMAIL_USER']) delete env[k];
  return spawnSync(process.execPath, ['--import', 'tsx', join('scripts', script), ...args], { cwd: ROOT, encoding: 'utf8', env, timeout: 120_000 });
}

describe('l’import Gmail sur la base canonique (contexte conteneur)', () => {
  before(() => {
    volume = mkdtempSync(join(tmpdir(), 'atlas-inbox-volume-'));
    mkdirSync(join(volume, 'backups'));
    db = join(volume, 'atlas.db');
    // Une entreprise contactée dans le registre : de quoi ouvrir une conversation.
    const repos = createRepositories(db, logger);
    repos.sales.discover({ batchId: 'TEST-INBOX', companyName: 'Nordpack Test', domain: 'nordpack-test.invalid', discoveredAt: '2026-09-01T00:00:00.000Z' });
    repos.sales.recordOutreach({ domain: 'nordpack-test.invalid', kind: 'CONTACTED', recordedBy: 'test', channel: 'EMAIL', recordedAt: '2026-09-02T00:00:00.000Z' });
    assert.equal(repos.conversations.all().length, 0);
    repos.close();
  });

  after(() => {
    rmSync(volume, { recursive: true, force: true });
  });

  test('sales-inbox sync ouvre les conversations dans <ATLAS_DATA_DIR>/atlas.db, jamais dans <cwd>/data/atlas.db', () => {
    const r = runInContainerLike('sales-inbox.ts', ['sync']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.ok(!/Cannot open database/.test(r.stderr), r.stderr);
    assert.match(r.stdout, /1 conversation\(s\) ouverte\(s\)/);
    const repos = createRepositories(db, logger, { readonly: true });
    try {
      const conversations = repos.conversations.all();
      assert.equal(conversations.length, 1);
      assert.equal(conversations[0]?.canonicalDomain, 'nordpack-test.invalid');
    } finally { repos.close(); }
    if (devDbHash) assert.equal(sha256(devDb), devDbHash, 'la base de développement du dépôt n’a pas été touchée');
  });

  test('un second sales-inbox sync ne rouvre rien : idempotent', () => {
    const r = runInContainerLike('sales-inbox.ts', ['sync']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /0 conversation\(s\) ouverte\(s\)/);
    const repos = createRepositories(db, logger, { readonly: true });
    try { assert.equal(repos.conversations.all().length, 1); } finally { repos.close(); }
  });

  test('sales-inbox-sync (boîte figée) rattache dans la même base, et se rejoue sans doublon', () => {
    const fixture = join(volume, 'inbox.json');
    writeFileSync(fixture, JSON.stringify([{
      messageId: 'msg-test-1', threadId: 'thr-test-1', from: 'Anna <anna@nordpack-test.invalid>', to: ['commercial@atlas.example'],
      subject: 'Re: votre message', receivedAt: '2026-09-03T09:00:00.000Z', labels: ['INBOX'],
      bodyText: 'Merci, pouvez-vous nous rappeler la semaine prochaine ?', snippet: null, headers: {},
    }]));
    // --allow-production : c'est bien la base désignée par la config qu'on vise, en connaissance de cause.
    const premier = runInContainerLike('sales-inbox-sync.ts', [`--fixture=${fixture}`, '--allow-production']);
    assert.equal(premier.status, 0, `${premier.stdout}\n${premier.stderr}`);
    assert.ok(!/Cannot open database/.test(premier.stderr), premier.stderr);
    const second = runInContainerLike('sales-inbox-sync.ts', [`--fixture=${fixture}`, '--allow-production']);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    const repos = createRepositories(db, logger, { readonly: true });
    try {
      assert.equal(repos.conversations.alreadyImported('fixture', 'msg-test-1')?.disposition, 'IMPORTED', 'le message est consigné dans la base canonique');
      const events = repos.conversations.eventsFor(repos.conversations.all()[0]!.id);
      assert.equal(events.length, 1, 'un seul événement après deux synchronisations');
    } finally { repos.close(); }
    if (devDbHash) assert.equal(sha256(devDb), devDbHash);
  });
});
