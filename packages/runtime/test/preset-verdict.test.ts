import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';
import {
  presetById,
  VALIDATION_MAX_OUTPUT_TOKENS_PER_CALL,
  VALIDATION_PRESETS,
} from '@atlas/departments';
import { evaluatePreset, DEFAULT_GATE } from '../src/preset-verdict.ts';

/**
 * Chaque validation jugée sur ses propres critères — et le socle qui ne bouge pas.
 *
 * L'évaluateur imposait six étapes sur six à toutes les missions. VAL-001, dont
 * l'objectif déclaré est de valider la découverte, se retrouvait donc PARTIAL
 * pour n'avoir pas produit de rapport final — alors qu'elle avait rempli chacun
 * de ses propres critères.
 *
 * Ce fichier protège les deux moitiés de la correction : qu'un preset puisse
 * exiger moins d'étapes, **et** qu'aucun ne puisse se dispenser du socle.
 */

const logger = createLogger({ level: 'error', pretty: false });
let repos: Repositories;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-preset-'));
  repos = createRepositories(join(dir, 'preset.db'), logger);
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const STEPS = ['discovery', 'enrichment', 'qualification', 'scoring', 'ranking', 'report'];

function missionWith(statuses: Record<string, string>, context: Record<string, unknown> = {}): string {
  const mission = repos.missions.create({
    title: 'validation',
    objective: 'o'.repeat(40),
    context: { budgetUsd: 0.08, executionMode: 'live', ...context },
    createdBy: 'test',
  });

  repos.missions.replaceTasks(
    mission.id,
    STEPS.map((ref, i) => ({
      ref,
      title: ref,
      agentKey: 'scout',
      action: ref,
      instruction: `Exécuter ${ref}`,
      input: {},
      dependsOn: i === 0 ? [] : [STEPS[i - 1]!],
      maxAttempts: 1,
    })),
  );

  for (const task of repos.missions.tasksFor(mission.id)) {
    const status = statuses[task.ref];
    if (status) repos.missions.setTaskStatus(task.id, status as never, {});
  }
  return mission.id;
}

/** Un candidat réel, avec sa preuve sourcée et un appel externe réussi. */
function realCandidate(missionId: string, index: number, options: { simulated?: boolean; sourced?: boolean } = {}): void {
  const { company } = repos.companies.upsert({
    canonicalKey: `cand-${index}`,
    name: `Candidat ${index} GmbH`,
    country: 'DE',
    website: `https://candidat-${index}.de`,
  });
  const { opportunity } = repos.opportunities.register({
    missionId,
    companyId: company.id,
    departmentKey: 'business-expansion',
    targetTypes: ['distributor'],
    discoveredBy: 'search',
  });
  repos.companies.appendEvidence({
    companyId: company.id,
    opportunityId: opportunity.id,
    missionId,
    field: 'activity',
    claim: 'distribue des machines',
    value: null,
    nature: 'observed',
    sourceKey: 'searxng',
    sourceRef: options.sourced === false ? null : `https://candidat-${index}.de/about`,
    sourceTitle: 'À propos',
    basis: 'page consultée',
    confidence: 0.8,
    simulated: options.simulated ?? false,
    collectedAt: new Date().toISOString(),
    agentKey: 'scout',
  });
}

/** Un appel externe réussi, qui prouve qu'un moteur réel a servi. */
function externalCall(missionId: string): void {
  repos.toolCalls.record({
    missionId,
    taskRef: 'discovery',
    agentKey: 'scout',
    tool: 'discover_companies',
    category: 'discovery',
    ok: true,
    outcome: 'success-with-results',
    error: null,
    durationMs: 800,
    external: true,
    createdAt: new Date().toISOString(),
  });
}

const gateOf = (id: string) => presetById(id)!.gate;

