/**
 * Ce qui sépare un rapport produit d'un rapport livrable.
 *
 * Le moteur sait désormais produire : qualification, notation, classement,
 * export, chacun vérifié par sa postcondition. Rien de tout cela ne dit qu'un
 * document peut partir chez un client qui paie.
 *
 * La différence n'est pas technique. Un rapport peut être parfaitement conforme
 * à ses contrats et rester invendable : une source morte, une traduction qui
 * déforme une preuve, un contact « général » présenté comme un interlocuteur.
 * Ces défauts-là ne se détectent pas en base — ils se voient en lisant.
 *
 * D'où une revue humaine obligatoire, et un état qui ne peut pas être franchi
 * sans elle. Ce n'est pas une formalité : c'est le seul point du système où
 * quelqu'un engage sa parole sur ce qui part.
 */

export type ReportState =
  /** Le pipeline a produit le document. Rien n'a encore été vérifié à l'œil. */
  | 'GENERATED'
  /** Soumis à la revue humaine. */
  | 'PENDING_REVIEW'
  /** Un humain a vérifié chaque point et engage sa parole. */
  | 'APPROVED_FOR_DELIVERY'
  /** Refusé : la raison est consignée, le rapport n'est pas livrable. */
  | 'REJECTED'
  /** Remis au client. */
  | 'DELIVERED';

/**
 * Les transitions permises.
 *
 * `GENERATED → DELIVERED` n'existe pas, et c'est tout l'objet de cette table.
 * Un rapport rejeté peut repasser en revue après correction, mais ne saute
 * jamais directement à l'approbation : ce qui a été refusé se revérifie.
 */
const TRANSITIONS: Readonly<Record<ReportState, readonly ReportState[]>> = {
  GENERATED: ['PENDING_REVIEW', 'REJECTED'],
  PENDING_REVIEW: ['APPROVED_FOR_DELIVERY', 'REJECTED'],
  APPROVED_FOR_DELIVERY: ['DELIVERED', 'REJECTED'],
  REJECTED: ['PENDING_REVIEW'],
  DELIVERED: [],
};

