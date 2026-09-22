import type { AtlasConfig, Logger } from '@atlas/core';
import type { Repositories, ExpansionPurpose, ExpansionStage, SourceTrust, RelationshipStatus, EntityKind } from '@atlas/data';
import type { LlmProvider } from '@atlas/llm';
import type { SearchProvider } from '@atlas/intelligence';

/**
 * Le moteur d'expansion : une bonne entreprise en révèle d'autres.
 *
 *   graine → hypothèses d'expansion → découverte → preuve → normalisation
 *   → dédoublonnage → relation → qualification ICP → score → Autopilot
 *
 * Ce fichier tient le vocabulaire. Une *graine* est une entreprise forte dont
 * on part. Une *stratégie* pose des *hypothèses* — « ses distributeurs sont
 * listés sur son site », « ses semblables répondent à cette requête », « le
 * salon de son métier publie ses exposants ». L'exécution d'une hypothèse
 * rend des *trouvailles* : une entreprise cible, une relation typée, une
 * confiance, et surtout une *preuve* — l'URL et l'extrait qui la portent. Sans
 * preuve, pas de relation : un moteur qui devine n'est pas un moteur, c'est
 * un générateur de bruit.
 */

export const RELATIONSHIP_TYPES = [
  'COMPETITOR', 'DISTRIBUTOR', 'RESELLER', 'INTEGRATOR', 'IMPORTER', 'WHOLESALER', 'INSTALLER', 'MAINTENANCE_PARTNER',
  'OEM_PARTNER', 'COMPLEMENTARY_VENDOR', 'GROUP_MEMBER', 'SUBSIDIARY', 'ASSOCIATION_MEMBER', 'TRADE_SHOW_EXHIBITOR',
  'VISIBLE_PARTNER', 'VISIBLE_BRAND', 'SIMILAR_COMPANY', 'LIKELY_CUSTOMER', 'OTHER',
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export const STRATEGY_KEYS = ['PARTNER', 'COMPETITOR', 'TRADE_SHOW', 'ASSOCIATION', 'SIMILAR'] as const;
export type StrategyKey = (typeof STRATEGY_KEYS)[number];

/** Une entreprise (ou un salon, une fédération), telle qu'on la désigne avant de la connaître. */
export interface EntityRef {
  name: string;
  domain: string | null;
  website: string | null;
  country: string | null;
  kind?: EntityKind;
}

export interface ExpansionSeed extends EntityRef {
  /** Le prospect commercial d'origine, quand la graine en est un. */
  prospectId?: string | null;
  /** Ce que l'on sait déjà de son activité — évite une lecture. */
  activity?: string | null;
}

/** Le profil visé : ce qui rend un candidat pertinent pour *cette* expansion. */
export interface ExpansionIcp {
  countries: string[];
  /** Des mots de métier ; vide = aucune contrainte sectorielle. */
  keywords: string[];
  /** Des mots qui écartent d'emblée. */
  exclusions: string[];
}

/** Les plafonds d'un tour — durs, jamais dépassés, écrits dans le tour. */
export interface ExpansionLimits {
  maxSeeds: number;
  maxChildrenPerSeed: number;
  maxCandidates: number;
  maxSearchCalls: number;
  maxFetches: number;
  maxAiCostUsd: number;
  maxDepth: number;
  /** Confiance minimale d'une relation pour qu'un enfant devienne graine (profondeur suivante). */
  minChildConfidence: number;
  maxWallMs: number;
}

export const DEFAULT_EXPANSION_LIMITS: ExpansionLimits = {
  maxSeeds: 3, maxChildrenPerSeed: 15, maxCandidates: 60, maxSearchCalls: 24, maxFetches: 40,
  maxAiCostUsd: 0.10, maxDepth: 2, minChildConfidence: 0.6, maxWallMs: 10 * 60_000,
};

export interface ExpansionOptions {
  seeds: ExpansionSeed[];
  purpose?: ExpansionPurpose;
  missionId?: string | null;
  trigger?: string;
  strategies?: StrategyKey[];
  limits?: Partial<ExpansionLimits>;
  icp?: ExpansionIcp;
  /** Reprendre un tour laissé RUNNING par un arrêt. */
  resumeRunId?: string;
  now?: () => Date;
  /** Appelé pendant le travail : le daemon y pose son battement. */
  heartbeat?: () => void;
}

/** Ce que le moteur emprunte au reste d'ATLAS. Tout est remplaçable — c'est ce qui le rend testable sans réseau. */
export interface ExpansionDeps {
  repos: Repositories;
  config: AtlasConfig;
  logger: Logger;
  /** Le moteur de recherche (le Fabric en production). `null` : aucune recherche, seules les pages officielles sont lues. */
  search: SearchProvider | null;
  /** Lire une page https : rend le HTML, ou `null`. Par défaut `fetchRawPages`. */
  fetchHtml?: (url: string) => Promise<string | null>;
  /** Le modèle, plafonné. `null` : chemin déterministe seulement, aucune dépense. */
  provider?: LlmProvider | null;
  /**
   * La cadence des requêtes : un écart minimal entre deux, et un recul quand
   * un moteur répond « trop vite ». SearXNG auto-hébergé rend HTTP 429 à une
   * rafale de sept requêtes ; une expansion n'a aucune raison d'être une
   * rafale. Les tests posent zéro.
   */
  pacing?: { searchGapMs: number; backoffMs: number };
}

export const DEFAULT_SEARCH_PACING = { searchGapMs: 2_500, backoffMs: 8_000 } as const;

/** Ce qu'une hypothèse a rapporté : une cible, une relation, une preuve. */
export interface Finding {
  source: EntityRef & { kind: EntityKind };
  target: EntityRef;
  relationship: RelationshipType;
  confidence: number;
  status: RelationshipStatus;
  trust: SourceTrust;
  evidenceUrl: string;
  evidenceSummary: string;
  method: StrategyKey;
  /** Ce que la page ou l'extrait disait de la cible — la matière de la qualification. */
  snippet: string | null;
  /**
   * Vrai quand l'extrait *décrit la cible* (le titre et l'extrait de son
   * propre site) ; faux quand c'est le contexte d'un lien sur une page tierce
   * — un indice, jamais un jugement sur son métier.
   */
  describesTarget: boolean;
}

/** Une hypothèse d'expansion : ce qu'une stratégie propose de chercher ou de lire. */
export type Hypothesis =
  | {
    kind: 'READ_SITE';
    entity: EntityRef;
    /** Les genres de pages à lire sur le site de l'entité, et la relation que chacun prouve. */
    pages: Array<{ match: RegExp; relationship: RelationshipType; label: string }>;
    maxPages: number;
    rationale: string;
  }
  | {
    kind: 'SEARCH_COMPANIES';
    query: string;
    country: string | null;
    relationship: RelationshipType;
    baseConfidence: number;
    rationale: string;
  }
  | {
    kind: 'SEARCH_LISTINGS';
    query: string;
    country: string | null;
    listingKind: 'EVENT' | 'ASSOCIATION';
    /** Les mots qui désignent, dans un chemin ou un lien, la page des membres / exposants. */
    memberPage: RegExp;
    /** Les mots qui désignent un site de salon / de fédération. */
    listingSite: RegExp;
    relationship: RelationshipType;
    maxSites: number;
    rationale: string;
  };

export interface SeedProfile {
  entity: EntityRef & { kind: EntityKind };
  /** Ce que l'entreprise dit faire : titre, description, mots de métier. */
  activity: string | null;
  keywords: string[];
  homepageUrl: string | null;
  homepageText: string | null;
}

export interface Strategy {
  key: StrategyKey;
  label: string;
  relationships: readonly RelationshipType[];
  plan(seed: SeedProfile, icp: ExpansionIcp): Hypothesis[];
}

export interface ExpansionFunnel {
  universe: number;
  relevant: number;
  qualified: number;
  highPriority: number;
  rejected: number;
}

export interface ExpansionStats {
  seeds: number;
  rawCandidates: number;
  uniqueCompanies: number;
  newCompanies: number;
  relationships: number;
  byRelationship: Record<string, number>;
  byStrategy: Record<string, number>;
  evidence: Record<SourceTrust, number>;
  funnel: ExpansionFunnel;
  relevantRate: number | null;
  qualificationRate: number | null;
  evidenceRate: number | null;
  searchCalls: number;
  fetches: number;
  aiCalls: number;
  searchCostUsd: number;
  aiCostUsd: number;
  costPerRetainedUsd: number | null;
  costPerQualifiedUsd: number | null;
  durationMs: number;
  stoppedBy: string[];
}

export interface ExpansionReport {
  runId: string;
  status: string;
  stats: ExpansionStats;
  topCandidates: Array<{ name: string; domain: string | null; country: string | null; stage: ExpansionStage; score: number | null; relationships: string[]; evidence: number; bestTrust: SourceTrust | null }>;
  summary: string;
}
