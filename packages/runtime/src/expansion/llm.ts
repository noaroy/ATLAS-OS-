import type { AtlasConfig } from '@atlas/core';
import { textOf, extractJson, costOfCall, estimateInputTokens, worstCaseCostUsd, type LlmProvider, type LlmRequest } from '@atlas/llm';
import type { RelationshipType, SeedProfile } from './types.ts';

/**
 * Le modèle, à deux endroits seulement — et jamais pour inventer.
 *
 * 1. Le profil d'activité d'une graine : ce que son site dit qu'elle fait,
 *    ramené à des mots de métier et des termes de recherche. Une lecture,
 *    pas une opinion.
 * 2. La confirmation d'une relation *déduite* (semblable, concurrent) sur
 *    des extraits : le modèle dit si l'extrait soutient la relation, et à
 *    quel point. Il ne crée pas de relation : il note celles que la recherche
 *    a rapportées, avec leur preuve.
 *
 * Chaque appel est réservé *avant* de partir : son coût maximal, calculé sur
 * la requête réelle au tarif connu du modèle, doit tenir sous le plafond du
 * tour (`maxAiCostUsd`) et sous le budget commercial du jour. Un tarif inconnu
 * ne se réserve pas — l'appel n'a pas lieu. Après coup, le coût réel est lu
 * sur l'usage rendu ; s'il ne peut l'être, c'est la réservation qui compte.
 */

/** Accorde ou refuse une réservation ; `null` = tarif inconnu. */
export type AiReservation = (boundUsd: number | null) => boolean;

/**
 * Le coût maximal d'un appel, avant de le lancer — `null` si le tarif du
 * modèle est inconnu.
 *
 * Sortie pleine, et entrée comptée à trois caractères par jeton plutôt que
 * quatre : le français et le JSON se découpent plus serré, et une borne qui
 * sous-estime laisse passer ce qu'elle devait arrêter.
 */
export function aiCallBoundUsd(request: LlmRequest): number | null {
  return worstCaseCostUsd(request.model, Math.ceil((estimateInputTokens(request) * 4) / 3), request.maxTokens);
}

export interface ActivityProfile {
  activity: string | null;
  sector: string | null;
  searchTerms: string[];
  country: string | null;
}

export interface RelationshipOpinion {
  key: string;
  relationship: RelationshipType | 'NONE';
  relevant: boolean;
  confidence: number;
  reason: string;
}

export interface AiCallOutcome<T> {
  value: T | null;
  costUsd: number;
  ok: boolean;
  error: string | null;
  /** Faux quand la réservation a été refusée : aucun appel n'est parti. */
  called: boolean;
}

const ACTIVITY_SCHEMA = {
  type: 'object',
  properties: {
    activity: { type: 'string', description: 'ce que l’entreprise fait, en une phrase, dans la langue de la page' },
    sector: { type: 'string', description: 'le secteur en deux ou trois mots' },
    search_terms: { type: 'array', items: { type: 'string' }, description: 'quatre à six termes de métier courts, dans la langue du marché, pour trouver des entreprises semblables' },
    country: { type: ['string', 'null'], description: 'le pays du siège s’il est écrit sur la page, sinon null' },
  },
  required: ['activity', 'sector', 'search_terms', 'country'],
  additionalProperties: false,
} as const;

const OPINION_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          relationship: { type: 'string', enum: ['COMPETITOR', 'SIMILAR_COMPANY', 'DISTRIBUTOR', 'RESELLER', 'COMPLEMENTARY_VENDOR', 'LIKELY_CUSTOMER', 'NONE'] },
          relevant: { type: 'boolean' },
          confidence: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['key', 'relationship', 'relevant', 'confidence', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['candidates'],
  additionalProperties: false,
} as const;

function costOf(response: { usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }; model: string }, request: LlmRequest, reservedUsd: number): number {
  // Tarif du modèle servi inconnu : la réservation, jamais zéro — un plafond
  // aveugle n'est pas un plafond.
  return costOfCall(response.usage, response.model || request.model) ?? reservedUsd;
}

