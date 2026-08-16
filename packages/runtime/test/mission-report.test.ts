import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';
import { buildMissionReport, formatMissionReport } from '../src/mission-report.ts';

/**
 * Ce que le rapport a le droit de dire.
 *
 * La distinction que ces tests protègent tient en une ligne : « zéro candidat »
 * et « la recherche n'a jamais tourné » mènent à des décisions opposées, et un
 * rapport qui rend `0` dans les deux cas fait chercher un problème de marché là
 * où il y a un problème de plomberie. Les cinq missions réelles qui ont échoué
 * rapportaient exactement de cette façon.
 */

let repos: Repositories;
let dir: string;
const logger = createLogger({ level: 'error', pretty: false });

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-report-'));
  repos = createRepositories(join(dir, 'report.db'), logger);
});

after(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const newMission = (context: Record<string, unknown> = {}) =>
  repos.missions.create({
    title: 'Mission de test',
    objective: 'vérifier le rapport',
    context,
    createdBy: 'system',
  });

describe('rapport de mission', () => {
  test("une mission qui n'a rien fait ne rapporte pas des zéros", () => {
    const mission = newMission({ executionMode: 'live', budgetUsd: 0.4 });
    const report = buildMissionReport(repos, mission.id)!;

    assert.equal(report.economics.costUsd.measured, false, 'le coût doit être inconnu, pas nul');
    assert.equal(report.economics.llmCalls.measured, false);
    assert.equal(report.external.toolCalls.measured, false);

    if (!report.economics.costUsd.measured) {
      assert.match(report.economics.costUsd.reason, /aucun appel/);
    }
  });

  test('les compteurs du tunnel sont mesurables même à zéro', () => {
    // Ils sont écrits par les transitions elles-mêmes : ici, zéro veut vraiment
    // dire zéro, et le rapport doit le dire sans réserve.
    const mission = newMission({ executionMode: 'live' });
    const report = buildMissionReport(repos, mission.id)!;

    assert.equal(report.results.candidates.measured, true);
    assert.equal(report.results.funnel.measured, true);
    if (report.results.candidates.measured) assert.equal(report.results.candidates.value, 0);
  });

  test("l'absence d'appel et l'absence d'outil sont signalées avant les chiffres", () => {
    const mission = newMission({ executionMode: 'live' });
    const report = buildMissionReport(repos, mission.id)!;

    assert.ok(report.caveats.some((c) => /appel au modèle/i.test(c)));
    assert.ok(report.caveats.some((c) => /outil/i.test(c)));

    // Et la mise en forme les place en tête, pas en note de bas de page.
    const text = formatMissionReport(report);
    assert.ok(
      text.indexOf('À LIRE AVANT LES CHIFFRES') < text.indexOf('Économie'),
      'les réserves doivent précéder les chiffres',
    );
  });

  test("un mode non déclaré est une réserve, pas une supposition", () => {
    const mission = newMission({});
    const report = buildMissionReport(repos, mission.id)!;

    assert.equal(report.mode, 'unknown');
    assert.ok(report.caveats.some((c) => /mode d'exécution/i.test(c)));
  });

  test('un plafond absent ne devient pas une part consommée', () => {
    const mission = newMission({ executionMode: 'live' });
    const report = buildMissionReport(repos, mission.id)!;

    assert.equal(report.economics.budgetUsd, null);
    assert.equal(report.economics.budgetUsedRatio.measured, false);
    if (!report.economics.budgetUsedRatio.measured) {
      assert.match(report.economics.budgetUsedRatio.reason, /plafond/);
    }
  });

  test('une mission inconnue ne rend pas un rapport vide', () => {
    // Rendre une coquille remplie de zéros serait pire que ne rien rendre : on
    // la lirait comme une mission qui a tourné sans rien produire.
    assert.equal(buildMissionReport(repos, 'msn_inexistante' as never), null);
  });

  test('la durée reste inconnue tant que la mission ne s’est pas terminée', () => {
    const mission = newMission({ executionMode: 'live' });
    const report = buildMissionReport(repos, mission.id)!;
    assert.equal(report.durationMs.measured, false);
  });

  test('le texte du rapport dit « inconnu » là où il ne sait pas', () => {
    const mission = newMission({ executionMode: 'live' });
    const text = formatMissionReport(buildMissionReport(repos, mission.id)!);

    assert.match(text, /inconnu/);
    assert.ok(!/0\.0000 \$/.test(text), 'un coût inconnu ne doit jamais s’afficher comme 0,0000 $');
  });
});
