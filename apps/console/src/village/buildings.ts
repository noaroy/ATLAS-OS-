import {
  dish,
  isoCylinder,
  isoDome,
  isoFootprint,
  isoPrism,
  mast,
  orbitRing,
  plume,
  screen,
  windowBand,
  withAlpha,
  type Palette,
} from './draw.ts';
import { styleOf } from './layout.ts';

/**
 * Les quatorze bâtiments, un par un.
 *
 * Chacun a sa propre fonction de dessin. C'est volontairement répétitif : la
 * seule façon d'obtenir une ville plutôt qu'un diagramme est que chaque édifice
 * ait une silhouette qu'on reconnaît de loin, et une silhouette reconnaissable
 * ne se paramètre pas — elle se dessine.
 *
 * Un bâtiment sans peintre reçoit un volume générique. Il aura l'air pauvre, ce
 * qui est le bon signal : cela se voit, et cela se corrige.
 */

export interface PaintContext {
  ctx: CanvasRenderingContext2D;
  /** Centre de l'empreinte au sol, en coordonnées écran. */
  cx: number;
  cy: number;
  /** Temps écoulé, en millisecondes, pour les animations. */
  time: number;
  /** Niveau du bâtiment : ce qu'il a accumulé de travail réel. */
  level: number;
  /** 0 au repos, 1 en pleine activité. Dérivé du statut réel. */
  lit: number;
  status: 'nominal' | 'busy' | 'alert' | 'locked';
  palette: Palette;
}

type Painter = (paint: PaintContext) => void;

/**
 * Facteur d'échelle appliqué à toutes les silhouettes.
 *
 * Les volumes ont d'abord été dessinés à l'échelle de la tuile, ce qui laissait
 * les bâtiments occuper environ un quart de l'écran pour trois quarts de sol
 * vide. Une ville dense ne se fabrique pas en rapprochant les bâtiments — les
 * rues ont besoin de leur largeur — mais en leur donnant du volume.
 *
 * 1,62 est la limite praticable : les parvis les plus proches sont séparés de
 * 195 px, et une empreinte de base d'environ 110 px laisse encore un passage
 * entre deux façades. Au-delà, les bâtiments se touchent.
 */
export const BUILDING_SCALE = 1.62;

/** Hauteur totale d'une silhouette, pour placer l'étiquette et la zone cliquable. */
export function heightOf(key: string, level: number): number {
  const growth = (level - 1) * 9;
  return ((BASE_HEIGHT[key] ?? 66) + growth) * BUILDING_SCALE;
}

/**
 * Hauteur de base de chaque silhouette, avant le facteur d'échelle.
 *
 * Le poste de commandement doit dominer d'au moins un tiers. À 128 il culminait
 * à 191 px pour 188 à la tour de communication : deux édifices à égalité, et
 * plus aucun centre lisible. La hiérarchie d'une ville se lit d'abord à sa
 * ligne d'horizon.
 */
const BASE_HEIGHT: Record<string, number> = {
  'command-center': 158,
  'strategy-hall': 62,
  'war-room': 52,
  'research-tower': 108,
  'analysis-lab': 74,
  'partnership-center': 68,
  'production-workshop': 72,
  'central-library': 86,
  'training-academy': 66,
  'evolution-observatory': 78,
  'communication-tower': 116,
  'logistics-hub': 54,
  'monitoring-station': 70,
  'automation-factory': 64,
};

// ─── Le cœur ────────────────────────────────────────────────────────────────

/**
 * Poste de commandement : trois corps empilés, un porche, un noyau.
 *
 * Il doit dominer sans écraser. La masse vient des étages en retrait, pas d'une
 * hauteur seule — une tour isolée aurait l'air d'une antenne, pas d'un siège.
 */
