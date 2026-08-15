import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError } from '@atlas/core';
import {
  BudgetLedger,
  BudgetedProvider,
  DEFAULT_BUDGET_LIMITS,
  costOfCall,
  estimateInputTokens,
  userText,
  type BudgetLimits,
  type LlmCallRecord,
  type LlmRequest,
} from '@atlas/llm';
import { ScriptedProvider } from '@atlas/testing';

/**
 * La sûreté économique.
 *
 * LIVE #001 avait un plafond de 400 000 jetons et en a consommé 1 524 676 —
 * 281 % de dépassement — parce que le plafond n'était consulté qu'entre les
 * étapes. Ces tests vérifient le déplacement qui corrige cela : la décision est
 * prise avant chaque appel, pas entre deux étapes.
 */

const MISSION = 'msn_test';

function requestFor(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'claude-sonnet-5',
    system: 'système',
    messages: [userText('bonjour')],
    maxTokens: 4000,
    meta: { missionId: MISSION, taskRef: 'discovery', agentKey: 'explorer', purpose: 'agent-step' },
    ...overrides,
  };
}

const limits = (overrides: Partial<BudgetLimits> = {}): BudgetLimits => ({
  ...DEFAULT_BUDGET_LIMITS,
  maxMissionCostUsd: 0,
  maxStepTokens: 0,
  maxCallsPerStep: 0,
  circuitBreakerFailures: 0,
  ...overrides,
});

let ledger: BudgetLedger;
let recorded: LlmCallRecord[];

beforeEach(() => {
  recorded = [];
  ledger = new BudgetLedger((record) => recorded.push(record));
});

describe('autorisation avant dépense', () => {
  test('un appel qui ne tient pas dans le budget restant est refusé avant de partir', () => {
    ledger.open(MISSION, limits({ maxMissionTokens: 5000 }));

    // Le pire cas — entrée estimée plus sortie pleine — dépasse déjà le
    // plafond : l'appel ne doit jamais atteindre le réseau.
    assert.throws(
      () => ledger.authorise(requestFor({ maxTokens: 100_000 })),
      (err: unknown) =>
        err instanceof AtlasError &&
        err.code === 'BUDGET_EXCEEDED' &&
        err.retryable === false,
      'un refus budgétaire ne se réessaie pas : le retry coûterait ce que le refus évite',
    );
  });

  test('le refus raisonne sur le pire cas, pas sur une consommation moyenne', () => {
    // 3 000 jetons restants, sortie plafonnée à 4 000 : refusé. Un plafond
    // calculé sur une moyenne serait dépassé une fois sur deux.
    ledger.open(MISSION, limits({ maxMissionTokens: 3000 }));
    assert.throws(() => ledger.authorise(requestFor({ maxTokens: 4000 })), /Budget de mission/);
  });

  test('un budget confortable laisse passer', () => {
    ledger.open(MISSION, limits({ maxMissionTokens: 1_000_000 }));
    assert.doesNotThrow(() => ledger.authorise(requestFor()));
  });

  test('une mission hors périmètre n’est pas plafonnée', () => {
    // Aucun `open` : les appels hors mission (santé, outillage) ne dépendent
    // pas d'un budget qui n'a pas de sens pour eux.
    assert.doesNotThrow(() => ledger.authorise(requestFor({ maxTokens: 999_999 })));
  });
});

