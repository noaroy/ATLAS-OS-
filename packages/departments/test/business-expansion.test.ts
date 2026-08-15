import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestSystem, waitFor, type TestSystem } from '@atlas/testing';
import { BUSINESS_EXPANSION, DEPARTMENT_DEFINITIONS, routeObjective } from '@atlas/departments';
import { instantiatePlaybook, renderTemplate } from '@atlas/intelligence';
import { SKILL_CATALOGUE } from '@atlas/agents';
import type { LlmRequest } from '@atlas/llm';

/**
 * Business Expansion Intelligence, end to end.
 *
 * The reference case: a French machine manufacturer wants distributors in
 * Germany. These drive the whole pipeline through the real orchestrator, the
 * real tools and the real database — the only thing scripted is what the model
 * says, which is the one part ATLAS does not own.
 */

let system: TestSystem | null = null;

afterEach(() => {
  system?.cleanup();
  system = null;
});

const OBJECTIVE =
  'We are a French manufacturer of industrial machines. Find 20 relevant potential distributors in Germany.';

/**
 * How many candidates the reference mission asks for.
 *
 * Kept small on purpose: the scripted Analyst has to score each one inside its
 * step budget, so a large number would test the step limit rather than the
 * pipeline.
 */
const WANTED = 4;

const textOf = (request: LlmRequest): string =>
  request.messages
    .flatMap((m) => m.content)
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n');

/** Which agent is being addressed, read from its persona. */
function agentOf(request: LlmRequest): string {
  // Les appels d'Hermès sont ceux qui demandent une sortie structurée. Le
  // prompt d'extraction de brief est rédigé en anglais (« Hermes »), celui de
  // synthèse en français (« Hermès ») : ne reconnaître qu'une graphie faisait
  // passer le brief pour un appel d'agent.
  if (request.jsonSchema) return 'hermes';
  if (request.system.includes("l'Explorateur")) return 'explorer';
  if (request.system.includes("l'Ambassadeur")) return 'ambassador';
  if (request.system.includes("l'Analyste")) return 'analyst';
  if (request.system.includes("l'Architecte")) return 'architect';
  return 'other';
}

/**
 * Which playbook stage this request belongs to.
 *
 * Read from the step ref Hermes states in the briefing rather than sniffed from
 * the prose: the instructions legitimately contain words like "registered", and
 * a handler keyed off those breaks for reasons that are not the system's.
 */
