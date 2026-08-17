import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestSystem, type TestSystem } from '@atlas/testing';

/**
 * La comptabilité par candidat.
 *
 * Le total par étape disait « l'enrichissement a coûté 0,116 $ ». Il ne disait
 * pas si dix candidats avaient coûté un centime chacun ou si l'un d'eux en
 * avait mangé neuf — et c'est la seule décomposition qui permette de décider
 * quoi arrêter.
 *
 * Pire : une dépense qui croît comme le carré du travail ressemble, sur une
 * ligne d'agrégat, à une dépense simplement élevée. VAL-003 a payé trois fois
 * pour cette confusion.
 *
 * Ces tests lisent les colonnes réellement écrites en base, pas la structure
 * en mémoire : une télémétrie qui ne survit pas à l'écriture ne sert à rien
 * quand il faut expliquer une facture après coup.
 */

let system: TestSystem | null = null;

afterEach(() => {
  system?.cleanup();
  system = null;
});

/** Fait enrichir `n` candidats et rend la comptabilité par sujet. */
async function spendOn(n: number) {
  let done = 0;
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
            opportunityId: opportunityIds[done - 1],
            evidence: [
              {
                field: 'existence',
                claim: `Candidat ${done} — ${'DETAIL '.repeat(40)}`,
                nature: 'reported',
                sourceRef: `https://candidat-${done}.de/about`,
                confidence: 0.7,
              },
              {
                field: 'sector',
                claim: `Candidat ${done} distribue des machines d'emballage industrielles.`,
                nature: 'reported',
                sourceRef: `https://candidat-${done}.de/produkte`,
                confidence: 0.6,
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
  assert.equal(result.toolFailures, 0, 'la mesure ne vaut que si les appels réussissent');

  return { sys, missionId: mission.id, calls: sys.repos.llmCalls.forMission(mission.id) };
}

describe('comptabilité par candidat', () => {
  test('chaque appel dit sur quel candidat il porte et ce qu’il a coûté', async () => {
    const { sys, missionId } = await spendOn(5);
    const perSubject = sys.repos.llmCalls.bySubject(missionId);

    assert.ok(perSubject.length >= 5, `attendu ≥ 5 candidats comptabilisés, obtenu ${perSubject.length}`);

    for (const row of perSubject) {
      assert.match(row.subject, /^enrichment#\d+$/, `sujet mal formé : ${row.subject}`);
      // Les cinq grandeurs demandées, présentes et mesurées — pas déduites.
      assert.ok(row.inputTokens > 0, `${row.subject} : jetons d'entrée non mesurés`);
      assert.ok(row.outputTokens > 0, `${row.subject} : jetons de sortie non mesurés`);
      assert.ok(row.costUsd >= 0, `${row.subject} : coût manquant`);
      assert.ok(
        row.peakContextChars !== null && row.peakContextChars > 0,
        `${row.subject} : taille de contexte non mesurée`,
      );
      assert.ok(row.evidenceCount !== null, `${row.subject} : preuves injectées non mesurées`);
    }
  });

  test('le contexte du dixième candidat ne porte pas la somme des neuf premiers', async () => {
    const { sys, missionId } = await spendOn(10);
    const perSubject = sys.repos.llmCalls.bySubject(missionId);
    const contexts = perSubject.map((r) => r.peakContextChars!);

    const first = contexts[0]!;
    const last = contexts.at(-1)!;

    // L'assertion demandée, lue depuis la base : ce que coûte le dixième
    // candidat ne doit pas dépendre de ce qu'ont coûté les neuf précédents.
    // Le seuil est posé au double : le relevé des unités closes fait
    // légitimement grandir le contexte d'une ligne courte par candidat, et
    // rien d'autre ne doit s'y ajouter.
    assert.ok(
      last < first * 2,
      `contexte du même ordre attendu du premier au dixième candidat — ` +
        `${first} → ${last} car. (${contexts.join(' → ')})`,
    );
  });

  test('les preuves d’un candidat ne s’ajoutent pas à celles du précédent', async () => {
    const { sys, missionId } = await spendOn(6);
    const counts = sys.repos.llmCalls.bySubject(missionId).map((r) => r.evidenceCount!);

    // Deux preuves sont versées par candidat. Sans isolement, le sixième en
    // verrait douze : le compte suivrait le cumul, pas le travail en cours.
    for (const [i, count] of counts.entries()) {
      assert.ok(
        count <= 2,
        `candidat ${i + 1} : ${count} preuves dans le contexte, ` +
          `au plus 2 attendues (${counts.join(', ')})`,
      );
    }
  });

  test('un appel qui ne porte sur aucun candidat ne s’en invente pas', async () => {
    // Une étape qui n'itère sur rien n'a pas de sujet. Écrire `0` ou une
    // chaîne vide affirmerait une mesure ; `null` dit ce qui est.
    const sys = createTestSystem({
      settings: { maxConcurrentTasks: 1, taskMaxAttempts: 1 },
      budget: { maxMissionTokens: 0, maxMissionCostUsd: 0, maxStepTokens: 0, maxCallsPerStep: 0 },
      handler: async () => ({ kind: 'text', text: 'analyse rendue' }),
    });
    system = sys;

    const mission = sys.repos.missions.create({
      title: 'Synthèse',
      objective: 'Rédiger la synthèse des candidats retenus pour le marché allemand.',
      context: {},
      createdBy: 'test',
    });
    const [task] = sys.repos.missions.replaceTasks(mission.id, [
      {
        ref: 'synthesis',
        title: 'Synthétiser',
        agentKey: 'analyst',
        action: 'analyze',
        instruction: 'Synthétisez.',
        input: {},
        dependsOn: [],
        maxAttempts: 1,
      },
    ]);

    const agent = sys.repos.agents.getDefinition('analyst')!;
    await sys.runtime.run({
      agent: { ...agent, maxSteps: 2 },
      mission: sys.repos.missions.require(mission.id),
      task: task!,
      upstream: {},
    });

    const calls = sys.repos.llmCalls.forMission(mission.id);
    assert.ok(calls.length > 0, 'aucun appel enregistré');
    for (const call of calls) {
      assert.equal(call.subject, null, 'une étape sans itération ne doit pas se voir attribuer un sujet');
      assert.equal(call.evidenceCount, null, 'aucune preuve injectée n’est différent de zéro preuve');
      // Le contexte, lui, est toujours mesurable : il part quoi qu'il arrive.
      assert.ok(call.contextChars !== null && call.contextChars > 0, 'contexte non mesuré');
    }
    assert.equal(sys.repos.llmCalls.bySubject(mission.id).length, 0);
  });
});
