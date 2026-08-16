import type { BudgetConfig } from '@atlas/core';
import { AtlasError, nowIso } from '@atlas/core';
import { costOfCall, pricingFor, worstCaseCostUsd } from './pricing.ts';
import type { LlmRequest, LlmResponse, LlmUsage } from './types.ts';

/**
 * La sûreté économique d'ATLAS.
 *
 * LIVE #001 a coûté 9,15 $ pour zéro résultat, et le plafond de 400 000 jetons
 * n'a rien empêché : il n'était consulté qu'*entre* les étapes. Une étape déjà
 * lancée allait jusqu'au bout, et celle qui s'est trouvée sans entrée a
 * improvisé pendant douze minutes — 1,37 million de jetons, presque quatre fois
 * le budget total de la mission, dans une seule étape.
 *
 * Le registre corrige cela en déplaçant la décision là où la dépense a lieu :
 * chaque appel est autorisé avant de partir, et comptabilisé dès qu'il revient.
 * Un plafond qu'on ne vérifie qu'après coup n'est pas un plafond, c'est un
 * constat.
 *
 * Quatre niveaux, du plus large au plus fin :
 *
 *   MISSION   jetons et dollars, tout compris
 *     ↓
 *   ÉTAPE     jetons et nombre d'appels — empêche qu'une étape mange la mission
 *     ↓
 *   APPEL     plafond de sortie, refusé s'il ne tient pas dans ce qui reste
 *     ↓
 *   BOUCLE    coupe-circuit sur répétition anormale
 *
 * L'autorisation raisonne sur le pire cas — entrée estimée plus sortie pleine.
 * Un plafond calculé sur une consommation moyenne serait dépassé une fois sur
 * deux, ce qui n'est pas un plafond non plus.
 */

/**
 * Les plafonds, tels que le déploiement les configure.
 *
 * Alias de `BudgetConfig` : le budget est une décision de configuration, pas
 * une propriété du fournisseur d'inférence. Le même jeu de plafonds
 * s'appliquera tel quel à un modèle local.
 */
export type BudgetLimits = BudgetConfig;

export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  maxMissionTokens: 400_000,
  maxMissionCostUsd: 5,
  maxStepTokens: 120_000,
  maxCallsPerStep: 12,
  maxOutputTokensPerCall: 16_000,
  circuitBreakerFailures: 3,
  minViableOutputTokens: 512,
};

/**
 * Combien d'appels une étape mérite, vu le travail réellement en jeu.
 *
 * Le plafond était forfaitaire — douze appels par étape, que la mission vise
 * trois candidats ou trois cents. La reprise de LIVE-001 l'a montré par
 * l'absurde : enrichir **trois** candidats a pris onze appels, dont l'entrée
 * croissait de 5 748 à 14 406 jetons parce que chaque appel renvoie tout le
 * contexte accumulé. À lui seul cet enrichissement a coûté 0,116 $ — plus du
 * quart de l'enveloppe du pilote, pour documenter trois entreprises.
 *
 * Deux appels par candidat : analyser, puis conclure. Un plancher pour les
 * étapes qui n'itèrent sur rien. Et jamais plus que le plafond configuré : la
 * proportion resserre, elle n'élargit pas.
 *
 * Zéro candidat signifie que la découverte n'a pas encore tourné. Elle a besoin
 * de son plafond plein pour aller en chercher, et la proportionner à un compte
 * encore vide la condamnerait avant qu'elle commence.
 *
 * Fonction pure, et exportée pour cela : c'est une règle de calibrage, elle doit
 * pouvoir être vérifiée sans monter une mission entière.
 */
export function proportionalCallsPerStep(candidates: number, maxCallsPerStep: number): number {
  if (maxCallsPerStep <= 0) return 0;
  if (candidates <= 0) return maxCallsPerStep;
  return Math.min(maxCallsPerStep, Math.max(4, candidates * 2));
}

/** Une ligne de comptabilité : un appel, ce qu'il a coûté, ce qu'il servait. */
export interface LlmCallRecord {
  missionId: string | null;
  taskRef: string | null;
  agentKey: string | null;
  purpose: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  durationMs: number;
  ok: boolean;
  /** Message d'erreur, jamais de secret : rien de la requête n'est recopié. */
  error: string | null;
  toolCalls: number;
  createdAt: string;
}

/** Où les lignes sont écrites. Une fonction, pour que le registre reste testable. */
export type LlmTelemetrySink = (record: LlmCallRecord) => void;