function stageOf(request: LlmRequest): string | null {
  return textOf(request).match(/# Votre étape \(([\w-]+)\)/)?.[1] ?? null;
}

const BRIEF = {
  clientProfile: {
    name: 'the client',
    country: 'France',
    industry: 'Industrial machinery',
    offering: 'Industrial machines for manufacturing lines',
    differentiators: ['Compact footprint'],
  },
  targetTypes: ['distributor', 'integrator'],
  markets: { countries: ['Germany'], industries: ['Manufacturing'], regions: [] },
  desiredCount: WANTED,
  mustHave: ['Sells industrial equipment in Germany'],
  niceToHave: ['Own service engineers'],
  exclusions: ['Consumer-only retailers'],
};

/**
 * Runs the reference mission to completion.
 *
 * The handler plays each agent the way a competent one would: the Explorer
 * registers then enriches, the Ambassador qualifies against real evidence, the
 * Analyst scores each candidate and then ranks, the Architect writes the report.
 * Each stage answers with text once its work is done, exactly as a real agent
 * concludes a step.
 */
async function runReferenceMission(options: { rejectEverything?: boolean } = {}) {
  const opportunityIds: string[] = [];
  const enriched = new Set<string>();
  const qualified = new Set<string>();
  const scored = new Set<string>();
  let discovered = false;
  let ranked = false;
  let documented = false;

  const sys = createTestSystem({
    settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1, maxReplansPerMission: 0 },
    handler: async ({ request }) => {
      const agent = agentOf(request);
      const stage = stageOf(request);

      if (agent === 'hermes') {
        const properties = (request.jsonSchema as { properties?: Record<string, unknown> }).properties ?? {};
        return 'report' in properties
          ? { kind: 'json', value: { report: '# Shortlist\nSee the ranked candidates.', quality: 88 } }
          : { kind: 'json', value: BRIEF };
      }

      if (agent === 'explorer') {
        if (stage === 'discovery') {
          if (discovered) return { kind: 'text', text: 'Candidats enregistrés ; couverture notée.' };
          discovered = true;
          // The agent describes the profile; ATLAS's providers find the
          // companies and keep the provenance of each one.
          return {
            kind: 'tool',
            name: 'discover_companies',
            input: {
              targetTypes: ['distributor', 'integrator'],
              countries: ['Allemagne'],
              industries: ['Équipement industriel'],
              keywords: ['Antriebstechnik', 'Industrievertrieb'],
              limit: WANTED,
            },
          };
        }

        const next = opportunityIds.find((id) => !enriched.has(id));
        if (!next) return { kind: 'text', text: 'All candidates enriched with sourced evidence.' };
        enriched.add(next);
        return {
          kind: 'tool',
          name: 'enrich_company',
          input: {
            opportunityId: next,
            profile: { sizeBand: 'medium', employeesEstimate: 80, industries: ['Industrial equipment'] },
            evidence: [
              {
                field: 'territory',
                claim: 'Sales offices across Germany.',
                nature: 'observed',
                sourceKind: 'company-website',
                sourceRef: 'https://example.de/standorte',
                confidence: 0.9,
              },
              {
                field: 'portfolio',
                claim: 'Carries drives and automation components, no competing machines.',
                nature: 'observed',
                sourceKind: 'company-website',
                sourceRef: 'https://example.de/produkte',
                confidence: 0.85,
              },
            ],
            contacts: [{ name: 'Vertriebsleitung', role: 'Head of Sales', confidence: 0.4 }],
          },
        };
      }

      if (agent === 'ambassador') {
        const next = opportunityIds.find((id) => !qualified.has(id));
        if (!next) return { kind: 'text', text: 'Every candidate now has a recorded verdict.' };
        qualified.add(next);
        return {
          kind: 'tool',
          name: 'qualify_opportunity',
          input: {
            opportunityId: next,
            verdict: options.rejectEverything ? 'rejected' : 'qualified',
            checks: [
              {
                criterion: 'Sells industrial equipment in Germany',
                passed: !options.rejectEverything,
                detail: 'Nationwide sales offices and a complementary range.',
                evidenceIds: [],
              },
            ],
            rationale: 'Complementary range, national coverage, plausible motivation to add a line.',
            confidence: 0.8,
            requiredFields: ['territory', 'portfolio'],
          },
        };
      }

      if (agent === 'analyst') {
        if (stage === 'scoring') {
          const next = opportunityIds.find((id) => !scored.has(id));
          if (!next) return { kind: 'text', text: 'Every qualified candidate is scored.' };
          // Descending by discovery order, so the expected ranking is known in
          // advance without depending on any particular company name.
          const base = 88 - scored.size * 8;
          scored.add(next);
          return {
            kind: 'tool',
            name: 'score_opportunity',
            input: {
              opportunityId: next,
              assessments: [
                { dimension: 'sector-fit', value: base, rationale: 'Serves the same manufacturing base.', confidence: 0.8 },
                { dimension: 'geographic-fit', value: base - 5, rationale: 'National footprint.', confidence: 0.8 },
                { dimension: 'portfolio-fit', value: base - 10, rationale: 'Complementary, not competing.', confidence: 0.7 },
                { dimension: 'commercial-reach', value: base - 15, rationale: 'Own service engineers.', confidence: 0.6 },
                { dimension: 'strategic-relevance', value: base - 8, rationale: 'Actively adding lines.', confidence: 0.6 },
                { dimension: 'size-fit', value: base - 12, rationale: 'Mid-sized, we would matter to them.', confidence: 0.7 },
              ],
              roleFits: [
                { role: 'distributor', value: base, rationale: 'Distribue déjà des équipements comparables.', confidence: 0.8 },
                { role: 'integrator', value: base - 25, rationale: "Peu de références d'intégration complète.", confidence: 0.5 },
              ],
            },
          };
        }

        if (ranked) return { kind: 'text', text: 'Shortlist checked; the ordering matches the evidence.' };
        ranked = true;
        return { kind: 'tool', name: 'rank_shortlist', input: { limit: 20 } };
      }

      if (agent === 'architect') {
        if (documented) return { kind: 'text', text: 'Report written to the artifact store.' };
        documented = true;
        return {
          kind: 'tool',
          name: 'create_document',
          input: {
            title: 'German distributor shortlist',
            format: 'markdown',
            body: '# Shortlist\n\nRanked candidates with justifications.',
          },
        };
      }

      return { kind: 'text', text: 'done' };
    },
  });

  // Discovery hands ids back through the tool result; the test needs them too,
  // so it reads them from storage the moment discovery reports.
  sys.events.on('opportunity.discovered', () => {
    for (const opportunity of sys.repos.opportunities.forMission(mission.id)) {
      if (!opportunityIds.includes(opportunity.id)) opportunityIds.push(opportunity.id);
    }
  });

  const mission = await sys.hermes.submit({
    title: 'German distributors',
    objective: OBJECTIVE,
    createdBy: 'founder',
    context: {
      targetTypes: ['distributor', 'integrator'],
      desiredCount: WANTED,
      markets: { countries: ['Germany'], industries: ['Manufacturing'], regions: [] },
    },
  });

  await waitFor(() => ['completed', 'failed'].includes(sys.repos.missions.require(mission.id).status), {
    timeoutMs: 20_000,
  });
  return { sys, mission };
}

