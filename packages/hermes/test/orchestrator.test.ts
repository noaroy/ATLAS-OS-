import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTestSystem,
  plan,
  testAgent,
  waitFor,
  type TestSystem,
  type ScriptedHandler,
} from '@atlas/testing';

/**
 * Orchestration tests.
 *
 * These run the real HermesEngine against a real database with a scripted
 * model, because the behaviour worth testing — parallelism, dependency
 * unlocking, retry policy, cascade skipping, cancellation, budget enforcement
 * and replanning — is a property of how those pieces interact, not of any one
 * of them.
 */

let system: TestSystem | null = null;

afterEach(() => {
  system?.cleanup();
  system = null;
});

/** Runs a mission to a terminal state and returns the final record. */
async function runMission(
  sys: TestSystem,
  objective = 'Do the work described by the test.',
  tokenBudget?: number,
) {
  const mission = await sys.hermes.submit({
    title: 'Test mission',
    objective,
    createdBy: 'test',
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
  });

  await waitFor(
    () => {
      const current = sys.repos.missions.require(mission.id);
      return ['completed', 'validated', 'failed', 'archived'].includes(current.status);
    },
    { timeoutMs: 15_000, label: `mission ${mission.code} to finish` },
  );

  return sys.repos.missions.require(mission.id);
}

