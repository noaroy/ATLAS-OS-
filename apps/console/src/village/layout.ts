import type { Building } from '@atlas/contracts';

// ─── Projection ─────────────────────────────────────────────────────────────

/** Largeur et hauteur d'une tuile isométrique, en pixels. */
export const TILE_W = 104;
export const TILE_H = 52;

/** Grille → écran. La seule conversion du village ; tout le reste en découle. */
export const project = (x: number, y: number): { sx: number; sy: number } => ({
  sx: (x - y) * (TILE_W / 2),
  sy: (x + y) * (TILE_H / 2),
});

/**
 * La forme de la ville : districts, routes, et identité de chaque bâtiment.
 *
 * Ce module ne connaît que l'apparence. Les coordonnées, les niveaux et les
 * statuts viennent du serveur ; ce qui est décrit ici, c'est comment on les
 * dessine — quelle silhouette, quelle couleur, quelle route mène où.
 *
 * La séparation compte : ajouter une tourelle ou changer une teinte ne doit
 * jamais demander de toucher au backend, et inversement un bâtiment que le
 * serveur ne connaît pas ne doit pas pouvoir apparaître à l'écran.
 */

// ─── Districts ──────────────────────────────────────────────────────────────

export type DistrictKey = 'core' | 'discovery' | 'intelligence' | 'knowledge' | 'liaison';

export interface District {
  key: DistrictKey;
  label: string;
  /** Ce que le quartier fait, en une ligne, pour le panneau latéral. */
  role: string;
  accent: string;
  /** Teinte de la lueur au sol qui délimite le quartier. */
  ground: string;
}

export const DISTRICTS: District[] = [
  {
    key: 'core',
    label: 'Cœur',
    role: 'Commandement, stratégie, briefing',
    accent: '#38bdf8',
    ground: 'rgba(56, 189, 248, 0.09)',
  },
  {
    key: 'discovery',
    label: 'Découverte',
    role: 'Recherche de terrain et partenariats',
    accent: '#22d3ee',
    ground: 'rgba(34, 211, 238, 0.07)',
  },
  {
    key: 'intelligence',
    label: 'Intelligence',
    role: 'Analyse, notation, production des livrables',
    accent: '#a78bfa',
    ground: 'rgba(167, 139, 250, 0.07)',
  },
  {
    key: 'knowledge',
    label: 'Savoir',
    role: 'Archives, formation, observation du système',
    accent: '#60a5fa',
    ground: 'rgba(96, 165, 250, 0.07)',
  },
  {
    key: 'liaison',
    label: 'Liaison',
    role: 'Communication, logistique, supervision',
    accent: '#34d399',
    ground: 'rgba(52, 211, 153, 0.07)',
  },
];

export const DISTRICT_BY_KEY = new Map(DISTRICTS.map((d) => [d.key, d]));

// ─── Identité visuelle des bâtiments ────────────────────────────────────────

/**
 * La silhouette d'un bâtiment.
 *
 * Sept formes seulement : au-delà, on ne distingue plus rien d'un coup d'œil, ce
 * qui est précisément ce qu'une silhouette doit permettre.
 */
export type Archetype =
  | 'citadel' // le poste de commandement : masse centrale et noyau lumineux
  | 'tower' // haut et étroit — recherche, communication
  | 'hall' // large et bas, toit plat — réunions
  | 'lab' // corps vitré, coupole légère
  | 'vault' // trapu et massif — archives
  | 'works' // cheminées et halles — production, automatisation
  | 'dome'; // coupole — observatoire, formation

export interface BuildingStyle {
  district: DistrictKey;
  archetype: Archetype;
  /** Glyphe affiché sur la façade, lisible de loin. */
  glyph: string;
  /** Nom court pour les panneaux, quand le nom complet ne tient pas. */
  short: string;
  left: string;
  right: string;
  roof: string;
  accent: string;
}