function nameFor(sys: TestSystem, opportunityId: string): string {
  const opportunity = sys.repos.opportunities.get(opportunityId);
  return opportunity ? (sys.repos.companies.get(opportunity.companyId)?.name ?? '') : '';
}

/** A Hermes handler that only needs to produce a brief and a report. */
function hermesOnly(request: LlmRequest) {
  const properties = (request.jsonSchema as { properties?: Record<string, unknown> }).properties ?? {};
  return 'report' in properties
    ? ({ kind: 'json', value: { report: 'partial', quality: 30 } } as const)
    : ({ kind: 'json', value: BRIEF } as const);
}

// ─── The department definition ─────────────────────────────────────────────

describe('the department definition', () => {
  test('every playbook stage names skills that exist in the catalogue', () => {
    const known = new Set(SKILL_CATALOGUE.map((s) => s.key));
    for (const department of DEPARTMENT_DEFINITIONS) {
      for (const stage of department.playbook) {
        for (const skill of stage.requiredSkills) {
          assert.ok(known.has(skill), `stage '${stage.ref}' requires unknown skill '${skill}'`);
        }
      }
    }
  });

  test('every playbook stage belongs to a declared team', () => {
    for (const department of DEPARTMENT_DEFINITIONS) {
      const teams = new Set(department.teams.map((t) => t.key));
      for (const stage of department.playbook) {
        assert.ok(teams.has(stage.teamKey), `stage '${stage.ref}' has no team`);
      }
    }
  });

  test('scoring weights are positive and include a computed axis', () => {
    const model = BUSINESS_EXPANSION.scoringModel;
    assert.ok(model.dimensions.every((d) => d.weight > 0));
    assert.ok(
      model.dimensions.some((d) => d.computed),
      'without a computed axis, an agent could score its own thoroughness',
    );
  });

  test('the department handles more than one kind of target', () => {
    const keys = BUSINESS_EXPANSION.targetTypes.map((t) => t.key);
    assert.ok(keys.includes('distributor'));
    assert.ok(keys.includes('supplier'));
    assert.ok(keys.includes('integrator'));
    assert.ok(keys.length >= 6, 'the department must not be a distributor-only product');
  });

  test('an objective is routed to the department that claims it', () => {
    assert.equal(routeObjective(OBJECTIVE, DEPARTMENT_DEFINITIONS), 'business-expansion');
    assert.equal(
      routeObjective('Trouve des distributeurs en Allemagne', DEPARTMENT_DEFINITIONS),
      'business-expansion',
    );
    assert.equal(
      routeObjective('Summarise last month system errors', DEPARTMENT_DEFINITIONS),
      null,
      'an unrelated objective must stay generic rather than be forced into a department',
    );
  });
});

