import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Building } from '@atlas/contracts';
import { BUILDINGS } from '@atlas/agents';
import {
  CITY_FILL_X,
  CITY_FILL_Y,
  distanceToSegment,
  frameCity,
  project,
  resolveRoads,
  styleOf,
  TILE_W,
} from '../src/village/layout.ts';
import { hasPainter, heightOf } from '../src/village/buildings.ts';

/**
 * La géométrie de la cité.
 *
 * Ces vérifications attrapent une classe de défauts qui passe le typecheck sans
 * broncher et saute aux yeux à l'écran : un bâtiment hors cadre, deux façades
 * qui se recouvrent, une rue qui traverse un édifice qu'elle ne dessert pas.
 *
 * Elles portent sur des fonctions pures — projection, cadrage, distances — donc
 * sans canevas ni navigateur. Ce qu'elles ne remplacent pas, c'est le jugement
 * à l'œil : elles disent qu'aucune règle n'est violée, pas que la ville est
 * belle.
 */

const CITY: Building[] = BUILDINGS.map(({ sortOrder: _s, ...building }) => building);

/** Largeur d'une empreinte au sol. Deux bâtiments plus proches se touchent. */
const FOOTPRINT = TILE_W;

describe('implantation des bâtiments', () => {
  test('aucun bâtiment ne recouvre son voisin', () => {
    const points = CITY.map((b) => ({ key: b.key, ...project(b.x, b.y) }));

    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const distance = Math.hypot(points[i]!.sx - points[j]!.sx, points[i]!.sy - points[j]!.sy);
        assert.ok(
          distance >= FOOTPRINT * 1.4,
          `${points[i]!.key} et ${points[j]!.key} ne sont qu'à ${Math.round(distance)} px ` +
            `(minimum ${Math.round(FOOTPRINT * 1.4)})`,
        );
      }
    }
  });

  test('chaque bâtiment a une silhouette dédiée', () => {
    // Le volume générique existe pour ne rien faire disparaître, pas pour
    // servir : une ville dont la moitié des bâtiments sont la même boîte
    // redevient un diagramme.
    for (const building of CITY) {
      assert.ok(hasPainter(building.key), `${building.key} n'a pas de silhouette propre`);
    }
  });

  test('les hauteurs créent une hiérarchie, dominée par le commandement', () => {
    const heights = CITY.map((b) => ({ key: b.key, h: heightOf(b.key, b.level) }));
    const core = heights.find((h) => h.key === 'command-center')!;
    const tallestOther = Math.max(...heights.filter((h) => h.key !== 'command-center').map((h) => h.h));

    // Un tiers d'écart au minimum. « Au moins aussi haut » laissait passer une
    // égalité à trois pixels près : deux centres, donc aucun.
    assert.ok(
      core.h >= tallestOther * 1.33,
      `le poste de commandement (${Math.round(core.h)}) doit dominer d'au moins un tiers, ` +
        `or une autre silhouette monte à ${Math.round(tallestOther)}`,
    );

    // Et il doit exister une vraie variété, pas trois hauteurs identiques.
    assert.ok(new Set(heights.map((h) => h.h)).size >= 8, 'les silhouettes sont trop uniformes');
  });
});

describe('le réseau de rues', () => {
  test("aucune rue ne traverse un bâtiment qu'elle ne dessert pas", () => {
    const roads = resolveRoads(CITY);

    for (const road of roads) {
      for (const building of CITY) {
        if (building.key === road.from || building.key === road.to) continue;

        const distance = distanceToSegment(
          building.x,
          building.y,
          road.ax,
          road.ay,
          road.bx,
          road.by,
        );
        // En unités de grille : une empreinte fait environ 1 unité de large.
        assert.ok(
          distance > 0.95,
          `la rue ${road.from} → ${road.to} passe à ${distance.toFixed(2)} unité(s) de ` +
            `${building.key}, qu'elle ne dessert pas`,
        );
      }
    }
  });

  test('chaque quartier est desservi', () => {
    const roads = resolveRoads(CITY);
    const served = new Set(roads.flatMap((r) => [r.from, r.to]));
    for (const building of CITY) {
      assert.ok(served.has(building.key), `${building.key} n'est desservi par aucune rue`);
    }
  });
});

