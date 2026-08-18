import { REVIEW_CHECKLIST, type ReportState, type ReviewItem } from './delivery.ts';

/**
 * L'approbation humaine d'un rapport, et ce qui la refuse.
 *
 * La liste de revue compte huit points. Quatre se constatent en lisant la base
 * — une preuve simulée se compte, une source absente se voit — et quatre
 * demandent d'ouvrir le document : les URL répondent-elles, la traduction
 * est-elle fidèle, la synthèse dépasse-t-elle ses preuves, l'entreprise
 * correspond-elle vraiment au besoin.
 *
 * Ces quatre-là ne peuvent pas être cochés par le système. Ils sont donc
 * réclamés explicitement, un par un, sur la ligne de commande. Un relecteur qui
 * les tape déclare les avoir faits ; c'est la seule signature qu'un logiciel
 * puisse recueillir, et c'est précisément pourquoi elle ne doit pas pouvoir
 * être donnée par défaut.
 *
 * Le module est pur : il ne lit ni base ni disque. Une garde qui ne peut être
 * éprouvée qu'en approuvant un vrai rapport ne serait jamais éprouvée.
 */

/**
 * Les points qu'aucune vérification automatique ne peut trancher.
 *
 * Ils ont un point commun : ils demandent de comparer le document à quelque
 * chose qui n'est pas dans la base — le web pour les sources, le sens pour la
 * traduction, les preuves pour la synthèse, le besoin réel du client pour la
 * pertinence.
 */
export const HUMAN_CHECKS = [
  'sources-live',
  'evidence-coherent',
  'translation-faithful',
  'opportunities-relevant',
] as const;

/** Les points que le système constate lui-même, et qu'il ne délègue pas. */
export const AUTOMATIC_CHECKS = [
  'no-simulation',
  'no-invented-contact',
  'scores-justified',
  'no-unsupported-claim',
] as const;

export type HumanCheckKey = (typeof HUMAN_CHECKS)[number];

/** Ce que le système a constaté, et ce que l'humain déclare avoir vérifié. */
export interface ApprovalInput {
  reportState: ReportState;
  /** Les clés cochées par le relecteur, telles qu'il les a tapées. */
  declaredChecks: readonly string[];
  /** Le verdict automatique de chaque point calculable. */
  automaticVerdicts: Readonly<Record<string, 'PASS' | 'FAIL'>>;
  simulatedEvidence: number;
  unsupportedClaims: number;
}

export type RefusalCode =
  | 'WRONG_STATE'
  | 'AUTOMATIC_CHECK_FAILED'
  | 'MISSING_HUMAN_CHECK'
  | 'UNKNOWN_CHECK'
  | 'SIMULATED_EVIDENCE'
  | 'UNSUPPORTED_CLAIM';

export interface ApprovalRefusal {
  code: RefusalCode;
  message: string;
}

export interface ApprovalDecision {
  approved: boolean;
  refusals: ApprovalRefusal[];
  /** Les points humains reconnus, dans l'ordre de la liste. */
  humanChecks: HumanCheckKey[];
  /** Les points automatiques et leur verdict. */
  automaticChecks: Array<{ key: string; verdict: 'PASS' | 'FAIL' }>;
  /** Les huit clés à consigner, quand l'approbation passe. */
  passedKeys: string[];
}

const itemOf = (key: string): ReviewItem | undefined =>
  REVIEW_CHECKLIST.find((i) => i.key === key);

/**
 * Cette approbation peut-elle aboutir ?
 *
 * Tous les motifs de refus sont énumérés, jamais court-circuités au premier.
 * Un relecteur qui corrige un point pour découvrir le suivant refait la lecture
 * à chaque fois — et une revue qu'on recommence trois fois finit expédiée.
 *
 * Un point resté NEEDS REVIEW n'est jamais promu en PASS : il n'y a aucun
 * chemin, dans cette fonction, qui transforme une absence de déclaration en
 * déclaration.
 */
