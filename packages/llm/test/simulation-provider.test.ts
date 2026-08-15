import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '@atlas/core';
import { SimulationProvider, type LlmRequest } from '@atlas/llm';

/**
 * Le mode simulation comme banc d'essai, et non comme générateur de prose.
 *
 * La différence est celle-ci : une valeur simulée doit franchir les validateurs
 * qu'une valeur réelle franchira. Tant qu'elle ne le fait pas, une démonstration
 * locale ne prouve rien de la chaîne — elle prouve seulement que les premiers
 * maillons acceptent n'importe quoi.
 *
 * La démonstration locale a échoué exactement là : `markets.countries` recevait
 * « [simulated] Countries for Identify and qualify potential… », 96 caractères
 * pour un champ qui en admet 60. `discover_companies` refusait l'appel, l'étape
 * ne découvrait rien, et les cinq étapes suivantes étaient sautées faute
 * d'entrée. Le fondateur voyait « aucun candidat » là où il fallait lire
 * « aucune recherche n'a eu lieu ».
 */

const logger = createLogger({ level: 'error', pretty: false });

function requestFor(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'sim',
    system: 'Vous êtes un spécialiste ATLAS.',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Trouvez des partenaires de distribution en Allemagne.' }],
      },
    ],
    maxTokens: 4000,
    effort: 'low',
    ...overrides,
  } as LlmRequest;
}

/** Le schéma réel de `discover_companies`, bornes comprises. */
const DISCOVER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    targetTypes: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      items: { type: 'string', maxLength: 40 },
    },
    countries: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: { type: 'string', maxLength: 60 },
    },
    industries: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 120 } },
    keywords: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 80 } },
    limit: { type: 'integer', minimum: 1, maximum: 60 },
  },
  required: ['targetTypes', 'countries'],
  additionalProperties: false,
};

/**
 * Vérifie une valeur contre les bornes du schéma qui comptent réellement en
 * aval : longueurs, cardinalités, énumérations. Assez pour attraper la classe
 * de défaut qui nous occupe, sans embarquer un validateur complet.
 */
function violations(value: unknown, schema: Record<string, unknown>, path = ''): string[] {
  const found: string[] = [];
  const type = schema.type as string | undefined;

  if (type === 'object' && value && typeof value === 'object') {
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in (value as Record<string, unknown>))) found.push(`${path}${key} manquant`);
    }
    for (const [key, sub] of Object.entries(properties)) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) found.push(...violations(child, sub, `${path}${key}.`));
    }
    return found;
  }

  if (type === 'array' && Array.isArray(value)) {
    const min = schema.minItems as number | undefined;
    const max = schema.maxItems as number | undefined;
    const label = path.replace(/\.$/, '');
    if (min !== undefined && value.length < min) found.push(`${label}: ${value.length} < minItems ${min}`);
    if (max !== undefined && value.length > max) found.push(`${label}: ${value.length} > maxItems ${max}`);
    const items = (schema.items ?? {}) as Record<string, unknown>;
    for (const [index, item] of value.entries()) {
      found.push(...violations(item, items, `${label}[${index}].`));
    }
    return found;
  }

  const label = path.replace(/\.$/, '');
  if (type === 'string' && typeof value === 'string') {
    const max = schema.maxLength as number | undefined;
    if (max !== undefined && value.length > max) {
      found.push(`${label}: ${value.length} caractères > maxLength ${max} — « ${value.slice(0, 50)}… »`);
    }
  }
  if (type === 'integer' && typeof value === 'number') {
    const min = schema.minimum as number | undefined;
    const max = schema.maximum as number | undefined;
    if (min !== undefined && value < min) found.push(`${label}: ${value} < minimum ${min}`);
    if (max !== undefined && value > max) found.push(`${label}: ${value} > maximum ${max}`);
  }
  const allowed = schema.enum as unknown[] | undefined;
  if (allowed && !allowed.includes(value)) {
    found.push(`${label}: « ${String(value)} » hors énumération`);
  }
  return found;
}

describe('provider de simulation', () => {
  test("l'entrée fabriquée pour un outil respecte les bornes de son schéma", async () => {
    const provider = new SimulationProvider(logger);

    const response = await provider.complete(
      requestFor({
        tools: [
          { name: 'discover_companies', description: 'Recherche des organisations', inputSchema: DISCOVER_SCHEMA },
        ],
        simulationHints: { toolsInInstruction: ['discover_companies'] },
      }),
    );

    const call = response.content.find((c) => c.type === 'tool_use');
    assert.ok(call, "l'agent simulé doit appeler l'outil que son instruction nomme");
    assert.equal(call.name, 'discover_companies');

    const problems = violations(call.input, DISCOVER_SCHEMA);
    assert.deepEqual(problems, [], `entrée refusée par le schéma :\n${problems.join('\n')}`);
  });

  test('un champ collection reçoit des valeurs courtes, pas une reformulation de l’objectif', async () => {
    const provider = new SimulationProvider(logger);

    const response = await provider.complete(
      requestFor({
        jsonSchema: {
          type: 'object',
          properties: {
            markets: {
              type: 'object',
              properties: {
                countries: { type: 'array', items: { type: 'string' } },
                industries: { type: 'array', items: { type: 'string' } },
                regions: { type: 'array', items: { type: 'string' } },
              },
              required: ['countries', 'industries', 'regions'],
            },
          },
          required: ['markets'],
        },
      }),
    );

    const text = response.content.find((c) => c.type === 'text');
    assert.ok(text);
    const value = JSON.parse(text.text) as {
      markets: { countries: string[]; industries: string[]; regions: string[] };
    };

    for (const [field, values] of Object.entries(value.markets)) {
      for (const entry of values) {
        assert.ok(
          entry.length <= 60,
          `markets.${field} contient « ${entry} » (${entry.length} caractères) — un marché n'est pas une phrase`,
        );
        assert.ok(
          !entry.includes('[simulated]'),
          `markets.${field} retombe sur la prose générique : « ${entry} »`,
        );
      }
    }
  });

  test("une liste tirée d'une énumération ne se répète pas", async () => {
    const provider = new SimulationProvider(logger);
    const roles = ['distributor', 'supplier', 'integrator', 'oem', 'reseller', 'commercial-partner'];

    const response = await provider.complete(
      requestFor({
        jsonSchema: {
          type: 'object',
          properties: {
            targetTypes: { type: 'array', items: { type: 'string', enum: roles } },
          },
          required: ['targetTypes'],
        },
      }),
    );

    const text = response.content.find((c) => c.type === 'text');
    assert.ok(text);
    const { targetTypes } = JSON.parse(text.text) as { targetTypes: string[] };

    assert.ok(targetTypes.length > 0, 'la liste ne doit pas être vide');
    for (const role of targetTypes) assert.ok(roles.includes(role), `« ${role} » hors énumération`);
    assert.equal(
      new Set(targetTypes).size,
      targetTypes.length,
      `rôles répétés : ${targetTypes.join(', ')} — le plan cherche alors moins large qu'il ne l'annonce`,
    );
  });

  test('le même appel rend toujours le même résultat', async () => {
    const provider = new SimulationProvider(logger);
    const request = requestFor({
      jsonSchema: {
        type: 'object',
        properties: { title: { type: 'string' }, desiredCount: { type: 'integer', minimum: 1, maximum: 100 } },
        required: ['title', 'desiredCount'],
      },
    });

    const [first, second] = await Promise.all([provider.complete(request), provider.complete(request)]);
    assert.deepEqual(first.content, second.content, 'une démonstration doit être reproductible');
  });
});
