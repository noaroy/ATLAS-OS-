import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toolsForAction, withheldFrom, scopedActions } from '../src/step-scope.ts';

/**
 * Une étape ne peut pas exécuter le pipeline entier.
 *
 * REVENUE-001 : dans la seule étape `discovery`, l'explorateur a passé
 * 4 `enrich_company`, 6 `find_contacts` et 6 `http_fetch`. Il a épuisé les
 * douze appels autorisés et 116 257 des 120 000 jetons de la mission avant que
 * la qualification ne démarre. Les six entreprises trouvées étaient réelles et
 * bien sourcées — mais aucune ne portait de score ni de verdict, donc aucune
 * n'était vendable.
 *
 * Le plan disait pourtant six étapes. Un plan qui décrit une séquence sans
 * pouvoir l'imposer ne décrit qu'une intention.
 */

/** La panoplie complète d'un explorateur, telle que ses compétences la donnent. */
const EXPLORER = [
  'discover_companies',
  'enrich_company',
  'find_contacts',
  'http_fetch',
  'record_evidence',
  'memory_search',
];

describe('la découverte reste la découverte', () => {
  test('elle peut chercher, lire et consigner', () => {
    const tools = toolsForAction('research', EXPLORER);
    assert.ok(tools.includes('discover_companies'));
    assert.ok(tools.includes('http_fetch'), 'lire un minimum établit qu’une entreprise existe');
    assert.ok(tools.includes('record_evidence'));
    assert.ok(tools.includes('memory_search'));
  });

  test('elle ne peut ni enrichir ni chercher des contacts', () => {
    const tools = toolsForAction('research', EXPLORER);
    assert.ok(!tools.includes('enrich_company'), 'l’enrichissement appartient à l’étape suivante');
    assert.ok(!tools.includes('find_contacts'), 'les contacts appartiennent à l’enrichissement');
  });

  test('le même agent retrouve ses outils à l’étape qui les justifie', () => {
    // La restriction porte sur l'étape, pas sur l'agent : l'explorateur sait
    // enrichir, et le fera — quand on le lui demandera.
    const tools = toolsForAction('collect', EXPLORER);
    assert.ok(tools.includes('enrich_company'));
    assert.ok(tools.includes('find_contacts'));
    assert.ok(!tools.includes('discover_companies'), 'l’enrichissement ne redécouvre pas');
  });
});

describe('chaque étape reste dans son rôle', () => {
  test('la qualification tranche, elle ne cherche pas', () => {
    const tools = toolsForAction('qualify', [
      'qualify_opportunity',
      'discover_companies',
      'enrich_company',
      'memory_search',
    ]);
    assert.deepEqual(tools.sort(), ['memory_search', 'qualify_opportunity']);
  });

  test('la notation note, elle ne qualifie pas', () => {
    const tools = toolsForAction('score', ['score_opportunity', 'qualify_opportunity']);
    assert.deepEqual(tools, ['score_opportunity']);
  });

  test('le classement classe, il ne renote pas depuis zéro', () => {
    const tools = toolsForAction('evaluate', ['rank_shortlist', 'enrich_company', 'find_contacts']);
    assert.deepEqual(tools, ['rank_shortlist']);
  });

  test('toutes les actions du pipeline commercial sont bornées', () => {
    const actions = scopedActions();
    for (const action of ['research', 'collect', 'qualify', 'score', 'evaluate', 'produce']) {
      assert.ok(actions.includes(action), `action « ${action} » non bornée`);
    }
  });
});

describe('la compatibilité de l’existant', () => {
  test('une action inconnue laisse la panoplie complète', () => {
    // Cette table décrit le pipeline commercial. Un plan ailleurs dans ATLAS —
    // évolution, opérations, atelier — ne doit pas se retrouver muet parce
    // qu'une action n'y figure pas : restreindre par défaut casserait
    // silencieusement des chemins qui fonctionnent.
    assert.deepEqual(toolsForAction('maintenance', EXPLORER), EXPLORER);
    assert.deepEqual(toolsForAction('', EXPLORER), EXPLORER);
    assert.deepEqual(withheldFrom('maintenance', EXPLORER), []);
  });

  test('un agent qui n’a pas l’outil ne le gagne pas', () => {
    // Le périmètre resserre, il n'élargit jamais : l'intersection de la
    // compétence et de l'étape, jamais leur union.
    const tools = toolsForAction('collect', ['http_fetch']);
    assert.deepEqual(tools, ['http_fetch']);
  });

  test('ce qui est retiré peut être nommé à l’agent', () => {
    // Un outil retiré sans explication se réclame tour après tour, ce qui coûte
    // exactement ce que la restriction voulait économiser.
    const withheld = withheldFrom('research', EXPLORER);
    assert.ok(withheld.includes('enrich_company'));
    assert.ok(withheld.includes('find_contacts'));
    assert.ok(!withheld.includes('discover_companies'));
  });

  test('la casse et les espaces d’une action ne la rendent pas inconnue', () => {
    assert.deepEqual(toolsForAction('  RESEARCH ', EXPLORER), toolsForAction('research', EXPLORER));
  });
});