describe('verdict propre à chaque preset', () => {
  test('VAL-001 n’exige pas six étapes sur six', () => {
    // Le cœur de la correction. Son objectif est la découverte ; exiger un
    // rapport final reviendrait à mesurer autre chose que ce qu'elle valide.
    const gate = gateOf('VAL-001-DISCOVERY');
    assert.deepEqual(gate.requiredSteps, ['discovery']);
    assert.equal(gate.requiresHumanReview, false);
  });

  test('VAL-001 telle qu’elle a réellement tourné est PASS', () => {
    // La mission M-FHPPM : 7 candidats réels, 11 preuves sourcées, aucune
    // simulée, SearXNG 3/3, 0,0662 $ sur 0,08 $. Elle remplit ses critères.
    const id = missionWith({
      discovery: 'succeeded',
      enrichment: 'cancelled',
      qualification: 'skipped',
      scoring: 'cancelled',
      ranking: 'cancelled',
      report: 'cancelled',
    });
    for (let i = 0; i < 7; i++) realCandidate(id, i);
    externalCall(id);

    const verdict = evaluatePreset({
      repos,
      missionId: id as never,
      gate: gateOf('VAL-001-DISCOVERY'),
      maxCostUsd: 0.08,
      spentUsd: 0.0662,
    });

    assert.equal(verdict.verdict, 'PASS', JSON.stringify(verdict.criteria.filter((c) => !c.met)));
  });

  test('la même mission reste PARTIAL sous la grille de bout en bout', () => {
    // La preuve que le changement porte sur les critères, pas sur les faits :
    // les mêmes données, jugées autrement, donnent un autre verdict.
    const id = missionWith({
      discovery: 'succeeded',
      enrichment: 'cancelled',
      qualification: 'skipped',
      scoring: 'cancelled',
      ranking: 'cancelled',
      report: 'cancelled',
    });
    for (let i = 0; i < 7; i++) realCandidate(id, i);
    externalCall(id);

    const verdict = evaluatePreset({
      repos,
      missionId: id as never,
      gate: DEFAULT_GATE,
      maxCostUsd: 0.08,
      spentUsd: 0.0662,
    });

    assert.equal(verdict.verdict, 'PARTIAL');
  });

  test('VAL-005 exige bien le pipeline complet', () => {
    // La seule qui valide la reproductibilité de bout en bout : elle ne peut
    // pas s'accommoder d'un rapport manquant.
    const gate = gateOf('VAL-005-END-TO-END');
    assert.deepEqual(gate.requiredSteps, STEPS);
    assert.equal(gate.requiresHumanReview, true);

    const id = missionWith({ discovery: 'succeeded', enrichment: 'cancelled' });
    realCandidate(id, 0);
    externalCall(id);

    const verdict = evaluatePreset({
      repos,
      missionId: id as never,
      gate,
      maxCostUsd: 0.45,
      spentUsd: 0.2,
    });
    assert.notEqual(verdict.verdict, 'PASS', 'un pipeline tronqué ne peut pas passer VAL-005');
  });

  test('VAL-002 accepte un arrêt budgétaire comme réussite', () => {
    // C'est précisément ce qu'elle met à l'épreuve : le plafond doit être un
    // mur, et l'atteindre proprement est le résultat attendu.
    const gate = gateOf('VAL-002-ECONOMIC-SAFETY');
    assert.equal(gate.budgetStopIsSuccess, true);
    assert.deepEqual(gate.requiredSteps, []);
  });
});

describe('le socle commun ne se contourne pas', () => {
  const permissive = { ...DEFAULT_GATE, requiredSteps: [], minCandidates: 0, minSourcedEvidence: 0, minFirsthandEvidence: 0, requiresHumanReview: false, requiresRealProvider: false };

  test('une preuve simulée disqualifie, même sous la grille la plus permissive', () => {
    const id = missionWith({ discovery: 'succeeded' });
    realCandidate(id, 0, { simulated: true });

    const verdict = evaluatePreset({
      repos,
      missionId: id as never,
      gate: permissive,
      maxCostUsd: 0.08,
      spentUsd: 0.01,
    });

    assert.equal(verdict.verdict, 'FAIL');
    assert.match(verdict.rationale, /Socle commun/);
  });

  test('un budget dépassé disqualifie', () => {
    const id = missionWith({ discovery: 'succeeded' });
    const verdict = evaluatePreset({
      repos,
      missionId: id as never,
      gate: permissive,
      maxCostUsd: 0.08,
      spentUsd: 0.09,
    });
    assert.equal(verdict.verdict, 'FAIL');
    assert.match(verdict.rationale, /budget/);
  });

  test('une donnée de première main sans source disqualifie', () => {
    // `realCandidate` produit une preuve `observed` : sans source, elle
    // prétend rapporter le monde sans que rien ne l'atteste.
    const id = missionWith({ discovery: 'succeeded' });
    realCandidate(id, 0, { sourced: false });

    const verdict = evaluatePreset({
      repos,
      missionId: id as never,
      gate: permissive,
      maxCostUsd: 0.08,
      spentUsd: 0.01,
    });
    assert.equal(verdict.verdict, 'FAIL');
    assert.match(verdict.rationale, /première main sans source/);
  });

  test('chaque critère du socle est marqué comme tel', () => {
    // Pour qu'un lecteur distingue d'un coup d'œil ce qui est négociable par
    // preset de ce qui ne l'est jamais.
    const id = missionWith({ discovery: 'succeeded' });
    const verdict = evaluatePreset({
      repos,
      missionId: id as never,
      gate: permissive,
      maxCostUsd: 0.08,
      spentUsd: 0.01,
    });

    const foundation = verdict.criteria.filter((c) => c.foundational);
    assert.equal(foundation.length, 5, 'les cinq critères du socle doivent apparaître');
    for (const c of foundation) assert.equal(c.required, true);
  });
});

