import type { Agent, VillageSnapshot } from '@atlas/contracts';
import { buildGraph, routeBetween, styleOf } from './layout.ts';

/**
 * La vie du village.
 *
 * Ce module décide de ce que chaque villageois *paraît* faire à un instant
 * donné. Deux sources, et la frontière entre elles est la chose la plus
 * importante de ce fichier.
 *
 *   L'état réel vient du serveur. Un agent au travail sur une étape, un trajet
 *   déclenché par une affectation d'Hermès, une erreur : cela se lit dans le
 *   cliché du village et rien ici ne peut l'inventer ni le contredire.
 *
 *   L'activité ambiante est fabriquée ici, et n'existe qu'ici. Elle occupe les
 *   agents que le serveur déclare disponibles, pour que la ville ne meure pas
 *   entre deux missions.
 *
 * Ce qui rend la séparation solide n'est pas une convention d'écriture : c'est
 * que ce module n'a aucun accès au serveur. Il ne reçoit qu'un cliché en
 * lecture, ne renvoie que des positions et des libellés, n'écrit dans aucune
 * base et n'émet aucun événement. Une réunion ambiante ne peut donc pas
 * produire un candidat, une preuve ou une décision — le chemin n'existe pas.
 *
 * Chaque occupation porte `real`. L'interface s'en sert pour dire, sans
 * ambiguïté, ce qui relève du travail et ce qui relève de la vie du village.
 */

// ─── Ce qu'un villageois peut être en train de faire ────────────────────────

export type OccupationKind =
  // Réel — dérivé de l'état que le serveur rapporte.
  | 'mission-task'
  | 'mission-transit'
  | 'incident'
  | 'offline'
  // Ambiant — fabriqué ici, sans effet sur quoi que ce soit.
  | 'briefing'
  | 'council'
  | 'team-meeting'
  | 'knowledge-review'
  | 'archive-consultation'
  | 'training'
  | 'maintenance'
  | 'inspection'
  | 'report-delivery'
  | 'logistics'
  | 'transit'
  | 'patrol';

export interface Occupation {
  kind: OccupationKind;
  /** Vrai lorsque le serveur est la source. Faux pour toute vie ambiante. */
  real: boolean;
  /** Ce que le villageois fait, en une phrase lisible. */
  label: string;
  /** Le bâtiment où l'occupation se déroule. */
  at: string;
  /** Les bâtiments traversés, du départ à l'arrivée. */
  path: string[];
  phase: 'travelling' | 'inside';
  /** Avancement le long du chemin, de 0 à 1. */
  progress: number;
  /** Les villageois partageant ce même identifiant sont réunis au même endroit. */
  groupId: string | null;
  /** Position dans le cercle de réunion, pour ne pas se marcher dessus. */
  seat: number;
  /** Horodatage de fin, en millisecondes. */
  until: number;
}

/** Le rythme collectif de la ville, lu sur l'état réel. */
export type CityMood = 'calm' | 'active' | 'council' | 'incident';

export interface CityPulse {
  mood: CityMood;
  label: string;
  detail: string;
  /** De 0 à 1 : combien la ville s'agite. Pilote l'ambiance du rendu. */
  intensity: number;
  realWorkers: number;
  ambientWorkers: number;
  gatherings: number;
}

interface Gathering {
  id: string;
  kind: 'briefing' | 'council' | 'team-meeting' | 'knowledge-review';
  at: string;
  members: string[];
  until: number;
  label: string;
}

// ─── Le catalogue des activités ambiantes ───────────────────────────────────

interface AmbientTemplate {
  kind: OccupationKind;
  /** Où cela se passe. Plusieurs choix possibles, tirés au sort. */
  places: string[];
  label: string;
  /** Durée sur place, en secondes. */
  dwell: [number, number];
  /** Poids relatif du tirage. */
  weight: number;
}

/**
 * Les occupations secondaires, communes à tous.
 *
 * Chacune correspond à quelque chose qu'une organisation fait réellement entre
 * deux commandes — ranger, se former, vérifier, transmettre. C'est ce qui donne
 * l'impression d'une société plutôt que d'une file d'attente.
 */
