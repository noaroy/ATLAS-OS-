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
  /**
   * Ce qui étaye cette connaissance, quand elle prétend décrire le monde.
   *
   * Une mémoire de palier `business` affirme un fait de marché ; sans preuve
   * sourcée derrière, elle n'est qu'une sortie de modèle promue au rang de
   * fait — et relue comme tel par toutes les missions suivantes.
   *
   * Les paliers `operational` et `strategic` n'en ont pas besoin : « cette
   * stratégie de recherche n'a rien donné » est une leçon sur nous, pas une
   * affirmation sur le monde.
   */
  evidenceIds?: string[];
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
  /** Combien de connaissances la barrière a écartées, pour la télémétrie. */
  #excluded = 0;

  constructor(
    private readonly repo: MemoryRepository,
    private readonly events: EventBus,
    logger: Logger,
    /**
     * Le mode d'exécution du déploiement.
     *
     * Passé à la construction, comme pour le registre d'entreprises : une
     * barrière qui dépend d'un paramètre d'appel est une barrière qu'un
     * appelant peut oublier.
     */
    private readonly mode: 'live' | 'simulation' = 'live',
  ) {
    this.#log = logger.child({ scope: 'memory' });
  }

  /** Ce que la barrière a écarté depuis le démarrage. Lecture seule. */
  get excludedCount(): number {
    return this.#excluded;
  }

  /**
   * Stores knowledge. If an entry with the same title already exists in the
   * tier, it is reinforced rather than duplicated — repetition is evidence of
   * importance, not a reason to grow the library.
   */
  remember(input: RememberInput): MemoryItem {
    const tier = input.tier ?? inferTier(input.kind);
    const importance = input.importance ?? defaultImportance(input.kind);

    // ── La barrière d'écriture ────────────────────────────────────────────
    //
    // La lignée vient du déploiement, jamais de l'appelant — exactement comme
    // le drapeau `simulated` des preuves. Un agent ne doit pas pouvoir
    // déclarer que sa production est réelle.
    //
    // Et une connaissance *métier* écrite en mode réel n'obtient la lignée
    // `live` que si des preuves l'étayent. Sans elles, elle reste `unknown` :
    // une conclusion de modèle sans source n'est pas un fait de marché, et la
    // mémoriser comme tel est précisément la façon dont une invention devient
    // indétectable au deuxième usage.
    //
    // Les leçons opérationnelles et stratégiques échappent à cette exigence :
    // elles parlent de nous, pas du monde. « Cette stratégie de recherche n'a
    // rien produit lors de la mission X » est vrai sans qu'aucune source
    // externe ait à l'attester.
    const claimsAboutTheWorld = tier === 'business';
    const backed = (input.evidenceIds?.length ?? 0) > 0;
    const dataOrigin: MemoryItem['dataOrigin'] =
      this.mode === 'simulation'
        ? 'simulated'
        : claimsAboutTheWorld && !backed
          ? 'unknown'
          : 'live';

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
      // `update` ne touche pas à `data_origin`, et `...existing` la conserve :
      // renforcer une connaissance ne change pas d'où elle vient. Une mission
      // réelle qui recroise une leçon écrite en démonstration ne doit pas
      // pouvoir la promouvoir au rang de fait réel — c'est le blanchiment que
      // cette colonne existe pour empêcher, un étage au-dessus des entreprises.
      this.#log.debug('memory reinforced', {
        id: existing.id,
        title: input.title,
        origin: existing.dataOrigin,
      });
      return { ...existing, content: input.content, importance: reinforced };
    }

    const item = this.repo.insert({
      tier,
      dataOrigin,
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

  /**
   * Ranked recall. Marks hits as accessed so useful knowledge gains weight.
   *
   * ── La barrière de lecture ──────────────────────────────────────────────
   *
   * En mode réel, seule une connaissance de lignée `live` est rendue au
   * raisonnement. `simulated` et `unknown` sont écartées sans distinction.
   *
   * C'est ici que la barrière compte le plus, et pas dans l'écriture : la
   * mémoire est relue *avant* toute recherche, et une connaissance fabriquée
   * qui entre dans un prompt n'est plus une sortie de modèle — elle est une
   * prémisse que le raisonnement suivant tient pour acquise. Une fiche
   * d'entreprise fabriquée se repère à son domaine ; une phrase fabriquée ne
   * se repère à rien.
   *
   * Ce qui est écarté est compté et journalisé — l'audit doit pouvoir voir
   * qu'une connaissance a été retenue à la porte, sans que son contenu entre.
   */
  recall(query: MemoryQuery): MemoryHit[] {
    const raw = this.repo.search(query);
    const hits = this.mode === 'live' ? raw.filter((h) => h.dataOrigin === 'live') : raw;

    const excluded = raw.length - hits.length;
    if (excluded > 0) {
      this.#excluded += excluded;
      this.#log.debug('connaissances écartées par la barrière de lignée', {
        excluded,
        kept: hits.length,
        origins: [...new Set(raw.filter((h) => h.dataOrigin !== 'live').map((h) => h.dataOrigin))],
      });
    }

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
