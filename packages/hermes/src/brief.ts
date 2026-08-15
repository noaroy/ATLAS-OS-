import type { Department, Mission } from '@atlas/contracts';
import type { Logger } from '@atlas/core';
import { describeError } from '@atlas/core';
import type { LlmProvider } from '@atlas/llm';
import { textOf, totalTokens, userText } from '@atlas/llm';

/**
 * Understanding the request before doing anything about it.
 *
 * A founder writes one sentence — "find 20 distributors in Germany". A pipeline
 * needs structure: whose product, sold to whom, where, how many, and what would
 * disqualify a candidate. This is where the first becomes the second, and it is
 * the step that makes the rest of the mission reproducible.
 *
 * The department declares the shape it needs; Hermes fills it. Nothing here
 * knows what a distributor is.
 */

export interface BriefRequest {
  mission: Mission;
  department: Department;
  provider: LlmProvider;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens: number;
  signal?: AbortSignal;
  logger: Logger;
}

export interface BriefOutcome {
  brief: Record<string, unknown>;
  tokensUsed: number;
  /** True when the model could not be used and the brief came from context alone. */
  degraded: boolean;
  /**
   * D'où vient le brief.
   *
   * `declared` n'est pas une version dégradée de `extracted` : c'est le cas le
   * plus fiable, puisque rien n'a été interprété. Les distinguer permet de dire
   * au fondateur qu'ATLAS a lu son formulaire plutôt que deviné son intention.
   */
  source: 'declared' | 'extracted' | 'fallback';
}

/**
 * Turns the objective into the department's brief.
 *
 * Anything the founder supplied explicitly through the console wins over what
 * the model infers: a form field is a statement of intent, an extraction is a
 * reading of prose. Merging in that order is what stops a good form being
 * overwritten by a confident guess.
 */
export async function extractBrief(request: BriefRequest): Promise<BriefOutcome> {
  const { mission, department } = request;
  const stated = statedFields(mission);

  // ── Rien à extraire ───────────────────────────────────────────────────────
  // Quand le formulaire couvre déjà tout ce que le département exige, appeler
  // un modèle ne peut rien apporter : il reformulerait des informations que le
  // fondateur vient de fournir, et le résultat serait de toute façon écrasé par
  // les champs déclarés — qui l'emportent toujours. Payer pour cela est un pur
  // gaspillage, et c'est ce qu'ATLAS faisait à chaque mission.
  if (covers(stated, department.briefSchema)) {
    request.logger.info('brief taken from the declared fields; no model call needed', {
      mission: mission.code,
    });
    return { brief: stated, tokensUsed: 0, degraded: false, source: 'declared' };
  }

  try {
    const response = await request.provider.complete({
      model: request.model,
      system: [
        'You are Hermes, operations director of ATLAS.',
        `A founder has given you an objective that belongs to the ${department.name} department.`,
        `That department's remit: ${department.mission}`,
        '',
        'Turn the objective into the structured brief the department needs.',
        'Read what is actually written. Where the founder was explicit, use their words.',
        'Where something is genuinely unstated, infer the most reasonable value from the context',
        'and keep it conservative — a brief that overreaches sends the whole pipeline the wrong way.',
        'Never invent a client name, a country or a criterion the objective does not support.',
      ].join('\n'),
      messages: [
        userText(
          [
            `# Objective\n${mission.objective}`,
            Object.keys(mission.context).length
              ? `# What the founder specified explicitly\n${JSON.stringify(mission.context, null, 2).slice(0, 3000)}`
              : '',
            `# Target types this department handles\n${department.targetTypes
              .map((t) => `- ${t.key}: ${t.description}`)
              .join('\n')}`,
            'Produce the brief now.',
          ]
            .filter(Boolean)
            .join('\n\n'),
        ),
      ],
      maxTokens: request.maxTokens,
      effort: request.effort,
      jsonSchema: department.briefSchema,
      meta: { missionId: mission.id, purpose: 'brief' },
      signal: request.signal,
    });

    const parsed = safeJson<Record<string, unknown>>(textOf(response.content));
    if (!parsed) throw new Error('the brief did not parse as JSON');

    return {
      brief: { ...parsed, ...stated },
      tokensUsed: totalTokens(response.usage),
      degraded: false,
      source: 'extracted',
    };
  } catch (err) {
    // A failed extraction must not sink a mission whose form was already
    // complete — the console supplies the fields that actually drive the
    // pipeline, so fall back to those and say the brief is thin.
    request.logger.warn('brief extraction failed; falling back to the stated fields', {
      mission: mission.code,
      error: describeError(err),
    });
    return {
      brief: fallbackBrief(mission, department, stated),
      tokensUsed: 0,
      degraded: true,
      source: 'fallback',
    };
  }
}

