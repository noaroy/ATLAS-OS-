import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { AtlasError } from './errors.ts';

/**
 * Configuration is loaded once at boot, validated, and then immutable.
 *
 * Anything that can legitimately change while the system runs (concurrency
 * limits, evolution autonomy, model choices) lives in the settings table
 * instead, so the founder can tune it from the Command Center without a
 * restart — and so the evolution loop has a safe surface to adjust.
 */

const boolish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v)));

const intish = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const floatish = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().min(min).max(max));

/**
 * Les plafonds économiques du déploiement.
 *
 * Déclarés ici plutôt que dans la couche d'inférence parce qu'ils relèvent de
 * la configuration, pas du fournisseur : ils s'appliqueraient à l'identique à
 * un modèle local. `0` vaut « pas de plafond » pour chacun.
 */
export interface BudgetConfig {
  maxMissionTokens: number;
  maxMissionCostUsd: number;
  maxStepTokens: number;
  maxCallsPerStep: number;
  maxOutputTokensPerCall: number;
  circuitBreakerFailures: number;
  /**
   * Sortie en dessous de laquelle un appel est refusé plutôt que rétréci.
   *
   * Le budget adaptatif réduit `max_output_tokens` pour tenir dans ce qui
   * reste ; passé un certain seuil il ne reste plus de quoi produire une
   * réponse utile, et payer une réponse coupée en deux est un pur gaspillage.
   */
  minViableOutputTokens: number;
}

/**
 * Le moteur de recherche d'ATLAS.
 *
 * `provider` désigne la source de résultats :
 *
 *   `searxng`   — défaut. Métamoteur auto-hébergé, gratuit, sans clé.
 *   `brave`     — API commerciale, optionnelle, facturée à la requête.
 *   `anthropic` — l'ancienne recherche par modèle, conservée pour comparaison.
 *   `none`      — aucun moteur ; la découverte se limite au registre.
 *
 * `fallbackEnabled` commande le repli vers la recherche par modèle, désactivé
 * par construction : un repli silencieux coûterait cent fois le prix d'une
 * requête moteur.
 */
export interface SearchConfig {
  provider: 'searxng' | 'brave' | 'anthropic' | 'none';
  /** Racine de l'instance SearXNG, sur le réseau interne. */
  searxngBaseUrl: string;
  /** Moteurs interrogés par SearXNG, séparés par des virgules. */
  searxngEngines: string;
  braveApiKey: string;
  costPerQueryUsd: number;
  fallbackEnabled: boolean;
  timeoutMs: number;
  resultsPerQuery: number;
  maxCandidates: number;
  maxCharsPerPage: number;
  /** Plafond de contexte d'une étape de découverte, en jetons. */
  discoveryMaxContextTokens: number;
}

/** Ce qu'une recherche a le droit de consommer. */
export interface WebLimitsConfig {
  maxSearchesPerDiscovery: number;
  maxFetchesPerCandidate: number;
  maxTotalFetchesPerMission: number;
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  ATLAS_HOST: z.string().default('0.0.0.0'),
  ATLAS_PORT: intish(4700, 1, 65535),
  ATLAS_PUBLIC_URL: z.string().default('http://localhost:4700'),
  ATLAS_CORS_ORIGINS: z.string().default('http://localhost:5173'),

  ATLAS_SESSION_SECRET: z.string().min(16, 'ATLAS_SESSION_SECRET must be at least 16 characters'),
  ATLAS_FOUNDER_EMAIL: z.string().email().default('founder@atlas.local'),
  ATLAS_FOUNDER_PASSWORD: z.string().min(6).default('atlas-founder'),

  ATLAS_DATA_DIR: z.string().default('./data'),
  ATLAS_BACKUP_DIR: z.string().default('./data/backups'),
  ATLAS_BACKUP_RETENTION: intish(14, 1, 365),

  ANTHROPIC_API_KEY: z.string().optional().default(''),
  ATLAS_HERMES_MODEL: z.string().default('claude-opus-5'),
  ATLAS_AGENT_MODEL: z.string().default('claude-sonnet-5'),
  ATLAS_LLM_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  ATLAS_LLM_MAX_TOKENS: intish(16000, 1024, 128000),

