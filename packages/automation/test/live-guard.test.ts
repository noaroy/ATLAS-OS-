import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AtlasConfig } from '@atlas/core';
import { guardLiveAutomation, type LiveAutomationRequest } from '../src/live-guard.ts';

/**
 * Ce qu'une mission planifiée doit prouver avant de dépenser.
 *
 * Une mission lancée à la main a quelqu'un devant l'écran. Une mission planifiée
 * n'en a pas : elle part à trois heures du matin, et si elle échoue mal, elle
 * recommence le lendemain à la même heure. C'est le seul endroit du système où
 * une erreur se répète toute seule — d'où un contrôle plus strict, et une
 * position par défaut sans ambiguïté.
 */

const config = (overrides: Record<string, unknown> = {}): AtlasConfig =>
  ({
    llm: { declaredMode: 'live', ...(overrides.llm as object) },
    budget: { maxMissionCostUsd: 0.4, ...(overrides.budget as object) },
  }) as unknown as AtlasConfig;

const request = (overrides: Partial<LiveAutomationRequest> = {}): LiveAutomationRequest => ({
  missionKey: 'live-pilot-001',
  budgetUsd: 0.4,
  searchHealth: 'healthy',
  searchSuitability: 'suitable',
  limitsDeclared: true,
  ...overrides,
});

describe('garde des missions planifiées', () => {
  test('tout déclaré et sain : autorisé', () => {
    const verdict = guardLiveAutomation(config(), request());
    assert.equal(verdict.allowed, true, verdict.refusals.join(' · '));
  });

  test('un mode déduit est refusé', () => {
    // Une planification qui bascule en réel parce qu'une clé traînait dans la
    // configuration est exactement le scénario qu'on refuse.
    const verdict = guardLiveAutomation(config({ llm: { declaredMode: 'auto' } }), request());
    assert.equal(verdict.allowed, false);
    assert.ok(verdict.refusals.some((r) => r.includes('déclaré')));
  });

  test('aucun budget : refusé', () => {
    for (const budgetUsd of [null, 0, -1, Number.NaN]) {
      const verdict = guardLiveAutomation(config(), request({ budgetUsd }));
      assert.equal(verdict.allowed, false, `budget ${String(budgetUsd)} accepté`);
    }
  });

  test('un budget supérieur au cadre du déploiement est refusé', () => {
    // La contrainte est à sens unique : une planification peut resserrer, jamais
    // s'octroyer davantage.
    const verdict = guardLiveAutomation(config(), request({ budgetUsd: 5 }));
    assert.equal(verdict.allowed, false);
    assert.ok(verdict.refusals.some((r) => r.includes('supérieur')));
  });

  test('un moteur non sain est refusé', () => {
    for (const searchHealth of ['unhealthy', 'unknown'] as const) {
      const verdict = guardLiveAutomation(config(), request({ searchHealth }));
      assert.equal(verdict.allowed, false, `santé « ${searchHealth} » acceptée`);
    }
  });

  test('un moteur sain mais inadapté est refusé', () => {
    // Le cas qui a coûté une mission : Marginalia répondait parfaitement et ne
    // couvrait pas le marché. Automatiser cela programmerait une dépense
    // inutile récurrente.
    const verdict = guardLiveAutomation(config(), request({ searchSuitability: 'unsuitable' }));
    assert.equal(verdict.allowed, false);
    assert.ok(verdict.refusals.some((r) => r.includes('couvre pas')));
  });

  test('une adéquation partielle passe, avec ses limites connues', () => {
    const verdict = guardLiveAutomation(config(), request({ searchSuitability: 'degraded' }));
    assert.equal(verdict.allowed, true, verdict.refusals.join(' · '));
  });

  test('une adéquation non évaluée est refusée', () => {
    // Ne pas savoir n'est pas la même chose que savoir que c'est bon.
    const verdict = guardLiveAutomation(config(), request({ searchSuitability: null }));
    assert.equal(verdict.allowed, false);
  });

  test('une mission non autorisée est refusée', () => {
    const verdict = guardLiveAutomation(config(), request({ missionKey: 'quelque-chose-dautre' }));
    assert.equal(verdict.allowed, false);
    assert.ok(verdict.refusals.some((r) => r.includes('autorisée')));
  });

  test('des bornes non déclarées sont refusées', () => {
    const verdict = guardLiveAutomation(config(), request({ limitsDeclared: false }));
    assert.equal(verdict.allowed, false);
  });

  test('chaque refus est nommé', () => {
    // Un refus muet ne se corrige pas : celui qui configure doit savoir quoi
    // changer sans relire le code.
    const verdict = guardLiveAutomation(
      config({ llm: { declaredMode: 'simulation' } }),
      request({ budgetUsd: null, searchHealth: 'unhealthy', searchSuitability: null, limitsDeclared: false, missionKey: null }),
    );
    assert.equal(verdict.allowed, false);
    assert.ok(verdict.refusals.length >= 5, `seulement ${verdict.refusals.length} motif(s)`);
    for (const refusal of verdict.refusals) assert.ok(refusal.length > 10);
  });
});
