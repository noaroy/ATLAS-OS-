import type { Agent, Building, VillageSnapshot } from '@atlas/contracts';
import {
  DISTRICTS,
  districtOf,
  frameCity,
  project,
  resolveRoads,
  styleOf,
  TILE_H,
  TILE_W,
  type RoadSegment,
} from './layout.ts';
import { VillageLife, type CityPulse, type Occupation } from './life.ts';
import { heightOf, paintBuilding } from './buildings.ts';
import { drawCharacter } from './people.ts';
import { isoCylinder, isoFootprint, isoPrism, roundRect, withAlpha } from './draw.ts';

/**
 * La cité ATLAS.
 *
 * Une scène isométrique où chaque élément renvoie à quelque chose de réel : la
 * hauteur d'un bâtiment est son niveau accumulé, l'anneau à son pied est son
 * statut, et un habitant ne marche que parce qu'une occupation le déplace.
 *
 * Le rendu vise une ville, pas un schéma. La différence tient à trois choses :
 * un sol continu plutôt qu'un fond vide, des rues avec une largeur et des
 * bordures plutôt que des traits entre des nœuds, et des silhouettes propres à
 * chaque bâtiment plutôt qu'une boîte recolorée. Un diagramme relie des points ;
 * une ville occupe un terrain.
 *
 * Deux registres cohabitent, et le rendu les distingue à l'œil.
 *
 *   Le travail réel — étapes de mission, incidents — brille : auréole marquée,
 *   étincelles, rues qui s'illuminent sur le trajet emprunté.
 *
 *   La vie ambiante — réunions, archives, maintenance — est présente mais
 *   sourde : pas d'étincelles, une auréole faible, un liseré discret.
 *
 * Un observateur doit pouvoir dire, sans lire une légende, si la ville travaille
 * ou si elle vit. C'est la condition pour qu'une cité animée en permanence ne
 * devienne pas un mensonge sur l'activité métier.
 */

export interface HitTarget {
  kind: 'building' | 'agent';
  key: string;
  label: string;
  screenX: number;
  screenY: number;
}

interface Camera {
  x: number;
  y: number;
  zoom: number;
}

interface AgentVisual {
  key: string;
  name: string;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  /** Dernier déplacement à l'écran, pour orienter la silhouette. */
  facing: -1 | 1;
  phase: number;
  hue: number;
  accent: string;
  emblem: string;
  status: Agent['state']['status'];
  occupation: Occupation | null;
  moving: boolean;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
}

/**
 * Une petite structure secondaire : abri, cuve, conteneur, annexe technique.
 *
 * Ce sont des éléments de décor urbain, au même titre que les lampadaires. Ils
 * ne portent aucun nom de département, ne sont pas cliquables et n'apparaissent
 * dans aucun panneau — sans quoi la ville prétendrait avoir des fonctions
 * qu'ATLAS n'a pas. Leur seul rôle est de combler les vides entre les parvis,
 * pour qu'un quartier ressemble à un quartier plutôt qu'à un bâtiment posé au
 * milieu du sol.
 */
interface Annex {
  x: number;
  y: number;
  /** Demi-largeur de l'empreinte, en pixels écran. */
  w: number;
  h: number;
  kind: 'block' | 'tank' | 'crates' | 'canopy';
  accent: string;
  shade: number;
}

/** Une navette aérienne, qui relie deux bâtiments. */
interface Drone {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  t: number;
  speed: number;
  altitude: number;
}

/** Une navette de fret sur une rue : de l'infrastructure, pas un habitant. */
interface Freight {
  road: RoadSegment;
  t: number;
  speed: number;
  direction: 1 | -1;
}

/** Demi-largeur d'une chaussée, en pixels écran. */
const ROAD_HALF = 12;

/**
 * Agrandissement des habitants.
 *
 * Ils doivent rester petits devant les bâtiments — c'est ce qui donne l'échelle
 * urbaine — mais restaient illisibles au cadrage par défaut. 1,55 les rend
 * visibles sans qu'ils cessent d'être des habitants.
 */
const CHARACTER_SCALE = 1.55;