  ATLAS_MAX_CONCURRENT_MISSIONS: intish(3, 1, 50),
  ATLAS_MAX_CONCURRENT_TASKS: intish(4, 1, 50),
  // ─── Délais de garde ────────────────────────────────────────────────────
  // Quatre niveaux emboîtés, du plus fin au plus large. LIVE #002 n'en avait
  // qu'un — l'étape — et il ne couvrait que l'inférence propre de l'agent :
  // une recherche web est restée en vol 1 284 s sous un délai d'étape de 300 s.
  // Chaque niveau annule réellement (AbortSignal), il n'abandonne pas.
  // Les défauts sont eux-mêmes une hiérarchie valide : un déploiement neuf ne
  // doit pas se faire refuser au démarrage. La validation a d'ailleurs attrapé
  // l'inverse — les anciens défauts reproduisaient l'inversion de LIVE #003.
  ATLAS_PROVIDER_TIMEOUT_MS: intish(180_000, 1_000, 1_800_000),
  ATLAS_TOOL_TIMEOUT_MS: intish(240_000, 1_000, 1_800_000),
  ATLAS_TASK_TIMEOUT_MS: intish(300_000, 5_000, 3_600_000),
  // 0 = pas de borne de mission. Sinon, dernier filet contre l'enlisement.
  ATLAS_MISSION_TIMEOUT_MS: intish(900_000, 0, 86_400_000),
  ATLAS_TASK_MAX_ATTEMPTS: intish(3, 1, 10),
  ATLAS_MISSION_TOKEN_BUDGET: intish(400_000, 0, 10_000_000),
  ATLAS_MAX_REPLANS_PER_MISSION: intish(1, 0, 5),

  // ─── Plafonds économiques ───────────────────────────────────────────────
  // Le plafond en dollars est le seul qui parle la langue de la facture. Un
  // plafond en jetons dépend du modèle : router vers un modèle plus cher
  // multiplierait la dépense sans toucher au compteur.
  ATLAS_MAX_MISSION_COST_USD: floatish(5, 0, 1000),
  ATLAS_MAX_STEP_TOKENS: intish(120_000, 0, 5_000_000),
  ATLAS_MAX_LLM_CALLS_PER_STEP: intish(12, 0, 200),
  ATLAS_MAX_OUTPUT_TOKENS_PER_CALL: intish(16_000, 0, 128_000),
  ATLAS_CIRCUIT_BREAKER_FAILURES: intish(3, 0, 20),
  // Sortie minimale en dessous de laquelle un appel n'a plus de sens : mieux
  // vaut le refuser que payer une réponse tronquée à mi-phrase.
  ATLAS_MIN_VIABLE_OUTPUT_TOKENS: intish(512, 0, 32_000),

  // ─── Bornes de recherche web ────────────────────────────────────────────
  // L'effort doit suivre l'objectif : chercher cent entreprises pour en rendre
  // deux se paie, et ne rend pas les deux meilleures.
  ATLAS_MAX_WEB_SEARCHES_PER_DISCOVERY: intish(6, 1, 30),
  ATLAS_MAX_PAGE_FETCHES_PER_CANDIDATE: intish(2, 0, 20),
  ATLAS_MAX_TOTAL_PAGE_FETCHES_PER_MISSION: intish(20, 0, 500),

  // ─── Moteur de recherche ────────────────────────────────────────────────
  // Le LLM n'est plus notre moteur de recherche. Un moteur répond en quelques
  // centaines de millisecondes parce qu'il ne fait qu'une chose ; LIVE #005 a
  // attendu sept minutes qu'un modèle fasse ce travail, sans jamais l'obtenir.
  // SearXNG par défaut : auto-hébergé, sans clé, sans quota, sans abonnement.
  // ATLAS dépense déjà de l'argent réel à chaque appel d'inférence ; imposer un
  // service payant pour la seule brique qui peut vivre sur notre VPS serait un
  // coût subi sans contrepartie. Brave reste disponible, en option.
  ATLAS_SEARCH_PROVIDER: z.enum(['searxng', 'brave', 'anthropic', 'none']).default('searxng'),
  SEARXNG_BASE_URL: z.string().default('http://searxng:8080'),
  // Vide = les moteurs configurés dans l'instance. Une sélection resserrée vaut
  // mieux qu'une longue liste : chaque moteur ajoute de la latence et des
  // occasions de panne.
  SEARXNG_ENGINES: z.string().default('duckduckgo,brave,startpage,mojeek'),
  BRAVE_SEARCH_API_KEY: z.string().optional().default(''),
  // Tarif par requête du forfait souscrit, pour une comptabilité honnête.
  ATLAS_SEARCH_COST_PER_QUERY_USD: floatish(0.005, 0, 1),
  // Un repli vers la recherche LLM coûte cent fois plus cher : il ne doit
  // jamais survenir sans une décision explicite.
  ATLAS_SEARCH_FALLBACK_ENABLED: boolish(false),
  ATLAS_SEARCH_TIMEOUT_MS: intish(15_000, 1_000, 120_000),
  ATLAS_SEARCH_RESULTS_PER_QUERY: intish(10, 1, 20),
  ATLAS_SEARCH_MAX_CANDIDATES: intish(6, 1, 30),
  ATLAS_SEARCH_MAX_CHARS_PER_PAGE: intish(6_000, 500, 40_000),
  // Le contexte d'une étape de découverte. LIVE #005 a produit un tour à
  // 154 000 jetons d'entrée — 0,49 $ pour un seul appel.
  ATLAS_DISCOVERY_MAX_CONTEXT_TOKENS: intish(40_000, 2_000, 200_000),

