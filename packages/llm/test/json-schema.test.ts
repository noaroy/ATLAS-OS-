import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sanitiseStructuredSchema, validateStructuredSchema } from '@atlas/llm';
import { BUSINESS_EXPANSION } from '@atlas/departments';

/**
 * Les schémas de sortie structurée.
 *
 * Ces tests existent à cause d'une panne précise : un `maxItems` dans le schéma
 * de découverte a fait rejeter chaque recherche de LIVE #001 en 400, avant
 * toute inférence, et la mission a coûté 9,15 $ pour zéro candidat sans que
 * rien ne s'en aperçoive. Le schéma était pourtant du JSON Schema parfaitement
 * valide — c'est l'API de sortie structurée qui n'en accepte qu'un sous-ensemble.
 *
 * Un test unitaire ne pouvait pas le voir : le provider simulé ne valide aucun
 * schéma. La parade est donc de vérifier les schémas eux-mêmes.
 */

describe('validation des schémas de sortie structurée', () => {
  test('maxItems est refusé — le mot-clé exact qui a fait échouer LIVE #001', () => {
    const result = validateStructuredSchema({
      type: 'object',
      properties: {
        companies: { type: 'array', maxItems: 40, items: { type: 'string' } },
      },
    });

    assert.equal(result.ok, false);
    const violation = result.violations.find((v) => v.keyword === 'maxItems');
    assert.ok(violation, 'la violation doit être nommée');
    assert.equal(
      violation.path,
      '$.properties.companies.maxItems',
      'le chemin doit désigner exactement quoi retirer',
    );
  });

  test('les autres contraintes de taille sont refusées elles aussi', () => {
    for (const keyword of ['minItems', 'maxLength', 'minLength', 'minimum', 'maximum', 'pattern']) {
      const result = validateStructuredSchema({
        type: 'object',
        properties: { champ: { type: 'string', [keyword]: 1 } },
      });
      assert.equal(result.ok, false, `${keyword} aurait dû être refusé`);
    }
  });

  test('un mot-clé inconnu est refusé par défaut plutôt que laissé passer', () => {
    // Nous n'avons observé qu'un seul refus réel de l'API. Deviner la liste
    // noire complète reviendrait à réintroduire le risque au prochain mot-clé :
    // la liste blanche est ce qui protège de ce qu'on n'a pas encore rencontré.
    const result = validateStructuredSchema({
      type: 'object',
      properties: { champ: { type: 'string', motCleInventé: true } },
    });
    assert.equal(result.ok, false);
    assert.match(result.violations[0]!.reason, /hors liste blanche/);
  });

  test('un champ nommé « maxItems » reste un champ, pas un mot-clé', () => {
    // `properties.maxItems` décrit un champ métier légitime. Le confondre avec
    // le mot-clé casserait des schémas parfaitement valides.
    const result = validateStructuredSchema({
      type: 'object',
      properties: { maxItems: { type: 'integer', description: 'Nombre maximal demandé' } },
    });
    assert.equal(result.ok, true);
  });

  test('un schéma purement structurel passe', () => {
    const result = validateStructuredSchema({
      type: 'object',
      properties: {
        nom: { type: 'string', description: 'Raison sociale' },
        roles: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
      },
      required: ['nom'],
      additionalProperties: false,
    });
    assert.deepEqual(result.violations, []);
    assert.equal(result.ok, true);
  });
});

describe('nettoyage avant envoi', () => {
  test('les contraintes partent, la structure reste', () => {
    const cleaned = sanitiseStructuredSchema({
      type: 'object',
      properties: {
        companies: {
          type: 'array',
          maxItems: 40,
          items: {
            type: 'object',
            properties: { name: { type: 'string', maxLength: 160, description: 'Nom' } },
            required: ['name'],
            additionalProperties: false,
          },
        },
      },
      required: ['companies'],
    });

    assert.equal(validateStructuredSchema(cleaned).ok, true);

    const at = (path: string): Record<string, unknown> =>
      path
        .split('.')
        .reduce<Record<string, unknown>>(
          (node, key) => node[key] as Record<string, unknown>,
          cleaned as unknown as Record<string, unknown>,
        );

    const companies = at('properties.companies');
    assert.equal(companies.maxItems, undefined);
    assert.equal(companies.type, 'array', 'le type doit survivre');

    const name = at('properties.companies.items.properties.name');
    assert.equal(name.maxLength, undefined);
    assert.equal(name.description, 'Nom', 'la description porte la consigne, elle doit rester');
    assert.deepEqual(at('properties.companies.items').required, ['name']);
  });

  test('le nettoyage est idempotent', () => {
    const once = sanitiseStructuredSchema({ type: 'array', maxItems: 3, items: { type: 'string' } });
    assert.deepEqual(sanitiseStructuredSchema(once), once);
  });
});

describe('les schémas réellement embarqués', () => {
  test('le brief du département est acceptable par l’API', () => {
    // Ce schéma-ci a échoué pendant LIVE #001 : Hermès n'a jamais pu lire
    // l'objectif et s'est rabattu sur les champs déclarés.
    const result = validateStructuredSchema(BUSINESS_EXPANSION.briefSchema);
    assert.deepEqual(
      result.violations.map((v) => v.path),
      [],
      'le schéma de brief expédié ne doit contenir aucun mot-clé refusé',
    );
  });
});
