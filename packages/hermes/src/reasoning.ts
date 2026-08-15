import type { LlmEffort } from '@atlas/llm';

/**
 * Quel niveau de raisonnement mérite chaque décision d'Hermès.
 *
 * Hermès tournait sur `opus-5` pour tout : lire un formulaire déjà rempli comme
 * arbitrer une replanification. LIVE #002 en a montré le prix — sous un plafond
 * de 1,00 $, un appel `opus-5` demandant 16 000 jetons de sortie coûtait au
 * pire 1,22 $ et était refusé *systématiquement*. Hermès était devenu
 * structurellement muet, non parce que le budget manquait, mais parce que le
 * réflexe premium ne laissait aucune place au budget.
 *
 * Trois niveaux, et une règle : le modèle premium est une escalade, pas un
 * défaut.
 *
 *   ROUTINE    Structurer, reformuler, extraire un formulaire.
 *              Le modèle rapide suffit — la difficulté est dans le schéma,
 *              pas dans le jugement.
 *
 *   COMPLEX    Décomposer un objectif, rendre compte au fondateur.
 *              Le modèle rapide, mais avec un effort de réflexion supérieur :
 *              c'est la profondeur qui compte, pas la taille du modèle.
 *
 *   STRATEGIC  Reconsidérer un plan après un échec, arbitrer un conseil.
 *              Là où se trompent les modèles rapides, et là seulement.
 *
 * Le fondateur garde la main : `hermesModel` reste le modèle stratégique, et
 * relever le niveau d'une décision suffit à y revenir.
 */

export type ReasoningTier = 'routine' | 'complex' | 'strategic';

/** Les décisions d'Hermès, et le niveau que chacune mérite. */
export const DECISION_TIERS = {
  /** Lire un objectif dans la structure attendue par un département. */
  brief: 'routine',
  /** Décomposer un objectif générique en étapes. */
  plan: 'complex',
  /** Rendre compte de la mission au fondateur. */
  synthesis: 'complex',
  /** Reconsidérer le reste d'un plan après un échec qui l'invalide. */
  replan: 'strategic',
} as const satisfies Record<string, ReasoningTier>;

export type HermesDecision = keyof typeof DECISION_TIERS;

export interface ReasoningModels {
  /** Le modèle rapide : celui des agents. */
  routine: string;
  /** Le modèle premium, réservé aux arbitrages. */
  strategic: string;
  /** L'effort configuré par le déploiement. */
  effort: LlmEffort;
}

export interface ReasoningChoice {
  tier: ReasoningTier;
  model: string;
  effort: LlmEffort;
}

/** Un cran d'effort au-dessus, sans changer de modèle. */
const DEEPER: Record<LlmEffort, LlmEffort> = {
  low: 'medium',
  medium: 'high',
  high: 'xhigh',
  xhigh: 'max',
  max: 'max',
};

/**
 * Le modèle et l'effort à employer pour une décision donnée.
 *
 * `complex` monte l'effort plutôt que le modèle : sur les modèles actuels, la
 * profondeur de réflexion rattrape l'essentiel de l'écart, à une fraction du
 * prix — et se règle sans changer de fournisseur.
 */
export function chooseReasoning(
  decision: HermesDecision,
  models: ReasoningModels,
): ReasoningChoice {
  const tier = DECISION_TIERS[decision];

  switch (tier) {
    case 'routine':
      return { tier, model: models.routine, effort: models.effort };
    case 'complex':
      return { tier, model: models.routine, effort: DEEPER[models.effort] };
    case 'strategic':
      return { tier, model: models.strategic, effort: models.effort };
  }
}