  ATLAS_N8N_ENABLED: boolish(false),
  ATLAS_N8N_BASE_URL: z.string().default('http://localhost:5678'),
  ATLAS_N8N_API_KEY: z.string().optional().default(''),
  ATLAS_N8N_WEBHOOK_SECRET: z.string().optional().default(''),

  ATLAS_EVOLUTION_ENABLED: boolish(true),
  ATLAS_EVOLUTION_AUTONOMY: z.enum(['observe', 'propose', 'apply-low-risk']).default('propose'),

  ATLAS_HEARTBEAT_MS: intish(30_000, 1_000, 600_000),
  ATLAS_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  ATLAS_LOG_PRETTY: boolish(true),
});

export interface AtlasConfig {
  env: 'development' | 'production' | 'test';
  isProduction: boolean;
  server: { host: string; port: number; publicUrl: string; corsOrigins: string[] };
  security: { sessionSecret: string; founderEmail: string; founderPassword: string };
  paths: { dataDir: string; databaseFile: string; backupDir: string; artifactDir: string };
  backup: { retention: number };
  llm: {
    apiKey: string;
    /** Simulation mode is a first-class operating mode, not a stub. */
    mode: 'live' | 'simulation';
    hermesModel: string;
    agentModel: string;
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    maxTokens: number;
  };
  orchestration: {
    maxConcurrentMissions: number;
    maxConcurrentTasks: number;
    /** Borne d'une exécution d'outil, annulation réelle comprise. */
    toolTimeoutMs: number;
    /** Borne d'un appel à un fournisseur externe (inférence, découverte). */
    providerTimeoutMs: number;
    /** Borne d'une étape complète, outils compris. */
    taskTimeoutMs: number;
    /** Borne d'une mission entière ; 0 désactive. */
    missionTimeoutMs: number;
    taskMaxAttempts: number;
    /** Default token ceiling per mission; 0 disables it. */
    missionTokenBudget: number;
    /** How many times Hermes may replan one mission; 0 disables replanning. */
    maxReplansPerMission: number;
  };
  /**
   * Plafonds appliqués sous chaque appel au modèle.
   *
   * Distincts de `orchestration` : ceux-là s'appliquent entre les étapes, ceux-ci
   * à l'appel lui-même. LIVE #001 a montré que seul le second niveau protège
   * réellement — une étape déjà lancée ignore tout plafond situé au-dessus d'elle.
   */
  budget: BudgetConfig;
  /** Bornes de recherche web, ajustées à l'ampleur de l'objectif. */
  web: WebLimitsConfig;
  /** Le moteur de recherche et ce qu'il a le droit de consommer. */
  search: SearchConfig;
  n8n: { enabled: boolean; baseUrl: string; apiKey: string; webhookSecret: string };
  evolution: { enabled: boolean; autonomy: 'observe' | 'propose' | 'apply-low-risk' };
  runtime: { heartbeatMs: number };
  log: { level: 'debug' | 'info' | 'warn' | 'error'; pretty: boolean };
}

