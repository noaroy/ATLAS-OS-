import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError, assertTimeoutHierarchy, checkTimeoutHierarchy } from '@atlas/core';

/**
 * Cohérence des délais emboîtés.
 *
 * LIVE #003 s'est arrêtée sur une seule incohérence : le délai d'outil valait
 * 120 s et le délai fournisseur 180 s. Comme l'outil *enveloppe* l'appel, la
 * borne extérieure était la plus serrée — le délai fournisseur ne pouvait
 * jamais s'exprimer, et toute recherche web dépassant deux minutes était tuée.
 *
 * Rien dans les journaux ne désignait la cause ; il a fallu la déduire après
 * coup, pour 0,38 $. Une configuration impossible doit se voir au démarrage.
 */

const base = {
  maxConcurrentMissions: 3,
  maxConcurrentTasks: 4,
  taskMaxAttempts: 3,
  missionTokenBudget: 400_000,
  maxReplansPerMission: 0,
};

const timeouts = (
  providerTimeoutMs: number,
  toolTimeoutMs: number,
  taskTimeoutMs: number,
  missionTimeoutMs: number,
) => ({ ...base, providerTimeoutMs, toolTimeoutMs, taskTimeoutMs, missionTimeoutMs });

describe('une hiérarchie valide passe', () => {
  test('la configuration de LIVE #004 est acceptée', () => {
    // fournisseur 180 s < outil 300 s < étape 360 s < mission 900 s
    const violations = checkTimeoutHierarchy(timeouts(180_000, 300_000, 360_000, 900_000));
    assert.deepEqual(violations, []);
  });

  test('la configuration de LIVE #005 est acceptée', () => {
    // 420 < 480 < 540 < 1200 s. LIVE #004 a mesuré deux fois qu'une recherche
    // web dépasse 180 s ; 420 s lui laisse une marge réelle plutôt qu'un pari.
    const violations = checkTimeoutHierarchy(timeouts(420_000, 480_000, 540_000, 1_200_000));
    assert.deepEqual(violations, []);
  });

  test('une borne de mission désactivée ne casse rien', () => {
    // 0 vaut « pas de borne » : il n'y a rien à comparer.
    assert.deepEqual(checkTimeoutHierarchy(timeouts(180_000, 300_000, 360_000, 0)), []);
  });

  test('assertTimeoutHierarchy ne lève pas sur une configuration saine', () => {
    assert.doesNotThrow(() => assertTimeoutHierarchy(timeouts(60_000, 120_000, 180_000, 600_000)));
  });
});

describe('une hiérarchie impossible est refusée', () => {
  test('outil ≤ fournisseur : exactement la configuration de LIVE #003', () => {
    const violations = checkTimeoutHierarchy(timeouts(180_000, 120_000, 300_000, 900_000));

    assert.equal(violations.length, 1);
    assert.equal(violations[0]!.inner, 'ATLAS_PROVIDER_TIMEOUT_MS');
    assert.equal(violations[0]!.outer, 'ATLAS_TOOL_TIMEOUT_MS');
    // Le message doit nommer le coupable et dire quoi faire, pas seulement
    // signaler qu'il y a un problème.
    assert.match(violations[0]!.message, /ATLAS_TOOL_TIMEOUT_MS=120000/);
    assert.match(violations[0]!.message, /ATLAS_PROVIDER_TIMEOUT_MS=180000/);
    assert.match(violations[0]!.message, /strictement supérieure à 180000/);
  });

  test('ATLAS refuse de démarrer, avec une erreur qui explique', () => {
    assert.throws(
      () => assertTimeoutHierarchy(timeouts(180_000, 120_000, 300_000, 900_000)),
      (err: unknown) =>
        err instanceof AtlasError &&
        err.code === 'BAD_REQUEST' &&
        /refuse de démarrer/.test(err.message) &&
        /ATLAS_TOOL_TIMEOUT_MS/.test(err.message),
    );
  });

  test('l’égalité est refusée autant que l’inversion', () => {
    // Deux bornes qui expirent au même instant produisent une course dont
    // l'issue dépend de l'ordonnanceur — donc un diagnostic différent d'une
    // exécution à l'autre.
    const violations = checkTimeoutHierarchy(timeouts(180_000, 180_000, 300_000, 900_000));
    assert.equal(violations.length, 1);
    assert.match(violations[0]!.message, /égale à/);
  });

  test('une étape plus courte que ses outils est refusée', () => {
    const violations = checkTimeoutHierarchy(timeouts(60_000, 300_000, 120_000, 900_000));
    assert.ok(violations.some((v) => v.outer === 'ATLAS_TASK_TIMEOUT_MS'));
  });

  test('une mission plus courte que ses étapes est refusée', () => {
    const violations = checkTimeoutHierarchy(timeouts(60_000, 120_000, 300_000, 200_000));
    assert.ok(violations.some((v) => v.outer === 'ATLAS_MISSION_TIMEOUT_MS'));
  });

  test('plusieurs inversions sont toutes rapportées', () => {
    // Corriger une seule ligne pour découvrir la suivante au redémarrage
    // suivant serait une perte de temps évitable.
    const violations = checkTimeoutHierarchy(timeouts(300_000, 200_000, 100_000, 50_000));
    assert.equal(violations.length, 3);
  });
});
