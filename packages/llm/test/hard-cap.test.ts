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

/**
 * Le plafond, éprouvé sur toute la plage qu'ATLAS emploie.
 *
 * Un seul montant testé ne prouve rien : la faille venait de ce que la
 * projection touchait *toujours* le plafond, quel qu'il soit. Ce qu'il faut
 * démontrer est une propriété — aucune séquence d'appels ne peut le franchir —
 * pas un cas particulier.
 */
describe('le plafond tient à tous les montants employés', () => {
  const CAPS = [0.01, 0.02, 0.04, 0.15];
  /** Des tailles d'entrée qui vont du bref au contexte accumulé. */
  const SIZES = [800, 4_000, 12_000, 30_000];

  for (const cap of CAPS) {
    for (const size of SIZES) {
      test(`plafond ${cap.toFixed(2)} $ · entrée ~${size} jetons`, () => {
        const ledger = new BudgetLedger();
        ledger.open('mis_test', { ...DEFAULT_BUDGET_LIMITS, maxMissionCostUsd: cap });

        let total = 0;
        let refused = false;
        // Vingt tours : bien plus qu'une mission réelle n'en fait, pour que
        // l'arrêt vienne du plafond et non de la fin de la boucle.
        for (let turn = 0; turn < 20; turn++) {
          const call = request(size * 4);
          let planned: number;
          try {
            ledger.authorise(call);
            planned = ledger.cappedMaxTokens(call);
          } catch {
            refused = true;
            break;
          }
          // Le fournisseur honore le plafond de sortie qu'on lui donne : c'est
          // le contrat de `maxTokens`, et l'ignorer testerait autre chose.
          const record = ledger.record(call, response(size, planned), {
            provider: 'anthropic',
            durationMs: 5,
            toolCalls: 0,
          });
          total += record.costUsd ?? 0;
        }

        assert.ok(refused, `le registre doit finir par refuser (total ${total.toFixed(5)} $)`);
        assert.ok(
          total <= cap,
          `plafond ${cap} $ franchi : ${total.toFixed(5)} $ dépensés`,
        );
      });
    }
  }

  test('la sortie autorisée rétrécit à mesure que le budget se consomme', () => {
    // Un plafond serré, pour que le budget morde avant le plafond de sortie
    // par appel : à budget large, `maxTokens` reste la contrainte active et le
    // test ne mesurerait rien.
    const ledger = new BudgetLedger();
    ledger.open('mis_test', { ...DEFAULT_BUDGET_LIMITS, maxMissionCostUsd: 0.01 });

    const call = request(4_000 * 4);
    const first = ledger.cappedMaxTokens(call);
    assert.ok(first < 2500, `le budget doit déjà brider la sortie : ${first}`);

    ledger.record(call, response(4_000, first), { provider: 'anthropic', durationMs: 5, toolCalls: 0 });
    const second = ledger.cappedMaxTokens(call);

    assert.ok(second < first, `la sortie doit rétrécir : ${first} puis ${second}`);
  });

  test('un refus n’est pas réessayable', () => {
    // Réessayer après un refus coûterait précisément ce que le refus vient
    // d'éviter. Le code d'erreur le dit, pour que rien en amont ne le rejoue.
    const ledger = new BudgetLedger();
    ledger.open('mis_test', { ...DEFAULT_BUDGET_LIMITS, maxMissionCostUsd: 0.0001 });

    assert.throws(
      () => ledger.authorise(request(40_000)),
      (err: unknown) => {
        const e = err as { code?: string; retryable?: boolean };
        assert.equal(e.code, 'BUDGET_EXCEEDED');
        assert.notEqual(e.retryable, true, 'un refus budgétaire ne se réessaie pas');
        return true;
      },
    );
  });

  test('l’estimation d’entrée est conservatrice, jamais optimiste', () => {
    // Une garde bâtie sur un comptage optimiste se franchit exactement quand
    // elle compte le plus. On vérifie donc que le refus arrive *avant* que le
    // coût réel n'atteigne le plafond, même si l'entrée réelle dépasse
    // l'estimation de 20 %.
    const ledger = new BudgetLedger();
    ledger.open('mis_test', { ...DEFAULT_BUDGET_LIMITS, maxMissionCostUsd: 0.02 });

    let total = 0;
    for (let turn = 0; turn < 20; turn++) {
      const call = request(6_000 * 4);
      let planned: number;
      try {
        ledger.authorise(call);
        planned = ledger.cappedMaxTokens(call);
      } catch {
        break;
      }
      // L'entrée réellement facturée dépasse l'estimation d'un cinquième.
      total +=
        ledger.record(call, response(Math.round(6_000 * 1.2), planned), {
          provider: 'anthropic',
          durationMs: 5,
          toolCalls: 0,
        }).costUsd ?? 0;
    }
    assert.ok(total <= 0.02, `plafond franchi malgré la marge : ${total.toFixed(5)} $`);
  });
});