export function canTransition(from: ReportState, to: ReportState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Ce qu'un rapport doit franchir pour être livrable. */
export interface ReviewItem {
  key: string;
  question: string;
  /** Pourquoi ce point compte — pour que la revue ne devienne pas un rituel. */
  why: string;
}

export const REVIEW_CHECKLIST: readonly ReviewItem[] = [
  {
    key: 'sources-live',
    question: 'Chaque URL citée s’ouvre-t-elle et montre-t-elle ce qui est affirmé ?',
    why: 'Une source morte transforme un fait vérifiable en affirmation nue, et c’est la première chose qu’un client teste.',
  },
  {
    key: 'evidence-coherent',
    question: 'Les preuves disent-elles la même chose que la synthèse qui les résume ?',
    why: 'Une synthèse qui va plus loin que ses preuves est une invention présentée comme un constat.',
  },
  {
    key: 'no-simulation',
    question: 'Aucune entreprise ni preuve de lignée simulée ou inconnue ?',
    why: 'Une fiche de démonstration livrée comme réelle décrédibilise tout le document, y compris ce qui était vrai.',
  },
  {
    key: 'no-invented-contact',
    question: 'Chaque contact nominatif a-t-il été réellement trouvé, jamais reconstruit ?',
    why: 'Une adresse plausible mais fausse se découvre au premier envoi, et le client en conclut que le reste l’est aussi.',
  },
  {
    key: 'scores-justified',
    question: 'Chaque note est-elle décomposée et rattachée à des preuves ?',
    why: 'Un score sans décomposition est un chiffre d’autorité, et rien ne permet au client de le discuter.',
  },
  {
    key: 'translation-faithful',
    question: 'La traduction française conserve-t-elle le sens exact des preuves ?',
    why: 'Traduire n’est pas interpréter : une nuance perdue change ce qu’on affirme d’une entreprise.',
  },
  {
    key: 'opportunities-relevant',
    question: 'Les entreprises retenues correspondent-elles vraiment au besoin exprimé ?',
    why: 'Un prospect hors cible coûte au client le temps de le découvrir, et à nous sa confiance.',
  },
  {
    key: 'no-unsupported-claim',
    question: 'Aucune affirmation de fait sans source, ni déduction présentée comme un fait ?',
    why: 'C’est la promesse centrale du produit : ce qui est établi est distingué de ce qui est supposé.',
  },
];

export interface ReviewOutcome {
  /** Les clés cochées par le relecteur. */
  passed: string[];
  reviewer: string;
  reviewedAt: string;
  notes?: string;
}

export interface ReviewVerdict {
  approved: boolean;
  missing: ReviewItem[];
  /** L'état qui découle de la revue — jamais choisi à la main. */
  nextState: ReportState;
}

/**
 * Le verdict de la revue, déduit de la liste et non déclaré.
 *
 * Un relecteur ne « décide » pas d'approuver : il constate huit points. Si
 * l'un manque, le rapport est refusé — y compris si le relecteur pense par
 * ailleurs qu'il est bon. C'est la même logique que les postconditions du
 * pipeline, une couche plus haut : l'artefact décide, pas l'opinion.
 */
export function reviewVerdict(outcome: ReviewOutcome): ReviewVerdict {
  const checked = new Set(outcome.passed);
  const missing = REVIEW_CHECKLIST.filter((item) => !checked.has(item.key));
  return {
    approved: missing.length === 0,
    missing,
    nextState: missing.length === 0 ? 'APPROVED_FOR_DELIVERY' : 'REJECTED',
  };
}

// ─── Économie ───────────────────────────────────────────────────────────────

/** Ce qu'un rapport a coûté, mesuré et non estimé. */
export interface ReportCost {
  llmCostUsd: number;
  /**
   * Le coût des recherches web.
   *
   * SearXNG tourne en local et Anthropic facture ses outils serveur dans le
   * coût des appels : la recherche ne coûte donc rien de séparé aujourd'hui.
   * Le champ existe pour que le jour où un moteur payant entre en service, le
   * coût réel apparaisse plutôt que de se fondre dans le total.
   */
  searchCostUsd: number;
  candidates: number;
  /** Les candidats réellement livrables, seuls à justifier la dépense. */
  usefulOpportunities: number;
}

export interface ReportEconomics extends ReportCost {
  totalCostUsd: number;
  costPerCandidateUsd: number | null;
  /** Le coût par opportunité utile — la seule division qui parle au vendeur. */
  costPerUsefulOpportunityUsd: number | null;
  sellingPriceEur: number | null;
  grossMarginEur: number | null;
  grossMarginPercent: number | null;
}

/**
 * Le taux employé pour comparer un coût en dollars à un prix en euros.
 *
 * Fixé et déclaré plutôt que tiré d'une API : un taux vivant ferait varier la
 * marge affichée d'un jour à l'autre sans que rien n'ait changé dans le
 * produit. Pour un arbitrage à 49 €, la précision au centime n'apporte rien ;
 * savoir d'où vient le chiffre, si.
 */
export const USD_PER_EUR = 1.08;

/**
 * L'économie d'un rapport.
 *
 * Aucun prix n'est fixé ici. `sellingPriceEur` arrive de la configuration —
 * c'est une décision commerciale, pas une propriété du calcul, et l'inscrire
 * en dur reviendrait à décider à la place du fondateur.
 *
 * `null` traverse partout où la division n'a pas de sens : zéro candidat ne
 * donne pas un coût par candidat de zéro, il n'en donne aucun.
 */
export function reportEconomics(
  cost: ReportCost,
  config: { sellingPriceEur?: number | null } = {},
): ReportEconomics {
  const totalCostUsd = round4(cost.llmCostUsd + cost.searchCostUsd);
  const sellingPriceEur = config.sellingPriceEur ?? null;
  const totalCostEur = totalCostUsd / USD_PER_EUR;

  return {
    ...cost,
    totalCostUsd,
    costPerCandidateUsd: cost.candidates > 0 ? round4(totalCostUsd / cost.candidates) : null,
    costPerUsefulOpportunityUsd:
      cost.usefulOpportunities > 0 ? round4(totalCostUsd / cost.usefulOpportunities) : null,
    sellingPriceEur,
    grossMarginEur: sellingPriceEur === null ? null : round4(sellingPriceEur - totalCostEur),
    grossMarginPercent:
      sellingPriceEur === null || sellingPriceEur === 0
        ? null
        : Math.round(((sellingPriceEur - totalCostEur) / sellingPriceEur) * 1000) / 10,
  };
}

// ─── Traçabilité ────────────────────────────────────────────────────────────

/**
 * La version du pipeline qui a produit un rapport.
 *
 * Incrémentée quand une correction change ce que le pipeline produit, pas à
 * chaque commit. Un rapport livré doit pouvoir être rattaché aux règles qui
 * l'ont fabriqué, y compris des mois plus tard quand elles auront changé.
 */
export const PIPELINE_VERSION = 'v1.0.0';

/** Ce qu'un rapport livré conserve, pour qu'on puisse le refaire ou le défendre. */
export interface ReportProvenance {
  missionId: string;
  generatedAt: string;
  pipelineVersion: string;
  scoringVersion: string;
  executionMode: 'live' | 'simulation';
  /** Les identifiants exacts des preuves citées. */
  evidenceIds: string[];
  /** Les adresses consultées, telles qu'écrites. */
  sources: string[];
  costUsd: number;
  reviewer: string | null;
  approvedAt: string | null;
  state: ReportState;
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
