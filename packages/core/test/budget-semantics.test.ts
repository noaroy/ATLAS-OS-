import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkBudget } from '../src/index.ts';

/**
 * Les six cas où zéro et l'inconnu se ressemblent.
 *
 * Toute la sûreté financière d'ATLAS tient à ce que ces deux valeurs ne se
 * confondent jamais. Un plafond de 0 $ veut dire « ne dépense rien » ; un coût
 * inconnu veut dire « je ne peux pas te dire ce que ça coûte ». Les deux se
 * représentent volontiers par le même chiffre en JavaScript, et c'est ainsi
 * qu'un garde-fou budgétaire devient décoratif : il additionne des zéros, se
 * trouve sous le plafond, et laisse passer.
 */

describe('la sémantique du budget', () => {
  test('DISABLED refuse tout, y compris un appel gratuit', () => {
    const verdict = checkBudget({ mode: 'DISABLED', taskCostUsd: 0 });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.mode, 'DISABLED');
  });

  test('UNLIMITED autorise sans vérifier de plafond', () => {
    const verdict = checkBudget({ mode: 'UNLIMITED', taskCostUsd: 999 });
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.mode, 'UNLIMITED');
  });

  test('CONFIGURED à 0 $ refuse toute dépense positive', () => {
    // 0 comme plafond n'est pas « pas de plafond » : c'est le plafond le plus
    // strict qui soit. Le traiter comme absent rendrait DISABLED inutile.
    const verdict = checkBudget({
      mode: 'CONFIGURED', taskCostUsd: 0.0001, maxTaskCostUsd: 0,
    });
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason, /plafond par tâche 0/);
  });

  test('CONFIGURED à 0 $ laisse passer un appel réellement gratuit', () => {
    const verdict = checkBudget({
      mode: 'CONFIGURED', taskCostUsd: 0, maxTaskCostUsd: 0,
    });
    assert.equal(verdict.allowed, true);
  });

  test('CONFIGURED positif autorise sous le plafond, refuse au-dessus', () => {
    const dessous = checkBudget({
      mode: 'CONFIGURED', taskCostUsd: 0.5, maxTaskCostUsd: 1,
      dailySpentUsd: 0, dailyLimitUsd: 10,
    });
    assert.equal(dessous.allowed, true);

    const dessus = checkBudget({
      mode: 'CONFIGURED', taskCostUsd: 2, maxTaskCostUsd: 1,
    });
    assert.equal(dessus.allowed, false);
  });

  test('un tarif inconnu sous plafond actif refuse au lieu de compter zéro', () => {
    // Le défaut corrigé : `taskCostUsd ?? 0` rendait « sous les plafonds »
    // pour un appel dont personne ne pouvait chiffrer la dépense.
    const verdict = checkBudget({
      mode: 'CONFIGURED', taskCostUsd: null, maxTaskCostUsd: 5,
      dailySpentUsd: 0, dailyLimitUsd: 10,
    });
    assert.equal(verdict.allowed, false, 'un coût inconnu ne passe pas pour nul');
    assert.match(verdict.reason, /inconnu/);
  });

  test('un tarif inconnu sans aucun plafond ne bloque rien', () => {
    // Sans plafond il n'y a rien à vérifier : refuser serait un blocage gratuit.
    const verdict = checkBudget({ mode: 'CONFIGURED', taskCostUsd: null });
    assert.equal(verdict.allowed, true);
  });

  test('un tarif connu dépasse le plafond journalier cumulé', () => {
    const verdict = checkBudget({
      mode: 'CONFIGURED', taskCostUsd: 1,
      dailySpentUsd: 9.5, dailyLimitUsd: 10,
    });
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason, /journalier/);
  });

  test('un coût absent n’est pas un coût inconnu', () => {
    // `undefined` : aucun coût de tâche n'est soumis à la vérification.
    // `null` : un coût existe mais reste inchiffrable. Seul le second bloque.
    const absent = checkBudget({ mode: 'CONFIGURED', maxTaskCostUsd: 5 });
    assert.equal(absent.allowed, true);

    const inconnu = checkBudget({ mode: 'CONFIGURED', taskCostUsd: null, maxTaskCostUsd: 5 });
    assert.equal(inconnu.allowed, false);
  });
});
