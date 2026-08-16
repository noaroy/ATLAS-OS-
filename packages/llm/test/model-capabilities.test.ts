import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Ce que chaque modèle accepte.
 *
 * LIVE PILOT 001 est mort en une seconde sur une erreur 400 : « adaptive
 * thinking is not supported on this model ». Le provider envoyait le paramètre
 * à tous les modèles, et Haiku — celui qu'on avait choisi précisément parce
 * qu'il est économique — le refuse. Chaque appel rejeté, six étapes sautées,
 * mission échouée. Le coût fut nul, mais le pilote n'a rien prouvé.
 *
 * Ce test lit la source plutôt que d'appeler l'API : vérifier une capacité de
 * modèle en interrogeant le fournisseur coûterait de l'argent à chaque
 * exécution de la suite, et échouerait hors ligne.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL('../src/anthropic-provider.ts', import.meta.url)),
  'utf8',
);

describe('capacités des modèles', () => {
  test('le thinking adaptatif est conditionnel, jamais inconditionnel', () => {
    // La forme exacte qui a cassé le pilote.
    assert.ok(
      !/\n\s+thinking: \{ type: 'adaptive' \},/.test(SOURCE),
      'le paramètre est envoyé sans condition de modèle',
    );
    assert.ok(
      SOURCE.includes('supportsAdaptiveThinking(request.model)'),
      'le paramètre doit dépendre du modèle appelé',
    );
  });

  test('la liste des modèles compatibles est en positif', () => {
    // Une liste d'exclusion laisserait passer tout modèle futur non listé, et
    // reproduirait la panne au prochain modèle économique.
    assert.ok(SOURCE.includes('const REASONING_MODELS'));
    assert.ok(
      !/NON_ADAPTIVE|UNSUPPORTED_THINKING|EXCLUDED_MODELS/.test(SOURCE),
      'la liste doit énumérer ce qui est permis, pas ce qui est interdit',
    );
  });

  test('Haiku est bien hors de la liste', () => {
    const block = /const REASONING_MODELS = \[([^\]]*)\]/.exec(SOURCE);
    assert.ok(block, 'liste introuvable');
    assert.ok(
      !block[1]!.includes('haiku'),
      'Haiku refuse le thinking adaptatif ; le lister casserait toute mission économique',
    );
  });

  test("le réglage d'effort suit la même règle", () => {
    // Deuxième paramètre, même piège : Haiku refuse `output_config.effort`.
    assert.ok(SOURCE.includes('supportsEffort(request.model)'));
    assert.ok(
      !/output_config: \{\s*effort:/.test(SOURCE),
      "l'effort est envoyé sans condition de modèle",
    );
  });

  test("un output_config vide n'est jamais envoyé", () => {
    // Un objet vide suffit à faire rejeter la requête sur certains modèles.
    assert.ok(SOURCE.includes('Object.keys(outputConfig).length > 0'));
  });

  test('les modèles de raisonnement y sont', () => {
    const block = /const REASONING_MODELS = \[([^\]]*)\]/.exec(SOURCE);
    assert.ok(block);
    for (const model of ['claude-opus-5', 'claude-sonnet-5']) {
      assert.ok(block[1]!.includes(model), `${model} devrait accepter le thinking adaptatif`);
    }
  });
});