const commandCenter: Painter = ({ ctx, cx, cy, time, lit, palette, level }) => {
  const accent = palette.accent;

  // Quatre corps en retrait successif : la masse monte en s'affinant, ce qui
  // donne la dominance sans qu'un seul volume écrase la place.
  isoPrism(ctx, cx, cy, 64, 32, 22, palette, 0.85);
  isoPrism(ctx, cx, cy - 22, 52, 26, 56, palette, 1);
  windowBand(ctx, cx, cy - 22, 52, 26, 16, accent, 0.35 + lit * 0.55, 4);
  windowBand(ctx, cx, cy - 22, 52, 26, 38, accent, 0.3 + lit * 0.5, 4);
  isoPrism(ctx, cx, cy - 78, 36, 18, 44, palette, 1.12);
  windowBand(ctx, cx, cy - 78, 36, 18, 16, accent, 0.4 + lit * 0.5, 3);
  windowBand(ctx, cx, cy - 78, 36, 18, 34, accent, 0.35 + lit * 0.45, 3);
  isoPrism(ctx, cx, cy - 122, 21, 11, 28, palette, 1.25);

  // Porche : l'entrée se voit, la ville a une adresse.
  ctx.fillStyle = withAlpha(accent, 0.22 + lit * 0.3);
  ctx.beginPath();
  ctx.moveTo(cx - 12, cy + 16);
  ctx.lineTo(cx, cy + 22);
  ctx.lineTo(cx, cy + 4);
  ctx.lineTo(cx - 12, cy - 2);
  ctx.closePath();
  ctx.fill();

  // Deux mâts de part et d'autre.
  const blink = 0.45 + Math.sin(time / 520) * 0.4;
  mast(ctx, cx - 56, cy - 14, 44, accent, blink);
  mast(ctx, cx + 56, cy - 14, 44, accent, blink * 0.8);

  // Le noyau : ce qui signale qu'Hermès veille.
  const coreY = cy - 158;
  const pulse = 0.5 + Math.sin(time / (430 - lit * 150)) * 0.35;

  const halo = ctx.createRadialGradient(cx, coreY, 0, cx, coreY, 58);
  halo.addColorStop(0, withAlpha(accent, (0.34 + lit * 0.3) * pulse));
  halo.addColorStop(1, withAlpha(accent, 0));
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, coreY, 58, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = `rgba(224, 247, 255, ${0.75 + pulse * 0.25})`;
  ctx.beginPath();
  ctx.arc(cx, coreY, 8 + pulse * 2.6, 0, Math.PI * 2);
  ctx.fill();

  for (let ring = 0; ring < 3; ring++) {
    orbitRing(
      ctx,
      cx,
      coreY,
      20 + ring * 10,
      time / (900 + ring * 520) + ring,
      withAlpha(accent, 0.42 - ring * 0.11),
    );
  }

  // Un fanion par niveau gagné : la croissance se lit.
  for (let i = 0; i < Math.min(level, 5); i++) {
    ctx.fillStyle = withAlpha(accent, 0.5);
    ctx.fillRect(cx - 30 + i * 15, cy - 128, 2, 9);
  }
};

/** Salle de stratégie : institutionnelle, colonnade et fronton. */
const strategyHall: Painter = ({ ctx, cx, cy, time, lit, palette }) => {
  isoPrism(ctx, cx, cy, 52, 26, 10, palette, 0.8); // parvis surélevé
  isoPrism(ctx, cx, cy - 10, 44, 22, 34, palette, 1);

  // Colonnade sur la face avant gauche.
  for (let i = 0; i < 4; i++) {
    const t = (i + 0.5) / 4;
    const x = cx - 44 + 44 * t;
    const y = cy - 10 + 22 * t;
    ctx.fillStyle = withAlpha(palette.accent, 0.3);
    ctx.fillRect(x - 1.5, y - 32, 3, 30);
  }

  // Fronton.
  ctx.fillStyle = withAlpha(palette.accent, 0.26);
  ctx.beginPath();
  ctx.moveTo(cx - 44, cy - 44);
  ctx.lineTo(cx, cy - 56);
  ctx.lineTo(cx + 44, cy - 44);
  ctx.closePath();
  ctx.fill();

  // Table de conseil éclairée à travers le toit.
  const glow = 0.2 + Math.sin(time / 900) * 0.08 + lit * 0.3;
  ctx.fillStyle = withAlpha(palette.accent, glow);
  ctx.beginPath();
  ctx.ellipse(cx, cy - 46, 16, 7, 0, 0, Math.PI * 2);
  ctx.fill();
};

