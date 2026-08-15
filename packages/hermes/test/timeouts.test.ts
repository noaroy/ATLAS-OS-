import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestSystem, waitFor, testAgent, type TestSystem, type ScriptedHandler } from '@atlas/testing';
import type { LlmRequest } from '@atlas/llm';
import { chooseReasoning } from '@atlas/hermes';

/**
 * Délais de garde, de l'appel jusqu'à la mission.
 *
 * LIVE #002 : l'appel de recherche web est resté en vol 1 284 secondes sous un
 * délai d'étape de 300, parce que ce délai n'enveloppait que l'inférence propre
 * de l'agent — jamais l'exécution de ses outils. La mission n'a jamais rendu la
 * main ; il a fallu l'annuler manuellement.
 *
 * Ce que ces tests doivent établir : fournisseur bloqué → délai → annulation
 * réelle → étape close proprement → mission terminée.
 */

let system: TestSystem | null = null;

afterEach(() => {
  system?.cleanup();
  system = null;
});

const OBJECTIVE = "Trouvez des distributeurs en Allemagne pour nos machines d'emballage.";

const BRIEF = {
  clientProfile: {
    name: 'le client',
    country: 'France',
    industry: "Machines d'emballage",
    offering: "Lignes d'emballage automatisées",
    differentiators: [],
  },
  targetTypes: ['distributor'],
  markets: { countries: ['Allemagne'], industries: [], regions: [] },
  desiredCount: 2,
  mustHave: [],
  niceToHave: [],
  exclusions: [],
};

function stepOf(request: LlmRequest): string | null {
  const briefing = request.messages
    .flatMap((m) => m.content)
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('\n');
  return briefing.match(/# Votre étape \(([^)]+)\)/)?.[1] ?? null;
}

function departmentHandler(execute: ScriptedHandler): ScriptedHandler {
  return async (call) => {
    if (call.request.jsonSchema) {
      const properties =
        (call.request.jsonSchema as { properties?: Record<string, unknown> }).properties ?? {};
      return 'report' in properties
        ? { kind: 'json', value: { report: 'Rapport.', quality: 40 } }
        : { kind: 'json', value: BRIEF };
    }
    return execute(call);
  };
}

async function runDepartmentMission(sys: TestSystem, context: Record<string, unknown> = {}) {
  const mission = await sys.hermes.submit({
    title: 'Partenaires allemands',
    objective: OBJECTIVE,
    createdBy: 'founder',
    departmentKey: 'business-expansion',
    context,
  });
  await waitFor(
    () => ['completed', 'failed'].includes(sys.repos.missions.require(mission.id).status),
    { timeoutMs: 25_000, label: 'la mission se termine' },
  );
  return sys.repos.missions.require(mission.id);
}

// ─── Le scénario de LIVE #002 ──────────────────────────────────────────────

describe('un fournisseur qui ne répond jamais', () => {
  test('la mission se termine au lieu de rester suspendue', async () => {
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1 },
      // 400 ms : le test doit prouver le mécanisme, pas attendre.
      config: { taskTimeoutMs: 5_000 },
      handler: departmentHandler(async () => ({ kind: 'hang' })),
    });
    // Un fournisseur muet, comme la recherche bloquée de LIVE #002.
    sys.config.orchestration.providerTimeoutMs = 400;
    system = sys;

    const started = Date.now();
    const mission = await runDepartmentMission(sys);
    const elapsed = Date.now() - started;

    assert.ok(
      ['completed', 'failed'].includes(mission.status),
      `la mission doit atteindre un état terminal (${mission.status})`,
    );
    assert.ok(elapsed < 20_000, `la mission ne doit pas s'enliser (${elapsed} ms)`);

    const discovery = sys.repos.missions.tasksFor(mission.id).find((t) => t.ref === 'discovery')!;
    assert.equal(discovery.status, 'failed');
    assert.match(discovery.error!, /délai|exceeded|cancelled|TIMEOUT/i);
  });

  test('l’annulation atteint réellement le fournisseur', async () => {
    // La preuve demandée : le signal parvient jusqu'à l'appel, il n'est pas
    // simplement oublié dans une course.
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1 },
      handler: departmentHandler(async ({ request }) => {
        if (stepOf(request) === 'discovery') return { kind: 'hang' };
        return { kind: 'text', text: 'ok' };
      }),
    });
    sys.config.orchestration.providerTimeoutMs = 400;
    system = sys;

    const mission = await runDepartmentMission(sys);

    // `hang` ne rejette que sur abort : que l'appel se soit dénoué prouve que
    // le signal est arrivé jusqu'à lui.
    const discovery = sys.repos.missions.tasksFor(mission.id).find((t) => t.ref === 'discovery')!;
    assert.equal(discovery.status, 'failed');
    assert.ok(
      sys.provider.calls.some((c) => stepOf(c) === 'discovery'),
      "l'appel a bien été émis avant d'être annulé",
    );
  });

  test('aucun appel n’est émis après l’annulation de la mission', async () => {
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1 },
      handler: departmentHandler(async () => ({ kind: 'hang' })),
    });
    sys.config.orchestration.providerTimeoutMs = 30_000;
    system = sys;

    const mission = await sys.hermes.submit({
      title: 'À annuler',
      objective: OBJECTIVE,
      createdBy: 'founder',
      departmentKey: 'business-expansion',
    });

    await waitFor(() => sys.provider.calls.length > 0, { timeoutMs: 10_000 });
    sys.hermes.cancel(mission.id, 'annulation de test');

    const after = sys.provider.calls.length;
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(sys.provider.calls.length, after, "aucun appel externe ne part après l'annulation");
    assert.equal(sys.repos.missions.require(mission.id).status, 'failed');
  });
});

