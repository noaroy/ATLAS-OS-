import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestSystem, type TestSystem } from '@atlas/testing';
import { UNREPEATABLE_SEARCH_OUTCOMES } from '@atlas/intelligence';
import type { Mission } from '@atlas/contracts';

/**
 * Une consigne n'est pas un garde-fou.
 *
 * LIVE #004 : la recherche a expiré, l'outil a répondu « ne relancez pas la
 * même recherche, la cause est technique et ne changera pas d'elle-même », et
 * l'Explorateur a relancé deux fois. Ce qui l'a finalement arrêté n'est pas la
 * consigne mais un plafond — 12 appels par étape.
 *
 * Ce que le système doit empêcher, il doit l'empêcher : un appel identique à
 * un appel déjà techniquement échoué est refusé avant d'atteindre le
 * fournisseur. Une stratégie réellement différente reste autorisée.
 */

let system: TestSystem | null = null;

afterEach(() => {
  system?.cleanup();
  system = null;
});

/** Une mission de département, prête à recevoir des appels d'outils. */
function scenario(): { sys: TestSystem; mission: Mission } {
  const sys = createTestSystem({ handler: async () => ({ kind: 'text', text: 'ok' }) });
  const mission = sys.repos.missions.create({
    title: 'Recherche',
    objective: 'Trouver des partenaires.',
    createdBy: 'test',
    departmentKey: 'business-expansion',
  });
  return { sys, mission };
}

/** Enregistre un appel de recherche tel que la plateforme le ferait. */
function recordSearch(
  sys: TestSystem,
  missionId: string,
  signature: string,
  outcome: string,
  ok = false,
): void {
  sys.repos.toolCalls.record({
    missionId,
    taskRef: 'discovery',
    agentKey: 'explorer',
    tool: 'discover_companies',
    category: 'research',
    durationMs: 180_000,
    ok,
    error: ok ? null : 'expiré',
    external: true,
    signature,
    outcome,
    createdAt: new Date().toISOString(),
  });
}

describe('un appel identique après une panne est refusé', () => {
  test('une recherche ayant expiré est reconnue', () => {
    const { sys, mission } = scenario();
    system = sys;

    recordSearch(sys, mission.id, 'distributor::allemagne::::emballage::', 'timeout');

    const blocked = sys.repos.toolCalls.hasFailedWithSignature(
      mission.id,
      'discover_companies',
      'distributor::allemagne::::emballage::',
      UNREPEATABLE_SEARCH_OUTCOMES,
    );
    assert.ok(blocked, "l'appel identique doit être reconnu comme déjà échoué");
    assert.equal(blocked.outcome, 'timeout');
  });

  test('une panne de fournisseur bloque elle aussi', () => {
    const { sys, mission } = scenario();
    system = sys;

    recordSearch(sys, mission.id, 'sig-a', 'provider-failure');
    assert.ok(
      sys.repos.toolCalls.hasFailedWithSignature(
        mission.id,
        'discover_companies',
        'sig-a',
        UNREPEATABLE_SEARCH_OUTCOMES,
      ),
    );
  });

  test('une recherche réellement différente reste autorisée', () => {
    // « packaging machinery distributors Germany » échoue ; « industrial
    // automation integrators Germany » doit rester tentable — c'est une vraie
    // stratégie différente, pas un entêtement.
    const { sys, mission } = scenario();
    system = sys;

    recordSearch(sys, mission.id, 'distributor::allemagne::::emballage::', 'timeout');

    assert.equal(
      sys.repos.toolCalls.hasFailedWithSignature(
        mission.id,
        'discover_companies',
        'integrator::allemagne::::automatisation::',
        UNREPEATABLE_SEARCH_OUTCOMES,
      ),
      null,
      'un autre angle du marché doit rester possible',
    );
  });

  test('un résultat vide ne bloque pas — le marché a pu être mal interrogé', () => {
    // Distinction volontaire : « rien trouvé » est un constat que l'agent peut
    // légitimement vouloir revérifier autrement. Seule une panne technique
    // rend le rejeu certainement inutile.
    const { sys, mission } = scenario();
    system = sys;

    recordSearch(sys, mission.id, 'sig-b', 'success-empty', true);
    assert.equal(
      sys.repos.toolCalls.hasFailedWithSignature(
        mission.id,
        'discover_companies',
        'sig-b',
        UNREPEATABLE_SEARCH_OUTCOMES,
      ),
      null,
    );
  });

  test('un refus budgétaire n’est pas mémorisé — le budget est déjà souverain', () => {
    const { sys, mission } = scenario();
    system = sys;

    recordSearch(sys, mission.id, 'sig-c', 'budget-cancelled');
    assert.equal(
      sys.repos.toolCalls.hasFailedWithSignature(
        mission.id,
        'discover_companies',
        'sig-c',
        UNREPEATABLE_SEARCH_OUTCOMES,
      ),
      null,
    );
  });

  test('le blocage ne franchit pas la frontière d’une mission', () => {
    // Une panne réseau d'hier ne doit pas condamner la recherche d'aujourd'hui.
    const { sys, mission } = scenario();
    system = sys;
    const autre = sys.repos.missions.create({
      title: 'Autre',
      objective: 'Autre objectif.',
      createdBy: 'test',
      departmentKey: 'business-expansion',
    });

    recordSearch(sys, mission.id, 'sig-partagée', 'timeout');
    assert.equal(
      sys.repos.toolCalls.hasFailedWithSignature(
        autre.id,
        'discover_companies',
        'sig-partagée',
        UNREPEATABLE_SEARCH_OUTCOMES,
      ),
      null,
    );
  });

  test('un autre outil n’est pas concerné', () => {
    const { sys, mission } = scenario();
    system = sys;

    recordSearch(sys, mission.id, 'sig-d', 'timeout');
    assert.equal(
      sys.repos.toolCalls.hasFailedWithSignature(
        mission.id,
        'find_contacts',
        'sig-d',
        UNREPEATABLE_SEARCH_OUTCOMES,
      ),
      null,
    );
  });
});

