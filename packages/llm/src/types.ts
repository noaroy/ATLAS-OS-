/**
 * Provider-neutral inference contract.
 *
 * The orchestrator and agents speak only these types, which is what allows
 * ATLAS to run identically against the Anthropic API or the deterministic
 * simulation provider — and to gain another provider later without touching
 * a single agent.
 */

export type LlmContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: LlmContent[];
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. */
  inputSchema: Record<string, unknown>;
}

export type LlmEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Provider-hosted tools. Requesting these gives an agent real web research
 * without ATLAS having to own a crawler; the simulation provider ignores them
 * and falls back to its own placeholder findings.
 */
export type LlmServerTool = 'web_search' | 'web_fetch';

/**
 * À quoi sert cet appel, et pour le compte de qui.
 *
 * Sans cela un appel LLM est anonyme : on connaît son coût mais pas ce qu'il
 * achetait. C'est exactement ce qui a empêché LIVE #001 de dire quelle étape
 * avait brûlé 1,37 million de jetons. Provider-neutre par construction — les
 * providers ne s'en servent pas, seule la comptabilité les lit.
 */
export interface LlmCallMeta {
  missionId?: string | null;
  /** Ref de l'étape de mission, quand l'appel en sert une. */
  taskRef?: string | null;
  agentKey?: string | null;
  /** Nature de l'appel : `plan`, `brief`, `agent-step`, `discovery`… */
  purpose: string;
  /**
   * Sur quoi porte l'appel : un candidat, une entreprise, une unité de travail.
   *
   * Sans lui, la comptabilité s'arrête à l'étape. « L'enrichissement a coûté
   * 0,116 $ » ne dit pas si dix candidats ont coûté un centime chacun ou si
   * l'un d'eux en a mangé neuf. C'est pourtant la seule décomposition qui
   * permette de décider quoi arrêter.
   */
  subject?: string | null;
  /**
   * Combien de preuves ont été versées au contexte de cet appel.
   *
   * Absent quand la notion n'a pas de sens pour l'appel — un plan n'en injecte
   * aucune. `0` signifierait « aucune preuve », ce qui est une mesure ; ne pas
   * savoir n'en est pas une.
   */
  evidenceCount?: number | null;
}

export interface LlmRequest {
  model: string;
  system: string;
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
  /** Provider-executed tools; results never round-trip through ATLAS. */
  serverTools?: LlmServerTool[];
  /**
   * Combien de fois chaque outil côté fournisseur peut servir.
   *
   * L'effort doit suivre l'objectif. Une micro-mission qui cherche deux
   * partenaires n'a pas besoin d'explorer autant qu'une qui en cherche vingt,
   * et la différence se paie en jetons d'entrée : chaque page rapportée entre
   * dans le contexte, et y reste pour tous les tours suivants.
   */
  serverToolLimits?: { webSearch?: number; webFetch?: number };
  maxTokens: number;
  effort?: LlmEffort;
  /**
   * Met le prompt système en cache côté fournisseur.
   *
   * À réserver aux blocs réellement stables — consignes d'un rôle, règles de
   * provenance, définition d'un département. Un prompt qui change à chaque
   * appel paierait l'écriture du cache sans jamais la relire, ce qui coûte plus
   * cher que de ne rien mettre en cache.
   *
   * Le gain se lit dans `usage.cacheReadTokens`, jamais supposé.
   */
  cacheSystemPrompt?: boolean;
  /**
   * Constrains the reply to a JSON schema. Mutually exclusive with `tools` —
   * planning is a structured-output call, execution is a tool-use call.
   */
  jsonSchema?: Record<string, unknown>;
  /**
   * Domain values a simulated provider may use, keyed by field name.
   *
   * Simulation has to produce input a real tool will accept — an invented
   * identifier fails validation and the run proves nothing. Rather than teach
   * the LLM layer about opportunities or departments, the caller supplies
   * plausible values for named fields and this layer stays domain-free.
   * Live providers ignore it entirely.
   */
  simulationHints?: Record<string, unknown[]>;
  /** Rattachement comptable de l'appel. Ignoré par les providers. */
  meta?: LlmCallMeta;
  signal?: AbortSignal;
}

export type LlmStopReason =
  | 'end_turn'
  | 'tool_use'
  /** A provider-side tool loop hit its iteration cap; resend to continue. */
  | 'pause_turn'
  | 'max_tokens'
  | 'refusal'
  | 'other';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /**
   * Jetons écrits dans le cache de prompt.
   *
   * Facturés plus cher qu'une entrée ordinaire et amortis sur les appels
   * suivants : sans ce compteur, aucune mesure du gain réel du cache n'est
   * possible — ce qui est précisément l'optimisation à évaluer ensuite.
   */
  cacheWriteTokens: number;
}

export interface LlmResponse {
  content: LlmContent[];
  stopReason: LlmStopReason;
  usage: LlmUsage;
  model: string;
  /** Present when the model declined; surfaced verbatim to the founder. */
  refusal: { category: string | null; explanation: string | null } | null;
}

export interface LlmProvider {
  readonly kind: 'anthropic' | 'simulation';
  complete(request: LlmRequest): Promise<LlmResponse>;
}

// ─── Helpers shared by both providers ──────────────────────────────────────

export const userText = (text: string): LlmMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
});

export const assistantText = (text: string): LlmMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
});

/** Concatenates every text block in a response, ignoring tool traffic. */
export function textOf(content: LlmContent[]): string {
  return content
    .filter((c): c is Extract<LlmContent, { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
    .trim();
}

export function toolCallsOf(content: LlmContent[]): Array<Extract<LlmContent, { type: 'tool_use' }>> {
  return content.filter((c): c is Extract<LlmContent, { type: 'tool_use' }> => c.type === 'tool_use');
}

export const totalTokens = (usage: LlmUsage): number => usage.inputTokens + usage.outputTokens;

/**
 * Extracts a JSON object from model text.
 *
 * Even with structured outputs a model can wrap JSON in prose or a fence, and
 * a planning failure must not take down a mission — so parsing is forgiving
 * and reports failure rather than throwing.
 */
export function parseJsonObject<T>(text: string): { ok: true; value: T } | { ok: false; error: string } {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return { ok: true, value: parsed as T };
    } catch {
      /* try the next candidate */
    }
  }
  return { ok: false, error: 'No parseable JSON object in model output' };
}