export function evaluateApproval(input: ApprovalInput): ApprovalDecision {
  const refusals: ApprovalRefusal[] = [];

  if (input.reportState !== 'PENDING_REVIEW') {
    refusals.push({
      code: 'WRONG_STATE',
      message:
        `Le rapport est en « ${input.reportState} ». L'approbation ne s'applique qu'à un ` +
        `rapport soumis à la revue (« PENDING_REVIEW ») — utilisez d'abord --submit.`,
    });
  }

  // Une clé inconnue est refusée plutôt qu'ignorée : une faute de frappe qui
  // passe inaperçue fait croire à un point coché qui ne l'est pas.
  const known = new Set<string>(REVIEW_CHECKLIST.map((i) => i.key));
  for (const declared of input.declaredChecks) {
    if (known.has(declared)) continue;
    refusals.push({
      code: 'UNKNOWN_CHECK',
      message:
        `Point de revue inconnu : « ${declared} ». Attendus : ${HUMAN_CHECKS.join(', ')}.`,
    });
  }

  const declared = new Set(input.declaredChecks);
  const missing = HUMAN_CHECKS.filter((key) => !declared.has(key));
  for (const key of missing) {
    const item = itemOf(key);
    refusals.push({
      code: 'MISSING_HUMAN_CHECK',
      message: `« ${key} » non déclaré — ${item?.question ?? 'point de revue humain'}`,
    });
  }

  const automaticChecks = AUTOMATIC_CHECKS.map((key) => ({
    key,
    verdict: input.automaticVerdicts[key] ?? ('FAIL' as const),
  }));
  for (const check of automaticChecks) {
    if (check.verdict === 'PASS') continue;
    refusals.push({
      code: 'AUTOMATIC_CHECK_FAILED',
      message:
        `Contrôle automatique en échec : « ${check.key} » — ` +
        `${itemOf(check.key)?.question ?? 'vérification système'}`,
    });
  }

  // Les deux verrous de fond, redits ici plutôt que délégués aux verdicts
  // ci-dessus. C'est délibérément redondant : ce sont les deux défauts qui
  // rendent un rapport indéfendable devant un client, et une garde répétée
  // coûte moins cher qu'une garde manquante.
  if (input.simulatedEvidence > 0) {
    refusals.push({
      code: 'SIMULATED_EVIDENCE',
      message:
        `${input.simulatedEvidence} preuve(s) de lignée simulée. Une fiche de démonstration ` +
        `livrée comme réelle décrédibilise aussi ce qui était vrai.`,
    });
  }
  if (input.unsupportedClaims > 0) {
    refusals.push({
      code: 'UNSUPPORTED_CLAIM',
      message:
        `${input.unsupportedClaims} affirmation(s) de fait sans source. C'est la promesse ` +
        `centrale du produit, et une seule suffit à la rompre.`,
    });
  }

  const approved = refusals.length === 0;
  return {
    approved,
    refusals,
    humanChecks: HUMAN_CHECKS.filter((key) => declared.has(key)),
    automaticChecks,
    passedKeys: approved ? [...HUMAN_CHECKS, ...AUTOMATIC_CHECKS] : [],
  };
}

/**
 * Les clés déclarées sur la ligne de commande.
 *
 * Deux formes acceptées, parce que les deux shells du poste ne se plient pas
 * aux mêmes habitudes :
 *
 *   --check=sources-live --check=evidence-coherent
 *   --checks=sources-live,evidence-coherent
 *
 * Rien n'est deviné : une valeur vide n'est pas une clé, et les doublons sont
 * réduits sans être signalés — répéter un point ne le coche pas deux fois.
 */
export function parseDeclaredChecks(argv: readonly string[]): string[] {
  const found: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith('--check=')) {
      const value = arg.slice(8).trim();
      if (value) found.push(value);
    } else if (arg.startsWith('--checks=')) {
      for (const part of arg.slice(9).split(',')) {
        const value = part.trim();
        if (value) found.push(value);
      }
    }
  }
  return [...new Set(found)];
}
