import { withAlpha } from './draw.ts';
import type { OccupationKind } from './life.ts';

/**
 * Les habitants.
 *
 * Un point coloré suffisait à dire « il y a quelqu'un là » ; il ne dit pas
 * qu'une ville est habitée. Une tête, un buste, deux jambes qui alternent — et
 * la scène cesse d'être un diagramme où des marqueurs glissent.
 *
 * Les silhouettes restent minuscules à l'écran, une vingtaine de pixels. Tout
 * l'effort porte donc sur la lisibilité de la posture : marche, arrêt, port
 * d'une caisse, consultation d'une console. C'est la posture qu'on lit à cette
 * taille, jamais le détail.
 */

export interface CharacterPose {
  /** Position au sol, en coordonnées écran. */
  x: number;
  y: number;
  /** Phase du cycle de marche, en radians. */
  phase: number;
  /** Vrai quand l'habitant se déplace. */
  walking: boolean;
  /** −1 vers la gauche, +1 vers la droite. */
  facing: -1 | 1;
  hue: number;
  accent: string;
  emblem: string;
  /** Ce qu'il fait, pour choisir la posture. */
  kind: OccupationKind;
  /** Vrai lorsque l'occupation vient du serveur. */
  real: boolean;
  /** État d'erreur : la posture ne change pas, la couleur si. */
  errored: boolean;
}

/** Ce que l'habitant tient ou utilise, déduit de son occupation. */
type Prop = 'none' | 'crate' | 'tablet' | 'console';

const PROP_BY_KIND: Partial<Record<OccupationKind, Prop>> = {
  logistics: 'crate',
  'report-delivery': 'crate',
  'archive-consultation': 'tablet',
  'knowledge-review': 'tablet',
  training: 'tablet',
  maintenance: 'console',
  inspection: 'console',
  'mission-task': 'console',
  briefing: 'tablet',
  council: 'tablet',
  'team-meeting': 'tablet',
};