export interface MissionSpend {
  missionId: string;
  limits: BudgetLimits;
  tokens: number;
  costUsd: number;
  calls: number;
  consecutiveFailures: number;
  /** Consommation par étape, clé = ref de l'étape. */
  steps: Map<string, { tokens: number; costUsd: number; calls: number }>;
}

export interface BudgetSnapshot {
  limits: BudgetLimits;
  tokens: number;
  costUsd: number;
  calls: number;
  remainingTokens: number | null;
  remainingCostUsd: number | null;
  steps: Array<{ taskRef: string; tokens: number; costUsd: number; calls: number }>;
}

/**
 * Le registre. Une instance pour tout le déploiement, une comptabilité par
 * mission ouverte.
 *
 * Une mission dont le périmètre n'a pas été ouvert n'est pas plafonnée : c'est
 * délibéré, pour que les appels hors mission (santé, outillage) ne dépendent
 * pas d'un budget qui n'a pas de sens pour eux. Tout ce qui coûte vraiment
 * passe par une mission, et l'orchestrateur en ouvre le périmètre.
 */
export class BudgetLedger {
  #missions = new Map<string, MissionSpend>();
  #sink: LlmTelemetrySink;

  constructor(sink: LlmTelemetrySink = () => {}) {
    this.#sink = sink;
  }

