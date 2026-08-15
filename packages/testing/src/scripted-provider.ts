import type { LlmContent, LlmProvider, LlmRequest, LlmResponse } from '@atlas/llm';

/**
 * A provider whose every answer the test decides.
 *
 * The handler receives the real request, so a test can branch on which agent
 * is calling, whether a JSON schema was requested (planning) or tools were
 * offered (execution), and how many times it has been called. That is what
 * makes it possible to test the orchestrator's behaviour — retries, cascades,
 * replanning — deterministically, without touching a network.
 */

export interface ScriptedCall {
  request: LlmRequest;
  index: number;
}

/**
 * La consommation qu'un test veut faire déclarer à un appel.
 *
 * Sans cela, chaque appel scripté coûte 150 jetons et aucun plafond réaliste
 * ne peut être exercé : c'est ce qui rendait invisible, en test, une étape
 * capable de consommer 343 % du budget de sa mission.
 */
export interface ScriptedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type ScriptedReply =
  | { kind: 'text'; text: string; usage?: ScriptedUsage }
  | { kind: 'json'; value: unknown; usage?: ScriptedUsage }
  | { kind: 'tool'; name: string; input: Record<string, unknown>; text?: string; usage?: ScriptedUsage }
  | { kind: 'throw'; error: Error }
  | { kind: 'refusal'; category?: string }
  /** Never settles until the caller's signal aborts — used to test timeouts. */
  | { kind: 'hang' };

export type ScriptedHandler = (call: ScriptedCall) => ScriptedReply | Promise<ScriptedReply>;

export class ScriptedProvider implements LlmProvider {
  readonly kind = 'simulation' as const;
  readonly calls: LlmRequest[] = [];
  #handler: ScriptedHandler;

  constructor(handler: ScriptedHandler) {
    this.#handler = handler;
  }

  /** Number of calls whose request offered tools (i.e. agent executions). */
  get executionCalls(): number {
    return this.calls.filter((c) => (c.tools?.length ?? 0) > 0).length;
  }

  /** Number of calls that asked for structured output (i.e. planning). */
  get planningCalls(): number {
    return this.calls.filter((c) => c.jsonSchema !== undefined).length;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const index = this.calls.length;
    this.calls.push(request);

    const reply = await this.#handler({ request, index });

    if (reply.kind === 'throw') throw reply.error;

    if (reply.kind === 'hang') {
      return new Promise<LlmResponse>((_resolve, reject) => {
        const onAbort = (): void => reject(new Error('aborted'));
        if (request.signal?.aborted) return onAbort();
        request.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }

    if (reply.kind === 'refusal') {
      return {
        content: [],
        stopReason: 'refusal',
        usage: usage(),
        model: request.model,
        refusal: { category: reply.category ?? 'policy', explanation: 'scripted refusal' },
      };
    }

    const content: LlmContent[] = [];
    let stopReason: LlmResponse['stopReason'] = 'end_turn';

    if (reply.kind === 'text') {
      content.push({ type: 'text', text: reply.text });
    } else if (reply.kind === 'json') {
      content.push({ type: 'text', text: JSON.stringify(reply.value) });
    } else {
      if (reply.text) content.push({ type: 'text', text: reply.text });
      content.push({
        type: 'tool_use',
        id: `call_${index}`,
        name: reply.name,
        input: reply.input,
      });
      stopReason = 'tool_use';
    }

    return { content, stopReason, usage: usage(reply.usage), model: request.model, refusal: null };
  }
}

/** Non-zero by default so token accounting is observable; overridable per reply. */
const usage = (override?: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): LlmResponse['usage'] => ({
  inputTokens: override?.inputTokens ?? 100,
  outputTokens: override?.outputTokens ?? 50,
  cacheReadTokens: override?.cacheReadTokens ?? 0,
  cacheWriteTokens: override?.cacheWriteTokens ?? 0,
});
