import type { Logger } from '@atlas/core';
import type { Repositories } from '@atlas/data';
import type { LlmProvider, LlmRequest } from '@atlas/llm';
import { textOf } from '@atlas/llm';
import type { OpportunityService } from '@atlas/intelligence';
import type { ScoringModel } from '@atlas/contracts';
import { validateStagePostcondition, type PostconditionResult } from './stage-contract.ts';

/**
 * Le pipeline commercial, conduit par le contrôleur et non par l'agent.
 *
 * SALVAGE-001 : l'ambassadeur a rendu du texte sans jamais appeler
 * `qualify_opportunity`. Rien ne l'y obligeait — le runtime lui présentait
 * l'outil et attendait qu'il choisisse de s'en servir. Cinq candidats sont
 * ressortis sans verdict, et le scoring a démarré dessus.
 *
 * La question « vais-je appeler qualify_opportunity ? » n'aurait jamais dû être
 * posée à un modèle. Elle n'a pas de bonne réponse à donner : l'étape s'appelle
 * qualification, elle qualifie. Ce qui relève du jugement, c'est le *contenu*
 * du verdict — pas la décision de l'émettre.
 *
 * D'où la répartition ici :
 *
 *   le contrôleur   décide quoi exécuter, sur quels candidats, dans quel ordre
 *   le modèle       fournit le contenu structuré d'une unité de travail
 *   le service      applique les règles et écrit
 *
 * Le modèle répond en JSON contraint par un schéma, jamais par appel d'outil.
 * Un texte libre ne peut donc plus tenir lieu de travail : soit la sortie
 * valide le schéma, soit l'unité échoue et le dit.
 */

export interface PipelineDeps {
  repos: Repositories;
  intelligence: OpportunityService;
  provider: LlmProvider;
  logger: Logger;
  model: string;
  maxOutputTokens: number;
}

export interface StageOutcome {
  stage: string;
  /** Combien d'unités de travail ont abouti. */
  completed: number;
  /** Combien ont échoué, malgré la réparation. */
  failed: number;
  /** Combien ont eu besoin d'une réparation, et l'ont obtenue. */
  repaired: number;
  postcondition: PostconditionResult;
  /** Vrai seulement si la postcondition métier est vraie. */
  succeeded: boolean;
}

/** Ce que le modèle doit rendre pour qualifier un candidat. */
const QUALIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['qualified', 'rejected', 'uncertain'] },
    rationale: { type: 'string', maxLength: 1200 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    checks: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          criterion: { type: 'string', maxLength: 160 },
          passed: { type: 'boolean' },
          detail: { type: 'string', maxLength: 600 },
          evidenceIds: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 40 } },
        },
        required: ['criterion', 'passed', 'detail', 'evidenceIds'],
        additionalProperties: false,
      },
    },
    targetTypes: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 40 } },
  },
  required: ['verdict', 'rationale', 'confidence', 'checks'],
  additionalProperties: false,
} as const;

/** Ce que le modèle doit rendre pour noter un candidat. */
const SCORING_SCHEMA = {
  type: 'object',
  properties: {
    assessments: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          dimension: { type: 'string', maxLength: 60 },
          value: {
            type: 'number',
            minimum: 0,
            maximum: 100,
            description:
              'Note sur 100, où 0 = inadapté et 100 = idéal. Jamais sur 10 : la pondération ' +
              'est appliquée ensuite par la plateforme.',
          },
          rationale: { type: 'string', maxLength: 600 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          evidenceIds: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 40 } },
        },
        required: ['dimension', 'value', 'rationale', 'confidence', 'evidenceIds'],
        additionalProperties: false,
      },
    },
  },
  required: ['assessments'],
  additionalProperties: false,
} as const;

export class DeterministicPipeline {
  #log: Logger;

  constructor(private readonly deps: PipelineDeps) {
    this.#log = deps.logger.child({ scope: 'pipeline' });
  }

  /**
   * Qualifie chaque candidat, un par un.
   *
   * La boucle appartient au contrôleur. Un candidat dont le verdict échoue
   * n'empêche pas les suivants : c'est une unité de travail indépendante, et
   * traiter l'échec de l'un comme l'échec de tous perdrait le travail déjà
   * payé sur les autres.
   */
  async qualify(input: {
    missionId: string;
    opportunityIds: string[];
    agentKey: string;
    objective: string;
    requiredFields?: string[];
  }): Promise<StageOutcome> {
    let completed = 0;
    let failed = 0;
    let repaired = 0;

    for (const opportunityId of input.opportunityIds) {
      const brief = this.#candidateBrief(opportunityId);
      if (!brief) {
        failed++;
        continue;
      }

      const result = await this.#structured({
        missionId: input.missionId,
        taskRef: 'qualification',
        agentKey: input.agentKey,
        subject: opportunityId,
        schema: QUALIFICATION_SCHEMA,
        system:
          "Vous décidez si un candidat correspond à la cible d'une mission commerciale. " +
          "Appuyez chaque contrôle sur les preuves fournies, par leur identifiant. " +
          "N'affirmez rien qui ne figure pas dans ces preuves : une entreprise mal qualifiée " +
          "coûte plus cher au client qu'une entreprise écartée à tort.",
        prompt: `# Objectif\n${input.objective}\n\n# Candidat\n${brief}`,
      });