describe('calibration des validations', () => {
  test('le plafond de sortie par appel est 2 500 pour toutes les validations', () => {
    // Mesuré, pas choisi : les neuf appels de VAL-001 ont produit 596 jetons en
    // moyenne, le plus long 1 298. Le défaut de 8 000 faisait réserver treize
    // fois la consommation réelle, et refusait des appels que le budget pouvait
    // financer.
    assert.equal(VALIDATION_MAX_OUTPUT_TOKENS_PER_CALL, 2500);
    for (const preset of VALIDATION_PRESETS) {
      assert.equal(
        preset.limits.maxOutputTokensPerCall,
        2500,
        `${preset.id} doit porter le plafond de sortie des validations`,
      );
    }
  });

  test('le plafond global du déploiement n’est pas touché', async () => {
    // La consigne était explicite : abaisser pour les validations, pas pour
    // toutes les missions.
    const { DEFAULT_BUDGET_LIMITS } = await import('@atlas/llm');
    assert.equal(DEFAULT_BUDGET_LIMITS.maxOutputTokensPerCall, 16_000);
  });

  test('chaque preset déclare une grille cohérente avec ses critères', () => {
    for (const preset of VALIDATION_PRESETS) {
      assert.ok(preset.gate, `${preset.id} doit porter une grille`);
      assert.ok(preset.criteria.pass.length > 0, `${preset.id} doit déclarer ses critères lisibles`);
      // Une grille qui n'exige rien du tout et accepte tout serait une case
      // vide déguisée en validation.
      const demandsSomething =
        preset.gate.requiredSteps.length > 0 ||
        preset.gate.minCandidates > 0 ||
        preset.gate.budgetStopIsSuccess;
      assert.ok(demandsSomething, `${preset.id} n'exige rien`);
    }
  });
});

/**
 * La frontière entre une inférence et une invention.
 *
 * Le socle exigeait une source sur *chaque* preuve, et VAL-002 a échoué sur une
 * inférence — « business model », dérivée de ce que les autres preuves
 * montraient. Une inférence n'a pas de source propre par construction ; c'est
 * tout ce qui la distingue d'une observation.
 *
 * Le critère a donc été précisé après ce FAIL, et ces tests existent pour que
 * la précision n'ait pas ouvert une porte : une affirmation de première main
 * sans source reste disqualifiante.
 */
describe('inférence et invention ne se confondent pas', () => {
  const permissive = {
    ...DEFAULT_GATE,
    requiredSteps: [],
    minCandidates: 0,
    minSourcedEvidence: 0,
    minFirsthandEvidence: 0,
    requiresHumanReview: false,
    requiresRealProvider: false,
  };

  /** Une preuve d'une nature donnée, avec ou sans source. */
  function evidenceOf(missionId: string, nature: 'observed' | 'reported' | 'inferred', sourced: boolean): void {
    const { company } = repos.companies.upsert({
      canonicalKey: `e-${nature}-${sourced}`,
      name: `Société ${nature}`,
      country: 'DE',
    });
    const { opportunity } = repos.opportunities.register({
      missionId,
      companyId: company.id,
      departmentKey: 'business-expansion',
      targetTypes: ['distributor'],
      discoveredBy: 'search',
    });
    repos.companies.appendEvidence({
      companyId: company.id,
      opportunityId: opportunity.id,
      missionId,
      field: nature === 'inferred' ? 'business model' : 'existence',
      claim: 'une affirmation',
      value: null,
      nature,
      sourceKey: 'searxng',
      sourceRef: sourced ? 'https://exemple.de/page' : null,
      sourceTitle: null,
      basis: nature === 'inferred' ? 'déduit des preuves collectées' : null,
      confidence: 0.7,
      simulated: false,
      collectedAt: new Date().toISOString(),
      agentKey: 'scout',
    });
  }

  const verdictFor = (id: string) =>
    evaluatePreset({ repos, missionId: id as never, gate: permissive, maxCostUsd: 0.12, spentUsd: 0.01 });

  test('une inférence sans source ne disqualifie pas', () => {
    // Le cas exact de VAL-002. Exiger une URL sur une inférence pousserait à en
    // fabriquer une — le défaut même qu'on cherche à empêcher.
    const id = missionWith({ discovery: 'succeeded' });
    evidenceOf(id, 'observed', true);
    evidenceOf(id, 'inferred', false);

    assert.notEqual(verdictFor(id).verdict, 'FAIL');
  });

  test('une observation sans source disqualifie toujours', () => {
    // Le durcissement reste entier là où il compte.
    const id = missionWith({ discovery: 'succeeded' });
    evidenceOf(id, 'observed', false);

    const verdict = verdictFor(id);
    assert.equal(verdict.verdict, 'FAIL');
    assert.match(verdict.rationale, /première main sans source/);
  });

  test('un rapport de tiers sans source disqualifie aussi', () => {
    // `reported` prétend rapporter le monde autant qu'`observed` : sans source,
    // rien ne le distingue d'une affirmation gratuite.
    const id = missionWith({ discovery: 'succeeded' });
    evidenceOf(id, 'reported', false);

    assert.equal(verdictFor(id).verdict, 'FAIL');
  });

  test('le compte des inférences reste visible dans le rapport', () => {
    // Une inférence acceptée ne doit pas devenir invisible : le lecteur doit
    // pouvoir juger sur quelle proportion de dérivé repose la conclusion.
    const id = missionWith({ discovery: 'succeeded' });
    evidenceOf(id, 'observed', true);
    evidenceOf(id, 'inferred', false);

    const criterion = verdictFor(id).criteria.find((c) => c.label.includes('première main sans source'))!;
    assert.match(criterion.observed, /inférence/);
  });
});
