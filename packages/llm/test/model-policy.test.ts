import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError } from '@atlas/core';
import {
  BudgetedProvider,
  BudgetLedger,
  DEFAULT_BUDGET_LIMITS,
  assertModelAllowed,
  describePolicy,
  isModelAllowed,
  type LlmRequest,
  type ModelPolicy,
} from '@atlas/llm';
import { ScriptedProvider } from '@atlas/testing';

/** Un fournisseur qui répond « ok » — ou qui échoue si on l'atteint alors qu'il ne devrait pas. */
const answering = (): ScriptedProvider => new ScriptedProvider(() => ({ kind: 'text', text: 'ok' }));
const unreachable = (): ScriptedProvider =>
  new ScriptedProvider(() => {
    throw new Error("le fournisseur ne devait jamais être atteint");
  });

/**
 * Quels modèles ce déploiement accepte d'appeler.
 *
 * Le preflight annonçait « aucun modèle interdit : rien n'empêche d'appeler le
 * plus cher », et c'était exact. Opus facture dix-huit fois le tarif de Haiku
 * pour un travail d'extraction où la différence ne se voit pas : l'écart entre
 * une mission à 0,04 $ et la même à 0,72 $ tenait à un mot dans un fichier de
 * configuration.
 *
 * Ce qui compte ici n'est pas que la règle existe, c'est *où* elle vit. Elle est
 * appliquée dans le décorateur que tout appel traverse — pas dans une
 * vérification que chaque appelant devrait penser à faire. Trois chemins
 * menaient au modèle le plus cher : un réglage de console, une variable
 * d'environnement, et le `model` propre à un agent. Les trois passent
 * maintenant par le même refus.
 */

const HAIKU = 'claude-haiku-4-5-20251001';
const OPUS = 'claude-opus-5';
const SONNET = 'claude-sonnet-5';

const policy = (overrides: Partial<ModelPolicy> = {}): ModelPolicy => ({
  allowed: [],
  forbidden: ['claude-opus'],
  ...overrides,
});

function requestFor(model: string): LlmRequest {
  return {
    model,
    system: 'test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'bonjour' }] }],
    maxTokens: 500,
    effort: 'low',
    meta: { missionId: 'msn_test', taskRef: null, agentKey: null, purpose: 'test' },
  } as LlmRequest;
}

describe('politique de modèles — la règle', () => {
  test('Opus est refusé', () => {
    assert.equal(isModelAllowed(OPUS, policy()), false);
    assert.equal(isModelAllowed('claude-opus-5-20260101', policy()), false);
  });

  test('Haiku est accepté', () => {
    assert.equal(isModelAllowed(HAIKU, policy()), true);
  });

  test('une liste blanche exclut tout le reste', () => {
    // Le réglage d'une mission réelle : elle énumère ce qu'elle s'autorise, et
    // rien d'autre ne passe — y compris un modèle qu'aucune interdiction ne vise.
    const strict = policy({ allowed: ['claude-haiku'] });
    assert.equal(isModelAllowed(HAIKU, strict), true);
    assert.equal(isModelAllowed(SONNET, strict), false, 'Sonnet ne doit pas passer implicitement');
    assert.equal(isModelAllowed(OPUS, strict), false);
  });

  test("l'interdiction l'emporte sur l'autorisation", () => {
    // Une contradiction dans la configuration doit se résoudre du côté sûr.
    const contradictory: ModelPolicy = { allowed: ['claude-opus'], forbidden: ['claude-opus'] };
    assert.equal(isModelAllowed(OPUS, contradictory), false);
  });

  test('aucune escalade implicite vers un modèle plus cher', () => {
    // Sonnet n'est ni interdit ni autorisé : sans liste blanche il passe, avec
    // liste blanche il ne passe pas. Le silence ne vaut jamais permission dès
    // qu'une liste existe.
    assert.equal(isModelAllowed(SONNET, policy()), true, 'sans liste blanche, Sonnet reste possible');
    assert.equal(
      isModelAllowed(SONNET, policy({ allowed: ['claude-haiku'] })),
      false,
      "avec liste blanche, l'escalade doit être refusée",
    );
  });

  test('un modèle simulé passe toujours', () => {
    // Il ne coûte rien et ne quitte pas la machine : le refuser empêcherait
    // toute démonstration sans rien protéger.
    assert.equal(isModelAllowed('claude-opus-5 (simulation)', policy()), true);
  });

  test('le refus explique quoi corriger', () => {
    try {
      assertModelAllowed(OPUS, policy());
      assert.fail('Opus aurait dû être refusé');
    } catch (err) {
      assert.ok(err instanceof AtlasError);
      assert.match(err.message, /interdits/);
      assert.equal(err.retryable, false, 'rejouer le même appel donnerait le même refus');
    }
  });

  test('la politique se résume lisiblement', () => {
    assert.match(describePolicy(policy()), /claude-opus/);
    assert.match(describePolicy({ allowed: [], forbidden: [] }), /aucune restriction/i);
    assert.match(describePolicy({ allowed: ['claude-haiku'], forbidden: [] }), /uniquement/);
  });
});

describe('politique de modèles — où elle est appliquée', () => {
  const ledger = () => new BudgetLedger(() => {});

  test('un appel interdit est refusé par le décorateur, pas par bonne volonté', async () => {
    // Le point qui compte : l'appelant n'a rien à vérifier. Le runtime des
    // agents, le planificateur, l'extraction de brief — tous passent ici.
    const book = ledger();
    book.open('msn_test', DEFAULT_BUDGET_LIMITS);
    const provider = new BudgetedProvider(unreachable(), book, policy());

    await assert.rejects(() => provider.complete(requestFor(OPUS)), /interdits/);
  });

  test('un appel autorisé passe normalement', async () => {
    const book = ledger();
    book.open('msn_test', DEFAULT_BUDGET_LIMITS);
    const provider = new BudgetedProvider(answering(), book, policy());

    const response = await provider.complete(requestFor(HAIKU));
    assert.ok(response.content.length > 0);
  });

  test("un refus de modèle ne consomme aucun budget", async () => {
    // Le refus arrive avant la comptabilité : un appel jamais parti ne doit
    // laisser aucune trace de dépense.
    const book = ledger();
    book.open('msn_test', DEFAULT_BUDGET_LIMITS);
    const provider = new BudgetedProvider(unreachable(), book, policy());

    await assert.rejects(() => provider.complete(requestFor(OPUS)));

    const snapshot = book.snapshot('msn_test');
    assert.equal(snapshot?.calls, 0, 'aucun appel ne doit être comptabilisé');
    assert.equal(snapshot?.costUsd, 0);
  });

  test("le modèle propre à un agent ne contourne pas la politique", async () => {
    // Le troisième chemin vers le modèle le plus cher : un agent portant son
    // propre `model`. Il traverse le même décorateur, donc le même refus.
    const book = ledger();
    book.open('msn_test', DEFAULT_BUDGET_LIMITS);
    const provider = new BudgetedProvider(unreachable(), book, policy({ allowed: ['claude-haiku'] }));

    await assert.rejects(() => provider.complete(requestFor(SONNET)), /autorisés/);
  });

  test('sans politique, le comportement reste inchangé', async () => {
    // La compatibilité compte : un déploiement qui ne déclare rien ne doit pas
    // se retrouver bloqué par une valeur par défaut trop stricte.
    const book = ledger();
    book.open('msn_test', DEFAULT_BUDGET_LIMITS);
    const provider = new BudgetedProvider(answering(), book);

    const response = await provider.complete(requestFor(OPUS));
    assert.ok(response.content.length > 0);
  });
});
