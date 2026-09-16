import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../core/src/logger.ts';
import { createRepositories, type Repositories } from '../src/index.ts';

/**
 * L'invariant de comptage d'une mission client (benchmark VPS, §4) : une
 * ligne par domaine, un état par ligne, la somme des états égale au nombre
 * de lignes — et les annuaires écartés avant lecture nommés à part, pour que
 * « 20 nouveaux » et « 21 inscrits » ne se lisent plus comme une erreur.
 */

const logger = createLogger({ level: 'error', pretty: false });
let dir: string;
let repos: Repositories;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-cc-invariant-'));
  repos = createRepositories(join(dir, 'atlas.db'), logger);
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('mission client : invariant de comptage', () => {
  test('la somme des états vaut le nombre de lignes, une ligne par domaine, les annuaires nommés à part', () => {
    const runId = 'msn_test_invariant';
    const c = repos.clientCandidates;
    const a = c.discover({ runId, domain: 'a.se', url: 'https://a.se/', batch: 1, briefVersion: 1 }).candidate;
    const b = c.discover({ runId, domain: 'b.se', url: 'https://b.se/', batch: 1, briefVersion: 1 }).candidate;
    const annuaire = c.discover({ runId, domain: 'europages.se', url: 'https://europages.se/x', batch: 1, briefVersion: 1 }).candidate;
    c.setStage(annuaire.id, 'EXCLUDED', { category: 'DIRECTORY', reason: 'annuaire' });
    c.setStage(a.id, 'RETAINED');
    c.markFailed(b.id, 'lent');
    // Le même domaine redécouvert au lot suivant ne crée pas de ligne.
    assert.equal(c.discover({ runId, domain: 'a.se', url: 'https://a.se/autre', batch: 2, briefVersion: 1 }).created, false);
    const s = c.summary(runId);
    assert.equal(s.total, 3);
    assert.equal(s.distinctDomains, 3);
    assert.equal(s.prefiltered, 1);
    assert.equal(s.candidates, 2);
    assert.equal(Object.values(s.byStage).reduce((x, y) => x + y, 0), s.total);
    assert.equal(s.consistent, true);
    assert.deepEqual({ RETAINED: s.byStage.RETAINED, FAILED_RETRYABLE: s.byStage.FAILED_RETRYABLE, EXCLUDED: s.byStage.EXCLUDED }, { RETAINED: 1, FAILED_RETRYABLE: 1, EXCLUDED: 1 });
  });
});
