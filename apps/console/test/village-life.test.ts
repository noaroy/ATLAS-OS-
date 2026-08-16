import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, AgentStatus, Building, VillageSnapshot } from '@atlas/contracts';
import { BUILDINGS } from '@atlas/agents';
import { VillageLife } from '../src/village/life.ts';
import { buildGraph, resolveRoads, routeBetween, styleOf } from '../src/village/layout.ts';

/**
 * La vie du village, et la frontière qu'elle ne doit jamais franchir.
 *
 * Ces tests protègent une promesse produit : la cité peut sembler vivante en
 * permanence, mais rien de ce qui la fait vivre ne doit pouvoir passer pour un
 * résultat métier. Une réunion inventée est une animation ; une découverte est
 * une donnée. Confondre les deux ferait d'un tableau de bord un argumentaire.
 */

const BUILDING_LIST: Building[] = BUILDINGS.map(({ sortOrder: _sortOrder, ...building }) => building);

function agentFor(key: string, status: AgentStatus, building: string, activity: string | null = null): Agent {
  return {
    key,
    name: key,
    role: 'test',
    tier: 'business',
    building,
    mission: '',
    skills: [],
    actions: [],
    mandates: [],
    systemPrompt: '',
    model: null,
    maxSteps: 6,
    appearance: { hue: 200, accent: '#38bdf8', silhouette: 'scout', emblem: '◆' },
    enabled: true,
    state: {
      key,
      status,
      currentMissionId: null,
      currentTaskId: null,
      currentActivity: activity,
      location: building,
      destination: null,
      lastActiveAt: null,
    },
    metrics: {
      key,
      tasksTotal: 0,
      tasksSucceeded: 0,
      tasksFailed: 0,
      successRate: 100,
      avgDurationMs: 0,
      tokensUsed: 0,
      qualityScore: 0,
      lastTaskAt: null,
    },
    tools: [],
  } as Agent;
}

function snapshotOf(agents: Agent[], overrides: Partial<VillageSnapshot> = {}): VillageSnapshot {
  return {
    buildings: BUILDING_LIST,
    agents,
    activeMissions: [],
    journeys: [],
    stats: {
      population: agents.length,
      activeAgents: 0,
      missionsToday: 0,
      missionsTotal: 0,
      knowledgeItems: 0,
      prosperity: 0,
      vitality: 80,
    },
    departments: [],
    generatedAt: new Date().toISOString(),
    ...overrides,
  } as VillageSnapshot;
}

const IDLE_TEAM = [
  agentFor('explorer', 'available', 'research-tower'),
  agentFor('analyst', 'available', 'analysis-lab'),
  agentFor('archivist', 'available', 'central-library'),
  agentFor('engineer', 'available', 'automation-factory'),
];

describe('la carte de la cité', () => {
  test('chaque bâtiment déclaré a une identité visuelle', () => {
    for (const building of BUILDING_LIST) {
      const style = styleOf(building.key);
      assert.notEqual(style.short, '—', `${building.key} retombe sur le style de secours`);
      assert.ok(style.glyph.length > 0);
    }
  });

  test('le réseau routier relie tous les bâtiments', () => {
    // Un bâtiment sans route est un bâtiment qu'aucun villageois ne peut
    // rejoindre à pied : il aurait l'air habité sans jamais l'être.
    const graph = buildGraph(BUILDING_LIST);
    for (const building of BUILDING_LIST) {
      assert.ok(
        (graph.get(building.key) ?? []).length > 0,
        `${building.key} n'est relié à aucune route`,
      );
    }
  });

  test('un trajet existe entre deux bâtiments quelconques', () => {
    const graph = buildGraph(BUILDING_LIST);
    for (const from of BUILDING_LIST) {
      for (const to of BUILDING_LIST) {
        const path = routeBetween(graph, from.key, to.key);
        assert.equal(path[0], from.key);
        assert.equal(path[path.length - 1], to.key);
      }
    }
  });

  test('aucune route ne pointe vers un bâtiment inexistant', () => {
    const keys = new Set(BUILDING_LIST.map((b) => b.key));
    for (const road of resolveRoads(BUILDING_LIST)) {
      assert.ok(keys.has(road.from) && keys.has(road.to));
    }
  });

  test('les salles de réunion existent réellement', () => {
    // La vie ambiante y convoque des agents ; si elles manquaient, les réunions
    // se tiendraient dans le vide.
    const keys = new Set(BUILDING_LIST.map((b) => b.key));
    for (const room of ['strategy-hall', 'war-room', 'central-library']) {
      assert.ok(keys.has(room), `${room} est absent de la carte`);
    }
  });
});

