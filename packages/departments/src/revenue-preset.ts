import { LIVE_PILOT_LIMITS, type LivePilotLimits } from './live-pilot.ts';
import { VALIDATION_MAX_OUTPUT_TOKENS_PER_CALL } from './validation-presets.ts';

/**
 * La première mission qui doit rapporter de l'argent.
 *
 * Les cinq validations cherchent des défauts. Celle-ci cherche des clients :
 * elle ne mesure pas ATLAS, elle produit ce qui sera vendu. La différence n'est
 * pas cosmétique — elle change la règle d'arrêt.
 *
 * Une validation s'arrête quand elle a mesuré ce qu'elle voulait mesurer. Une
 * mission commerciale s'arrête quand le livrable est **bon**, et pas une
 * seconde plus tard. Continuer à dépenser pour atteindre un nombre rond de
 * candidats n'améliore pas ce qui sera livré : cela ajoute des lignes médiocres
 * sous les bonnes, et un client qui lit vingt fiches dont trois valent quelque
 * chose conclut que dix-sept ne valaient rien.
 *
 * Trois prospects excellents valent mieux que vingt moyens. C'est le seul
 * arbitrage de ce preset, et tout le reste en découle : le seuil de qualité est
 * déclaré avant l'exécution, l'arrêt est autorisé dès qu'il est franchi trois
 * fois, et le budget est un mur, pas une cible.
 */

/**
 * Le seuil au-dessus duquel un prospect mérite d'être facturé.
 *
 * Pas une moyenne observée ni une note de confort : la barre qu'un prospect
 * doit franchir pour qu'un client paie sans regret de l'avoir lu.
 *
 * Les trois conditions se cumulent parce qu'elles se compensent autrement. Un
 * score élevé bâti sur une seule source est une opinion bien notée ; deux
 * sources sur un candidat hors cible sont deux sources inutiles. Le score dit
 * l'adéquation, les preuves de première main disent que quelqu'un l'a
 * réellement vu, et la qualification dit qu'ATLAS a tranché plutôt que penché.
 */
export interface QualityBar {
  /** Le score d'adéquation minimal, sur 100. */
  minScore: number;
  /**
   * Combien d'affirmations observées ou rapportées — jamais inférées — le
   * prospect doit porter.
   *
   * Deux, et non une : une source unique ne se contredit jamais elle-même.
   */
  minFirsthandEvidence: number;
  /** Le prospect doit avoir été qualifié, pas seulement découvert. */
  requiresQualified: boolean;
}

export const REVENUE_QUALITY_BAR: QualityBar = {
  minScore: 70,
  minFirsthandEvidence: 2,
  requiresQualified: true,
};

/**
 * Combien de prospects excellents suffisent à livrer.
 *
 * Trois est un plancher de livrable, pas une cible de production : en dessous,
 * le pack ne vaut pas son prix ; au-dessus, chaque ligne supplémentaire coûte
 * un peu et n'ajoute que si elle est du même niveau.
 */
export const REVENUE_ENOUGH_PROSPECTS = 3;

/** Au-delà, on ne cherche plus : le pack est complet. */
export const REVENUE_TARGET_PROSPECTS = 5;

export interface RevenuePreset {
  id: string;
  title: string;
  /** Ce que le client achète, en une phrase. */
  promise: string;
  objective: string;
  limits: LivePilotLimits;
  mode: 'live';
  /** La barre de qualité, déclarée avant l'exécution. */
  qualityBar: QualityBar;
  /** Assez de prospects pour livrer — l'arrêt est autorisé ici. */
  enoughProspects: number;
  /** Le nombre visé quand le budget le permet sans dégrader la qualité. */
  targetProspects: number;
  /** Les étapes, dans l'ordre. Chacune peut être la dernière. */
  steps: string[];
  need: { countries: string[]; languages: string[]; commercial: boolean };
  context: Record<string, unknown>;
  departmentKey: string;
  tags: string[];
}

/**
 * Le budget : 0,12 $, et c'est un mur.
 *
 * Calibré sur ce que VAL-002 a réellement consommé, pas sur une estimation
 * prudente. Haiku facture 0,80 $ le million de jetons d'entrée et 4 $ en
 * sortie ; l'isolement du contexte ayant supprimé l'accumulation quadratique,
 * cinq candidats coûtent désormais cinq fois un candidat, et non vingt-cinq
 * fois.
 *
 * `maxCandidates` est à 8 alors que le pack en vise 5 : la découverte doit
 * pouvoir écarter les candidats faibles sans que le pack se retrouve court. Ce
 * n'est pas une cible de production — c'est la marge de tri.
 *
 * `maxAnalyzedCandidates` est à 5, soit exactement le pack. Analyser plus
 * coûterait pour des lignes qui ne seront pas livrées.
 */
