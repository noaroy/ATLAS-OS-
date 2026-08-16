/**
 * LIVE PILOT 001 — la première mission réelle d'ATLAS.
 *
 * Tout est petit, et volontairement. Cinq missions réelles ont déjà échoué pour
 * 10,94 $ cumulés et zéro candidat ; ce pilote n'a pas à prouver qu'ATLAS sait
 * traiter un grand marché, seulement qu'il sait produire *un* résultat sourcé
 * sans dépasser son budget.
 *
 * Les bornes ci-dessous ne sont pas indicatives. Le plafond en dollars descend
 * jusqu'au registre budgétaire, qui refuse chaque appel avant de l'émettre ; les
 * bornes de recherche et de récupération descendent jusqu'aux outils. Une
 * mission qui atteint une limite s'arrête proprement en conservant ce qu'elle a
 * déjà trouvé — elle ne compense jamais un manque de résultats par des appels
 * supplémentaires.
 */

export interface LivePilotLimits {
  /** Plafond absolu de la mission, en dollars. */
  maxCostUsd: number;
  maxTokens: number;
  maxSearchQueries: number;
  maxSearchResults: number;
  maxCandidates: number;
  /** Combien de candidats méritent une analyse par le modèle. */
  maxAnalyzedCandidates: number;
  maxFetchedPages: number;
  maxOpportunities: number;
  maxMissionDurationMs: number;
  /** Le modèle employé. Jamais le plus cher : c'est de l'extraction. */
  model: string;
}

/**
 * Le budget du pilote, confirmé par le fondateur.
 *
 * 0,40 $ n'est pas une estimation prudente d'un coût attendu : c'est un mur.
 * Haiku facture 0,80 $ par million de jetons d'entrée et 4 $ en sortie — le
 * plafond autorise donc largement une dizaine d'appels d'extraction, et rien de
 * plus. Opus est interdit par configuration, pas par convention.
 */
export const LIVE_PILOT_LIMITS: LivePilotLimits = {
  maxCostUsd: 0.4,
  maxTokens: 120_000,
  maxSearchQueries: 4,
  maxSearchResults: 10,
  maxCandidates: 12,
  maxAnalyzedCandidates: 5,
  maxFetchedPages: 2,
  maxOpportunities: 3,
  maxMissionDurationMs: 8 * 60 * 1000,
  model: 'claude-haiku-4-5-20251001',
};

/**
 * Ce que ce pilote attend d'un moteur.
 *
 * Sert au contrôle d'adéquation. Marginalia répond parfaitement et ne couvre ni
 * l'allemand ni la découverte commerciale : sain, mais incapable de répondre à
 * *cette* question. Sans cette déclaration, la mission dépensait pour le
 * découvrir, et rendait « aucun distributeur » là où il fallait lire « ce moteur
 * ne contient pas la réponse ».
 */
export const LIVE_PILOT_NEED = {
  countries: ['DE'],
  languages: ['de'],
  commercial: true,
};

export const LIVE_PILOT_MISSION = {
  code: 'LIVE-001',
  title: 'LIVE PILOT 001 — Distributeurs allemands, machines d’emballage',
  objective:
    "Identifier des distributeurs et intégrateurs allemands susceptibles de représenter un " +
    "fabricant français de machines d'emballage industriel. Chaque candidat doit provenir d'une " +
    "source consultable et être accompagné des preuves qui l'ont fait retenir. Ne proposer aucune " +
    "organisation dont l'existence n'est pas établie par une source.",
  context: {
    sector: "machines d'emballage industriel",
    origin: 'France',
    targetMarket: 'Allemagne',
    companySize: '80 personnes, 14 M€ de chiffre d’affaires',
    // Lu par l'orchestrateur : ce champ resserre le plafond du déploiement.
    budgetUsd: LIVE_PILOT_LIMITS.maxCostUsd,
    executionMode: 'live',
    pilot: 'LIVE-001',
  },
  priority: 'normal' as const,
  tags: ['live', 'pilot', 'business-expansion'],
  departmentKey: 'business-expansion',
  tokenBudget: LIVE_PILOT_LIMITS.maxTokens,
};
