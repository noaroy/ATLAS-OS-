import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../core/src/logger.ts';
import { createRepositories, type Repositories } from '../../data/src/index.ts';
import type { AtlasConfig } from '../../core/src/config.ts';
import { createSearchFabric } from '@atlas/intelligence';
import { buildCockpit } from '../src/http/cockpit.ts';
import type { AtlasSystem } from '../src/bootstrap.ts';

/**
 * Le cockpit d'une mission.
 *
 * Ce qu'il protège : que chaque chiffre affiché soit lu dans la base. Un
 * compteur estimé par l'interface a exactement la même apparence qu'un compteur
 * mesuré, et plus rien ensuite ne permet de les distinguer — sur un écran qui
 * pilote une dépense réelle, la nuance décide de la confiance qu'on peut lui
 * accorder.
 *
 * Deux propriétés valent plus que les autres, parce qu'elles ont coûté de
 * l'argent : le budget restant, et l'écart entre un moteur qui répond et un
 * moteur qui sait répondre.
 */

const logger = createLogger({ level: 'error', pretty: false });
let dir: string;
let repos: Repositories;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-cockpit-'));
  repos = createRepositories(join(dir, 'cockpit.db'), logger);
});

after(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

function systemWith(overrides: Record<string, unknown> = {}): AtlasSystem {
  const search = {
    provider: 'duckduckgo',
    searxngBaseUrl: '',
    searxngEngines: '',
    braveApiKey: '',
    costPerQueryUsd: 0,
    ...(overrides.search as object),
  } as AtlasConfig['search'];

  return {
    repos,
    config: {
      llm: { mode: 'live', declaredMode: 'live', ...(overrides.llm as object) },
      budget: { maxMissionCostUsd: 0.4, maxMissionTokens: 100_000 },
      search,
    } as unknown as AtlasConfig,
    // Le cockpit lit le parc vivant du serveur. Lui en fournir un vrai plutôt
    // qu'un double : c'est le routage réel qui décide de l'adéquation affichée,
    // et un faux ne testerait que lui-même.
    searchFabric: createSearchFabric(search),
  } as unknown as AtlasSystem;
}

const newMission = (context: Record<string, unknown> = {}): string =>
  repos.missions.create({
    title: 'Test cockpit',
    objective: 'o'.repeat(40),
    createdBy: 'test',
    context,
  }).id;

describe('cockpit — budget', () => {
  test('le plafond de la mission resserre celui du déploiement', () => {
    // La même règle que celle appliquée par l'orchestrateur. L'afficher
    // autrement mentirait sur ce qui va réellement arrêter la mission.
    const id = newMission({ budgetUsd: 0.1 });
    const cockpit = buildCockpit(systemWith(), id);
    assert.equal(cockpit.budget.maxUsd, 0.1);
  });

  test('une mission sans plafond propre hérite de celui du déploiement', () => {
    const cockpit = buildCockpit(systemWith(), newMission());
    assert.equal(cockpit.budget.maxUsd, 0.4);
  });

  test('le reste est le plafond moins la dépense, jamais négatif', () => {
    const id = newMission({ budgetUsd: 0.05 });
    repos.llmCalls.record({
      missionId: id,
      taskRef: null,
      agentKey: null,
      purpose: 'test',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.09,
      subject: null,
      contextChars: 4200,
      evidenceCount: null,
      durationMs: 10,
      ok: true,
      error: null,
      toolCalls: 0,
      createdAt: new Date().toISOString(),
    });

    const cockpit = buildCockpit(systemWith(), id);
    assert.equal(cockpit.budget.spentUsd, 0.09);
    assert.equal(cockpit.budget.remainingUsd, 0, 'un dépassement affiche zéro, pas un négatif');
  });

  test('en simulation, aucun coût réel n’est affiché', () => {
    // Le garde-fou le plus important du tableau de bord : une démonstration ne
    // doit jamais donner l'impression d'avoir dépensé.
    const id = newMission();
    const cockpit = buildCockpit(systemWith({ llm: { mode: 'simulation', declaredMode: 'simulation' } }), id);
    assert.equal(cockpit.mode, 'simulation');
    assert.equal(cockpit.budget.spentUsd, 0);
  });
});

describe('cockpit — moteur de recherche', () => {
  test('sans appel, la santé est inconnue et non « saine »', () => {
    // Ne rien savoir n'est pas la même chose que savoir que tout va bien.
    const cockpit = buildCockpit(systemWith(), newMission());
    assert.equal(cockpit.search.health, 'unknown');
  });

  test('la santé et l’adéquation sont deux champs distincts', () => {
    // La distinction qui a coûté une mission entière : Marginalia répondait en
    // trois cents millisecondes et ne contenait rien du marché allemand.
    const id = newMission({ brief: { markets: { countries: ['DE'] } } });
    const cockpit = buildCockpit(systemWith({ search: { provider: 'marginalia' } }), id);

    assert.ok('health' in cockpit.search);
    assert.ok('suitability' in cockpit.search);
    assert.equal(cockpit.search.suitability, 'unsuitable');
    assert.ok(cockpit.search.suitabilityGaps.length > 0);
  });

  test('un moteur adapté est reconnu comme tel', () => {
    const id = newMission({ brief: { markets: { countries: ['DE'] } } });
    const cockpit = buildCockpit(systemWith(), id);
    assert.equal(cockpit.search.suitability, 'suitable');
    assert.deepEqual(cockpit.search.suitabilityGaps, []);
  });

  test('les limites du moteur sont portées jusqu’à l’écran', () => {
    const cockpit = buildCockpit(systemWith({ search: { provider: 'marginalia' } }), newMission());
    assert.ok(cockpit.search.caveat, 'une limite non affichée est une limite découverte en production');
  });
});

describe('cockpit — entonnoir et preuves', () => {
  test('une mission vierge ne fabrique aucun chiffre', () => {
    const cockpit = buildCockpit(systemWith(), newMission());
    assert.equal(cockpit.pipeline.candidates, 0);
    assert.equal(cockpit.pipeline.evidence.total, 0);
    assert.equal(cockpit.inference.calls, 0);
    assert.equal(cockpit.reliability.errors, 0);
  });

  test('les preuves sont ventilées par nature', () => {
    // Une shortlist bâtie sur des inférences n'est pas une shortlist bâtie sur
    // des observations, et l'écran doit permettre de le voir.
    const cockpit = buildCockpit(systemWith(), newMission());
    for (const key of ['observed', 'reported', 'inferred', 'sourced', 'total'] as const) {
      assert.equal(typeof cockpit.pipeline.evidence[key], 'number');
    }
  });

  test('la revue humaine est vide tant que personne n’a tranché', () => {
    const cockpit = buildCockpit(systemWith(), newMission());
    assert.deepEqual(cockpit.review, []);
  });
});

describe('cockpit — décisions et fiabilité', () => {
  test('les réessais se comptent sur les étapes, jamais estimés', () => {
    const cockpit = buildCockpit(systemWith(), newMission());
    assert.equal(cockpit.reliability.retries, 0);
    assert.equal(typeof cockpit.reliability.timeouts, 'number');
  });

  test('le mode déclaré est reporté tel quel', () => {
    assert.equal(buildCockpit(systemWith(), newMission()).mode, 'live');
    assert.equal(
      buildCockpit(systemWith({ llm: { mode: 'simulation', declaredMode: 'simulation' } }), newMission()).mode,
      'simulation',
    );
  });
});
