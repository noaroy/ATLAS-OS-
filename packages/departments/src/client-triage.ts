/**
 * Le tri final : ce qui part au client sans relecture, ce qu'un humain doit
 * regarder — et dans quel ordre —, ce qui est écarté pour une raison qui se
 * relit.
 *
 * Sur le premier lot suédois réel, quinze candidats sur vingt sont sortis
 * « à revoir ». Treize pour un pays non prouvé sur des sites qui publiaient
 * tous leur adresse ; sept pour un « généraliste » dont chaque critère requis
 * était contredit par ses propres pages, avec la citation. La revue humaine
 * relisait ce que les pages avaient déjà tranché.
 *
 * Trois sorties, et leurs conditions exactes :
 *
 *   AUTO_APPROVED   pays prouvé, critères requis établis et relus, aucune
 *                   contradiction, aucun concurrent, note et confiance
 *                   hautes, un canal de contact — tout, sans exception.
 *   AUTO_EXCLUDED   une exclusion déterministe (pays prouvé ailleurs, marque
 *                   concurrente citée, annuaire, exclusion du client) ou un
 *                   critère requis contredit par un passage relu.
 *   HUMAN_REVIEW    tout le reste, classé P1 (probablement à retenir), P2
 *                   (ambigu), P3 (probablement à écarter).
 *
 * Réduire la revue ne se fait jamais en assouplissant l'approbation : une
 * société n'est approuvée seule que si un humain n'aurait rien à vérifier.
 */
import type { CandidateDecision, CriterionResult, SpecialisationResult } from './client-criteria.ts';
import type { ContactChannelConfidence } from './client-pages.ts';

export type TriageStatus = 'AUTO_APPROVED' | 'HUMAN_REVIEW' | 'AUTO_EXCLUDED';
export type ReviewPriority = 'P1' | 'P2' | 'P3';
export type ReviewRecommendation = 'RETAIN' | 'EXCLUDE' | 'TO_CONFIRM';

export interface TriageInput {
  decision: CandidateDecision;
  criteria: readonly CriterionResult[];
  specialisation: SpecialisationResult;
  countryStatus: 'IN_SCOPE' | 'OUT_OF_SCOPE' | 'NEEDS_VERIFICATION';
  contradiction: readonly string[];
  score: { total: number; confidence: number };
  generalistRisk: number;
  contact: { method: 'EMAIL' | 'FORM' | 'PHONE' | 'NONE'; confidence: ContactChannelConfidence };
  preferSpecialist: boolean;
  /** Combien de termes du brief les pages portaient. */
  relevanceHits: number;
}

export interface Triage {
  status: TriageStatus;
  priority: ReviewPriority | null;
  recommendation: ReviewRecommendation;
  /** Ce qui empêche l'approbation automatique, ou ce qui fonde l'exclusion. Jamais vide en revue. */
  reasons: string[];
}

/** Les catégories dont l'exclusion ne dépend d'aucune lecture. */
const EXCLUSIONS_DETERMINISTES = new Set(['WRONG_COUNTRY', 'COMPETITOR', 'DIRECTORY', 'CLIENT_EXCLUDED', 'DUPLICATE']);

export const AUTO_APPROVAL_MIN_SCORE = 70;
export const AUTO_APPROVAL_MIN_CONFIDENCE = 0.6;
export const GENERALIST_RISK_REVIEW = 60;