/** Which step an execution call is for, read from the briefing Hermes built. */
function stepRef(call: { request: { messages: Array<{ content: Array<unknown> }> } }): string | null {
  const briefing = call.request.messages
    .flatMap((m) => m.content)
    .map((c) => ((c as { type: string; text?: string }).type === 'text' ? (c as { text: string }).text : ''))
    .join('\n');
  return briefing.match(/# Votre étape \(([^)]+)\)/)?.[1] ?? null;
}

/** A handler that plans the given steps, then answers every execution. */
function handlerFor(steps: Parameters<typeof plan>[0], execute?: ScriptedHandler): ScriptedHandler {
  return async (call) => {
    // Planning is the call that asks for structured output with no tools.
    if (call.request.jsonSchema && !call.request.tools?.length) {
      if (call.request.system.includes('You are replanning')) {
        return { kind: 'json', value: plan([{ agentKey: 'architect', ref: 'recovery' }]) };
      }
      // Hermes' synthesis call also uses a schema; distinguish by its prompt.
      if (call.request.system.includes('reporting to the founder')) {
        return { kind: 'json', value: { report: 'Synthesised report.', quality: 80 } };
      }
      return { kind: 'json', value: plan(steps) };
    }
    if (execute) return execute(call);
    return { kind: 'text', text: 'Step complete.' };
  };
}

describe('dispatch and dependencies', () => {
  test('independent steps run in parallel', async () => {
    let concurrent = 0;
    let peak = 0;

    system = createTestSystem({
      handler: handlerFor(
        [
          { agentKey: 'explorer', ref: 'a' },
          { agentKey: 'analyst', ref: 'b' },
          { agentKey: 'ambassador', ref: 'c' },
        ],
        async () => {
          concurrent++;
          peak = Math.max(peak, concurrent);
          await new Promise((r) => setTimeout(r, 60));
          concurrent--;
          return { kind: 'text', text: 'done' };
        },
      ),
    });

    const mission = await runMission(system);

    assert.equal(mission.status, 'completed');
    assert.ok(peak > 1, `expected steps to overlap, peak concurrency was ${peak}`);
  });

  test('concurrency never exceeds the configured limit', async () => {
    let concurrent = 0;
    let peak = 0;

    system = createTestSystem({
      settings: { maxConcurrentTasks: 2 },
      handler: handlerFor(
        ['explorer', 'analyst', 'ambassador', 'messenger', 'architect'].map((agentKey, i) => ({
          agentKey,
          ref: `s${i}`,
        })),
        async () => {
          concurrent++;
          peak = Math.max(peak, concurrent);
          await new Promise((r) => setTimeout(r, 40));
          concurrent--;
          return { kind: 'text', text: 'done' };
        },
      ),
    });

    await runMission(system);
    assert.ok(peak <= 2, `peak concurrency ${peak} exceeded the limit of 2`);
  });

  test('a dependent step runs only after its prerequisite succeeds', async () => {
    const order: string[] = [];

    system = createTestSystem({
      handler: handlerFor(
        [
          { agentKey: 'explorer', ref: 'first' },
          { agentKey: 'analyst', ref: 'second', dependsOn: ['first'] },
        ],
        async (call) => {
          // The briefing names the step, so the prompt identifies which ran.
          const isSecond = call.request.messages.some((m) =>
            m.content.some((c) => c.type === 'text' && c.text.includes('(second)')),
          );
          order.push(isSecond ? 'second' : 'first');
          await new Promise((r) => setTimeout(r, 20));
          return { kind: 'text', text: 'done' };
        },
      ),
    });

    await runMission(system);
    assert.deepEqual(order, ['first', 'second']);
  });

  test('a dependent step receives its prerequisite’s output', async () => {
    let downstreamBriefing = '';

    system = createTestSystem({
      handler: handlerFor(
        [
          { agentKey: 'explorer', ref: 'first' },
          { agentKey: 'analyst', ref: 'second', dependsOn: ['first'] },
        ],
        async (call) => {
          const briefing = call.request.messages
            .flatMap((m) => m.content)
            .filter((c) => c.type === 'text')
            .map((c) => (c as { text: string }).text)
            .join('\n');

          if (briefing.includes('(second)')) {
            downstreamBriefing = briefing;
            return { kind: 'text', text: 'analysed' };
          }
          return { kind: 'text', text: 'UPSTREAM-MARKER-42' };
        },
      ),
    });

    await runMission(system);

    assert.ok(
      downstreamBriefing.includes('Résultats dont vous dépendez'),
      'the downstream step should be given its dependencies',
    );
    assert.ok(
      downstreamBriefing.includes('UPSTREAM-MARKER-42'),
      'the upstream result should appear in the downstream briefing',
    );
  });
});

describe('failure handling', () => {
  test('a transient failure is retried and can then succeed', async () => {
    let attempts = 0;

    system = createTestSystem({
      handler: handlerFor([{ agentKey: 'explorer', ref: 'flaky' }], async () => {
        attempts++;
        if (attempts < 3) return { kind: 'throw', error: new Error('temporary glitch') };
        return { kind: 'text', text: 'succeeded on the third attempt' };
      }),
    });

    const mission = await runMission(system);
    const task = system.repos.missions.tasksFor(mission.id)[0]!;

    assert.equal(attempts, 3);
    assert.equal(task.status, 'succeeded');
    assert.equal(task.attempts, 3);
    assert.equal(system.eventsOfType('task.retrying').length, 2);
  });

  test('retries stop at maxAttempts and the step fails', async () => {
    let attempts = 0;

    system = createTestSystem({
      settings: { taskMaxAttempts: 2 },
      handler: handlerFor([{ agentKey: 'explorer', ref: 'doomed' }], async () => {
        attempts++;
        return { kind: 'throw', error: new Error('always fails') };
      }),
    });

    const mission = await runMission(system);
    const task = system.repos.missions.tasksFor(mission.id)[0]!;

    assert.equal(attempts, 2, 'should stop at the configured attempt limit');
    assert.equal(task.status, 'failed');
    assert.equal(mission.status, 'failed', 'a mission with no successful step fails');
  });

  test('a failed prerequisite skips its dependants in cascade', async () => {
    system = createTestSystem({
      settings: { taskMaxAttempts: 1, maxReplansPerMission: 0 },
      handler: handlerFor(
        [
          { agentKey: 'explorer', ref: 'root' },
          { agentKey: 'analyst', ref: 'mid', dependsOn: ['root'] },
          { agentKey: 'architect', ref: 'leaf', dependsOn: ['mid'] },
          { agentKey: 'messenger', ref: 'independent' },
        ],
        async (call) => {
          if (stepRef(call) === 'root') {
            return { kind: 'throw', error: new Error('root step failed') };
          }
          return { kind: 'text', text: 'done' };
        },
      ),
    });

    const mission = await runMission(system);
    const byRef = new Map(system.repos.missions.tasksFor(mission.id).map((t) => [t.ref, t]));

    assert.equal(byRef.get('root')!.status, 'failed');
    assert.equal(byRef.get('mid')!.status, 'skipped', 'direct dependant should be skipped');
    assert.equal(byRef.get('leaf')!.status, 'skipped', 'the cascade should reach the whole chain');
    assert.equal(
      byRef.get('independent')!.status,
      'succeeded',
      'an unrelated step must not be affected',
    );
  });

  test('a permanent failure leaves the agent visibly in error', async () => {
    system = createTestSystem({
      settings: { taskMaxAttempts: 1, maxReplansPerMission: 0 },
      handler: handlerFor([{ agentKey: 'explorer', ref: 'boom' }], async () => ({
        kind: 'throw',
        error: new Error('unrecoverable'),
      })),
    });

    await runMission(system);

    const explorer = system.repos.agents.get('explorer')!;
    assert.equal(explorer.state.status, 'error');
    assert.ok(explorer.state.currentActivity, 'the reason should be visible on the agent');
  });

  test('a retried step does not leave the agent in error', async () => {
    let attempts = 0;

    system = createTestSystem({
      handler: handlerFor([{ agentKey: 'explorer', ref: 'flaky' }], async () => {
        attempts++;
        if (attempts === 1) return { kind: 'throw', error: new Error('transient') };
        return { kind: 'text', text: 'recovered' };
      }),
    });

    await runMission(system);
    assert.equal(system.repos.agents.get('explorer')!.state.status, 'available');
  });

  test('a model refusal is not retried', async () => {
    let calls = 0;

    system = createTestSystem({
      handler: handlerFor([{ agentKey: 'explorer', ref: 'refused' }], async () => {
        calls++;
        return { kind: 'refusal', category: 'policy' };
      }),
    });

    await runMission(system);
    assert.equal(calls, 1, 'a refusal is a decision, not a transient fault');
  });
});

describe('cancellation', () => {
  test('cancelling a running mission stops it and marks pending steps cancelled', async () => {
    system = createTestSystem({
      handler: handlerFor(
        [
          { agentKey: 'explorer', ref: 'slow' },
          { agentKey: 'analyst', ref: 'later', dependsOn: ['slow'] },
        ],
        async () => {
          await new Promise((r) => setTimeout(r, 3000));
          return { kind: 'text', text: 'done' };
        },
      ),
    });

    const mission = await system.hermes.submit({
      title: 'Cancel me',
      objective: 'A mission that will be cancelled mid-flight.',
      createdBy: 'test',
    });

    await waitFor(
      () => system!.repos.missions.tasksFor(mission.id).some((t) => t.status === 'running'),
      { label: 'the first step to start' },
    );

    const cancelled = system.hermes.cancel(mission.id, 'cancelled by the test');

    assert.equal(cancelled.status, 'failed');
    assert.equal(cancelled.error, 'cancelled by the test');

    const statuses = system.repos.missions.tasksFor(mission.id).map((t) => t.status);
    assert.ok(
      statuses.every((s) => !['ready', 'pending'].includes(s)),
      `no step should be left waiting, got ${statuses.join(', ')}`,
    );
  });

  test('pausing a queued mission removes it from the queue', async () => {
    system = createTestSystem({
      settings: { maxConcurrentMissions: 1 },
      handler: handlerFor([{ agentKey: 'explorer', ref: 'a' }], async () => {
        await new Promise((r) => setTimeout(r, 400));
        return { kind: 'text', text: 'done' };
      }),
    });

    const first = await system.hermes.submit({
      title: 'Occupies the slot',
      objective: 'This one holds the only mission slot.',
      createdBy: 'test',
    });
    const second = await system.hermes.submit({
      title: 'Waits in the queue',
      objective: 'This one should still be queued when it is paused.',
      createdBy: 'test',
    });

    await waitFor(() => system!.hermes.isActive(first.id), { label: 'the first mission to start' });

    const paused = system.hermes.pause(second.id);
    assert.equal(paused.status, 'paused');
    assert.equal(system.hermes.queuedCount, 0, 'a paused mission should leave the queue');
  });
});

/** Une étape qui consomme à elle seule davantage que le budget de sa mission. */
const EXPENSIVE = { inputTokens: 30_000, outputTokens: 10_000 };

describe('token budget', () => {
  test('a mission stops cleanly once its budget is spent', async () => {
    system = createTestSystem({
      // Serial dispatch, so the ceiling is observed between steps rather than
      // after a whole batch has already been launched.
      settings: { maxConcurrentTasks: 1 },
      // La première étape consomme à elle seule plus que le plafond de la
      // mission. C'est le scénario de LIVE #001 en miniature — une étape qui
      // dépasse le budget total — et il doit se solder par un arrêt net.
      handler: handlerFor(
        [
          { agentKey: 'explorer', ref: 'one' },
          { agentKey: 'analyst', ref: 'two' },
          { agentKey: 'architect', ref: 'three' },
        ],
        async () => ({ kind: 'text', text: 'done', usage: EXPENSIVE }),
      ),
    });

    const mission = await runMission(system, 'Budgeted mission.', 30_000);
    const tasks = system.repos.missions.tasksFor(mission.id);

    // Stopping on budget is still a clean stop, not a crash — but it can no
    // longer read as `completed`. A mission whose steps were cancelled never
    // reached its conclusion, and saying otherwise put it in the dashboard's
    // success rate.
    assert.equal(mission.status, 'failed', 'an interrupted mission does not read as completed');
    assert.ok(mission.result, 'a budget stop still produces a result — nothing crashed');
    assert.equal(mission.result?.budgetExhausted, true);
    assert.ok(
      tasks.some((t) => t.status === 'cancelled'),
      'unstarted steps should be cancelled, not left pending',
    );
    assert.equal(system.eventsOfType('mission.budget-exhausted').length, 1);
  });

  test('a zero budget means unlimited', async () => {
    system = createTestSystem({
      handler: handlerFor(
        [
          { agentKey: 'explorer', ref: 'one' },
          { agentKey: 'analyst', ref: 'two' },
        ],
        async () => ({ kind: 'text', text: 'done' }),
      ),
    });

    const mission = await runMission(system, 'Unbounded mission.', 0);
    const tasks = system.repos.missions.tasksFor(mission.id);

    assert.ok(tasks.every((t) => t.status === 'succeeded'));
    assert.notEqual(mission.result?.budgetExhausted, true);
  });

  test('le travail déjà payé est conservé, pas annulé rétroactivement', async () => {
    system = createTestSystem({
      settings: { maxConcurrentTasks: 1 },
      handler: handlerFor(
        [
          { agentKey: 'explorer', ref: 'one' },
          { agentKey: 'analyst', ref: 'two' },
        ],
        async () => {
          await new Promise((r) => setTimeout(r, 30));
          return { kind: 'text', text: 'done', usage: EXPENSIVE };
        },
      ),
    });

    const mission = await runMission(system, 'Budget mid-flight.', 30_000);
    const tasks = system.repos.missions.tasksFor(mission.id);

    // Le plafond agit désormais avant chaque appel, donc l'arrêt commence à
    // l'intérieur d'une étape. Ce qui a déjà été payé reste acquis : annuler
    // un résultat obtenu ne rembourserait rien et perdrait le travail.
    assert.ok(
      tasks.some((t) => t.status === 'succeeded'),
      'une étape dont l’appel est revenu garde son résultat',
    );
    assert.equal(mission.result?.budgetExhausted, true);
  });
});

describe('replanning', () => {
  test('a failed step with dependants triggers one replan', async () => {
    system = createTestSystem({
      settings: { taskMaxAttempts: 1, maxReplansPerMission: 1 },
      handler: handlerFor(
        [
          { agentKey: 'explorer', ref: 'critical' },
          { agentKey: 'analyst', ref: 'downstream', dependsOn: ['critical'] },
        ],
        async (call) => {
          const briefing = call.request.messages
            .flatMap((m) => m.content)
            .map((c) => (c.type === 'text' ? c.text : ''))
            .join('\n');
          if (briefing.includes('(critical)')) {
            return { kind: 'throw', error: new Error('the plan depended on this') };
          }
          return { kind: 'text', text: 'done' };
        },
      ),
    });

    const mission = await runMission(system);

    assert.equal(system.eventsOfType('mission.replanned').length, 1);
    assert.equal(system.repos.missions.require(mission.id).replanCount, 1);
    assert.equal(mission.result?.replanned, true);

    // The recovery step supplied by the harness should have been created.
    const refs = system.repos.missions.tasksFor(mission.id).map((t) => t.ref);
    assert.ok(
      refs.some((r) => r.startsWith('r1-')),
      `expected a replanned step, got refs: ${refs.join(', ')}`,
    );
  });

  test('a failed leaf step does not trigger replanning', async () => {
    system = createTestSystem({
      settings: { taskMaxAttempts: 1, maxReplansPerMission: 1 },
      handler: handlerFor(
        [
          { agentKey: 'explorer', ref: 'ok' },
          { agentKey: 'analyst', ref: 'leaf' },
        ],
        async (call) => {
          const briefing = call.request.messages
            .flatMap((m) => m.content)
            .map((c) => (c.type === 'text' ? c.text : ''))
            .join('\n');
          if (briefing.includes('(leaf)')) return { kind: 'throw', error: new Error('leaf failed') };
          return { kind: 'text', text: 'done' };
        },
      ),
    });

    await runMission(system);
    assert.equal(
      system.eventsOfType('mission.replanned').length,
      0,
      'a leaf failure is a gap in the result, not a broken plan',
    );
  });

  test('replanning is disabled when the limit is zero', async () => {
    system = createTestSystem({
      settings: { taskMaxAttempts: 1, maxReplansPerMission: 0 },
      handler: handlerFor(
        [
          { agentKey: 'explorer', ref: 'critical' },
          { agentKey: 'analyst', ref: 'downstream', dependsOn: ['critical'] },
        ],
        async (call) => {
          const briefing = call.request.messages
            .flatMap((m) => m.content)
            .map((c) => (c.type === 'text' ? c.text : ''))
            .join('\n');
          if (briefing.includes('(critical)')) return { kind: 'throw', error: new Error('failed') };
          return { kind: 'text', text: 'done' };
        },
      ),
    });

    await runMission(system);
    assert.equal(system.eventsOfType('mission.replanned').length, 0);
  });

  test('replanning preserves work that already succeeded', async () => {
    system = createTestSystem({
      settings: { taskMaxAttempts: 1, maxReplansPerMission: 1 },
      handler: handlerFor(
        [
          { agentKey: 'explorer', ref: 'done-well' },
          { agentKey: 'analyst', ref: 'critical' },
          { agentKey: 'architect', ref: 'downstream', dependsOn: ['critical'] },
        ],
        async (call) => {
          const briefing = call.request.messages
            .flatMap((m) => m.content)
            .map((c) => (c.type === 'text' ? c.text : ''))
            .join('\n');
          if (briefing.includes('(critical)')) return { kind: 'throw', error: new Error('failed') };
          return { kind: 'text', text: 'done' };
        },
      ),
    });

    const mission = await runMission(system);
    const byRef = new Map(system.repos.missions.tasksFor(mission.id).map((t) => [t.ref, t]));

    assert.equal(
      byRef.get('done-well')?.status,
      'succeeded',
      'a completed step must survive replanning',
    );
  });
});

describe('mandates', () => {
  test('only agents with mission-execution are offered to the planner', async () => {
    system = createTestSystem({
      agents: [
        testAgent({ key: 'doer', mandates: ['mission-execution'] }),
        testAgent({ key: 'advisor', mandates: ['system-analysis', 'advisory'] }),
      ],
      handler: handlerFor([{ agentKey: 'doer', ref: 'a' }]),
    });

    await runMission(system);

    const planningCall = system.provider.calls.find(
      (c) => c.jsonSchema && c.system.includes('Your team'),
    );
    assert.ok(planningCall, 'a planning call should have been made');
    assert.ok(planningCall!.system.includes('doer'), 'an executor should be offered');
    assert.ok(
      !planningCall!.system.includes('advisor'),
      'an advisory-only agent must not be offered mission steps',
    );
  });

  test('planning fails cleanly when no agent can execute missions', async () => {
    system = createTestSystem({
      agents: [testAgent({ key: 'advisor', mandates: ['advisory'] })],
      handler: handlerFor([]),
    });

    const mission = await runMission(system);

    assert.equal(mission.status, 'failed');
    assert.match(String(mission.error), /mission-execution/);
  });
});

describe('recovery', () => {
  test('an interrupted mission is resumed and its running steps re-queued', async () => {
    system = createTestSystem({
      handler: handlerFor([{ agentKey: 'explorer', ref: 'a' }]),
    });

    const mission = system.repos.missions.create({
      title: 'Interrupted',
      objective: 'A mission the previous process left mid-flight.',
      createdBy: 'test',
    });
    system.repos.missions.transition(mission.id, 'planned');
    system.repos.missions.replaceTasks(mission.id, [
      {
        ref: 'a',
        title: 'a',
        agentKey: 'explorer',
        action: 'research',
        instruction: 'i',
        input: {},
        dependsOn: [],
        maxAttempts: 3,
      },
    ]);
    system.repos.missions.transition(mission.id, 'running');
    const task = system.repos.missions.tasksFor(mission.id)[0]!;
    system.repos.missions.setTaskStatus(task.id, 'running');

    const resumed = system.hermes.recover();
    assert.equal(resumed, 1);

    await waitFor(
      () => system!.repos.missions.require(mission.id).status === 'completed',
      { timeoutMs: 10_000, label: 'the resumed mission to finish' },
    );
  });
});
