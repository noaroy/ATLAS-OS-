import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ImprovementChange } from '@atlas/contracts';
import { AtlasError } from '@atlas/core';
import { createTestSystem, testAgent, type TestSystem } from '@atlas/testing';

/**
 * Evolution tests.
 *
 * Two things must hold for self-improvement to be safe to leave running: every
 * applied change can be reverted to exactly what was there before, and nothing
 * outside the declared union can ever be applied. Both are tested here.
 */

let system: TestSystem | null = null;

afterEach(() => {
  system?.cleanup();
  system = null;
});

/** A system whose Evolution Manager answers with the given recommendations. */
function withRecommendations(recommendations: unknown[], assessment = 'Assessment text.') {
  return createTestSystem({
    handler: async () => ({ kind: 'json', value: { assessment, recommendations } }),
  });
}

/** Proposes a change directly, bypassing the analyst. */
function propose(sys: TestSystem, change: ImprovementChange, risk: 'low' | 'high' = 'low') {
  const improvement = sys.repos.improvements.propose({
    title: 'Test improvement',
    category: 'orchestration',
    rationale: 'Because the test says so.',
    evidence: {},
    change,
    impact: 'low',
    risk,
    proposedBy: 'evolution-manager',
  });
  assert.ok(improvement, 'the proposal should have been accepted');
  return improvement!;
}

describe('apply and revert', () => {
  test('an agent setting is applied and reverted exactly', async () => {
    system = withRecommendations([]);
    const before = system.repos.agents.getDefinition('explorer')!.maxSteps;

    const improvement = propose(system, {
      type: 'agent.setting',
      agentKey: 'explorer',
      field: 'maxSteps',
      value: 17,
    });

    const applied = system.evolution.apply(improvement.id, 'founder');
    assert.equal(applied.status, 'applied');
    assert.equal(system.repos.agents.getDefinition('explorer')!.maxSteps, 17);

    const reverted = system.evolution.revert(improvement.id, 'founder');
    assert.equal(reverted.status, 'reverted');
    assert.equal(
      system.repos.agents.getDefinition('explorer')!.maxSteps,
      before,
      'revert must restore the exact previous value, not a default',
    );
  });

  test('appended prompt guidance is removed cleanly on revert', async () => {
    system = withRecommendations([]);
    const before = system.repos.agents.getDefinition('analyst')!.systemPrompt;

    const improvement = propose(system, {
      type: 'agent.prompt.append',
      agentKey: 'analyst',
      guidance: 'Converge sooner once the evidence is sufficient.',
    });

    system.evolution.apply(improvement.id, 'founder');
    const after = system.repos.agents.getDefinition('analyst')!.systemPrompt;
    assert.ok(after.includes('Converge sooner'), 'the guidance should be present');
    assert.ok(after.length > before.length);

    system.evolution.revert(improvement.id, 'founder');
    assert.equal(
      system.repos.agents.getDefinition('analyst')!.systemPrompt,
      before,
      'no fragment of the appended guidance may survive a revert',
    );
  });

  test('an orchestration setting is applied and reverted', async () => {
    system = withRecommendations([]);

    const improvement = propose(system, {
      type: 'orchestration.setting',
      key: 'taskMaxAttempts',
      value: 5,
    });

    system.evolution.apply(improvement.id, 'founder');
    assert.equal(system.repos.settings.get('orchestration.taskMaxAttempts', null), 5);

    system.evolution.revert(improvement.id, 'founder');
    assert.equal(
      system.repos.settings.get('orchestration.taskMaxAttempts', null),
      null,
      'reverting an unset setting should restore it to unset',
    );
  });

  test('a workflow toggle is applied and reverted', async () => {
    system = withRecommendations([]);
    system.repos.workflows.upsert({
      key: 'demo-flow',
      name: 'Demo',
      description: '',
      externalId: null,
      webhookPath: null,
      trigger: { type: 'manual' },
      enabled: true,
    });

    const improvement = propose(system, {
      type: 'workflow.toggle',
      workflowKey: 'demo-flow',
      enabled: false,
    });

    system.evolution.apply(improvement.id, 'founder');
    assert.equal(system.repos.workflows.getByKey('demo-flow')!.enabled, false);

    system.evolution.revert(improvement.id, 'founder');
    assert.equal(system.repos.workflows.getByKey('demo-flow')!.enabled, true);
  });

  test('memory retention is applied and reverted', async () => {
    system = withRecommendations([]);

    const improvement = propose(system, {
      type: 'memory.retention',
      tier: 'operational',
      minImportance: 0.55,
    });

    system.evolution.apply(improvement.id, 'founder');
    const applied = system.repos.settings.get<Record<string, number>>('memory.retention', {});
    assert.equal(applied.operational, 0.55);

    system.evolution.revert(improvement.id, 'founder');
    const restored = system.repos.settings.get<Record<string, number>>('memory.retention', {
      operational: 0.2,
    });
    assert.equal(restored.operational, 0.2);
  });

  test('a change referring to a vanished agent fails without corrupting state', async () => {
    system = withRecommendations([]);

    const improvement = propose(system, {
      type: 'agent.setting',
      agentKey: 'no-such-agent',
      field: 'maxSteps',
      value: 9,
    });

    assert.throws(() => system!.evolution.apply(improvement.id, 'founder'), AtlasError);
    assert.equal(system.repos.improvements.require(improvement.id).status, 'failed');
  });

  test('an improvement cannot be applied twice, nor reverted before applying', async () => {
    system = withRecommendations([]);

    const improvement = propose(system, {
      type: 'agent.setting',
      agentKey: 'explorer',
      field: 'maxSteps',
      value: 11,
    });

    assert.throws(() => system!.evolution.revert(improvement.id, 'founder'), AtlasError);

    system.evolution.apply(improvement.id, 'founder');
    assert.throws(() => system!.evolution.apply(improvement.id, 'founder'), AtlasError);

    system.evolution.revert(improvement.id, 'founder');
    assert.throws(() => system!.evolution.revert(improvement.id, 'founder'), AtlasError);
  });

  test('rejecting leaves the system untouched', async () => {
    system = withRecommendations([]);
    const before = system.repos.agents.getDefinition('explorer')!.maxSteps;

    const improvement = propose(system, {
      type: 'agent.setting',
      agentKey: 'explorer',
      field: 'maxSteps',
      value: 20,
    });

    const rejected = system.evolution.reject(improvement.id, 'founder');
    assert.equal(rejected.status, 'rejected');
    assert.equal(system.repos.agents.getDefinition('explorer')!.maxSteps, before);
  });
});