/** Salle de mission : bunker bas, murs inclinés, meurtrière lumineuse. */
const warRoom: Painter = ({ ctx, cx, cy, time, lit, palette }) => {
  isoPrism(ctx, cx, cy, 46, 23, 8, palette, 0.75);
  isoPrism(ctx, cx, cy - 8, 38, 19, 26, palette, 1);

  // Bandeau lumineux : la ligne de situation.
  const sweep = (time / 2200) % 1;
  ctx.fillStyle = withAlpha(palette.accent, 0.18 + lit * 0.35);
  ctx.fillRect(cx - 34, cy - 26, 68, 4);
  ctx.fillStyle = withAlpha(palette.accent, 0.75);
  ctx.fillRect(cx - 34 + sweep * 60, cy - 26, 8, 4);

  // Toit blindé, en pans.
  ctx.fillStyle = withAlpha(palette.roof, 1);
  isoFootprint(ctx, cx, cy - 36, 30, 15);
  ctx.fill();
  ctx.strokeStyle = withAlpha(palette.accent, 0.35);
  ctx.lineWidth = 1;
  ctx.stroke();

  // Antenne courte.
  mast(ctx, cx + 22, cy - 34, 18, palette.accent, 0.4 + Math.sin(time / 400) * 0.35);
};

// ─── Découverte ─────────────────────────────────────────────────────────────

/** Tour de recherche : haute et fine, écrans scientifiques, antennes. */
const researchTower: Painter = ({ ctx, cx, cy, time, lit, palette }) => {
  isoPrism(ctx, cx, cy, 44, 22, 12, palette, 0.8);
  isoPrism(ctx, cx, cy - 12, 26, 13, 78, palette, 1);

  for (let row = 0; row < 5; row++) {
    windowBand(ctx, cx, cy - 12, 26, 13, 14 + row * 15, palette.accent, 0.3 + lit * 0.5, 2);
  }

  // Bandeau d'écrans sur la face gauche.
  screen(ctx, cx - 16, cy + 2, 14, 18, palette.accent, lit * 0.6 + (time / 3000) % 1);

  // Coiffe et antennes.
  isoPrism(ctx, cx, cy - 90, 16, 8, 14, palette, 1.2);
  mast(ctx, cx, cy - 104, 26, palette.accent, 0.4 + Math.sin(time / 420) * 0.4);
  dish(ctx, cx - 14, cy - 96, 8, -0.5 + Math.sin(time / 2600) * 0.2, withAlpha(palette.accent, 0.45));
  dish(ctx, cx + 14, cy - 92, 6, 0.6, withAlpha(palette.accent, 0.35));
};

/** Centre des partenariats : diplomatique, marches, portique, anneaux. */
const partnershipCenter: Painter = ({ ctx, cx, cy, time, lit, palette }) => {
  // Marches.
  for (let i = 0; i < 3; i++) {
    isoPrism(ctx, cx, cy - i * 4, 50 - i * 6, 25 - i * 3, 4, palette, 0.72 + i * 0.06);
  }
  isoPrism(ctx, cx, cy - 12, 36, 18, 32, palette, 1);
  windowBand(ctx, cx, cy - 12, 36, 18, 14, palette.accent, 0.35 + lit * 0.45, 3);

  // Portique.
  ctx.strokeStyle = withAlpha(palette.accent, 0.4);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy - 12, 20, Math.PI, 0);
  ctx.stroke();

  // Anneaux flottants : les liaisons vers l'extérieur.
  for (let i = 0; i < 2; i++) {
    orbitRing(
      ctx,
      cx,
      cy - 56 - i * 8,
      18 - i * 5,
      time / (1600 + i * 700) + i,
      withAlpha(palette.accent, 0.35 - i * 0.1),
    );
  }
};

// ─── Intelligence ───────────────────────────────────────────────────────────

