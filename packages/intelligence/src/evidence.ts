import type { Evidence, EvidenceNature, Source } from '@atlas/contracts';
import { MAX_INFERENCE_CONFIDENCE } from '@atlas/contracts';
import { badRequest } from '@atlas/core';

/**
 * The evidence discipline.
 *
 * ATLAS must never present what it guessed as what it saw. That is not a
 * convention agents are asked to honour — it is enforced here, on the way in:
 * an inference is capped in confidence, must state what it was built on, and is
 * stamped with the inference mode it was produced under.
 */

export interface EvidenceDraft {
  field: string;
  claim: string;
  value?: unknown;
  nature: EvidenceNature;
  sourceRef?: string | null;
  sourceTitle?: string | null;
  basis?: string | null;
  confidence?: number;
}

/** Default trust in a source kind, before anything is known about it. */
export const DEFAULT_RELIABILITY: Record<Source['kind'], number> = {
  'company-website': 0.9,
  registry: 0.95,
  directory: 0.6,
  press: 0.7,
  social: 0.45,
  dataset: 0.8,
  'model-inference': 0.3,
  founder: 0.95,
  simulation: 0.1,
};

/**
 * Des suffixes qui ressemblent à un domaine sans désigner quoi que ce soit de
 * joignable. Les préfixer d'un `https://` fabriquerait une adresse plausible
 * pour une source qui n'existe pas — exactement ce qu'une preuve ne doit pas
 * faire. `.example`, `.invalid`, `.test` et `.localhost` sont réservés par la
 * RFC 2606 précisément pour ne jamais être résolus.
 */
const NON_ROUTABLE_TLDS = new Set([
  'example',
  'invalid',
  'test',
  'localhost',
  'local',
  'internal',
  'lan',
  'home',
  'arpa',
]);

/**
 * Rend une référence de source utilisable, quand elle ne l'est pas encore.
 *
 * Les agents rendent régulièrement `bhs-world.com` là où une adresse complète
 * est attendue. Ce n'est pas une erreur de fond : le domaine est juste, la
 * source existe, il manque le protocole. Mais la chaîne n'est pas une URL, donc
 * la source enregistrée n'en est pas une non plus, et la preuve devient
 * invérifiable pour un défaut de forme.
 *
 * La règle est purement syntaxique et volontairement stricte : mieux vaut
 * laisser passer un domaine nu que fabriquer une adresse à partir d'une phrase.
 * Ce qui n'est pas reconnu avec certitude est rendu tel quel, sans altération —
 * une normalisation qui devine est une invention.
 *
 * `https` et non `http` : c'est le défaut du web, et se tromper coûte une
 * redirection, là où l'inverse coûterait une adresse en clair.
 */
