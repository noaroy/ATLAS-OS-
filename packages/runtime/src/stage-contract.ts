import type { Repositories } from '@atlas/data';

/**
 * Ce qu'une étape doit avoir réellement produit pour être dite réussie.
 *
 * SALVAGE-001 a franchi la qualification avec zéro appel d'outil : l'ambassadeur
 * a rendu du texte, le runtime a rendu ce texte, et l'étape a été comptée comme
 * réussie. Le scoring a démarré sur cinq candidats sans verdict, ses deux
 * appels ont échoué, l'agent a réessayé, et la mission a brûlé son budget à
 * noter ce qui n'avait jamais été qualifié.
 *
 * Le défaut n'est pas que l'agent ait mal travaillé. C'est qu'aucune définition
 * de « réussie » n'existait : le seul critère était « le modèle a répondu ».
 * Un modèle répond toujours.
 *
 * Une étape est donc réussie quand sa **postcondition métier** est vraie —
 * quand l'artefact qu'elle devait produire existe en base. Du texte seul est un
 * non-événement, pas un succès. La différence est celle entre « l'agent a
 * parlé » et « le travail est fait », et c'est la seule qui compte pour ce qui
 * sera facturé.
 */

export interface StageCheckContext {
  repos: Repositories;
  missionId: string;
  /** Les opportunités sur lesquelles l'étape devait travailler. */
  opportunityIds: string[];
  /** Ce que l'étape a écrit sur disque, quand elle produit des fichiers. */
  artifacts?: string[];
}

export interface StageCheck {
  ok: boolean;
  /** Ce qui était attendu, en clair. */
  expected: string;
  /** Ce qui a été constaté, en clair. */
  actual: string;
  /** Le détail par candidat, pour dire *lequel* manque. */
  missing: string[];
}

export interface StageContract {
  stage: string;
  /** Ce que l'étape doit recevoir pour pouvoir commencer. */
  requiredInputs: string[];
  /** Ce qu'elle doit avoir produit pour être dite réussie. */
  requiredOutputs: string[];
  /** Les seuls outils qu'elle peut employer. */
  allowedTools: string[];
  /** La postcondition métier. Vraie ⇒ l'étape est réussie. */
  completionCondition: (ctx: StageCheckContext) => StageCheck;
  /**
   * Ce qui condamne l'étape indépendamment de sa postcondition.
   *
   * Distinct d'une postcondition fausse : une étape qui n'a rien produit peut
   * être réessayée, une étape qui a produit quelque chose d'interdit ne doit
   * pas l'être.
   */
  failureCondition?: (ctx: StageCheckContext) => StageCheck | null;
}

const ok = (expected: string, actual: string): StageCheck => ({
  ok: true,
  expected,
  actual,
  missing: [],
});

/** Le nom d'un candidat, pour que le diagnostic se lise sans requête SQL. */
const nameOf = (ctx: StageCheckContext, opportunityId: string): string => {
  const opportunity = ctx.repos.opportunities.get(opportunityId);
  if (!opportunity) return opportunityId;
  return ctx.repos.companies.get(opportunity.companyId)?.name ?? opportunityId;
};

// ─── Qualification ──────────────────────────────────────────────────────────

const QUALIFICATION: StageContract = {
  stage: 'qualification',
  requiredInputs: ['candidates'],
  requiredOutputs: ['verdict', 'rationale', 'evidenceIds'],
  allowedTools: ['qualify_opportunity', 'record_evidence', 'memory_search'],
  completionCondition: (ctx) => {
    const missing: string[] = [];
    for (const id of ctx.opportunityIds) {
      const opportunity = ctx.repos.opportunities.get(id);
      const qualification = opportunity?.qualification;
      if (!qualification) {
        missing.push(`${nameOf(ctx, id)} : aucun verdict`);
        continue;
      }
      if (!qualification.rationale?.trim()) {
        missing.push(`${nameOf(ctx, id)} : verdict sans motif`);
        continue;
      }
      // Un verdict doit s'appuyer sur des preuves nommées. Sans elles, c'est
      // une opinion — et une opinion ne se facture pas comme une vérification.
      const cited = qualification.checks.some((c) => (c.evidenceIds?.length ?? 0) > 0);
      if (!cited) missing.push(`${nameOf(ctx, id)} : aucun contrôle ne cite de preuve`);
    }
    const decided = ctx.opportunityIds.length - missing.length;
    return {
      ok: missing.length === 0 && ctx.opportunityIds.length > 0,
      expected: `un verdict motivé et sourcé pour ${ctx.opportunityIds.length} candidat(s)`,
      actual: `${decided} verdict(s) exploitable(s)`,
      missing,
    };
  },
};