      if (!result.value) {
        failed++;
        this.#log.warn('qualification sans sortie exploitable', {
          opportunityId,
          reason: result.reason,
        });
        continue;
      }
      if (result.viaRepair) repaired++;

      try {
        const payload = result.value as {
          verdict: 'qualified' | 'rejected' | 'uncertain';
          rationale: string;
          confidence: number;
          checks: Array<{ criterion: string; passed: boolean; detail: string; evidenceIds: string[] }>;
          targetTypes?: string[];
        };
        this.deps.intelligence.qualify({
          opportunityId,
          agentKey: input.agentKey,
          verdict: payload.verdict,
          checks: payload.checks,
          rationale: payload.rationale,
          confidence: payload.confidence,
          ...(input.requiredFields ? { requiredFields: input.requiredFields } : {}),
          ...(payload.targetTypes?.length ? { targetTypes: payload.targetTypes } : {}),
        });
        completed++;
      } catch (err) {
        failed++;
        this.#log.warn('verdict refusé par le service', {
          opportunityId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return this.#outcome('qualification', input, { completed, failed, repaired });
  }

  /** Note chaque candidat qualifié. Les autres ne sont pas notés, et c'est correct. */
  async score(input: {
    missionId: string;
    opportunityIds: string[];
    agentKey: string;
    objective: string;
    model: ScoringModel;
  }): Promise<StageOutcome> {
    let completed = 0;
    let failed = 0;
    let repaired = 0;

    const toScore = input.opportunityIds.filter(
      (id) => this.deps.repos.opportunities.get(id)?.qualification?.verdict === 'qualified',
    );

    // L'échelle et le poids, explicitement.
    //
    // Le micro-run l'a payé : le prompt listait « - sector-fit : Adéquation
    // sectorielle » sans dire sur quoi noter. Le modèle a noté de 0 à 10, la
    // plateforme pondère sur 100, et les totaux sont sortis dix fois trop bas —
    // 14,8 et 13,98 pour un seuil de sélection à 45. Aucun candidat classé,
    // alors que les évaluations elles-mêmes étaient justes et bien sourcées.
    //
    // La seule dimension correcte était `evidence-quality`, calculée par la
    // plateforme : 81, contribution 8,1. C'est ce contraste qui a désigné la
    // cause — et c'est pourquoi elle est exclue de la liste ci-dessous : un
    // agent n'a pas à la fournir.
    const dimensions = input.model.dimensions
      .filter((d) => !d.computed)
      .map((d) => `- ${d.key} (${d.label}, poids ${d.weight}) : ${d.description ?? ''}`)
      .join('\n');

    for (const opportunityId of toScore) {
      const brief = this.#candidateBrief(opportunityId);
      if (!brief) {
        failed++;
        continue;
      }

      const result = await this.#structured({
        missionId: input.missionId,
        taskRef: 'scoring',
        agentKey: input.agentKey,
        subject: opportunityId,
        schema: SCORING_SCHEMA,
        system:
          "Vous notez l'adéquation d'un candidat, dimension par dimension. " +
          'CHAQUE NOTE EST SUR 100 : 0 signifie inadapté, 50 acceptable, 100 idéal. ' +
          "N'employez jamais une échelle sur 10 — la pondération et le total sont calculés " +
          'ensuite par ATLAS. Donnez chaque axe, sa valeur, sa raison et les preuves qui la ' +
          "portent : une note sans preuve citée n'a pas de valeur.",
        prompt:
          `# Objectif\n${input.objective}\n\n` +
          `# Dimensions à noter, chacune sur 100\n${dimensions}\n\n` +
          `# Candidat\n${brief}`,
      });

      if (!result.value) {
        failed++;
        this.#log.warn('notation sans sortie exploitable', { opportunityId, reason: result.reason });
        continue;
      }
      if (result.viaRepair) repaired++;

      try {
        const payload = result.value as {
          assessments: Array<{
            dimension: string;
            value: number;
            rationale: string;
            confidence: number;
            evidenceIds: string[];
          }>;
        };
        this.deps.intelligence.score({
          opportunityId,
          agentKey: input.agentKey,
          model: input.model,
          assessments: payload.assessments,
        });
        completed++;
      } catch (err) {
        failed++;
        this.#log.warn('note refusée par le service', {
          opportunityId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return this.#outcome('scoring', input, { completed, failed, repaired });
  }

  /**
   * Classe ce qui a été noté.
   *
   * Aucun appel au modèle : l'ordre découle des scores, qui sont déjà calculés.
   * Demander à un modèle de trier des nombres coûterait un appel pour un
   * résultat qu'on peut obtenir exactement.
   */
  rank(input: {
    missionId: string;
    opportunityIds: string[];
    agentKey: string;
    model: ScoringModel;
  }): StageOutcome {
    const ranked = this.deps.intelligence.rank({
      missionId: input.missionId,
      agentKey: input.agentKey,
      model: input.model,
    });
    return this.#outcome('ranking', input, { completed: ranked.length, failed: 0, repaired: 0 });
  }

  #outcome(
    stage: string,
    input: { missionId: string; opportunityIds: string[] },
    counts: { completed: number; failed: number; repaired: number },
  ): StageOutcome {
    const postcondition = validateStagePostcondition(stage, {
      repos: this.deps.repos,
      missionId: input.missionId,
      opportunityIds: input.opportunityIds,
    });
    if (!postcondition.passed) this.#log.error(postcondition.diagnostic);
    return { stage, ...counts, postcondition, succeeded: postcondition.passed };
  }

  /** Le dossier d'un candidat : ce qui est en base, rien de plus. */
  #candidateBrief(opportunityId: string): string | null {
    const opportunity = this.deps.repos.opportunities.get(opportunityId);
    if (!opportunity) return null;
    const company = this.deps.repos.companies.get(opportunity.companyId);
    if (!company) return null;

    const evidence = this.deps.repos.companies.evidenceForOpportunity(opportunityId);
    const lines = [
      `Nom : ${company.name}`,
      `Site : ${company.website ?? company.domain ?? 'inconnu'}`,
      `Lieu : ${[company.city, company.region, company.country].filter(Boolean).join(', ') || 'inconnu'}`,
      `Secteurs : ${company.industries.join(', ') || 'non renseignés'}`,
      `Rôles envisagés : ${opportunity.targetTypes.join(', ') || 'aucun'}`,
      '',
      'Preuves disponibles :',
      ...evidence.map(
        (e) =>
          `  [${e.id}] (${e.nature}) ${e.field} : ${e.claim.slice(0, 260)}` +
          (e.sourceRef ? `\n        source : ${e.sourceRef}` : `\n        base : ${e.basis ?? '—'}`),
      ),
    ];
    return lines.join('\n');
  }

  /**
   * Un appel qui doit rendre du JSON valide, avec au plus une réparation.
   *
   * La réparation ne reçoit que trois choses : l'entrée de l'unité, la sortie
   * invalide, et le schéma attendu. Pas l'historique — c'est précisément
   * l'accumulation des tentatives dans la conversation qui a fait exploser le
   * contexte de SALVAGE-001, où quatre échecs successifs ont porté l'entrée de
   * 4 447 à 13 119 jetons.
   *
   * Une seule réparation. Un modèle qui a échoué deux fois sur le même schéma
   * n'échouera pas différemment la troisième, et chaque tentative coûte le prix
   * plein.
   */
  async #structured(input: {
    missionId: string;
    taskRef: string;
    agentKey: string;
    subject: string;
    schema: Record<string, unknown>;
    system: string;
    prompt: string;
  }): Promise<{ value: unknown | null; reason: string; viaRepair: boolean }> {
    const base: LlmRequest = {
      model: this.deps.model,
      system: input.system,
      messages: [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }],
      jsonSchema: input.schema,
      maxTokens: this.deps.maxOutputTokens,
      meta: {
        missionId: input.missionId,
        taskRef: input.taskRef,
        agentKey: input.agentKey,
        purpose: `pipeline-${input.taskRef}`,
        subject: input.subject,
        evidenceCount: null,
      },
    };

    const first = await this.#attempt(base);
    if (first.value) return { ...first, viaRepair: false };

    // La réparation, une fois, et sur un contexte volontairement pauvre.
    const repair: LlmRequest = {
      ...base,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                `${input.prompt}\n\n` +
                `# Sortie précédente, invalide\n${first.raw.slice(0, 1200)}\n\n` +
                `# Motif\n${first.reason}\n\n` +
                `Rendez uniquement un objet JSON conforme au schéma. Aucun texte autour.`,
            },
          ],
        },
      ],
    };
    const second = await this.#attempt(repair);
    return { value: second.value, reason: second.reason, viaRepair: Boolean(second.value) };
  }

  async #attempt(request: LlmRequest): Promise<{ value: unknown | null; reason: string; raw: string }> {
    try {
      const response = await this.deps.provider.complete(request);
      const raw = textOf(response.content).trim();
      if (!raw) return { value: null, reason: 'réponse vide', raw: '' };

      // Le modèle encadre volontiers son JSON d'une clôture Markdown.
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start === -1 || end <= start) {
        return { value: null, reason: 'aucun objet JSON dans la réponse', raw };
      }
      return { value: JSON.parse(cleaned.slice(start, end + 1)), reason: 'ok', raw };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Un refus budgétaire n'est pas une erreur de format : le laisser
      // remonter évite qu'une réparation soit tentée après un refus, ce qui
      // coûterait exactement ce que le refus venait d'empêcher.
      if (message.includes('BUDGET') || message.includes('Plafond') || message.includes('Budget')) {
        throw err;
      }
      return { value: null, reason: message.slice(0, 200), raw: '' };
    }
  }
}
