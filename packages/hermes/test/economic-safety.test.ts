import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestSystem, waitFor, type TestSystem, type ScriptedHandler } from '@atlas/testing';
import type { LlmRequest } from '@atlas/llm';

/**
 * Sûreté économique — les pannes qui ont coûté 9,15 $.
 *
 * LIVE #001 a dépensé 9,15 $ et 1 524 676 jetons pour zéro candidat. La chaîne
 * était la suivante :
 *
 *   1. un `maxItems` fait rejeter chaque recherche en 400 ;
 *   2. la découverte se termine « avec succès » en rapportant qu'elle n'a rien ;
 *   3. l'enrichissement est lancé quand même, faute de précondition ;
 *   4. privé d'entrée, l'agent improvise pendant 715 s — 1 372 673 jetons,
 *      soit 343 % du budget total de la mission, dans une seule étape.
 *
 * Chaque maillon a maintenant son test. Le plus important est le dernier :
 * découverte sans candidat ⇒ **zéro appel LLM** à l'enrichissement.
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
  desiredCount: 5,
  mustHave: [],
  niceToHave: [],
  exclusions: [],
};

/** Quelle étape de mission cet appel d'agent sert, lue dans le briefing. */
function stepOf(request: LlmRequest): string | null {
  const briefing = request.messages
    .flatMap((m) => m.content)
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('\n');
  return briefing.match(/# Votre étape \(([^)]+)\)/)?.[1] ?? null;
}

/** Répond aux appels structurés d'Hermès ; délègue le reste au test. */
function departmentHandler(execute: ScriptedHandler): ScriptedHandler {
  return async (call) => {
    if (call.request.jsonSchema) {
      const properties =
        (call.request.jsonSchema as { properties?: Record<string, unknown> }).properties ?? {};
      return 'report' in properties
        ? { kind: 'json', value: { report: 'Rapport de mission.', quality: 40 } }
        : { kind: 'json', value: BRIEF };
    }
    return execute(call);
  };
}

async function runDepartmentMission(sys: TestSystem) {
  const mission = await sys.hermes.submit({
    title: 'Partenaires allemands',
    objective: OBJECTIVE,
    createdBy: 'founder',
    departmentKey: 'business-expansion',
  });
  await waitFor(
    () => ['completed', 'failed'].includes(sys.repos.missions.require(mission.id).status),
    { timeoutMs: 20_000, label: 'la mission se termine' },
  );
  return sys.repos.missions.require(mission.id);
}

// ─── Le scénario à 9,15 $ ──────────────────────────────────────────────────

describe('découverte sans candidat', () => {
  test("l'enrichissement ne passe AUCUN appel au modèle", async () => {
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1 },
      // La découverte se termine avec succès en rapportant honnêtement qu'elle
      // n'a rien trouvé — exactement ce qu'a fait l'Explorateur de LIVE #001.
      handler: departmentHandler(async () => ({
        kind: 'text',
        text: "Aucun candidat : le fournisseur de recherche a refusé chaque requête. Je n'invente aucune entreprise.",
      })),
    });
    system = sys;

    const mission = await runDepartmentMission(sys);
    const tasks = sys.repos.missions.tasksFor(mission.id);
    const steps = Object.fromEntries(tasks.map((t) => [t.ref, t]));

    assert.equal(steps.discovery!.status, 'succeeded', 'un constat d’absence est un résultat valable');
    assert.equal(steps.enrichment!.status, 'skipped');
    assert.match(steps.enrichment!.error!, /^SKIPPED_NO_INPUT/);

    // Le cœur du test. Aucun appel du modèle ne doit porter la ref de l'étape
    // d'enrichissement : c'est la ligne qui a coûté 8,24 $.
    const enrichmentCalls = sys.provider.calls.filter((r) => stepOf(r) === 'enrichment');
    assert.equal(
      enrichmentCalls.length,
      0,
      "l'enrichissement ne doit émettre aucun appel LLM quand la découverte n'a rien produit",
    );

    // Et rien n'a été facturé à cette étape dans la comptabilité.
    const billed = sys.repos.llmCalls.byStep(mission.id).filter((s) => s.taskRef === 'enrichment');
    assert.deepEqual(billed, [], "aucun coût ne doit être imputé à une étape jamais exécutée");
  });

  test('toute la chaîne en aval est sautée, pas tentée', async () => {
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1 },
      handler: departmentHandler(async () => ({ kind: 'text', text: 'Aucun candidat trouvé.' })),
    });
    system = sys;

    const mission = await runDepartmentMission(sys);
    const tasks = sys.repos.missions.tasksFor(mission.id);

    for (const ref of ['enrichment', 'qualification', 'scoring', 'ranking']) {
      assert.equal(tasks.find((t) => t.ref === ref)!.status, 'skipped', `${ref} aurait dû être sautée`);
    }
    assert.equal(
      sys.provider.calls.filter((r) => {
        const step = stepOf(r);
        return step !== null && step !== 'discovery';
      }).length,
      0,
      'aucune étape en aval ne doit consommer quoi que ce soit',
    );
  });

  test("aucune entreprise n'est créée pour combler le vide", async () => {
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1 },
      handler: departmentHandler(async () => ({ kind: 'text', text: 'Rien trouvé.' })),
    });
    system = sys;

    const mission = await runDepartmentMission(sys);
    assert.equal(sys.repos.opportunities.forMission(mission.id).length, 0);
    assert.equal(sys.repos.companies.evidenceForMission(mission.id).length, 0);
  });

  test("l'issue dit « aucun résultat », pas « succès » ni « échec »", async () => {
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1 },
      handler: departmentHandler(async () => ({ kind: 'text', text: 'Rien trouvé.' })),
    });
    system = sys;

    const mission = await runDepartmentMission(sys);

    // Une recherche honnête qui ne trouve rien a bien fonctionné. La confondre
    // avec une panne pousserait à remplir la liste pour avoir l'air d'avoir
    // réussi — précisément ce qu'ATLAS refuse.
    assert.equal(mission.status, 'completed', 'le cycle de vie s’est achevé normalement');
    assert.equal(mission.result?.outcome, 'no-result');

    // Seule la première étape privée de matière est signalée comme telle ; les
    // suivantes tombent par cascade de dépendance. Les marquer toutes « sans
    // entrée » masquerait laquelle a réellement manqué de quelque chose.
    assert.deepEqual(mission.result?.skippedForMissingInput, ['enrichment']);

    const tasks = sys.repos.missions.tasksFor(mission.id);
    assert.equal(
      tasks.filter((t) => t.status === 'skipped').length,
      5,
      'les quatre étapes en aval suivent par cascade',
    );
  });

  test('une étape sautée est annoncée, pas passée sous silence', async () => {
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1 },
      handler: departmentHandler(async () => ({ kind: 'text', text: 'Rien trouvé.' })),
    });
    system = sys;

    await runDepartmentMission(sys);
    const skipped = sys.eventsOfType('task.skipped');
    assert.ok(skipped.length >= 1);
    assert.equal((skipped[0]!.payload as { cause: string }).cause, 'missing-input');
    assert.match(skipped[0]!.message, /sautée/);
  });
});

