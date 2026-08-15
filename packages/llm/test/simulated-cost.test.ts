import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { costOfCall, pricingFor, worstCaseCostUsd, isSimulatedModel } from '@atlas/llm';

/**
 * Un appel simulé ne coûte rien, et rien ne doit lui en faire coûter.
 *
 * Le provider de simulation nomme son modèle « claude-sonnet-5 (simulation) »
 * pour que les journaux disent sur quoi la mission a tourné. La résolution de
 * tarif par préfixe y reconnaissait un vrai Sonnet : la mission de
 * démonstration affichait 1,07 $ pour 240 000 jetons qui n'avaient jamais
 * quitté la machine.
 *
 * Le tableau de bord faux n'était que la moitié du problème. Cette somme
 * fictive était aussi décomptée du plafond de mission — une démonstration un
 * peu longue se serait arrêtée pour épuisement d'un budget jamais entamé, et le
 * message d'arrêt aurait été parfaitement crédible.
 */

const USAGE = {
  inputTokens: 216_030,
  outputTokens: 23_843,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

describe('coût des appels simulés', () => {
  test('un modèle simulé est reconnu comme tel', () => {
    assert.ok(isSimulatedModel('claude-sonnet-5 (simulation)'));
    assert.ok(isSimulatedModel('claude-opus-5 (simulation)'));
    assert.ok(!isSimulatedModel('claude-sonnet-5'));
    assert.ok(!isSimulatedModel('claude-opus-5'));
  });

  test('la consommation simulée est facturée zéro', () => {
    assert.equal(costOfCall(USAGE, 'claude-sonnet-5 (simulation)'), 0);
    assert.equal(costOfCall(USAGE, 'claude-opus-5 (simulation)'), 0);
  });

  test("le même volume sur le vrai modèle coûte, lui, quelque chose", () => {
    const real = costOfCall(USAGE, 'claude-sonnet-5');
    assert.ok(real !== null && real > 0, 'sans quoi le test précédent ne prouverait rien');
  });

  test('le plafond avant appel ne réserve rien pour un appel simulé', () => {
    // C'est ce chemin-là qui refusait des appels : le budget était consommé
    // par une réservation calculée sur un tarif qui ne s'appliquait pas.
    const reserved = worstCaseCostUsd('claude-opus-5 (simulation)', 120_000, 16_000);
    assert.equal(reserved, 0);

    const realReserved = worstCaseCostUsd('claude-opus-5', 120_000, 16_000);
    assert.ok(realReserved !== null && realReserved > 0);
  });

  test('un tarif nul reste un tarif, pas une absence de tarif', () => {
    // La nuance compte : `null` veut dire « modèle inconnu, coût inchiffrable »,
    // et le registre traite les deux différemment.
    const pricing = pricingFor('claude-sonnet-5 (simulation)');
    assert.notEqual(pricing, null);
    assert.deepEqual(pricing, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});