/** Laboratoire d'analyse : corps vitré, grand anneau instrumenté. */
const analysisLab: Painter = ({ ctx, cx, cy, time, lit, palette }) => {
  isoPrism(ctx, cx, cy, 46, 23, 10, palette, 0.8);
  isoCylinder(ctx, cx, cy - 10, 30, 34, palette, 1);

  // Bandeau vitré.
  ctx.fillStyle = withAlpha(palette.accent, 0.14 + lit * 0.3);
  ctx.fillRect(cx - 30, cy - 34, 60, 10);
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = withAlpha(palette.accent, 0.3 + Math.sin(time / 600 + i) * 0.2);
    ctx.fillRect(cx - 26 + i * 9, cy - 33, 4, 8);
  }

  isoDome(ctx, cx, cy - 44, 22, withAlpha(palette.accent, 0.2));
  ctx.strokeStyle = withAlpha(palette.accent, 0.5);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.ellipse(cx, cy - 44, 22, 19, 0, Math.PI, 0);
  ctx.stroke();

  // L'anneau d'instruments, plus rapide quand le laboratoire travaille.
  const speed = 2600 - lit * 1400;
  orbitRing(ctx, cx, cy - 52, 34, time / speed, withAlpha(palette.accent, 0.5), 2);
  orbitRing(ctx, cx, cy - 52, 24, -time / (speed * 1.4), withAlpha(palette.accent, 0.3));

  // Bras d'instrument.
  const arm = time / speed;
  ctx.fillStyle = withAlpha(palette.accent, 0.8);
  ctx.beginPath();
  ctx.arc(cx + Math.cos(arm) * 34, cy - 52 + Math.sin(arm) * 11, 2.6, 0, Math.PI * 2);
  ctx.fill();
};

/** Atelier de production : halle, toit en dents de scie, cheminées, bras. */
const productionWorkshop: Painter = ({ ctx, cx, cy, time, lit, palette }) => {
  isoPrism(ctx, cx, cy, 52, 26, 8, palette, 0.78);
  isoPrism(ctx, cx, cy - 8, 44, 22, 30, palette, 1);

  // Toit en dents de scie : la marque d'une halle industrielle.
  for (let i = 0; i < 3; i++) {
    const t = (i + 0.5) / 3;
    const x = cx - 44 + 88 * t;
    ctx.fillStyle = withAlpha(palette.roof, 1.0);
    ctx.beginPath();
    ctx.moveTo(x - 14, cy - 38);
    ctx.lineTo(x, cy - 50);
    ctx.lineTo(x + 14, cy - 38);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = withAlpha(palette.accent, 0.2 + lit * 0.35);
    ctx.beginPath();
    ctx.moveTo(x, cy - 50);
    ctx.lineTo(x + 14, cy - 38);
    ctx.lineTo(x + 14, cy - 41);
    ctx.lineTo(x, cy - 53);
    ctx.closePath();
    ctx.fill();
  }

  // Portes de quai.
  for (let i = 0; i < 2; i++) {
    ctx.fillStyle = withAlpha(palette.accent, 0.18 + lit * 0.25);
    ctx.fillRect(cx - 30 + i * 26, cy - 4, 14, 14);
  }

  // Cheminées et vapeur.
  for (const offset of [-30, 20]) {
    isoPrism(ctx, cx + offset, cy - 44, 5, 2.5, 22, palette, 1.15);
    plume(ctx, cx + offset, cy - 66, (time / (lit > 0.5 ? 1400 : 2800)) % 1, lit > 0.5 ? 0.24 : 0.1);
  }

  // Bras mécanique, qui balaie plus vite en production.
  const swing = Math.sin(time / (lit > 0.5 ? 700 : 1600)) * 0.6;
  ctx.strokeStyle = withAlpha(palette.accent, 0.55);
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(cx + 34, cy - 12);
  ctx.lineTo(cx + 34 + Math.cos(swing - 0.9) * 20, cy - 12 + Math.sin(swing - 0.9) * 14);
  ctx.stroke();
};

// ─── Savoir ─────────────────────────────────────────────────────────────────

/** Bibliothèque centrale : forteresse de données, contreforts, colonnes. */
const centralLibrary: Painter = ({ ctx, cx, cy, time, lit, palette }) => {
  isoPrism(ctx, cx, cy, 54, 27, 14, palette, 0.75);
  isoPrism(ctx, cx, cy - 14, 44, 22, 44, palette, 1);
  isoPrism(ctx, cx, cy - 58, 30, 15, 16, palette, 1.15);

  // Contreforts.
  for (const offset of [-38, 38]) {
    isoPrism(ctx, cx + offset, cy - 6, 7, 4, 40, palette, 0.9);
  }

  // Colonnes de données : la mémoire qui se recharge en continu.
  for (let i = 0; i < 5; i++) {
    const x = cx - 30 + i * 15;
    const h = 26 + Math.sin(time / 1100 + i * 1.6) * 7;
    ctx.fillStyle = withAlpha(palette.accent, 0.18 + lit * 0.3);
    ctx.fillRect(x - 2.5, cy - 16 - h, 5, h);
    ctx.fillStyle = withAlpha(palette.accent, 0.7);
    ctx.fillRect(x - 2.5, cy - 16 - h, 5, 2.5);
  }

  // Grande porte voûtée.
  ctx.fillStyle = withAlpha(palette.accent, 0.16 + lit * 0.2);
  ctx.beginPath();
  ctx.moveTo(cx - 10, cy + 4);
  ctx.lineTo(cx, cy + 9);
  ctx.lineTo(cx, cy - 8);
  ctx.lineTo(cx - 10, cy - 13);
  ctx.closePath();
  ctx.fill();
};