/** Minimal .env reader — avoids a dependency for a 20-line job. */
function loadDotEnv(cwd: string): void {
  const file = join(cwd, '.env');
  if (!existsSync(file)) return;

  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key in process.env) continue; // real env always wins

    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export function loadConfig(cwd = process.cwd()): AtlasConfig {
  loadDotEnv(cwd);

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new AtlasError(
      'BAD_REQUEST',
      `Invalid configuration. Copy .env.example to .env and fix:\n${issues}`,
    );
  }
  const e = parsed.data;

  const abs = (p: string) => (isAbsolute(p) ? p : resolve(cwd, p));
  const dataDir = abs(e.ATLAS_DATA_DIR);
  const backupDir = abs(e.ATLAS_BACKUP_DIR);
  const artifactDir = join(dataDir, 'artifacts');

  for (const dir of [dataDir, backupDir, artifactDir]) {
    mkdirSync(dir, { recursive: true });
  }

  const apiKey = e.ANTHROPIC_API_KEY.trim();

  const config: AtlasConfig = {
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    server: {
      host: e.ATLAS_HOST,
      port: e.ATLAS_PORT,
      publicUrl: e.ATLAS_PUBLIC_URL.replace(/\/+$/, ''),
      corsOrigins: e.ATLAS_CORS_ORIGINS.split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    },
    security: {
      sessionSecret: e.ATLAS_SESSION_SECRET,
      founderEmail: e.ATLAS_FOUNDER_EMAIL,
      founderPassword: e.ATLAS_FOUNDER_PASSWORD,
    },
    paths: { dataDir, databaseFile: join(dataDir, 'atlas.db'), backupDir, artifactDir },
    backup: { retention: e.ATLAS_BACKUP_RETENTION },
    llm: {
      apiKey,
      mode: apiKey ? 'live' : 'simulation',
      hermesModel: e.ATLAS_HERMES_MODEL,
      agentModel: e.ATLAS_AGENT_MODEL,
      effort: e.ATLAS_LLM_EFFORT,
      maxTokens: e.ATLAS_LLM_MAX_TOKENS,
    },
    budget: {
      maxMissionTokens: e.ATLAS_MISSION_TOKEN_BUDGET,
      maxMissionCostUsd: e.ATLAS_MAX_MISSION_COST_USD,
      maxStepTokens: e.ATLAS_MAX_STEP_TOKENS,
      maxCallsPerStep: e.ATLAS_MAX_LLM_CALLS_PER_STEP,
      maxOutputTokensPerCall: e.ATLAS_MAX_OUTPUT_TOKENS_PER_CALL,
      circuitBreakerFailures: e.ATLAS_CIRCUIT_BREAKER_FAILURES,
      minViableOutputTokens: e.ATLAS_MIN_VIABLE_OUTPUT_TOKENS,
    },
    search: {
      provider: e.ATLAS_SEARCH_PROVIDER,
      searxngBaseUrl: e.SEARXNG_BASE_URL,
      searxngEngines: e.SEARXNG_ENGINES,
      braveApiKey: e.BRAVE_SEARCH_API_KEY,
      costPerQueryUsd: e.ATLAS_SEARCH_COST_PER_QUERY_USD,
      fallbackEnabled: e.ATLAS_SEARCH_FALLBACK_ENABLED,
      timeoutMs: e.ATLAS_SEARCH_TIMEOUT_MS,
      resultsPerQuery: e.ATLAS_SEARCH_RESULTS_PER_QUERY,
      maxCandidates: e.ATLAS_SEARCH_MAX_CANDIDATES,
      maxCharsPerPage: e.ATLAS_SEARCH_MAX_CHARS_PER_PAGE,
      discoveryMaxContextTokens: e.ATLAS_DISCOVERY_MAX_CONTEXT_TOKENS,
    },
    web: {
      maxSearchesPerDiscovery: e.ATLAS_MAX_WEB_SEARCHES_PER_DISCOVERY,
      maxFetchesPerCandidate: e.ATLAS_MAX_PAGE_FETCHES_PER_CANDIDATE,
      maxTotalFetchesPerMission: e.ATLAS_MAX_TOTAL_PAGE_FETCHES_PER_MISSION,
    },
    orchestration: {
      maxConcurrentMissions: e.ATLAS_MAX_CONCURRENT_MISSIONS,
      maxConcurrentTasks: e.ATLAS_MAX_CONCURRENT_TASKS,
      toolTimeoutMs: e.ATLAS_TOOL_TIMEOUT_MS,
      providerTimeoutMs: e.ATLAS_PROVIDER_TIMEOUT_MS,
      taskTimeoutMs: e.ATLAS_TASK_TIMEOUT_MS,
      missionTimeoutMs: e.ATLAS_MISSION_TIMEOUT_MS,
      taskMaxAttempts: e.ATLAS_TASK_MAX_ATTEMPTS,
      missionTokenBudget: e.ATLAS_MISSION_TOKEN_BUDGET,
      maxReplansPerMission: e.ATLAS_MAX_REPLANS_PER_MISSION,
    },
    n8n: {
      enabled: e.ATLAS_N8N_ENABLED,
      baseUrl: e.ATLAS_N8N_BASE_URL.replace(/\/+$/, ''),
      apiKey: e.ATLAS_N8N_API_KEY,
      webhookSecret: e.ATLAS_N8N_WEBHOOK_SECRET,
    },
    evolution: { enabled: e.ATLAS_EVOLUTION_ENABLED, autonomy: e.ATLAS_EVOLUTION_AUTONOMY },
    runtime: { heartbeatMs: e.ATLAS_HEARTBEAT_MS },
    log: { level: e.ATLAS_LOG_LEVEL, pretty: e.ATLAS_LOG_PRETTY },
  };

  // Une configuration incohérente doit se voir au démarrage, pas après une
  // mission facturée.
  assertTimeoutHierarchy(config.orchestration);
  return config;
}

