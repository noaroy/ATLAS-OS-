import type { SearchProvider } from './types.ts';

/**
 * Ce qu'un moteur sait faire — distinct de savoir s'il répond.
 *
 * LIVE PILOT 001 a échoué deux fois de suite avec un moteur parfaitement sain.
 * DuckDuckGo répondait en 800 ms mais bridait cette adresse ; Marginalia
 * répondait en 300 ms et rendait dix études de marché anglophones pour une
 * recherche de distributeurs allemands. Dans les deux cas le contrôle de santé
 * disait « vert », et la mission a dépensé pour découvrir que le moteur ne
 * pouvait pas répondre à *cette* question.
 *
 * D'où deux notions séparées, et qui doivent le rester :
 *
 *   La santé — le moteur répond-il ? Se mesure en l'appelant.
 *   L'adéquation — peut-il répondre à cette mission-ci ? Se déduit de ce qu'il
 *   couvre, sans rien appeler.
 *
 * Un moteur sain mais inadapté est le cas le plus coûteux, parce qu'il passe
 * tous les contrôles et produit un résultat vide qu'on prend pour un constat de
 * marché. « Aucun distributeur allemand » et « ce moteur ne couvre pas
 * l'allemand » sont deux phrases que rien ne distinguait.
 */

export interface ProviderCapabilities {
  /** Index web généraliste, par opposition à un index thématique. */
  generalWeb: boolean;
  /**
   * Trouve-t-il des entreprises commerciales ?
   *
   * Un index qui privilégie les sites documentaires et artisanaux — c'est le
   * parti pris assumé de Marginalia — ramènera une étude de marché plutôt qu'un
   * distributeur régional. Ce n'est pas un défaut du moteur, c'est son objet.
   */
  commercialDiscovery: boolean;
  /** Codes pays ISO couverts. `['*']` signifie sans restriction connue. */
  geographicCoverage: string[];
  /** Codes langue couverts. `['*']` signifie sans restriction connue. */
  languageCoverage: string[];
  /** Rend-il un titre, une URL et un extrait exploitables sans post-traitement ? */
  structuredResults: boolean;
  /** Ce que ce moteur ne sait pas faire, en une phrase lisible. */
  caveat: string | null;
}

const UNIVERSAL = ['*'];

const CAPABILITIES: Record<string, ProviderCapabilities> = {
  duckduckgo: {
    generalWeb: true,
    commercialDiscovery: true,
    geographicCoverage: UNIVERSAL,
    languageCoverage: UNIVERSAL,
    structuredResults: true,
    caveat: "Bride une adresse trop insistante ; espacer les requêtes est obligatoire.",
  },
  marginalia: {
    generalWeb: true,
    // Le point qui a coûté une mission : techniquement sain, structurellement
    // inadapté à la découverte commerciale.
    commercialDiscovery: false,
    geographicCoverage: ['US', 'GB', 'CA', 'AU'],
    languageCoverage: ['en'],
    structuredResults: true,
    caveat:
      "Index restreint et anglophone, orienté sites documentaires. Ne convient pas à la découverte d'entreprises hors du monde anglophone.",
  },
  searxng: {
    generalWeb: true,
    commercialDiscovery: true,
    geographicCoverage: UNIVERSAL,
    languageCoverage: UNIVERSAL,
    structuredResults: true,
    caveat: 'Dépend des moteurs configurés dans l’instance et de sa disponibilité.',
  },
  brave: {
    generalWeb: true,
    commercialDiscovery: true,
    geographicCoverage: UNIVERSAL,
    languageCoverage: UNIVERSAL,
    structuredResults: true,
    caveat: 'Requiert une clé et facture à la requête.',
  },
};

/**
 * Les capacités d'un moteur inconnu.
 *
 * Volontairement pessimistes : un moteur qu'on ne connaît pas n'est pas
 * présumé capable. Le sens de l'erreur compte — refuser à tort coûte une
 * question au fondateur, accepter à tort coûte une mission entière.
 */
const UNKNOWN: ProviderCapabilities = {
  generalWeb: false,
  commercialDiscovery: false,
  geographicCoverage: [],
  languageCoverage: [],
  structuredResults: false,
  caveat: "Moteur non répertorié : ses capacités n'ont pas été établies.",
};

export const capabilitiesOf = (key: string): ProviderCapabilities => CAPABILITIES[key] ?? UNKNOWN;

// ─── Adéquation à une mission donnée ────────────────────────────────────────

export interface MissionSearchNeed {
  /** Codes pays visés par le brief. */
  countries: string[];
  /** Langues attendues des sources. */
  languages: string[];
  /** La mission cherche-t-elle des organisations commerciales ? */
  commercial: boolean;
}

export type SuitabilityVerdict = 'suitable' | 'degraded' | 'unsuitable';

export interface SuitabilityReport {
  verdict: SuitabilityVerdict;
  /** Ce qui manque, s'il manque quelque chose. */
  gaps: string[];
  detail: string;
}

/**
 * Ce moteur peut-il répondre à cette mission ?
 *
 * Trois issues plutôt que deux. `degraded` existe parce qu'un moteur peut
 * couvrir la langue sans couvrir le pays, ou l'inverse : ce n'est pas un refus,
 * c'est un avertissement à porter jusqu'au rapport final, pour qu'un résultat
 * maigre ne soit pas lu comme un marché vide.
 */
export function assessSuitability(
  provider: SearchProvider,
  need: MissionSearchNeed,
): SuitabilityReport {
  const caps = capabilitiesOf(provider.key);
  const gaps: string[] = [];

  if (!caps.generalWeb) gaps.push("l'index n'est pas généraliste");

  if (need.commercial && !caps.commercialDiscovery) {
    gaps.push("l'index ne privilégie pas les sites d'entreprises");
  }

  const covers = (coverage: string[], wanted: string[]): boolean =>
    coverage.includes('*') || wanted.length === 0 || wanted.some((w) => coverage.includes(w.toUpperCase()) || coverage.includes(w.toLowerCase()));

  if (!covers(caps.geographicCoverage, need.countries)) {
    gaps.push(`aucune couverture connue pour ${need.countries.join(', ')}`);
  }
  if (!covers(caps.languageCoverage, need.languages)) {
    gaps.push(`aucune couverture connue pour la langue ${need.languages.join(', ')}`);
  }

  // La découverte commerciale est structurante : sans elle, la mission cherche
  // ce que l'index ne contient pas, et aucun réglage n'y changera rien.
  const structural = need.commercial && !caps.commercialDiscovery;
  const verdict: SuitabilityVerdict =
    gaps.length === 0 ? 'suitable' : structural || gaps.length >= 2 ? 'unsuitable' : 'degraded';

  return {
    verdict,
    gaps,
    detail:
      verdict === 'suitable'
        ? `${provider.label} couvre ce que la mission demande.`
        : `${provider.label} : ${gaps.join(' · ')}.` + (caps.caveat ? ` ${caps.caveat}` : ''),
  };
}
