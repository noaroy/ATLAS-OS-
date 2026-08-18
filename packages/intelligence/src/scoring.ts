import type {
  Evidence,
  Opportunity,
  OpportunityScore,
  RoleFit,
  ScoreComponent,
  ScoringModel,
  Source,
} from '@atlas/contracts';
import { badRequest } from '@atlas/core';
import { evidenceStrength } from './evidence.ts';

/**
 * Explainable scoring.
 *
 * A score here is never a number an agent hands back. It is the sum of named,
 * weighted contributions, each carrying its own rationale, confidence and the
 * evidence it rests on — so "why is this one first?" is answerable by
 * subtraction rather than by asking the model to justify itself afterwards.
 *
 * The model is data (it lives on the department), so weights can be re-tuned
 * without touching this file, and a re-weighting is visibly a *new* score.
 */

/** One axis as an agent asserts it, before weighting. */
export interface DimensionAssessment {
  dimension: string;
  /** 0..100 on this axis. */
  value: number;
  rationale: string;
  confidence?: number;
  evidenceIds?: string[];
}

/** La compatibilité d'un candidat avec un rôle donné, telle qu'un agent la juge. */
export interface RoleFitAssessment {
  role: string;
  value: number;
  rationale: string;
  confidence?: number;
  evidenceIds?: string[];
}

export interface ScoreInput {
  model: ScoringModel;
  assessments: DimensionAssessment[];
  /** Compatibilité par rôle, quand la mission en cherche plusieurs. */
  roleFits?: RoleFitAssessment[];
  /** Les rôles retenus pour ce candidat. */
  roles?: string[];
  /** Le catalogue de rôles du département, pour les libellés. */
  targetTypes?: Array<{ key: string; label: string }>;
  /** Everything known about the company, for the computed dimensions. */
  evidence: readonly Evidence[];
  sources: ReadonlyMap<string, Source>;
  scoredBy: string;
  scoredAt: string;
}

/**
 * A fingerprint of the weighting used.
 *
 * Two scores are only comparable if they were produced by the same model; this
 * makes that visible on the record rather than implied.
 */