export function normaliseSourceRef(ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed) return ref;

  // Déjà une adresse — y compris `mailto:` ou `tel:`, qu'on ne touche pas.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  // Un espace signe une phrase, pas un domaine.
  if (/\s/.test(trimmed)) return trimmed;

  const [authority = ''] = trimmed.split(/[/?#]/, 1);
  const labels = authority.split('.');
  if (labels.length < 2) return trimmed;

  const tld = labels.at(-1)!.toLowerCase();
  // Un TLD est alphabétique et jamais très court : cela écarte « Industrie
  // 4.0 », « v1.2 » et les numéros de version, qui ont la même forme.
  if (!/^[a-z]{2,24}$/.test(tld)) return trimmed;
  if (NON_ROUTABLE_TLDS.has(tld)) return trimmed;

  // Chaque étiquette : alphanumérique ou tiret, jamais bordée d'un tiret.
  const wellFormed = labels.every((l) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(l));
  if (!wellFormed) return trimmed;

  return `https://${trimmed}`;
}

/**
 * Validates and normalises one claim before it is written.
 *
 * Rejects rather than silently clamps where the mistake is a category error —
 * an inference presented as fact is not a rounding problem — and clamps only
 * where the intent is unambiguous.
 */
export function prepareEvidence(
  draft: EvidenceDraft,
  context: { simulated: boolean },
): EvidenceDraft & { confidence: number; nature: EvidenceNature } {
  if (!draft.field.trim()) throw badRequest('Evidence must name the field it speaks to');
  if (!draft.claim.trim()) throw badRequest('Evidence must state a claim');

  // Un domaine nu est complété avant les contrôles : la discipline porte sur ce
  // qui sera écrit, et refuser une source pour un protocole manquant serait
  // sévère sans être utile.
  const sourceRef = draft.sourceRef ? normaliseSourceRef(draft.sourceRef) : draft.sourceRef;

  // Espaces normalisés à l'écriture, pour que deux copies d'une même phrase se
  // reconnaissent ensuite sans avoir à être interprétées. Le texte n'est pas
  // retouché autrement : seule la mise en forme est unifiée.
  const claim = normaliseSpace(draft.claim);

  // In simulation there is no external world to have observed anything in.
  // Downgrading rather than refusing keeps the pipeline demonstrable while
  // making it impossible for simulated output to masquerade as observation.
  const nature: EvidenceNature = context.simulated ? 'inferred' : draft.nature;

  if (nature === 'inferred' && !(draft.basis ?? '').trim() && !context.simulated) {
    throw badRequest('An inference must state the basis it was drawn from');
  }
  if (nature !== 'inferred' && !(sourceRef ?? '').trim() && !context.simulated) {
    throw badRequest(`An ${nature} claim must cite the source it was read at`);
  }

  const requested = draft.confidence ?? (nature === 'inferred' ? 0.5 : 0.7);
  const ceiling = nature === 'inferred' ? MAX_INFERENCE_CONFIDENCE : 1;
  const confidence = Math.max(0, Math.min(ceiling, requested));

  return {
    ...draft,
    claim,
    sourceRef,
    nature,
    confidence,
    basis: draft.basis ?? (context.simulated ? 'Simulated inference — no external source' : null),
  };
}

/**
 * How well-supported a set of claims is, 0..1.
 *
 * Three things move it: how much evidence there is, how it was obtained, and
 * how reliable the sources are. It is deliberately computed rather than
 * asserted, so no agent can talk its own findings up.
 */
export function evidenceStrength(
  evidence: readonly Evidence[],
  sources: ReadonlyMap<string, Source>,
): number {
  if (evidence.length === 0) return 0;

  const natureWeight: Record<EvidenceNature, number> = {
    observed: 1,
    reported: 0.75,
    inferred: 0.35,
  };

  let total = 0;
  for (const item of evidence) {
    const reliability = sources.get(item.sourceKey)?.reliability ?? 0.4;
    total += natureWeight[item.nature] * reliability * item.confidence;
  }

  // Averaged, then lifted by breadth: five corroborating claims should beat one
  // strong claim, but with diminishing returns rather than linearly.
  const average = total / evidence.length;
  const breadth = Math.min(1, Math.log2(evidence.length + 1) / Math.log2(9));
  return round2(Math.min(1, average * (0.65 + 0.35 * breadth)));
}

/** Distinct fields the evidence covers — breadth of what is actually known. */
export function coveredFields(evidence: readonly Evidence[]): string[] {
  return [...new Set(evidence.map((e) => e.field))].sort();
}

/**
 * Whether a claimed fact is backed by something other than the model's opinion.
 *
 * This is the mechanical half of verification: qualification may not rest on a
 * field whose only support is an inference.
 */
export function hasGroundedEvidence(evidence: readonly Evidence[], field: string): boolean {
  return evidence.some((e) => e.field === field && e.nature !== 'inferred');
}

/** How stale the freshest observation is, in days. Null when nothing is known. */
export function evidenceAgeDays(evidence: readonly Evidence[], now = Date.now()): number | null {
  if (evidence.length === 0) return null;
  const newest = Math.max(...evidence.map((e) => Date.parse(e.collectedAt) || 0));
  if (!newest) return null;
  return Math.max(0, (now - newest) / 86_400_000);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Une seule forme pour un même texte : bords coupés, espaces internes réduits.
 *
 * Purement typographique. Deux phrases qui ne different que par un retour a la
 * ligne sont la meme phrase ; deux phrases qui different par un mot ne le sont
 * pas, et rien ici ne pretend en juger.
 */
export const normaliseSpace = (text: string): string => text.trim().replace(/\s+/g, ' ');
