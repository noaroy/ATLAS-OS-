import type { Agent, Building, VillageSnapshot } from '@atlas/contracts';

/**
 * ATLAS Village renderer (SRS §3).
 *
 * An isometric canvas scene where every visual element is bound to real system
 * state: a building's height is its accumulated activity, its ring colour is
 * its department's status, and an inhabitant only walks when an agent was
 * genuinely dispatched. Nothing here animates for decoration alone.
 *
 * Canvas rather than DOM because the scene redraws every frame with dozens of
 * moving parts — and it keeps the whole village dependency-free.
 */

const TILE_W = 104;
const TILE_H = 52;
const BUILDING_FOOTPRINT = 0.82;

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
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  bob: number;
  hue: number;
  accent: string;
  emblem: string;
  status: Agent['state']['status'];
  name: string;
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

const project = (x: number, y: number): { sx: number; sy: number } => ({
  sx: (x - y) * (TILE_W / 2),
  sy: (x + y) * (TILE_H / 2),
});

/** Ease-in-out so inhabitants accelerate away and settle on arrival. */
const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

export class VillageRenderer {
  #canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D;
  #frame = 0;
  #raf: number | null = null;
  #time = 0;

  #snapshot: VillageSnapshot | null = null;
  #camera: Camera = { x: 0, y: 0, zoom: 1 };
  #targetCamera: Camera = { x: 0, y: 0, zoom: 1 };
  #agents = new Map<string, AgentVisual>();
  #sparks: Spark[] = [];
  #stars: Array<{ x: number; y: number; r: number; twinkle: number }> = [];

  #pointer = { x: 0, y: 0, inside: false };
  #hover: HitTarget | null = null;
  #hitTargets: Array<HitTarget & { radius: number }> = [];

  #dragging = false;
  #dragStart = { x: 0, y: 0, camX: 0, camY: 0 };
  #reduceMotion = false;