describe('le plafond en dollars', () => {
  test('un budget trop mince pour une réponse utile refuse l’appel', () => {
    // Le budget adaptatif rétrécit d'abord la sortie ; quand il ne reste plus
    // de quoi produire un résultat exploitable, il refuse au lieu de payer une
    // réponse coupée en deux.
    ledger.open(MISSION, limits({ maxMissionTokens: 0, maxMissionCostUsd: 0.001 }));
    assert.throws(
      () => ledger.authorise(requestFor({ maxTokens: 16_000 })),
      /Budget insuffisant pour une réponse utile/,
    );
  });

  test('une demande volontairement courte n’est pas refusée par le seuil', () => {
    // Le seuil vise le budget qui rétrécit la réponse, pas l'appelant qui
    // demande un verdict d'un mot. Les confondre briserait tout appel bref.
    ledger.open(MISSION, limits({ maxMissionTokens: 0, maxMissionCostUsd: 0 }));
    assert.doesNotThrow(() => ledger.authorise(requestFor({ maxTokens: 100 })));
  });

  test('le budget restant rétrécit la sortie au lieu de tout refuser', () => {
    // C'est la correction de LIVE #002 : sous un plafond de 1,00 $, un appel
    // opus demandant 16 000 jetons de sortie était refusé *systématiquement*.
    // Il doit désormais partir, avec une réponse plus courte.
    ledger.open(MISSION, limits({ maxMissionTokens: 0, maxMissionCostUsd: 1 }));
    const request = requestFor({ model: 'claude-opus-5', maxTokens: 16_000 });

    const cap = ledger.cappedMaxTokens(request);
    assert.ok(cap > 0 && cap < 16_000, `la sortie doit être rétrécie, pas refusée (${cap})`);
    assert.doesNotThrow(() => ledger.authorise(request));
  });

  test('un modèle sans tarif connu reste plafonné en jetons', () => {
    // Le plafond en dollars ne peut pas s'appliquer sans tarif ; celui en
    // jetons, lui, s'applique toujours — sinon un modèle inconnu contournerait
    // toute la protection.
    ledger.open(MISSION, limits({ maxMissionTokens: 1000, maxMissionCostUsd: 0.0001 }));
    assert.throws(
      () => ledger.authorise(requestFor({ model: 'modele-maison', maxTokens: 8000 })),
      /Budget de mission/,
    );
  });
});

describe('le plafond par étape', () => {
  test('une étape ne peut pas absorber le budget de la mission', () => {
    // C'est exactement ce qui s'est produit : l'enrichissement de LIVE #001 a
    // consommé 1 372 673 jetons, soit 343 % du budget de la mission entière.
    ledger.open(MISSION, limits({ maxMissionTokens: 1_000_000, maxStepTokens: 2000 }));

    const request = requestFor({ maxTokens: 500 });
    ledger.record(request, response(1500, 400), { provider: 'simulation', durationMs: 10, toolCalls: 0 });

    assert.throws(() => ledger.authorise(request), /« discovery ».*absorber le budget/s);
  });

  test('le plafond d’étape ne bloque pas une autre étape', () => {
    ledger.open(MISSION, limits({ maxMissionTokens: 1_000_000, maxStepTokens: 2000 }));
    const discovery = requestFor({ maxTokens: 500 });
    ledger.record(discovery, response(1500, 400), {
      provider: 'simulation',
      durationMs: 10,
      toolCalls: 0,
    });

    const other = requestFor({
      maxTokens: 500,
      meta: { missionId: MISSION, taskRef: 'report', purpose: 'agent-step' },
    });
    assert.doesNotThrow(() => ledger.authorise(other));
  });

  test('le nombre d’appels par étape est borné', () => {
    ledger.open(MISSION, limits({ maxMissionTokens: 0, maxCallsPerStep: 2 }));
    const request = requestFor();

    for (let i = 0; i < 2; i++) {
      ledger.record(request, response(10, 10), {
        provider: 'simulation',
        durationMs: 1,
        toolCalls: 0,
      });
    }
    assert.throws(() => ledger.authorise(request), /a déjà passé 2 appels/);
  });
});

describe('plafond de sortie par appel', () => {
  test('une demande de sortie supérieure au plafond est ramenée au plafond', () => {
    ledger.open(MISSION, limits({ maxOutputTokensPerCall: 1000 }));
    assert.equal(ledger.cappedMaxTokens(requestFor({ maxTokens: 64_000 })), 1000);
  });

  test('une demande plus modeste n’est pas gonflée', () => {
    ledger.open(MISSION, limits({ maxOutputTokensPerCall: 8000 }));
    assert.equal(ledger.cappedMaxTokens(requestFor({ maxTokens: 500 })), 500);
  });
});