export function drawCharacter(ctx: CanvasRenderingContext2D, pose: CharacterPose): void {
  const { x, y } = pose;
  const swing = pose.walking ? Math.sin(pose.phase) : 0;
  const lift = pose.walking ? Math.abs(Math.cos(pose.phase)) * 1.6 : 0;
  const base = y - lift;

  const skin = `hsl(${pose.hue} 40% 86%)`;
  const cloth = `hsl(${pose.hue} 72% 58%)`;
  const clothDark = `hsl(${pose.hue} 58% 38%)`;

  // Ombre : elle ancre le personnage au sol, sans quoi il flotte.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
  ctx.beginPath();
  ctx.ellipse(x, y + 1, 6.4, 2.4, 0, 0, Math.PI * 2);
  ctx.fill();

  const prop = PROP_BY_KIND[pose.kind] ?? 'none';

  // Une console posée devant l'habitant, quand il en consulte une.
  if (prop === 'console' && !pose.walking) {
    drawConsole(ctx, x + pose.facing * 8, base + 1, pose.accent, pose.real);
  }

  // Jambes : deux traits qui alternent. À cette taille, c'est tout ce qu'il
  // faut pour lire une marche.
  ctx.strokeStyle = clothDark;
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - 1.4, base - 7);
  ctx.lineTo(x - 1.4 + swing * 2.6, base - 0.5);
  ctx.moveTo(x + 1.4, base - 7);
  ctx.lineTo(x + 1.4 - swing * 2.6, base - 0.5);
  ctx.stroke();

  // Buste.
  ctx.fillStyle = cloth;
  ctx.beginPath();
  ctx.moveTo(x - 4.2, base - 7);
  ctx.quadraticCurveTo(x - 4.8, base - 15, x, base - 17);
  ctx.quadraticCurveTo(x + 4.8, base - 15, x + 4.2, base - 7);
  ctx.closePath();
  ctx.fill();

  // Épaulière, du côté du regard : donne une orientation lisible.
  ctx.fillStyle = clothDark;
  ctx.beginPath();
  ctx.ellipse(x + pose.facing * 3.4, base - 13.5, 2.2, 2.8, 0, 0, Math.PI * 2);
  ctx.fill();

  // Bras.
  ctx.strokeStyle = cloth;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  if (prop === 'crate') {
    // Les deux bras en avant, portant la caisse.
    ctx.moveTo(x - 3.6, base - 13);
    ctx.lineTo(x + pose.facing * 4.5, base - 10);
    ctx.moveTo(x + 3.6, base - 13);
    ctx.lineTo(x + pose.facing * 4.5, base - 10);
  } else if (prop === 'console' && !pose.walking) {
    // Un bras tendu vers la console.
    ctx.moveTo(x - pose.facing * 3.4, base - 13);
    ctx.lineTo(x - pose.facing * 4.6, base - 9);
    ctx.moveTo(x + pose.facing * 3.4, base - 13);
    ctx.lineTo(x + pose.facing * 7, base - 8);
  } else {
    ctx.moveTo(x - 3.6, base - 13);
    ctx.lineTo(x - 4.4 - swing * 1.8, base - 8);
    ctx.moveTo(x + 3.6, base - 13);
    ctx.lineTo(x + 4.4 + swing * 1.8, base - 8);
  }
  ctx.stroke();

  // Objet porté.
  if (prop === 'crate') {
    const cx = x + pose.facing * 6;
    const cy = base - 11;
    ctx.fillStyle = withAlpha(pose.accent, 0.75);
    ctx.fillRect(cx - 3, cy - 3, 6, 5.5);
    ctx.strokeStyle = withAlpha('#000000', 0.35);
    ctx.lineWidth = 0.7;
    ctx.strokeRect(cx - 3, cy - 3, 6, 5.5);
  } else if (prop === 'tablet') {
    const cx = x + pose.facing * 5.2;
    const cy = base - 11.5;
    ctx.fillStyle = withAlpha(pose.accent, 0.6);
    ctx.fillRect(cx - 2, cy - 2.6, 4, 4.4);
  }

  // Tête et visière.
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.arc(x, base - 21, 4.4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = pose.errored ? '#fb7185' : withAlpha(pose.accent, 0.85);
  ctx.beginPath();
  ctx.ellipse(x + pose.facing * 1.6, base - 21.4, 2.4, 1.5, 0, 0, Math.PI * 2);
  ctx.fill();

  // Emblème du spécialiste, sur le buste.
  ctx.font = "700 6px 'Inter', system-ui, sans-serif";
  ctx.textAlign = 'center';
  ctx.fillStyle = withAlpha('#04121f', 0.75);
  ctx.fillText(pose.emblem, x, base - 10.5);
}

/** Un pupitre lumineux, devant lequel un habitant travaille. */
function drawConsole(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  accent: string,
  bright: boolean,
): void {
  ctx.fillStyle = 'rgba(15, 25, 40, 0.9)';
  ctx.beginPath();
  ctx.moveTo(x - 5, y);
  ctx.lineTo(x + 5, y);
  ctx.lineTo(x + 4, y - 7);
  ctx.lineTo(x - 4, y - 7);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = withAlpha(accent, bright ? 0.75 : 0.4);
  ctx.beginPath();
  ctx.moveTo(x - 4, y - 7);
  ctx.lineTo(x + 4, y - 7);
  ctx.lineTo(x + 3.2, y - 11);
  ctx.lineTo(x - 3.2, y - 11);
  ctx.closePath();
  ctx.fill();

  // La lueur du pupitre sur le sol.
  ctx.fillStyle = withAlpha(accent, bright ? 0.16 : 0.08);
  ctx.beginPath();
  ctx.ellipse(x, y + 1, 9, 3.4, 0, 0, Math.PI * 2);
  ctx.fill();
}