/** Académie : deux ailes autour d'une cour, arche d'entrée. */
const trainingAcademy: Painter = ({ ctx, cx, cy, time, lit, palette }) => {
  isoPrism(ctx, cx, cy, 50, 25, 8, palette, 0.78);
  // Deux ailes, laissant une cour au milieu.
  isoPrism(ctx, cx - 26, cy - 6, 20, 10, 32, palette, 1);
  isoPrism(ctx, cx + 26, cy - 6, 20, 10, 32, palette, 0.95);
  windowBand(ctx, cx - 26, cy - 6, 20, 10, 14, palette.accent, 0.3 + lit * 0.4, 2);
  windowBand(ctx, cx + 26, cy - 6, 20, 10, 14, palette.accent, 0.3 + lit * 0.4, 2);

  // Cour éclairée.
  ctx.fillStyle = withAlpha(palette.accent, 0.1 + lit * 0.16);
  isoFootprint(ctx, cx, cy - 6, 18, 9);
  ctx.fill();

  // Arche.
  ctx.strokeStyle = withAlpha(palette.accent, 0.45);
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.arc(cx, cy - 12, 17, Math.PI, 0);
  ctx.stroke();

  // Hologramme d'enseignement, qui tourne lentement au-dessus de la cour.
  const spin = time / 2400;
  for (let i = 0; i < 3; i++) {
    const a = spin + (i * Math.PI * 2) / 3;
    ctx.fillStyle = withAlpha(palette.accent, 0.4);
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * 9, cy - 34 + Math.sin(a) * 3.5, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
};

/** Observatoire : coupole fendue, télescope, ciel scruté. */
const evolutionObservatory: Painter = ({ ctx, cx, cy, time, lit, palette }) => {
  isoPrism(ctx, cx, cy, 44, 22, 12, palette, 0.8);
  isoCylinder(ctx, cx, cy - 12, 26, 30, palette, 1);
  windowBand(ctx, cx, cy - 12, 22, 11, 14, palette.accent, 0.28 + lit * 0.35, 2);

  isoDome(ctx, cx, cy - 42, 27, palette.roof);
  // Fente de la coupole.
  ctx.fillStyle = withAlpha(palette.accent, 0.22 + lit * 0.3);
  ctx.beginPath();
  ctx.moveTo(cx - 4, cy - 42);
  ctx.lineTo(cx + 4, cy - 42);
  ctx.lineTo(cx + 3, cy - 66);
  ctx.lineTo(cx - 3, cy - 66);
  ctx.closePath();
  ctx.fill();

  // Télescope, orienté lentement.
  const aim = -0.9 + Math.sin(time / 5200) * 0.35;
  ctx.strokeStyle = withAlpha(palette.accent, 0.6);
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 52);
  ctx.lineTo(cx + Math.cos(aim) * 26, cy - 52 + Math.sin(aim) * 20);
  ctx.stroke();

  // Faisceau d'observation.
  ctx.strokeStyle = withAlpha(palette.accent, 0.12 + lit * 0.12);
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(cx + Math.cos(aim) * 26, cy - 52 + Math.sin(aim) * 20);
  ctx.lineTo(cx + Math.cos(aim) * 90, cy - 52 + Math.sin(aim) * 70);
  ctx.stroke();
};

// ─── Liaison ────────────────────────────────────────────────────────────────