const AMBIENT: AmbientTemplate[] = [
  {
    kind: 'archive-consultation',
    places: ['central-library'],
    label: 'Consulte les archives',
    dwell: [12, 26],
    weight: 3,
  },
  {
    kind: 'knowledge-review',
    places: ['central-library', 'evolution-observatory'],
    label: 'Relit les enseignements des missions passées',
    dwell: [14, 28],
    weight: 2,
  },
  {
    kind: 'training',
    places: ['training-academy'],
    label: 'Révise ses compétences à l’académie',
    dwell: [16, 32],
    weight: 2,
  },
  {
    kind: 'maintenance',
    places: ['automation-factory', 'monitoring-station'],
    label: 'Entretien des automatismes',
    dwell: [12, 24],
    weight: 2,
  },
  {
    kind: 'inspection',
    places: ['monitoring-station', 'logistics-hub'],
    label: 'Tournée de supervision',
    dwell: [10, 20],
    weight: 2,
  },
  {
    kind: 'report-delivery',
    places: ['command-center', 'production-workshop'],
    label: 'Dépose un dossier',
    dwell: [8, 16],
    weight: 2,
  },
  {
    kind: 'logistics',
    places: ['logistics-hub'],
    label: 'Transfert de dossiers entre départements',
    dwell: [10, 20],
    weight: 2,
  },
  {
    kind: 'patrol',
    places: [],
    label: 'Rejoint son poste',
    dwell: [6, 12],
    weight: 1,
  },
];

/**
 * Ce que chaque spécialiste fait plus volontiers que les autres.
 *
 * Sans cela, tout le monde ferait tout, et le village perdrait ce qui le rend
 * lisible : on doit pouvoir deviner qui est qui à ce qu'il est en train de
 * faire. L'Archiviste vit près des archives, l'Ingénieur près des machines.
 */
const AFFINITY: Record<string, OccupationKind[]> = {
  explorer: ['archive-consultation', 'knowledge-review', 'inspection'],
  analyst: ['knowledge-review', 'archive-consultation', 'training'],
  ambassador: ['report-delivery', 'logistics', 'training'],
  architect: ['report-delivery', 'logistics', 'archive-consultation'],
  messenger: ['logistics', 'report-delivery', 'inspection'],
  archivist: ['archive-consultation', 'knowledge-review', 'training'],
  engineer: ['maintenance', 'inspection', 'logistics'],
  'evolution-manager': ['knowledge-review', 'inspection', 'training'],
};

/** Les salles où l'on se réunit, et ce qu'on y fait. */
const MEETING_ROOMS: Array<{ at: string; kind: Gathering['kind']; label: string }> = [
  { at: 'war-room', kind: 'briefing', label: 'Point de situation en salle de mission' },
  { at: 'strategy-hall', kind: 'council', label: 'Conseil de stratégie' },
  { at: 'strategy-hall', kind: 'team-meeting', label: 'Synchronisation entre départements' },
  { at: 'central-library', kind: 'knowledge-review', label: 'Revue des enseignements' },
];

// ─── Le directeur ───────────────────────────────────────────────────────────

const SECOND = 1000;

/** Entre deux réunions ambiantes. Assez rare pour rester un événement. */
const GATHERING_INTERVAL_MS = 42 * SECOND;
const GATHERING_DURATION_MS = 22 * SECOND;
const MIN_GATHERING_SIZE = 3;

/** Durée d'un déplacement ambiant, par bâtiment traversé. */
const TRAVEL_PER_HOP_MS = 3400;

export class VillageLife {
  #occupations = new Map<string, Occupation>();
  #gatherings: Gathering[] = [];
  #nextGatheringAt = Date.now() + 12 * SECOND;
  #graph = new Map<string, string[]>();
  #buildingKeys: string[] = [];
  #seed = 1;

