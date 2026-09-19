import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtlasError, createLogger } from '@atlas/core';
import { createRepositories, proveReadonly } from '../src/index.ts';

/**
 * Une base ouverte en lecture seule l'est au sens de SQLite : le moteur
 * refuse d'écrire, quoi que le code demande. C'est la garantie qu'une
 * épreuve (restauration, instantané) exige d'une base vivante.
 */

const logger = createLogger({ level: 'error', pretty: false });

describe('createRepositories(…, { readonly: true })', () => {
  test('lit tout, n’écrit rien : une écriture — d’essai ou réelle — tombe en SQLITE_READONLY', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-ro-'));
    try {
      const rw = createRepositories(join(dir, 'atlas.db'), logger);
      rw.tasks.create({ taskType: 'DEMO_SLEEP', department: 'BACKGROUND', workerType: 'DETERMINISTIC', payload: {} });
      rw.close();

      const ro = createRepositories(join(dir, 'atlas.db'), logger, { readonly: true });
      try {
        assert.equal(Object.values(ro.tasks.countByStatus()).reduce((a, b) => a + b, 0), 1, 'la lecture marche');
        assert.equal(proveReadonly(ro.db).readonly, true);
        assert.throws(
          () => ro.tasks.create({ taskType: 'DEMO_SLEEP', department: 'BACKGROUND', workerType: 'DETERMINISTIC', payload: {} }),
          (e: unknown) => (e as { code?: string }).code === 'SQLITE_READONLY',
        );
      } finally { ro.close(); }

      const encore = createRepositories(join(dir, 'atlas.db'), logger, { readonly: true });
      try { assert.equal(Object.values(encore.tasks.countByStatus()).reduce((a, b) => a + b, 0), 1, 'rien n’a été écrit'); } finally { encore.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('une connexion en écriture accepte l’écriture d’essai : la preuve distingue vraiment les deux', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-ro-'));
    try {
      const rw = createRepositories(join(dir, 'atlas.db'), logger);
      try { assert.equal(proveReadonly(rw.db).readonly, false); } finally { rw.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('en lecture seule on ne migre pas : une base en retard est refusée, nommément', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-ro-'));
    try {
      const rw = createRepositories(join(dir, 'atlas.db'), logger);
      const derniere = (rw.db.prepare('SELECT MAX(version) v FROM schema_migrations').get() as { v: number }).v;
      rw.db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(derniere);
      rw.close();
      assert.throws(
        () => createRepositories(join(dir, 'atlas.db'), logger, { readonly: true }),
        (e: unknown) => e instanceof AtlasError && (e.details as { reason?: string }).reason === 'SCHEMA_BEHIND' && (e.details as { pending: number[] }).pending.includes(derniere),
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