const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class VillageRenderer {
  #canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D;
  #raf: number | null = null;
  #time = 0;

  #snapshot: VillageSnapshot | null = null;
  #life = new VillageLife();
  #occupations = new Map<string, Occupation>();
  #pulse: CityPulse | null = null;
  #roads: RoadSegment[] = [];
  #buildingByKey = new Map<string, Building>();

  #camera: Camera = { x: 0, y: 0, zoom: 1 };
  #targetCamera: Camera = { x: 0, y: 0, zoom: 1 };
  #agents = new Map<string, AgentVisual>();
  #sparks: Spark[] = [];
  #freight: Freight[] = [];
  #annexes: Annex[] = [];
  #drones: Drone[] = [];
  #stars: Array<{ x: number; y: number; r: number; twinkle: number }> = [];

  #pointer = { x: 0, y: 0, inside: false };
  #hover: HitTarget | null = null;
  #hitTargets: Array<HitTarget & { radius: number }> = [];

  #dragging = false;
  #dragStart = { x: 0, y: 0, camX: 0, camY: 0 };
  #reduceMotion = false;

  #lastReport = 0;

  onSelect: ((target: HitTarget | null) => void) | null = null;
  onHover: ((target: HitTarget | null) => void) | null = null;
  /** Remonte l'état de la ville à l'interface, quatre fois par seconde. */
  onTick: ((pulse: CityPulse, occupations: Map<string, Occupation>) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error("Le canevas 2D n'est pas disponible dans ce navigateur");
    this.#ctx = ctx;

    this.#reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.#seedStars();
    this.#bindEvents();
    this.resize();
  }

  // ─── Cycle de vie ────────────────────────────────────────────────────────

  start(): void {
    if (this.#raf !== null) return;
    let last = performance.now();

    const loop = (now: number): void => {
      const delta = Math.min(64, now - last);
      last = now;
      this.#time += delta;
      this.#update(delta, now);
      this.#draw();
      this.#raf = requestAnimationFrame(loop);
    };
    this.#raf = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.#raf !== null) cancelAnimationFrame(this.#raf);
    this.#raf = null;
  }

  destroy(): void {
    this.stop();
    this.#unbindEvents();
  }

  update(snapshot: VillageSnapshot): void {
    const first = this.#snapshot === null;
    this.#snapshot = snapshot;
    this.#buildingByKey = new Map(snapshot.buildings.map((b) => [b.key, b]));
    this.#roads = resolveRoads(snapshot.buildings);
    this.#seedFreight();
    this.#seedAnnexes(snapshot);
    this.#seedDrones(snapshot);
    if (first) this.fit();
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.#canvas.getBoundingClientRect();
    this.#canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.#canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.#ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.#seedStars();
    // Recadrer : sans cela, une fenêtre agrandie laisse la ville minuscule dans
    // un coin, et une fenêtre rétrécie la fait déborder.
    this.fit();
  }

  /** Cadre la cité dans la vue, en la faisant occuper l'essentiel de l'écran. */
  fit(): void {
    if (!this.#snapshot || this.#snapshot.buildings.length === 0) return;
    const rect = this.#canvas.getBoundingClientRect();
    const frame = frameCity(this.#snapshot.buildings, rect.width, rect.height);
    this.#targetCamera = { x: frame.x, y: frame.y, zoom: frame.zoom };
    this.#camera = { ...this.#targetCamera };
  }

  zoomBy(factor: number): void {
    this.#targetCamera.zoom = Math.max(0.2, Math.min(2.6, this.#targetCamera.zoom * factor));
  }

  focusBuilding(key: string): void {
    const building = this.#buildingByKey.get(key);
    if (!building) return;
    const { sx, sy } = project(building.x, building.y);
    this.#targetCamera = { x: sx, y: sy - 50, zoom: Math.max(this.#targetCamera.zoom, 1.1) };
  }

  // ─── Mise à jour ─────────────────────────────────────────────────────────

  #update(delta: number, now: number): void {
    const step = delta / 1000;
    const snapshot = this.#snapshot;

    this.#camera.x += (this.#targetCamera.x - this.#camera.x) * Math.min(1, step * 6);
    this.#camera.y += (this.#targetCamera.y - this.#camera.y) * Math.min(1, step * 6);
    this.#camera.zoom += (this.#targetCamera.zoom - this.#camera.zoom) * Math.min(1, step * 6);

    if (snapshot) {
      this.#occupations = this.#life.update(snapshot, now);
      this.#pulse = this.#life.pulse(snapshot);
      this.#syncAgents(snapshot);

      if (now - this.#lastReport > 250) {
        this.#lastReport = now;
        this.onTick?.(this.#pulse, this.#occupations);
      }
    }

    for (const agent of this.#agents.values()) {
      const lerp = Math.min(1, step * (agent.moving ? 6 : 3.5));
      const dx = agent.targetX - agent.x;
      const dy = agent.targetY - agent.y;

      // L'orientation suit le déplacement *à l'écran*, pas dans la grille :
      // c'est ce que l'œil compare.
      const screenDx = (dx - dy) * (TILE_W / 2);
      if (Math.abs(screenDx) > 0.015) agent.facing = screenDx > 0 ? 1 : -1;

      agent.x += dx * lerp;
      agent.y += dy * lerp;
      // Le cycle de marche n'avance que si l'habitant marche ; sinon les jambes
      // pédaleraient sur place.
      agent.phase += step * (agent.moving ? 11 : 0);

      const working = agent.occupation?.real === true && agent.occupation.kind === 'mission-task';
      if (!this.#reduceMotion && working && Math.random() < step * 3) {
        const { sx, sy } = project(agent.x, agent.y);
        this.#sparks.push({
          x: sx,
          y: sy - 26,
          vx: (Math.random() - 0.5) * 18,
          vy: -18 - Math.random() * 22,
          life: 0,
          maxLife: 0.7 + Math.random() * 0.5,
          color: agent.accent,
        });
      }
    }

    for (const spark of this.#sparks) {
      spark.life += step;
      spark.x += spark.vx * step;
      spark.y += spark.vy * step;
      spark.vy += 14 * step;
    }
    this.#sparks = this.#sparks.filter((s) => s.life < s.maxLife).slice(-240);

    for (const drone of this.#drones) {
      drone.t += drone.speed * step;
      if (drone.t > 1) drone.t -= 1;
    }

    for (const cart of this.#freight) {
      cart.t += cart.speed * step * cart.direction;
      if (cart.t > 1) {
        cart.t = 0;
        cart.direction = Math.random() > 0.5 ? 1 : -1;
      }
      if (cart.t < 0) cart.t = 1;
    }
  }

  #syncAgents(snapshot: VillageSnapshot): void {
    const seen = new Set<string>();
    const occupancy = new Map<string, number>();
    const groupSizes = new Map<string, number>();

    for (const occupation of this.#occupations.values()) {
      if (occupation.groupId) {
        groupSizes.set(occupation.groupId, (groupSizes.get(occupation.groupId) ?? 0) + 1);
      }
    }

    for (const agent of snapshot.agents) {
      seen.add(agent.key);
      const occupation = this.#occupations.get(agent.key) ?? null;
      const position = this.#positionFor(agent, occupation, occupancy, groupSizes);
      if (!position) continue;

      const moving = occupation?.phase === 'travelling';
      const existing = this.#agents.get(agent.key);

      if (existing) {
        existing.targetX = position.x;
        existing.targetY = position.y;
        existing.status = agent.state.status;
        existing.occupation = occupation;
        existing.moving = moving;
        existing.hue = agent.appearance.hue;
        existing.accent = agent.appearance.accent;
        existing.name = agent.name;
      } else {
        this.#agents.set(agent.key, {
          key: agent.key,
          name: agent.name,
          x: position.x,
          y: position.y,
          targetX: position.x,
          targetY: position.y,
          facing: 1,
          phase: Math.random() * Math.PI * 2,
          hue: agent.appearance.hue,
          accent: agent.appearance.accent,
          emblem: agent.appearance.emblem,
          status: agent.state.status,
          occupation,
          moving,
        });
      }
    }

    for (const key of [...this.#agents.keys()]) {
      if (!seen.has(key)) this.#agents.delete(key);
    }
  }

  #positionFor(
    agent: Agent,
    occupation: Occupation | null,
    occupancy: Map<string, number>,
    groupSizes: Map<string, number>,
  ): { x: number; y: number } | null {
    const fallback = this.#buildingByKey.get(agent.state.location || agent.building);
    if (!occupation) {
      if (!fallback) return null;
      return this.#slotAround(fallback, occupancy);
    }

    if (occupation.phase === 'travelling' && occupation.path.length > 1) {
      return this.#alongPath(occupation.path, occupation.progress);
    }

    const destination = this.#buildingByKey.get(occupation.at) ?? fallback;
    if (!destination) return null;

    if (occupation.groupId) {
      const size = Math.max(2, groupSizes.get(occupation.groupId) ?? 2);
      const angle = (occupation.seat / size) * Math.PI * 2;
      return {
        x: destination.x + Math.cos(angle) * 0.66,
        y: destination.y + Math.sin(angle) * 0.66 + 0.5,
      };
    }

    return this.#slotAround(destination, occupancy);
  }

  /** Une place libre sur le parvis, répartie en spirale dorée. */
  #slotAround(building: Building, occupancy: Map<string, number>): { x: number; y: number } {
    const slot = occupancy.get(building.key) ?? 0;
    occupancy.set(building.key, slot + 1);
    const angle = slot * 2.39996 + 0.6;
    const radius = 0.52 + (slot % 3) * 0.14;
    return { x: building.x + Math.cos(angle) * radius, y: building.y + Math.sin(angle) * radius + 0.42 };
  }

  #alongPath(path: string[], progress: number): { x: number; y: number } | null {
    const points = path
      .map((key) => this.#buildingByKey.get(key))
      .filter((b): b is Building => Boolean(b))
      .map((b) => ({ x: b.x, y: b.y }));

    if (points.length === 0) return null;
    if (points.length === 1) return points[0]!;

    const lengths: number[] = [];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const d = Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
      lengths.push(d);
      total += d;
    }
    if (total === 0) return points[0]!;

    let travelled = easeInOut(Math.max(0, Math.min(1, progress))) * total;
    for (let i = 0; i < lengths.length; i++) {
      if (travelled <= lengths[i]!) {
        const t = lengths[i]! === 0 ? 0 : travelled / lengths[i]!;
        return {
          x: points[i]!.x + (points[i + 1]!.x - points[i]!.x) * t,
          y: points[i]!.y + (points[i + 1]!.y - points[i]!.y) * t,
        };
      }
      travelled -= lengths[i]!;
    }
    return points[points.length - 1]!;
  }

  /**
   * Sème les structures secondaires autour de chaque bâtiment.
   *
   * Déterministe à partir de la clé du bâtiment : la ville a la même allure
   * d'une session à l'autre, ce qui la rend reconnaissable. Les positions sont
   * choisies hors des chaussées et hors du parvis, dans l'espace qui restait
   * vide entre deux quartiers.
   */
  #seedAnnexes(snapshot: VillageSnapshot): void {
    this.#annexes = [];

    for (const building of snapshot.buildings) {
      const style = styleOf(building.key);
      // Le cœur garde sa place dégagée : on n'encombre pas une place publique.
      const count = building.key === 'command-center' ? 2 : 3 + (hash(building.key) % 2);

      for (let i = 0; i < count; i++) {
        const seed = hash(`${building.key}:${i}`);
        const angle = ((seed % 360) / 360) * Math.PI * 2;
        const distance = 1.25 + ((seed >> 9) % 60) / 100;
        const kinds: Annex['kind'][] = ['block', 'tank', 'crates', 'canopy'];

        this.#annexes.push({
          x: building.x + Math.cos(angle) * distance,
          y: building.y + Math.sin(angle) * distance * 0.9,
          w: 11 + ((seed >> 3) % 9),
          h: 9 + ((seed >> 6) % 16),
          kind: kinds[seed % kinds.length]!,
          accent: style.accent,
          shade: 0.7 + ((seed >> 12) % 30) / 100,
        });
      }
    }
  }

  /** Sème quelques navettes aériennes entre bâtiments voisins. */
  #seedDrones(snapshot: VillageSnapshot): void {
    const roads = this.#roads.slice(0, 10);
    this.#drones = roads
      .filter((_, i) => i % 2 === 0)
      .map((road, i) => ({
        fromX: road.ax,
        fromY: road.ay,
        toX: road.bx,
        toY: road.by,
        t: (i * 0.21) % 1,
        speed: 0.055 + (i % 3) * 0.02,
        altitude: 74 + (i % 4) * 18,
      }));
    void snapshot;
  }

  /**
   * Une structure secondaire.
   *
   * Volontairement simple : ces objets doivent meubler sans attirer l'œil. Un
   * décor qui se remarque autant qu'un bâtiment fonctionnel brouillerait la
   * lecture de la ville.
   */
  #drawAnnex(annex: Annex): void {
    const ctx = this.#ctx;
    const { sx, sy } = project(annex.x, annex.y);
    const palette = { left: '#16233a', right: '#101a2c', roof: '#1d2d47', accent: annex.accent };

    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.beginPath();
    ctx.ellipse(sx + 3, sy + 2, annex.w * 0.95, annex.w * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();

    switch (annex.kind) {
      case 'tank':
        isoCylinder(ctx, sx, sy, annex.w * 0.7, annex.h, palette, annex.shade);
        ctx.strokeStyle = withAlpha(annex.accent, 0.22);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(sx, sy - annex.h * 0.55, annex.w * 0.7, annex.w * 0.35, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;

      case 'crates':
        // Trois caisses empilées en escalier.
        for (let i = 0; i < 3; i++) {
          isoPrism(
            ctx,
            sx + (i - 1) * annex.w * 0.5,
            sy + (i % 2) * 3,
            annex.w * 0.42,
            annex.w * 0.21,
            annex.h * (0.4 + (i % 2) * 0.3),
            palette,
            annex.shade + i * 0.08,
          );
        }
        break;

      case 'canopy': {
        // Un auvent sur quatre pieds : de l'espace couvert, pas un bâtiment.
        const top = sy - annex.h;
        ctx.strokeStyle = 'rgba(90, 125, 170, 0.5)';
        ctx.lineWidth = 1.4;
        for (const dx of [-annex.w * 0.8, annex.w * 0.8]) {
          ctx.beginPath();
          ctx.moveTo(sx + dx, sy);
          ctx.lineTo(sx + dx, top);
          ctx.stroke();
        }
        ctx.fillStyle = withAlpha(annex.accent, 0.18);
        isoFootprint(ctx, sx, top, annex.w, annex.w * 0.5);
        ctx.fill();
        ctx.strokeStyle = withAlpha(annex.accent, 0.3);
        ctx.stroke();
        break;
      }

      case 'block':
      default:
        isoPrism(ctx, sx, sy, annex.w, annex.w * 0.5, annex.h, palette, annex.shade);
        // Une lucarne éclairée : le décor vit lui aussi, faiblement.
        ctx.fillStyle = withAlpha(
          annex.accent,
          0.18 + Math.sin(this.#time / 1700 + annex.x * 2) * 0.1,
        );
        ctx.fillRect(sx - annex.w * 0.45, sy - annex.h * 0.6, 4, 5);
        break;
    }
  }

  /**
   * Les navettes aériennes.
   *
   * Elles suivent les rues, en altitude. Comme le fret au sol, ce sont des
   * mouvements d'infrastructure : elles ne transportent aucun agent et ne
   * représentent aucune tâche.
   */
  #drawDrones(): void {
    if (this.#reduceMotion) return;
    const ctx = this.#ctx;

    for (const drone of this.#drones) {
      const a = project(drone.fromX, drone.fromY);
      const b = project(drone.toX, drone.toY);
      // Aller-retour : une navette qui disparaît au bout serait un artefact.
      const t = drone.t < 0.5 ? drone.t * 2 : 2 - drone.t * 2;
      const x = a.sx + (b.sx - a.sx) * t;
      const groundY = a.sy + (b.sy - a.sy) * t;
      const y = groundY - drone.altitude - Math.sin(this.#time / 900 + drone.t * 6) * 4;

      // Ombre au sol : elle donne l'altitude.
      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      ctx.beginPath();
      ctx.ellipse(x, groundY, 5, 2, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = 'rgba(60, 96, 140, 0.95)';
      ctx.beginPath();
      ctx.ellipse(x, y, 6, 2.6, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = 'rgba(125, 211, 252, 0.35)';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(x - 8, y - 1.5);
      ctx.lineTo(x + 8, y - 1.5);
      ctx.stroke();

      const blink = 0.35 + Math.sin(this.#time / 300 + drone.t * 10) * 0.35;
      ctx.fillStyle = `rgba(186, 230, 253, ${blink})`;
      ctx.beginPath();
      ctx.arc(x + 6, y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  #seedFreight(): void {
    if (this.#freight.length > 0 || this.#roads.length === 0) return;
    const count = Math.min(8, this.#roads.length);
    this.#freight = Array.from({ length: count }, (_, i) => ({
      road: this.#roads[(i * 3) % this.#roads.length]!,
      t: Math.random(),
      speed: 0.05 + Math.random() * 0.05,
      direction: Math.random() > 0.5 ? 1 : -1,
    }));
  }

  // ─── Dessin ──────────────────────────────────────────────────────────────

  #draw(): void {
    const ctx = this.#ctx;
    const rect = this.#canvas.getBoundingClientRect();

    this.#drawSky(rect.width, rect.height);

    ctx.save();
    ctx.translate(rect.width / 2, rect.height / 2);
    ctx.scale(this.#camera.zoom, this.#camera.zoom);
    ctx.translate(-this.#camera.x, -this.#camera.y);

    this.#hitTargets = [];

    if (this.#snapshot) {
      this.#drawTerrain();
      this.#drawDistrictBlocks();
      this.#drawStreets();
      this.#drawPlazas();
      this.#drawStreetFurniture();
      this.#drawFreight();
      this.#drawGatherings();
      this.#drawDrones();

      // Algorithme du peintre : en isométrie, la profondeur est x + y.
      const drawables: Array<{ depth: number; render: () => void }> = [];
      for (const annex of this.#annexes) {
        drawables.push({ depth: annex.x + annex.y, render: () => this.#drawAnnex(annex) });
      }
      for (const building of this.#snapshot.buildings) {
        drawables.push({ depth: building.x + building.y, render: () => this.#drawBuilding(building) });
      }
      for (const agent of this.#agents.values()) {
        drawables.push({ depth: agent.x + agent.y + 0.45, render: () => this.#drawAgent(agent) });
      }
      drawables.sort((a, b) => a.depth - b.depth);
      for (const drawable of drawables) drawable.render();

      this.#drawSparks();
      this.#drawLabels();
    }

    ctx.restore();
    this.#updateHover();
  }

  #drawSky(width: number, height: number): void {
    const ctx = this.#ctx;
    const mood = this.#pulse?.mood ?? 'calm';
    const intensity = this.#pulse?.intensity ?? 0.2;

    const hue = mood === 'incident' ? 348 : mood === 'active' ? 205 : mood === 'council' ? 228 : 218;
    const lift = intensity * 4;

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, `hsl(${hue} 46% ${4 + lift}%)`);
    gradient.addColorStop(0.55, `hsl(${hue} 40% ${6 + lift}%)`);
    gradient.addColorStop(1, `hsl(${hue - 10} 34% ${3 + lift * 0.5}%)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    for (const star of this.#stars) {
      const alpha = 0.2 + Math.sin(this.#time / 900 + star.twinkle) * 0.16;
      ctx.globalAlpha = Math.max(0.04, alpha);
      ctx.fillStyle = '#cbd5f5';
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Le terrain : une plateforme urbaine continue.
   *
   * C'est le changement qui pèse le plus lourd dans l'impression d'ensemble.
   * Des bâtiments posés sur du vide se lisent comme des nœuds ; les mêmes
   * bâtiments posés sur un sol se lisent comme une ville.
   */
  #drawTerrain(): void {
    const ctx = this.#ctx;
    if (!this.#snapshot) return;

    // Marge serrée : la dalle doit border la ville, pas s'étendre au-delà de
    // l'écran. À 2,6 unités, un quart de la vue était du sol vide au-delà du
    // dernier bâtiment — l'impression d'un décor trop grand pour ce qu'il porte.
    const bounds = this.#gridBounds(1.15);
    const corners = [
      project(bounds.minX, bounds.minY),
      project(bounds.maxX, bounds.minY),
      project(bounds.maxX, bounds.maxY),
      project(bounds.minX, bounds.maxY),
    ];

    // Flanc de la plateforme : le sol a une épaisseur, donc un relief.
    const thickness = 26;
    ctx.fillStyle = '#080e1a';
    ctx.beginPath();
    ctx.moveTo(corners[0]!.sx, corners[0]!.sy);
    for (const c of corners.slice(1)) ctx.lineTo(c.sx, c.sy);
    ctx.lineTo(corners[0]!.sx, corners[0]!.sy + thickness);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#0a1424';
    ctx.beginPath();
    ctx.moveTo(corners[3]!.sx, corners[3]!.sy);
    ctx.lineTo(corners[2]!.sx, corners[2]!.sy);
    ctx.lineTo(corners[2]!.sx, corners[2]!.sy + thickness);
    ctx.lineTo(corners[3]!.sx, corners[3]!.sy + thickness);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(corners[1]!.sx, corners[1]!.sy);
    ctx.lineTo(corners[2]!.sx, corners[2]!.sy);
    ctx.lineTo(corners[2]!.sx, corners[2]!.sy + thickness);
    ctx.lineTo(corners[1]!.sx, corners[1]!.sy + thickness);
    ctx.closePath();
    ctx.fill();

    // Dalle.
    const centre = project((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2);
    const plate = ctx.createRadialGradient(centre.sx, centre.sy, 40, centre.sx, centre.sy, 620);
    plate.addColorStop(0, '#152238');
    plate.addColorStop(0.6, '#101a2c');
    plate.addColorStop(1, '#0b1220');
    ctx.fillStyle = plate;
    ctx.beginPath();
    ctx.moveTo(corners[0]!.sx, corners[0]!.sy);
    for (const c of corners.slice(1)) ctx.lineTo(c.sx, c.sy);
    ctx.closePath();
    ctx.fill();

    // Trame de dallage, discrète : elle donne l'échelle sans faire grille.
    ctx.strokeStyle = 'rgba(90, 130, 185, 0.055)';
    ctx.lineWidth = 1;
    for (let gx = Math.ceil(bounds.minX); gx <= bounds.maxX; gx += 2) {
      const a = project(gx, bounds.minY);
      const b = project(gx, bounds.maxY);
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.stroke();
    }
    for (let gy = Math.ceil(bounds.minY); gy <= bounds.maxY; gy += 2) {
      const a = project(bounds.minX, gy);
      const b = project(bounds.maxX, gy);
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.stroke();
    }

    // Liseré de bordure.
    ctx.strokeStyle = 'rgba(125, 211, 252, 0.16)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(corners[0]!.sx, corners[0]!.sy);
    for (const c of corners.slice(1)) ctx.lineTo(c.sx, c.sy);
    ctx.closePath();
    ctx.stroke();
  }

  /** Les quartiers, en blocs colorés posés sur la dalle. */
  #drawDistrictBlocks(): void {
    const ctx = this.#ctx;
    if (!this.#snapshot) return;

    for (const district of DISTRICTS) {
      const members = this.#snapshot.buildings.filter((b) => styleOf(b.key).district === district.key);
      if (members.length === 0) continue;

      const cx = members.reduce((s, b) => s + b.x, 0) / members.length;
      const cy = members.reduce((s, b) => s + b.y, 0) / members.length;
      const spread = Math.max(...members.map((b) => Math.hypot(b.x - cx, b.y - cy))) + 2.1;

      const { sx, sy } = project(cx, cy);
      ctx.save();
      ctx.translate(sx, sy);
      ctx.scale(1, TILE_H / TILE_W);

      const radius = spread * TILE_W * 0.56;
      const glow = ctx.createRadialGradient(0, 0, radius * 0.2, 0, 0, radius);
      glow.addColorStop(0, district.ground);
      glow.addColorStop(1, 'rgba(8, 12, 22, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = withAlpha(district.accent, 0.11);
      ctx.lineWidth = 1.6;
      ctx.setLineDash([12, 14]);
      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  /**
   * Les rues.
   *
   * Une chaussée pleine, avec ses bordures et son marquage — pas un trait entre
   * deux nœuds. C'est ce qui transforme le graphe logique, inchangé par
   * ailleurs, en réseau de circulation.
   */
  #drawStreets(): void {
    const ctx = this.#ctx;

    const hot = new Set<string>();
    for (const occupation of this.#occupations.values()) {
      if (!occupation.real || occupation.phase !== 'travelling') continue;
      for (let i = 1; i < occupation.path.length; i++) {
        hot.add(edgeKey(occupation.path[i - 1]!, occupation.path[i]!));
      }
    }

    // Trois passes : bordures, chaussées, marquages. Peindre rue par rue
    // laisserait la bordure de l'une recouvrir la chaussée de sa voisine à
    // chaque croisement.
    for (const pass of ['kerb', 'surface', 'marking'] as const) {
      for (const road of this.#roads) {
        const a = project(road.ax, road.ay);
        const b = project(road.bx, road.by);
        const dx = b.sx - a.sx;
        const dy = b.sy - a.sy;
        const length = Math.hypot(dx, dy) || 1;
        const nx = (-dy / length) * ROAD_HALF;
        const ny = (dx / length) * ROAD_HALF;

        const live = hot.has(edgeKey(road.from, road.to));
        const busy =
          this.#buildingByKey.get(road.from)?.status === 'busy' ||
          this.#buildingByKey.get(road.to)?.status === 'busy';

        if (pass === 'kerb') {
          ctx.fillStyle = '#0c1626';
          quad(ctx, a.sx, a.sy, b.sx, b.sy, nx * 1.28, ny * 1.28);
          ctx.fill();
        } else if (pass === 'surface') {
          ctx.fillStyle = live ? '#1b2f4a' : busy ? '#17273c' : '#141f33';
          quad(ctx, a.sx, a.sy, b.sx, b.sy, nx, ny);
          ctx.fill();

          // Trottoirs : deux liserés clairs le long des bordures.
          ctx.strokeStyle = live
            ? 'rgba(125, 211, 252, 0.5)'
            : busy
              ? 'rgba(52, 211, 153, 0.2)'
              : 'rgba(96, 132, 180, 0.13)';
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(a.sx + nx, a.sy + ny);
          ctx.lineTo(b.sx + nx, b.sy + ny);
          ctx.moveTo(a.sx - nx, a.sy - ny);
          ctx.lineTo(b.sx - nx, b.sy - ny);
          ctx.stroke();
        } else {
          // Marquage axial.
          ctx.strokeStyle = 'rgba(160, 195, 235, 0.13)';
          ctx.lineWidth = 1.2;
          ctx.setLineDash([9, 13]);
          ctx.beginPath();
          ctx.moveTo(a.sx, a.sy);
          ctx.lineTo(b.sx, b.sy);
          ctx.stroke();
          ctx.setLineDash([]);

          if (live && !this.#reduceMotion) {
            for (let i = 0; i < 3; i++) {
              const t = (this.#time / 900 + i / 3) % 1;
              const px = a.sx + dx * t;
              const py = a.sy + dy * t;
              ctx.fillStyle = `rgba(186, 230, 253, ${Math.sin(t * Math.PI) * 0.85})`;
              ctx.beginPath();
              ctx.arc(px, py, 3.2, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
      }
    }
  }

  /**
   * La place centrale, au pied du poste de commandement.
   *
   * Le cœur d'une ville n'est pas un bâtiment isolé : c'est un bâtiment et
   * l'espace public qui l'entoure. Sans elle, le centre restait un édifice de
   * plus, un peu plus grand que les autres.
   */
  #drawCentralPlaza(): void {
    const ctx = this.#ctx;
    const centre = this.#buildingByKey.get('command-center');
    if (!centre) return;

    const { sx, sy } = project(centre.x, centre.y);
    const intensity = this.#pulse?.intensity ?? 0.2;

    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(1, TILE_H / TILE_W);

    // Dallage circulaire, trois anneaux concentriques.
    for (const [radius, colour] of [
      [232, '#0d1828'],
      [196, '#101d31'],
      [150, '#13233a'],
    ] as Array<[number, string]>) {
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    // Rayons de pavage : huit allées convergentes.
    ctx.strokeStyle = 'rgba(125, 211, 252, 0.07)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 96, Math.sin(a) * 96);
      ctx.lineTo(Math.cos(a) * 228, Math.sin(a) * 228);
      ctx.stroke();
    }

    // Anneau lumineux, qui suit le rythme de la cité.
    ctx.strokeStyle = `rgba(56, 189, 248, ${0.1 + intensity * 0.16})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, 196, 0, Math.PI * 2);
    ctx.stroke();

    // Bornes d'éclairage sur le pourtour.
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ctx.fillStyle = 'rgba(125, 211, 252, 0.22)';
      ctx.beginPath();
      ctx.arc(Math.cos(a) * 212, Math.sin(a) * 212, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Les parvis : une place pavée au pied de chaque bâtiment. */
  #drawPlazas(): void {
    const ctx = this.#ctx;
    if (!this.#snapshot) return;

    this.#drawCentralPlaza();

    for (const building of this.#snapshot.buildings) {
      const { sx, sy } = project(building.x, building.y);
      const style = styleOf(building.key);
      const isCore = building.key === 'command-center';
      const w = isCore ? 106 : 84;

      ctx.save();
      ctx.translate(sx, sy);
      ctx.scale(1, TILE_H / TILE_W);

      ctx.fillStyle = '#0e1a2c';
      ctx.beginPath();
      ctx.arc(0, 0, w, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#131f34';
      ctx.beginPath();
      ctx.arc(0, 0, w * 0.86, 0, Math.PI * 2);
      ctx.fill();

      const statusColour =
        building.status === 'alert' ? '#fb7185' : building.status === 'busy' ? '#34d399' : style.accent;
      const ring = building.status === 'alert' ? 0.5 + Math.sin(this.#time / 260) * 0.34 : 0.24;
      ctx.strokeStyle = withAlpha(statusColour, ring);
      ctx.lineWidth = building.status === 'alert' ? 3.4 : 2;
      ctx.beginPath();
      ctx.arc(0, 0, w * 0.86, 0, Math.PI * 2);
      ctx.stroke();

      // Éclairage au sol : quatre bornes autour du parvis.
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        ctx.fillStyle = withAlpha(style.accent, 0.2);
        ctx.beginPath();
        ctx.arc(Math.cos(a) * w * 0.72, Math.sin(a) * w * 0.72, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  /**
   * Le mobilier urbain : lampadaires le long des rues.
   *
   * Détail secondaire, mais c'est l'accumulation de détails secondaires qui
   * distingue une rue d'un segment.
   */
  #drawStreetFurniture(): void {
    if (this.#reduceMotion) return;
    const ctx = this.#ctx;

    for (const [index, road] of this.#roads.entries()) {
      const a = project(road.ax, road.ay);
      const b = project(road.bx, road.by);
      const dx = b.sx - a.sx;
      const dy = b.sy - a.sy;
      const length = Math.hypot(dx, dy) || 1;
      const nx = (-dy / length) * (ROAD_HALF + 5);
      const ny = (dx / length) * (ROAD_HALF + 5);

      // Deux lampadaires par rue, alternés d'un côté puis de l'autre.
      for (const t of [0.34, 0.66]) {
        const side = (index + (t > 0.5 ? 1 : 0)) % 2 === 0 ? 1 : -1;
        const x = a.sx + dx * t + nx * side;
        const y = a.sy + dy * t + ny * side;

        ctx.strokeStyle = 'rgba(90, 125, 170, 0.5)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y - 13);
        ctx.stroke();

        ctx.fillStyle = 'rgba(186, 230, 253, 0.55)';
        ctx.beginPath();
        ctx.arc(x, y - 14, 1.7, 0, Math.PI * 2);
        ctx.fill();

        // Flaque de lumière au sol.
        ctx.fillStyle = 'rgba(125, 211, 252, 0.055)';
        ctx.beginPath();
        ctx.ellipse(x, y + 1, 11, 4.4, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  #drawFreight(): void {
    if (this.#reduceMotion) return;
    const ctx = this.#ctx;

    for (const cart of this.#freight) {
      const a = project(cart.road.ax, cart.road.ay);
      const b = project(cart.road.bx, cart.road.by);
      const x = a.sx + (b.sx - a.sx) * cart.t;
      const y = a.sy + (b.sy - a.sy) * cart.t;

      ctx.fillStyle = 'rgba(125, 211, 252, 0.10)';
      ctx.beginPath();
      ctx.ellipse(x, y + 2, 8, 3, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = 'rgba(46, 78, 118, 0.95)';
      ctx.fillRect(x - 5, y - 8, 10, 6);
      ctx.fillStyle = 'rgba(125, 211, 252, 0.5)';
      ctx.fillRect(x - 5, y - 8, 10, 1.6);
      ctx.fillStyle = 'rgba(186, 230, 253, 0.6)';
      ctx.beginPath();
      ctx.arc(x + (cart.direction > 0 ? 5 : -5), y - 5, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  #drawGatherings(): void {
    const ctx = this.#ctx;
    for (const gathering of this.#life.gatherings()) {
      const building = this.#buildingByKey.get(gathering.at);
      if (!building) continue;

      const { sx, sy } = project(building.x, building.y);
      const pulse = 0.4 + Math.sin(this.#time / 620) * 0.22;

      ctx.save();
      ctx.translate(sx, sy + 22);
      ctx.scale(1, TILE_H / TILE_W);
      const glow = ctx.createRadialGradient(0, 0, 4, 0, 0, 62);
      glow.addColorStop(0, `rgba(196, 181, 253, ${0.2 * pulse})`);
      glow.addColorStop(1, 'rgba(196, 181, 253, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, 62, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = `rgba(196, 181, 253, ${0.26 * pulse})`;
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 7]);
      ctx.beginPath();
      ctx.arc(0, 0, 48, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  // ─── Bâtiments ───────────────────────────────────────────────────────────

  #drawBuilding(building: Building): void {
    const ctx = this.#ctx;
    const { sx, sy } = project(building.x, building.y);
    const style = styleOf(building.key);

    // Ombre portée, décalée : elle donne l'assise et la direction de la lumière.
    ctx.save();
    ctx.translate(sx + 10, sy + 4);
    ctx.scale(1, 0.5);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.34)';
    ctx.beginPath();
    ctx.arc(0, 0, 60, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const lit =
      building.status === 'busy' ? 1 : building.status === 'alert' ? 0.7 : 0.18 + (building.level - 1) * 0.05;

    paintBuilding(building.key, {
      ctx,
      cx: sx,
      cy: sy,
      time: this.#time,
      level: building.level,
      lit: Math.min(1, lit),
      status: building.status,
      palette: { left: style.left, right: style.right, roof: style.roof, accent: style.accent },
    });

    const height = heightOf(building.key, building.level);
    this.#hitTargets.push({
      kind: 'building',
      key: building.key,
      label: building.name,
      screenX: sx,
      screenY: sy - height * 0.42,
      radius: Math.max(66, height * 0.5),
    });
  }

  /**
   * Les étiquettes, dessinées après tout le reste.
   *
   * Peintes avec leur bâtiment, elles passaient derrière ceux de l'avant-plan et
   * devenaient illisibles dès que la ville se densifiait.
   */
  #drawLabels(): void {
    const ctx = this.#ctx;
    if (!this.#snapshot) return;

    for (const building of this.#snapshot.buildings) {
      const { sx, sy } = project(building.x, building.y);
      const style = styleOf(building.key);
      const isCore = building.key === 'command-center';
      const height = heightOf(building.key, building.level);
      const statusColour =
        building.status === 'alert' ? '#fb7185' : building.status === 'busy' ? '#34d399' : style.accent;

      const y = sy - height - (isCore ? 58 : 20);
      const text = isCore ? 'Poste de commandement' : style.short;

      ctx.font = `600 ${isCore ? 12.5 : 11}px 'Space Grotesk', system-ui, sans-serif`;
      ctx.textAlign = 'center';
      const width = ctx.measureText(text).width + 18;

      ctx.fillStyle = 'rgba(4, 9, 20, 0.8)';
      roundRect(ctx, sx - width / 2, y - 12, width, 18, 5);
      ctx.fill();
      ctx.strokeStyle = withAlpha(statusColour, building.status === 'nominal' ? 0.22 : 0.5);
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = building.status === 'alert' ? '#fecdd3' : '#e2e8f0';
      ctx.fillText(text, sx, y + 1);

      ctx.font = "500 8.5px 'Inter', system-ui, sans-serif";
      ctx.fillStyle = withAlpha(statusColour, 0.8);
      ctx.fillText(`N${building.level} · ${districtOf(building.key).label}`, sx, y + 12);
    }
  }

  // ─── Habitants ───────────────────────────────────────────────────────────

  #drawAgent(agent: AgentVisual): void {
    const ctx = this.#ctx;
    const { sx, sy } = project(agent.x, agent.y);
    const occupation = agent.occupation;
    const real = occupation?.real === true;

    // Auréole. Marquée pour le travail réel, discrète pour la vie ambiante :
    // c'est le signal qui empêche de confondre les deux registres.
    if (occupation && occupation.kind !== 'offline') {
      const strength = agent.status === 'error' ? 0.5 : real ? 0.36 : 0.13;
      const colour = agent.status === 'error' ? '#fb7185' : real ? agent.accent : '#94a3b8';
      const pulse = 0.45 + Math.sin(this.#time / (real ? 320 : 900)) * 0.28;
      const radius = real ? 25 : 17;
      const aura = ctx.createRadialGradient(sx, sy - 12, 0, sx, sy - 12, radius);
      aura.addColorStop(0, withAlpha(colour, strength * pulse));
      aura.addColorStop(1, withAlpha(colour, 0));
      ctx.fillStyle = aura;
      ctx.beginPath();
      ctx.arc(sx, sy - 12, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    // Les habitants sont agrandis avec la ville : à l'échelle d'origine ils
    // devenaient des points dès que la caméra prenait du recul.
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(CHARACTER_SCALE, CHARACTER_SCALE);
    ctx.translate(-sx, -sy);
    drawCharacter(ctx, {
      x: sx,
      y: sy,
      phase: agent.phase,
      walking: agent.moving,
      facing: agent.facing,
      hue: agent.hue,
      accent: agent.accent,
      emblem: agent.emblem,
      kind: occupation?.kind ?? 'patrol',
      real,
      errored: agent.status === 'error',
    });
    ctx.restore();

    // Pastille : ce villageois vit, il ne travaille pas sur une mission.
    if (occupation && !real && occupation.kind !== 'offline') {
      ctx.fillStyle = 'rgba(148, 163, 184, 0.5)';
      ctx.beginPath();
      ctx.arc(sx + 7, sy - 26, 1.9, 0, Math.PI * 2);
      ctx.fill();
    }

    if (this.#hover?.kind === 'agent' && this.#hover.key === agent.key) {
      this.#drawAgentTooltip(agent, sx, sy, real);
    }

    this.#hitTargets.push({
      kind: 'agent',
      key: agent.key,
      label: agent.name,
      screenX: sx,
      screenY: sy - 14,
      radius: 18,
    });
  }

  #drawAgentTooltip(agent: AgentVisual, sx: number, sy: number, real: boolean): void {
    const ctx = this.#ctx;
    const caption = agent.occupation?.label ?? '';

    ctx.font = "600 10.5px 'Inter', system-ui, sans-serif";
    const nameWidth = ctx.measureText(agent.name).width;
    ctx.font = "500 9.5px 'Inter', system-ui, sans-serif";
    const captionWidth = ctx.measureText(caption).width;
    const width = Math.max(nameWidth, captionWidth) + 16;
    const height = caption ? 30 : 18;
    const top = sy - 40 - height;

    ctx.fillStyle = 'rgba(3, 7, 18, 0.9)';
    roundRect(ctx, sx - width / 2, top, width, height, 6);
    ctx.fill();
    ctx.strokeStyle = withAlpha(real ? agent.accent : '#94a3b8', 0.4);
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.font = "600 10.5px 'Inter', system-ui, sans-serif";
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(agent.name, sx, top + 13);

    if (caption) {
      ctx.font = "500 9.5px 'Inter', system-ui, sans-serif";
      ctx.fillStyle = real ? withAlpha(agent.accent, 0.95) : 'rgba(148, 163, 184, 0.95)';
      ctx.fillText(caption, sx, top + 25);
    }
  }

  #drawSparks(): void {
    const ctx = this.#ctx;
    for (const spark of this.#sparks) {
      const alpha = 1 - spark.life / spark.maxLife;
      ctx.fillStyle = withAlpha(spark.color, alpha * 0.75);
      ctx.beginPath();
      ctx.arc(spark.x, spark.y, 1.9 * alpha + 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ─── Interaction ─────────────────────────────────────────────────────────

  #gridBounds(margin: number): { minX: number; maxX: number; minY: number; maxY: number } {
    const buildings = this.#snapshot?.buildings ?? [];
    if (buildings.length === 0) return { minX: -5, maxX: 5, minY: -5, maxY: 5 };

    return {
      minX: Math.min(...buildings.map((b) => b.x)) - margin,
      maxX: Math.max(...buildings.map((b) => b.x)) + margin,
      minY: Math.min(...buildings.map((b) => b.y)) - margin,
      maxY: Math.max(...buildings.map((b) => b.y)) + margin,
    };
  }

  #updateHover(): void {
    if (!this.#pointer.inside || this.#dragging) {
      if (this.#hover) {
        this.#hover = null;
        this.onHover?.(null);
      }
      return;
    }

    const target = this.#pick(this.#pointer.x, this.#pointer.y);
    if (target?.key !== this.#hover?.key || target?.kind !== this.#hover?.kind) {
      this.#hover = target;
      this.onHover?.(target);
      this.#canvas.style.cursor = target ? 'pointer' : 'grab';
    }
  }

  /** Écran → monde. Les habitants l'emportent : ils sont devant les bâtiments. */
  #pick(clientX: number, clientY: number): HitTarget | null {
    const rect = this.#canvas.getBoundingClientRect();
    const worldX = (clientX - rect.left - rect.width / 2) / this.#camera.zoom + this.#camera.x;
    const worldY = (clientY - rect.top - rect.height / 2) / this.#camera.zoom + this.#camera.y;

    let best: (HitTarget & { radius: number }) | null = null;
    let bestScore = Infinity;

    for (const target of this.#hitTargets) {
      const distance = Math.hypot(worldX - target.screenX, worldY - target.screenY);
      if (distance > target.radius) continue;
      const score = distance - (target.kind === 'agent' ? 60 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = target;
      }
    }

    return best
      ? { kind: best.kind, key: best.key, label: best.label, screenX: best.screenX, screenY: best.screenY }
      : null;
  }

  #onPointerDown = (event: PointerEvent): void => {
    this.#dragging = true;
    this.#dragStart = {
      x: event.clientX,
      y: event.clientY,
      camX: this.#targetCamera.x,
      camY: this.#targetCamera.y,
    };
    this.#canvas.setPointerCapture(event.pointerId);
    this.#canvas.style.cursor = 'grabbing';
  };

  #onPointerMove = (event: PointerEvent): void => {
    this.#pointer = { x: event.clientX, y: event.clientY, inside: true };
    if (!this.#dragging) return;

    this.#targetCamera.x = this.#dragStart.camX - (event.clientX - this.#dragStart.x) / this.#camera.zoom;
    this.#targetCamera.y = this.#dragStart.camY - (event.clientY - this.#dragStart.y) / this.#camera.zoom;
    this.#camera.x = this.#targetCamera.x;
    this.#camera.y = this.#targetCamera.y;
  };

  #onPointerUp = (event: PointerEvent): void => {
    const moved = Math.hypot(event.clientX - this.#dragStart.x, event.clientY - this.#dragStart.y) > 5;
    this.#dragging = false;
    this.#canvas.style.cursor = 'grab';
    if (!moved) this.onSelect?.(this.#pick(event.clientX, event.clientY));
  };

  #onPointerLeave = (): void => {
    this.#pointer.inside = false;
    this.#dragging = false;
  };

  #onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.zoomBy(event.deltaY < 0 ? 1.12 : 0.89);
  };

  #bindEvents(): void {
    this.#canvas.addEventListener('pointerdown', this.#onPointerDown);
    this.#canvas.addEventListener('pointermove', this.#onPointerMove);
    this.#canvas.addEventListener('pointerup', this.#onPointerUp);
    this.#canvas.addEventListener('pointerleave', this.#onPointerLeave);
    this.#canvas.addEventListener('wheel', this.#onWheel, { passive: false });
    this.#canvas.style.cursor = 'grab';
    this.#canvas.style.touchAction = 'none';
  }

  #unbindEvents(): void {
    this.#canvas.removeEventListener('pointerdown', this.#onPointerDown);
    this.#canvas.removeEventListener('pointermove', this.#onPointerMove);
    this.#canvas.removeEventListener('pointerup', this.#onPointerUp);
    this.#canvas.removeEventListener('pointerleave', this.#onPointerLeave);
    this.#canvas.removeEventListener('wheel', this.#onWheel);
  }

  #seedStars(): void {
    const rect = this.#canvas.getBoundingClientRect();
    const count = Math.round((rect.width * rect.height) / 12_000);
    this.#stars = Array.from({ length: Math.max(30, count) }, () => ({
      x: Math.random() * rect.width,
      y: Math.random() * rect.height * 0.65,
      r: Math.random() * 1.1 + 0.25,
      twinkle: Math.random() * Math.PI * 2,
    }));
  }
}

// ─── Utilitaires ────────────────────────────────────────────────────────────

const edgeKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Hachage stable d'une chaîne : la ville doit avoir la même allure à chaque visite. */
function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** Le quadrilatère d'une chaussée, autour de son axe. */
function quad(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  nx: number,
  ny: number,
): void {
  ctx.beginPath();
  ctx.moveTo(ax + nx, ay + ny);
  ctx.lineTo(bx + nx, by + ny);
  ctx.lineTo(bx - nx, by - ny);
  ctx.lineTo(ax - nx, ay - ny);
  ctx.closePath();
}

export { isoFootprint };
