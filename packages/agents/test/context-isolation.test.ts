import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestSystem, type TestSystem } from '@atlas/testing';
import type { LlmRequest } from '@atlas/llm';

/**
 * L'isolement du contexte entre deux unités de travail.
 *
 * VAL-003 a mesuré le défaut trois fois de suite. L'entrée de l'enrichissement
 * passait de 5 710 jetons au premier candidat à 32 443 au huitième — 178 584 au
 * total pour cinq candidats — parce que chaque candidat enrichi restait dans la
 * conversation et repartait au modèle avec le suivant.
 *
 * Le coût suivait donc le carré du nombre de candidats, quand le travail, lui,
 * restait strictement proportionnel. Trois missions de suite ont échoué avant
 * d'atteindre la qualification : pas faute de budget, mais parce que le budget
 * partait dans la répétition.
 *
 * La propriété appartient au runtime, et c'est là qu'elle est éprouvée ici —
 * pas à travers une mission complète, dont les préconditions masqueraient ce
 * qu'on mesure.
 */

let system: TestSystem | null = null;

/** Le volume qu'une unité de travail close laisserait derrière elle sans isolement. */
const PAYLOAD_CHARS = 'DETAIL_VOLUMINEUX '.repeat(45).length;

afterEach(() => {
  system?.cleanup();
  system = null;
});

/** La taille du contexte envoyé à chaque appel, en caractères. */
const contextSizes = (calls: LlmRequest[]): number[] =>
  calls.map((request) =>
    request.messages
      .flatMap((m) => m.content)
      .reduce((n, c) => n + (c.type === 'text' ? c.text.length : JSON.stringify(c).length), 0),
  );

/**
 * Fait traiter `n` unités de travail à un agent, et rend le contexte de chaque
 * appel.
 *
 * Chaque tour appelle `enrich_company` — marqué `boundary` — avec une charge
 * utile volumineuse. C'est exactement ce volume qui s'accumulait.
 */
async function runUnits(n: number): Promise<LlmRequest[]> {
  let done = 0;
  /** Les identifiants réels des opportunités à enrichir. */
  const opportunityIds: string[] = [];

  const sys = createTestSystem({
    settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1 },
    budget: { maxMissionTokens: 0, maxMissionCostUsd: 0, maxStepTokens: 0, maxCallsPerStep: 0 },
    handler: async () => {
      if (done < n) {
        done += 1;
        return {
          kind: 'tool',
          name: 'enrich_company',
          input: {
            // Un identifiant réel : sans quoi l'outil échoue, la frontière ne
            // se déclenche pas, et le test passerait pour la mauvaise raison.
            opportunityId: opportunityIds[done - 1],
            evidence: [
              {
                field: 'existence',
                claim: `Candidat ${done} — ${'DETAIL_VOLUMINEUX '.repeat(45)}`,
                nature: 'reported',
                sourceRef: `https://candidat-${done}.de/about`,
                confidence: 0.7,
              },
            ],
          },
        };
      }
      return { kind: 'text', text: 'toutes les unités sont traitées' };
    },
  });
  system = sys;

  const mission = sys.repos.missions.create({
    title: 'Enrichissement',
    objective: "Documenter chaque distributeur allemand identifié pour nos machines d'emballage.",
    context: {},
    createdBy: 'test',
    departmentKey: 'business-expansion',
  });

  // De vraies opportunités : `enrich_company` doit réussir pour clore une
  // unité, et c'est la réussite qu'on mesure.
  for (let i = 0; i < n; i++) {
    const { company } = sys.repos.companies.upsert({
      canonicalKey: `d:candidat-${i}.de`,
      name: `Candidat ${i} GmbH`,
      country: 'Allemagne',
      domain: `candidat-${i}.de`,
      dataOrigin: 'live',
    });
    const { opportunity } = sys.repos.opportunities.register({
      missionId: mission.id,
      companyId: company.id,
      departmentKey: 'business-expansion',
      targetTypes: ['distributor'],
      discoveredBy: 'test',
    });
    opportunityIds.push(opportunity.id);
  }

  const [task] = sys.repos.missions.replaceTasks(mission.id, [
    {
      ref: 'enrichment',
      title: 'Documenter chaque candidat',
      agentKey: 'explorer',
      action: 'enrich',
      instruction: 'Documentez chaque candidat, un par un.',
      input: {},
      dependsOn: [],
      maxAttempts: 1,
    },
  ]);

  const agent = sys.repos.agents.getDefinition('explorer')!;
  const result = await sys.runtime.run({
    agent: { ...agent, maxSteps: n + 2 },
    mission: sys.repos.missions.require(mission.id),
    task: task!,
    upstream: {},
  });
  // Le garde-fou du garde-fou. La première version de ces tests passait alors
  // que *tous* les appels échouaient : la charge utile dépassait la borne du
  // schéma, aucune frontière ne se déclenchait, et les contextes restaient
  // petits pour la mauvaise raison. Un test vert qui ne mesure rien est pire
  // qu'un test absent — donc on exige ici que les frontières soient bien
  // franchies avant de mesurer quoi que ce soit.
  assert.equal(
    result.toolFailures,
    0,
    `les ${n} appels doivent réussir, sinon aucune frontière ne se ferme ` +
      `et la mesure ne prouve rien (${result.toolFailures} échec(s))`,
  );
  assert.equal(result.toolCalls, n, `attendu ${n} unités closes, obtenu ${result.toolCalls}`);

  return sys.provider.calls;
}