describe("l'appel bloqué ne coûte rien", () => {
  test('aucun jeton, aucun appel au fournisseur', async () => {
    const { sys, mission } = scenario();
    system = sys;

    sys.repos.missions.replaceTasks(mission.id, [
      {
        ref: 'discovery',
        title: 'Chercher',
        agentKey: 'explorer',
        action: 'research',
        instruction: 'Cherchez.',
        input: {},
        dependsOn: [],
        maxAttempts: 1,
      },
    ]);
    const task = sys.repos.missions.tasksFor(mission.id)[0]!;

    const input = {
      targetTypes: ['distributor'],
      countries: ['Allemagne'],
      industries: ["Machines d'emballage"],
    };

    const ctx = {
      missionId: mission.id,
      taskId: task.id,
      taskRef: 'discovery',
      departmentKey: 'business-expansion',
      agentKey: 'explorer',
      config: sys.config,
      repos: sys.repos,
      memory: sys.memory,
      events: sys.events,
      logger: sys.logger,
      automation: null,
      intelligence: sys.intelligence,
      discovery: sys.discovery,
    };

    // Premier appel : il atteint le service, qui n'a aucun provider réel en
    // test et rend une liste vide. On enregistre l'échec à sa place.
    const first = await sys.registry.invoke(
      'discover_companies',
      input,
      ['discover_companies'],
      ctx as never,
    );
    const signature = (first.result.data as { signature?: string } | undefined)?.signature;
    assert.ok(signature, "l'appel doit porter une empreinte");

    recordSearch(sys, mission.id, signature, 'timeout');

    const callsBefore = sys.provider.calls.length;
    const second = await sys.registry.invoke(
      'discover_companies',
      input,
      ['discover_companies'],
      ctx as never,
    );

    assert.equal(second.result.isError, true, "l'appel identique doit être refusé");
    assert.equal(
      (second.result.data as { outcome?: string }).outcome,
      'duplicate-blocked',
      "l'issue doit nommer la raison du refus",
    );
    assert.match(second.result.content, /Changez réellement de stratégie/);
    assert.equal(
      sys.provider.calls.length,
      callsBefore,
      'aucun appel au fournisseur ne doit partir',
    );
  });
});

