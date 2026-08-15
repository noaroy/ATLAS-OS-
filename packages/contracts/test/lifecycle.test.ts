import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MISSION_STATUSES,
  MISSION_TRANSITIONS,
  TERMINAL_MISSION_STATUSES,
  canTransition,
} from '../src/domain.ts';

describe('mission lifecycle', () => {
  test('every status has a transition entry', () => {
    for (const status of MISSION_STATUSES) {
      assert.ok(MISSION_TRANSITIONS[status], `missing transitions for '${status}'`);
    }
  });

  test('every transition target is a real status', () => {
    for (const [from, targets] of Object.entries(MISSION_TRANSITIONS)) {
      for (const target of targets) {
        assert.ok(
          MISSION_STATUSES.includes(target),
          `'${from}' points at unknown status '${target}'`,
        );
      }
    }
  });

  test('allows the normal happy path', () => {
    const path = ['created', 'planned', 'running', 'completed', 'validated', 'archived'] as const;
    for (let i = 0; i < path.length - 1; i++) {
      assert.ok(canTransition(path[i]!, path[i + 1]!), `${path[i]} → ${path[i + 1]} should be allowed`);
    }
  });

  test('archived is terminal — nothing can follow it', () => {
    assert.equal(MISSION_TRANSITIONS.archived.length, 0);
    for (const status of MISSION_STATUSES) {
      assert.equal(canTransition('archived', status), false);
    }
  });

  test('a failed mission can be replanned but not resumed directly', () => {
    assert.ok(canTransition('failed', 'planned'));
    assert.equal(canTransition('failed', 'running'), false);
  });

  test('a completed mission cannot silently restart', () => {
    assert.equal(canTransition('completed', 'running'), false);
    assert.ok(canTransition('completed', 'validated'));
  });

  test('terminal statuses are never resumable by the supervisor', () => {
    for (const status of TERMINAL_MISSION_STATUSES) {
      assert.equal(canTransition(status, 'running'), false, `${status} must not resume`);
    }
  });
});