// ─── Notation ───────────────────────────────────────────────────────────────

const SCORING: StageContract = {
  stage: 'scoring',
  requiredInputs: ['qualifiedCandidates'],
  requiredOutputs: ['score', 'confidence', 'evidenceIds'],
  allowedTools: ['score_opportunity', 'record_evidence', 'memory_search'],
  completionCondition: (ctx) => {
    // Seuls les candidats retenus se notent : un candidat écarté n'a pas à
    // porter de score, et l'exiger ferait échouer une étape correcte.
    const toScore = ctx.opportunityIds.filter(
      (id) => ctx.repos.opportunities.get(id)?.qualification?.verdict === 'qualified',
    );
    const missing: string[] = [];
    for (const id of toScore) {
      const opportunity = ctx.repos.opportunities.get(id)!;
      if (opportunity.score === null) {
        missing.push(`${nameOf(ctx, id)} : aucun score`);
        continue;
      }
      const detail = opportunity.scoreDetail;
      if (!detail || detail.components.length === 0) {
        missing.push(`${nameOf(ctx, id)} : score sans décomposition`);
        continue;
      }
      const grounded = detail.components.some((c) => (c.evidenceIds?.length ?? 0) > 0);
      if (!grounded) missing.push(`${nameOf(ctx, id)} : aucune dimension ne cite de preuve`);

      // ── Notation hors échelle ────────────────────────────────────────────
      //
      // Le micro-run a rendu des totaux de 14,8 et 13,98 pour un seuil de 45 :
      // le modèle avait noté de 0 à 10 quand la plateforme pondère sur 100.
      // Les évaluations étaient justes, leurs rationales sourcées — seul
      // l'ordre de grandeur était faux, et rien ne s'en apercevait avant le
      // classement, qui rendait alors une liste vide sans dire pourquoi.
      //
      // Le contraste est la signature : les dimensions calculées par la
      // plateforme restent sur 100 pendant que celles du modèle plafonnent à
      // 10. Un candidat réellement mauvais sur tous les axes déclencherait
      // aussi ce contrôle — c'est acceptable, parce qu'il ne serait de toute
      // façon pas retenu, et qu'un diagnostic explicite vaut mieux qu'un
      // classement vide.
      const judged = detail.components.filter((c) => !c.computed);
      const computed = detail.components.filter((c) => c.computed);
      const highestJudged = Math.max(0, ...judged.map((c) => c.value));
      const highestComputed = Math.max(0, ...computed.map((c) => c.value));
      if (judged.length > 0 && highestJudged <= 10 && highestComputed > 30) {
        missing.push(
          `${nameOf(ctx, id)} : notation probablement sur 10 et non sur 100 ` +
            `(plus haute note du modèle ${highestJudged}, dimension calculée ${highestComputed})`,
        );
      }
    }
    return {
      ok: missing.length === 0 && toScore.length > 0,
      expected:
        toScore.length > 0
          ? `un score sourcé pour ${toScore.length} candidat(s) qualifié(s)`
          : 'au moins un candidat qualifié à noter',
      actual: `${toScore.length - missing.length} score(s) exploitable(s)`,
      missing,
    };
  },
};

// ─── Classement ─────────────────────────────────────────────────────────────

const RANKING: StageContract = {
  stage: 'ranking',
  requiredInputs: ['scoredCandidates'],
  requiredOutputs: ['rank', 'justification'],
  allowedTools: ['rank_shortlist', 'memory_search'],
  completionCondition: (ctx) => {
    const scored = ctx.opportunityIds.filter((id) => ctx.repos.opportunities.get(id)?.score !== null);
    const ranked = scored.filter((id) => ctx.repos.opportunities.get(id)?.rank !== null);
    const missing = scored
      .filter((id) => ctx.repos.opportunities.get(id)?.rank === null)
      .map((id) => `${nameOf(ctx, id)} : noté mais non classé`);
    return {
      ok: missing.length === 0 && ranked.length > 0,
      expected: `${scored.length} candidat(s) noté(s) classé(s)`,
      actual: `${ranked.length} classé(s)`,
      missing,
    };
  },
  failureCondition: (ctx) => {
    // Un classement qui contient un candidat non noté est pire qu'un classement
    // absent : il donne un ordre à ce qui n'a pas été mesuré.
    const intruders = ctx.opportunityIds.filter((id) => {
      const opportunity = ctx.repos.opportunities.get(id);
      return opportunity?.rank !== null && opportunity?.score === null;
    });
    if (intruders.length === 0) return null;
    return {
      ok: false,
      expected: 'aucun candidat non noté dans le classement',
      actual: `${intruders.length} candidat(s) classé(s) sans score`,
      missing: intruders.map((id) => `${nameOf(ctx, id)} : classé sans score`),
    };
  },
};

