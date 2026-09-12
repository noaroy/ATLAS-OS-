import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_BATCH_DEFAULTS, clientBudgetLimits, describeClientBudgetLimits } from '../src/index.ts';

/**
 * Le preflight affichait « plafond mission 0.4 $ » — ATLAS_MAX_MISSION_COST_USD,
 * qu'un lot client n'applique pas. Ce que le preflight montre doit être ce
 * que `batch` applique : une seule fonction pour les deux.
 */
const configure = (usd: number) => ({ dailyBudgetUsd: usd, dailyBudgetMode: 'CONFIGURED' as const });
const sansPlafondJour = { dailyBudgetUsd: 0, dailyBudgetMode: 'UNLIMITED' as const };

describe('clientBudgetLimits : les plafonds que batch applique, et d’où ils viennent', () => {
  test('sans argument, les défauts de batch — et chacun dit qu’il est un défaut', () => {
    const l = clientBudgetLimits(configure(2));
    assert.equal(l.mission.usd, CLIENT_BATCH_DEFAULTS.runBudgetUsd);
    assert.equal(l.mission.source, 'défaut --budget');
    assert.equal(l.batch.usd, CLIENT_BATCH_DEFAULTS.batchBudgetUsd);
    assert.equal(l.batch.source, 'défaut --batch-budget');
    assert.equal(l.daily.usd, 2);
    assert.equal(l.daily.configured, true);
    assert.equal(l.daily.source, 'ATLAS_AI_DAILY_BUDGET_USD');
  });

  test('les défauts sont ceux documentés : 1,00 $ mission, 0,40 $ lot, 20 candidats, 8 requêtes', () => {
    assert.equal(CLIENT_BATCH_DEFAULTS.runBudgetUsd, 1.0);
    assert.equal(CLIENT_BATCH_DEFAULTS.batchBudgetUsd, 0.4);
    assert.equal(CLIENT_BATCH_DEFAULTS.batchSize, 20);
    assert.equal(CLIENT_BATCH_DEFAULTS.maxQueries, 8);
  });

  test('--budget et --batch-budget passés en argument sont appliqués tels quels, et nommés comme tels', () => {
    const l = clientBudgetLimits(configure(2), { budget: '3.00', batchBudget: '0.25' });
    assert.equal(l.mission.usd, 3);
    assert.equal(l.mission.source, '--budget');
    assert.equal(l.batch.usd, 0.25);
    assert.equal(l.batch.source, '--batch-budget');
  });

  test('un seul argument explicite laisse l’autre à son défaut', () => {
    const l = clientBudgetLimits(configure(2), { budget: '3' });
    assert.equal(l.mission.source, '--budget');
    assert.equal(l.batch.usd, CLIENT_BATCH_DEFAULTS.batchBudgetUsd);
    assert.equal(l.batch.source, 'défaut --batch-budget');
  });

  test('sans ATLAS_AI_DAILY_BUDGET_USD : plafond quotidien 0, marqué non configuré — jamais un faux plafond', () => {
    const l = clientBudgetLimits(sansPlafondJour);
    assert.equal(l.daily.usd, 0);
    assert.equal(l.daily.configured, false);
  });

  test('ATLAS_MAX_MISSION_COST_USD n’entre pas dans le calcul', () => {
    // La fonction ne reçoit que la configuration `ai` : la valeur du ledger
    // ne peut pas s'y glisser. Le contrat est dans la signature.
    const l = clientBudgetLimits({ ...configure(2), maxMissionCostUsd: 0.4 } as never);
    assert.equal(l.mission.usd, CLIENT_BATCH_DEFAULTS.runBudgetUsd);
  });

  test('un plafond illisible ou négatif est refusé — NaN ne borne rien', () => {
    assert.throws(() => clientBudgetLimits(configure(2), { budget: 'abc' }), /--budget=abc/);
    assert.throws(() => clientBudgetLimits(configure(2), { batchBudget: '-1' }), /--batch-budget=-1/);
  });
});

describe('describeClientBudgetLimits : les trois lignes du preflight', () => {
  test('mission, lot, jour — avec la valeur et sa provenance', () => {
    const lignes = describeClientBudgetLimits(clientBudgetLimits(configure(2)));
    assert.deepEqual(lignes, [
      'mission : 1.00 $ (défaut --budget)',
      'lot     : 0.40 $ (défaut --batch-budget)',
      'jour    : 2.00 $ (ATLAS_AI_DAILY_BUDGET_USD)',
    ]);
  });

  test('avec des arguments, la provenance change avec la valeur', () => {
    const lignes = describeClientBudgetLimits(clientBudgetLimits(configure(3), { budget: '3.00', batchBudget: '0.40' }));
    assert.equal(lignes[0], 'mission : 3.00 $ (--budget)');
    assert.equal(lignes[1], 'lot     : 0.40 $ (--batch-budget)');
    assert.equal(lignes[2], 'jour    : 3.00 $ (ATLAS_AI_DAILY_BUDGET_USD)');
  });

  test('sans plafond quotidien, la ligne le dit plutôt que d’afficher 0,00 $', () => {
    const lignes = describeClientBudgetLimits(clientBudgetLimits(sansPlafondJour));
    assert.match(lignes[2]!, /non configuré/);
    assert.match(lignes[2]!, /ATLAS_AI_DAILY_BUDGET_USD/);
  });

  test('aucune ligne ne mentionne le plafond du ledger', () => {
    const texte = describeClientBudgetLimits(clientBudgetLimits(configure(2))).join('\n');
    assert.doesNotMatch(texte, /MAX_MISSION_COST|0\.40 \$ \(défaut --budget\)/);
  });
});
