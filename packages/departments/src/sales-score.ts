/**
 * Ce que vaut un prospect pour *notre* acquisition.
 *
 * Le score du département Business Expansion mesure l'adéquation d'une
 * entreprise à la cible d'un client. Celui-ci mesure autre chose : à quel point
 * notre offre lui serait utile, et à quel point nous pouvons l'atteindre.
 *
 * Une règle gouverne les sept axes : **aucun ne note la probabilité qu'ils
 * achètent**. Cette probabilité n'est pas observable, et la noter reviendrait à
 * mesurer notre optimisme. Ce qui est observable, c'est leur situation — vendent-
 * ils à des entreprises, cherchent-ils à s'étendre, publient-ils un contact,
 * leur panier justifie-t-il quarante-neuf euros. Le reste est une conversation
 * à avoir, pas un chiffre à inventer.
 */

export interface SalesDimension {
  key: SalesDimensionKey;
  label: string;
  /** Ce que l'axe mesure, en une phrase, pour que la note se discute. */
  question: string;
  weight: number;
  /**
   * Calculée par la plateforme depuis les preuves, plutôt qu'affirmée.
   *
   * Comme pour le scoring client : un analyste ne peut pas déclarer que son
   * propre travail est bien sourcé.
   */
  computed?: boolean;
}

export type SalesDimensionKey =
  | 'needFit'
  | 'b2bFit'
  | 'abilityToPay'
  | 'accessibility'
  | 'expansionSignal'
  | 'contactQuality'
  | 'evidenceQuality';

/**
 * Les sept axes et leur poids.
 *
 * `needFit` et `b2bFit` pèsent le plus : une entreprise qui ne vend pas aux
 * entreprises n'a aucun usage de notre livrable, quelle que soit sa taille ou
 * son accessibilité. `evidenceQuality` pèse peu mais existe, pour la même
 * raison que dans le scoring client — une évaluation mal sourcée doit passer
 * derrière une évaluation modeste et établie.
 */
export const SALES_SCORING_MODEL: readonly SalesDimension[] = [
  {
    key: 'needFit',
    label: 'Besoin compatible',
    question:
      'Des signaux observables indiquent-ils une difficulté à trouver des clients, ' +
      'distributeurs ou partenaires ?',
    weight: 22,
  },
  {
    key: 'b2bFit',
    label: 'Vente aux entreprises',
    question: 'Vend-elle réellement à d’autres entreprises, et non à des particuliers ?',
    weight: 20,
  },
  {
    key: 'abilityToPay',
    label: 'Capacité à payer',
    question:
      'Le panier moyen et la structure rendent-ils quarante-neuf euros insignifiants ?',
    weight: 14,
  },
  {
    key: 'accessibility',
    label: 'Accessibilité',
    question: 'Peut-on atteindre un décideur sans passer par un standard ni un formulaire ?',
    weight: 14,
  },
  {
    key: 'expansionSignal',
    label: 'Signal d’expansion',
    question: 'Cherche-t-elle activement de nouveaux marchés, revendeurs ou partenaires ?',
    weight: 14,
  },
  {
    key: 'contactQuality',
    label: 'Qualité du contact',
    question: 'Un interlocuteur nommé est-il publié, avec un rôle pertinent ?',
    weight: 8,
  },
  {
    key: 'evidenceQuality',
    label: 'Qualité des preuves',
    question: 'À quel point cette évaluation repose-t-elle sur des sources consultables ?',
    weight: 8,
    computed: true,
  },
];

export interface SalesAssessment {
  dimension: SalesDimensionKey;
  /** 0..100. Jamais une probabilité d'achat. */
  value: number;
  rationale: string;
  confidence: number;
  evidenceIds: string[];
}

export interface SalesScoreComponent extends SalesAssessment {
  label: string;
  weight: number;
  contribution: number;
  computed: boolean;
}

export interface SalesScore {
  total: number;
  components: SalesScoreComponent[];
  confidence: number;
  /** Le rang commercial qui découle du total, jamais déclaré à la main. */
  tier: SalesTier;
}

