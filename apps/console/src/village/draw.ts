/**
 * Les primitives de dessin isométrique.
 *
 * Séparées du moteur pour une raison simple : une ville se distingue d'un
 * diagramme par la quantité de volume qu'elle montre, et le volume se construit
 * en empilant des formes. Tant que chaque bâtiment était un prisme recoloré, la
 * scène restait un graphe de nœuds — quelle que soit la qualité des couleurs.
 *
 * Toutes les fonctions travaillent en coordonnées écran : le point (cx, cy)
 * désigne le centre de l'empreinte au sol, et les hauteurs montent vers le haut.
 */

export interface Palette {
  left: string;
  right: string;
  roof: string;
  accent: string;
}

/** Le losange d'une empreinte au sol. */
export function isoFootprint(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  d: number,
): void {
  ctx.beginPath();
  ctx.moveTo(cx, cy - d);
  ctx.lineTo(cx + w, cy);
  ctx.lineTo(cx, cy + d);
  ctx.lineTo(cx - w, cy);
  ctx.closePath();
}

/**
 * Un volume rectangulaire : deux faces visibles et un toit.
 *
 * `shade` éclaircit ou assombrit l'ensemble, ce qui permet d'empiler des étages
 * en les distinguant sans multiplier les palettes.
 */
export function isoPrism(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  d: number,
  h: number,
  palette: Palette,
  shade = 1,
): void {
  const left = tint(palette.left, shade);
  const right = tint(palette.right, shade);
  const roof = tint(palette.roof, shade);

  // Face gauche
  ctx.fillStyle = left;
  ctx.beginPath();
  ctx.moveTo(cx - w, cy);
  ctx.lineTo(cx, cy + d);
  ctx.lineTo(cx, cy + d - h);
  ctx.lineTo(cx - w, cy - h);
  ctx.closePath();
  ctx.fill();

  // Face droite
  ctx.fillStyle = right;
  ctx.beginPath();
  ctx.moveTo(cx + w, cy);
  ctx.lineTo(cx, cy + d);
  ctx.lineTo(cx, cy + d - h);
  ctx.lineTo(cx + w, cy - h);
  ctx.closePath();
  ctx.fill();

  // Toit
  ctx.fillStyle = roof;
  isoFootprint(ctx, cx, cy - h, w, d);
  ctx.fill();
}

/** Un cylindre : socle elliptique, corps, couronne. */
export function isoCylinder(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  h: number,
  palette: Palette,
  shade = 1,
): void {
  const ry = r * 0.5;

  ctx.fillStyle = tint(palette.left, shade);
  ctx.beginPath();
  ctx.moveTo(cx - r, cy - h);
  ctx.lineTo(cx - r, cy);
  ctx.ellipse(cx, cy, r, ry, 0, Math.PI, 0, true);
  ctx.lineTo(cx + r, cy - h);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = tint(palette.roof, shade);
  ctx.beginPath();
  ctx.ellipse(cx, cy - h, r, ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** Une coupole. */
export function isoDome(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  colour: string,
): void {
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.ellipse(cx, cy, r, r * 0.86, 0, Math.PI, 0);
  ctx.closePath();
  ctx.fill();
}

/**
 * Une rangée de fenêtres sur la face gauche et la face droite.
 *
 * `lit` module l'éclairage : c'est ce qui fait qu'un bâtiment au travail se
 * remarque de loin sans qu'on ait à lire une étiquette.
 */
export function windowBand(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  d: number,
  y: number,
  accent: string,
  lit: number,
  count = 3,
): void {
  for (let i = 0; i < count; i++) {
    const t = (i + 1) / (count + 1);
    const flicker = 0.55 + Math.sin(y * 0.7 + i * 2.1) * 0.2;
    ctx.fillStyle = withAlpha(accent, Math.min(1, lit * flicker));

    // Gauche : on suit l'arête qui descend de (cx-w, cy) vers (cx, cy+d).
    const lx = cx - w + w * t;
    const ly = cy + d * t;
    ctx.fillRect(lx - 2, ly - y - 4, 4, 5.5);

    // Droite : arête symétrique.
    const rx = cx + w - w * t;
    const ry = cy + d * t;
    ctx.fillRect(rx - 2, ry - y - 4, 4, 5.5);
  }
}

/** Un mât, avec sa balise au sommet. */
export function mast(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  height: number,
  accent: string,
  blink: number,
): void {
  ctx.strokeStyle = withAlpha(accent, 0.7);
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, cy - height);
  ctx.stroke();

  ctx.fillStyle = withAlpha(accent, blink);
  ctx.beginPath();
  ctx.arc(cx, cy - height, 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = withAlpha(accent, blink * 0.25);
  ctx.beginPath();
  ctx.arc(cx, cy - height, 8, 0, Math.PI * 2);
  ctx.fill();
}

/** Une parabole de relais, orientée. */
export function dish(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  angle: number,
  colour: string,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.ellipse(0, 0, r, r * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Un anneau incliné, en rotation. */
export function orbitRing(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  angle: number,
  colour: string,
  width = 1.6,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.scale(1, 0.34);
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** Un écran lumineux plaqué sur une façade. */
export function screen(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  h: number,
  accent: string,
  intensity: number,
): void {
  ctx.fillStyle = withAlpha(accent, 0.16 + intensity * 0.24);
  ctx.fillRect(cx - w / 2, cy - h, w, h);
  ctx.strokeStyle = withAlpha(accent, 0.4);
  ctx.lineWidth = 0.8;
  ctx.strokeRect(cx - w / 2, cy - h, w, h);

  // Lignes de données qui défilent : le signe le plus économique qu'une machine
  // travaille.
  for (let i = 0; i < 3; i++) {
    const t = (intensity * 0.7 + i * 0.33) % 1;
    ctx.fillStyle = withAlpha(accent, 0.5);
    ctx.fillRect(cx - w / 2 + 1.5, cy - h + 2 + t * (h - 4), w * (0.3 + ((i * 7) % 5) / 10), 1.2);
  }
}

/** Un panache de vapeur qui monte. */
export function plume(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  phase: number,
  strength: number,
): void {
  for (let i = 0; i < 4; i++) {
    const t = (phase + i / 4) % 1;
    ctx.fillStyle = `rgba(148, 180, 220, ${(1 - t) * strength})`;
    ctx.beginPath();
    ctx.arc(cx + Math.sin(t * 4 + i) * 3, cy - t * 30, 2 + t * 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ─── Couleur ────────────────────────────────────────────────────────────────

export function withAlpha(colour: string, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha));
  if (colour.startsWith('#')) {
    const { r, g, b } = hexToRgb(colour);
    return `rgba(${r}, ${g}, ${b}, ${clamped})`;
  }
  if (colour.startsWith('hsl(')) return colour.replace('hsl(', 'hsla(').replace(')', ` / ${clamped})`);
  return colour;
}

/** Éclaircit (>1) ou assombrit (<1) une couleur hexadécimale. */
export function tint(colour: string, factor: number): string {
  if (factor === 1 || !colour.startsWith('#')) return colour;
  const { r, g, b } = hexToRgb(colour);
  const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v * factor)));
  return `rgb(${clamp(r)}, ${clamp(g)}, ${clamp(b)})`;
}

function hexToRgb(colour: string): { r: number; g: number; b: number } {
  const hex = colour.slice(1);
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

export function roundRect(
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