describe('le coupe-circuit', () => {
  test('trois échecs consécutifs arrêtent les appels de la mission', () => {
    ledger.open(MISSION, limits({ maxMissionTokens: 0, circuitBreakerFailures: 3 }));
    const request = requestFor();

    for (let i = 0; i < 3; i++) {
      ledger.recordFailure(request, 'panne du fournisseur', { provider: 'anthropic', durationMs: 5 });
    }
    assert.throws(() => ledger.authorise(request), /Coupe-circuit/);
  });

  test('un succès réarme le compteur', () => {
    // C'est la répétition d'une panne qui coûte cher, pas un échec isolé au
    // milieu d'un travail qui avance.
    ledger.open(MISSION, limits({ maxMissionTokens: 0, circuitBreakerFailures: 3 }));
    const request = requestFor();

    ledger.recordFailure(request, 'panne', { provider: 'anthropic', durationMs: 5 });
    ledger.recordFailure(request, 'panne', { provider: 'anthropic', durationMs: 5 });
    ledger.record(request, response(10, 10), { provider: 'anthropic', durationMs: 5, toolCalls: 0 });
    ledger.recordFailure(request, 'panne', { provider: 'anthropic', durationMs: 5 });
    ledger.recordFailure(request, 'panne', { provider: 'anthropic', durationMs: 5 });

    assert.doesNotThrow(() => ledger.authorise(request));
  });
});

describe('comptabilité', () => {
  test('chaque appel est enregistré avec son rattachement et son coût', () => {
    ledger.open(MISSION, limits());
    ledger.record(requestFor(), response(1000, 500), {
      provider: 'anthropic',
      durationMs: 1234,
      toolCalls: 2,
    });

    assert.equal(recorded.length, 1);
    const call = recorded[0]!;
    assert.equal(call.missionId, MISSION);
    assert.equal(call.taskRef, 'discovery');
    assert.equal(call.agentKey, 'explorer');
    assert.equal(call.purpose, 'agent-step');
    assert.equal(call.inputTokens, 1000);
    assert.equal(call.outputTokens, 500);
    assert.equal(call.toolCalls, 2);
    assert.equal(call.ok, true);
    // 1000 entrée à 3 $/M + 500 sortie à 15 $/M
    assert.equal(call.costUsd, costOfCall(response(1000, 500).usage, 'claude-sonnet-5'));
  });

  test('un échec est enregistré lui aussi', () => {
    ledger.open(MISSION, limits());
    ledger.recordFailure(requestFor(), 'Anthropic API error: 400', {
      provider: 'anthropic',
      durationMs: 42,
    });

    assert.equal(recorded[0]!.ok, false);
    assert.match(recorded[0]!.error!, /400/);
  });

  test('l’enregistrement ne recopie rien du contenu de la requête', () => {
    // La table dit ce qu'un appel a coûté, jamais ce qu'il contenait : ni
    // requête, ni réponse, ni en-tête, ni clé.
    ledger.open(MISSION, limits());
    ledger.record(
      requestFor({ system: 'SECRET-SYSTEME', messages: [userText('SECRET-MESSAGE')] }),
      response(10, 10),
      { provider: 'anthropic', durationMs: 1, toolCalls: 0 },
    );

    const serialised = JSON.stringify(recorded[0]);
    assert.ok(!serialised.includes('SECRET-SYSTEME'));
    assert.ok(!serialised.includes('SECRET-MESSAGE'));
  });

  test('le solde restant est recalculé immédiatement', () => {
    ledger.open(MISSION, limits({ maxMissionTokens: 10_000 }));
    ledger.record(requestFor(), response(1000, 500), {
      provider: 'anthropic',
      durationMs: 1,
      toolCalls: 0,
    });

    const snapshot = ledger.snapshot(MISSION)!;
    assert.equal(snapshot.tokens, 1500);
    assert.equal(snapshot.remainingTokens, 8500);
    assert.equal(snapshot.calls, 1);
  });

  test('fermer une mission libère sa comptabilité', () => {
    // Sans quoi les plafonds fuiraient d'une mission à la suivante.
    ledger.open(MISSION, limits({ maxMissionTokens: 10 }));
    ledger.close(MISSION);
    assert.equal(ledger.snapshot(MISSION), null);
    assert.doesNotThrow(() => ledger.authorise(requestFor({ maxTokens: 99_999 })));
  });
});

