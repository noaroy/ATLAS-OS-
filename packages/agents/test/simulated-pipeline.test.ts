import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '@atlas/core';
import { SimulationProvider } from '@atlas/llm';
import { INTELLIGENCE_TOOLS } from '../src/intelligence-tools.ts';

/**
 * Le mode simulation doit pouvoir conduire la vraie chaîne.
 *
 * Un provider simulé qui produit des valeurs que les outils réels refusent ne
 * démontre rien : la mission s'arrête à la première étape, les suivantes sont
 * sautées faute d'entrée, et le tableau de bord affiche « aucun candidat »
 * là où il faudrait lire « aucune recherche n'a eu lieu ».
 *
 * Ce test tient le contrat à l'endroit exact où il se rompt : le schéma de
 * l'outil et son validateur, tels qu'ils sont réellement déclarés.
 */

const logger = createLogger({ level: 'error', pretty: false });

const discover = INTELLIGENCE_TOOLS.find((t) => t.name === 'discover_companies');

describe('agent simulé face aux outils réels', () => {
  test('discover_companies accepte ce que fabrique un agent simulé', async () => {
    assert.ok(discover, 'discover_companies doit exister');

    const provider = new SimulationProvider(logger);
    const response = await provider.complete({
      model: 'sim',
      system: 'Vous êtes Explorateur, spécialiste recherche et découverte.',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'Appelez discover_companies UNE fois en décrivant ce que vous cherchez : ' +
                'des integrator, supplier, oem en Germany.',
            },
          ],
        },
      ],
      maxTokens: 4000,
      effort: 'low',
      tools: [
        {
          name: discover.name,
          description: discover.description,
          inputSchema: discover.inputSchema,
        },
      ],
      // Les mêmes indices que le runtime fournit en simulation : les rôles que
      // le département traite réellement, et les marchés du brief.
      simulationHints: {
        toolsInInstruction: ['discover_companies'],
        targetTypes: ['integrator', 'supplier', 'oem'],
        targetType: ['integrator'],
        countries: ['Germany', 'Austria'],
        country: ['Germany'],
        industries: ['Industrial equipment'],
        industry: ['Industrial equipment'],
      },
    });

    const call = response.content.find((c) => c.type === 'tool_use');
    assert.ok(call, "l'agent simulé doit appeler l'outil que son instruction nomme");

    const parsed = discover.parse.safeParse(call.input);
    assert.ok(
      parsed.success,
      'entrée refusée par le validateur de l’outil :\n' +
        JSON.stringify(call.input, null, 2) +
        '\n\n' +
        JSON.stringify(parsed.success ? null : parsed.error.issues, null, 2),
    );

    const input = parsed.data as { targetTypes: string[]; countries: string[] };
    // Un rôle inconnu du département fait rejeter l'appel à l'exécution, bien
    // après que le schéma l'a laissé passer.
    for (const role of input.targetTypes) {
      assert.ok(
        ['integrator', 'supplier', 'oem'].includes(role),
        `« ${role} » n'est pas un rôle indiqué au brief — l'outil le refusera`,
      );
    }
    for (const country of input.countries) {
      assert.ok(country.length <= 60, `« ${country} » dépasse la borne du champ`);
    }
  });
});