describe("l'empreinte identifie la stratégie, pas la formulation", () => {
  test('la casse et l’ordre des mots-clés ne créent pas deux recherches', async () => {
    const { sys, mission } = scenario();
    system = sys;

    const ctx = {
      missionId: mission.id,
      taskId: null,
      taskRef: 'discovery',
      agentKey: 'explorer',
      config: sys.config,
      repos: sys.repos,
      memory: sys.memory,
      events: sys.events,
      logger: sys.logger,
      automation: null,
      intelligence: sys.intelligence,
      discovery: sys.discovery,
    };

    const a = await sys.registry.invoke(
      'discover_companies',
      { targetTypes: ['distributor'], countries: ['Allemagne'], keywords: ['Emballage', 'Ligne'] },
      ['discover_companies'],
      ctx as never,
    );
    const b = await sys.registry.invoke(
      'discover_companies',
      { targetTypes: ['distributor'], countries: ['allemagne'], keywords: ['ligne', 'emballage'] },
      ['discover_companies'],
      ctx as never,
    );

    assert.equal(
      (a.result.data as { signature: string }).signature,
      (b.result.data as { signature: string }).signature,
      'la même stratégie doit produire la même empreinte',
    );
  });

  test('la limite de résultats ne fait pas une autre recherche', async () => {
    // Sinon il suffirait de changer un chiffre pour contourner le blocage.
    const { sys, mission } = scenario();
    system = sys;

    const ctx = {
      missionId: mission.id,
      taskId: null,
      taskRef: 'discovery',
      agentKey: 'explorer',
      config: sys.config,
      repos: sys.repos,
      memory: sys.memory,
      events: sys.events,
      logger: sys.logger,
      automation: null,
      intelligence: sys.intelligence,
      discovery: sys.discovery,
    };

    const a = await sys.registry.invoke(
      'discover_companies',
      { targetTypes: ['distributor'], countries: ['Allemagne'], limit: 2 },
      ['discover_companies'],
      ctx as never,
    );
    const b = await sys.registry.invoke(
      'discover_companies',
      { targetTypes: ['distributor'], countries: ['Allemagne'], limit: 20 },
      ['discover_companies'],
      ctx as never,
    );

    assert.equal(
      (a.result.data as { signature: string }).signature,
      (b.result.data as { signature: string }).signature,
    );
  });

  test('un rôle différent produit une empreinte différente', async () => {
    const { sys, mission } = scenario();
    system = sys;

    const ctx = {
      missionId: mission.id,
      taskId: null,
      taskRef: 'discovery',
      agentKey: 'explorer',
      config: sys.config,
      repos: sys.repos,
      memory: sys.memory,
      events: sys.events,
      logger: sys.logger,
      automation: null,
      intelligence: sys.intelligence,
      discovery: sys.discovery,
    };

    const a = await sys.registry.invoke(
      'discover_companies',
      { targetTypes: ['distributor'], countries: ['Allemagne'] },
      ['discover_companies'],
      ctx as never,
    );
    const b = await sys.registry.invoke(
      'discover_companies',
      { targetTypes: ['integrator'], countries: ['Allemagne'] },
      ['discover_companies'],
      ctx as never,
    );

    assert.notEqual(
      (a.result.data as { signature: string }).signature,
      (b.result.data as { signature: string }).signature,
    );
  });
});

describe('la télémétrie conserve empreinte et issue', () => {
  test('chaque appel de recherche est enregistré avec son issue', async () => {
    const { sys, mission } = scenario();
    system = sys;

    await sys.registry.invoke(
      'discover_companies',
      { targetTypes: ['distributor'], countries: ['Allemagne'] },
      ['discover_companies'],
      {
        missionId: mission.id,
        taskId: null,
        taskRef: 'discovery',
        agentKey: 'explorer',
        config: sys.config,
        repos: sys.repos,
        memory: sys.memory,
        events: sys.events,
        logger: sys.logger,
        automation: null,
        intelligence: sys.intelligence,
        discovery: sys.discovery,
      } as never,
    );

    const recorded = sys.repos.toolCalls
      .forMission(mission.id)
      .filter((c) => c.tool === 'discover_companies');

    assert.equal(recorded.length, 1);
    assert.ok(recorded[0]!.signature, "l'empreinte doit être conservée");
    assert.ok(recorded[0]!.outcome, "l'issue doit être conservée");
    assert.equal(recorded[0]!.external, true);
  });
});