describe('le provider plafonné', () => {
  test('un appel refusé n’atteint jamais le fournisseur', async () => {
    const inner = new ScriptedProvider(() => ({ kind: 'text', text: 'ne devrait pas arriver' }));
    const guarded = new BudgetedProvider(inner, ledger);
    ledger.open(MISSION, limits({ maxMissionTokens: 100 }));

    await assert.rejects(() => guarded.complete(requestFor()), /BUDGET_EXCEEDED|Budget de mission/);
    assert.equal(inner.calls.length, 0, "le fournisseur ne doit pas avoir été appelé");
  });

  test('la sortie est bornée même quand l’appelant en demande plus', async () => {
    const inner = new ScriptedProvider(() => ({ kind: 'text', text: 'ok' }));
    const guarded = new BudgetedProvider(inner, ledger);
    ledger.open(MISSION, limits({ maxMissionTokens: 0, maxOutputTokensPerCall: 2000 }));

    await guarded.complete(requestFor({ maxTokens: 64_000 }));
    assert.equal(inner.calls[0]!.maxTokens, 2000);
  });

  test('un appel réussi est comptabilisé sans intervention de l’appelant', async () => {
    const guarded = new BudgetedProvider(
      new ScriptedProvider(() => ({ kind: 'text', text: 'ok' })),
      ledger,
    );
    ledger.open(MISSION, limits());

    await guarded.complete(requestFor());
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.ok, true);
  });

  test('un appel en échec est comptabilisé et l’erreur remonte', async () => {
    const guarded = new BudgetedProvider(
      new ScriptedProvider(() => ({ kind: 'throw', error: new Error('réseau coupé') })),
      ledger,
    );
    ledger.open(MISSION, limits());

    await assert.rejects(() => guarded.complete(requestFor()), /réseau coupé/);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.ok, false);
  });

  test('une boucle de pannes est coupée après trois échecs', async () => {
    // Le scénario coûteux : un appel qui échoue toujours de la même façon.
    // Sans coupe-circuit, chaque tentative repaye le contexte complet.
    const inner = new ScriptedProvider(() => ({
      kind: 'throw',
      error: new Error('Anthropic API error: 400'),
    }));
    const guarded = new BudgetedProvider(inner, ledger);
    ledger.open(MISSION, limits({ maxMissionTokens: 0, circuitBreakerFailures: 3 }));

    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => guarded.complete(requestFor()));
    }
    const before = inner.calls.length;

    await assert.rejects(() => guarded.complete(requestFor()), /Coupe-circuit/);
    assert.equal(inner.calls.length, before, 'le quatrième appel ne doit pas partir');
  });
});

describe('estimation des jetons d’entrée', () => {
  test('elle croît avec la taille du contexte', () => {
    const petit = estimateInputTokens(requestFor({ messages: [userText('court')] }));
    const grand = estimateInputTokens(requestFor({ messages: [userText('x'.repeat(40_000))] }));
    assert.ok(grand > petit * 100);
  });

  test('les définitions d’outils comptent dans l’estimation', () => {
    // Elles occupent le contexte à chaque tour ; les ignorer sous-estimerait
    // systématiquement les étapes les plus outillées, donc les plus chères.
    const sans = estimateInputTokens(requestFor());
    const avec = estimateInputTokens(
      requestFor({
        tools: [
          {
            name: 'discover_companies',
            description: 'x'.repeat(2000),
            inputSchema: { type: 'object' },
          },
        ],
      }),
    );
    assert.ok(avec > sans);
  });
});

/** Une réponse de fournisseur avec la consommation voulue. */
function response(inputTokens: number, outputTokens: number) {
  return {
    content: [{ type: 'text' as const, text: 'ok' }],
    stopReason: 'end_turn' as const,
    usage: { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
    model: 'claude-sonnet-5',
    refusal: null,
  };
}