describe('instantiating the method', () => {
  test('brief fields are interpolated into the instructions', () => {
    const rendered = renderTemplate('Find {{targetType}}s in {{markets.countries}} for {{clientProfile.name}}', {
      targetType: 'distributor',
      markets: { countries: ['Germany', 'Austria'] },
      clientProfile: { name: 'Acme' },
    });
    assert.equal(rendered, 'Find distributors in Germany, Austria for Acme');
  });

  test('a missing field is marked unspecified rather than left as a placeholder', () => {
    assert.equal(renderTemplate('Count: {{desiredCount}}', {}), 'Count: unspecified');
  });

  test('a stage assigned to an agent lacking a required skill fails at planning time', () => {
    system = createTestSystem({ handler: async () => ({ kind: 'text', text: 'ok' }) });
    const agents = system.repos.agents
      .listByMandate('mission-execution')
      .map((a) => (a.key === 'explorer' ? { ...a, skills: ['memory-recall'] } : a));

    assert.throws(
      () =>
        instantiatePlaybook({
          playbook: BUSINESS_EXPANSION.playbook,
          brief: {},
          agents,
          departmentName: 'Business Expansion',
          producedBy: 'test',
          producedAt: new Date().toISOString(),
        }),
      /company-discovery/,
      'a broken method must fail before anything is paid for',
    );
  });

  test('the real roster can run the real method', () => {
    system = createTestSystem({ handler: async () => ({ kind: 'text', text: 'ok' }) });
    const plan = instantiatePlaybook({
      playbook: BUSINESS_EXPANSION.playbook,
      brief: { targetType: 'distributor', desiredCount: 20, markets: { countries: ['Germany'] } },
      agents: system.repos.agents.listByMandate('mission-execution'),
      departmentName: 'Business Expansion',
      producedBy: 'test',
      producedAt: new Date().toISOString(),
    });

    assert.equal(plan.steps.length, BUSINESS_EXPANSION.playbook.length);
    assert.deepEqual(
      plan.steps.map((s) => s.agentKey),
      ['explorer', 'explorer', 'ambassador', 'analyst', 'analyst', 'architect'],
    );
    assert.match(plan.steps[0]!.title, /Germany/);
  });
});

// ─── The reference mission ─────────────────────────────────────────────────