describe('la vie du village', () => {
  test("aucun villageois ne reste sans rien faire", () => {
    // « Au repos » ne doit jamais vouloir dire immobile : c'est l'exigence
    // centrale de la cité vivante.
    const life = new VillageLife();
    const occupations = life.update(snapshotOf(IDLE_TEAM));

    assert.equal(occupations.size, IDLE_TEAM.length);
    for (const agent of IDLE_TEAM) {
      const occupation = occupations.get(agent.key);
      assert.ok(occupation, `${agent.key} n'a aucune occupation`);
      assert.ok(occupation.label.length > 0);
      assert.notEqual(occupation.kind, 'offline');
    }
  });

  test('toute activité sans mission est marquée comme ambiante', () => {
    const life = new VillageLife();
    const occupations = life.update(snapshotOf(IDLE_TEAM));

    for (const occupation of occupations.values()) {
      assert.equal(
        occupation.real,
        false,
        `« ${occupation.label} » se présente comme réelle alors qu'aucune mission ne tourne`,
      );
    }
  });

  test("l'état réel écrase toujours l'activité ambiante", () => {
    const life = new VillageLife();
    life.update(snapshotOf(IDLE_TEAM));

    // L'Explorateur reçoit une vraie étape. Ce qu'il faisait doit céder.
    const working = [
      agentFor('explorer', 'working', 'research-tower', 'Recherche de partenaires'),
      ...IDLE_TEAM.slice(1),
    ];
    const occupations = life.update(snapshotOf(working));

    const explorer = occupations.get('explorer')!;
    assert.equal(explorer.real, true);
    assert.equal(explorer.kind, 'mission-task');
    assert.equal(explorer.label, 'Recherche de partenaires');
    assert.equal(explorer.groupId, null, 'un agent au travail ne peut pas rester en réunion');
  });

  test('un trajet réel suit ce que le serveur annonce', () => {
    const life = new VillageLife();
    const startedAt = new Date().toISOString();
    const occupations = life.update(
      snapshotOf(IDLE_TEAM, {
        journeys: [
          {
            agentKey: 'explorer',
            from: 'command-center',
            to: 'research-tower',
            missionId: 'msn_1',
            reason: 'Trouver des partenaires',
            startedAt,
            durationMs: 2600,
          },
        ],
      }),
    );

    const explorer = occupations.get('explorer')!;
    assert.equal(explorer.real, true);
    assert.equal(explorer.kind, 'mission-transit');
    assert.equal(explorer.at, 'research-tower');
    assert.equal(explorer.path[0], 'command-center');
    assert.equal(explorer.path[explorer.path.length - 1], 'research-tower');
  });

  test("le rythme n'est « actif » que sur une mission réelle", () => {
    const life = new VillageLife();

    // Beaucoup d'agitation ambiante, aucune mission : la ville reste calme.
    const calm = snapshotOf(IDLE_TEAM);
    life.update(calm);
    const calmPulse = life.pulse(calm);
    assert.ok(['calm', 'council'].includes(calmPulse.mood));
    assert.equal(calmPulse.realWorkers, 0);
    assert.ok(calmPulse.ambientWorkers > 0, 'la ville doit tout de même vivre');

    // Une vraie mission, et seulement alors, fait monter l'intensité.
    const busy = snapshotOf([agentFor('explorer', 'working', 'research-tower'), ...IDLE_TEAM.slice(1)], {
      activeMissions: [{ id: 'msn_1', title: 'M', status: 'running', progress: 0.3 }] as never,
    });
    life.update(busy);
    const busyPulse = life.pulse(busy);
    assert.equal(busyPulse.mood, 'active');
    assert.ok(busyPulse.intensity > calmPulse.intensity);
    assert.equal(busyPulse.realWorkers, 1);
  });

  test('une erreur réelle bascule la ville en incident', () => {
    const life = new VillageLife();
    const broken = snapshotOf([agentFor('analyst', 'error', 'analysis-lab', 'Étape échouée'), ...IDLE_TEAM]);
    life.update(broken);
    const pulse = life.pulse(broken);

    assert.equal(pulse.mood, 'incident');
    assert.equal(pulse.intensity, 1);
  });

  test('une réunion réunit plusieurs agents au même endroit', () => {
    const life = new VillageLife();
    const snapshot = snapshotOf(IDLE_TEAM);

    // Les réunions sont espacées ; on avance le temps jusqu'à la première.
    let gathered: ReturnType<VillageLife['gatherings']> = [];
    for (let tick = 0; tick < 400 && gathered.length === 0; tick++) {
      life.update(snapshot, Date.now() + tick * 1000);
      gathered = life.gatherings();
    }

    assert.ok(gathered.length > 0, 'aucune réunion ne se tient jamais');
    const meeting = gathered[0]!;
    assert.ok(meeting.size >= 2, 'une réunion à un seul participant ne se voit pas');
    assert.ok(
      BUILDING_LIST.some((b) => b.key === meeting.at),
      'la réunion se tient dans un bâtiment inexistant',
    );
  });

  test('une réunion ne détourne jamais un agent au travail', () => {
    const life = new VillageLife();
    const team = [
      agentFor('explorer', 'working', 'research-tower', 'Étape réelle'),
      agentFor('analyst', 'analyzing', 'analysis-lab', 'Étape réelle'),
      ...IDLE_TEAM.slice(2),
    ];

    for (let tick = 0; tick < 400; tick++) {
      const occupations = life.update(snapshotOf(team), Date.now() + tick * 1000);
      for (const key of ['explorer', 'analyst']) {
        const occupation = occupations.get(key)!;
        assert.equal(occupation.real, true, `${key} a été détourné par la vie du village`);
        assert.equal(occupation.groupId, null, `${key} a été convoqué alors qu'il travaillait`);
      }
    }
  });

  test('un villageois se rend dans un bâtiment qui existe', () => {
    const life = new VillageLife();
    const keys = new Set(BUILDING_LIST.map((b) => b.key));

    for (let tick = 0; tick < 300; tick++) {
      const occupations = life.update(snapshotOf(IDLE_TEAM), Date.now() + tick * 1000);
      for (const occupation of occupations.values()) {
        assert.ok(keys.has(occupation.at), `destination inconnue : ${occupation.at}`);
        for (const step of occupation.path) {
          assert.ok(keys.has(step), `étape de trajet inconnue : ${step}`);
        }
      }
    }
  });

  test('la chorégraphie est reproductible', () => {
    // Deux instances, la même suite d'appels, le même résultat : c'est ce qui
    // rend une régression visuelle observable plutôt que anecdotique.
    const start = Date.now();
    const first = new VillageLife();
    const second = new VillageLife();

    for (let tick = 0; tick < 60; tick++) {
      const a = first.update(snapshotOf(IDLE_TEAM), start + tick * 1000);
      const b = second.update(snapshotOf(IDLE_TEAM), start + tick * 1000);
      assert.deepEqual(
        [...a.entries()].map(([k, v]) => [k, v.kind, v.at]),
        [...b.entries()].map(([k, v]) => [k, v.kind, v.at]),
      );
    }
  });
});
