import { nowIso } from '@atlas/core';
import type {
  Availability,
  DiscoveredCandidate,
  DiscoveryProvider,
  DiscoveryProviderContext,
  DiscoveryQuery,
  ProviderResult,
} from './types.ts';

/**
 * Découverte fabriquée, pour la démonstration hors ligne.
 *
 * Marqué `synthetic` : le service refuse de l'utiliser dès qu'ATLAS tourne en
 * mode réel, et ce refus est une propriété du service, pas une politesse de ce
 * fichier. Les noms produits portent visiblement leur nature — une donnée
 * simulée ne doit jamais pouvoir être prise pour une donnée réelle.
 */
export class SimulationDiscoveryProvider implements DiscoveryProvider {
  readonly key = 'simulation';
  readonly label = 'Simulation (données fabriquées)';
  readonly kind = 'simulation' as const;
  readonly synthetic = true;

  availability(): Availability {
    return {
      available: true,
      reason: 'Données fabriquées, utilisables uniquement en mode simulation.',
    };
  }

  async search(query: DiscoveryQuery, _ctx: DiscoveryProviderContext): Promise<ProviderResult> {
    const retrievedAt = nowIso();
    const country = query.countries[0] ?? 'Allemagne';
    const roleKeys = query.targetTypes.map((t) => t.key);
    const industry = query.industries[0] ?? 'Équipement industriel';

    // Déterministe à partir de la requête : deux exécutions de la même mission
    // donnent le même jeu, ce qui rend une démonstration reproductible.
    const rng = mulberry32(hash(`${roleKeys.join('+')}|${country}|${industry}|${query.limit}`));
    const count = Math.max(3, Math.min(query.limit, 8));

    const candidates: DiscoveredCandidate[] = Array.from({ length: count }, (_, index) => {
      const name = `[SIMULÉ] ${pick(rng, ROOTS)}${pick(rng, TRADES)} ${pick(rng, FORMS)}`;
      const slug = `sim-${hash(name).toString(36).slice(0, 6)}`;
      return {
        name,
        website: `https://${slug}.example`,
        country,
        region: null,
        city: pick(rng, CITIES),
        description: `Organisation fabriquée pour la démonstration, présentée comme ${roleKeys.join(' / ') || 'partenaire'} dans le secteur ${industry}.`,
        industries: [industry],
        relevance:
          "Candidat fabriqué : aucune recherche réelle n'a été effectuée pour le produire.",
        // Alterne les rôles demandés pour que la démonstration couvre chaque cas.
        roles: roleKeys.length ? [roleKeys[index % roleKeys.length]!] : [],
        sources: [
          {
            kind: 'simulation',
            ref: null,
            title: 'Mode simulation — aucune source réelle',
            retrievedAt,
            provider: this.key,
          },
        ],
        // Volontairement basse : une donnée fabriquée ne mérite pas de confiance,
        // et le score final doit s'en ressentir.
        confidence: 0.15 + index * 0.02,
      };
    });

    return {
      candidates,
      notes: [
        'ATLAS tourne en mode simulation : ces organisations sont fabriquées et ne doivent en aucun cas être présentées à un prospect.',
      ],
      tokensUsed: 0,
      outcome: candidates.length > 0 ? 'success-with-results' : 'success-empty',
    };
  }
}

const ROOTS = ['Nord', 'Sud', 'Rhein', 'Alpen', 'Hansa', 'Vector', 'Meridian', 'Kestrel'];
const TRADES = ['Antriebe', 'Industrietechnik', 'Systemtechnik', 'Maschinenhandel', 'Automation'];
const FORMS = ['GmbH', 'AG', 'GmbH & Co. KG', 'Group'];
const CITIES = ['Hambourg', 'Munich', 'Cologne', 'Stuttgart', 'Leipzig', 'Francfort'];

const pick = <T>(rng: () => number, list: T[]): T => list[Math.floor(rng() * list.length)]!;

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