const STYLE: Record<string, BuildingStyle> = {
  'command-center': {
    district: 'core',
    archetype: 'citadel',
    glyph: '◈',
    short: 'Commandement',
    left: '#14304d',
    right: '#0d2138',
    roof: '#1f4468',
    accent: '#38bdf8',
  },
  'strategy-hall': {
    district: 'core',
    archetype: 'hall',
    glyph: '⌬',
    short: 'Stratégie',
    left: '#1b2f4a',
    right: '#132235',
    roof: '#274563',
    accent: '#7dd3fc',
  },
  'war-room': {
    district: 'core',
    archetype: 'hall',
    glyph: '⊕',
    short: 'Salle de mission',
    left: '#2a2340',
    right: '#1d1930',
    roof: '#3a3057',
    accent: '#c4b5fd',
  },
  'research-tower': {
    district: 'discovery',
    archetype: 'tower',
    glyph: '◉',
    short: 'Recherche',
    left: '#123243',
    right: '#0c2532',
    roof: '#1a4658',
    accent: '#22d3ee',
  },
  'partnership-center': {
    district: 'discovery',
    archetype: 'hall',
    glyph: '⬡',
    short: 'Partenariats',
    left: '#3a2c15',
    right: '#2b2010',
    roof: '#513e1f',
    accent: '#fbbf24',
  },
  'analysis-lab': {
    district: 'intelligence',
    archetype: 'lab',
    glyph: '◎',
    short: 'Analyse',
    left: '#241d43',
    right: '#1a1533',
    roof: '#332a5c',
    accent: '#a78bfa',
  },
  'production-workshop': {
    district: 'intelligence',
    archetype: 'works',
    glyph: '▤',
    short: 'Production',
    left: '#3a1c22',
    right: '#2b141a',
    roof: '#51272f',
    accent: '#fb7185',
  },
  'central-library': {
    district: 'knowledge',
    archetype: 'vault',
    glyph: '▦',
    short: 'Archives',
    left: '#152740',
    right: '#0f1d30',
    roof: '#1e3757',
    accent: '#60a5fa',
  },
  'training-academy': {
    district: 'knowledge',
    archetype: 'dome',
    glyph: '✦',
    short: 'Académie',
    left: '#1c3040',
    right: '#14222e',
    roof: '#28455a',
    accent: '#7dd3fc',
  },
  'evolution-observatory': {
    district: 'knowledge',
    archetype: 'dome',
    glyph: '◐',
    short: 'Observatoire',
    left: '#2b1d40',
    right: '#201530',
    roof: '#3d2a58',
    accent: '#c084fc',
  },
  'communication-tower': {
    district: 'liaison',
    archetype: 'tower',
    glyph: '⌁',
    short: 'Communication',
    left: '#13332a',
    right: '#0d2620',
    roof: '#1b4a3b',
    accent: '#34d399',
  },
  'logistics-hub': {
    district: 'liaison',
    archetype: 'works',
    glyph: '⇄',
    short: 'Logistique',
    left: '#1d3327',
    right: '#14241c',
    roof: '#294a37',
    accent: '#4ade80',
  },
  'monitoring-station': {
    district: 'liaison',
    archetype: 'lab',
    glyph: '◍',
    short: 'Supervision',
    left: '#16303a',
    right: '#10232b',
    roof: '#1f4450',
    accent: '#22d3ee',
  },
  'automation-factory': {
    district: 'liaison',
    archetype: 'works',
    glyph: '⚙',
    short: 'Automatisation',
    left: '#16303a',
    right: '#10232b',
    roof: '#1f4450',
    accent: '#2dd4bf',
  },
};

const FALLBACK_STYLE: BuildingStyle = {
  district: 'core',
  archetype: 'hall',
  glyph: '◇',
  short: '—',
  left: '#1a2438',
  right: '#131b2b',
  roof: '#243149',
  accent: '#7dd3fc',
};

/**
 * Le style d'un bâtiment.
 *
 * Un bâtiment inconnu reçoit une silhouette neutre plutôt que de disparaître :
 * si le serveur en déclare un nouveau, il doit apparaître à l'écran — quitte à
 * être laid — au lieu d'être silencieusement absent de la carte.
 */
export const styleOf = (key: string): BuildingStyle => STYLE[key] ?? FALLBACK_STYLE;

export const districtOf = (key: string): District =>
  DISTRICT_BY_KEY.get(styleOf(key).district) ?? DISTRICTS[0]!;

// ─── Le réseau routier ──────────────────────────────────────────────────────

/**
 * Les routes, déclarées par paires de bâtiments.
 *
 * Un réseau, et non une étoile. L'étoile d'origine — un trait du centre vers
 * chaque bâtiment — disait quelque chose de faux : que rien ne circule
 * directement entre deux départements. Or un livrable passe bien de l'analyse à
 * la production sans repasser par le commandement.
 *
 * Les routes servent aussi au déplacement : un villageois suit le réseau plutôt
 * que de traverser les façades en diagonale.
 */
export const ROADS: Array<[string, string]> = [
  // Le cœur, relié à ses deux salles
  ['command-center', 'strategy-hall'],
  ['command-center', 'war-room'],
  ['strategy-hall', 'war-room'],

  // Les rayons vers la couronne
  ['command-center', 'research-tower'],
  ['command-center', 'analysis-lab'],
  ['command-center', 'central-library'],
  ['command-center', 'communication-tower'],
  ['strategy-hall', 'partnership-center'],
  ['war-room', 'production-workshop'],

  // La couronne : le vrai trajet d'un livrable, d'ouest en est
  ['research-tower', 'analysis-lab'],
  ['analysis-lab', 'production-workshop'],
  ['production-workshop', 'communication-tower'],
  ['partnership-center', 'research-tower'],
  ['communication-tower', 'logistics-hub'],
  ['logistics-hub', 'partnership-center'],

  // Le nord : le savoir
  ['central-library', 'training-academy'],
  ['central-library', 'evolution-observatory'],
  ['training-academy', 'research-tower'],
  ['evolution-observatory', 'analysis-lab'],

  // Le sud et la périphérie
  ['communication-tower', 'monitoring-station'],
  ['monitoring-station', 'production-workshop'],
  ['logistics-hub', 'automation-factory'],
  ['automation-factory', 'research-tower'],
];

