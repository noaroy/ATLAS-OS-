import type { ExpansionStage, ProspectEvidence, ProspectRelationship, SourceTrust } from '@atlas/data';
import { icpStatus, countryFit, type IcpStatus } from '@atlas/departments';
import type { ExpansionIcp, RelationshipType } from './types.ts';
import { flatten, keywordHit } from './normalize.ts';

/**
 * Le score d'occasion, et l'étage de l'entonnoir qu'il ouvre.
 *
 *   UNIVERSE → RELEVANT → QUALIFIED → HIGH_PRIORITY
 *
 * Huit facteurs, tous lisibles dans `detail` : adéquation au profil,
 * qualité de la relation, force de la preuve, géographie, pertinence
 * commerciale, confiance des sources, distance dans le graphe, confiance de
 * la relation. Aucun ne prétend connaître une probabilité de revenu : il n'y
 * a pas de preuve pour cela, donc pas de chiffre.
 *
 * Une règle ne se négocie pas : sans preuve forte (page officielle, page de
 * salon ou de fédération) et sans relation d'une confiance suffisante, un
 * candidat ne passe jamais HIGH_PRIORITY, quel que soit son score.
 */

export const TRUST_WEIGHT: Record<SourceTrust, number> = { OFFICIAL: 20, ASSOCIATION_EVENT: 16, SECONDARY: 6 };

const RELATIONSHIP_WEIGHT: Record<RelationshipType, number> = {
  DISTRIBUTOR: 20, RESELLER: 19, INTEGRATOR: 19, IMPORTER: 18, WHOLESALER: 18, INSTALLER: 16, MAINTENANCE_PARTNER: 16, OEM_PARTNER: 18,
  COMPLEMENTARY_VENDOR: 15, COMPETITOR: 17, SIMILAR_COMPANY: 15, ASSOCIATION_MEMBER: 14, TRADE_SHOW_EXHIBITOR: 14,
  VISIBLE_PARTNER: 12, VISIBLE_BRAND: 10, LIKELY_CUSTOMER: 12, GROUP_MEMBER: 10, SUBSIDIARY: 10, OTHER: 6,
};

export const STAGE_THRESHOLDS = { RELEVANT: 35, QUALIFIED: 55, HIGH_PRIORITY: 70 } as const;
export const HIGH_PRIORITY_MIN_RELATIONSHIP_CONFIDENCE = 0.6;
const STRONG: readonly SourceTrust[] = ['OFFICIAL', 'ASSOCIATION_EVENT'];

export interface ScoreInput {
  name: string;
  domain: string | null;
  country: string | null;
  /** Le pays est-il prouvé (page officielle) ou seulement suggéré (suffixe, extrait) ? */
  countryProven: boolean;
  depth: number;
  /** Ce que la cible dit d'elle-même. Juge le métier et les exclusions. */
  snippet: string | null;
  /** Le contexte des liens qui la nomment sur des pages tierces. Indice de pertinence seulement. */
  context?: string | null;
  /** Ce que le modèle a dit de la pertinence, s'il a été consulté. */
  aiRelevant: boolean | null;
  relationships: readonly ProspectRelationship[];
  evidence: readonly ProspectEvidence[];
  icp: ExpansionIcp;
}