describe('the reference mission', () => {
  test('is planned from the playbook, not improvised', async () => {
    const { sys, mission } = await runReferenceMission();
    system = sys;

    const planned = sys.repos.missions.require(mission.id);
    assert.equal(planned.departmentKey, 'business-expansion');
    assert.equal(planned.plan!.producedBy, 'department:business-expansion');
    assert.deepEqual(
      sys.repos.missions.tasksFor(mission.id).map((t) => t.ref),
      ['discovery', 'enrichment', 'qualification', 'scoring', 'ranking', 'report'],
    );
  });

  test('turns the objective into a structured brief, stored once', async () => {
    const { sys, mission } = await runReferenceMission();
    system = sys;

    const brief = (sys.repos.missions.require(mission.id).context as { brief?: Record<string, unknown> })
      .brief!;
    assert.deepEqual(brief.targetTypes, ['distributor', 'integrator']);
    assert.equal(brief.desiredCount, WANTED, 'a field the founder stated must survive extraction');
    assert.deepEqual((brief.markets as { countries: string[] }).countries, ['Germany']);
    assert.equal(sys.eventsOfType('department.brief').length, 1);
  });

  test('completes with a ranked, justified shortlist', async () => {
    const { sys, mission } = await runReferenceMission();
    system = sys;

    assert.equal(sys.repos.missions.require(mission.id).status, 'completed');

    const shortlist = sys.repos.opportunities.shortlistFor(mission.id);
    assert.ok(shortlist.length >= 3, 'the discovery providers must produce a shortlist');
    assert.deepEqual(
      shortlist.map((o) => o.rank),
      shortlist.map((_, index) => index + 1),
      'ranks must be contiguous from 1',
    );
    assert.ok(shortlist[0]!.score! > shortlist[1]!.score!);
    assert.match(shortlist[0]!.justification!, /Classé n°1/);
    assert.match(shortlist[0]!.justification!, /Adéquation sectorielle/);
  });

  test('puts the shortlist on the mission result, read from storage', async () => {
    const { sys, mission } = await runReferenceMission();
    system = sys;

    const result = sys.repos.missions.require(mission.id).result!;
    const shortlist = result.outputs.shortlist as Array<{ rank: number; name: string; justification: string }>;
    assert.ok(shortlist.length >= 3);
    assert.equal(shortlist[0]!.rank, 1);
    assert.ok(shortlist[0]!.name.length > 0);
    assert.ok(shortlist[0]!.justification.length > 20);

    assert.equal(
      (result.outputs.funnel as Record<string, number>).shortlisted,
      shortlist.length,
    );
  });

  test('stores every claim behind the shortlist with its source', async () => {
    const { sys, mission } = await runReferenceMission();
    system = sys;

    const evidence = sys.repos.companies.evidenceForMission(mission.id);
    assert.ok(evidence.length >= 9, 'one discovery claim plus two enrichment claims per candidate');
    assert.ok(
      evidence.some((e) => e.sourceKey === 'simulation'),
      'a simulated run must be traceable to the simulation source',
    );
    assert.ok(
      evidence.every((e) => e.sourceKey && e.agentKey && e.collectedAt),
      'evidence without provenance is not evidence',
    );
    assert.ok(evidence.some((e) => e.nature === 'observed'));
    assert.ok(
      evidence.every((e) => e.nature !== 'inferred' || e.basis),
      'an inference must always say what it rests on',
    );
  });

  test('computes the economics of the run', async () => {
    const { sys, mission } = await runReferenceMission();
    system = sys;

    const economics = sys.repos.missions.require(mission.id).result!.outputs.economics as {
      opportunitiesDiscovered: number;
      opportunitiesQualified: number;
      opportunitiesShortlisted: number;
      tokensUsed: number;
    };

    assert.ok(economics.opportunitiesDiscovered >= 3);
    assert.equal(economics.opportunitiesQualified, economics.opportunitiesDiscovered);
    assert.equal(economics.opportunitiesShortlisted, economics.opportunitiesDiscovered);
    assert.ok(economics.tokensUsed > 0);
  });

  test('shows the work in the village as it actually happened', async () => {
    const { sys } = await runReferenceMission();
    system = sys;

    assert.ok(sys.eventsOfType('opportunity.discovered').length >= 1);
    assert.ok(sys.eventsOfType('opportunity.qualified').length >= 3);
    assert.ok(sys.eventsOfType('opportunity.scored').length >= 3);
    assert.equal(sys.eventsOfType('opportunity.shortlisted').length, 1);

    const states = sys.eventsOfType('agent.state').map((e) => (e.payload as { status: string }).status);
    assert.ok(states.includes('moving'), 'agents travel because a step was dispatched');
    assert.ok(states.includes('working'));
  });

  test('reports an empty shortlist rather than inventing one', async () => {
    const { sys, mission } = await runReferenceMission({ rejectEverything: true });
    system = sys;

    assert.equal(sys.repos.opportunities.shortlistFor(mission.id).length, 0);
    const funnel = sys.repos.opportunities.funnelFor(mission.id);
    assert.ok(funnel.rejected >= 3);
    assert.equal(funnel.shortlisted, 0);
  });
});

// ─── Resilience ────────────────────────────────────────────────────────────

