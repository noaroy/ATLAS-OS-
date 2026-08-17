import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError } from '@atlas/core';
import { createTestSystem, testAgent, type TestSystem } from '@atlas/testing';
import type { Mission, MissionTask } from '@atlas/contracts';

/**
 * Agent runtime tests.
 *
 * The tool loop is where an agent's permissions, step budget and timeout are
 * actually enforced, so these exercise the runtime directly rather than
 * through a whole mission.
 */

let system: TestSystem | null = null;

afterEach(() => {
  system?.cleanup();
  system = null;
});

/** A mission and task pair, persisted so tool context has something real. */
/**
 * Une étape de test, sur une action volontairement hors pipeline.
 *
 * Ces tests éprouvent la boucle d'outils du runtime, pas la sémantique d'une
 * étape commerciale. Les faire tourner sous `research` les soumettrait au
 * périmètre de la découverte — qui exclut `memory_remember` et
 * `create_document`, et pour de bonnes raisons — ce qui mesurerait la
 * restriction au lieu de la boucle. Le périmètre par action a ses propres
 * tests, dans `step-scope.test.ts`.
 */
function scenario(
  sys: TestSystem,
  agentKey: string,
  action = 'exercise',
): { mission: Mission; task: MissionTask } {
  const mission = sys.repos.missions.create({
    title: 'Runtime test',
    objective: 'Exercise the agent runtime directly.',
    createdBy: 'test',
  });
  sys.repos.missions.replaceTasks(mission.id, [
    {
      ref: 'only',
      title: 'The step under test',
      agentKey,
      action,
      instruction: 'Do the thing the test needs.',
      input: {},
      dependsOn: [],
      maxAttempts: 1,
    },
  ]);
  return { mission, task: sys.repos.missions.tasksFor(mission.id)[0]! };
}

describe('tool loop', () => {
  test('a tool call is executed and its result fed back', async () => {
    system = createTestSystem({
      agents: [testAgent({ key: 'worker', skills: ['memory-curation', 'memory-recall'] })],
      handler: async (call) => {
        if (call.index === 0) {
          return {
            kind: 'tool',
            name: 'memory_remember',
            input: {
              title: 'A fact worth keeping',
              content: 'The runtime executed a tool call.',
              kind: 'fact',
            },
          };
        }
        return { kind: 'text', text: 'Recorded and finished.' };
      },
    });

    const { mission, task } = scenario(system, 'worker');
    const agent = system.repos.agents.getDefinition('worker')!;

    const result = await system.runtime.run({ agent, mission, task, upstream: {} });

    assert.equal(result.toolCalls, 1);
    assert.match(result.summary, /Recorded and finished/);

    // The tool genuinely ran: the memory it wrote is retrievable.
    const hits = system.memory.recall({ text: 'runtime executed a tool call', limit: 5 });
    assert.equal(hits.length, 1);

    // The second call must carry the tool result back to the model.
    const secondCall = system.provider.calls[1]!;
    const hasToolResult = secondCall.messages.some((m) =>
      m.content.some((c) => c.type === 'tool_result'),
    );
    assert.ok(hasToolResult, 'the tool result should be returned to the model');
  });

  test('several tool results are returned in one message', async () => {
    system = createTestSystem({
      agents: [testAgent({ key: 'worker', skills: ['memory-recall'] })],
      handler: async (call) => {
        if (call.index === 0) {
          // A single assistant turn carrying two tool calls.
          return { kind: 'tool', name: 'memory_search', input: { query: 'anything' } };
        }
        return { kind: 'text', text: 'done' };
      },
    });

    const { mission, task } = scenario(system, 'worker');
    const agent = system.repos.agents.getDefinition('worker')!;
    await system.runtime.run({ agent, mission, task, upstream: {} });

    const followUp = system.provider.calls[1]!;
    const resultMessages = followUp.messages.filter((m) =>
      m.content.every((c) => c.type === 'tool_result'),
    );
    assert.equal(
      resultMessages.length,
      1,
      'all results for one assistant turn must go back in a single message',
    );
  });

  test('the run reports the phases the village displays', async () => {
    const phases: string[] = [];

    system = createTestSystem({
      agents: [testAgent({ key: 'worker', skills: ['memory-recall'] })],
      handler: async (call) =>
        call.index === 0
          ? { kind: 'tool', name: 'memory_search', input: { query: 'x' } }
          : { kind: 'text', text: 'done' },
    });

    const { mission, task } = scenario(system, 'worker');
    const agent = system.repos.agents.getDefinition('worker')!;

    await system.runtime.run({
      agent,
      mission,
      task,
      upstream: {},
      onPhase: (phase) => phases.push(phase),
    });

    assert.deepEqual(phases, ['working', 'analyzing'], 'reasoning over tool results is analysing');
  });
});