  /**
   * Recalcule ce que fait chaque villageois.
   *
   * Appelé à chaque cliché du serveur, soit une fois par seconde. Les
   * occupations en cours sont conservées : ce qui n'est pas terminé continue,
   * sans quoi les villageois changeraient d'avis chaque seconde et l'ensemble
   * ressemblerait à une fourmilière prise de panique.
   */
  update(snapshot: VillageSnapshot, now = Date.now()): Map<string, Occupation> {
    this.#graph = buildGraph(snapshot.buildings);
    this.#buildingKeys = snapshot.buildings.map((b) => b.key);

    const journeys = new Map(snapshot.journeys.map((j) => [j.agentKey, j]));
    this.#gatherings = this.#gatherings.filter((g) => g.until > now);

    const alive = new Set<string>();

    for (const agent of snapshot.agents) {
      alive.add(agent.key);
      const real = this.#realOccupation(agent, journeys.get(agent.key), now);

      if (real) {
        // L'état réel l'emporte toujours, et coupe court à toute occupation
        // ambiante en cours : un agent affecté à une étape cesse d'arroser les
        // plantes, quoi qu'il fût en train de faire une seconde plus tôt.
        this.#occupations.set(agent.key, real);
        this.#leaveGatherings(agent.key);
        continue;
      }

      const current = this.#occupations.get(agent.key);
      if (current && current.until > now && !current.real) {
        this.#advance(current, now);
        continue;
      }
      // Un agent qui vient de terminer une étape repart d'où il était.
      this.#occupations.set(agent.key, this.#nextAmbient(agent, current, now));
    }

    for (const key of [...this.#occupations.keys()]) {
      if (!alive.has(key)) this.#occupations.delete(key);
    }

    this.#maybeGather(snapshot, now);
    return this.#occupations;
  }

  /**
   * L'état d'un villageois tel que le serveur le rapporte.
   *
   * Rend `null` quand le serveur le dit disponible : c'est le seul cas où la
   * vie ambiante a le droit de prendre la main.
   */
  #realOccupation(
    agent: Agent,
    journey: VillageSnapshot['journeys'][number] | undefined,
    now: number,
  ): Occupation | null {
    const status = agent.state.status;
    const home = agent.building;
    const where = agent.state.location || home;

    if (status === 'offline') {
      return {
        kind: 'offline',
        real: true,
        label: 'Hors service',
        at: where,
        path: [where],
        phase: 'inside',
        progress: 1,
        groupId: null,
        seat: 0,
        until: now + SECOND,
      };
    }

    if (status === 'error') {
      return {
        kind: 'incident',
        real: true,
        label: agent.state.currentActivity ?? 'Incident sur une étape',
        at: where,
        path: [where],
        phase: 'inside',
        progress: 1,
        groupId: null,
        seat: 0,
        until: now + SECOND,
      };
    }

    if (journey) {
      const elapsed = now - Date.parse(journey.startedAt);
      const progress = Math.max(0, Math.min(1, elapsed / Math.max(1, journey.durationMs)));
      return {
        kind: 'mission-transit',
        real: true,
        label: journey.reason,
        at: journey.to,
        path: this.#path(journey.from, journey.to),
        phase: progress < 1 ? 'travelling' : 'inside',
        progress,
        groupId: null,
        seat: 0,
        until: now + SECOND,
      };
    }

    if (status === 'working' || status === 'analyzing' || status === 'moving') {
      return {
        kind: 'mission-task',
        real: true,
        label: agent.state.currentActivity ?? 'Étape de mission',
        at: where,
        path: [where],
        phase: 'inside',
        progress: 1,
        groupId: null,
        seat: 0,
        until: now + SECOND,
      };
    }

    return null;
  }

  /** Choisit la prochaine occupation ambiante d'un villageois disponible. */
  #nextAmbient(agent: Agent, previous: Occupation | undefined, now: number): Occupation {
    const from = previous?.at ?? (agent.state.location || agent.building);

    // Une réunion en cours à laquelle il a été convoqué prime sur le reste.
    const gathering = this.#gatherings.find((g) => g.members.includes(agent.key));
    if (gathering) {
      const path = this.#path(from, gathering.at);
      return {
        kind: gathering.kind,
        real: false,
        label: gathering.label,
        at: gathering.at,
        path,
        phase: path.length > 1 ? 'travelling' : 'inside',
        progress: 0,
        groupId: gathering.id,
        seat: gathering.members.indexOf(agent.key),
        until: gathering.until,
      };
    }

    const template = this.#pickTemplate(agent);
    const place = this.#pickPlace(template, agent, from);
    const path = this.#path(from, place);
    const dwellMs = this.#between(template.dwell[0], template.dwell[1]) * SECOND;
    const travelMs = (path.length - 1) * TRAVEL_PER_HOP_MS;