export interface RoadSegment {
  from: string;
  to: string;
  /** Coordonnées de grille, résolues depuis les bâtiments du serveur. */
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/**
 * Résout les routes contre les bâtiments réellement présents.
 *
 * Une route dont une extrémité manque est écartée : mieux vaut un réseau
 * incomplet qu'un trait partant vers un bâtiment qui n'existe pas.
 */
export function resolveRoads(buildings: Building[]): RoadSegment[] {
  const byKey = new Map(buildings.map((b) => [b.key, b]));
  const out: RoadSegment[] = [];

  for (const [from, to] of ROADS) {
    const a = byKey.get(from);
    const b = byKey.get(to);
    if (!a || !b) continue;
    out.push({ from, to, ax: a.x, ay: a.y, bx: b.x, by: b.y });
  }
  return out;
}

/**
 * Le graphe des routes, pour se déplacer d'un bâtiment à l'autre.
 *
 * Un villageois qui traverse la place en diagonale casse l'illusion de ville
 * plus sûrement qu'un bâtiment mal dessiné. Le chemin est cherché en largeur :
 * le réseau compte deux douzaines d'arêtes, la simplicité vaut mieux ici que
 * l'optimalité.
 */
export function buildGraph(buildings: Building[]): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const building of buildings) graph.set(building.key, []);

  for (const segment of resolveRoads(buildings)) {
    graph.get(segment.from)?.push(segment.to);
    graph.get(segment.to)?.push(segment.from);
  }
  return graph;
}

/** Le chemin le plus court entre deux bâtiments, extrémités comprises. */
export function routeBetween(graph: Map<string, string[]>, from: string, to: string): string[] {
  if (from === to) return [from];
  if (!graph.has(from) || !graph.has(to)) return [from, to];

  const previous = new Map<string, string>([[from, from]]);
  const queue = [from];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of graph.get(current) ?? []) {
      if (previous.has(next)) continue;
      previous.set(next, current);
      if (next === to) {
        const path = [to];
        let step = to;
        while (step !== from) {
          step = previous.get(step)!;
          path.unshift(step);
        }
        return path;
      }
      queue.push(next);
    }
  }

  // Graphe déconnecté : la ligne droite reste préférable à l'immobilité.
  return [from, to];
}

// ─── Cadrage de la caméra ───────────────────────────────────────────────────

export interface CityFrame {
  x: number;
  y: number;
  zoom: number;
  /** Emprise de la ville à l'écran, une fois le zoom appliqué. */
  widthPx: number;
  heightPx: number;
}

/**
 * Ce que la silhouette d'un bâtiment occupe au-dessus et autour de sa base.
 *
 * Le cadrage doit tenir compte du volume dessiné, pas seulement du point de
 * pose : une tour de cent pixels cadrée sur sa base sort du haut de l'écran, et
 * c'est exactement ce qui donnait l'impression d'un diagramme flottant plutôt
 * que d'une ville posée.
 */
const SILHOUETTE_ABOVE = 210;
const SILHOUETTE_BELOW = 46;
const SILHOUETTE_SIDE = 86;

/**
 * La part de la vue que la cité doit remplir.
 *
 * Un peu moins en largeur qu'en hauteur : les panneaux latéraux mordent sur les
 * bords, et une ville calée au ras du cadre donne le sentiment d'être à
 * l'étroit plutôt que dense.
 */
export const CITY_FILL_X = 0.8;
export const CITY_FILL_Y = 0.86;

/**
 * Cadre la cité dans une vue donnée.
 *
 * Fonction pure, hors du moteur de rendu, pour qu'un test puisse vérifier
 * qu'aucun bâtiment ne sort de l'écran sans avoir à instancier un canevas.
 */
export function frameCity(buildings: Building[], viewWidth: number, viewHeight: number): CityFrame {
  if (buildings.length === 0) return { x: 0, y: 0, zoom: 1, widthPx: 0, heightPx: 0 };

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const building of buildings) {
    const { sx, sy } = project(building.x, building.y);
    minX = Math.min(minX, sx - SILHOUETTE_SIDE);
    maxX = Math.max(maxX, sx + SILHOUETTE_SIDE);
    minY = Math.min(minY, sy - SILHOUETTE_ABOVE);
    maxY = Math.max(maxY, sy + SILHOUETTE_BELOW);
  }

  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);

  const zoom = Math.max(
    0.28,
    Math.min(2.2, Math.min((viewWidth * CITY_FILL_X) / spanX, (viewHeight * CITY_FILL_Y) / spanY)),
  );

  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    zoom,
    widthPx: spanX * zoom,
    heightPx: spanY * zoom,
  };
}

/**
 * La distance d'un point à un segment, en unités de grille.
 *
 * Sert à vérifier qu'une rue ne traverse pas un bâtiment qu'elle ne dessert
 * pas — le genre de défaut qui passe inaperçu au typecheck et saute aux yeux à
 * l'écran.
 */
export function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);

  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