// ─── Export ─────────────────────────────────────────────────────────────────

const EXPORT: StageContract = {
  stage: 'export',
  requiredInputs: ['rankedCandidates'],
  requiredOutputs: ['file'],
  allowedTools: [],
  completionCondition: (ctx) => {
    const files = ctx.artifacts ?? [];
    if (files.length === 0) {
      return {
        ok: false,
        expected: 'au moins un fichier livrable écrit sur disque',
        actual: 'aucun fichier',
        missing: ['aucun artefact produit'],
      };
    }
    const sellable = ctx.opportunityIds.filter((id) => {
      const opportunity = ctx.repos.opportunities.get(id);
      return opportunity?.score !== null && opportunity?.qualification?.verdict === 'qualified';
    });
    return {
      ok: sellable.length > 0,
      expected: 'au moins un prospect vendable dans le livrable',
      actual: `${sellable.length} prospect(s) vendable(s)`,
      missing: sellable.length === 0 ? ['aucun prospect ne franchit la barre'] : [],
    };
  },
  failureCondition: (ctx) => {
    // Les gardes LIVE, au dernier moment où elles peuvent encore empêcher une
    // livraison : une fois le fichier chez le client, il est trop tard.
    const forbidden: string[] = [];
    for (const id of ctx.opportunityIds) {
      const opportunity = ctx.repos.opportunities.get(id);
      if (!opportunity || opportunity.rank === null) continue;
      const company = ctx.repos.companies.get(opportunity.companyId);
      if (!company) continue;
      if (company.dataOrigin !== 'live') {
        forbidden.push(`${company.name} : lignée « ${company.dataOrigin} »`);
      }
      if (company.identityStatus !== 'ok') {
        forbidden.push(`${company.name} : identité « ${company.identityStatus} »`);
      }
      const simulated = ctx.repos.companies
        .evidenceForOpportunity(opportunity.id)
        .filter((e) => e.simulated).length;
      if (simulated > 0) forbidden.push(`${company.name} : ${simulated} preuve(s) simulée(s)`);
    }
    if (forbidden.length === 0) return null;
    return {
      ok: false,
      expected: 'aucune ligne interdite par les gardes LIVE',
      actual: `${forbidden.length} ligne(s) interdite(s)`,
      missing: forbidden,
    };
  },
};

export const STAGE_CONTRACTS: Record<string, StageContract> = {
  qualification: QUALIFICATION,
  scoring: SCORING,
  ranking: RANKING,
  export: EXPORT,
};

export const contractFor = (stage: string): StageContract | null =>
  STAGE_CONTRACTS[stage.trim().toLowerCase()] ?? null;

export interface PostconditionResult {
  stage: string;
  passed: boolean;
  /** Le diagnostic, écrit pour être lu dans un journal sans autre contexte. */
  diagnostic: string;
  check: StageCheck;
}

/**
 * L'étape a-t-elle réellement produit ce qu'on lui demandait ?
 *
 * Appelée **après** chaque étape, et son verdict remplace celui du modèle. Une
 * étape sans contrat déclaré passe : cette table décrit le pipeline commercial,
 * et un plan ailleurs dans ATLAS ne doit pas se retrouver bloqué parce qu'il
 * n'y figure pas.
 */
export function validateStagePostcondition(
  stage: string,
  ctx: StageCheckContext,
): PostconditionResult {
  const contract = contractFor(stage);
  if (!contract) {
    return {
      stage,
      passed: true,
      diagnostic: `Aucun contrat déclaré pour « ${stage} » — postcondition non applicable.`,
      check: ok('aucune postcondition', 'non applicable'),
    };
  }

  const failure = contract.failureCondition?.(ctx);
  if (failure) {
    return {
      stage,
      passed: false,
      diagnostic: formatDiagnostic(stage, failure, 'STAGE_FAILURE_CONDITION_MET'),
      check: failure,
    };
  }

  const check = contract.completionCondition(ctx);
  return {
    stage,
    passed: check.ok,
    diagnostic: check.ok
      ? `${stage} : ${check.actual}.`
      : formatDiagnostic(stage, check, 'STAGE_POSTCONDITION_FAILED'),
    check,
  };
}

function formatDiagnostic(stage: string, check: StageCheck, code: string): string {
  const lines = [`${code}`, `stage=${stage}`, `expected=${check.expected}`, `actual=${check.actual}`];
  if (check.missing.length > 0) {
    lines.push(...check.missing.slice(0, 10).map((m) => `  - ${m}`));
    if (check.missing.length > 10) lines.push(`  … et ${check.missing.length - 10} de plus`);
  }
  return lines.join('\n');
}