/**
 * Les délais emboîtés, du plus interne au plus externe.
 *
 * L'ordre n'est pas une convention : chaque niveau *contient* le précédent.
 * Un outil enveloppe l'appel fournisseur qu'il déclenche, une étape enveloppe
 * ses outils, une mission enveloppe ses étapes.
 */
const TIMEOUT_LEVELS = [
  { key: 'providerTimeoutMs', env: 'ATLAS_PROVIDER_TIMEOUT_MS', what: "un appel au fournisseur" },
  { key: 'toolTimeoutMs', env: 'ATLAS_TOOL_TIMEOUT_MS', what: "l'exécution d'un outil" },
  { key: 'taskTimeoutMs', env: 'ATLAS_TASK_TIMEOUT_MS', what: 'une étape entière' },
  { key: 'missionTimeoutMs', env: 'ATLAS_MISSION_TIMEOUT_MS', what: 'une mission entière' },
] as const;

export interface TimeoutViolation {
  inner: string;
  outer: string;
  message: string;
}

/**
 * Vérifie que chaque délai laisse vivre celui qu'il contient.
 *
 * LIVE #003 s'est arrêtée sur cette exacte incohérence : le délai d'outil
 * valait 120 s et le délai fournisseur 180 s. Comme l'outil enveloppe l'appel,
 * la borne extérieure était la plus serrée — le délai fournisseur ne pouvait
 * jamais s'exprimer, et toute recherche web dépassant deux minutes était tuée.
 * Rien dans les journaux ne désignait la cause ; il a fallu la déduire après
 * coup, pour 0,38 $.
 *
 * L'égalité est refusée autant que l'inversion : deux bornes qui expirent au
 * même instant produisent une course dont l'issue dépend de l'ordonnanceur, et
 * donc un diagnostic différent d'une exécution à l'autre.
 */
export function checkTimeoutHierarchy(
  orchestration: AtlasConfig['orchestration'],
): TimeoutViolation[] {
  const violations: TimeoutViolation[] = [];

  for (let i = 0; i < TIMEOUT_LEVELS.length - 1; i++) {
    const inner = TIMEOUT_LEVELS[i]!;
    const outer = TIMEOUT_LEVELS[i + 1]!;
    const innerMs = orchestration[inner.key];
    const outerMs = orchestration[outer.key];

    // 0 vaut « pas de borne » : rien à comparer.
    if (innerMs <= 0 || outerMs <= 0) continue;
    if (outerMs > innerMs) continue;

    violations.push({
      inner: inner.env,
      outer: outer.env,
      message:
        `${outer.env}=${outerMs} borne ${outer.what}, qui contient ${inner.what} borné par ` +
        `${inner.env}=${innerMs}. La borne extérieure étant ${outerMs === innerMs ? 'égale à' : 'plus courte que'} ` +
        `l'intérieure, ${inner.env} ne pourra jamais s'appliquer` +
        `${outerMs === innerMs ? ' de façon déterministe' : ''}. ` +
        `Donnez à ${outer.env} une valeur strictement supérieure à ${innerMs}.`,
    });
  }
  return violations;
}

/** Refuse de démarrer sur une hiérarchie de délais impossible. */
export function assertTimeoutHierarchy(orchestration: AtlasConfig['orchestration']): void {
  const violations = checkTimeoutHierarchy(orchestration);
  if (violations.length === 0) return;

  throw new AtlasError(
    'BAD_REQUEST',
    ['Configuration des délais incohérente — ATLAS refuse de démarrer :']
      .concat(violations.map((v) => `  • ${v.message}`))
      .join('\n'),
  );
}
