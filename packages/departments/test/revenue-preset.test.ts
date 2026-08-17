import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  REVENUE_001,
  meetsQualityBar,
  whyBelowBar,
  shouldStopEarly,
  type ProspectQuality,
} from '../src/revenue-preset.ts';

/**
 * La règle économique du premier produit.
 *
 * Trois validations de suite se sont arrêtées faute de budget, jamais faute de
 * besoin — aucune n'avait de raison de s'arrêter avant. Une mission qui ne sait
 * pas reconnaître qu'elle a fini dépense jusqu'au mur, et le mur arrive
 * toujours au pire moment : au milieu de la qualification, quand tout ce qui
 * précède est payé et pas encore exploitable.
 *
 * Tout est vérifié hors ligne. La règle d'arrêt d'une mission payante ne doit
 * pas coûter une mission payante pour être éprouvée.
 */

const good = (n: number): ProspectQuality[] =>
  Array.from({ length: n }, (_, i) => ({
    opportunityId: `opp_${i}`,
    score: 78,
    firsthandEvidence: 3,
    qualified: true,
  }));

describe('la barre de qualité', () => {
  test('un prospect solide la franchit', () => {
    assert.equal(
      meetsQualityBar(
        { opportunityId: 'o', score: 72, firsthandEvidence: 2, qualified: true },
        REVENUE_001.qualityBar,
      ),
      true,
    );
  });

  test('un score élevé sur une seule source ne suffit pas', () => {
    // Une source unique ne se contredit jamais elle-même : un score bâti
    // dessus est une opinion bien notée, pas un fait corroboré.
    const prospect = { opportunityId: 'o', score: 95, firsthandEvidence: 1, qualified: true };
    assert.equal(meetsQualityBar(prospect, REVENUE_001.qualityBar), false);
    assert.deepEqual(whyBelowBar(prospect, REVENUE_001.qualityBar), [
      '1 preuve(s) de première main < 2',
    ]);
  });

  test('un prospect non qualifié ne se livre pas, si bien noté soit-il', () => {
    const prospect = { opportunityId: 'o', score: 99, firsthandEvidence: 5, qualified: false };
    assert.equal(meetsQualityBar(prospect, REVENUE_001.qualityBar), false);
    assert.deepEqual(whyBelowBar(prospect, REVENUE_001.qualityBar), ['non qualifié']);
  });

  test('un score non mesuré n’est pas un score bas', () => {
    // Les deux mènent au même refus, mais ne disent pas la même chose — et
    // cette distinction se retrouve dans le livrable remis au client.
    const prospect = { opportunityId: 'o', score: null, firsthandEvidence: 4, qualified: true };
    assert.equal(meetsQualityBar(prospect, REVENUE_001.qualityBar), false);
    assert.deepEqual(whyBelowBar(prospect, REVENUE_001.qualityBar), ['score non mesuré']);
  });
});

describe('l’arrêt anticipé', () => {
  test('trois prospects au niveau attendu suffisent à s’arrêter', () => {
    const decision = shouldStopEarly(good(3), REVENUE_001, 5);
    assert.equal(decision.stop, true);
    assert.equal(decision.reason, 'enough-quality');
    assert.equal(decision.qualifying, 3);
  });

  test('deux ne suffisent pas tant qu’il reste des candidats', () => {
    const decision = shouldStopEarly(good(2), REVENUE_001, 4);
    assert.equal(decision.stop, false);
    assert.equal(decision.qualifying, 2);
    assert.match(decision.explanation, /2\/3/);
  });

  test('le pack visé atteint arrête aussi', () => {
    const decision = shouldStopEarly(good(5), REVENUE_001, 3);
    assert.equal(decision.stop, true);
    assert.equal(decision.reason, 'target-reached');
  });

  test('vingt prospects médiocres n’arrêtent rien', () => {
    // Le cœur du preset : ce n'est pas le nombre qui décide, c'est le niveau.
    // Vingt candidats sous la barre laissent le livrable vide.
    const mediocre: ProspectQuality[] = Array.from({ length: 20 }, (_, i) => ({
      opportunityId: `opp_${i}`,
      score: 55,
      firsthandEvidence: 1,
      qualified: true,
    }));
    const decision = shouldStopEarly(mediocre, REVENUE_001, 2);
    assert.equal(decision.stop, false);
    assert.equal(decision.qualifying, 0);
  });

  test('sans candidat restant, on s’arrête même en dessous du compte', () => {
    const decision = shouldStopEarly(good(1), REVENUE_001, 0);
    assert.equal(decision.stop, true);
    assert.equal(decision.reason, 'candidates-exhausted');
    // Et l'explication dit franchement que le livrable est incomplet, plutôt
    // que de présenter un arrêt par épuisement comme une réussite.
    assert.match(decision.explanation, /en dessous des 3 requis/);
  });

  test('la dépense ne se poursuit jamais pour atteindre un nombre rond', () => {
    // La formulation directe de l'exigence : à qualité égale, passer de trois
    // bons prospects à quatre n'est pas une raison de continuer à payer.
    const stopped = shouldStopEarly(good(3), REVENUE_001, 99);
    assert.equal(stopped.stop, true, 'trois bons prospects et 99 candidats restants : on arrête');
  });
});

describe('les bornes du preset', () => {
  test('le budget est de 0,12 $ et le modèle n’est pas le plus cher', () => {
    assert.equal(REVENUE_001.limits.maxCostUsd, 0.12);
    assert.equal(REVENUE_001.context.budgetUsd, 0.12);
    assert.match(REVENUE_001.limits.model, /haiku/);
  });

  test('on n’analyse pas plus de candidats qu’on n’en livrera', () => {
    // Analyser au-delà du pack coûterait pour des lignes qui ne seront pas
    // remises au client.
    assert.equal(REVENUE_001.limits.maxAnalyzedCandidates, REVENUE_001.targetProspects);
  });

  test('la découverte garde une marge de tri', () => {
    assert.ok(
      REVENUE_001.limits.maxCandidates > REVENUE_001.targetProspects,
      'sans marge, écarter un candidat faible rendrait le pack court',
    );
  });

  test('le plafond de sortie par appel reste à 2 500', () => {
    assert.equal(REVENUE_001.limits.maxOutputTokensPerCall, 2500);
  });

  test('le pipeline va de la découverte à l’export client', () => {
    assert.deepEqual(REVENUE_001.steps, [
      'discovery',
      'enrichment',
      'qualification',
      'scoring',
      'ranking',
      'export',
    ]);
  });
});
