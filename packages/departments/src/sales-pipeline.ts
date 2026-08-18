/**
 * L'ordre des étapes, isolé de ce qui les exécute.
 *
 * Le lot 002 a payé pour qualifier l'éditeur d'une étude de marché. L'ordre
 * était en cause, pas la qualification : le modèle a été appelé sur un objet
 * dont personne n'avait établi l'identité. Tant que cet ordre vivait dans un
 * script, il ne pouvait pas être testé — on pouvait affirmer qu'aucun appel
 * ne précédait la résolution, pas le prouver.
 *
 * Il vit donc ici, avec la qualification en paramètre. Un test peut passer une
 * fonction qui compte ses appels et vérifier qu'elle reste à zéro sur un
 * candidat que les gardes refusent — ce qui est une preuve, contrairement à
 * une lecture attentive du script.
 */

import { classifyPageType, resolveCompanyIdentity, icpStatus, type CompanyIdentity } from './company-resolver.ts';
import { looksLikeCompanySite } from './sales-queries.ts';
import { filterCandidate, ATLAS_SALES_ICP, type SalesIcp } from './sales-icp.ts';

export interface PipelineCandidate {
  searchTitle: string;
  url: string;
  domain: string | null;
  country?: string | null;
  industry?: string | null;
  snippet?: string | null;
}

/** La raison exacte pour laquelle un candidat s'arrête, et à quelle étape. */
export type RejectionStage =
  | 'PAGE_TYPE_REJECTED'
  | 'URL_SHAPE_REJECTED'
  | 'IDENTITY_UNRESOLVED'
  | 'OUT_OF_ICP'
  | 'DEDUPLICATED';

export interface PipelineRejection {
  candidate: PipelineCandidate;
  stage: RejectionStage;
  reason: string;
}

export interface PipelineSurvivor {
  candidate: PipelineCandidate;
  identity: CompanyIdentity;
}

export interface FunnelCounts {
  searchResults: number;
  pageTypeRejected: number;
  urlShapeRejected: number;
  identityUnresolved: number;
  outOfIcp: number;
  deduplicated: number;
  retained: number;
}

export interface PipelineOutcome<Q> {
  survivors: PipelineSurvivor[];
  rejections: PipelineRejection[];
  funnel: FunnelCounts;
  qualifications: Array<{ survivor: PipelineSurvivor; result: Q }>;
}

export interface PipelineOptions<Q> {
  candidates: readonly PipelineCandidate[];
  maxRetained: number;
  /**
   * Ce qui coûte. Appelée seulement sur les survivants, jamais avant — c'est
   * l'invariant que ce module existe pour rendre vérifiable.
   */
  qualify: (survivor: PipelineSurvivor) => Promise<Q>;
  /** Combien de qualifications au maximum. Le plafond de dépense en amont. */
  maxQualifications?: number;
  /** Le profil recherché. Celui d'ATLAS par défaut. */
  icp?: SalesIcp;
}