  /** Ouvre la comptabilité d'une mission avec ses plafonds. */
  open(missionId: string, limits: BudgetLimits): void {
    this.#missions.set(missionId, {
      missionId,
      limits,
      tokens: 0,
      costUsd: 0,
      calls: 0,
      consecutiveFailures: 0,
      steps: new Map(),
    });
  }

  /**
   * Réajuste les plafonds d'une mission déjà ouverte, sans toucher au dépensé.
   *
   * Certains plafonds ne peuvent pas être connus au démarrage. Le nombre
   * d'appels que mérite une étape dépend du nombre de candidats, et il n'y en a
   * aucun avant que la découverte ait tourné : figer la limite à l'ouverture
   * revient à la calculer sur un compte vide, donc à la laisser forfaitaire.
   *
   * Ce qui est déjà consommé n'est jamais remis à zéro. Un réajustement qui
   * effacerait la comptabilité serait un moyen de contourner le budget en
   * changeant simplement d'avis.
   */
  retune(missionId: string, limits: BudgetLimits): void {
    const spend = this.#missions.get(missionId);
    if (!spend) return;
    spend.limits = limits;
  }

  close(missionId: string): BudgetSnapshot | null {
    const snapshot = this.snapshot(missionId);
    this.#missions.delete(missionId);
    return snapshot;
  }

  snapshot(missionId: string): BudgetSnapshot | null {
    const spend = this.#missions.get(missionId);
    if (!spend) return null;
    const { limits } = spend;
    return {
      limits,
      tokens: spend.tokens,
      costUsd: round6(spend.costUsd),
      calls: spend.calls,
      remainingTokens:
        limits.maxMissionTokens > 0 ? Math.max(0, limits.maxMissionTokens - spend.tokens) : null,
      remainingCostUsd:
        limits.maxMissionCostUsd > 0
          ? round6(Math.max(0, limits.maxMissionCostUsd - spend.costUsd))
          : null,
      steps: [...spend.steps.entries()].map(([taskRef, s]) => ({
        taskRef,
        tokens: s.tokens,
        costUsd: round6(s.costUsd),
        calls: s.calls,
      })),
    };
  }

  /**
   * Combien de jetons de sortie le budget restant permet réellement de payer.
   *
   * Rend `null` quand la question ne se pose pas — pas de plafond en dollars,
   * ou modèle sans tarif connu.
   *
   * C'est ici que le budget cesse d'être une validation pour devenir une
   * contrainte. LIVE #002 l'a montré par l'absurde : sous un plafond de 1,00 $,
   * un appel `opus-5` demandant 16 000 jetons de sortie coûtait au pire 1,22 $
   * et était refusé — non pas une fois, mais *toujours*, quel que soit le solde.
   * Hermès était devenu structurellement inutilisable. La bonne réponse n'est
   * pas de relever le plafond : c'est de demander une réponse plus courte.
   */
  affordableOutputTokens(request: LlmRequest): number | null {
    const limits = this.#limitsFor(request);
    if (limits.maxMissionCostUsd <= 0) return null;

    const pricing = pricingFor(request.model);
    if (!pricing) return null;

    const spend = request.meta?.missionId ? this.#missions.get(request.meta.missionId) : undefined;
    const spent = spend?.costUsd ?? 0;
    const remaining = limits.maxMissionCostUsd - spent;
    if (remaining <= 0) return 0;

    // L'entrée est due quoi qu'il arrive : elle est payée avant que le premier
    // jeton de sortie n'existe. Ce qui reste après elle est le seul budget
    // réellement disponible pour la réponse.
    const inputCost = (estimateInputTokens(request) / 1_000_000) * pricing.input;
    const forOutput = remaining - inputCost;
    if (forOutput <= 0) return 0;

    return Math.floor((forOutput / pricing.output) * 1_000_000);
  }

  /**
   * Le plafond de sortie applicable à cet appel.
   *
   * Le plus petit de trois nombres :
   *   • ce que l'appelant demande — le besoin propre à son rôle ;
   *   • le plafond global par appel ;
   *   • ce que le budget restant permet de payer.
   *
   * Appliqué même hors mission : une sortie non bornée est un risque en soi.
   */
  cappedMaxTokens(request: LlmRequest): number {
    const limits = this.#limitsFor(request);

    let cap = request.maxTokens;
    if (limits.maxOutputTokensPerCall > 0) {
      cap = Math.min(cap, limits.maxOutputTokensPerCall);
    }
    const affordable = this.affordableOutputTokens(request);
    if (affordable !== null) {
      cap = Math.min(cap, affordable);
    }
    return Math.max(0, cap);
  }

  /**
   * Autorise — ou refuse — un appel avant qu'il parte.
   *
   * Lève `BUDGET_EXCEEDED`, non réessayable : réessayer coûterait précisément
   * ce que le refus vient d'éviter.
   */
  authorise(request: LlmRequest): void {
    const missionId = request.meta?.missionId;
    if (!missionId) return;
    const spend = this.#missions.get(missionId);
    if (!spend) return;

    const { limits } = spend;

    if (
      limits.circuitBreakerFailures > 0 &&
      spend.consecutiveFailures >= limits.circuitBreakerFailures
    ) {
      throw refuse(
        `Coupe-circuit : ${spend.consecutiveFailures} appels consécutifs ont échoué de suite. ` +
          "ATLAS cesse d'appeler le modèle pour cette mission plutôt que de répéter une panne à vos frais.",
        {
          guard: 'circuit-breaker',
          current: spend.consecutiveFailures,
          limit: limits.circuitBreakerFailures,
          projected: 1,
          remaining: 0,
          unit: 'calls',
          reason: `${spend.consecutiveFailures} échecs consécutifs >= ${limits.circuitBreakerFailures}`,
        },
      );
    }

    const estimatedInput = estimateInputTokens(request);
    const plannedOutput = this.cappedMaxTokens(request);
    const worstCaseTokens = estimatedInput + plannedOutput;

    // ── Sortie devenue trop courte pour être utile ──────────────────────────
    // Le budget adaptatif rétrécit la réponse tant qu'il le peut. En dessous
    // du seuil, il ne reste plus de quoi produire un résultat exploitable :
    // refuser coûte zéro, payer une réponse coupée en deux coûte le prix fort
    // pour rien.
    //
    // Le seuil ne s'applique que si c'est *le budget* qui a rétréci la sortie.
    // Un appelant qui demande délibérément une réponse courte — un classement,
    // un verdict d'un mot — a le droit de l'obtenir ; le lui refuser au nom
    // d'un plafond qu'il ne touche pas n'aurait aucun sens.
    const affordable = this.affordableOutputTokens(request);
    if (
      limits.minViableOutputTokens > 0 &&
      affordable !== null &&
      affordable < limits.minViableOutputTokens &&
      plannedOutput < limits.minViableOutputTokens
    ) {
      throw refuse(
        `Budget insuffisant pour une réponse utile : il ne reste de quoi produire que ` +
          `${fmt(affordable)} jetons de sortie, or ${fmt(limits.minViableOutputTokens)} sont ` +
          `nécessaires au minimum. Dépensé ${usd(spend.costUsd)} sur ${usd(limits.maxMissionCostUsd)}. ` +
          "L'appel n'est pas lancé.",
        {
          guard: 'min-viable-output',
          current: affordable,
          limit: limits.minViableOutputTokens,
          projected: plannedOutput,
          remaining: affordable,
          unit: 'tokens',
          reason: `${fmt(affordable)} jetons finançables < ${fmt(limits.minViableOutputTokens)} minimum`,
        },
      );
    }

    if (limits.maxMissionTokens > 0 && spend.tokens + worstCaseTokens > limits.maxMissionTokens) {
      throw refuse(
        `Budget de mission insuffisant : ${fmt(spend.tokens)} jetons déjà consommés sur ` +
          `${fmt(limits.maxMissionTokens)}, et cet appel peut en coûter ${fmt(worstCaseTokens)}. ` +
          "L'appel n'est pas lancé.",
        {
          guard: 'mission-tokens',
          current: spend.tokens,
          limit: limits.maxMissionTokens,
          projected: worstCaseTokens,
          remaining: limits.maxMissionTokens - spend.tokens,
          unit: 'tokens',
          reason:
            `${fmt(spend.tokens)} + ${fmt(worstCaseTokens)} > ${fmt(limits.maxMissionTokens)} jetons de mission`,
        },
      );
    }

    if (limits.maxMissionCostUsd > 0) {
      const worstCost = worstCaseCostUsd(request.model, estimatedInput, plannedOutput);
      // Un modèle sans tarif connu ne peut pas être plafonné en dollars ; le
      // plafond en jetons reste, lui, toujours applicable.
      if (worstCost !== null && spend.costUsd + worstCost > limits.maxMissionCostUsd) {
        throw refuse(
          `Plafond de dépense atteint : ${usd(spend.costUsd)} déjà dépensés sur ` +
            `${usd(limits.maxMissionCostUsd)}, et cet appel peut coûter ${usd(worstCost)}. ` +
            "L'appel n'est pas lancé.",
          {
            guard: 'mission-cost',
            current: spend.costUsd,
            limit: limits.maxMissionCostUsd,
            projected: worstCost,
            remaining: limits.maxMissionCostUsd - spend.costUsd,
            unit: 'usd',
            reason:
              `${usd(spend.costUsd)} + ${usd(worstCost)} > ${usd(limits.maxMissionCostUsd)} de mission`,
          },
        );
      }
    }

    const stepKey = request.meta?.taskRef;
    if (stepKey) {
      const step = spend.steps.get(stepKey);
      if (step) {
        if (limits.maxCallsPerStep > 0 && step.calls >= limits.maxCallsPerStep) {
          throw refuse(
            `L'étape « ${stepKey} » a déjà passé ${step.calls} appels au modèle, sa limite. ` +
              'Une étape qui boucle est arrêtée ici, pas quand la mission est vide.',
            {
              guard: 'step-calls',
              current: step.calls,
              limit: limits.maxCallsPerStep,
              projected: 1,
              remaining: 0,
              unit: 'calls',
              reason: `${step.calls} appels >= ${limits.maxCallsPerStep} pour l'étape « ${stepKey} »`,
            },
          );
        }
        if (limits.maxStepTokens > 0 && step.tokens + worstCaseTokens > limits.maxStepTokens) {
          throw refuse(
            `L'étape « ${stepKey} » a consommé ${fmt(step.tokens)} jetons sur ` +
              `${fmt(limits.maxStepTokens)} : elle ne peut pas absorber le budget de la mission. ` +
              `Cet appel en demanderait ${fmt(worstCaseTokens)} au pire.`,
            {
              guard: 'step-tokens',
              current: step.tokens,
              limit: limits.maxStepTokens,
              projected: worstCaseTokens,
              remaining: limits.maxStepTokens - step.tokens,
              unit: 'tokens',
              reason:
                `${fmt(step.tokens)} + ${fmt(worstCaseTokens)} > ${fmt(limits.maxStepTokens)} jetons ` +
                `pour l'étape « ${stepKey} »`,
            },
          );
        }
      }
    }
  }

  /** Enregistre un appel réussi et recalcule immédiatement ce qui reste. */
  record(
    request: LlmRequest,
    response: LlmResponse,
    context: { provider: string; durationMs: number; toolCalls: number },
  ): LlmCallRecord {
    const costUsd = costOfCall(response.usage, response.model || request.model);
    const record: LlmCallRecord = {
      missionId: request.meta?.missionId ?? null,
      taskRef: request.meta?.taskRef ?? null,
      agentKey: request.meta?.agentKey ?? null,
      purpose: request.meta?.purpose ?? 'unspecified',
      provider: context.provider,
      model: response.model || request.model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cacheReadTokens: response.usage.cacheReadTokens,
      cacheWriteTokens: response.usage.cacheWriteTokens,
      costUsd,
      durationMs: context.durationMs,
      ok: true,
      error: null,
      toolCalls: context.toolCalls,
      createdAt: nowIso(),
    };
    this.#apply(record, totalOf(response.usage), costUsd ?? 0, true);
    return record;
  }

  /**
   * Enregistre un appel qui a échoué.
   *
   * Un échec coûte souvent quand même — un rejet après traitement partiel est
   * facturé. Et surtout il alimente le coupe-circuit : c'est la répétition qui
   * est chère, pas l'échec isolé.
   */
  recordFailure(
    request: LlmRequest,
    error: string,
    context: { provider: string; durationMs: number; usage?: LlmUsage },
  ): LlmCallRecord {
    const usage = context.usage ?? EMPTY_USAGE;
    const costUsd = costOfCall(usage, request.model);
    const record: LlmCallRecord = {
      missionId: request.meta?.missionId ?? null,
      taskRef: request.meta?.taskRef ?? null,
      agentKey: request.meta?.agentKey ?? null,
      purpose: request.meta?.purpose ?? 'unspecified',
      provider: context.provider,
      model: request.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costUsd,
      durationMs: context.durationMs,
      ok: false,
      error: error.slice(0, 500),
      toolCalls: 0,
      createdAt: nowIso(),
    };
    this.#apply(record, totalOf(usage), costUsd ?? 0, false);
    return record;
  }

  #apply(record: LlmCallRecord, tokens: number, costUsd: number, ok: boolean): void {
    this.#sink(record);

    if (!record.missionId) return;
    const spend = this.#missions.get(record.missionId);
    if (!spend) return;

    spend.tokens += tokens;
    spend.costUsd += costUsd;
    spend.calls += 1;
    spend.consecutiveFailures = ok ? 0 : spend.consecutiveFailures + 1;

    const stepKey = record.taskRef;
    if (!stepKey) return;
    const step = spend.steps.get(stepKey) ?? { tokens: 0, costUsd: 0, calls: 0 };
    step.tokens += tokens;
    step.costUsd += costUsd;
    step.calls += 1;
    spend.steps.set(stepKey, step);
  }

  #limitsFor(request: LlmRequest): BudgetLimits {
    const missionId = request.meta?.missionId;
    const spend = missionId ? this.#missions.get(missionId) : undefined;
    return spend?.limits ?? DEFAULT_BUDGET_LIMITS;
  }
}

