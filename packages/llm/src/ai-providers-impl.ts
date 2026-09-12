import { withDeadline } from '@atlas/core';
import { pricingFor } from './pricing.ts';
import {
  classifyAiError,
  extractJson,
  type AiProvider,
  type AiProviderStatus,
  type AiRequest,
  type AiResponse,
  type AiErrorVerdict,
  type AiUsage,
} from './ai-provider.ts';

/**
 * Les trois façons d'appeler un modèle : figée, OpenAI, Anthropic.
 *
 * La figée n'est pas un accessoire de test. C'est le fournisseur par défaut du
 * système tant que `ATLAS_AI_LIVE` est faux, et elle permet de dérouler une
 * chaîne entière — routage, résultat structuré, enfants, bornes — sans qu'un
 * centime soit dépensé. Un système autonome qu'on ne peut pas exercer sans
 * payer finit par n'être exercé qu'en production.
 *
 * OpenAI est appelé en HTTP direct plutôt que par son SDK. Deux raisons : le
 * dépôt n'a pas cette dépendance et l'ajouter pour quatre champs serait
 * disproportionné ; et l'endpoint utilisé est documenté et stable. Le choix est
 * dit ici pour qu'il se conteste, pas pour qu'il se découvre.
 */

const OPENAI_API = 'https://api.openai.com/v1/chat/completions';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

/**
 * Le coût, quand le tarif du modèle est connu — et `null` sinon.
 *
 * `null` plutôt que zéro. Un modèle absent de la table tarifaire a bien coûté
 * quelque chose ; l'écrire zéro ferait apparaître une dépense réelle comme
 * gratuite dans tous les totaux qui suivent.
 */
function priceOf(
  model: string,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number },
): { costUsd: number | null; costBasis: AiUsage['costBasis'] } {
  const pricing = pricingFor(model);
  if (!pricing) return { costUsd: null, costBasis: 'UNKNOWN_PRICE' };
  const cost =
    (usage.inputTokens / 1_000_000) * pricing.input
    + (usage.outputTokens / 1_000_000) * pricing.output
    + (usage.cacheReadTokens / 1_000_000) * pricing.cacheRead;
  return { costUsd: Math.round(cost * 1_000_000) / 1_000_000, costBasis: 'KNOWN' };
}

// --- Fournisseur figé -------------------------------------------------------

export interface FixtureReply {
  /**
   * Ce que le modèle est censé répondre. Objet ou texte, au choix du scénario.
   * Facultatif quand `error` est fourni : un appel qui échoue ne répond rien.
   */
  body?: Record<string, unknown> | string;
  /** Une erreur à lever plutôt qu'à répondre, pour éprouver les gardes. */
  error?: { status?: number; message: string; headers?: Record<string, string> };
  delayMs?: number;
  usage?: Partial<Pick<AiUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens'>>;
}

/**
 * Un fournisseur dont les réponses sont écrites d'avance.
 *
 * Les réponses sont consommées dans l'ordre ; la dernière se répète, pour qu'un
 * scénario n'ait pas à prévoir combien d'appels le routeur fera. Les appels
 * reçus sont conservés : c'est ce qui permet de vérifier ce qu'on a réellement
 * envoyé au modèle — notamment qu'on ne lui a pas envoyé tout le dépôt.
 */
export class FixtureAiProvider implements AiProvider {
  readonly calls: AiRequest[] = [];
  private index = 0;

  constructor(
    readonly provider: 'OPENAI' | 'ANTHROPIC',
    readonly model: string,
    private readonly replies: readonly FixtureReply[],
  ) {}

  status(): AiProviderStatus {
    return {
      configured: true,
      code: 'FIXTURE_READY',
      detail: 'réponses figées : aucun appel réseau, aucune dépense.',
    };
  }

  async execute(request: AiRequest): Promise<AiResponse> {
    this.calls.push(request);
    const reply = this.replies[Math.min(this.index, this.replies.length - 1)]
      ?? { body: '{}' };
    this.index += 1;

    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    if (reply.error) {
      const error = new Error(reply.error.message) as Error & {
        status?: number; headers?: Record<string, string>;
      };
      error.status = reply.error.status;
      error.headers = reply.error.headers;
      throw error;
    }

    const body = reply.body ?? {};
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      text,
      structured: typeof body === 'string' ? extractJson(text) : body,
      usage: {
        inputTokens: reply.usage?.inputTokens ?? 100,
        outputTokens: reply.usage?.outputTokens ?? 50,
        cacheReadTokens: reply.usage?.cacheReadTokens ?? 0,
        costUsd: 0,
        // Zéro parce que rien n'a été facturé, et `SIMULATED` pour que le
        // rapport ne le compte pas comme une dépense réelle.
        costBasis: 'SIMULATED',
      },
      model: this.model,
      provider: this.provider,
      durationMs: reply.delayMs ?? 1,
    };
  }

  classifyError(error: unknown): AiErrorVerdict {
    const e = error as { status?: number; message?: string; headers?: Record<string, string> };
    return classifyAiError({
      status: e?.status ?? null,
      message: e?.message ?? String(error),
      headers: e?.headers ?? null,
    });
  }
}

// --- OpenAI -----------------------------------------------------------------

export class OpenAiProvider implements AiProvider {
  readonly provider = 'OPENAI' as const;