/**
 * Le rang d'un prospect.
 *
 * Déduit du total, et de rien d'autre. Le forcer serait la manière la plus
 * simple de se retrouver avec cinq PRIORITY dont trois ne valent rien — ce qui
 * ferait perdre trois créneaux d'appel avant qu'on s'en aperçoive.
 */
export type SalesTier = 'PRIORITY' | 'GOOD_FIT' | 'WATCH' | 'REJECTED';

export const SALES_TIER_THRESHOLDS = {
  priority: 70,
  goodFit: 55,
  watch: 40,
} as const;

export function tierFor(total: number): SalesTier {
  if (total >= SALES_TIER_THRESHOLDS.priority) return 'PRIORITY';
  if (total >= SALES_TIER_THRESHOLDS.goodFit) return 'GOOD_FIT';
  if (total >= SALES_TIER_THRESHOLDS.watch) return 'WATCH';
  return 'REJECTED';
}

/** Ce que la plateforme calcule elle-même, depuis les preuves réunies. */
export interface EvidenceSummary {
  observed: number;
  reported: number;
  inferred: number;
  /** Combien portent une adresse consultable. */
  sourced: number;
}

/**
 * La qualité des preuves, mesurée et non affirmée.
 *
 * Une affirmation constatée vaut plus qu'une rapportée, qui vaut plus qu'une
 * déduite ; et rien ne compte sans source. La largeur joue avec des rendements
 * décroissants : cinq constats valent mieux qu'un, mais pas cinq fois mieux.
 */
export function evidenceQuality(summary: EvidenceSummary): number {
  const total = summary.observed + summary.reported + summary.inferred;
  if (total === 0) return 0;

  const weighted = summary.observed * 1 + summary.reported * 0.75 + summary.inferred * 0.3;
  const average = weighted / total;
  const sourcedRatio = summary.sourced / total;
  const breadth = Math.min(1, Math.log2(total + 1) / Math.log2(9));

  return Math.round(Math.min(100, average * sourcedRatio * (0.65 + 0.35 * breadth) * 100));
}

/**
 * Assemble le score.
 *
 * Les poids sont normalisés sur les seules dimensions présentes : un axe que
 * personne n'a pu juger réduit la confiance plutôt que de compter zéro. Un axe
 * qu'on n'a pas su évaluer n'est pas un axe raté.
 */
export function scoreSalesProspect(input: {
  assessments: readonly SalesAssessment[];
  evidence: EvidenceSummary;
}): SalesScore {
  const byKey = new Map(input.assessments.map((a) => [a.dimension, a]));
  const components: SalesScoreComponent[] = [];

  for (const dimension of SALES_SCORING_MODEL) {
    const computed = dimension.computed
      ? {
          value: evidenceQuality(input.evidence),
          rationale:
            `${input.evidence.observed} constatée(s), ${input.evidence.reported} rapportée(s), ` +
            `${input.evidence.inferred} déduite(s) · ${input.evidence.sourced} sourcée(s).`,
          confidence: 0.75,
          evidenceIds: [] as string[],
        }
      : null;
    const asserted = byKey.get(dimension.key);
    if (!computed && !asserted) continue;

    const value = clamp(computed ? computed.value : asserted!.value, 0, 100);
    components.push({
      dimension: dimension.key,
      label: dimension.label,
      value,
      weight: dimension.weight,
      contribution: 0,
      rationale: computed ? computed.rationale : asserted!.rationale,
      confidence: clamp(computed ? computed.confidence : (asserted!.confidence ?? 0.6), 0, 1),
      evidenceIds: computed ? [] : (asserted!.evidenceIds ?? []),
      computed: Boolean(computed),
    });
  }

  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  if (totalWeight === 0) {
    return { total: 0, components: [], confidence: 0, tier: 'REJECTED' };
  }

  let total = 0;
  for (const component of components) {
    component.contribution = round2((component.value * component.weight) / totalWeight);
    total += component.contribution;
  }

  const confidence = round2(
    components.reduce((sum, c) => sum + c.confidence * c.weight, 0) / totalWeight,
  );
  const rounded = round2(total);
  return { total: rounded, components, confidence, tier: tierFor(rounded) };
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const round2 = (n: number): number => Math.round(n * 100) / 100;