/**
 * Estime les jetons d'entrée d'une requête.
 *
 * Quatre caractères par jeton : approximation grossière et assumée. Elle sert
 * uniquement à décider si un appel *peut* tenir dans ce qui reste — et une
 * estimation prudente qui refuse un appel de trop vaut mieux qu'une mesure
 * exacte obtenue après l'avoir payé.
 */
export function estimateInputTokens(request: LlmRequest): number {
  let chars = request.system.length;
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === 'text') chars += block.text.length;
      else if (block.type === 'tool_result') chars += block.content.length;
      else if (block.type === 'tool_use') chars += JSON.stringify(block.input).length;
    }
  }
  for (const tool of request.tools ?? []) {
    chars += tool.name.length + tool.description.length + JSON.stringify(tool.inputSchema).length;
  }
  if (request.jsonSchema) chars += JSON.stringify(request.jsonSchema).length;
  return Math.ceil(chars / 4);
}

const EMPTY_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

const totalOf = (usage: LlmUsage): number => usage.inputTokens + usage.outputTokens;

/**
 * Quelle règle a refusé, avec ses nombres.
 *
 * « refused by the budget » a coûté une enquête entière : le message ne disait
 * ni quelle garde s'était déclenchée, ni sur quelle valeur. On a cherché du
 * côté du plafond en dollars — 0,0652 $ sur 0,40 $ — alors que le refus venait
 * du plafond de l'étape, dérivé implicitement du budget en jetons.
 *
 * Un refus doit se lire « X > Y », pas « quelque chose a dit non ».
 */
export type BudgetGuard =
  | 'circuit-breaker'
  | 'min-viable-output'
  | 'mission-tokens'
  | 'mission-cost'
  | 'step-calls'
  | 'step-tokens';

export interface BudgetRefusal {
  guard: BudgetGuard;
  /** Ce qui est déjà consommé, dans l'unité de la garde. */
  current: number;
  /** La limite qui s'applique. */
  limit: number;
  /** Ce que cet appel ajouterait au pire. */
  projected: number;
  /** Ce qui resterait disponible avant l'appel. */
  remaining: number;
  unit: 'tokens' | 'usd' | 'calls';
  reason: string;
}

/** Une erreur budgétaire qui porte ses chiffres, pas seulement sa phrase. */
export interface BudgetError extends AtlasError {
  budget?: BudgetRefusal;
}

const refuse = (message: string, detail?: BudgetRefusal): AtlasError => {
  const error = new AtlasError('BUDGET_EXCEEDED', message, {
    retryable: false,
  }) as BudgetError;
  if (detail) error.budget = detail;
  return error;
};

const fmt = (n: number): string => Math.round(n).toLocaleString('fr-FR');
const usd = (n: number): string => `${n.toFixed(4)} $`;
const round6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;