export async function runSalesPipeline<Q>(options: PipelineOptions<Q>): Promise<PipelineOutcome<Q>> {
  const rejections: PipelineRejection[] = [];
  const resolved: PipelineSurvivor[] = [];

  for (const candidate of options.candidates) {
    // 1. À qui appartient cette page ?
    const page = classifyPageType({
      url: candidate.url,
      domain: candidate.domain,
      title: candidate.searchTitle,
      snippet: candidate.snippet,
    });
    if (!page.ownerIsCandidate) {
      rejections.push({ candidate, stage: 'PAGE_TYPE_REJECTED', reason: `page de type ${page.type} : ${page.reason}` });
      continue;
    }

    // 2. La forme de l'URL : un article coûterait le même prix qu'une usine.
    const shape = looksLikeCompanySite(candidate.url);
    if (!shape.ok) {
      rejections.push({ candidate, stage: 'URL_SHAPE_REJECTED', reason: shape.reason });
      continue;
    }

    // 3. Quelle entreprise cette page désigne-t-elle ?
    const outcome = resolveCompanyIdentity({
      searchTitle: candidate.searchTitle,
      url: candidate.url,
      domain: candidate.domain,
      country: candidate.country,
      page,
    });
    if (!outcome.identity) {
      rejections.push({ candidate, stage: 'IDENTITY_UNRESOLVED', reason: outcome.reason });
      continue;
    }

    // 4. Entre-t-elle dans le profil ? Le titre brut part avec le résumé :
    //    ramener « X : agence marketing » à « X » ne doit pas faire disparaître
    //    le mot qui disqualifie.
    const icp = icpStatus({
      companyName: outcome.identity.companyName,
      snippet: [candidate.searchTitle, candidate.snippet].filter(Boolean).join(' — '),
      industry: candidate.industry,
      country: outcome.identity.country,
    });
    if (icp.status !== 'MATCH') {
      rejections.push({ candidate, stage: 'OUT_OF_ICP', reason: icp.reason });
      continue;
    }

    // Le filtre de profil historique reste consulté : il attrape des libellés
    // que la classification de page laisse passer (« annuaire » dans un nom,
    // par exemple). Ses refus sont comptés au même endroit, parce qu'un
    // entonnoir à deux sorties pour un même motif ne se lit plus.
    const filtered = filterCandidate(
      {
        companyName: outcome.identity.companyName,
        domain: outcome.identity.canonicalDomain,
        country: candidate.country ?? null,
        industry: candidate.industry ?? null,
        sourceUrl: candidate.url,
        searchProvider: 'pipeline',
        query: '',
        discoveredAt: new Date().toISOString(),
        snippet: candidate.snippet ?? null,
      },
      options.icp ?? ATLAS_SALES_ICP,
    );
    if (filtered.outcome === 'rejected') {
      rejections.push({ candidate, stage: 'OUT_OF_ICP', reason: filtered.reason });
      continue;
    }

    resolved.push({ candidate, identity: outcome.identity });
  }

  // 5. Dédoublonnage sur le domaine officiel, pas sur celui du résultat : deux
  //    pages d'un même site ne sont qu'une entreprise.
  const seen = new Set<string>();
  const survivors: PipelineSurvivor[] = [];
  for (const entry of resolved) {
    if (seen.has(entry.identity.canonicalDomain)) {
      rejections.push({
        candidate: entry.candidate,
        stage: 'DEDUPLICATED',
        reason: `déjà retenu sous « ${entry.identity.canonicalDomain} ».`,
      });
      continue;
    }
    seen.add(entry.identity.canonicalDomain);
    if (survivors.length < options.maxRetained) survivors.push(entry);
  }

  // 6. Seulement maintenant, ce qui coûte.
  const qualifications: Array<{ survivor: PipelineSurvivor; result: Q }> = [];
  const cap = options.maxQualifications ?? survivors.length;
  for (const survivor of survivors.slice(0, cap)) {
    qualifications.push({ survivor, result: await options.qualify(survivor) });
  }

  const count = (stage: RejectionStage) => rejections.filter((r) => r.stage === stage).length;
  return {
    survivors,
    rejections,
    qualifications,
    funnel: {
      searchResults: options.candidates.length,
      pageTypeRejected: count('PAGE_TYPE_REJECTED'),
      urlShapeRejected: count('URL_SHAPE_REJECTED'),
      identityUnresolved: count('IDENTITY_UNRESOLVED'),
      outOfIcp: count('OUT_OF_ICP'),
      deduplicated: count('DEDUPLICATED'),
      retained: survivors.length,
    },
  };
}

/**
 * L'entonnoir doit fermer.
 *
 * Un décompte qui ne retombe pas sur le nombre de résultats cache une étape,
 * et une étape cachée est exactement ce qui a laissé passer le lot 002.
 */
export function funnelBalances(f: FunnelCounts): { balanced: boolean; sum: number; missing: number } {
  const sum =
    f.pageTypeRejected + f.urlShapeRejected + f.identityUnresolved +
    f.outOfIcp + f.deduplicated + f.retained;
  return { balanced: sum === f.searchResults, sum, missing: f.searchResults - sum };
}