    return {
      kind: template.kind,
      real: false,
      label: template.label,
      at: place,
      path,
      phase: path.length > 1 ? 'travelling' : 'inside',
      progress: 0,
      groupId: null,
      seat: 0,
      until: now + travelMs + dwellMs,
    };
  }

  /**
   * Fait avancer un déplacement ambiant.
   *
   * Le trajet occupe le début de l'occupation, le séjour le reste. Un villageois
   * qui apparaîtrait instantanément à destination annulerait tout l'intérêt du
   * réseau routier.
   */
  #advance(occupation: Occupation, now: number): void {
    if (occupation.phase !== 'travelling') return;

    const travelMs = (occupation.path.length - 1) * TRAVEL_PER_HOP_MS;
    if (travelMs <= 0) {
      occupation.phase = 'inside';
      occupation.progress = 1;
      return;
    }

    const startedAt = occupation.until - travelMs - this.#dwellOf(occupation);
    const elapsed = now - startedAt;
    const progress = Math.max(0, Math.min(1, elapsed / travelMs));

    occupation.progress = progress;
    if (progress >= 1) occupation.phase = 'inside';
  }

  /** Le temps passé sur place, déduit de ce qui n'est pas du trajet. */
  #dwellOf(occupation: Occupation): number {
    const template = AMBIENT.find((t) => t.kind === occupation.kind);
    if (!template) return GATHERING_DURATION_MS;
    return ((template.dwell[0] + template.dwell[1]) / 2) * SECOND;
  }

  /**
   * Convoque une réunion, de temps à autre.
   *
   * Trois participants au minimum : à deux c'est une conversation, et cela ne
   * se voit pas de loin. Seuls les villageois sans travail réel sont appelés —
   * détourner un agent d'une étape en cours pour faire joli serait exactement
   * le genre de mensonge que ce fichier existe pour éviter.
   */
  #maybeGather(snapshot: VillageSnapshot, now: number): void {
    if (now < this.#nextGatheringAt) return;
    this.#nextGatheringAt = now + GATHERING_INTERVAL_MS + this.#between(0, 20) * SECOND;

    const free = snapshot.agents.filter((agent) => {
      const occupation = this.#occupations.get(agent.key);
      return occupation && !occupation.real && occupation.groupId === null;
    });
    if (free.length < MIN_GATHERING_SIZE) return;

    const rooms = MEETING_ROOMS.filter((room) => this.#buildingKeys.includes(room.at));
    if (rooms.length === 0) return;

    // Une mission en cours appelle un point de situation ; au calme, on tient
    // plutôt conseil ou l'on revoit les enseignements.
    const busy = snapshot.activeMissions.length > 0;
    const candidates = busy
      ? rooms.filter((r) => r.kind === 'briefing' || r.kind === 'team-meeting')
      : rooms.filter((r) => r.kind !== 'briefing');
    const room = this.#pick(candidates.length > 0 ? candidates : rooms);

    const size = Math.min(free.length, MIN_GATHERING_SIZE + Math.floor(this.#random() * 2));
    const members = this.#shuffle(free.map((a) => a.key)).slice(0, size);

    const gathering: Gathering = {
      id: `g${now.toString(36)}`,
      kind: room.kind,
      at: room.at,
      members,
      until: now + GATHERING_DURATION_MS,
      label: room.label,
    };
    this.#gatherings.push(gathering);

    // Les convoqués partent immédiatement : la convocation se voit.
    for (const key of members) {
      const agent = snapshot.agents.find((a) => a.key === key);
      if (!agent) continue;
      const current = this.#occupations.get(key);
      const from = current?.at ?? agent.building;
      const path = this.#path(from, gathering.at);

      this.#occupations.set(key, {
        kind: gathering.kind,
        real: false,
        label: gathering.label,
        at: gathering.at,
        path,
        phase: path.length > 1 ? 'travelling' : 'inside',
        progress: 0,
        groupId: gathering.id,
        seat: members.indexOf(key),
        until: gathering.until,
      });
    }
  }

  #leaveGatherings(agentKey: string): void {
    for (const gathering of this.#gatherings) {
      const index = gathering.members.indexOf(agentKey);
      if (index !== -1) gathering.members.splice(index, 1);
    }
    this.#gatherings = this.#gatherings.filter((g) => g.members.length >= 2);
  }

  /** Les réunions en cours, pour que le rendu puisse les dessiner. */
  gatherings(): ReadonlyArray<{ id: string; at: string; size: number; label: string }> {
    return this.#gatherings.map((g) => ({
      id: g.id,
      at: g.at,
      size: g.members.length,
      label: g.label,
    }));
  }

  /**
   * Le rythme de la ville, lu sur l'état réel uniquement.
   *
   * L'ambiance visuelle peut monter, mais c'est toujours une mission réelle ou
   * une erreur réelle qui la fait monter — jamais une réunion ambiante.
   */
  pulse(snapshot: VillageSnapshot): CityPulse {
    const occupations = [...this.#occupations.values()];
    const realWorkers = occupations.filter((o) => o.real && o.kind !== 'offline').length;
    const ambientWorkers = occupations.filter((o) => !o.real).length;
    const incidents = snapshot.agents.filter((a) => a.state.status === 'error').length;
    const missions = snapshot.activeMissions.length;

    if (incidents > 0) {
      return {
        mood: 'incident',
        label: 'Incident',
        detail: `${incidents} spécialiste(s) en erreur — le quartier concerné passe en alerte`,
        intensity: 1,
        realWorkers,
        ambientWorkers,
        gatherings: this.#gatherings.length,
      };
    }

    if (missions > 0) {
      return {
        mood: 'active',
        label: 'Mission en cours',
        detail: `${missions} mission(s) réelle(s), ${realWorkers} spécialiste(s) au travail`,
        intensity: Math.min(1, 0.55 + missions * 0.15),
        realWorkers,
        ambientWorkers,
        gatherings: this.#gatherings.length,
      };
    }

    if (this.#gatherings.length > 0) {
      return {
        mood: 'council',
        label: 'Réunion',
        detail: `${this.#gatherings[0]!.label} — activité de village, sans effet métier`,
        intensity: 0.4,
        realWorkers,
        ambientWorkers,
        gatherings: this.#gatherings.length,
      };
    }

    return {
      mood: 'calm',
      label: 'Calme',
      detail: `Aucune mission en cours · ${ambientWorkers} spécialiste(s) à leurs occupations`,
      intensity: 0.22,
      realWorkers,
      ambientWorkers,
      gatherings: 0,
    };
  }

  // ─── Petits utilitaires ───────────────────────────────────────────────────

  #path(from: string, to: string): string[] {
    return routeBetween(this.#graph, from, to);
  }

  #pickTemplate(agent: Agent): AmbientTemplate {
    const preferred = AFFINITY[agent.key] ?? [];
    const pool = AMBIENT.filter((t) => t.places.length === 0 || this.#exists(t.places));

    // Deux tirages sur trois suivent l'affinité du spécialiste ; le troisième
    // l'en écarte, sans quoi chacun referait éternellement la même chose.
    if (preferred.length > 0 && this.#random() < 0.66) {
      const affine = pool.filter((t) => preferred.includes(t.kind));
      if (affine.length > 0) return this.#pick(affine);
    }

    const total = pool.reduce((sum, t) => sum + t.weight, 0);
    let ticket = this.#random() * total;
    for (const template of pool) {
      ticket -= template.weight;
      if (ticket <= 0) return template;
    }
    return pool[0] ?? AMBIENT[AMBIENT.length - 1]!;
  }

  /** Un lieu qui existe vraiment ; à défaut, le bâtiment d'attache. */
  #pickPlace(template: AmbientTemplate, agent: Agent, from: string): string {
    const places = template.places.filter((p) => this.#buildingKeys.includes(p));
    if (places.length === 0) {
      // « Rejoint son poste » : le district d'attache, ou un voisin.
      const neighbours = (this.#graph.get(from) ?? []).filter((k) => k !== from);
      const sameDistrict = neighbours.filter(
        (k) => styleOf(k).district === styleOf(agent.building).district,
      );
      const pool = sameDistrict.length > 0 ? sameDistrict : neighbours;
      return pool.length > 0 ? this.#pick(pool) : agent.building;
    }
    // Rester sur place n'est pas une activité : on préfère bouger.
    const elsewhere = places.filter((p) => p !== from);
    return this.#pick(elsewhere.length > 0 ? elsewhere : places);
  }

  #exists(places: string[]): boolean {
    return places.some((p) => this.#buildingKeys.includes(p));
  }

  /**
   * Générateur pseudo-aléatoire propre au module.
   *
   * `Math.random` ferait l'affaire, mais un état interne rend la vie du village
   * reproductible dans un test : la même suite d'appels produit la même
   * chorégraphie.
   */
  #random(): number {
    this.#seed = (this.#seed * 1664525 + 1013904223) >>> 0;
    return this.#seed / 4294967296;
  }

  #pick<T>(list: T[]): T {
    return list[Math.floor(this.#random() * list.length)]!;
  }

  #between(min: number, max: number): number {
    return min + this.#random() * (max - min);
  }

  #shuffle<T>(list: T[]): T[] {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.#random() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}

/** Libellés courts, pour les puces et les légendes. */
export const OCCUPATION_LABEL: Record<OccupationKind, string> = {
  'mission-task': 'Étape de mission',
  'mission-transit': 'En route pour une étape',
  incident: 'Incident',
  offline: 'Hors service',
  briefing: 'Point de situation',
  council: 'Conseil',
  'team-meeting': 'Synchronisation',
  'knowledge-review': 'Revue des enseignements',
  'archive-consultation': 'Consultation des archives',
  training: 'Formation',
  maintenance: 'Maintenance',
  inspection: 'Supervision',
  'report-delivery': 'Remise de dossier',
  logistics: 'Logistique',
  transit: 'Déplacement',
  patrol: 'Rejoint son poste',
};