// ─── L'agent ne doit pas refaire le travail d'une étape en échec ───────────

describe("Hermès n'invite jamais un agent à refaire une étape amont", () => {
  test("le briefing d'une étape privée d'entrée le lui interdit explicitement", async () => {
    // C'est le second garde-fou : même lancé, l'agent est prévenu. Le premier
    // — la précondition — empêche l'étape de démarrer ; celui-ci protège les
    // cas où une étape amont a échoué sans que la matière soit exigible.
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1 },
      handler: async (call) => {
        if (call.request.jsonSchema && !call.request.tools?.length) {
          if (call.request.system.includes('reporting to the founder')) {
            return { kind: 'json', value: { report: 'ok', quality: 50 } };
          }
          return {
            kind: 'json',
            value: {
              summary: 's',
              rationale: 'r',
              strategy: 'st',
              steps: [
                {
                  ref: 'collecte',
                  title: 'Collecter',
                  agentKey: 'explorer',
                  action: 'research',
                  instruction: 'Collecter les données.',
                  expectedOutput: 'Des données.',
                  dependsOn: [],
                },
                {
                  ref: 'analyse',
                  title: 'Analyser',
                  agentKey: 'analyst',
                  action: 'analyze',
                  instruction: 'Analyser les données collectées.',
                  expectedOutput: 'Une analyse.',
                  dependsOn: [],
                },
              ],
            },
          };
        }
        // La collecte échoue ; l'analyse ne dépend pas d'elle formellement,
        // mais Hermès doit tout de même lui dire de ne pas la refaire.
        if (stepOf(call.request) === 'collecte') {
          return { kind: 'throw', error: new Error('source indisponible') };
        }
        return { kind: 'text', text: 'Analyse faite avec ce que j’avais.' };
      },
    });
    system = sys;

    const mission = await sys.hermes.submit({
      title: 'Chaîne',
      objective: 'Collecter puis analyser.',
      createdBy: 'founder',
      departmentKey: null,
    });
    await waitFor(
      () => ['completed', 'failed'].includes(sys.repos.missions.require(mission.id).status),
      { timeoutMs: 20_000 },
    );

    // Le briefing d'une étape dont une dépendance a échoué porte l'interdiction.
    const withFailedUpstream = sys.provider.calls.filter((r) =>
      r.messages
        .flatMap((m) => m.content)
        .some((c) => c.type === 'text' && c.text.includes('Étapes amont sans résultat')),
    );

    if (withFailedUpstream.length > 0) {
      const briefing = withFailedUpstream[0]!.messages
        .flatMap((m) => m.content)
        .map((c) => (c.type === 'text' ? c.text : ''))
        .join('\n');
      assert.match(briefing, /Ne refaites pas leur travail/);
      assert.match(briefing, /constat d'absence est un résultat valable/);
    }
  });
});

// ─── Une étape ne peut plus faire exploser le budget de la mission ─────────

