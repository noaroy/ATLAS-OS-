import type { EventType, SystemEvent, EventSeverity } from '@atlas/contracts';
import { id } from './ids.ts';
import { nowIso } from './time.ts';
import type { Logger } from './logger.ts';

export type EventHandler = (event: SystemEvent) => void | Promise<void>;

export interface PublishInput {
  type: EventType;
  message: string;
  severity?: EventSeverity;
  source?: string;
  missionId?: string | null;
  agentKey?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * The system's nervous system (SRS §5.9).
 *
 * Subscribers never block publishers: handlers run detached and their failures
 * are logged rather than propagated, so one bad listener can never stall a
 * mission. Ordering is preserved per-publish, which is what the village
 * animation relies on to replay activity coherently.
 */
export class EventBus {
  #handlers = new Map<EventType | '*', Set<EventHandler>>();
  #log: Logger;
  #inFlight = 0;

  constructor(logger: Logger) {
    this.#log = logger.child({ scope: 'events' });
  }

  on(type: EventType | '*', handler: EventHandler): () => void {
    let set = this.#handlers.get(type);
    if (!set) {
      set = new Set();
      this.#handlers.set(type, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  once(type: EventType, handler: EventHandler): () => void {
    const off = this.on(type, async (event) => {
      off();
      await handler(event);
    });
    return off;
  }

  /** Builds the canonical event record and fans it out. */
  publish(input: PublishInput): SystemEvent {
    const event: SystemEvent = {
      id: id('evt'),
      type: input.type,
      severity: input.severity ?? 'info',
      source: input.source ?? 'system',
      missionId: input.missionId ?? null,
      agentKey: input.agentKey ?? null,
      message: input.message,
      payload: input.payload ?? {},
      createdAt: nowIso(),
    };
    this.#dispatch(event);
    return event;
  }

  /** Re-emits an already-materialised event (used when replaying from storage). */
  emit(event: SystemEvent): void {
    this.#dispatch(event);
  }

  #dispatch(event: SystemEvent): void {
    const targets = [this.#handlers.get(event.type), this.#handlers.get('*')];
    for (const set of targets) {
      if (!set) continue;
      for (const handler of set) {
        this.#inFlight++;
        void Promise.resolve()
          .then(() => handler(event))
          .catch((err) => {
            this.#log.error('event handler failed', {
              type: event.type,
              error: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(() => {
            this.#inFlight--;
          });
      }
    }
  }

  /** Number of handler invocations still running — surfaced in health checks. */
  get backlog(): number {
    return this.#inFlight;
  }

  /** Waits for outstanding handlers, so shutdown does not truncate the log. */
  async drain(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.#inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}