export interface ScoreVerdict {
  score: number;
  stage: ExpansionStage;
  icpStatus: IcpStatus;
  rejectReason: string | null;
  detail: Record<string, number | string | boolean | null>;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function scoreCandidate(input: ScoreInput): ScoreVerdict {
  const rels = input.relationships;
  const best = rels.reduce<ProspectRelationship | null>((acc, r) => (acc === null || r.confidence > acc.confidence ? r : acc), null);
  const strongestTrust = input.evidence.reduce<SourceTrust | null>((acc, e) => {
    if (acc === null) return e.trust;
    return TRUST_WEIGHT[e.trust] > TRUST_WEIGHT[acc] ? e.trust : acc;
  }, null);
  const distinctUrls = new Set(input.evidence.map((e) => e.url)).size;

  // 1. Le profil (0–25). Le pays d'abord : prouvé hors profil, c'est un rejet ;
  // seulement suggéré (suffixe, extrait), c'est une absence de points. Le
  // métier ensuite : les mots du profil quand il en donne, sinon le tri
  // industriel du lot commercial (`icpStatus`, sans son volet pays — jugé ici).
  const geo = countryFit(input.country, input.icp.countries);
  const haystack = flatten([input.name, input.snippet ?? ''].join(' '));
  const excluded = input.icp.exclusions.find((x) => haystack.includes(flatten(x)));
  if (!input.domain) {
    return { score: 0, stage: 'UNIVERSE', icpStatus: 'UNKNOWN', rejectReason: 'aucun site identifié : impossible de vérifier quoi que ce soit', detail: { domain: false } };
  }
  if (excluded) {
    return { score: 0, stage: 'REJECTED', icpStatus: 'OUT_OF_ICP', rejectReason: `mot écarté par le profil : « ${excluded} »`, detail: { excluded } };
  }
  if (geo.fit === 'OUT_OF_SCOPE' && input.countryProven) {
    return { score: 0, stage: 'REJECTED', icpStatus: 'OUT_OF_ICP', rejectReason: geo.reason, detail: { country: input.country, countryProven: true } };
  }
  const hintstack = [haystack, input.context ?? ''].join(' ');
  const keywordHits = input.icp.keywords.filter((k) => keywordHit(hintstack, k)).length;
  const icp: { status: IcpStatus; reason: string } = input.icp.keywords.length > 0
    ? (keywordHits > 0
      ? { status: 'MATCH', reason: `${keywordHits} mot(s) du profil repéré(s)` }
      : { status: 'UNKNOWN', reason: 'aucun mot du profil dans ce qu’on sait' })
    : icpStatus({ companyName: input.name, snippet: input.snippet, country: null });
  if (icp.status === 'OUT_OF_ICP') {
    return { score: 0, stage: 'REJECTED', icpStatus: 'OUT_OF_ICP', rejectReason: icp.reason, detail: { icp: icp.reason } };
  }
  const icpPoints = icp.status === 'MATCH' ? 25 : icp.status === 'NEEDS_VERIFICATION' ? 12 : 8;

  // 2. La relation (0–20), pondérée par sa confiance.
  const relationPoints = best ? Math.round(RELATIONSHIP_WEIGHT[best.relationshipType as RelationshipType] * best.confidence) : 0;
  // 3. La preuve (0–20) : la plus forte, plus deux points par preuve distincte supplémentaire.
  const evidencePoints = strongestTrust ? clamp(TRUST_WEIGHT[strongestTrust] + Math.max(0, distinctUrls - 1) * 2, 0, 20) : 0;
  // 4. La géographie (0–15).
  const geoPoints = geo.fit === 'IN_SCOPE' ? (input.countryProven ? 15 : 11) : geo.fit === 'NEEDS_VERIFICATION' ? 6 : 0;
  // 5. La pertinence commerciale (0–10) : mots de métier du profil dans ce qu'on sait, ou l'avis du modèle.
  const relevancePoints = input.aiRelevant === true ? 10 : input.aiRelevant === false ? 0 : clamp(keywordHits * 4, 0, 8);
  // 6. La distance (0–5) et 7. la confiance (0–5).
  const distancePoints = input.depth <= 1 ? 5 : input.depth === 2 ? 2 : 0;
  const confidencePoints = best ? Math.round(best.confidence * 5) : 0;

  const score = clamp(icpPoints + relationPoints + evidencePoints + geoPoints + relevancePoints + distancePoints + confidencePoints, 0, 100);

  const hasStrongEvidence = strongestTrust !== null && STRONG.includes(strongestTrust);
  const strongRelationship = best !== null && best.confidence >= HIGH_PRIORITY_MIN_RELATIONSHIP_CONFIDENCE;
  let stage: ExpansionStage = 'UNIVERSE';
  let rejectReason: string | null = null;
  // Qualifié : le pays est dans le profil (au moins suggéré). Prioritaire : le
  // pays est *prouvé* dans le profil, la preuve est forte, la relation sûre.
  // Un distributeur ukrainien d'un fabricant français est une vraie relation
  // — et un candidat hors profil ; il reste RELEVANT, jamais QUALIFIED.
  // Qualifié, c'est aussi *du métier* : les signaux du profil (ou l'avis du
  // modèle) le disent. Un exposant d'un salon voisin — un fabricant
  // d'ordinateurs sur un salon de robotique — reste RELEVANT.
  const inScope = geo.fit === 'IN_SCOPE';
  const inTrade = icp.status === 'MATCH' || input.aiRelevant === true;
  if (rels.length === 0) {
    rejectReason = 'aucune relation prouvée';
  } else if (score >= STAGE_THRESHOLDS.HIGH_PRIORITY && hasStrongEvidence && strongRelationship && inScope && inTrade && input.countryProven) {
    stage = 'HIGH_PRIORITY';
  } else if (score >= STAGE_THRESHOLDS.QUALIFIED && inScope && inTrade) {
    stage = 'QUALIFIED';
  } else if (score >= STAGE_THRESHOLDS.RELEVANT) {
    stage = 'RELEVANT';
  }
  if (stage !== 'HIGH_PRIORITY' && score >= STAGE_THRESHOLDS.QUALIFIED) {
    rejectReason = !inScope ? `pays ${input.country ? `« ${input.country} »` : 'inconnu'} : ${geo.reason}`
      : !inTrade ? `métier non établi : ${icp.reason}`
        : !hasStrongEvidence ? 'aucune preuve forte (page officielle, salon ou fédération) : ne peut pas être prioritaire'
          : !strongRelationship ? `relation trop incertaine (${best?.confidence.toFixed(2)}) pour être prioritaire`
            : !input.countryProven ? 'pays suggéré, non prouvé par une page officielle : ne peut pas être prioritaire' : rejectReason;
  }

  return {
    score, stage, icpStatus: icp.status, rejectReason,
    detail: {
      icp: icpPoints, relationship: relationPoints, evidence: evidencePoints, geography: geoPoints, relevance: relevancePoints,
      distance: distancePoints, confidence: confidencePoints, bestRelationship: best?.relationshipType ?? null, bestConfidence: best?.confidence ?? null,
      strongestTrust, evidenceUrls: distinctUrls, country: input.country, countryProven: input.countryProven, icpReason: icp.reason,
    },
  };
}