export function scoringModelVersion(model: ScoringModel): string {
  const shape = model.dimensions
    .map((d) => `${d.key}:${d.weight}`)
    .sort()
    .join('|');
  let hash = 2166136261;
  for (let i = 0; i < shape.length; i++) {
    hash ^= shape.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `v${(hash >>> 0).toString(36)}`;
}

/**
 * Computes the dimensions the platform owns.
 *
 * `evidence-quality` is deliberately not something an agent may assert: a
 * candidate researched thinly must score worse on it than one researched well,
 * however confident the agent sounds.
 */
export function computeDimension(
  key: string,
  evidence: readonly Evidence[],
  sources: ReadonlyMap<string, Source>,
): { value: number; rationale: string; confidence: number } | null {
  if (key !== 'evidence-quality') return null;

  const strength = evidenceStrength(evidence, sources);
  const observed = evidence.filter((e) => e.nature === 'observed').length;
  const reported = evidence.filter((e) => e.nature === 'reported').length;
  const inferred = evidence.filter((e) => e.nature === 'inferred').length;

  return {
    value: Math.round(strength * 100),
    rationale:
      evidence.length === 0
        ? "Aucune preuve n'a été enregistrée pour ce candidat."
        : `${evidence.length} affirmation(s) : ${observed} constatée(s), ${reported} rapportée(s), ${inferred} déduite(s).`,
    confidence: evidence.length === 0 ? 0.2 : Math.min(1, 0.4 + evidence.length * 0.08),
  };
}

/**
 * Turns per-axis assessments into a total that can be taken apart again.
 *
 * Weights are normalised across the dimensions actually present, so a missing
 * assessment reduces confidence rather than silently scoring zero — an axis
 * nobody could judge is not the same as an axis judged badly.
 */
export function scoreOpportunity(input: ScoreInput): OpportunityScore {
  const { model } = input;
  if (model.dimensions.length === 0) throw badRequest('The scoring model declares no dimensions');

  const byKey = new Map(input.assessments.map((a) => [a.dimension, a]));
  const components: ScoreComponent[] = [];

  for (const dimension of model.dimensions) {
    const computed = dimension.computed
      ? computeDimension(dimension.key, input.evidence, input.sources)
      : null;
    const asserted = byKey.get(dimension.key);

    if (!computed && !asserted) continue;

    const value = clamp(computed ? computed.value : asserted!.value, 0, 100);
    const confidence = clamp(
      computed ? computed.confidence : (asserted!.confidence ?? 0.6),
      0,
      1,
    );

    components.push({
      dimension: dimension.key,
      label: dimension.label,
      value,
      weight: dimension.weight,
      // Filled in once the present weights are known.
      contribution: 0,
      rationale: computed ? computed.rationale : asserted!.rationale,
      confidence,
      evidenceIds: computed ? [] : (asserted!.evidenceIds ?? []),
      computed: Boolean(computed),
    });
  }

  if (components.length === 0) {
    throw badRequest('No dimension of the scoring model could be assessed');
  }

  const weightTotal = components.reduce((sum, c) => sum + c.weight, 0);
  for (const component of components) {
    component.contribution = round2((component.value * component.weight) / weightTotal);
  }

  const total = round2(components.reduce((sum, c) => sum + c.contribution, 0));

  // Confidence in the total is the weighted confidence of its parts, reduced
  // when the model could not be assessed in full.
  const coverage = components.reduce((s, c) => s + c.weight, 0) / totalWeight(model);
  const weighted = components.reduce((s, c) => s + c.confidence * c.weight, 0) / weightTotal;

  return {
    total,
    components: components.sort((a, b) => b.contribution - a.contribution),
    confidence: round2(clamp(weighted * (0.7 + 0.3 * coverage), 0, 1)),
    roleFits: buildRoleFits(input),
    modelVersion: scoringModelVersion(model),
    scoredBy: input.scoredBy,
    scoredAt: input.scoredAt,
  };
}

/**
 * Assemble la compatibilité par rôle.
 *
 * Un rôle retenu pour le candidat mais qu'aucune évaluation ne couvre apparaît
 * quand même, à zéro et en confiance nulle : un rôle que personne n'a jugé n'est
 * pas un rôle qui convient, et le taire laisserait croire qu'il a été examiné.
 */
function buildRoleFits(input: ScoreInput): RoleFit[] {
  const roles = input.roles ?? [];
  if (roles.length === 0) return [];

  const labels = new Map((input.targetTypes ?? []).map((t) => [t.key, t.label]));
  const assessed = new Map((input.roleFits ?? []).map((f) => [f.role, f]));

  return roles.map((role) => {
    const fit = assessed.get(role);
    return {
      role,
      label: labels.get(role) ?? role,
      // `null` et non `0` quand le rôle n'a pas été évalué.
      //
      // Un rôle affiché « 0/100 » se lit comme une mesure défavorable, alors
      // qu'aucune mesure n'a eu lieu. La revue humaine du premier rapport l'a
      // relevé : « Distributeur 0/100, Intégrateur 0/100 » suivi de « À
      // approcher d'abord comme Distributeur » — un conseil fondé sur une note
      // qui n'existait pas.
      value: fit ? clamp(fit.value, 0, 100) : null,
      rationale: fit ? fit.rationale : "Ce rôle n'a pas été évalué séparément.",
      confidence: fit ? clamp(fit.confidence ?? 0.6, 0, 1) : 0,
      evidenceIds: fit?.evidenceIds ?? [],
    };
  });
}

/**
 * Writes the reason a candidate sits where it sits.
 *
 * Generated from the components rather than asked of the model, so the text and
 * the arithmetic cannot disagree.
 */
export function explainScore(
  score: OpportunityScore,
  options: { rank?: number | null; companyName: string; comparedTo?: OpportunityScore | null } = {
    companyName: 'This candidate',
  },
): string {
  const [first, second] = score.components;
  const weakest = [...score.components].sort((a, b) => a.value - b.value)[0];

  const lines: string[] = [];
  const position = options.rank ? `Classé n°${options.rank}` : 'Noté';
  lines.push(
    `${position} à ${score.total.toFixed(1)}/100 (confiance ${(score.confidence * 100).toFixed(0)} %).`,
  );

  if (first) {
    lines.push(
      `Contribution la plus forte : ${first.label} — ${first.value}/100, soit ${first.contribution.toFixed(1)} points. ${first.rationale}`,
    );
  }
  if (second && second.dimension !== first?.dimension) {
    lines.push(
      `Puis ${second.label} — ${second.value}/100, soit ${second.contribution.toFixed(1)} points.`,
    );
  }
  if (weakest && weakest.dimension !== first?.dimension) {
    lines.push(`Axe le plus faible : ${weakest.label} à ${weakest.value}/100. ${weakest.rationale}`);
  }

  if (options.comparedTo) {
    const delta = score.total - options.comparedTo.total;
    const gap = biggestGap(score, options.comparedTo);
    if (gap) {
      lines.push(
        `Devance le candidat suivant de ${delta.toFixed(1)} points, principalement sur ${gap.label} (${gap.delta > 0 ? '+' : ''}${gap.delta.toFixed(1)}).`,
      );
    }
  }

  // Quel rôle proposer est une décision commerciale distincte du classement :
  // la justification doit donc la porter explicitement.
  // Un rôle non évalué ne se recommande pas.
  //
  // L'ancienne version listait « Distributeur 0/100, Intégrateur 0/100 » puis
  // concluait « À approcher d'abord comme Distributeur ». Le conseil reposait
  // sur un classement de valeurs nulles — c'est-à-dire sur l'ordre du tableau,
  // pas sur une évaluation. Sans mesure, on dit qu'il n'y en a pas.
  const evaluated = score.roleFits.filter((f) => f.value !== null).sort((a, b) => b.value! - a.value!);
  const unevaluated = score.roleFits.filter((f) => f.value === null);

  if (evaluated.length === 1) {
    lines.push(`Rôle pertinent : ${evaluated[0]!.label} — ${evaluated[0]!.value}/100. ${evaluated[0]!.rationale}`);
  } else if (evaluated.length > 1) {
    lines.push(
      `Rôles pertinents : ${evaluated.map((f) => `${f.label} ${f.value}/100`).join(', ')}. ` +
        `À approcher d'abord comme ${evaluated[0]!.label} : ${evaluated[0]!.rationale}`,
    );
  }
  if (unevaluated.length > 0) {
    lines.push(
      `Rôle${unevaluated.length > 1 ? 's' : ''} NON ÉVALUÉ${unevaluated.length > 1 ? 'S' : ''} : ` +
        `${unevaluated.map((f) => f.label).join(', ')}. ` +
        `Ces rôles n'ont pas fait l'objet d'une notation séparée ; aucune recommandation ne s'appuie dessus.`,
    );
  }

  const inferredOnly = score.components.filter((c) => !c.computed && c.evidenceIds.length === 0);
  if (inferredOnly.length > 0) {
    lines.push(
      `Réserve : ${inferredOnly.map((c) => c.label).join(', ')} repose${inferredOnly.length === 1 ? '' : 'nt'} sur un jugement plutôt que sur une preuve citée.`,
    );
  }

  return lines.join('\n');
}

/** Which axis explains most of the distance between two candidates. */
export function biggestGap(
  a: OpportunityScore,
  b: OpportunityScore,
): { label: string; delta: number } | null {
  const other = new Map(b.components.map((c) => [c.dimension, c]));
  let best: { label: string; delta: number } | null = null;

  for (const component of a.components) {
    const counterpart = other.get(component.dimension);
    if (!counterpart) continue;
    const delta = component.contribution - counterpart.contribution;
    if (!best || Math.abs(delta) > Math.abs(best.delta)) {
      best = { label: component.label, delta };
    }
  }
  return best;
}

/**
 * Orders scored opportunities into the shortlist.
 *
 * Ties break on confidence: between two equal scores, prefer the one ATLAS is
 * more sure about rather than whichever happened to be discovered first.
 */
export function rankOpportunities(
  opportunities: readonly Opportunity[],
  threshold: number,
): Opportunity[] {
  return opportunities
    .filter((o) => o.score !== null && o.score >= threshold)
    .sort((a, b) => {
      const byScore = (b.score ?? 0) - (a.score ?? 0);
      if (Math.abs(byScore) > 0.001) return byScore;
      return (b.scoreDetail?.confidence ?? 0) - (a.scoreDetail?.confidence ?? 0);
    });
}

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));
const round2 = (n: number): number => Math.round(n * 100) / 100;
const totalWeight = (model: ScoringModel): number =>
  model.dimensions.reduce((sum, d) => sum + d.weight, 0) || 1;
