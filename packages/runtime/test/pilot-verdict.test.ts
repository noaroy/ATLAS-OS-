import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';
import { evaluatePilot } from '../src/pilot-verdict.ts';

/**
 * Ce qu'un pilote a le droit d'appeler une réussite.
 *
 * Le test central de ce fichier est celui de LIVE-001 : trois candidats réels,
 * trois preuves sourcées, budget tenu — et **PARTIAL**, parce que cinq étapes
 * sur six n'ont jamais tourné. L'ancien verdict rendait PASS sur ces trois
 * seuls chiffres, ce qui revenait à mesurer une chaîne de six maillons en
 * regardant le premier.
 */

const logger = createLogger({ level: 'error', pretty: false });
let repos: Repositories;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-verdict-'));
  repos = createRepositories(join(dir, 'verdict.db'), logger);
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const STEPS = ['discovery', 'enrichment', 'qualification', 'scoring', 'ranking', 'report'];

/** Une mission dont chaque étape porte le statut que le test décide. */
function missionWith(statuses: Record<string, string>): string {
  const mission = repos.missions.create({
    title: 'LIVE PILOT test',
    objective: 'o'.repeat(40),
    context: { budgetUsd: 0.4, executionMode: 'live' },
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

/** Un candidat réel, avec sa preuve sourcée. */
function realCandidate(missionId: string, index: number, options: { simulated?: boolean } = {}): void {
  const { company } = repos.companies.upsert({
    canonicalKey: `distributor-${index}-de`,
    name: `Distributor ${index} GmbH`,
    legalName: `Distributor ${index} GmbH`,
    country: 'DE',
    website: `https://distributor-${index}.de`,
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
    claim: 'distribue des machines d’emballage',
    value: null,
    nature: 'observed',
    sourceKey: 'duckduckgo',
    sourceRef: `https://distributor-${index}.de/about`,
    sourceTitle: 'À propos',
    basis: 'page consultée',
    confidence: 0.8,
    simulated: options.simulated ?? false,
    collectedAt: new Date().toISOString(),
    agentKey: 'scout',
  });
}

const allSucceeded = Object.fromEntries(STEPS.map((s) => [s, 'succeeded']));

describe('verdict du pilote', () => {
  test('LIVE-001 rend PARTIAL, pas PASS', () => {
    // Le cas exact : découverte réussie, enrichissement annulé par une garde,
    // le reste sauté. Trois candidats sourcés ne rachètent pas cinq étapes
    // qui n'ont pas tourné.
    const id = missionWith({
      discovery: 'succeeded',
      enrichment: 'cancelled',
      qualification: 'skipped',
      scoring: 'cancelled',
      ranking: 'cancelled',
      report: 'cancelled',
    });
    for (let i = 0; i < 3; i++) realCandidate(id, i);

    const report = evaluatePilot({ repos, missionId: id as never, maxCostUsd: 0.4, spentUsd: 0.0652 });

    assert.equal(report.verdict, 'PARTIAL');
    assert.match(report.rationale, /arrêtée ensuite/);
    assert.equal(report.incompleteSteps.length, 5);
  });

  test('découvrir ne suffit jamais à conclure', () => {
    // La règle en une ligne : PASS ne peut pas venir de la première étape
    // d'une chaîne de six.
    const id = missionWith({ discovery: 'succeeded' });
    for (let i = 0; i < 10; i++) realCandidate(id, i);

    const report = evaluatePilot({ repos, missionId: id as never, maxCostUsd: 0.4, spentUsd: 0.01 });
    assert.notEqual(report.verdict, 'PASS');
  });

  test('un pipeline complet avec opportunités rend PASS', () => {
    const id = missionWith(allSucceeded);
    for (let i = 0; i < 3; i++) realCandidate(id, i);
    for (const opp of repos.opportunities.forMission(id)) {
      repos.opportunities.setStage(opp.id, 'shortlisted');
    }

    const report = evaluatePilot({ repos, missionId: id as never, maxCostUsd: 0.4, spentUsd: 0.2 });
    assert.equal(report.verdict, 'PASS', JSON.stringify(report.criteria.filter((c) => !c.met)));
  });

  test('un pipeline complet sans opportunité retenue rend PASS aussi', () => {
    // Explicitement demandé, et c'est la bonne règle : forcer une opportunité
    // pour faire passer un test reviendrait à fabriquer le résultat mesuré.
    // La conclusion « aucune ne convient » est un résultat, si elle est étayée.
    const id = missionWith(allSucceeded);
    realCandidate(id, 0);

    const report = evaluatePilot({ repos, missionId: id as never, maxCostUsd: 0.4, spentUsd: 0.2 });

    assert.equal(report.verdict, 'PASS');
    assert.match(report.rationale, /Aucune opportunité retenue/);
    const proposed = report.criteria.find((c) => c.label.includes('opportunité proposée'))!;
    assert.equal(proposed.met, false);
    assert.equal(proposed.required, false, 'ce critère ne doit jamais bloquer un PASS');
  });

  test('une preuve simulée disqualifie tout', () => {
    // Elle rend le reste invérifiable : le volume de preuves réelles ne
    // compense pas une preuve fabriquée présentée comme réelle.
    const id = missionWith(allSucceeded);
    realCandidate(id, 0);
    realCandidate(id, 1, { simulated: true });

    const report = evaluatePilot({ repos, missionId: id as never, maxCostUsd: 0.4, spentUsd: 0.1 });

    assert.equal(report.verdict, 'FAIL');
    assert.match(report.rationale, /simulées/);
  });

  test('un budget dépassé empêche PASS', () => {
    const id = missionWith(allSucceeded);
    realCandidate(id, 0);

    const report = evaluatePilot({ repos, missionId: id as never, maxCostUsd: 0.4, spentUsd: 0.55 });

    assert.notEqual(report.verdict, 'PASS');
    assert.equal(report.criteria.find((c) => c.label === 'budget respecté')?.met, false);
  });

  test('une découverte qui n’aboutit pas rend BLOCKED', () => {
    // Rien n'a pu être collecté : ce n'est pas un échec métier, c'est un
    // blocage technique, et les deux appellent des gestes différents.
    const id = missionWith({ discovery: 'failed' });

    const report = evaluatePilot({ repos, missionId: id as never, maxCostUsd: 0.4, spentUsd: 0.01 });
    assert.equal(report.verdict, 'BLOCKED');
  });

  test('chaque critère porte la valeur observée', () => {
    // Un verdict qu'on ne peut pas vérifier sans relire le code n'est pas un
    // verdict, c'est une affirmation.
    const id = missionWith({ discovery: 'succeeded' });
    realCandidate(id, 0);

    const report = evaluatePilot({ repos, missionId: id as never, maxCostUsd: 0.4, spentUsd: 0.02 });

    for (const criterion of report.criteria) {
      assert.ok(criterion.observed.length > 0, `${criterion.label} n'affiche rien`);
    }
    assert.match(
      report.criteria.find((c) => c.label === 'budget respecté')!.observed,
      /0\.0200 \$ sur 0\.40 \$/,
    );
  });
});