/**
 * Le formulaire couvre-t-il déjà tout ce que le département exige ?
 *
 * Lit les `required` du schéma du département plutôt qu'une liste tenue à la
 * main : un département qui ajoute un champ obligatoire resserre
 * automatiquement la condition, sans qu'on ait à y penser.
 *
 * Une case vide ne compte pas comme remplie — un tableau vide ou une chaîne
 * blanche laisse la question ouverte, et c'est alors au modèle de la trancher.
 */
function covers(stated: Record<string, unknown>, schema: Record<string, unknown>): boolean {
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  if (required.length === 0) return false;

  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;

  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(stated, field)) return false;
    const value = stated[field];
    if (!filled(value)) return false;

    // Un objet imbriqué doit satisfaire ses propres champs obligatoires : un
    // `clientProfile` sans pays ne dispense pas de lire l'objectif.
    const sub = properties[field];
    if (sub?.type === 'object' && value && typeof value === 'object') {
      const subRequired = Array.isArray(sub.required) ? (sub.required as string[]) : [];
      const record = value as Record<string, unknown>;
      for (const key of subRequired) {
        if (!filled(record[key])) return false;
      }
    }
  }
  return true;
}

/**
 * Une valeur réellement renseignée, par opposition à une case laissée vide.
 *
 * Un **tableau vide compte comme rempli** : « aucun critère disqualifiant » est
 * une réponse délibérée, et `statedFields` n'aurait pas recopié la clé si le
 * fondateur ne l'avait pas fournie. La présence vaut donc intention. Traiter
 * une liste vide comme une question ouverte ferait payer une extraction pour
 * qu'un modèle re-conclue… la même liste vide.
 *
 * Une chaîne blanche, elle, ne dit rien : c'est un champ qu'on a survolé.
 */
function filled(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return true;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

/**
 * Fields the founder set explicitly, normalised into brief shape.
 *
 * Kept deliberately small: only what a console form can state without
 * interpretation. Everything else is the extractor's job.
 */
function statedFields(mission: Mission): Record<string, unknown> {
  const context = mission.context as Record<string, unknown>;
  const stated: Record<string, unknown> = {};

  // Les deux formes sont acceptées : une mission antérieure porte un rôle
  // unique, une mission actuelle en porte plusieurs. Normaliser à l'entrée
  // évite d'avoir deux notions concurrentes dans le reste du système.
  if (Array.isArray(context.targetTypes)) {
    stated.targetTypes = asStringArray(context.targetTypes);
  } else if (typeof context.targetType === 'string') {
    stated.targetTypes = [context.targetType];
  }
  if (typeof context.desiredCount === 'number') stated.desiredCount = context.desiredCount;

  const markets = context.markets as Record<string, unknown> | undefined;
  if (markets && typeof markets === 'object') {
    stated.markets = {
      countries: asStringArray(markets.countries),
      industries: asStringArray(markets.industries),
      regions: asStringArray(markets.regions),
    };
  }
  if (context.clientProfile && typeof context.clientProfile === 'object') {
    stated.clientProfile = context.clientProfile;
  }
  for (const key of ['mustHave', 'niceToHave', 'exclusions'] as const) {
    if (Array.isArray(context[key])) stated[key] = asStringArray(context[key]);
  }
  return stated;
}

function fallbackBrief(
  mission: Mission,
  department: Department,
  stated: Record<string, unknown>,
): Record<string, unknown> {
  return {
    clientProfile: {
      name: 'the client',
      country: 'unspecified',
      industry: 'unspecified',
      offering: mission.objective.slice(0, 600),
      differentiators: [],
    },
    targetTypes: department.targetTypes[0] ? [department.targetTypes[0].key] : [],
    markets: { countries: [], industries: [], regions: [] },
    desiredCount: 10,
    mustHave: [],
    niceToHave: [],
    exclusions: [],
    ...stated,
  };
}

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

function safeJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      return null;
    }
  }
}