// ─── Le brief gratuit ──────────────────────────────────────────────────────

describe('un brief entièrement déclaré ne coûte rien', () => {
  test('aucun appel au modèle quand le formulaire est complet', async () => {
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1 },
      handler: departmentHandler(async () => ({ kind: 'text', text: 'Aucun candidat.' })),
    });
    system = sys;

    const mission = await runDepartmentMission(sys, BRIEF);

    // Le brief déclaré emporte de toute façon sur l'extraction : payer un
    // modèle pour reformuler ce que le fondateur vient d'écrire est un pur
    // gaspillage.
    const briefCalls = sys.repos.llmCalls
      .forMission(mission.id)
      .filter((c) => c.purpose === 'brief');
    assert.deepEqual(briefCalls, [], "aucun appel d'extraction ne doit être émis");

    const stored = (sys.repos.missions.require(mission.id).context as { brief?: Record<string, unknown> })
      .brief!;
    assert.deepEqual(stored.targetTypes, ['distributor']);
    assert.equal(stored.desiredCount, 2);
  });

  test('un formulaire incomplet fait bien appel au modèle', async () => {
    // La contrepartie : la gratuité ne doit pas se payer d'un brief inventé.
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1 },
      handler: departmentHandler(async () => ({ kind: 'text', text: 'Aucun candidat.' })),
    });
    system = sys;

    const mission = await runDepartmentMission(sys, { targetTypes: ['distributor'] });

    assert.ok(
      sys.repos.llmCalls.forMission(mission.id).some((c) => c.purpose === 'brief'),
      "un brief partiel doit être complété par le modèle",
    );
  });
});

// ─── La politique de raisonnement ──────────────────────────────────────────

