import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from '@atlas/core';
import { AtlasError } from '@atlas/core';
import { sanitiseStructuredSchema } from './json-schema.ts';
import type {
  LlmContent,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStopReason,
} from './types.ts';

/**
 * Anthropic-backed inference.
 *
 * Two deliberate choices here:
 *  • Adaptive thinking is always on and effort is the depth control — the
 *    fixed thinking-budget model is gone on current Claude models.
 *  • Every call streams and resolves via `finalMessage()`, which gives ATLAS
 *    timeout protection on long agent turns without handling stream events.
 */
export class AnthropicProvider implements LlmProvider {
  readonly kind = 'anthropic' as const;
  #client: Anthropic;
  #log: Logger;

  constructor(apiKey: string, logger: Logger) {
    this.#client = new Anthropic({ apiKey, maxRetries: 3 });
    this.#log = logger.child({ scope: 'llm:anthropic' });
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens,
      // Le prompt système passe en bloc structuré uniquement lorsqu'on veut le
      // mettre en cache : la forme simple reste plus lisible partout ailleurs.
      system: request.cacheSystemPrompt
        ? [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }]
        : request.system,
      messages: request.messages.map(toApiMessage),
      thinking: { type: 'adaptive' },
      output_config: {
        effort: request.effort ?? 'high',
        // Le schéma est nettoyé ici, au dernier moment : un mot-clé non
        // supporté ferait rejeter la requête entière en 400 avant toute
        // inférence, et l'appelant n'aurait aucun moyen de le voir venir.
        ...(request.jsonSchema
          ? { format: { type: 'json_schema', schema: sanitiseStructuredSchema(request.jsonSchema) } }
          : {}),
      },
    };

    const tools: Array<Record<string, unknown>> = [];
    for (const tool of request.tools ?? []) {
      tools.push({ name: tool.name, description: tool.description, input_schema: tool.inputSchema });
    }
    // Server-side tools carry dynamic filtering on current models, so results
    // are narrowed before they ever reach the context window.
    for (const serverTool of request.serverTools ?? []) {
      if (serverTool === 'web_search') {
        tools.push({
          type: 'web_search_20260209',
          name: 'web_search',
          max_uses: request.serverToolLimits?.webSearch ?? 6,
        });
      } else if (serverTool === 'web_fetch') {
        tools.push({
          type: 'web_fetch_20260209',
          name: 'web_fetch',
          max_uses: request.serverToolLimits?.webFetch ?? 4,
        });
      }
    }
    if (tools.length > 0) body.tools = tools;

    try {
      const stream = this.#client.messages.stream(body as never, {
        signal: request.signal,
      });
      const message = await stream.finalMessage();

      // A refusal is a successful HTTP response — check it before reading content.
      const stopReason = mapStopReason(message.stop_reason);
      if (stopReason === 'refusal') {
        const details = (message as { stop_details?: { category?: string; explanation?: string } })
          .stop_details;
        this.#log.warn('model declined the request', { category: details?.category ?? null });
        return {
          content: [],
          stopReason,
          usage: {
            inputTokens: message.usage.input_tokens ?? 0,
            outputTokens: message.usage.output_tokens ?? 0,
            cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
          },
          model: message.model,
          refusal: {
            category: details?.category ?? null,
            explanation: details?.explanation ?? null,
          },
        };
      }

      return {
        content: fromApiContent(message.content),
        stopReason,
        usage: {
          inputTokens: message.usage.input_tokens ?? 0,
          outputTokens: message.usage.output_tokens ?? 0,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
        },
        model: message.model,
        refusal: null,
      };
    } catch (err) {
      throw translateError(err);
    }
  }
}

function toApiMessage(message: { role: 'user' | 'assistant'; content: LlmContent[] }) {
  return {
    role: message.role,
    content: message.content.map((block) => {
      switch (block.type) {
        case 'text':
          return { type: 'text' as const, text: block.text };
        case 'tool_use':
          return {
            type: 'tool_use' as const,
            id: block.id,
            name: block.name,
            input: block.input,
          };
        case 'tool_result':
          return {
            type: 'tool_result' as const,
            tool_use_id: block.toolUseId,
            content: block.content,
            is_error: block.isError,
          };
      }
    }),
  };
}

/**
 * Thinking blocks are intentionally dropped: ATLAS never replays a turn to a
 * different model mid-mission, and the raw chain of thought is not part of the
 * record we keep. Text and tool traffic is what the system reasons about.
 */
function fromApiContent(content: unknown[]): LlmContent[] {
  const out: LlmContent[] = [];
  for (const raw of content) {
    const block = raw as { type: string; text?: string; id?: string; name?: string; input?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use' && block.id && block.name) {
      out.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      });
    }
  }
  return out;
}

function mapStopReason(reason: string | null | undefined): LlmStopReason {
  switch (reason) {
    case 'end_turn':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'pause_turn':
      return 'pause_turn';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

/** Maps SDK errors onto the ATLAS taxonomy so retry policy stays uniform. */
function translateError(err: unknown): AtlasError {
  if (err instanceof Anthropic.RateLimitError) {
    return new AtlasError('RATE_LIMITED', 'Anthropic rate limit reached', { retryable: true, cause: err });
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return new AtlasError('PROVIDER_ERROR', 'Anthropic rejected the API key', {
      retryable: false,
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AtlasError('DEPENDENCY_FAILED', 'Could not reach the Anthropic API', {
      retryable: true,
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIError) {
    const retryable = err.status === undefined || err.status >= 500 || err.status === 408;
    return new AtlasError('PROVIDER_ERROR', `Anthropic API error: ${err.message}`, {
      retryable,
      cause: err,
    });
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return new AtlasError('TIMEOUT', 'Inference was cancelled', { retryable: false, cause: err });
  }
  return new AtlasError('PROVIDER_ERROR', err instanceof Error ? err.message : String(err), {
    retryable: true,
    cause: err,
  });
}