  constructor(
    readonly model: string,
    private readonly apiKey: string,
  ) {}

  status(): AiProviderStatus {
    return this.apiKey.trim()
      ? { configured: true, code: 'OPENAI_READY', detail: `modèle ${this.model}` }
      : {
          configured: false,
          code: 'OPENAI_NOT_CONFIGURED',
          // Le nom de la variable, jamais sa valeur.
          detail: 'variable absente : ATLAS_OPENAI_API_KEY',
        };
  }

  async execute(request: AiRequest): Promise<AiResponse> {
    if (!this.apiKey.trim()) {
      const error = new Error('ATLAS_OPENAI_API_KEY absente') as Error & { status?: number };
      error.status = 401;
      throw error;
    }
    const startedAt = Date.now();

    const response = await withDeadline(
      (signal) =>
        fetch(OPENAI_API, {
          method: 'POST',
          signal,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
            // Le fournisseur déduplique les retours réseau ratés : une réponse
            // perdue en chemin ne se paie pas deux fois.
            ...(request.idempotencyKey ? { 'idempotency-key': request.idempotencyKey } : {}),
          },
          body: JSON.stringify({
            model: this.model,
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.prompt },
            ],
            max_completion_tokens: request.maxOutputTokens,
            ...(request.responseSchema
              ? { response_format: { type: 'json_object' } }
              : {}),
          }),
        }),
      { ms: request.timeoutMs, label: 'openai' },
    );

    if (!response.ok) {
      // Le corps est lu pour le message, jamais journalisé tel quel : une
      // réponse d'erreur peut contenir un fragment de la requête.
      const body = await response.text().catch(() => '');
      const error = new Error(`OpenAI HTTP ${response.status} — ${body.slice(0, 300)}`) as Error & {
        status?: number; headers?: Record<string, string>;
      };
      error.status = response.status;
      error.headers = Object.fromEntries(response.headers.entries());
      throw error;
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number;
                prompt_tokens_details?: { cached_tokens?: number } };
      model?: string;
    };

    const text = payload.choices?.[0]?.message?.content ?? '';
    const tokens = {
      inputTokens: payload.usage?.prompt_tokens ?? 0,
      outputTokens: payload.usage?.completion_tokens ?? 0,
      cacheReadTokens: payload.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    };

    return {
      text,
      structured: extractJson(text),
      usage: { ...tokens, ...priceOf(payload.model ?? this.model, tokens) },
      model: payload.model ?? this.model,
      provider: this.provider,
      durationMs: Date.now() - startedAt,
    };
  }

  classifyError(error: unknown): AiErrorVerdict {
    const e = error as { status?: number; message?: string; headers?: Record<string, string> };
    return classifyAiError({
      status: e?.status ?? null,
      message: e?.message ?? String(error),
      headers: e?.headers ?? null,
    });
  }
}

// --- Anthropic --------------------------------------------------------------

export class AnthropicAiProvider implements AiProvider {
  readonly provider = 'ANTHROPIC' as const;

  constructor(
    readonly model: string,
    private readonly apiKey: string,
  ) {}

  status(): AiProviderStatus {
    return this.apiKey.trim()
      ? { configured: true, code: 'ANTHROPIC_READY', detail: `modèle ${this.model}` }
      : {
          configured: false,
          code: 'ANTHROPIC_NOT_CONFIGURED',
          detail: 'variable absente : ANTHROPIC_API_KEY',
        };
  }

  async execute(request: AiRequest): Promise<AiResponse> {
    if (!this.apiKey.trim()) {
      const error = new Error('ANTHROPIC_API_KEY absente') as Error & { status?: number };
      error.status = 401;
      throw error;
    }
    const startedAt = Date.now();

    const response = await withDeadline(
      (signal) =>
        fetch(ANTHROPIC_API, {
          method: 'POST',
          signal,
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
            ...(request.idempotencyKey ? { 'idempotency-key': request.idempotencyKey } : {}),
          },
          body: JSON.stringify({
            model: this.model,
            system: request.system,
            messages: [{ role: 'user', content: request.prompt }],
            max_tokens: request.maxOutputTokens,
          }),
        }),
      { ms: request.timeoutMs, label: 'anthropic' },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const error = new Error(`Anthropic HTTP ${response.status} — ${body.slice(0, 300)}`) as Error & {
        status?: number; headers?: Record<string, string>;
      };
      error.status = response.status;
      error.headers = Object.fromEntries(response.headers.entries());
      throw error;
    }

    const payload = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
      model?: string;
    };

    const text = (payload.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n');
    const tokens = {
      inputTokens: payload.usage?.input_tokens ?? 0,
      outputTokens: payload.usage?.output_tokens ?? 0,
      cacheReadTokens: payload.usage?.cache_read_input_tokens ?? 0,
    };

    return {
      text,
      structured: extractJson(text),
      usage: { ...tokens, ...priceOf(payload.model ?? this.model, tokens) },
      model: payload.model ?? this.model,
      provider: this.provider,
      durationMs: Date.now() - startedAt,
    };
  }

  classifyError(error: unknown): AiErrorVerdict {
    const e = error as { status?: number; message?: string; headers?: Record<string, string> };
    return classifyAiError({
      status: e?.status ?? null,
      message: e?.message ?? String(error),
      headers: e?.headers ?? null,
    });
  }
}