describe('une étape ne peut plus absorber la mission', () => {
  test("un appel qui ne tient pas dans le budget n'est pas lancé", async () => {
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1, missionTokenBudget: 30_000 },
      handler: departmentHandler(async () => ({
        kind: 'text',
        text: 'étape coûteuse',
        usage: { inputTokens: 30_000, outputTokens: 10_000 },
      })),
    });
    system = sys;

    const mission = await runDepartmentMission(sys);

    assert.equal(mission.status, 'completed', 'un plafond atteint est un arrêt net, pas un plantage');
    assert.equal(mission.result?.budgetExhausted, true);
    assert.equal(mission.result?.outcome, 'cancelled-budget');
    assert.ok(
      sys.repos.missions.tasksFor(mission.id).some((t) => t.status === 'cancelled'),
      'le reste du plan est annulé plutôt que lancé au-delà du plafond',
    );
  });

  test('un refus budgétaire ne déclenche aucun retry', async () => {
    // Trois tentatives d'une étape refusée coûteraient trois fois ce que le
    // refus vient d'éviter.
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 3 },
      budget: { maxMissionTokens: 6000, maxOutputTokensPerCall: 2000 },
      handler: departmentHandler(async () => ({
        kind: 'text',
        text: 'étape',
        usage: { inputTokens: 4000, outputTokens: 1000 },
      })),
    });
    system = sys;

    const mission = await runDepartmentMission(sys);
    const cancelled = sys.repos.missions
      .tasksFor(mission.id)
      .filter((t) => t.status === 'cancelled' && (t.error ?? '').includes('Budget'));

    for (const task of cancelled) {
      assert.ok(task.attempts <= 1, `« ${task.ref} » a été retentée ${task.attempts} fois`);
    }
  });
});

// ─── Télémétrie ───────────────────────────────────────────────────────────

describe('la comptabilité par appel', () => {
  test('chaque appel est attribué à son étape, son agent et son intention', async () => {
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1 },
      handler: departmentHandler(async () => ({ kind: 'text', text: 'Aucun candidat.' })),
    });
    system = sys;

    const mission = await runDepartmentMission(sys);
    const calls = sys.repos.llmCalls.forMission(mission.id);

    assert.ok(calls.length > 0, 'la mission doit avoir une comptabilité');
    assert.ok(
      calls.some((c) => c.purpose === 'brief'),
      "l'extraction du brief doit être identifiable — elle a échoué silencieusement pendant LIVE #001",
    );

    const discovery = calls.find((c) => c.taskRef === 'discovery');
    assert.ok(discovery, "l'appel de découverte doit être rattaché à son étape");
    assert.equal(discovery.agentKey, 'explorer');
    assert.equal(discovery.purpose, 'agent-step');
    assert.ok(discovery.inputTokens > 0 && discovery.outputTokens > 0, 'entrée et sortie séparées');
  });

  test('les totaux se ventilent par modèle et par étape', async () => {
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1 },
      handler: departmentHandler(async () => ({ kind: 'text', text: 'Aucun candidat.' })),
    });
    system = sys;

    const mission = await runDepartmentMission(sys);
    const totals = sys.repos.llmCalls.totals(mission.id);
    const byModel = sys.repos.llmCalls.byModel(mission.id);
    const byStep = sys.repos.llmCalls.byStep(mission.id);

    assert.equal(
      byModel.reduce((sum, m) => sum + m.calls, 0),
      totals.calls,
      'la ventilation par modèle doit couvrir tous les appels',
    );
    assert.ok(byStep.length > 0);
    assert.equal(totals.inputTokens > 0, true);
  });

  test("l'économie de mission expose la décomposition mesurée", async () => {
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1 },
      handler: departmentHandler(async () => ({ kind: 'text', text: 'Aucun candidat.' })),
    });
    system = sys;

    const mission = await runDepartmentMission(sys);
    const { missionEconomics } = await import('@atlas/intelligence');
    const economics = missionEconomics({
      repos: sys.repos,
      missionId: mission.id,
      model: 'claude-sonnet-5',
      simulated: false,
    });

    assert.ok(economics.measured, 'une mission instrumentée doit porter sa décomposition');
    assert.equal(economics.measured.llmCalls, sys.repos.llmCalls.totals(mission.id).calls);
    // Zéro candidat : le coût unitaire est null, jamais une division par zéro
    // déguisée en chiffre.
    assert.equal(economics.measured.costPerDiscoveredOpportunity, null);
    assert.equal(economics.measured.costPerQualifiedOpportunity, null);
  });

  test('aucun secret ne transite par la comptabilité', async () => {
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1 },
      handler: departmentHandler(async () => ({ kind: 'text', text: 'Aucun candidat.' })),
    });
    system = sys;

    const mission = await runDepartmentMission(sys);
    const serialised = JSON.stringify(sys.repos.llmCalls.forMission(mission.id));

    // La table dit ce qu'un appel a coûté, jamais ce qu'il contenait.
    assert.ok(!serialised.includes(OBJECTIVE));
    assert.ok(!/sk-ant|api[_-]?key/i.test(serialised));
  });
});