describe('isolement du contexte entre unités de travail', () => {
  test('le contexte du dernier appel ne porte pas la somme des précédents', async () => {
    const sizes = contextSizes(await runUnits(10));
    assert.ok(sizes.length >= 10, `attendu ≥ 10 appels, obtenu ${sizes.length}`);

    // L'assertion demandée, énoncée telle quelle : ce que coûte le dixième
    // candidat ne doit pas dépendre de ce qu'ont coûté les neuf premiers.
    //
    // Entre le premier enrichissement et le dixième, le contexte ne doit avoir
    // grandi que du relevé — une ligne courte par unité close — et non des
    // charges utiles, qui pèsent chacune plus de 800 caractères. Le seuil est
    // posé au quart d'une charge utile : au-delà, quelque chose du travail
    // précédent voyage encore.
    const perClosedUnit = (sizes.at(-1)! - sizes[1]!) / 9;
    assert.ok(
      perClosedUnit < PAYLOAD_CHARS / 4,
      `chaque unité close ne doit laisser qu'une trace courte, ` +
        `mesuré ${perClosedUnit.toFixed(0)} car./unité pour une charge utile de ` +
        `${PAYLOAD_CHARS} car. (${sizes.join(' → ')})`,
    );
  });

  test('la croissance est linéaire, pas quadratique', async () => {
    // Le test empirique demandé, sur quatre tailles. Avec accumulation, le
    // total croît comme N² ; sans elle, comme N.
    const totals: Record<number, number> = {};
    for (const n of [1, 3, 5, 10]) {
      totals[n] = contextSizes(await runUnits(n)).reduce((a, b) => a + b, 0);
      system?.cleanup();
      system = null;
    }

    const ratio = totals[10]! / totals[1]!;
    // Dix unités doivent coûter de l'ordre de dix fois une unité. Le seuil est
    // posé à 20× : au-delà, la croissance n'est plus proportionnelle. Une
    // accumulation quadratique donnerait ici un facteur d'environ 55.
    assert.ok(
      ratio < 20,
      `10 unités doivent coûter ~10× une unité, mesuré ${ratio.toFixed(1)}× ` +
        `(1 → ${totals[1]}, 3 → ${totals[3]}, 5 → ${totals[5]}, 10 → ${totals[10]} car.)`,
    );

    // Et la progression elle-même doit rester régulière : le passage de 5 à 10
    // ne doit pas coûter davantage que le passage de 1 à 5 ne le laissait
    // prévoir.
    const perUnitAt5 = totals[5]! / 5;
    const perUnitAt10 = totals[10]! / 10;
    assert.ok(
      perUnitAt10 < perUnitAt5 * 2,
      `le coût par unité doit rester stable : ${perUnitAt5.toFixed(0)} car./unité à 5, ` +
        `${perUnitAt10.toFixed(0)} à 10`,
    );
  });

  test('une unité ne voit jamais le travail fait sur les précédentes', async () => {
    // L'exigence, énoncée directement : l'enrichissement de B ne doit pas
    // connaître ce qui a été trouvé sur A.
    const calls = await runUnits(4);
    // Le contexte entier, pas seulement ses blocs de texte : la charge utile
    // voyage dans un bloc `tool_use`, et ne la chercher que dans le texte
    // laisserait ce test vert alors que l'accumulation est bien là.
    const last = JSON.stringify(calls.at(-1)!.messages);

    assert.ok(
      !last.includes('DETAIL_VOLUMINEUX DETAIL_VOLUMINEUX'),
      'la charge utile d’une unité close ne doit pas voyager avec la suivante',
    );
  });

  test('le briefing de mission survit à la remise à propre', async () => {
    // L'isolement ne doit pas emporter ce dont l'agent a besoin d'un bout à
    // l'autre : sans le briefing, il ne saurait plus ce qu'il cherche.
    const calls = await runUnits(3);
    const last = calls
      .at(-1)!
      .messages.flatMap((m) => m.content)
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n');

    assert.match(last, /Documentez|distributeur|emballage/i);
  });

  test('le relevé des unités closes reste borné', async () => {
    // Un relevé qui grandit sans fin recréerait le problème qu'il résout, en
    // plus lent.
    const calls = await runUnits(10);
    const last = calls
      .at(-1)!
      .messages.flatMap((m) => m.content)
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n');

    const lines = last.split('\n').filter((l) => l.trim().startsWith('- enrich_company'));
    assert.ok(lines.length <= 25, `relevé plafonné à 25 lignes, obtenu ${lines.length}`);
  });

  test('un échec ne clôt aucune unité', async () => {
    // Effacer le contexte après un échec ferait perdre à l'agent ce qu'il
    // venait d'apprendre en essayant.
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1 },
      budget: { maxMissionTokens: 0, maxMissionCostUsd: 0, maxStepTokens: 0, maxCallsPerStep: 0 },
      handler: async (call) =>
        call.index < 2
          ? {
              kind: 'tool',
              name: 'enrich_company',
              // `evidence` vide : l'outil refuse, donc rien n'est clos.
              input: { opportunityId: 'opp_invalide', evidence: [] },
            }
          : { kind: 'text', text: 'terminé' },
    });
    system = sys;

    const mission = sys.repos.missions.create({
      title: 'Échecs',
      objective: 'o'.repeat(40),
      context: {},
      createdBy: 'test',
    });
    const [task] = sys.repos.missions.replaceTasks(mission.id, [
      {
        ref: 'enrichment',
        title: 'Documenter',
        agentKey: 'explorer',
        action: 'enrich',
        instruction: 'Documentez.',
        input: {},
        dependsOn: [],
        maxAttempts: 1,
      },
    ]);

    const agent = sys.repos.agents.getDefinition('explorer')!;
    const result = await sys.runtime.run({
      agent: { ...agent, maxSteps: 4 },
      mission: sys.repos.missions.require(mission.id),
      task: task!,
      upstream: {},
    });

    assert.ok(result.toolFailures > 0, 'les appels invalides doivent compter comme des échecs');
  });
});