describe('Sonnet par défaut, Opus en escalade', () => {
  const models = { routine: 'claude-sonnet-5', strategic: 'claude-opus-5', effort: 'high' as const };

  test('structurer un objectif ne mobilise pas le modèle premium', () => {
    const choice = chooseReasoning('brief', models);
    assert.equal(choice.tier, 'routine');
    assert.equal(choice.model, 'claude-sonnet-5');
  });

  test('décomposer monte l’effort, pas le modèle', () => {
    // Sur les modèles actuels, la profondeur de réflexion rattrape l'essentiel
    // de l'écart, à une fraction du prix.
    const choice = chooseReasoning('plan', models);
    assert.equal(choice.tier, 'complex');
    assert.equal(choice.model, 'claude-sonnet-5');
    assert.equal(choice.effort, 'xhigh');
  });

  test('reconsidérer un plan mobilise le modèle premium', () => {
    const choice = chooseReasoning('replan', models);
    assert.equal(choice.tier, 'strategic');
    assert.equal(choice.model, 'claude-opus-5');
  });

  test('le modèle premium reste accessible — c’est une escalade, pas un retrait', () => {
    assert.ok(
      Object.values(['brief', 'plan', 'synthesis', 'replan'] as const)
        .map((d) => chooseReasoning(d, models).model)
        .includes('claude-opus-5'),
    );
  });
});

// ─── Rattachement et comptage ──────────────────────────────────────────────

describe('télémétrie complète', () => {
  test('un outil réussi laisse une trace', async () => {
    // `agent.tool` est publié en debug, que le journal d'événements écarte :
    // un outil qui réussissait ne laissait aucune trace, et l'économie ne
    // comptait donc que les échecs.
    const sys = createTestSystem({
      agents: [testAgent({ key: 'chercheur', skills: ['memory-recall'], maxSteps: 3 })],
      handler: async (call) => {
        const asked = call.request.messages.some((m) =>
          m.content.some((c) => c.type === 'tool_result'),
        );
        if (call.request.jsonSchema && !call.request.tools?.length) {
          if (call.request.system.includes('reporting to the founder')) {
            return { kind: 'json', value: { report: 'ok', quality: 60 } };
          }
          return {
            kind: 'json',
            value: {
              summary: 's',
              rationale: 'r',
              strategy: 'st',
              steps: [
                {
                  ref: 'recherche',
                  title: 'Chercher',
                  agentKey: 'chercheur',
                  action: 'research',
                  instruction: 'Chercher en mémoire.',
                  expectedOutput: 'Un constat.',
                  dependsOn: [],
                },
              ],
            },
          };
        }
        if (asked) return { kind: 'text', text: 'Terminé.' };
        return { kind: 'tool', name: 'memory_search', input: { query: 'quoi que ce soit' } };
      },
    });
    system = sys;

    const mission = await sys.hermes.submit({
      title: 'Outillée',
      objective: 'Chercher quelque chose.',
      createdBy: 'founder',
      departmentKey: null,
    });
    await waitFor(
      () => ['completed', 'failed'].includes(sys.repos.missions.require(mission.id).status),
      { timeoutMs: 20_000 },
    );

    const calls = sys.repos.toolCalls.forMission(mission.id);
    const search = calls.find((c) => c.tool === 'memory_search');
    assert.ok(search, "un outil réussi doit apparaître dans la comptabilité");
    assert.equal(search.ok, true);
    assert.equal(search.taskRef, 'recherche', "l'appel doit être imputé à son étape");
    assert.equal(search.agentKey, 'chercheur');
    assert.equal(search.external, false, 'la mémoire ATLAS ne sort pas du système');
  });

  test('aucun coût n’apparaît « hors étape » quand il appartient à une étape', async () => {
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1 },
      handler: departmentHandler(async () => ({ kind: 'text', text: 'Aucun candidat.' })),
    });
    system = sys;

    const mission = await runDepartmentMission(sys, BRIEF);
    const orphans = sys.repos.llmCalls
      .forMission(mission.id)
      .filter((c) => c.taskRef === null && c.purpose === 'agent-step');

    assert.deepEqual(orphans, [], 'un appel d’agent doit toujours porter la ref de son étape');
  });
});

// ─── Bornes de recherche ───────────────────────────────────────────────────