describe('the Evolution Manager', () => {
  test('is consulted, and its recommendation becomes a proposal', async () => {
    system = withRecommendations([
      {
        title: 'Give the Explorer more room',
        category: 'agent-tuning',
        rationale: 'It hit its step limit repeatedly during the last ten missions.',
        impact: 'medium',
        risk: 'low',
        change: { type: 'agent.setting', agentKey: 'explorer', field: 'maxSteps', numberValue: 14 },
      },
    ]);

    const result = await system.evolution.runCycle();

    assert.equal(result.degraded, false, 'the agent should have been usable');
    assert.equal(result.assessment, 'Assessment text.');
    assert.equal(result.proposed.length, 1);
    assert.equal(result.proposed[0]!.title, 'Give the Explorer more room');
    assert.deepEqual(result.proposed[0]!.change, {
      type: 'agent.setting',
      agentKey: 'explorer',
      field: 'maxSteps',
      value: 14,
    });
  });

  test('hands its recommendation to Hermes as a recorded message', async () => {
    system = withRecommendations([
      {
        title: 'Retry transient failures once more',
        category: 'reliability',
        rationale: 'Timeouts accounted for most step failures this week.',
        impact: 'high',
        risk: 'low',
        change: { type: 'orchestration.setting', settingKey: 'taskMaxAttempts', numberValue: 4 },
      },
    ]);

    await system.evolution.runCycle();

    const handoff = system.repos.messages
      .recent(50)
      .find((m) => m.from === 'evolution-manager' && m.to === 'hermes');

    assert.ok(handoff, 'the recommendation must reach Hermes, not stay inside the loop');
    assert.equal(handoff!.kind, 'handoff');
    assert.equal(system.eventsOfType('evolution.analysed').length, 1);
  });

  test('a recommendation naming a non-existent agent is discarded', async () => {
    system = withRecommendations([
      {
        title: 'Tune a ghost',
        category: 'agent-tuning',
        rationale: 'This agent does not exist.',
        impact: 'low',
        risk: 'low',
        change: { type: 'agent.setting', agentKey: 'phantom', field: 'maxSteps', numberValue: 9 },
      },
    ]);

    const result = await system.evolution.runCycle();
    assert.equal(result.proposed.length, 0, 'an unmappable recommendation must not be proposed');
  });

  test('an out-of-range value is rejected rather than clamped', async () => {
    system = withRecommendations([
      {
        title: 'Retry a hundred times',
        category: 'reliability',
        rationale: 'Absurd on purpose.',
        impact: 'high',
        risk: 'low',
        change: { type: 'orchestration.setting', settingKey: 'taskMaxAttempts', numberValue: 100 },
      },
    ]);

    const result = await system.evolution.runCycle();
    assert.equal(
      result.proposed.length,
      0,
      'the founder must never be shown a value the agent did not actually propose',
    );
  });

  test('unparseable analysis degrades to the raw signals instead of failing', async () => {
    system = createTestSystem({
      handler: async () => ({ kind: 'text', text: 'this is not the JSON you asked for' }),
    });

    const result = await system.evolution.runCycle();
    assert.equal(result.degraded, true);
    assert.equal(result.assessment, null);
  });

  test('no advisory agent means the cycle degrades rather than throwing', async () => {
    system = createTestSystem({
      agents: [testAgent({ key: 'doer', mandates: ['mission-execution'] })],
      handler: async () => ({ kind: 'json', value: { assessment: 'x', recommendations: [] } }),
    });

    const result = await system.evolution.runCycle();
    assert.equal(result.degraded, true);
  });

  test('the agent is shown as analysing while it works, and released afterwards', async () => {
    system = createTestSystem({
      handler: async (call) => {
        // Observe the agent's state from inside the call.
        const state = system!.repos.agents.get('evolution-manager')!.state.status;
        assert.equal(state, 'analyzing', 'the village should show the agent working');
        return { kind: 'json', value: { assessment: 'ok', recommendations: [] } };
      },
    });

    await system.evolution.runCycle();
    assert.equal(system.repos.agents.get('evolution-manager')!.state.status, 'available');
  });

  test('observe-only autonomy consults nobody and proposes nothing', async () => {
    system = createTestSystem({
      settings: { evolutionAutonomy: 'observe' },
      handler: async () => {
        throw new Error('the analyst must not be called in observe mode');
      },
    });

    const result = await system.evolution.runCycle();
    assert.equal(result.proposed.length, 0);
    assert.equal(system.provider.calls.length, 0);
  });

  test('low-risk changes are auto-applied only when autonomy allows it', async () => {
    system = createTestSystem({
      settings: { evolutionAutonomy: 'apply-low-risk' },
      handler: async () => ({
        kind: 'json',
        value: {
          assessment: 'Explorer needs more room.',
          recommendations: [
            {
              title: 'Raise the Explorer step allowance',
              category: 'agent-tuning',
              rationale: 'It ran out of steps repeatedly.',
              impact: 'medium',
              risk: 'low',
              change: {
                type: 'agent.setting',
                agentKey: 'explorer',
                field: 'maxSteps',
                numberValue: 13,
              },
            },
          ],
        },
      }),
    });

    const result = await system.evolution.runCycle();

    assert.equal(result.autoApplied.length, 1);
    assert.equal(system.repos.agents.getDefinition('explorer')!.maxSteps, 13);
  });

  test('a high-risk change is never auto-applied', async () => {
    system = createTestSystem({
      settings: { evolutionAutonomy: 'apply-low-risk' },
      handler: async () => ({
        kind: 'json',
        value: {
          assessment: 'Risky idea.',
          recommendations: [
            {
              title: 'Disable the Explorer',
              category: 'agent-tuning',
              rationale: 'Deliberately high risk.',
              impact: 'high',
              risk: 'high',
              change: {
                type: 'agent.setting',
                agentKey: 'explorer',
                field: 'enabled',
                booleanValue: false,
              },
            },
          ],
        },
      }),
    });

    const result = await system.evolution.runCycle();

    assert.equal(result.proposed.length, 1);
    assert.equal(result.autoApplied.length, 0, 'high risk always waits for a human');
    assert.equal(system.repos.agents.getDefinition('explorer')!.enabled, true);
  });
});