// ─── Registre métier vide : refus structurel ──────────────────────────────

describe('memory_search sur un registre métier vide', () => {
  test('est refusé avant tout travail, sans coût', async () => {
    // LIVE #004 puis LIVE #005 ont porté l'information dans le briefing — « le
    // registre est vide, n'interrogez pas la mémoire » — et l'agent a cherché
    // quand même : sept fois, puis cinq. Une information n'est pas un garde-fou.
    const { sys, mission } = scenario();
    system = sys;

    assert.equal(sys.repos.companies.count(), 0, 'le test suppose un registre vierge');

    const ctx = {
      missionId: mission.id,
      taskId: null,
      taskRef: 'discovery',
      agentKey: 'explorer',
      config: sys.config,
      repos: sys.repos,
      memory: sys.memory,
      events: sys.events,
      logger: sys.logger,
      automation: null,
      intelligence: sys.intelligence,
      discovery: sys.discovery,
    };

    const before = sys.provider.calls.length;
    const result = await sys.registry.invoke(
      'memory_search',
      { query: 'distributeurs allemands' },
      ['memory_search'],
      ctx as never,
    );

    assert.equal(result.result.isError, true);
    assert.match(result.result.content, /EMPTY_BUSINESS_REGISTRY/);
    assert.equal(
      (result.result.data as { outcome?: string }).outcome,
      'empty-business-registry',
    );
    assert.equal(sys.provider.calls.length, before, 'aucun appel LLM ne doit partir');
  });

  test('la mémoire système reste accessible pour ses usages propres', async () => {
    // Deux réserves distinctes : le refus vise la recherche métier, pas la
    // mémoire d'ATLAS.
    const { sys, mission } = scenario();
    system = sys;

    sys.memory.remember({
      kind: 'lesson',
      title: 'Leçon de fonctionnement',
      content: 'Une observation système, sans rapport avec des entreprises.',
      importance: 0.8,
    });

    const result = await sys.registry.invoke(
      'memory_search',
      { query: 'leçon', tier: 'operational' },
      ['memory_search'],
      {
        missionId: mission.id,
        taskId: null,
        taskRef: 'discovery',
        agentKey: 'explorer',
        config: sys.config,
        repos: sys.repos,
        memory: sys.memory,
        events: sys.events,
        logger: sys.logger,
        automation: null,
        intelligence: sys.intelligence,
        discovery: sys.discovery,
      } as never,
    );

    assert.equal(result.result.isError, false, 'la mémoire système n’est pas concernée');
  });

  test('dès qu’une entreprise existe, la recherche métier reprend', async () => {
    const { sys, mission } = scenario();
    system = sys;

    sys.repos.companies.upsert({
      canonicalKey: 'd:deja-connue.de',
      name: 'Déjà Connue GmbH',
      website: 'https://deja-connue.de',
      domain: 'deja-connue.de',
      country: 'Allemagne',
      industries: [],
    });

    const result = await sys.registry.invoke(
      'memory_search',
      { query: 'distributeurs allemands' },
      ['memory_search'],
      {
        missionId: mission.id,
        taskId: null,
        taskRef: 'discovery',
        agentKey: 'explorer',
        config: sys.config,
        repos: sys.repos,
        memory: sys.memory,
        events: sys.events,
        logger: sys.logger,
        automation: null,
        intelligence: sys.intelligence,
        discovery: sys.discovery,
      } as never,
    );

    assert.equal(result.result.isError, false);
    assert.ok(!result.result.content.includes('EMPTY_BUSINESS_REGISTRY'));
  });
});