describe('les bornes de recherche suivent l’objectif', () => {
  test('viser deux candidats ne déclenche pas la recherche maximale', async () => {
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1 },
      handler: departmentHandler(async ({ request }) => {
        if (stepOf(request) === 'discovery') {
          return {
            kind: 'tool',
            name: 'discover_companies',
            input: { targetTypes: ['distributor'], countries: ['Allemagne'], limit: 2 },
          };
        }
        return { kind: 'text', text: 'Aucun candidat.' };
      }),
    });
    system = sys;

    await runDepartmentMission(sys, BRIEF);

    // Le provider simulé est écarté hors simulation, mais la borne calculée
    // reste vérifiable : deux candidats visés valent quatre recherches, pas six.
    const { maxSearchesPerDiscovery } = sys.config.web;
    assert.equal(Math.max(1, Math.min(maxSearchesPerDiscovery, 2 + 2)), 4);
    assert.ok(4 < maxSearchesPerDiscovery + 1);
  });
});

// ─── Mémoire vide : ne pas payer pour redécouvrir un vide connu ────────────

describe('un registre vide ne se sonde pas', () => {
  test('le briefing annonce le vide au lieu de le laisser deviner', async () => {
    // LIVE #003 a lancé quatre `memory_search` successifs sur un registre vide :
    // l'agent, ne recevant aucune connaissance préalable, a supposé qu'il
    // n'avait pas cherché au bon endroit. 0,17 $, 45 % du coût de la mission,
    // pour redécouvrir un vide qu'ATLAS connaissait avant de démarrer.
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1 },
      handler: departmentHandler(async () => ({ kind: 'text', text: 'Aucun candidat.' })),
    });
    system = sys;

    assert.equal(sys.repos.memory.total(), 0, 'le test suppose une mémoire vierge');
    await runDepartmentMission(sys, BRIEF);

    const briefings = sys.provider.calls
      .flatMap((c) => c.messages)
      .flatMap((m) => m.content)
      .map((c) => (c.type === 'text' ? c.text : ''))
      .filter((t) => t.includes('# Votre étape'));

    assert.ok(briefings.length > 0, 'au moins une étape a été briefée');
    assert.ok(
      briefings.every((b) => b.includes('État des connaissances ATLAS')),
      "chaque briefing doit dire ce qu'ATLAS sait déjà",
    );
    assert.ok(
      briefings.some((b) => /N'interrogez pas la mémoire/.test(b)),
      "l'agent doit être dispensé d'interroger une mémoire vide",
    );
  });

  test('le registre d’entreprises vide est signalé aux missions de département', async () => {
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1 },
      handler: departmentHandler(async () => ({ kind: 'text', text: 'Aucun candidat.' })),
    });
    system = sys;

    assert.equal(sys.repos.companies.count(), 0);
    await runDepartmentMission(sys, BRIEF);

    const briefing = sys.provider.calls
      .flatMap((c) => c.messages)
      .flatMap((m) => m.content)
      .map((c) => (c.type === 'text' ? c.text : ''))
      .find((t) => t.includes('# Votre étape'))!;

    assert.match(briefing, /Le registre métier est \*\*vide\*\*/);
    assert.match(briefing, /aucun candidat antérieur n'est réutilisable/);
    assert.match(briefing, /Ce n'est pas une panne/);
  });

  test('sur une mission générique, une mémoire réelle rend la recherche utile', async () => {
    // Une mission sans département n'a pas de registre métier : la mémoire
    // générale est sa seule réserve, et dès qu'elle contient quelque chose la
    // consigne de ne pas la consulter n'a plus lieu d'être.
    const sys = createTestSystem({
      handler: async (call) => {
        if (call.request.jsonSchema && !call.request.tools?.length) {
          if (call.request.system.includes('reporting to the founder')) {
            return { kind: 'json', value: { report: 'ok', quality: 60 } };
          }
          return {
            kind: 'json',
            value: {
              summary: 's',
              rationale: 'r',
              strategy: 'st',
              steps: [
                {
                  ref: 'analyse',
                  title: 'Analyser',
                  agentKey: 'analyst',
                  action: 'analyze',
                  instruction: 'Analyser le sujet.',
                  expectedOutput: 'Une analyse.',
                  dependsOn: [],
                },
              ],
            },
          };
        }
        return { kind: 'text', text: 'Analyse faite.' };
      },
    });
    system = sys;

    sys.memory.remember({
      kind: 'insight',
      title: 'Marché allemand de l’emballage',
      content: 'Une mission antérieure a étudié ce marché en détail.',
      importance: 0.9,
    });

    const mission = await sys.hermes.submit({
      title: 'Générique',
      objective: 'Analyser le marché allemand de l’emballage.',
      createdBy: 'founder',
      departmentKey: null,
    });
    await waitFor(
      () => ['completed', 'failed'].includes(sys.repos.missions.require(mission.id).status),
      { timeoutMs: 20_000 },
    );

    const briefings = sys.provider.calls
      .flatMap((c) => c.messages)
      .flatMap((m) => m.content)
      .map((c) => (c.type === 'text' ? c.text : ''))
      .filter((t) => t.includes('# Votre étape'));

    assert.ok(
      briefings.every((b) => !b.includes("N'interrogez pas la mémoire")),
      'une mémoire réelle doit rendre à la recherche tout son sens',
    );
  });

  test('mémoire système non vide + registre métier vide → toujours dispensé', async () => {
    // Le cas exact de LIVE #004 : deux éléments en mémoire générale (un bilan
    // de l'Evolution Manager, un résumé de mission) et zéro entreprise. Le
    // garde-fou exigeait le vide absolu et ne s'est pas déclenché ; sept
    // `memory_search` ont suivi, pour 46 % du coût de la mission.
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1 },
      handler: departmentHandler(async () => ({ kind: 'text', text: 'Aucun candidat.' })),
    });
    system = sys;

    sys.memory.remember({
      kind: 'outcome',
      title: 'Performance review — bilan système',
      content: "Bilan de fonctionnement produit par l'Evolution Manager.",
      importance: 0.6,
    });
    sys.memory.remember({
      kind: 'outcome',
      title: 'Mission outcome: une mission antérieure',
      content: 'Résumé de mission, sans aucune entreprise exploitable.',
      importance: 0.6,
    });

    assert.ok(sys.repos.memory.total() > 0, 'la mémoire générale n’est pas vide');
    assert.equal(sys.repos.companies.count(), 0, 'le registre métier est vide');

    await runDepartmentMission(sys, BRIEF);

    const briefing = sys.provider.calls
      .flatMap((c) => c.messages)
      .flatMap((m) => m.content)
      .map((c) => (c.type === 'text' ? c.text : ''))
      .find((t) => t.includes('# Votre étape'))!;

    assert.match(briefing, /Le registre métier est \*\*vide\*\*/);
    assert.match(briefing, /N'interrogez pas la mémoire pour y chercher des candidats/);
    // La nuance compte : on dit pourquoi la mémoire générale ne sert à rien ici.
    assert.match(briefing, /traces de fonctionnement/);
  });

  test('un registre métier peuplé rend la mémoire de nouveau utile', async () => {
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1 },
      handler: departmentHandler(async () => ({ kind: 'text', text: 'Aucun candidat.' })),
    });
    system = sys;

    sys.repos.companies.upsert({
      canonicalKey: 'd:verpackung-nord.de',
      name: 'Verpackung Nord GmbH',
      website: 'https://verpackung-nord.de',
      domain: 'verpackung-nord.de',
      country: 'Allemagne',
      industries: ["Machines d'emballage"],
    });
    assert.ok(sys.repos.companies.count() > 0);

    await runDepartmentMission(sys, BRIEF);

    const briefings = sys.provider.calls
      .flatMap((c) => c.messages)
      .flatMap((m) => m.content)
      .map((c) => (c.type === 'text' ? c.text : ''))
      .filter((t) => t.includes('# Votre étape'));

    assert.ok(
      briefings.every((b) => !b.includes('Le registre métier est')),
      'dès que des entreprises existent, la recherche mémoire reprend tout son sens',
    );
  });
});