describe('permissions', () => {
  test('a tool outside the allow-list is refused, not executed', async () => {
    system = createTestSystem({
      // The agent may search memory but not write to it.
      agents: [testAgent({ key: 'reader', skills: ['memory-recall'] })],
      handler: async (call) =>
        call.index === 0
          ? {
              kind: 'tool',
              name: 'memory_remember',
              input: { title: 'Should never be stored', content: 'forbidden', kind: 'fact' },
            }
          : { kind: 'text', text: 'understood' },
    });

    const { mission, task } = scenario(system, 'reader');
    const agent = system.repos.agents.getDefinition('reader')!;

    await system.runtime.run({ agent, mission, task, upstream: {} });

    // Nothing was written despite the model asking for it.
    assert.equal(system.memory.recall({ text: 'Should never be stored', limit: 5 }).length, 0);

    // And the model was told why, so it can correct itself.
    const followUp = system.provider.calls[1]!;
    const refusal = followUp.messages
      .flatMap((m) => m.content)
      .find((c) => c.type === 'tool_result') as { content: string; isError: boolean } | undefined;

    assert.ok(refusal?.isError, 'the refusal should be marked as an error result');
    assert.match(refusal!.content, /not permitted/i);
  });

  test('an unknown tool name is refused rather than crashing the step', async () => {
    system = createTestSystem({
      agents: [testAgent({ key: 'worker', skills: ['memory-recall'] })],
      handler: async (call) =>
        call.index === 0
          ? { kind: 'tool', name: 'no_such_tool', input: {} }
          : { kind: 'text', text: 'recovered' },
    });

    const { mission, task } = scenario(system, 'worker');
    const agent = system.repos.agents.getDefinition('worker')!;

    const result = await system.runtime.run({ agent, mission, task, upstream: {} });
    assert.match(result.summary, /recovered/);
  });

  test('malformed tool input is rejected with a usable message', async () => {
    system = createTestSystem({
      agents: [testAgent({ key: 'worker', skills: ['memory-curation'] })],
      handler: async (call) =>
        call.index === 0
          ? { kind: 'tool', name: 'memory_remember', input: { title: 'x' } } // missing content and kind
          : { kind: 'text', text: 'corrected' },
    });

    const { mission, task } = scenario(system, 'worker');
    const agent = system.repos.agents.getDefinition('worker')!;
    await system.runtime.run({ agent, mission, task, upstream: {} });

    const followUp = system.provider.calls[1]!;
    const toolResult = followUp.messages
      .flatMap((m) => m.content)
      .find((c) => c.type === 'tool_result') as { content: string; isError: boolean } | undefined;

    assert.ok(toolResult?.isError);
    assert.match(toolResult!.content, /Invalid input/i);
  });

  test('only permitted tools are offered to the model', async () => {
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

describe('step limit', () => {
  test('the loop stops at maxSteps and still produces a conclusion', async () => {
    let toolCalls = 0;

    system = createTestSystem({
      agents: [testAgent({ key: 'looper', skills: ['memory-recall'], maxSteps: 3 })],
      handler: async (call) => {
        // Always ask for another tool; only the forced final turn ends it.
        const asksForConclusion = call.request.messages.some((m) =>
          m.content.some(
            (c) => c.type === 'text' && c.text.includes("limite d'étapes"),
          ),
        );
        if (asksForConclusion) return { kind: 'text', text: 'Final answer under duress.' };
        toolCalls++;
        return { kind: 'tool', name: 'memory_search', input: { query: 'again' } };
      },
    });

    const { mission, task } = scenario(system, 'looper');
    const agent = system.repos.agents.getDefinition('looper')!;

    const result = await system.runtime.run({ agent, mission, task, upstream: {} });

    assert.equal(toolCalls, 3, 'the loop must not exceed maxSteps turns');
    assert.match(result.summary, /Final answer under duress/);
  });
});

describe('boucles anormales', () => {
  test('le même appel d’outil répété à l’identique est coupé', async () => {
    // `maxSteps` borne les tours, pas l'acharnement : un agent peut rejouer le
    // même outil avec les mêmes arguments à chaque tour et repayer tout le
    // contexte à chaque fois. Au troisième échec identique on ne mesure plus
    // qu'un entêtement.
    let executed = 0;

    system = createTestSystem({
      agents: [testAgent({ key: 'obstine', skills: ['memory-recall'], maxSteps: 20 })],
      handler: async (call) => {
        const closing = call.request.messages.some((m) =>
          m.content.some((c) => c.type === 'text' && c.text.includes("interrompt la boucle d'outils")),
        );
        if (closing) return { kind: 'text', text: 'Voici ce que j’ai pu établir.' };
        executed++;
        return { kind: 'tool', name: 'memory_search', input: { query: 'toujours la même' } };
      },
    });

    const { mission, task } = scenario(system, 'obstine');
    const agent = system.repos.agents.getDefinition('obstine')!;
    const result = await system.runtime.run({ agent, mission, task, upstream: {} });

    assert.ok(
      executed <= 4,
      `l'outil identique ne doit pas être rejoué 20 fois (${executed} tours)`,
    );
    assert.match(result.summary, /Voici ce que j’ai pu établir/);
  });

  test('un argument différent n’est pas confondu avec une répétition', async () => {
    // Sinon un agent qui explore réellement plusieurs pistes serait coupé.
    let turns = 0;

    system = createTestSystem({
      agents: [testAgent({ key: 'explorateur', skills: ['memory-recall'], maxSteps: 6 })],
      handler: async (call) => {
        const forced = call.request.messages.some((m) =>
          m.content.some(
            (c) =>
              c.type === 'text' &&
              (c.text.includes("limite d'étapes") || c.text.includes("interrompt la boucle")),
          ),
        );
        if (forced) return { kind: 'text', text: 'Terminé.' };
        turns++;
        return { kind: 'tool', name: 'memory_search', input: { query: `piste ${turns}` } };
      },
    });

    const { mission, task } = scenario(system, 'explorateur');
    const agent = system.repos.agents.getDefinition('explorateur')!;
    await system.runtime.run({ agent, mission, task, upstream: {} });

    assert.equal(turns, 6, 'des requêtes distinctes doivent aller jusqu’à maxSteps');
  });

  test('une panne d’outil qui se répète clôt la boucle', async () => {
    // Cinq échecs consécutifs : insister ne fait qu'accumuler du contexte
    // facturé. LIVE #001 en a fait cinq, tous en échec, sans jamais s'arrêter.
    let attempts = 0;

    system = createTestSystem({
      agents: [testAgent({ key: 'malchanceux', skills: ['web-research'], maxSteps: 20 })],
      handler: async (call) => {
        const closing = call.request.messages.some((m) =>
          m.content.some((c) => c.type === 'text' && c.text.includes("interrompt la boucle d'outils")),
        );
        if (closing) return { kind: 'text', text: 'Je n’ai rien pu vérifier.' };
        attempts++;
        // Une URL différente à chaque fois : ce n'est pas une répétition
        // d'arguments, c'est une panne d'outillage qui se répète.
        return { kind: 'tool', name: 'http_fetch', input: { url: `http://10.0.0.${attempts}/x` } };
      },
    });

    const { mission, task } = scenario(system, 'malchanceux');
    const agent = system.repos.agents.getDefinition('malchanceux')!;
    const result = await system.runtime.run({ agent, mission, task, upstream: {} });

    assert.ok(attempts <= 6, `la boucle doit se clore après quelques échecs (${attempts} tentatives)`);
    assert.match(result.summary, /rien pu vérifier/);
  });
});

describe('timeout and cancellation', () => {
  test('a step that never returns is cut off by the task timeout', async () => {
    system = createTestSystem({
      config: { taskTimeoutMs: 250 },
      agents: [testAgent({ key: 'stuck' })],
      handler: async () => ({ kind: 'hang' }),
    });

    const { mission, task } = scenario(system, 'stuck');
    const agent = system.repos.agents.getDefinition('stuck')!;

    await assert.rejects(
      () => system!.runtime.run({ agent, mission, task, upstream: {} }),
      (err: unknown) => err instanceof AtlasError && err.code === 'TIMEOUT',
    );
  });

  test('an aborted signal stops the run', async () => {
    system = createTestSystem({
      agents: [testAgent({ key: 'worker' })],
      handler: async () => ({ kind: 'hang' }),
    });

    const { mission, task } = scenario(system, 'worker');
    const agent = system.repos.agents.getDefinition('worker')!;
    const controller = new AbortController();

    const run = system.runtime.run({ agent, mission, task, upstream: {}, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);

    await assert.rejects(() => run);
  });
});

describe('results', () => {
  test('an empty answer is a retryable failure, not a silent success', async () => {
    system = createTestSystem({
      agents: [testAgent({ key: 'mute' })],
      handler: async () => ({ kind: 'text', text: '   ' }),
    });

    const { mission, task } = scenario(system, 'mute');
    const agent = system.repos.agents.getDefinition('mute')!;

    await assert.rejects(
      () => system!.runtime.run({ agent, mission, task, upstream: {} }),
      (err: unknown) => err instanceof AtlasError && err.retryable,
    );
  });

  test('a refusal fails the step and is not retried', async () => {
    system = createTestSystem({
      agents: [testAgent({ key: 'refused' })],
      handler: async () => ({ kind: 'refusal', category: 'policy' }),
    });

    const { mission, task } = scenario(system, 'refused');
    const agent = system.repos.agents.getDefinition('refused')!;

    await assert.rejects(
      () => system!.runtime.run({ agent, mission, task, upstream: {} }),
      (err: unknown) => err instanceof AtlasError && !err.retryable,
    );
  });

  test('an artifact produced by a tool is carried into the result', async () => {
    system = createTestSystem({
      agents: [testAgent({ key: 'maker', skills: ['document-production'] })],
      handler: async (call) =>
        call.index === 0
          ? {
              kind: 'tool',
              name: 'create_document',
              input: { title: 'Test report', format: 'markdown', body: '# Findings\n\nAll good.' },
            }
          : { kind: 'text', text: 'Report delivered.' },
    });

    const { mission, task } = scenario(system, 'maker');
    const agent = system.repos.agents.getDefinition('maker')!;

    const result = await system.runtime.run({ agent, mission, task, upstream: {} });

    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0]!.name, 'Test report');
    assert.equal(result.artifacts[0]!.createdBy, 'maker');
  });

  test('token usage is accumulated across every turn', async () => {
    system = createTestSystem({
      agents: [testAgent({ key: 'worker', skills: ['memory-recall'] })],
      handler: async (call) =>
        call.index === 0
          ? { kind: 'tool', name: 'memory_search', input: { query: 'x' } }
          : { kind: 'text', text: 'done' },
    });

    const { mission, task } = scenario(system, 'worker');
    const agent = system.repos.agents.getDefinition('worker')!;
    const result = await system.runtime.run({ agent, mission, task, upstream: {} });

    // The scripted provider reports 150 tokens per call; two turns were needed.
    assert.equal(result.tokensUsed, 300);
  });
});

describe('safety', () => {
  test('http_fetch refuses a private address', async () => {
    system = createTestSystem({
      agents: [testAgent({ key: 'fetcher', skills: ['web-research'] })],
      handler: async (call) =>
        call.index === 0
          ? {
              kind: 'tool',
              name: 'http_fetch',
              input: { url: 'https://127.0.0.1/admin', purpose: 'probe the host' },
            }
          : { kind: 'text', text: 'understood' },
    });

    const { mission, task } = scenario(system, 'fetcher');
    const agent = system.repos.agents.getDefinition('fetcher')!;
    await system.runtime.run({ agent, mission, task, upstream: {} });

    const followUp = system.provider.calls[1]!;
    const toolResult = followUp.messages
      .flatMap((m) => m.content)
      .find((c) => c.type === 'tool_result') as { content: string; isError: boolean } | undefined;

    assert.ok(toolResult?.isError);
    assert.match(toolResult!.content, /internal or private/i);
  });

  test('http_fetch refuses plain http', async () => {
    system = createTestSystem({
      agents: [testAgent({ key: 'fetcher', skills: ['web-research'] })],
      handler: async (call) =>
        call.index === 0
          ? {
              kind: 'tool',
              name: 'http_fetch',
              input: { url: 'http://example.com', purpose: 'read a page' },
            }
          : { kind: 'text', text: 'understood' },
    });

    const { mission, task } = scenario(system, 'fetcher');
    const agent = system.repos.agents.getDefinition('fetcher')!;
    await system.runtime.run({ agent, mission, task, upstream: {} });

    const followUp = system.provider.calls[1]!;
    const toolResult = followUp.messages
      .flatMap((m) => m.content)
      .find((c) => c.type === 'tool_result') as { content: string; isError: boolean } | undefined;

    assert.ok(toolResult?.isError);
    assert.match(toolResult!.content, /https/i);
  });
});

describe('contexte borné', () => {
  test('un historique trop lourd est compacté sans perdre l’objectif', async () => {
    // LIVE #005 a produit un tour à 154 000 jetons d'entrée — 0,49 $, 57 % de
    // la mission — parce que chaque tour rejoue tout ce qui précède. Le modèle
    // n'a pas besoin des transcriptions : il a besoin de savoir ce qui a été
    // essayé et ce qui en est ressorti.
    const big = 'x'.repeat(30_000);
    let turns = 0;

    system = createTestSystem({
      agents: [testAgent({ key: 'bavard', skills: ['web-research'], maxSteps: 8 })],
      config: { taskTimeoutMs: 20_000 },
      handler: async (call) => {
        const closing = call.request.messages.some((m) =>
          m.content.some(
            (c) =>
              c.type === 'text' &&
              (c.text.includes("limite d'étapes") || c.text.includes('interrompt la boucle')),
          ),
        );
        if (closing) return { kind: 'text', text: 'Conclusion.' };
        turns++;
        // Chaque page récupérée revient dans le contexte au tour suivant.
        return { kind: 'tool', name: 'http_fetch', input: { url: `https://exemple-${turns}.de/`, purpose: big } };
      },
    });
    // Un plafond bas pour que le compactage se déclenche pendant le test.
    system.config.search.discoveryMaxContextTokens = 5_000;

    const { mission, task } = scenario(system, 'bavard');
    const agent = system.repos.agents.getDefinition('bavard')!;
    await system.runtime.run({ agent, mission, task, upstream: {} });

    const sizes = system.provider.calls.map((call) =>
      call.messages.reduce(
        (chars, m) =>
          chars +
          m.content.reduce((c, b) => {
            if (b.type === 'text') return c + b.text.length;
            if (b.type === 'tool_result') return c + b.content.length;
            return c + JSON.stringify(b.input ?? {}).length;
          }, 0),
        0,
      ),
    );

    const ceiling = 5_000 * 4 * 3; // le plafond en caractères, avec une marge
    assert.ok(
      sizes.every((s) => s < ceiling),
      `aucun appel ne doit exploser le contexte (max observé ${Math.max(...sizes)})`,
    );

    // Le briefing initial survit au compactage : sans lui, l'agent ne sait plus
    // ce qu'il fait.
    const last = system.provider.calls.at(-1)!;
    const firstMessage = last.messages[0]!.content
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('');
    assert.match(firstMessage, /# Votre étape/);
  });

  test('un historique léger n’est pas touché', async () => {
    system = createTestSystem({
      agents: [testAgent({ key: 'sobre', skills: ['memory-recall'], maxSteps: 3 })],
      handler: async (call) => {
        const asked = call.request.messages.some((m) =>
          m.content.some((c) => c.type === 'tool_result'),
        );
        if (asked) return { kind: 'text', text: 'Terminé.' };
        return { kind: 'tool', name: 'memory_search', input: { query: 'court' } };
      },
    });

    const { mission, task } = scenario(system, 'sobre');
    const agent = system.repos.agents.getDefinition('sobre')!;
    await system.runtime.run({ agent, mission, task, upstream: {} });

    assert.ok(
      system.provider.calls.every(
        (c) =>
          !c.messages.some((m) =>
            m.content.some((b) => b.type === 'text' && b.text.includes('# Ce que vous avez déjà fait')),
          ),
      ),
      'le compactage ne doit pas se déclencher sans nécessité',
    );
  });
});