/** Réserve, appelle, et rend le coût — ou rend sans appeler si la réservation est refusée. */
async function reservedCall(provider: LlmProvider, request: LlmRequest, reserve: AiReservation): Promise<{ response: Awaited<ReturnType<LlmProvider['complete']>>; costUsd: number } | { refused: true } | { error: string }> {
  const bound = aiCallBoundUsd(request);
  // `reserve(null)` refuse toujours, et consigne pourquoi : tarif inconnu.
  if (!reserve(bound) || bound === null) return { refused: true };
  try {
    const response = await provider.complete(request);
    return { response, costUsd: costOf(response, request, bound) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const REFUSED = { value: null, costUsd: 0, ok: false, error: 'réservation IA refusée : plafond ou tarif inconnu', called: false } as const;

const SYSTEM = 'Tu es un analyste commercial rigoureux. Tu ne réponds qu’à partir du texte fourni ; tu n’inventes ni entreprise, ni relation, ni pays. Réponds en JSON strict.';

export async function profileActivity(provider: LlmProvider, config: AtlasConfig, seed: SeedProfile, meta: { runId: string; missionId?: string | null }, reserve: AiReservation): Promise<AiCallOutcome<ActivityProfile>> {
  const text = (seed.homepageText ?? seed.activity ?? '').slice(0, 3_500);
  if (!text.trim()) return { value: null, costUsd: 0, ok: false, error: 'aucun texte à lire', called: false };
  const prompt = `# Entreprise\n${seed.entity.name}\nSite : ${seed.entity.website ?? '(inconnu)'}\n\n# Ce que sa page d’accueil dit\n${text}\n\nDonne son activité, son secteur, quatre à six termes de recherche de métier (courts, dans la langue de la page), et le pays du siège seulement s’il est écrit.`;
  const outcome = await reservedCall(provider, {
    model: config.llm.agentModel, system: SYSTEM, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    jsonSchema: ACTIVITY_SCHEMA as unknown as Record<string, unknown>, maxTokens: 400,
    meta: { purpose: 'prospect-expansion', taskRef: 'expansion-profile', subject: seed.entity.domain ?? seed.entity.name, missionId: meta.missionId ?? null, evidenceCount: null },
  }, reserve);
  if ('refused' in outcome) return REFUSED;
  if ('error' in outcome) return { value: null, costUsd: 0, ok: false, error: outcome.error, called: true };
  const parsed = extractJson(textOf(outcome.response.content)) ?? {};
  const terms = Array.isArray(parsed.search_terms) ? parsed.search_terms.map(String).map((t) => t.trim()).filter((t) => t.length >= 3).slice(0, 6) : [];
  return {
    value: {
      activity: typeof parsed.activity === 'string' ? parsed.activity.slice(0, 300) : null,
      sector: typeof parsed.sector === 'string' ? parsed.sector.slice(0, 80) : null,
      searchTerms: terms,
      country: typeof parsed.country === 'string' && parsed.country.trim() ? parsed.country.trim() : null,
    },
    costUsd: outcome.costUsd, ok: true, error: null, called: true,
  };
}

export async function confirmRelationships(
  provider: LlmProvider,
  config: AtlasConfig,
  seed: SeedProfile,
  candidates: Array<{ key: string; name: string; snippet: string | null; proposed: RelationshipType }>,
  meta: { runId: string; missionId?: string | null },
  reserve: AiReservation,
): Promise<AiCallOutcome<RelationshipOpinion[]>> {
  if (candidates.length === 0) return { value: [], costUsd: 0, ok: true, error: null, called: false };
  const list = candidates.map((c, i) => `${i + 1}. key=${c.key} · ${c.name} · relation proposée : ${c.proposed}\n   extrait : ${(c.snippet ?? '(aucun)').replace(/\s+/g, ' ').slice(0, 320)}`).join('\n');
  const prompt = `# Entreprise de référence\n${seed.entity.name} — ${seed.activity ?? (seed.keywords.join(', ') || '(activité inconnue)')}\n\n# Candidats trouvés par la recherche\n${list}\n\nPour chaque candidat, dis si l’extrait soutient une relation commerciale avec l’entreprise de référence (COMPETITOR, SIMILAR_COMPANY, DISTRIBUTOR, RESELLER, COMPLEMENTARY_VENDOR, LIKELY_CUSTOMER) ou NONE, s’il est pertinent comme entreprise du même écosystème (relevant), une confiance de 0 à 1 fondée uniquement sur l’extrait, et la raison en une phrase. Un annuaire, un article, une page sans entreprise identifiable : NONE, relevant=false.`;
  const outcome = await reservedCall(provider, {
    model: config.llm.agentModel, system: SYSTEM, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    jsonSchema: OPINION_SCHEMA as unknown as Record<string, unknown>, maxTokens: Math.min(1_500, 120 * candidates.length + 200),
    meta: { purpose: 'prospect-expansion', taskRef: 'expansion-confirm', subject: seed.entity.domain ?? seed.entity.name, missionId: meta.missionId ?? null, evidenceCount: candidates.length },
  }, reserve);
  if ('refused' in outcome) return REFUSED;
  if ('error' in outcome) return { value: null, costUsd: 0, ok: false, error: outcome.error, called: true };
  const parsed = extractJson(textOf(outcome.response.content)) ?? {};
  const raw = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  const known = new Set(candidates.map((c) => c.key));
  const opinions: RelationshipOpinion[] = raw
    .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === 'object')
    .map((o) => ({
      key: String(o.key ?? ''),
      relationship: (typeof o.relationship === 'string' ? o.relationship : 'NONE') as RelationshipType | 'NONE',
      relevant: o.relevant === true,
      confidence: Math.max(0, Math.min(1, Number(o.confidence ?? 0))),
      reason: String(o.reason ?? '').slice(0, 200),
    }))
    .filter((o) => known.has(o.key));
  return { value: opinions, costUsd: outcome.costUsd, ok: true, error: null, called: true };
}
