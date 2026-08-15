import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SKILL_CATALOGUE, toolsForSkills, danglingSkills, ALL_TOOLS } from '@atlas/agents';
import { createTestSystem, testAgent, type TestSystem } from '@atlas/testing';
import type { Mission, MissionTask } from '@atlas/contracts';

/**
 * Skill registry tests (Article VII).
 *
 * The registry only earns its place if a skill is genuinely the single place a
 * tool permission comes from. So these check the catalogue's integrity, the
 * resolution rule, and — the part that actually matters — that withdrawing a
 * skill withdraws the tool from every holder at once, at execution time.
 */

let system: TestSystem | null = null;

afterEach(() => {
  system?.cleanup();
  system = null;
});

describe('the catalogue', () => {
  test('every skill resolves to tools that exist', () => {
    const dangling = danglingSkills(
      SKILL_CATALOGUE,
      ALL_TOOLS.map((t) => t.name),
    );
    assert.deepEqual(dangling, [], 'a skill promising a missing tool would grant nothing silently');
  });

  test('skill keys are unique', () => {
    const keys = SKILL_CATALOGUE.map((s) => s.key);
    assert.equal(new Set(keys).size, keys.length);
  });

  test('every tool is reachable through at least one skill', () => {
    const granted = new Set(SKILL_CATALOGUE.flatMap((s) => s.tools));
    const orphans = ALL_TOOLS.map((t) => t.name).filter((name) => !granted.has(name));
    assert.deepEqual(orphans, [], 'a tool no skill grants can never be used by any agent');
  });

  test("a skill's category matches the category of the tools it grants", () => {
    const byName = new Map(ALL_TOOLS.map((t) => [t.name, t]));
    for (const skill of SKILL_CATALOGUE) {
      for (const tool of skill.tools) {
        assert.equal(
          byName.get(tool)!.category,
          skill.category,
          `skill '${skill.key}' and tool '${tool}' disagree about their category`,
        );
      }
    }
  });
});

describe('resolution', () => {
  test('declared skills become the union of their tools, sorted and deduped', () => {
    const tools = toolsForSkills(['memory-recall', 'memory-curation', 'web-research'], SKILL_CATALOGUE);
    assert.deepEqual(tools, ['http_fetch', 'memory_remember', 'memory_search']);
  });

  test('a disabled skill contributes nothing', () => {
    const catalogue = SKILL_CATALOGUE.map((s) =>
      s.key === 'web-research' ? { ...s, enabled: false } : s,
    );
    assert.deepEqual(toolsForSkills(['web-research', 'memory-recall'], catalogue), ['memory_search']);
  });

  test('an unknown skill is ignored rather than throwing', () => {
    assert.deepEqual(toolsForSkills(['no-such-skill', 'scoring'], SKILL_CATALOGUE), [
      'score_candidates',
      'score_opportunity',
    ]);
  });

  test('an agent declaring no skills gets no tools', () => {
    assert.deepEqual(toolsForSkills([], SKILL_CATALOGUE), []);
  });
});

describe('the registry as the source of permissions', () => {
  test('an agent reads back the tools its skills grant, never a stored list', () => {
    system = createTestSystem({
      agents: [testAgent({ key: 'worker', skills: ['memory-recall', 'scoring'] })],
      handler: async () => ({ kind: 'text', text: 'done' }),
    });

    const expected = ['memory_search', 'score_candidates', 'score_opportunity'];
    assert.deepEqual(system.repos.agents.get('worker')!.tools, expected);
    assert.deepEqual(system.repos.agents.toolsFor('worker'), expected);
  });

  test('disabling a skill withdraws its tool from every holder at once', () => {
    system = createTestSystem({
      agents: [
        testAgent({ key: 'one', skills: ['web-research', 'memory-recall'] }),
        testAgent({ key: 'two', skills: ['web-research', 'scoring'] }),
      ],
      handler: async () => ({ kind: 'text', text: 'done' }),
    });

    assert.deepEqual(system.repos.skills.holders('web-research').sort(), ['one', 'two']);

    system.repos.skills.setEnabled('web-research', false);

    assert.deepEqual(system.repos.agents.toolsFor('one'), ['memory_search']);
    assert.deepEqual(system.repos.agents.toolsFor('two'), ['score_candidates', 'score_opportunity']);

    system.repos.skills.setEnabled('web-research', true);
    assert.ok(system.repos.agents.toolsFor('one').includes('http_fetch'), 're-enabling restores it');
  });

  test('a withdrawn skill is refused at execution time, not merely hidden', async () => {
    system = createTestSystem({
      agents: [testAgent({ key: 'worker', skills: ['web-research'] })],
      handler: async (call) =>
        call.index === 0
          ? { kind: 'tool', name: 'http_fetch', input: { url: 'https://example.com' } }
          : { kind: 'text', text: 'understood' },
    });

    system.repos.skills.setEnabled('web-research', false);

    const { mission, task } = scenario(system, 'worker');
    const agent = system.repos.agents.getDefinition('worker')!;
    await system.runtime.run({ agent, mission, task, upstream: {} });

    const followUp = system.provider.calls[1]!;
    const refusal = followUp.messages
      .flatMap((m) => m.content)
      .find((c) => c.type === 'tool_result') as { content: string; isError: boolean } | undefined;

    assert.ok(refusal?.isError, 'the withdrawn tool must be refused, not executed');
    assert.match(refusal!.content, /not permitted/i);
  });

  test('the model is only shown the tools its skills grant', async () => {
    system = createTestSystem({
      agents: [testAgent({ key: 'worker', skills: ['memory-recall'] })],
      handler: async () => ({ kind: 'text', text: 'done' }),
    });

    const { mission, task } = scenario(system, 'worker');
    const agent = system.repos.agents.getDefinition('worker')!;
    await system.runtime.run({ agent, mission, task, upstream: {} });

    const offered = (system.provider.calls[0]!.tools ?? []).map((t) => t.name);
    assert.deepEqual(offered, ['memory_search']);
  });
});

/** A mission and task pair, persisted so tool context has something real. */
function scenario(sys: TestSystem, agentKey: string): { mission: Mission; task: MissionTask } {
  const mission = sys.repos.missions.create({
    title: 'Skill test',
    objective: 'Exercise skill-derived permissions.',
    createdBy: 'test',
  });
  sys.repos.missions.replaceTasks(mission.id, [
    {
      ref: 'only',
      title: 'The step under test',
      agentKey,
      action: 'research',
      instruction: 'Do the thing the test needs.',
      input: {},
      dependsOn: [],
      maxAttempts: 1,
    },
  ]);
  return { mission, task: sys.repos.missions.tasksFor(mission.id)[0]! };
}
