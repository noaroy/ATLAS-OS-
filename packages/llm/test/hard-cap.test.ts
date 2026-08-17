import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetLedger, DEFAULT_BUDGET_LIMITS } from '../src/budget.ts';
import type { LlmRequest } from '../src/types.ts';

/**
 * Le plafond en dollars doit être un mur, pas une indication.
 *
 * SALVAGE-001 a dépensé 0,0597 $ sur un plafond de 0,04 $ déclaré dur. Aucun
 * refus n'a été consigné : le registre a laissé passer deux appels qui,
 * arithmétiquement, ne tenaient pas dans ce qui restait.
 *
 * Une garde économique qui laisse passer 49 % de dépassement sans le dire est
 * pire qu'une absence de garde : elle donne à celui qui autorise la dépense la
 * certitude d'un plafond qui n'existe pas.
 */

const MODEL = 'claude-haiku-4-5-20251001';

const request = (inputChars: number, maxTokens = 2500): LlmRequest => ({
  model: MODEL,
  system: 'x'.repeat(200),
  messages: [{ role: 'user', content: [{ type: 'text', text: 'y'.repeat(inputChars) }] }],
  maxTokens,
  meta: { missionId: 'mis_test', taskRef: 'scoring', purpose: 'agent-step' },
});

const response = (inputTokens: number, outputTokens: number) => ({
  model: MODEL,
  content: [{ type: 'text' as const, text: 'ok' }],
  stopReason: 'end_turn' as const,
  usage: { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
  refusal: null,
});

describe('le plafond de dépense est un mur', () => {
  test('un appel qui ne tient pas dans ce qui reste est refusé', () => {
    const ledger = new BudgetLedger();
    ledger.open('mis_test', { ...DEFAULT_BUDGET_LIMITS, maxMissionCostUsd: 0.04 });

    // La séquence exacte de SALVAGE-001, en jetons réellement facturés.
    const spent: number[] = [];
    const sequence = [
      [4108, 530],
      [4447, 254],
      [8551, 2500],
      [10658, 1896],
      [13119, 1580],
    ] as const;

    let refusedAt: number | null = null;
    for (const [k, [input, output]] of sequence.entries()) {
      try {
        ledger.authorise(request(input * 4));
      } catch {
        refusedAt = k + 1;
        break;
      }
      const record = ledger.record(request(input * 4), response(input, output), {
        provider: 'anthropic',
        durationMs: 10,
        toolCalls: 0,
      });
      spent.push(record.costUsd ?? 0);
    }

    const total = spent.reduce((a, b) => a + b, 0);
    assert.ok(
      refusedAt !== null,
      `le registre doit refuser avant le dépassement — total atteint ${total.toFixed(4)} $ ` +
        `sur un plafond de 0,0400 $`,
    );
    assert.ok(
      total <= 0.04,
      `le plafond ne doit jamais être franchi : ${total.toFixed(4)} $ dépensés, refus au tour ${refusedAt}`,
    );
  });

  test('une mission dont le périmètre n’est pas ouvert n’est pas plafonnée', () => {
    // Comportement délibéré et documenté : les appels hors mission — santé,
    // outillage — ne dépendent pas d'un budget qui n'a pas de sens pour eux.
    // Le test existe pour que ce choix reste un choix, et non une surprise.
    const ledger = new BudgetLedger();
    assert.doesNotThrow(() => ledger.authorise(request(40_000)));
  });

  test('le dépassement se produit exactement quand la mission n’est pas ouverte', () => {
    // La reproduction du défaut : le même appel, refusé sur une mission
    // ouverte, passe sans broncher sur une mission qui ne l'est pas.
    const opened = new BudgetLedger();
    opened.open('mis_test', { ...DEFAULT_BUDGET_LIMITS, maxMissionCostUsd: 0.001 });
    assert.throws(() => opened.authorise(request(40_000)));

    const closed = new BudgetLedger();
    assert.doesNotThrow(() => closed.authorise(request(40_000)));
  });
});