  onSelect: ((target: HitTarget | null) => void) | null = null;
  onHover: ((target: HitTarget | null) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not available in this browser');
    this.#ctx = ctx;

    this.#reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.#seedStars();
    this.#bindEvents();
    this.resize();
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  start(): void {
    if (this.#raf !== null) return;
    let last = performance.now();

    const loop = (now: number): void => {
      const delta = Math.min(64, now - last);
      last = now;
      this.#time += delta;
      this.#frame++;
      this.#update(delta);
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
    this.#syncAgents(snapshot);
    if (first) this.fit();
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.#canvas.getBoundingClientRect();
    this.#canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.#canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.#ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.#seedStars();
  }

  /** Frames the whole village in the viewport. */
  fit(): void {
    if (!this.#snapshot || this.#snapshot.buildings.length === 0) return;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const building of this.#snapshot.buildings) {
      const { sx, sy } = project(building.x, building.y);
      minX = Math.min(minX, sx - TILE_W);
      maxX = Math.max(maxX, sx + TILE_W);
      minY = Math.min(minY, sy - TILE_H * 3);
      maxY = Math.max(maxY, sy + TILE_H * 2);
    }

    const rect = this.#canvas.getBoundingClientRect();
    const zoom = Math.min(
      1.35,
      Math.max(0.35, Math.min((rect.width - 80) / (maxX - minX), (rect.height - 80) / (maxY - minY))),
    );

    this.#targetCamera = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom };
    this.#camera = { ...this.#targetCamera };
  }

  zoomBy(factor: number): void {
    this.#targetCamera.zoom = Math.max(0.3, Math.min(2.4, this.#targetCamera.zoom * factor));
  }

  /** Moves the camera to a building. The easing to it is handled per frame. */
  focusBuilding(key: string): void {
    const building = this.#snapshot?.buildings.find((b) => b.key === key);
    if (!building) return;

    const { sx, sy } = project(building.x, building.y);
    this.#targetCamera = { x: sx, y: sy, zoom: Math.max(this.#targetCamera.zoom, 1.1) };
  }

  // ─── State synchronisation ───────────────────────────────────────────────

  /**
   * Reconciles inhabitants with the snapshot.
   *
   * Positions are interpolated rather than snapped so an agent that is
   * dispatched glides to its destination; the journey list from the server is
   * the source of truth for who is actually travelling.
   */
  #syncAgents(snapshot: VillageSnapshot): void {
    const buildings = new Map(snapshot.buildings.map((b) => [b.key, b]));
    const journeys = new Map(snapshot.journeys.map((j) => [j.agentKey, j]));
    const seen = new Set<string>();

    // Spread inhabitants around their building so they never overlap exactly.
    const occupancy = new Map<string, number>();

    for (const agent of snapshot.agents) {
      seen.add(agent.key);
      const journey = journeys.get(agent.key);
      const homeKey = agent.state.location || agent.building;
      const home = buildings.get(homeKey) ?? buildings.get(agent.building);
      if (!home) continue;

      const slot = occupancy.get(home.key) ?? 0;
      occupancy.set(home.key, slot + 1);
      const angle = (slot * 2.39996) + 0.6; // golden-angle spread
      const radius = 0.42 + (slot % 3) * 0.12;

      let targetX = home.x + Math.cos(angle) * radius;
      let targetY = home.y + Math.sin(angle) * radius;
      let moving = false;

      if (journey) {
        const from = buildings.get(journey.from);
        const to = buildings.get(journey.to);
        if (from && to) {
          const elapsed = Date.now() - Date.parse(journey.startedAt);
          const t = Math.max(0, Math.min(1, elapsed / Math.max(1, journey.durationMs)));
          const eased = easeInOut(t);
          targetX = from.x + (to.x - from.x) * eased;
          targetY = from.y + (to.y - from.y) * eased;
          moving = t < 1;
        }
      }

      const existing = this.#agents.get(agent.key);
      if (existing) {
        existing.targetX = targetX;
        existing.targetY = targetY;
        existing.status = agent.state.status;
        existing.moving = moving;
        existing.hue = agent.appearance.hue;
        existing.accent = agent.appearance.accent;
        existing.name = agent.name;
      } else {
        this.#agents.set(agent.key, {
          key: agent.key,
          x: targetX,
          y: targetY,
          targetX,
          targetY,
          bob: Math.random() * Math.PI * 2,
          hue: agent.appearance.hue,
          accent: agent.appearance.accent,
          emblem: agent.appearance.emblem,
          status: agent.state.status,
          name: agent.name,
          moving,
        });
      }
    }

    for (const key of [...this.#agents.keys()]) {
      if (!seen.has(key)) this.#agents.delete(key);
    }
  }

  #update(delta: number): void {
    const step = delta / 1000;

    // Camera easing keeps zoom and pan from feeling mechanical.
    this.#camera.x += (this.#targetCamera.x - this.#camera.x) * Math.min(1, step * 6);
    this.#camera.y += (this.#targetCamera.y - this.#camera.y) * Math.min(1, step * 6);
    this.#camera.zoom += (this.#targetCamera.zoom - this.#camera.zoom) * Math.min(1, step * 6);

    for (const agent of this.#agents.values()) {
      const lerp = Math.min(1, step * (agent.moving ? 9 : 4));
      agent.x += (agent.targetX - agent.x) * lerp;
      agent.y += (agent.targetY - agent.y) * lerp;
      agent.bob += step * (agent.moving ? 9 : 2.4);

      // A working agent throws off sparks — visible proof of activity.
      if (!this.#reduceMotion && agent.status === 'working' && Math.random() < step * 3) {
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
    this.#sparks = this.#sparks.filter((s) => s.life < s.maxLife).slice(-220);
  }

  // ─── Drawing ─────────────────────────────────────────────────────────────

  #draw(): void {
    const ctx = this.#ctx;
    const rect = this.#canvas.getBoundingClientRect();
    const { width, height } = rect;

    this.#drawSky(width, height);

    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.scale(this.#camera.zoom, this.#camera.zoom);
    ctx.translate(-this.#camera.x, -this.#camera.y);

    this.#hitTargets = [];

    if (this.#snapshot) {
      this.#drawGround();
      this.#drawRoads();

      // Painter's algorithm: depth in an isometric scene is x + y.
      const drawables: Array<{ depth: number; render: () => void }> = [];

      for (const building of this.#snapshot.buildings) {
        drawables.push({ depth: building.x + building.y, render: () => this.#drawBuilding(building) });
      }
      for (const agent of this.#agents.values()) {
        drawables.push({ depth: agent.x + agent.y + 0.35, render: () => this.#drawAgent(agent) });
      }

      drawables.sort((a, b) => a.depth - b.depth);
      for (const drawable of drawables) drawable.render();

      this.#drawSparks();
    }

    ctx.restore();

    this.#updateHover();
  }

  #drawSky(width: number, height: number): void {
    const ctx = this.#ctx;
    const vitality = this.#snapshot?.stats.vitality ?? 70;

    // Ambience follows system vitality: a healthy village sits under a calm
    // blue night, a struggling one shifts warm and dim.
    const hue = 215 - (100 - vitality) * 0.35;
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, `hsl(${hue} 45% 6%)`);
    gradient.addColorStop(0.55, `hsl(${hue} 38% 8%)`);
    gradient.addColorStop(1, `hsl(${hue - 8} 30% 4%)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    for (const star of this.#stars) {
      const alpha = 0.25 + Math.sin(this.#time / 900 + star.twinkle) * 0.2;
      ctx.globalAlpha = Math.max(0.05, alpha);
      ctx.fillStyle = '#cbd5f5';
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  #drawGround(): void {
    const ctx = this.#ctx;
    if (!this.#snapshot) return;

    // A soft plaza under the settlement, sized to the buildings it holds.
    let radius = 3;
    for (const b of this.#snapshot.buildings) radius = Math.max(radius, Math.hypot(b.x, b.y) + 2.2);

    const { sx, sy } = project(0, 0);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(1, TILE_H / TILE_W);

    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, radius * TILE_W * 0.62);
    glow.addColorStop(0, 'rgba(56, 189, 248, 0.14)');
    glow.addColorStop(0.55, 'rgba(30, 58, 96, 0.30)');
    glow.addColorStop(1, 'rgba(8, 12, 22, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, radius * TILE_W * 0.62, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Grid, fading with distance so the plaza has an edge without a hard line.
    ctx.lineWidth = 1;
    const extent = Math.ceil(radius);
    for (let i = -extent; i <= extent; i++) {
      for (const [a, b] of [
        [project(i, -extent), project(i, extent)],
        [project(-extent, i), project(extent, i)],
      ] as const) {
        const fade = 1 - Math.abs(i) / (extent + 1);
        ctx.strokeStyle = `rgba(80, 120, 175, ${0.05 + fade * 0.06})`;
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
        ctx.stroke();
      }
    }
  }

  /** Energy conduits from the Command Center to every department. */
  #drawRoads(): void {
    const ctx = this.#ctx;
    if (!this.#snapshot) return;

    const centre = this.#snapshot.buildings.find((b) => b.key === 'command-center');
    if (!centre) return;
    const origin = project(centre.x, centre.y);

    for (const building of this.#snapshot.buildings) {
      if (building.key === centre.key) continue;
      const target = project(building.x, building.y);

      ctx.strokeStyle = 'rgba(56, 189, 248, 0.10)';
      ctx.lineWidth = 9;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(origin.sx, origin.sy);
      ctx.lineTo(target.sx, target.sy);
      ctx.stroke();

      // Pulses flow only where the department is actually busy.
      const busy = building.status === 'busy';
      const pulseCount = busy ? 3 : 1;
      const speed = busy ? 1400 : 3600;

      for (let i = 0; i < pulseCount; i++) {
        const t = ((this.#time / speed + i / pulseCount) % 1);
        const px = origin.sx + (target.sx - origin.sx) * t;
        const py = origin.sy + (target.sy - origin.sy) * t;
        const alpha = Math.sin(t * Math.PI) * (busy ? 0.85 : 0.3);

        ctx.fillStyle =
          building.status === 'alert'
            ? `rgba(251, 113, 133, ${alpha})`
            : `rgba(125, 211, 252, ${alpha})`;
        ctx.beginPath();
        ctx.arc(px, py, busy ? 3.4 : 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  #drawBuilding(building: Building): void {
    const ctx = this.#ctx;
    const { sx, sy } = project(building.x, building.y);
    const isCentre = building.key === 'command-center';

    // Height grows with the department's level — the village visibly develops.
    const baseHeight = isCentre ? 96 : 58;
    const height = baseHeight + (building.level - 1) * 13;
    const w = TILE_W * BUILDING_FOOTPRINT * (isCentre ? 1.22 : 1);
    const h = TILE_H * BUILDING_FOOTPRINT * (isCentre ? 1.22 : 1);

    const palette = BUILDING_PALETTE[building.key] ?? BUILDING_PALETTE.default!;
    const statusColour =
      building.status === 'alert' ? '#fb7185' : building.status === 'busy' ? '#34d399' : palette.accent;

    // Ground shadow
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(1, 0.5);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.beginPath();
    ctx.arc(0, 0, w * 0.62, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Status ring — a department in alert is unmistakable from across the map.
    const ringPulse = building.status === 'alert' ? 0.5 + Math.sin(this.#time / 260) * 0.35 : 0.28;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(1, TILE_H / TILE_W);
    ctx.strokeStyle = withAlpha(statusColour, ringPulse);
    ctx.lineWidth = building.status === 'alert' ? 3.5 : 2;
    ctx.beginPath();
    ctx.arc(0, 0, w * 0.72, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Body: two visible walls plus a roof, drawn as an isometric prism.
    const top = sy - height;

    ctx.fillStyle = palette.left;
    ctx.beginPath();
    ctx.moveTo(sx - w / 2, sy);
    ctx.lineTo(sx, sy + h / 2);
    ctx.lineTo(sx, sy + h / 2 - height);
    ctx.lineTo(sx - w / 2, sy - height);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = palette.right;
    ctx.beginPath();
    ctx.moveTo(sx + w / 2, sy);
    ctx.lineTo(sx, sy + h / 2);
    ctx.lineTo(sx, sy + h / 2 - height);
    ctx.lineTo(sx + w / 2, sy - height);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = palette.roof;
    ctx.beginPath();
    ctx.moveTo(sx, top - h / 2);
    ctx.lineTo(sx + w / 2, top);
    ctx.lineTo(sx, top + h / 2);
    ctx.lineTo(sx - w / 2, top);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = withAlpha(palette.accent, 0.5);
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Windows: one lit row per level, so growth reads at a glance.
    for (let level = 0; level < building.level; level++) {
      const rowY = sy - 16 - level * 13;
      for (let i = 0; i < 3; i++) {
        const flicker = 0.45 + Math.sin(this.#time / 700 + level * 2 + i) * 0.2;
        ctx.fillStyle = withAlpha(palette.accent, building.status === 'busy' ? 0.55 + flicker * 0.4 : flicker);
        ctx.fillRect(sx - w / 2 + 9 + i * 9, rowY - 5, 5, 6);
        ctx.fillRect(sx + 9 + i * 9, rowY - 5 - 3, 5, 6);
      }
    }

    // The Command Center carries a visible intelligence core (SRS §3.4).
    if (isCentre) {
      const pulse = 0.55 + Math.sin(this.#time / 480) * 0.35;
      const coreY = top - 22;

      const halo = ctx.createRadialGradient(sx, coreY, 0, sx, coreY, 46);
      halo.addColorStop(0, `rgba(56, 189, 248, ${0.55 * pulse})`);
      halo.addColorStop(1, 'rgba(56, 189, 248, 0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(sx, coreY, 46, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = `rgba(224, 247, 255, ${0.75 + pulse * 0.25})`;
      ctx.beginPath();
      ctx.arc(sx, coreY, 8 + pulse * 2.5, 0, Math.PI * 2);
      ctx.fill();

      // Orbiting rings signal that Hermes is always coordinating.
      for (let ring = 0; ring < 2; ring++) {
        const angle = this.#time / (900 + ring * 500);
        ctx.save();
        ctx.translate(sx, coreY);
        ctx.rotate(angle * (ring === 0 ? 1 : -1));
        ctx.scale(1, 0.34);
        ctx.strokeStyle = `rgba(125, 211, 252, ${0.4 - ring * 0.14})`;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(0, 0, 20 + ring * 9, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Label
    const labelY = top - (isCentre ? 56 : 18);
    ctx.font = `600 ${isCentre ? 13 : 11.5}px 'Space Grotesk', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(3, 7, 18, 0.72)';
    const labelWidth = ctx.measureText(building.name).width + 16;
    roundRect(ctx, sx - labelWidth / 2, labelY - 13, labelWidth, 19, 6);
    ctx.fill();

    ctx.fillStyle = building.status === 'alert' ? '#fecdd3' : '#e2e8f0';
    ctx.fillText(building.name, sx, labelY);

    ctx.font = "500 9.5px 'Inter', system-ui, sans-serif";
    ctx.fillStyle = withAlpha(statusColour, 0.9);
    ctx.fillText(`LV ${building.level} · ${building.department.toUpperCase()}`, sx, labelY + 12);

    this.#hitTargets.push({
      kind: 'building',
      key: building.key,
      label: building.name,
      screenX: sx,
      screenY: sy - height / 2,
      radius: Math.max(w, height) * 0.55,
    });
  }

  #drawAgent(agent: AgentVisual): void {
    const ctx = this.#ctx;
    const { sx, sy } = project(agent.x, agent.y);
    const bob = Math.sin(agent.bob) * (agent.moving ? 3.4 : 1.6);
    const y = sy + bob;

    const base = `hsl(${agent.hue} 78% 62%)`;
    const dark = `hsl(${agent.hue} 62% 42%)`;

    // Shadow
    ctx.save();
    ctx.translate(sx, sy + 3);
    ctx.scale(1, 0.42);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.beginPath();
    ctx.arc(0, 0, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Status aura
    if (agent.status === 'working' || agent.status === 'analyzing' || agent.status === 'error') {
      const pulse = 0.4 + Math.sin(this.#time / 320) * 0.28;
      const colour = agent.status === 'error' ? '#fb7185' : agent.accent;
      const aura = ctx.createRadialGradient(sx, y - 10, 0, sx, y - 10, 26);
      aura.addColorStop(0, withAlpha(colour, 0.4 * pulse));
      aura.addColorStop(1, withAlpha(colour, 0));
      ctx.fillStyle = aura;
      ctx.beginPath();
      ctx.arc(sx, y - 10, 26, 0, Math.PI * 2);
      ctx.fill();
    }

    // Cloak / body
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.moveTo(sx - 6.5, y);
    ctx.quadraticCurveTo(sx - 7.5, y - 15, sx, y - 19);
    ctx.quadraticCurveTo(sx + 7.5, y - 15, sx + 6.5, y);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = base;
    ctx.beginPath();
    ctx.moveTo(sx - 4.2, y - 1.5);
    ctx.quadraticCurveTo(sx - 5, y - 13, sx, y - 17);
    ctx.quadraticCurveTo(sx + 5, y - 13, sx + 4.2, y - 1.5);
    ctx.closePath();
    ctx.fill();

    // Head
    ctx.fillStyle = `hsl(${agent.hue} 40% 88%)`;
    ctx.beginPath();
    ctx.arc(sx, y - 22, 5.2, 0, Math.PI * 2);
    ctx.fill();

    // Emblem badge — each specialist is identifiable without reading a label.
    ctx.fillStyle = agent.accent;
    ctx.font = "700 8px 'Inter', system-ui, sans-serif";
    ctx.textAlign = 'center';
    ctx.fillText(agent.emblem, sx, y - 8.5);

    // Motion trail
    if (agent.moving && !this.#reduceMotion) {
      for (let i = 1; i <= 3; i++) {
        ctx.fillStyle = withAlpha(agent.accent, 0.16 / i);
        ctx.beginPath();
        ctx.arc(sx - i * 5.5, y - 10, 4.5 - i * 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Name appears on hover only, so a busy village stays readable.
    if (this.#hover?.kind === 'agent' && this.#hover.key === agent.key) {
      ctx.font = "600 10.5px 'Inter', system-ui, sans-serif";
      const width = ctx.measureText(agent.name).width + 14;
      ctx.fillStyle = 'rgba(3, 7, 18, 0.85)';
      roundRect(ctx, sx - width / 2, y - 44, width, 17, 5);
      ctx.fill();
      ctx.fillStyle = '#e2e8f0';
      ctx.textAlign = 'center';
      ctx.fillText(agent.name, sx, y - 32);
    }

    this.#hitTargets.push({
      kind: 'agent',
      key: agent.key,
      label: agent.name,
      screenX: sx,
      screenY: y - 14,
      radius: 17,
    });
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

  #updateHover(): void {
    if (!this.#pointer.inside || this.#dragging) {
      if (this.#hover) {
        this.#hover = null;
        this.onHover?.(null);
      }
      return;
    }

    const target = this.#pick(this.#pointer.x, this.#pointer.y);
    const changed = target?.key !== this.#hover?.key || target?.kind !== this.#hover?.kind;
    if (changed) {
      this.#hover = target;
      this.onHover?.(target);
      this.#canvas.style.cursor = target ? 'pointer' : 'grab';
    }
  }

  /** Screen → world hit test. Agents win ties: they sit in front of buildings. */
  #pick(clientX: number, clientY: number): HitTarget | null {
    const rect = this.#canvas.getBoundingClientRect();
    const worldX = (clientX - rect.left - rect.width / 2) / this.#camera.zoom + this.#camera.x;
    const worldY = (clientY - rect.top - rect.height / 2) / this.#camera.zoom + this.#camera.y;

    let best: (HitTarget & { radius: number }) | null = null;
    let bestScore = Infinity;

    for (const target of this.#hitTargets) {
      const distance = Math.hypot(worldX - target.screenX, worldY - target.screenY);
      if (distance > target.radius) continue;
      const score = distance - (target.kind === 'agent' ? 40 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = target;
      }
    }

    return best ? { kind: best.kind, key: best.key, label: best.label, screenX: best.screenX, screenY: best.screenY } : null;
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
    const moved =
      Math.hypot(event.clientX - this.#dragStart.x, event.clientY - this.#dragStart.y) > 5;
    this.#dragging = false;
    this.#canvas.style.cursor = 'grab';

    // A drag pans; only a genuine click selects.
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
    this.#stars = Array.from({ length: Math.max(24, count) }, () => ({
      x: Math.random() * rect.width,
      y: Math.random() * rect.height * 0.7,
      r: Math.random() * 1.1 + 0.25,
      twinkle: Math.random() * Math.PI * 2,
    }));
  }
}

// ─── Palette ────────────────────────────────────────────────────────────────

interface BuildingPalette {
  left: string;
  right: string;
  roof: string;
  accent: string;
}

/** Each department has its own material identity, so the map reads spatially. */
const BUILDING_PALETTE: Record<string, BuildingPalette> = {
  'command-center': { left: '#132a44', right: '#0d1f34', roof: '#1d3d5e', accent: '#38bdf8' },
  'research-tower': { left: '#123243', right: '#0c2532', roof: '#1a4658', accent: '#22d3ee' },
  'analysis-lab': { left: '#241d43', right: '#1a1533', roof: '#332a5c', accent: '#a78bfa' },
  'partnership-center': { left: '#3a2c15', right: '#2b2010', roof: '#513e1f', accent: '#fbbf24' },
  'production-workshop': { left: '#3a1c22', right: '#2b141a', roof: '#51272f', accent: '#fb7185' },
  'communication-tower': { left: '#13332a', right: '#0d2620', roof: '#1b4a3b', accent: '#34d399' },
  'central-library': { left: '#152740', right: '#0f1d30', roof: '#1e3757', accent: '#60a5fa' },
  'automation-factory': { left: '#16303a', right: '#10232b', roof: '#1f4450', accent: '#22d3ee' },
  'evolution-observatory': { left: '#2b1d40', right: '#201530', roof: '#3d2a58', accent: '#c084fc' },
  default: { left: '#1a2438', right: '#131b2b', roof: '#243149', accent: '#7dd3fc' },
};

function withAlpha(colour: string, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha));
  if (colour.startsWith('#')) {
    const hex = colour.slice(1);
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${clamped})`;
  }
  if (colour.startsWith('hsl(')) return colour.replace('hsl(', 'hsla(').replace(')', ` / ${clamped})`);
  return colour;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