describe('cadrage de la caméra', () => {
  const VIEWPORTS: Array<[number, number, string]> = [
    [1902, 910, 'large'],
    [1440, 820, 'portable'],
    [1134, 700, 'fenêtre réduite'],
    [900, 600, 'petite fenêtre'],
  ];

  for (const [width, height, label] of VIEWPORTS) {
    test(`la cité remplit la vue sans déborder — ${label}`, () => {
      const frame = frameCity(CITY, width, height);

      // Occupation : c'est l'exigence produit, exprimée en chiffres.
      const fillX = frame.widthPx / width;
      const fillY = frame.heightPx / height;
      assert.ok(
        fillX > 0.6 || fillY > 0.6,
        `la cité n'occupe que ${Math.round(fillX * 100)} % × ${Math.round(fillY * 100)} % de la vue`,
      );
      assert.ok(fillX <= CITY_FILL_X + 0.02, `débordement horizontal : ${Math.round(fillX * 100)} %`);
      assert.ok(fillY <= CITY_FILL_Y + 0.02, `débordement vertical : ${Math.round(fillY * 100)} %`);
    });

    test(`aucun bâtiment hors écran — ${label}`, () => {
      const frame = frameCity(CITY, width, height);

      for (const building of CITY) {
        const { sx, sy } = project(building.x, building.y);
        const top = sy - heightOf(building.key, building.level);

        // Écran = (monde − caméra) × zoom + centre de la vue.
        const screenX = (sx - frame.x) * frame.zoom + width / 2;
        const screenBase = (sy - frame.y) * frame.zoom + height / 2;
        const screenTop = (top - frame.y) * frame.zoom + height / 2;

        assert.ok(screenX > 0 && screenX < width, `${building.key} sort horizontalement`);
        assert.ok(screenTop > 0, `le sommet de ${building.key} sort par le haut`);
        assert.ok(screenBase < height, `la base de ${building.key} sort par le bas`);
      }
    });
  }

  test('un changement de taille recadre sans perdre la ville', () => {
    // Le défaut classique du redimensionnement : la caméra garde son zoom, et
    // la cité se retrouve minuscule dans un coin ou débordante.
    const small = frameCity(CITY, 900, 600);
    const large = frameCity(CITY, 1902, 910);

    assert.ok(large.zoom > small.zoom, 'une vue plus grande doit rapprocher la caméra');
    assert.equal(Math.round(small.x), Math.round(large.x), 'le centre ne doit pas dériver');
    assert.equal(Math.round(small.y), Math.round(large.y));
  });
});

describe('lisibilité', () => {
  test('les étiquettes ne se chevauchent pas', () => {
    // Une étiquette se dessine au-dessus de la silhouette ; deux bâtiments
    // proches en hauteur et en abscisse verraient leurs noms se superposer.
    const frame = frameCity(CITY, 1902, 910);
    const labels = CITY.map((b) => {
      const { sx, sy } = project(b.x, b.y);
      const isCore = b.key === 'command-center';
      return {
        key: b.key,
        x: sx * frame.zoom,
        y: (sy - heightOf(b.key, b.level) - (isCore ? 58 : 20)) * frame.zoom,
        // Largeur estimée : environ 6,2 px par caractère à 11 px, plus la marge.
        half: (styleOf(b.key).short.length * 6.2 + 18) * frame.zoom * 0.5,
      };
    });

    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i]!;
        const b = labels[j]!;
        const overlapX = Math.abs(a.x - b.x) < a.half + b.half;
        const overlapY = Math.abs(a.y - b.y) < 20 * frame.zoom;
        assert.ok(
          !(overlapX && overlapY),
          `les étiquettes de ${a.key} et ${b.key} se chevauchent`,
        );
      }
    }
  });
});
