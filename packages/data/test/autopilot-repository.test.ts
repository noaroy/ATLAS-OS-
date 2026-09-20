import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createLogger } from '../../core/src/logger.ts';
import { createRepositories, OPEN_ACTION_STATUSES, type Repositories } from '../src/index.ts';

/**
 * La mémoire de l'Autopilot, au niveau du dépôt : un cycle se relit, une
 * action ouverte ne se dédouble pas — la base le garantit — et une action
 * résolue libère son empreinte.
 */

const logger = createLogger({ level: 'error', pretty: false });
let dir: string;
let repos: Repositories;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-autopilot-repo-'));
  repos = createRepositories(join(dir, 'atlas.db'), logger);
});
afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const propose = (cycleId: string, over: Partial<Parameters<typeof repos.autopilot.propose>[0]> = {}) =>
  repos.autopilot.propose({
    cycleId, fingerprint: 'fp-1', objective: 'lire la boîte', category: 'BLOCKED_WORK', allocation: 'EXPLOIT', score: 90,
    proposal: { evidence: ['test'] }, recommendedAgent: 'DETERMINISTIC', requiresHumanApproval: false, reason: 'test', ...over,
  });

describe('les cycles', () => {
  test('un cycle s’ouvre RUNNING, se ferme avec tout ce qu’il a vu, et se relit', () => {
    const cycle = repos.autopilot.startCycle({ trigger: 'test' });
    assert.equal(cycle.status, 'RUNNING');
    assert.equal(cycle.finishedAt, null);
    const done = repos.autopilot.finishCycle(cycle.id, {
      status: 'DONE', observations: { sales: { contacted: 3 } }, opportunities: [{ objective: 'x', score: 1 }],
      decisions: [{ objective: 'x', decision: 'CREATED' }], actionsCreated: ['a'], executed: [], estimatedCostUsd: 0.1, summary: 'ok',
    });
    assert.equal(done.status, 'DONE');
    assert.ok(done.finishedAt);
    assert.deepEqual(done.observations, { sales: { contacted: 3 } });
    assert.equal(repos.autopilot.lastCycle()?.id, cycle.id);
    assert.equal(repos.autopilot.cycles(5).length, 1);
  });

  test('un cycle laissé ouvert est marqué INTERRUPTED, jamais effacé', () => {
    const a = repos.autopilot.startCycle({ trigger: 'crash' });
    const b = repos.autopilot.startCycle({ trigger: 'crash-2' });
    assert.deepEqual(repos.autopilot.interruptOpenCycles().sort(), [a.id, b.id].sort());
    assert.equal(repos.autopilot.cycle(a.id)?.status, 'INTERRUPTED');
    assert.ok(repos.autopilot.cycle(a.id)?.error);
    assert.deepEqual(repos.autopilot.interruptOpenCycles(), []);
  });
});

describe('les actions', () => {
  test('la même empreinte ouverte ne se crée pas deux fois ; résolue, elle se libère', () => {
    const cycle = repos.autopilot.startCycle({ trigger: 'test' });
    const first = propose(cycle.id);
    const twin = propose(cycle.id);
    assert.equal(first.created, true);
    assert.equal(twin.created, false);
    assert.equal(twin.action.id, first.action.id);
    assert.equal(repos.autopilot.openByFingerprint('fp-1')?.id, first.action.id);

    const done = repos.autopilot.transition(first.action.id, 'DONE', { result: { ran: true }, actualCostUsd: 0.01 });
    assert.equal(done.status, 'DONE');
    assert.ok(done.resolvedAt);
    assert.equal(repos.autopilot.openByFingerprint('fp-1'), null);
    assert.equal(repos.autopilot.lastResolvedByFingerprint('fp-1')?.id, first.action.id);
    const again = propose(cycle.id);
    assert.equal(again.created, true, 'résolue, l’empreinte est libre');
    assert.notEqual(again.action.id, first.action.id);
  });

  test('la base refuse elle-même une seconde action ouverte de même empreinte', () => {
    const cycle = repos.autopilot.startCycle({ trigger: 'test' });
    propose(cycle.id);
    const db = new Database(join(dir, 'atlas.db'));
    assert.throws(() => db.prepare(
      `INSERT INTO autopilot_actions (id, fingerprint, cycle_id, objective, category, allocation, status, score, proposal_json,
         recommended_agent, requires_human_approval, reason, estimated_cost_usd, depth, created_at, updated_at)
       VALUES ('apa_x', 'fp-1', ?, 'o', 'REVENUE', 'EXPLOIT', 'PROPOSED', 1, '{}', 'HUMAN', 1, 'r', 0, 0, 'now', 'now')`,
    ).run(cycle.id), /UNIQUE/);
    db.close();
  });

  test('les statuts ouverts, les transitions et les compteurs', () => {
    const cycle = repos.autopilot.startCycle({ trigger: 'test' });
    const { action } = propose(cycle.id);
    for (const status of OPEN_ACTION_STATUSES) {
      const t = repos.autopilot.transition(action.id, status, { taskId: status === 'QUEUED' ? 'tsk_1' : undefined });
      assert.equal(t.status, status);
      assert.equal(t.resolvedAt, null, `${status} reste ouvert`);
    }
    assert.equal(repos.autopilot.byTask('tsk_1')?.id, action.id);
    const rejected = repos.autopilot.transition(action.id, 'REJECTED', { rejectionReason: 'pas la peine' });
    assert.equal(rejected.rejectionReason, 'pas la peine');
    assert.ok(rejected.resolvedAt);
    assert.deepEqual(repos.autopilot.countByStatus(), { REJECTED: 1 });
    assert.equal(repos.autopilot.resolvedSince('1970-01-01T00:00:00.000Z').length, 1);
    assert.equal(repos.autopilot.actions({ status: ['REJECTED', 'DONE'] }).length, 1);
    assert.throws(() => repos.autopilot.transition('apa_inconnue', 'DONE'), /inconnue/);
  });

  test('une action naît résolue quand son statut initial l’est (BLOCKED reste ouverte, REJECTED non)', () => {
    const cycle = repos.autopilot.startCycle({ trigger: 'test' });
    const blocked = propose(cycle.id, { fingerprint: 'fp-b', status: 'BLOCKED', rejectionReason: 'fournisseur absent' });
    assert.equal(blocked.action.resolvedAt, null);
    assert.equal(repos.autopilot.openByFingerprint('fp-b')?.id, blocked.action.id);
    const rejected = propose(cycle.id, { fingerprint: 'fp-r', status: 'REJECTED', rejectionReason: 'aucune valeur' });
    assert.ok(rejected.action.resolvedAt);
    assert.equal(repos.autopilot.openByFingerprint('fp-r'), null);
  });
});
