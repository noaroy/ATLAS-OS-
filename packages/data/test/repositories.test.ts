import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../core/src/logger.ts';
import { createRepositories, type Repositories } from '../src/index.ts';

/**
 * These exercise the parts of persistence that carry real logic — dependency
 * resolution, ranked recall, lifecycle enforcement — against a genuine SQLite
 * file rather than a mock, because that is where the behaviour actually lives.
 */
const logger = createLogger({ level: 'error', pretty: false });
let dir: string;
let repos: Repositories;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-test-'));
  repos = createRepositories(join(dir, 'test.db'), logger);
});

after(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('mission and task orchestration', () => {
  test('creates a mission with a unique human code', () => {
    const a = repos.missions.create({ title: 'A', objective: 'x'.repeat(20), createdBy: 'test' });
    const b = repos.missions.create({ title: 'B', objective: 'y'.repeat(20), createdBy: 'test' });
    assert.notEqual(a.code, b.code);
    assert.equal(a.status, 'created');
    assert.equal(a.progress, 0);
  });

  test('rejects an illegal lifecycle transition', () => {
    const mission = repos.missions.create({ title: 'T', objective: 'z'.repeat(20), createdBy: 'test' });
    repos.missions.transition(mission.id, 'planned');
    repos.missions.transition(mission.id, 'running');
    repos.missions.transition(mission.id, 'completed');
    repos.missions.transition(mission.id, 'archived');

    assert.throws(
      () => repos.missions.transition(mission.id, 'running'),
      /cannot move from 'archived'/,
    );
  });

  test('only dependency-free steps start ready', () => {
    const mission = repos.missions.create({ title: 'Dep', objective: 'q'.repeat(20), createdBy: 'test' });
    const tasks = repos.missions.replaceTasks(mission.id, [
      { ref: 's1', title: 'gather', agentKey: 'explorer', action: 'research', instruction: 'i', input: {}, dependsOn: [], maxAttempts: 3 },
      { ref: 's2', title: 'analyse', agentKey: 'analyst', action: 'analyze', instruction: 'i', input: {}, dependsOn: ['s1'], maxAttempts: 3 },
      { ref: 's3', title: 'report', agentKey: 'architect', action: 'produce-report', instruction: 'i', input: {}, dependsOn: ['s2'], maxAttempts: 3 },
    ]);

    assert.equal(tasks.find((t) => t.ref === 's1')!.status, 'ready');
    assert.equal(tasks.find((t) => t.ref === 's2')!.status, 'pending');
  });

  test('a dependency succeeding unlocks exactly its dependants', () => {
    const mission = repos.missions.create({ title: 'Chain', objective: 'w'.repeat(20), createdBy: 'test' });
    repos.missions.replaceTasks(mission.id, [
      { ref: 's1', title: 'a', agentKey: 'explorer', action: 'research', instruction: 'i', input: {}, dependsOn: [], maxAttempts: 3 },
      { ref: 's2', title: 'b', agentKey: 'analyst', action: 'analyze', instruction: 'i', input: {}, dependsOn: ['s1'], maxAttempts: 3 },
      { ref: 's3', title: 'c', agentKey: 'architect', action: 'produce-report', instruction: 'i', input: {}, dependsOn: ['s2'], maxAttempts: 3 },
    ]);

    const s1 = repos.missions.tasksFor(mission.id).find((t) => t.ref === 's1')!;
    repos.missions.setTaskStatus(s1.id, 'succeeded', { output: { summary: 'done' } });

    const unlocked = repos.missions.refreshReadyTasks(mission.id);
    assert.deepEqual(unlocked.map((t) => t.ref), ['s2']);
  });

  test('a failed dependency skips everything downstream', () => {
    const mission = repos.missions.create({ title: 'Fail', objective: 'e'.repeat(20), createdBy: 'test' });
    repos.missions.replaceTasks(mission.id, [
      { ref: 's1', title: 'a', agentKey: 'explorer', action: 'research', instruction: 'i', input: {}, dependsOn: [], maxAttempts: 1 },
      { ref: 's2', title: 'b', agentKey: 'analyst', action: 'analyze', instruction: 'i', input: {}, dependsOn: ['s1'], maxAttempts: 1 },
    ]);

    const s1 = repos.missions.tasksFor(mission.id).find((t) => t.ref === 's1')!;
    repos.missions.setTaskStatus(s1.id, 'failed', { error: 'boom' });
    repos.missions.refreshReadyTasks(mission.id);

    const s2 = repos.missions.tasksFor(mission.id).find((t) => t.ref === 's2')!;
    assert.equal(s2.status, 'skipped');
  });

  test('progress reflects terminal steps only', () => {
    const mission = repos.missions.create({ title: 'Prog', objective: 'r'.repeat(20), createdBy: 'test' });
    repos.missions.replaceTasks(mission.id, [
      { ref: 's1', title: 'a', agentKey: 'explorer', action: 'research', instruction: 'i', input: {}, dependsOn: [], maxAttempts: 1 },
      { ref: 's2', title: 'b', agentKey: 'analyst', action: 'analyze', instruction: 'i', input: {}, dependsOn: [], maxAttempts: 1 },
    ]);

    assert.equal(repos.missions.computeProgress(mission.id), 0);
    const tasks = repos.missions.tasksFor(mission.id);
    repos.missions.setTaskStatus(tasks[0]!.id, 'succeeded');
    assert.equal(repos.missions.computeProgress(mission.id), 0.5);
    repos.missions.setTaskStatus(tasks[1]!.id, 'failed', { error: 'x' });
    assert.equal(repos.missions.computeProgress(mission.id), 1);
  });

  test('interrupted steps are re-queued for recovery after a restart', () => {
    const mission = repos.missions.create({ title: 'Crash', objective: 't'.repeat(20), createdBy: 'test' });
    repos.missions.replaceTasks(mission.id, [
      { ref: 's1', title: 'a', agentKey: 'explorer', action: 'research', instruction: 'i', input: {}, dependsOn: [], maxAttempts: 3 },
      { ref: 's2', title: 'b', agentKey: 'analyst', action: 'analyze', instruction: 'i', input: {}, dependsOn: ['s1'], maxAttempts: 3 },
    ]);

    const tasks = repos.missions.tasksFor(mission.id);
    repos.missions.setTaskStatus(tasks[0]!.id, 'running');
    repos.missions.setTaskStatus(tasks[1]!.id, 'running');

    assert.equal(repos.missions.requeueUnfinishedTasks(mission.id), 2);
    const after = repos.missions.tasksFor(mission.id);
    assert.equal(after.find((t) => t.ref === 's1')!.status, 'ready');
    // A step with dependencies must go back to pending, not straight to ready.
    assert.equal(after.find((t) => t.ref === 's2')!.status, 'pending');
  });
});

describe('memory', () => {
  test('full-text recall finds items by content', () => {
    repos.memory.insert({
      tier: 'business',
      kind: 'entity',
      title: 'Nordpack Systems GmbH',
      content: 'German distributor of packaging machinery, based in Hamburg, serves food and beverage.',
      tags: ['germany', 'distributor'],
      importance: 0.8,
    });

    const hits = repos.memory.search({ text: 'hamburg packaging distributor', limit: 5 });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0]!.title, 'Nordpack Systems GmbH');
    assert.ok(hits[0]!.score > 0);
  });

  test('recall survives characters that are FTS5 operators', () => {
    // A raw query like this would be a syntax error if passed through unescaped.
    assert.doesNotThrow(() => repos.memory.search({ text: 'AND OR "quoted" (paren) * ^caret -dash', limit: 5 }));
  });

  test('tag filtering matches on any supplied tag', () => {
    repos.memory.insert({
      tier: 'strategic',
      kind: 'lesson',
      title: 'Prefer primary sources',
      content: 'Aggregator data on company size was wrong twice.',
      tags: ['research-quality'],
      importance: 0.9,
    });

    const hits = repos.memory.search({ tags: ['research-quality'], limit: 10 });
    assert.ok(hits.some((h) => h.title === 'Prefer primary sources'));
    assert.equal(repos.memory.search({ tags: ['no-such-tag'], limit: 10 }).length, 0);
  });

  test('ranking favours importance when relevance is comparable', () => {
    repos.memory.insert({ tier: 'business', kind: 'fact', title: 'Zeta trivial note', content: 'zetamarker minor', importance: 0.1 });
    repos.memory.insert({ tier: 'business', kind: 'insight', title: 'Zeta key insight', content: 'zetamarker major', importance: 0.95 });

    const hits = repos.memory.search({ text: 'zetamarker', limit: 5 });
    assert.equal(hits[0]!.title, 'Zeta key insight');
  });

  test('deletion keeps the full-text index in sync', () => {
    const item = repos.memory.insert({
      tier: 'operational',
      kind: 'fact',
      title: 'Ephemeral finding',
      content: 'uniquetokenxyz should disappear entirely',
      importance: 0.3,
    });

    assert.equal(repos.memory.search({ text: 'uniquetokenxyz', limit: 5 }).length, 1);
    repos.memory.delete(item.id);
    assert.equal(repos.memory.search({ text: 'uniquetokenxyz', limit: 5 }).length, 0);
  });
});