describe('resilience', () => {
  test('a failed stage stops everything that depended on it', async () => {
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1, maxReplansPerMission: 0 },
      handler: async ({ request }) => {
        if (agentOf(request) === 'hermes') return hermesOnly(request);
        // Discovery fails outright, so nothing downstream has anything to work on.
        if (agentOf(request) === 'explorer') {
          return { kind: 'throw', error: new Error('directory unreachable') };
        }
        return { kind: 'text', text: 'nothing to do' };
      },
    });
    system = sys;

    const mission = await sys.hermes.submit({
      title: 'Failing discovery',
      objective: OBJECTIVE,
      createdBy: 'founder',
      departmentKey: 'business-expansion',
    });
    await waitFor(() => ['completed', 'failed'].includes(sys.repos.missions.require(mission.id).status), {
      timeoutMs: 20_000,
    });

    const tasks = sys.repos.missions.tasksFor(mission.id);
    assert.equal(tasks.find((t) => t.ref === 'discovery')!.status, 'failed');
    assert.ok(
      tasks.filter((t) => t.status === 'skipped').length >= 4,
      'the whole chain below a failed discovery must be skipped, not attempted',
    );
    assert.equal(sys.repos.opportunities.forMission(mission.id).length, 0);
  });

  test('a department mission stops cleanly at its token budget', async () => {
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1, missionTokenBudget: 30_000 },
      // Une seule étape consomme plus que le budget de la mission entière.
      // C'est LIVE #001 en miniature : l'enrichissement y avait consommé
      // 343 % du plafond total.
      handler: async ({ request }) =>
        agentOf(request) === 'hermes'
          ? hermesOnly(request)
          : {
              kind: 'text',
              text: 'a step that consumes tokens',
              usage: { inputTokens: 30_000, outputTokens: 10_000 },
            },
    });
    system = sys;

    const mission = await sys.hermes.submit({
      title: 'Budgeted',
      objective: OBJECTIVE,
      createdBy: 'founder',
      departmentKey: 'business-expansion',
    });
    await waitFor(() => ['completed', 'failed'].includes(sys.repos.missions.require(mission.id).status), {
      timeoutMs: 20_000,
    });

    assert.equal(sys.eventsOfType('mission.budget-exhausted').length, 1);
    assert.equal(sys.repos.missions.require(mission.id).result!.budgetExhausted, true);
    assert.ok(
      sys.repos.missions.tasksFor(mission.id).some((t) => t.status === 'cancelled'),
      'remaining stages must be cancelled rather than run past the ceiling',
    );
  });

  test('the brief is read once and survives on the mission', async () => {
    const { sys, mission } = await runReferenceMission();
    system = sys;

    assert.ok(
      (sys.repos.missions.require(mission.id).context as { brief?: unknown }).brief,
      'a resumed mission must not pay to have its objective read again',
    );
    assert.equal(sys.eventsOfType('department.brief').length, 1);
  });

  test('an objective outside any department is still planned by Hermes', async () => {
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1 },
      handler: async ({ request }) => {
        if (request.jsonSchema) {
          const properties = (request.jsonSchema as { properties?: Record<string, unknown> }).properties ?? {};
          if ('report' in properties) return { kind: 'json', value: { report: 'done', quality: 70 } };
          return {
            kind: 'json',
            value: {
              summary: 'One step',
              rationale: 'Simple objective',
              strategy: 'direct',
              steps: [
                {
                  ref: 's1',
                  title: 'Summarise the errors',
                  agentKey: 'analyst',
                  action: 'analyze',
                  instruction: 'Summarise last month system errors.',
                  input: {},
                  expectedOutput: 'A summary',
                  dependsOn: [],
                },
              ],
            },
          };
        }
        return { kind: 'text', text: 'summary produced' };
      },
    });
    system = sys;

    const mission = await sys.hermes.submit({
      title: 'Generic',
      objective: 'Summarise last month system errors.',
      createdBy: 'founder',
    });
    await waitFor(() => ['completed', 'failed'].includes(sys.repos.missions.require(mission.id).status), {
      timeoutMs: 20_000,
    });

    const finished = sys.repos.missions.require(mission.id);
    assert.equal(finished.departmentKey, null, 'nothing may be forced into a department');
    assert.notEqual(finished.plan!.producedBy, 'department:business-expansion');
    assert.equal(sys.repos.opportunities.forMission(mission.id).length, 0);
  });
});
