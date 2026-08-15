import type {
  Agent,
  Building,
  VillageDepartmentActivity,
  VillageJourney,
  VillageSnapshot,
  VillageStats,
} from '@atlas/contracts';
import type { EventBus } from '@atlas/core';
import { nowIso, startOfTodayIso } from '@atlas/core';
import type { Repositories } from '@atlas/data';

/** How long a journey stays visible before the traveller is considered arrived. */
const JOURNEY_TTL_MS = 6000;

/** Les états qui signifient qu'un travail est réellement en cours sur place. */
const WORKING_STATES = new Set<Agent['state']['status']>(['working', 'analyzing']);

/**
 * Builds the live view of ATLAS Village (SRS §3).
 *
 * Every element is derived from real state — no decorative movement. A walking
 * inhabitant means an agent was genuinely dispatched; a building at alert means
 * a step there actually failed. That correspondence is the whole point of the
 * immersive mode, so nothing here is allowed to invent activity.
 */
export class VillageService {
  #journeys: VillageJourney[] = [];
  #unsubscribe: (() => void) | null = null;

  constructor(
    private readonly repos: Repositories,
    private readonly events: EventBus,
  ) {}

  /** Listens for real dispatch events and turns them into visible journeys. */
  start(): void {
    if (this.#unsubscribe) return;

    this.#unsubscribe = this.events.on('agent.journey', (event) => {
      const payload = event.payload as {
        from?: string;
        to?: string;
        reason?: string;
        durationMs?: number;
      };
      if (!event.agentKey || !payload.from || !payload.to) return;

      this.#journeys = this.#journeys.filter((j) => j.agentKey !== event.agentKey);
      this.#journeys.push({
        agentKey: event.agentKey,
        from: payload.from,
        to: payload.to,
        missionId: event.missionId,
        reason: payload.reason ?? 'On assignment',
        startedAt: event.createdAt,
        durationMs: payload.durationMs ?? 2600,
      });
      this.#prune();
    });
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  snapshot(): VillageSnapshot {
    this.#prune();

    // Disabled agents are shown as `offline` rather than hidden: a specialist
    // that has been taken out of service is information, not absence.
    const agents = this.repos.agents.list();
    const activeMissions = this.repos.missions.listByStatus('running', 'planned', 'assigned');
    const buildings = this.#withLiveStatus(this.repos.buildings.list(), agents);

    return {
      buildings,
      agents,
      activeMissions,
      journeys: [...this.#journeys],
      stats: this.#stats(agents),
      departments: this.#departmentActivity(),
      generatedAt: nowIso(),
    };
  }

  /**
   * What each department is actually doing, keyed to the building that houses it.
   *
   * Every number here is counted from stored rows, so a busy-looking building is
   * a building where work genuinely happened (Article XII). Nothing in the
   * village is animated from anything other than a real event.
   */
  #departmentActivity(): VillageDepartmentActivity[] {
    return this.repos.departments.list(true).map((department) => {
      const missions = this.repos.missions
        .listByStatus('running', 'planned', 'assigned')
        .filter((m) => m.departmentKey === department.key);

      return {
        key: department.key,
        name: department.name,
        building: department.building,
        activeMissions: missions.length,
        opportunitiesDiscovered: this.repos.opportunities.countForDepartment(department.key),
        opportunitiesShortlisted: this.repos.opportunities.countForDepartment(department.key, [
          'shortlisted',
        ]),
        teams: department.teams.length,
      };
    });
  }

  /**
   * Le statut d'un bâtiment, dérivé de l'état des agents à l'instant de la vue.
   *
   * La colonne stockée est rafraîchie par le battement du superviseur, toutes
   * les trente secondes. Le village, lui, est diffusé chaque seconde : lire le
   * stockage laissait donc un bâtiment éteint jusqu'à une demi-minute après
   * qu'un agent y avait commencé son travail — et une étape de simulation dure
   * deux secondes. Le villageois s'animait dans un bâtiment resté sombre, et le
   * Command Center annonçait « en cours » ce que le Village montrait au repos.
   *
   * Dériver ici coûte un parcours de la liste des agents et n'écrit rien. Le
   * rafraîchissement périodique reste utile : il persiste l'état et fait
   * décroître l'activité accumulée.
   */
  #withLiveStatus(buildings: Building[], agents: Agent[]): Building[] {
    const busy = new Set<string>();
    const alert = new Set<string>();

    for (const agent of agents) {
      const where = agent.state.location || agent.building;
      if (agent.state.status === 'error') alert.add(where);
      else if (WORKING_STATES.has(agent.state.status)) busy.add(where);
    }

    return buildings.map((building) => {
      const status: Building['status'] = alert.has(building.key)
        ? 'alert'
        : busy.has(building.key)
          ? 'busy'
          : building.status === 'alert'
            ? // Une alerte stockée sans agent en erreur vient d'une panne que le
              // battement n'a pas encore effacée : on la conserve, c'est une
              // information, mais elle s'éteindra d'elle-même.
              'alert'
            : 'nominal';

      return status === building.status ? building : { ...building, status };
    });
  }

  /**
   * Clears an alert on a building once its department is working again — the
   * village must recover visually, not stay red forever after one failure.
   */
  refreshBuildingStatus(): void {
    const agents = this.repos.agents.list();
    const busyBuildings = new Set(
      agents.filter((a) => a.state.status === 'working' || a.state.status === 'analyzing').map((a) => a.building),
    );
    const erroredBuildings = new Set(
      agents.filter((a) => a.state.status === 'error').map((a) => a.building),
    );

    for (const building of this.repos.buildings.list()) {
      if (erroredBuildings.has(building.key)) {
        this.repos.buildings.setStatus(building.key, 'alert');
      } else if (busyBuildings.has(building.key)) {
        this.repos.buildings.setStatus(building.key, 'busy');
      } else if (building.status !== 'nominal') {
        this.repos.buildings.setStatus(building.key, 'nominal');
      }
    }

    // Activity fades slowly, so a village that goes quiet stops looking busy.
    this.repos.buildings.decayActivity(0.995);
  }

  #stats(agents: Agent[]): VillageStats {
    const counts = this.repos.missions.countsByStatus();
    const missionsTotal = Object.values(counts).reduce((a, b) => a + b, 0);
    const missionsToday = this.repos.missions.countSince(startOfTodayIso(), [
      'completed',
      'validated',
      'archived',
    ]);

    const activeAgents = agents.filter((a) =>
      ['working', 'analyzing', 'moving'].includes(a.state.status),
    ).length;
    const erroredAgents = agents.filter((a) => a.state.status === 'error').length;
    const openAlerts = this.repos.ops.openAlertCount();
    const knowledge = this.repos.memory.total();

    const failed = counts.failed ?? 0;
    const finished = missionsToday + failed;
    const successRate = finished > 0 ? missionsToday / finished : 1;

    // Vitality blends outcomes, faults and alerts into one readable number that
    // drives the village's ambience.
    const vitality = Math.round(
      Math.max(
        0,
        Math.min(
          100,
          successRate * 70 + Math.max(0, 30 - openAlerts * 6) - erroredAgents * 5,
        ),
      ),
    );

    // Prosperity grows with accumulated knowledge and delivered missions, so
    // the village visibly reflects the organisation getting richer over time.
    const prosperity = Math.round(
      Math.min(100, Math.log10(knowledge + 1) * 24 + Math.log10(missionsTotal + 1) * 18),
    );

    return {
      population: agents.length,
      activeAgents,
      missionsToday,
      missionsTotal,
      knowledgeItems: knowledge,
      prosperity,
      vitality,
    };
  }

  #prune(): void {
    const cutoff = Date.now() - JOURNEY_TTL_MS;
    this.#journeys = this.#journeys.filter((j) => Date.parse(j.startedAt) > cutoff);
  }
}