describe('improvements', () => {
  test('an identical open proposal is never raised twice', () => {
    const change = { type: 'orchestration.setting', key: 'taskMaxAttempts', value: 4 } as const;
    const input = {
      title: 'Retry more',
      category: 'reliability' as const,
      rationale: 'because',
      evidence: {},
      change,
      impact: 'high' as const,
      risk: 'low' as const,
      proposedBy: 'evolution-manager',
    };

    assert.ok(repos.improvements.propose(input));
    assert.equal(repos.improvements.propose(input), null, 'duplicate should be suppressed');
  });

  test('a rejected proposal frees the fingerprint for a future re-proposal', () => {
    const change = { type: 'workflow.toggle', workflowKey: 'demo', enabled: false } as const;
    const input = {
      title: 'Disable demo',
      category: 'workflow' as const,
      rationale: 'failing',
      evidence: {},
      change,
      impact: 'low' as const,
      risk: 'low' as const,
      proposedBy: 'evolution-manager',
    };

    const first = repos.improvements.propose(input);
    assert.ok(first);
    repos.improvements.setStatus(first!.id, 'rejected', { decidedBy: 'founder' });
    assert.ok(repos.improvements.propose(input), 'should be proposable again once resolved');
  });
});

describe('agents', () => {
  test('metrics are derived from the task log, not counters', () => {
    repos.buildings.ensure({
      key: 'test-hall',
      name: 'Test Hall',
      department: 'Testing',
      purpose: 'p',
      x: 0,
      y: 0,
      level: 1,
      activityScore: 0,
      status: 'nominal',
      unlockedAt: null,
      sortOrder: 99,
    });

    repos.agents.upsertDefinition({
      key: 'tester',
      name: 'Tester',
      role: 'r',
      tier: 'support',
      building: 'test-hall',
      mission: 'm',
      skills: [],
      actions: ['test'],
      mandates: ['mission-execution'],
      systemPrompt: 'p',
      model: null,
      maxSteps: 4,
      appearance: { hue: 100, accent: '#fff', silhouette: 'scout', emblem: '◆' },
      enabled: true,
    });

    const mission = repos.missions.create({ title: 'Metrics', objective: 'm'.repeat(20), createdBy: 'test' });
    repos.missions.replaceTasks(mission.id, [
      { ref: 'a', title: 'a', agentKey: 'tester', action: 'test', instruction: 'i', input: {}, dependsOn: [], maxAttempts: 1 },
      { ref: 'b', title: 'b', agentKey: 'tester', action: 'test', instruction: 'i', input: {}, dependsOn: [], maxAttempts: 1 },
    ]);

    const tasks = repos.missions.tasksFor(mission.id);
    repos.missions.setTaskStatus(tasks[0]!.id, 'succeeded', { durationMs: 1000, tokensUsed: 50 });
    repos.missions.setTaskStatus(tasks[1]!.id, 'failed', { error: 'nope', tokensUsed: 20 });

    const metrics = repos.agents.metricsFor('tester');
    assert.equal(metrics.tasksTotal, 2);
    assert.equal(metrics.tasksSucceeded, 1);
    assert.equal(metrics.successRate, 50);
    assert.equal(metrics.tokensUsed, 70);
  });

  test('buildings level up as their department accumulates real work', () => {
    let result = { level: 1, leveledUp: false };
    for (let i = 0; i < 30; i++) result = repos.buildings.recordActivity('test-hall', 1);
    assert.ok(result.level > 1, 'sustained activity should raise the level');
  });
});