export function triageCandidate(input: TriageInput): Triage {
  const d = input.decision;

  if (d.outcome === 'EXCLUDED') {
    if (d.category && EXCLUSIONS_DETERMINISTES.has(d.category)) {
      return { status: 'AUTO_EXCLUDED', priority: null, recommendation: 'EXCLUDE', reasons: [d.reason] };
    }
    if (d.category === 'EXCLUSION_CRITERION') {
      const exclu = input.criteria.find((c) => c.verdict === 'EXCLUDED');
      if (exclu && exclu.evidence.length > 0) {
        return { status: 'AUTO_EXCLUDED', priority: null, recommendation: 'EXCLUDE', reasons: [d.reason] };
      }
      return { status: 'HUMAN_REVIEW', priority: 'P3', recommendation: 'EXCLUDE', reasons: [`${d.reason} — sans passage relu`] };
    }
    if (d.category === 'LOW_RELEVANCE') {
      // Contredit par un passage relu : la page le dit, pas le modèle.
      const contredits = input.criteria.filter((c) => c.kind === 'required' && c.verdict === 'NOT_ESTABLISHED');
      const avecPreuve = contredits.filter((c) => c.evidence.length > 0);
      if (avecPreuve.length > 0) {
        return {
          status: 'AUTO_EXCLUDED', priority: null, recommendation: 'EXCLUDE',
          reasons: avecPreuve.map((c) => `${c.label} — contredit par la page : « ${c.evidence[0]!.evidenceQuote.slice(0, 140)} »`),
        };
      }
      return { status: 'HUMAN_REVIEW', priority: 'P3', recommendation: 'EXCLUDE', reasons: [`${d.reason} — lecture du modèle sans passage relu`] };
    }
    // INSUFFICIENT_EVIDENCE et le reste : une exclusion sans preuve est une revue.
    return { status: 'HUMAN_REVIEW', priority: 'P3', recommendation: 'EXCLUDE', reasons: [d.reason] };
  }

  const reasons: string[] = [];
  const requisAConfirmer = input.criteria.filter((c) => c.kind === 'required' && c.verdict === 'TO_CONFIRM');
  const requisEtablis = input.criteria.filter((c) => c.kind === 'required' && c.verdict === 'ESTABLISHED');

  if (d.outcome === 'REVIEW_REQUIRED') {
    if (d.category === 'INSUFFICIENT_EVIDENCE') {
      reasons.push('aucun critère requis établi sur les pages lues');
      const priority: ReviewPriority = input.relevanceHits >= 2 ? 'P2' : 'P3';
      return { status: 'HUMAN_REVIEW', priority, recommendation: priority === 'P2' ? 'TO_CONFIRM' : 'EXCLUDE', reasons };
    }
    if (d.category === 'TOO_GENERAL') {
      reasons.push(`généraliste selon les pages lues (risque ${input.generalistRisk}/100)`);
      const priority: ReviewPriority = input.generalistRisk >= 80 && input.score.total < 50 ? 'P3' : 'P2';
      return { status: 'HUMAN_REVIEW', priority, recommendation: priority === 'P3' ? 'EXCLUDE' : 'TO_CONFIRM', reasons };
    }
    for (const c of requisAConfirmer) reasons.push(`critère requis à confirmer : ${c.label}`);
    if (input.countryStatus === 'NEEDS_VERIFICATION') reasons.push(input.contradiction.length > 0 ? `pays contredit : ${input.contradiction.join(', ')}` : 'pays non prouvé sur les pages lues');
  }

  // Ce qui, même sur un dossier retenu, exige un regard.
  if (input.contradiction.length > 0 && !reasons.some((r) => r.startsWith('pays'))) reasons.push(`pays contredit : ${input.contradiction.join(', ')}`);
  if (input.preferSpecialist && input.generalistRisk >= GENERALIST_RISK_REVIEW) reasons.push(`risque généraliste ${input.generalistRisk}/100`);
  if (input.score.total < AUTO_APPROVAL_MIN_SCORE) reasons.push(`note ${input.score.total}/100 sous le seuil d’approbation (${AUTO_APPROVAL_MIN_SCORE})`);
  if (input.score.confidence < AUTO_APPROVAL_MIN_CONFIDENCE) reasons.push(`confiance ${input.score.confidence} sous le seuil (${AUTO_APPROVAL_MIN_CONFIDENCE})`);
  if (input.contact.method === 'NONE') reasons.push('aucune coordonnée commerciale publiée');
  if (input.contact.confidence === 'LOW') reasons.push('canal de contact faible (hors domaine, ou téléphone seul)');
  if (requisEtablis.some((c) => c.evidence.length === 0)) reasons.push('un critère requis établi sans passage relu');

  if (reasons.length === 0) {
    return { status: 'AUTO_APPROVED', priority: null, recommendation: 'RETAIN', reasons: [] };
  }

  /*
   * P1 : tout est établi, il ne manque qu'une vérification de pays ou de
   * canal — la société vaut le regard en premier. P2 : un critère requis
   * ou la spécialisation restent ouverts. P3 : la note est basse.
   */
  const seulementPaysOuCanal = reasons.every((r) => /^pays|^canal|^aucune coordonnée/.test(r));
  const priority: ReviewPriority =
    requisEtablis.length === input.criteria.filter((c) => c.kind === 'required').length && seulementPaysOuCanal ? 'P1'
    : input.score.total < 40 ? 'P3'
    : 'P2';
  return {
    status: 'HUMAN_REVIEW', priority,
    recommendation: priority === 'P1' ? 'RETAIN' : priority === 'P3' ? 'EXCLUDE' : 'TO_CONFIRM',
    reasons,
  };
}

/** L'ordre d'une file de revue : P1 d'abord, puis la note. */
export function compareReviewOrder(
  a: { priority: ReviewPriority | null; score: number },
  b: { priority: ReviewPriority | null; score: number },
): number {
  const rang = (p: ReviewPriority | null) => (p === 'P1' ? 0 : p === 'P2' ? 1 : p === 'P3' ? 2 : 3);
  return rang(a.priority) - rang(b.priority) || b.score - a.score;
}