export const REVENUE_001: RevenuePreset = {
  id: 'REVENUE-001-DE-B2B',
  title: 'Pack Expansion B2B Allemagne',
  promise:
    'Cinq prospects B2B allemands recherchés et qualifiés, avec preuves vérifiables, ' +
    'priorité et angle d’approche.',
  objective:
    "Identifier et qualifier entre trois et cinq distributeurs ou intégrateurs allemands " +
    "susceptibles de représenter une offre B2B industrielle. Chaque prospect doit être " +
    "rattaché à des sources consultables et porter au moins deux affirmations de première " +
    "main. Ne proposer aucune organisation dont l'existence n'est pas établie par une " +
    "source. Mieux vaut livrer trois prospects solides que cinq dont deux sont douteux.",
  limits: {
    ...LIVE_PILOT_LIMITS,
    model: 'claude-haiku-4-5-20251001',
    maxOutputTokensPerCall: VALIDATION_MAX_OUTPUT_TOKENS_PER_CALL,
    maxCostUsd: 0.12,
    maxTokens: 120_000,
    maxSearchQueries: 4,
    maxSearchResults: 10,
    maxCandidates: 8,
    maxAnalyzedCandidates: 5,
    maxFetchedPages: 2,
    maxOpportunities: 5,
    maxMissionDurationMs: 8 * 60 * 1000,
  },
  mode: 'live',
  qualityBar: REVENUE_QUALITY_BAR,
  enoughProspects: REVENUE_ENOUGH_PROSPECTS,
  targetProspects: REVENUE_TARGET_PROSPECTS,
  steps: ['discovery', 'enrichment', 'qualification', 'scoring', 'ranking', 'export'],
  need: { countries: ['DE'], languages: ['de'], commercial: true },
  context: {
    executionMode: 'live',
    preset: 'REVENUE-001-DE-B2B',
    budgetUsd: 0.12,
    deliverable: 'Pack Expansion B2B Allemagne',
  },
  departmentKey: 'business-expansion',
  tags: ['revenue', 'live', 'deliverable'],
};

/** Ce qu'on sait d'un prospect au moment de décider si on continue. */
export interface ProspectQuality {
  opportunityId: string;
  score: number | null;
  firsthandEvidence: number;
  qualified: boolean;
}

/**
 * Ce prospect mérite-t-il d'être livré ?
 *
 * Un score absent n'est pas un score bas : c'est une mesure qui n'a pas été
 * faite, et un prospect non mesuré ne franchit aucune barre. Le traiter comme
 * un zéro reviendrait au même ici, mais dirait quelque chose de faux — et cette
 * fonction sert aussi à expliquer un tri à un client.
 */
export function meetsQualityBar(prospect: ProspectQuality, bar: QualityBar): boolean {
  if (bar.requiresQualified && !prospect.qualified) return false;
  if (prospect.score === null) return false;
  if (prospect.score < bar.minScore) return false;
  return prospect.firsthandEvidence >= bar.minFirsthandEvidence;
}

/** Pourquoi ce prospect ne passe pas — pour l'expliquer, pas seulement le trancher. */
export function whyBelowBar(prospect: ProspectQuality, bar: QualityBar): string[] {
  const reasons: string[] = [];
  if (bar.requiresQualified && !prospect.qualified) reasons.push('non qualifié');
  if (prospect.score === null) reasons.push('score non mesuré');
  else if (prospect.score < bar.minScore) reasons.push(`score ${prospect.score} < ${bar.minScore}`);
  if (prospect.firsthandEvidence < bar.minFirsthandEvidence) {
    reasons.push(
      `${prospect.firsthandEvidence} preuve(s) de première main < ${bar.minFirsthandEvidence}`,
    );
  }
  return reasons;
}

export type StopReason =
  /** Assez de bons prospects : le livrable est complet. */
  | 'enough-quality'
  /** Le pack visé est atteint. */
  | 'target-reached'
  /** Rien de plus à traiter. */
  | 'candidates-exhausted';

export interface StopDecision {
  stop: boolean;
  reason: StopReason | null;
  qualifying: number;
  explanation: string;
}

/**
 * Faut-il continuer à dépenser ?
 *
 * La règle que ce preset existe pour porter : **on s'arrête quand le livrable
 * est bon**, pas quand un compteur atteint un nombre rond.
 *
 * Les trois validations précédentes se sont arrêtées faute de budget, jamais
 * faute de besoin — parce qu'aucune n'avait de raison de s'arrêter avant. Une
 * mission qui ne sait pas reconnaître qu'elle a fini dépense jusqu'au mur, et
 * le mur arrive toujours au pire moment : au milieu de la qualification, quand
 * tout ce qui précède est déjà payé et pas encore exploitable.
 *
 * Fonction pure, et exportée pour cela : c'est la règle économique du produit,
 * elle doit pouvoir être vérifiée sans dépenser un centime.
 */
export function shouldStopEarly(
  prospects: readonly ProspectQuality[],
  preset: Pick<RevenuePreset, 'qualityBar' | 'enoughProspects' | 'targetProspects'>,
  remainingCandidates: number,
): StopDecision {
  const qualifying = prospects.filter((p) => meetsQualityBar(p, preset.qualityBar)).length;

  if (qualifying >= preset.targetProspects) {
    return {
      stop: true,
      reason: 'target-reached',
      qualifying,
      explanation: `${qualifying} prospects au niveau attendu : le pack est complet.`,
    };
  }

  if (qualifying >= preset.enoughProspects) {
    return {
      stop: true,
      reason: 'enough-quality',
      qualifying,
      explanation:
        `${qualifying} prospects franchissent la barre de qualité — assez pour livrer. ` +
        `Poursuivre coûterait sans améliorer le pack : les candidats restants seraient ` +
        `ajoutés sous les bons, pas au-dessus.`,
    };
  }

  if (remainingCandidates <= 0) {
    return {
      stop: true,
      reason: 'candidates-exhausted',
      qualifying,
      explanation:
        `Plus aucun candidat à traiter. ${qualifying} prospect(s) au niveau attendu — ` +
        `en dessous des ${preset.enoughProspects} requis pour livrer.`,
    };
  }

  return {
    stop: false,
    reason: null,
    qualifying,
    explanation:
      `${qualifying}/${preset.enoughProspects} prospects au niveau attendu, ` +
      `${remainingCandidates} candidat(s) restant(s) à traiter.`,
  };
}
