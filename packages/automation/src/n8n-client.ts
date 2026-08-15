import type { Logger } from '@atlas/core';
import { AtlasError } from '@atlas/core';

export interface N8nConfig {
  baseUrl: string;
  apiKey: string;
  webhookSecret: string;
}

export interface N8nWorkflowSummary {
  id: string;
  name: string;
  active: boolean;
}

/**
 * Thin client for n8n (SRS §2.12).
 *
 * Deliberately narrow: ATLAS triggers workflows and reads their result. The
 * boundary is "Hermes decides, n8n executes" — so this client never authors
 * or mutates workflow definitions, which keeps the automation layer swappable.
 */
export class N8nClient {
  #log: Logger;

  constructor(private readonly config: N8nConfig, logger: Logger) {
    this.#log = logger.child({ scope: 'n8n' });
  }

  /** Fires a production webhook and returns the workflow's response body. */
  async triggerWebhook(
    path: string,
    payload: Record<string, unknown>,
    timeoutMs = 120_000,
  ): Promise<Record<string, unknown>> {
    const url = `${this.config.baseUrl}/webhook/${path.replace(/^\/+/, '')}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(this.config.webhookSecret ? { 'x-atlas-signature': this.config.webhookSecret } : {}),
        },
        body: JSON.stringify(payload),
      });

      const text = await response.text();
      if (!response.ok) {
        throw new AtlasError('DEPENDENCY_FAILED', `n8n webhook returned HTTP ${response.status}`, {
          details: text.slice(0, 500),
          retryable: response.status >= 500,
        });
      }

      if (!text.trim()) return {};
      try {
        const parsed = JSON.parse(text);
        return typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)
          : { value: parsed };
      } catch {
        return { raw: text.slice(0, 8000) };
      }
    } catch (err) {
      if (err instanceof AtlasError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AtlasError('TIMEOUT', `n8n workflow did not respond within ${timeoutMs}ms`);
      }
      throw new AtlasError('DEPENDENCY_FAILED', `Could not reach n8n: ${String(err)}`, {
        retryable: true,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Lists workflows via the public API, so the console can offer real keys. */
  async listWorkflows(): Promise<N8nWorkflowSummary[]> {
    if (!this.config.apiKey) return [];

    try {
      const response = await fetch(`${this.config.baseUrl}/api/v1/workflows?limit=100`, {
        headers: { 'X-N8N-API-KEY': this.config.apiKey, accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        this.#log.warn('n8n workflow listing failed', { status: response.status });
        return [];
      }

      const body = (await response.json()) as { data?: Array<{ id: string; name: string; active: boolean }> };
      return (body.data ?? []).map((w) => ({ id: String(w.id), name: w.name, active: Boolean(w.active) }));
    } catch (err) {
      this.#log.warn('could not list n8n workflows', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** Connectivity probe used by the health check. */
  async ping(): Promise<{ reachable: boolean; detail: string }> {
    try {
      const response = await fetch(`${this.config.baseUrl}/healthz`, {
        signal: AbortSignal.timeout(5_000),
      });
      return {
        reachable: response.ok,
        detail: response.ok ? 'n8n reachable' : `n8n returned HTTP ${response.status}`,
      };
    } catch (err) {
      return { reachable: false, detail: `n8n unreachable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