/** Tour de communication : treillis, relais, ondes. */
const communicationTower: Painter = ({ ctx, cx, cy, time, lit, palette }) => {
  isoPrism(ctx, cx, cy, 40, 20, 14, palette, 0.8);
  isoPrism(ctx, cx, cy - 14, 22, 11, 26, palette, 1);
  windowBand(ctx, cx, cy - 14, 22, 11, 12, palette.accent, 0.3 + lit * 0.4, 2);

  // Treillis : deux montants qui se rapprochent, entretoises croisées.
  const baseY = cy - 40;
  const topY = cy - 106;
  ctx.strokeStyle = withAlpha(palette.accent, 0.45);
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(cx - 14, baseY);
  ctx.lineTo(cx - 4, topY);
  ctx.moveTo(cx + 14, baseY);
  ctx.lineTo(cx + 4, topY);
  ctx.stroke();

  ctx.lineWidth = 0.9;
  for (let i = 0; i < 6; i++) {
    const t0 = i / 6;
    const t1 = (i + 1) / 6;
    const y0 = baseY + (topY - baseY) * t0;
    const y1 = baseY + (topY - baseY) * t1;
    const w0 = 14 - 10 * t0;
    const w1 = 14 - 10 * t1;
    ctx.beginPath();
    ctx.moveTo(cx - w0, y0);
    ctx.lineTo(cx + w1, y1);
    ctx.moveTo(cx + w0, y0);
    ctx.lineTo(cx - w1, y1);
    ctx.stroke();
  }

  dish(ctx, cx - 12, cy - 74, 9, -0.4, withAlpha(palette.accent, 0.5));
  dish(ctx, cx + 12, cy - 88, 7, 0.5, withAlpha(palette.accent, 0.4));
  mast(ctx, cx, cy - 106, 16, palette.accent, 0.45 + Math.sin(time / 380) * 0.4);

  // Ondes émises, plus larges quand la ville communique.
  for (let i = 0; i < 3; i++) {
    const t = ((time / 1500 + i / 3) % 1);
    ctx.strokeStyle = withAlpha(palette.accent, (1 - t) * (0.14 + lit * 0.2));
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.ellipse(cx, cy - 118, 12 + t * 46, (12 + t * 46) * 0.34, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
};

/** Halle logistique : quais, conteneurs empilés, navette. */
const logisticsHub: Painter = ({ ctx, cx, cy, time, lit, palette }) => {
  isoPrism(ctx, cx, cy, 54, 27, 7, palette, 0.75);
  isoPrism(ctx, cx - 12, cy - 7, 30, 15, 26, palette, 1);

  // Toit courbe de la halle.
  ctx.fillStyle = palette.roof;
  ctx.beginPath();
  ctx.ellipse(cx - 12, cy - 33, 30, 11, 0, Math.PI, 0);
  ctx.fill();

  // Quais de chargement.
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = withAlpha(palette.accent, 0.16 + lit * 0.22);
    ctx.fillRect(cx - 34 + i * 14, cy - 6, 9, 9);
  }

  // Conteneurs empilés, couleurs alternées : le désordre ordonné d'un dépôt.
  const stacks = [
    { x: 26, y: 2, n: 3 },
    { x: 40, y: -4, n: 2 },
    { x: 14, y: 10, n: 1 },
  ];
  for (const stack of stacks) {
    for (let i = 0; i < stack.n; i++) {
      isoPrism(ctx, cx + stack.x, cy + stack.y - i * 9, 9, 4.5, 9, palette, 0.85 + (i % 2) * 0.3);
    }
  }

  // Navette qui fait la navette entre deux quais.
  const t = (time / 3000) % 1;
  const sx = cx - 30 + t * 54;
  ctx.fillStyle = withAlpha(palette.accent, 0.55);
  ctx.beginPath();
  ctx.ellipse(sx, cy + 14 - t * 4, 7, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = withAlpha(palette.accent, 0.2);
  ctx.beginPath();
  ctx.ellipse(sx, cy + 18 - t * 4, 8, 2.4, 0, 0, Math.PI * 2);
  ctx.fill();
};

/** Station de supervision : écrans, radar, poste technique. */
const monitoringStation: Painter = ({ ctx, cx, cy, time, lit, palette, status }) => {
  isoPrism(ctx, cx, cy, 42, 21, 10, palette, 0.8);
  isoPrism(ctx, cx, cy - 10, 32, 16, 28, palette, 1);

  // Mur d'écrans.
  screen(ctx, cx - 14, cy - 16, 16, 12, palette.accent, lit * 0.8 + ((time / 2000) % 1) * 0.2);
  screen(ctx, cx + 8, cy - 14, 12, 9, palette.accent, lit * 0.6 + ((time / 2600) % 1) * 0.2);

  // Radar : balayage continu, plus rapide en alerte.
  const radarY = cy - 44;
  ctx.strokeStyle = withAlpha(palette.accent, 0.3);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(cx, radarY, 20, 7, 0, 0, Math.PI * 2);
  ctx.stroke();

  const sweep = time / (status === 'alert' ? 700 : 2000);
  ctx.strokeStyle = withAlpha(status === 'alert' ? '#fb7185' : palette.accent, 0.7);
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(cx, radarY);
  ctx.lineTo(cx + Math.cos(sweep) * 20, radarY + Math.sin(sweep) * 7);
  ctx.stroke();

  isoPrism(ctx, cx, cy - 38, 8, 4, 6, palette, 1.2);
};

/** Fabrique d'automatisation : ligne continue, machines, drones. */
const automationFactory: Painter = ({ ctx, cx, cy, time, lit, palette }) => {
  isoPrism(ctx, cx, cy, 56, 28, 7, palette, 0.75);
  isoPrism(ctx, cx, cy - 7, 46, 23, 24, palette, 1);

  // Toit plat avec conduits.
  for (let i = 0; i < 3; i++) {
    isoPrism(ctx, cx - 24 + i * 24, cy - 31, 8, 4, 7, palette, 1.15);
  }

  // La ligne : des blocs qui avancent puis reviennent.
  for (let i = 0; i < 5; i++) {
    const t = ((time / 2600 + i / 5) % 1);
    const x = cx - 40 + t * 80;
    const y = cy - 2 + t * 6;
    ctx.fillStyle = withAlpha(palette.accent, 0.3 + lit * 0.4);
    ctx.fillRect(x - 3, y - 3, 6, 5);
  }
  ctx.strokeStyle = withAlpha(palette.accent, 0.22);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - 42, cy - 4);
  ctx.lineTo(cx + 40, cy + 3);
  ctx.stroke();

  // Deux drones en vol stationnaire.
  for (let i = 0; i < 2; i++) {
    const dx = cx - 20 + i * 40;
    const dy = cy - 44 + Math.sin(time / (900 + i * 300)) * 5;
    ctx.fillStyle = withAlpha(palette.accent, 0.6);
    ctx.beginPath();
    ctx.ellipse(dx, dy, 4, 1.8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = withAlpha(palette.accent, 0.25);
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(dx - 6, dy - 1);
    ctx.lineTo(dx + 6, dy - 1);
    ctx.stroke();
  }
};

/** Volume générique : visible, pauvre, donc corrigible. */
const generic: Painter = ({ ctx, cx, cy, lit, palette }) => {
  isoPrism(ctx, cx, cy, 40, 20, 10, palette, 0.8);
  isoPrism(ctx, cx, cy - 10, 32, 16, 40, palette, 1);
  windowBand(ctx, cx, cy - 10, 32, 16, 16, palette.accent, 0.3 + lit * 0.4, 3);
};

const PAINTERS: Record<string, Painter> = {
  'command-center': commandCenter,
  'strategy-hall': strategyHall,
  'war-room': warRoom,
  'research-tower': researchTower,
  'partnership-center': partnershipCenter,
  'analysis-lab': analysisLab,
  'production-workshop': productionWorkshop,
  'central-library': centralLibrary,
  'training-academy': trainingAcademy,
  'evolution-observatory': evolutionObservatory,
  'communication-tower': communicationTower,
  'logistics-hub': logisticsHub,
  'monitoring-station': monitoringStation,
  'automation-factory': automationFactory,
};

/** Y a-t-il une silhouette dédiée pour ce bâtiment ? */
export const hasPainter = (key: string): boolean => key in PAINTERS;

export function paintBuilding(key: string, paint: PaintContext): void {
  const painter = PAINTERS[key] ?? generic;
  const style = styleOf(key);
  const { ctx, cx, cy } = paint;

  // L'échelle s'applique autour du point de pose : le bâtiment grandit vers le
  // haut et sur les côtés, sans quitter son parvis.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(BUILDING_SCALE, BUILDING_SCALE);
  ctx.translate(-cx, -cy);
  painter({ ...paint, palette: { ...paint.palette, accent: style.accent } });
  ctx.restore();
}
