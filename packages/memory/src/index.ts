import type {
  MemoryHit,
  MemoryItem,
  MemoryKind,
  MemoryQuery,
  MemoryTier,
  MissionId,
  AgentKey,
} from '@atlas/contracts';
import type { EventBus, Logger } from '@atlas/core';
import { addMs, nowIso } from '@atlas/core';
import type { MemoryRepository } from '@atlas/data';

export interface RememberInput {
  tier?: MemoryTier;
  kind: MemoryKind;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  missionId?: MissionId | null;
  agentKey?: AgentKey | null;
  importance?: number;
  confidence?: number;
}

export interface MemoryRetention {
  operational: number;
  strategic: number;
  business: number;
}

/** Operational memory expires unless it proves itself worth promoting. */
const OPERATIONAL_TTL_MS = 1000 * 60 * 60 * 24 * 30;

/**
 * The Archivist's library (SRS §2.11, §5.11).
 *
 * Three tiers with different lifecycles:
 *   • operational — what a running mission needs; short-lived by default
 *   • strategic  — durable lessons about how the organisation works best
 *   • business   — domain knowledge (companies, markets, partners)
 *
 * The tier is inferred from the kind of knowledge unless the caller insists,
 * so agents record what they learned without having to reason about storage.
 */
export class MemoryService {
  #log: Logger;

  constructor(
    private readonly repo: MemoryRepository,
    private readonly events: EventBus,
    logger: Logger,
  ) {
    this.#log = logger.child({ scope: 'memory' });
  }

  /**
   * Stores knowledge. If an entry with the same title already exists in the
   * tier, it is reinforced rather than duplicated — repetition is evidence of
   * importance, not a reason to grow the library.
   */
  remember(input: RememberInput): MemoryItem {
    const tier = input.tier ?? inferTier(input.kind);
    const importance = input.importance ?? defaultImportance(input.kind);

    const existing = this.repo.findSimilar(tier, input.title);
    if (existing) {
      const reinforced = Math.min(1, existing.importance + 0.08);
      this.repo.update(existing.id, {
        content: input.content,
        importance: reinforced,
        confidence: Math.max(existing.confidence, input.confidence ?? existing.confidence),
        tags: dedupe([...existing.tags, ...(input.tags ?? [])]),
        metadata: { ...existing.metadata, ...(input.metadata ?? {}) },
      });
      this.#log.debug('memory reinforced', { id: existing.id, title: input.title });
      return { ...existing, content: input.content, importance: reinforced };
    }

    const item = this.repo.insert({
      tier,
      kind: input.kind,
      title: input.title.slice(0, 200),
      content: input.content,
      metadata: input.metadata,
      tags: dedupe(input.tags ?? []),
      missionId: input.missionId ?? null,
      agentKey: input.agentKey ?? null,
      importance,
      confidence: input.confidence,
      // Only operational memory self-expires; the other tiers are curated.
      expiresAt: tier === 'operational' ? addMs(nowIso(), OPERATIONAL_TTL_MS) : null,
    });

    this.events.publish({
      type: 'memory.stored',
      severity: 'debug',
      source: 'memory',
      missionId: input.missionId ?? null,
      agentKey: input.agentKey ?? null,
      message: `Recorded ${tier} ${input.kind}: ${input.title}`,
      payload: { memoryId: item.id, tier, kind: input.kind },
    });

    return item;
  }

  /** Ranked recall. Marks hits as accessed so useful knowledge gains weight. */
  recall(query: MemoryQuery): MemoryHit[] {
    const hits = this.repo.search(query);
    if (hits.length > 0) {
      this.repo.markAccessed(hits.map((h) => h.id));
      this.events.publish({
        type: 'memory.recalled',
        severity: 'debug',
        source: 'memory',
        missionId: query.missionId ?? null,
        agentKey: query.agentKey ?? null,
        message: `Recalled ${hits.length} item(s)`,
        payload: { count: hits.length, text: query.text ?? null },
      });
    }
    return hits;
  }

  /**
   * Builds a compact briefing for an agent about to start work.
   *
   * Capped by character budget rather than item count: what matters is how
   * much context an agent can actually carry, not how many rows we found.
   */
  briefing(topic: string, options: { missionId?: MissionId; budget?: number } = {}): string {
    const budget = options.budget ?? 2400;
    const hits = this.recall({ text: topic, limit: 12, minImportance: 0.25 });
    if (hits.length === 0) return '';

    const lines: string[] = [];
    let used = 0;
    for (const hit of hits) {
      const entry = `- [${hit.tier}/${hit.kind}] ${hit.title}: ${collapse(hit.content, 320)}`;
      if (used + entry.length > budget) break;
      lines.push(entry);
      used += entry.length;
    }
    if (lines.length === 0) return '';
    return `Relevant knowledge from ATLAS memory:\n${lines.join('\n')}`;
  }

  get(memoryId: string): MemoryItem | null {
    return this.repo.get(memoryId);
  }

  forget(memoryId: string): void {
    this.repo.delete(memoryId);
  }

  recent(limit = 20): MemoryItem[] {
    return this.repo.recent(limit);
  }

  stats(): { total: number; byTier: Record<MemoryTier, number> } {
    return { total: this.repo.total(), byTier: this.repo.countByTier() };
  }

  /**
   * Periodic housekeeping (SRS §2.11): expire stale entries, promote proven
   * operational knowledge into strategic memory, prune what nobody ever used.
   *
   * Returns a report so the evolution loop can observe whether memory is
   * actually improving over time.
   */
  consolidate(retention: MemoryRetention): {
    expired: number;
    promoted: number;
    pruned: number;
  } {
    const expired = this.repo.purgeExpired();

    let promoted = 0;
    for (const candidate of this.repo.promotionCandidates(3, 0.8, 25)) {
      this.repo.update(candidate.id, {
        tier: 'strategic',
        importance: Math.min(1, candidate.importance + 0.1),
      });
      promoted++;
    }

    // Only operational memory is pruned automatically — curated tiers are the
    // founder's and the Archivist's to manage, never the janitor's.
    const cutoff = addMs(nowIso(), -1000 * 60 * 60 * 24 * 14);
    const pruned = this.repo.purgeLowValue('operational', retention.operational, cutoff);

    if (expired + promoted + pruned > 0) {
      this.#log.info('memory consolidated', { expired, promoted, pruned });
    }
    return { expired, promoted, pruned };
  }
}

/** Maps a kind of knowledge to where it naturally belongs. */
function inferTier(kind: MemoryKind): MemoryTier {
  switch (kind) {
    case 'entity':
      return 'business';
    case 'lesson':
    case 'procedure':
    case 'preference':
      return 'strategic';
    case 'insight':
      return 'strategic';
    case 'fact':
    case 'outcome':
    default:
      return 'operational';
  }
}

function defaultImportance(kind: MemoryKind): number {
  switch (kind) {
    case 'lesson':
      return 0.85;
    case 'preference':
      return 0.8;
    case 'procedure':
      return 0.75;
    case 'insight':
      return 0.7;
    case 'entity':
      return 0.6;
    case 'outcome':
      return 0.45;
    case 'fact':
    default:
      return 0.4;
  }
}

const dedupe = (values: string[]): string[] => [...new Set(values.map((v) => v.trim()).filter(Boolean))];

function collapse(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}
