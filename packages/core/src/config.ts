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
  provider: 'auto' | 'duckduckgo' | 'marginalia' | 'searxng' | 'brave' | 'anthropic' | 'none';
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
  /**
   * Le fichier de base, quand il n'est pas `<ATLAS_DATA_DIR>/atlas.db` — pour
   * ouvrir volontairement une copie, une archive, une sauvegarde. Absent en
   * production : le serveur et atlas-cli lisent tous deux /data/atlas.db.
   */
  ATLAS_DB_PATH: z.string().optional(),
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
  // `duckduckgo` interroge le moteur en direct : ni clé, ni quota, ni service à
  // héberger. C'est le seul provider qui fonctionne sans infrastructure, donc le
  // défaut — SearXNG reste préférable en production, quand Docker est
  // disponible, parce qu'il fusionne plusieurs moteurs.
  // ─── Mode d'exécution ──────────────────────────────────────────────────────
  // Jusqu'ici le mode se déduisait de la présence d'une clé : poser une clé
  // dans .env suffisait à faire basculer ATLAS en dépense réelle sans que
  // personne l'ait demandé. C'est exactement ce qui s'est produit — le serveur
  // a démarré en `live` alors que l'intention était de faire une démonstration.
  //
  // Le mode se déclare désormais. `auto` conserve l'ancien comportement pour ne
  // rien casser, mais `live` exige une clé et `simulation` interdit toute
  // dépense, quelle que soit la configuration par ailleurs.
  ATLAS_EXECUTION_MODE: z.enum(['auto', 'simulation', 'live']).default('auto'),

  // Modèles interdits, séparés par des virgules.
  //
  // Opus par défaut, et ce n'est pas de la prudence excessive : il facture dix-
  // huit fois le tarif de Haiku, pour un travail d'extraction où la différence
  // ne se voit pas. L'écart entre une mission à 0,04 $ et la même à 0,72 $ tient
  // à un mot dans un fichier de configuration — mieux vaut devoir l'autoriser
  // explicitement que découvrir la facture après coup.
  ATLAS_FORBIDDEN_MODELS: z.string().default('claude-opus'),

  // Modèles autorisés. Vide = tous, hors interdits. Renseigné, c'est une liste
  // blanche stricte : rien d'autre ne passe, y compris un modèle qu'un agent
  // porterait dans sa propre définition.
  ATLAS_ALLOWED_MODELS: z.string().default(''),

  // `auto` enregistre tout ce qui est configuré et laisse le Search Fabric
  // router à chaque requête selon l'état réel du parc. Nommer un moteur reste
  // possible — c'est utile pour reproduire un incident — mais c'est alors un
  // parc d'un seul moteur, avec le point de défaillance unique que cela
  // suppose : deux jours d'attente que DuckDuckGo relâche son bridage.
  ATLAS_SEARCH_PROVIDER: z
    .enum(['auto', 'duckduckgo', 'marginalia', 'searxng', 'brave', 'anthropic', 'none'])
    .default('auto'),
  // Une instance persistante — locale ou privée distante — se branche ici sans
  // toucher au code. Le défaut vise le réseau Docker ; en développement,
  // http://localhost:8080 convient.
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

  // ─── La boucle commerciale autonome ───────────────────────────────────
  // Le verrou d'approbation est le seul reglage dont la valeur par defaut
  // engage quelqu'un : il vaut `true`, et le passer a `false` autorise ATLAS
  // a ecrire a des inconnus sans relecture. Il reste donc un choix explicite.
  ATLAS_SALES_HUMAN_APPROVAL: boolish(true),
  ATLAS_SALES_MIN_CONVERSION_SCORE: intish(60, 0, 100),
  ATLAS_SALES_MAX_NEW_OUTREACH_PER_DAY: intish(10, 0, 200),
  ATLAS_SALES_MAX_BUDGET_USD: floatish(0.1, 0, 5),
  ATLAS_SALES_WALL_CLOCK_MS: intish(1_800_000, 60_000, 14_400_000),
  ATLAS_SALES_MAX_DOMAINS_PER_RUN: intish(40, 1, 500),
  ATLAS_SALES_MAX_PAGES_PER_DOMAIN: intish(8, 1, 40),
  // Les prospects deja retenus en PRIORITY meritent d'etre lus plus loin : ce
  // sont les seuls dont un brouillon peut sortir, et le seul motif de blocage
  // observe est le manque de faits sources. La profondeur ne vaut que pour eux
  // — l'elargir a tous multiplierait les requetes sans changer une decision.
  ATLAS_SALES_MAX_PAGES_PER_PRIORITY_DOMAIN: intish(15, 1, 60),
  ATLAS_SALES_CONCURRENCY: intish(4, 1, 16),
  // Trois jours ouvres au minimum, et le plancher est aussi tenu par
  // `evaluateFollowUp` : une relance a vingt-quatre heures ne lit pas comme une
  // relance. Un delai plus long reste libre.
  ATLAS_SALES_FOLLOW_UP_AFTER_DAYS: intish(3, 3, 60),
  // Le nom qui signe les messages. Vide, le gabarit s'arrete sur la formule de
  // politesse — un courriel non signe se remarque, mais inventer un nom serait
  // pire.
  ATLAS_SALES_SENDER_NAME: z.string().default('Noa Roy'),

  // --- Le moteur commercial en production -----------------------------
  // `ATLAS_OUTBOUND_ENABLED` est l'interrupteur general de l'envoi. Faux par
  // defaut, et faux au premier deploiement : un serveur neuf qui tourne
  // 24 h/24 decouvre et qualifie, mais n'ecrit a personne tant qu'une personne
  // n'a pas leve cet interrupteur en connaissance de cause.
  ATLAS_OUTBOUND_ENABLED: boolish(false),
  // INTERNAL_TEST ne contacte jamais un vrai prospect, quel que soit l'etat
  // des autres reglages. PRODUCTION est un choix explicite.
  ATLAS_ENGINE_MODE: z.enum(['INTERNAL_TEST', 'PRODUCTION']).default('INTERNAL_TEST'),
  // Le planificateur des cycles commerciaux (decouverte, relances, lecture de
  // la boite, mesures, recommandations). Le couper arrete la cadence, pas
  // les commandes manuelles.
  ATLAS_SALES_ENGINE_ENABLED: boolish(true),
  ATLAS_SALES_DISCOVERY_ENABLED: boolish(true),
  ATLAS_SALES_DAILY_AI_BUDGET_USD: floatish(0.5, 0, 50),
  ATLAS_SALES_DAILY_SEARCH_BUDGET: intish(200, 0, 5000),
  ATLAS_SALES_HOURLY_SEND_CAP: intish(3, 0, 100),
  ATLAS_SALES_MIN_SEND_DELAY_SECONDS: intish(120, 0, 86_400),
  // Fenetre d'envoi, heure locale du fuseau ci-dessous : « 09:00-17:30 ».
  ATLAS_SALES_SEND_WINDOW: z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/).default('09:00-17:30'),
  ATLAS_SALES_WEEKEND_ENABLED: boolish(false),
  ATLAS_SALES_TIMEZONE: z.string().default('Europe/Paris'),
  // Une seule relance par entreprise : c'est aussi la borne de `follow-up.ts`.
  ATLAS_SALES_MAX_FOLLOWUPS: intish(1, 0, 1),
  // Au-dela de ce taux de rebonds sur l'echantillon minimal, l'envoi se met
  // en pause tout seul et le dit.
  ATLAS_SALES_BOUNCE_PAUSE_RATE: floatish(0.05, 0, 1),
  ATLAS_SALES_BOUNCE_MIN_SAMPLE: intish(20, 1, 1000),

  // --- Les workers IA ---------------------------------------------------
  // `live` est le seul reglage dont la valeur par defaut engage de l'argent.
  // Il vaut `false` : tant qu'il n'est pas leve explicitement, aucun appel
  // payant ne part, et les demonstrations tournent sur des fournisseurs figes.
  ATLAS_AI_LIVE: boolish(false),
  ATLAS_OPENAI_MODEL: z.string().default('gpt-5'),
  ATLAS_OPENAI_REVIEW_MODEL: z.string().default(''),
  ATLAS_ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  ATLAS_ANTHROPIC_ENGINEERING_MODEL: z.string().default(''),
  ATLAS_OPENAI_API_KEY: z.string().default(''),
  ATLAS_OPENAI_TASK_TIMEOUT_MS: intish(120_000, 5_000, 900_000),
  ATLAS_CLAUDE_TASK_TIMEOUT_MS: intish(600_000, 5_000, 3_600_000),
  ATLAS_MAX_AI_CHAIN_DEPTH: intish(4, 1, 20),
  ATLAS_MAX_AI_TASKS_PER_CHAIN: intish(12, 1, 200),
  ATLAS_MAX_CHAIN_COST_USD: floatish(1, 0, 100),
  ATLAS_MAX_CHAIN_RUNTIME_MINUTES: intish(60, 1, 1440),
  ATLAS_AI_DAILY_BUDGET_USD: floatish(0, 0, 1000),
  ATLAS_AI_MONTHLY_BUDGET_USD: floatish(0, 0, 10000),
  ATLAS_MAX_TASK_COST_USD: floatish(0, 0, 100),

  // --- L'ingenierie reelle ----------------------------------------------
  // Des garde-fous de taille, parce qu'une mission simple ne doit pas pouvoir
  // reecrire la moitie du depot. Aucun n'est illimite par defaut.
  ATLAS_MAX_FILES_CHANGED_PER_TASK: intish(15, 1, 500),
  ATLAS_MAX_DIFF_LINES_PER_TASK: intish(800, 10, 50_000),
  ATLAS_MAX_ENGINEERING_ITERATIONS: intish(3, 1, 20),
  ATLAS_ENGINEERING_WORKSPACE_ROOT: z.string().default(''),
  // La suppression de fichier est refusee par defaut, et s'autorise tache par
  // tache : c'est la seule operation d'edition qu'on ne peut pas relire dans un
  // diff aussi facilement qu'on la subit.
  ATLAS_ALLOW_FILE_DELETE: boolish(false),
  /**
   * Ce que vaut un plafond de cout quand le prix est inconnu.
   *
   * `BLOCK` arrete la chaine plutot que de la laisser courir sur un tarif
   * qu'on ne sait pas calculer. C'est la valeur par defaut : un plafond aveugle
   * n'est pas un plafond.
   */
  ATLAS_UNKNOWN_COST_POLICY: z.enum(['BLOCK', 'ALLOW']).default('BLOCK'),
  // Le binaire Claude Code. Resolu dans le PATH par defaut ; son absence est
  // une situation normale, rapportee comme telle plutot que comme un echec.
  ATLAS_CLAUDE_CODE_BIN: z.string().default('claude'),
  ATLAS_CLAUDE_CODE_TIMEOUT_MS: intish(900_000, 30_000, 7_200_000),
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
    /** Ce qui a été déclaré, avant résolution : `auto` déduit de la clé. */
    declaredMode: 'auto' | 'simulation' | 'live';
    /** Modèles que ce déploiement refuse d'appeler, quoi qu'on lui demande. */
    forbiddenModels: string[];
    /** Liste blanche. Vide = tout ce qui n'est pas interdit. */
    allowedModels: string[];
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
  /**
   * La boucle commerciale : ce qu'elle cherche, ce qu'elle depense, et ce
   * qu'elle n'a pas le droit de faire seule.
   */
  sales: {
    /** Tant qu'il est vrai, aucun message ne part sans decision humaine. */
    humanApprovalRequired: boolean;
    minConversionScore: number;
    maxNewOutreachPerDay: number;
    maxBudgetUsd: number;
    wallClockMs: number;
    maxDomainsPerRun: number;
    maxPagesPerDomain: number;
    /** Profondeur reservee aux PRIORITY, seuls candidats a un brouillon. */
    maxPagesPerPriorityDomain: number;
    concurrency: number;
    followUpAfterDays: number;
    /** Le nom qui signe les messages sortants. Vide = aucune signature. */
    senderName: string;
    /** L'interrupteur general de l'envoi. Faux tant qu'une personne ne l'a pas leve. */
    outboundEnabled: boolean;
    /** INTERNAL_TEST n'ecrit jamais a un vrai prospect. */
    engineMode: 'INTERNAL_TEST' | 'PRODUCTION';
    engineEnabled: boolean;
    discoveryEnabled: boolean;
    dailyAiBudgetUsd: number;
    dailySearchBudget: number;
    hourlySendCap: number;
    minSendDelaySeconds: number;
    /** « HH:MM-HH:MM », heure locale de `timezone`. */
    sendWindow: string;
    weekendEnabled: boolean;
    timezone: string;
    maxFollowUps: number;
    bouncePauseRate: number;
    bounceMinSample: number;
  };
  /**
   * Les workers de modele, et les bornes qui les empechent de s'emballer.
   *
   * `live` separe deux mondes : a faux, les fournisseurs sont figes et rien
   * n'est facture ; a vrai, chaque tache depense. La valeur par defaut est
   * fausse, et le passage a vrai est une decision.
   */
  ai: {
    live: boolean;
    openaiModel: string;
    openaiReviewModel: string;
    anthropicModel: string;
    anthropicEngineeringModel: string;
    openaiTimeoutMs: number;
    claudeTimeoutMs: number;
    maxChainDepth: number;
    maxTasksPerChain: number;
    maxChainCostUsd: number;
    maxChainRuntimeMinutes: number;
    /**
     * Les plafonds de depense.
     *
     * Zero ne signifie plus « illimite » : le mode l'exprime explicitement, et
     * la valeur ne sert que lorsque le mode vaut CONFIGURED. Confondre les deux
     * faisait lire « aucune limite » la ou l'on avait ecrit « zero ».
     */
    dailyBudgetUsd: number;
    monthlyBudgetUsd: number;
    maxTaskCostUsd: number;
    dailyBudgetMode: 'UNLIMITED' | 'CONFIGURED' | 'DISABLED';
    monthlyBudgetMode: 'UNLIMITED' | 'CONFIGURED' | 'DISABLED';
    /** Ce qu'on fait d'une chaine dont le cout n'est pas calculable. */
    unknownCostPolicy: 'BLOCK' | 'ALLOW';
  };
  /** L'ingenierie reelle : ce qu'une tache a le droit de changer. */
  engineering: {
    maxFilesChanged: number;
    maxDiffLines: number;
    maxIterations: number;
    workspaceRoot: string;
    allowFileDelete: boolean;
    /** Le binaire Claude Code, et le temps qu'on lui laisse. */
    claudeCodeBin: string;
    claudeCodeTimeoutMs: number;
  };
  runtime: { heartbeatMs: number };
  log: { level: 'debug' | 'info' | 'warn' | 'error'; pretty: boolean };
}

/**
 * La seule facon de charger l'environnement d'ATLAS.
 *
 * Trois sources, dans cet ordre de priorite :
 *
 *   1. `process.env` — l'environnement reel gagne toujours. Une variable posee
 *      sur la ligne de commande ou par le service systeme doit pouvoir passer
 *      devant un fichier, sans quoi on ne peut plus rien surcharger.
 *   2. `.env.local` — les secrets obtenus par un amorcage local, comme un jeton
 *      de rafraichissement OAuth. Jamais partage, jamais commite, jamais fusionne.
 *   3. `.env` — la configuration partagee, qui peut rester lisible parce que rien
 *      de secret n'a besoin d'y figurer.
 *
 * Exportee, et non plus privee, parce que l'oubli etait silencieux. Dix-sept
 * scripts ne chargeaient rien du tout : `sales:inbox-sync` voyait Gmail
 * « non configure » a la seconde ou `gmail:check` lisait dix mille messages dans
 * la vraie boite. Aucune erreur, aucun avertissement — deux processus, deux
 * environnements, et le meme disque.
 *
 * Idempotente : la relire ne change rien, puisque tout ce qui est deja dans
 * `process.env` est laisse en place.
 */
export function loadAtlasEnv(cwd: string = process.cwd()): void {
  for (const name of ['.env.local', '.env']) loadEnvFile(join(cwd, name));
}

function loadEnvFile(file: string): void {
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

/**
 * La garde de la base canonique.
 *
 * Sur le serveur, ATLAS tourne dans Docker et sa base vit dans le volume
 * `atlas-data`, montée en /data. Une commande lancée depuis l'hôte, dans le
 * même dépôt, ouvrirait — ou créerait — ./data/atlas.db : une seconde base,
 * silencieuse, sans daemon ni tableau de bord, qui ne dirait jamais qu'elle
 * n'est pas la bonne. C'est arrivé : les benchmarks INTERNAL_TEST de l'hôte
 * et la production du conteneur ont vécu dans deux fichiers.
 *
 * Le dépôt déployé se reconnaît à `deployment/docker-compose.private.yml`,
 * le fichier propre au serveur qui n'existe nulle part ailleurs ; ou à
 * `ATLAS_CANONICAL_DB=docker`, posé exprès. Dans ce dépôt, ouvrir la base
 * par défaut de l'hôte est refusé, et le message dit quoi lancer à la place.
 *
 * La garde se tait quand le choix est explicite : dans le conteneur outils
 * (`ATLAS_CLI_CONTEXT=docker`, posé par Compose), avec un `ATLAS_DB_PATH`
 * choisi, avec un `ATLAS_DATA_DIR` qui n'est pas ./data (tests, copies), ou
 * avec `ATLAS_ALLOW_HOST_DB=1` — pour lire l'archive en connaissance de cause.
 */
export function canonicalDatabaseGuard(input: {
  cwd: string;
  dataDir: string;
  env: Record<string, string | undefined>;
}): { blocked: boolean; reason: string | null } {
  const env = input.env;
  if (env.ATLAS_CLI_CONTEXT === 'docker') return { blocked: false, reason: null };
  if (env.ATLAS_DB_PATH && env.ATLAS_DB_PATH.trim() !== '') return { blocked: false, reason: null };
  if (/^(1|true|yes|on)$/i.test((env.ATLAS_ALLOW_HOST_DB ?? '').trim())) return { blocked: false, reason: null };
  const defaut = resolve(input.cwd, 'data');
  if (resolve(input.dataDir) !== defaut) return { blocked: false, reason: null };
  const marque = existsSync(join(input.cwd, 'deployment', 'docker-compose.private.yml'))
    ? 'deployment/docker-compose.private.yml présent : ce dépôt est déployé par Docker Compose'
    : env.ATLAS_CANONICAL_DB === 'docker' ? 'ATLAS_CANONICAL_DB=docker' : null;
  if (!marque) return { blocked: false, reason: null };
  return {
    blocked: true,
    reason: [
      `Base canonique dans Docker (${marque}).`,
      `Refus d’ouvrir ${join(defaut, 'atlas.db')} : ce serait une seconde base, hors du volume atlas-data que le serveur et le tableau de bord utilisent.`,
      'Lancer la commande dans le conteneur outils : ./deployment/atlas-cli.sh <commande> … (même volume, même réseau, même .env).',
      'Pour lire volontairement une base de l’hôte : ATLAS_DB_PATH=<fichier> ou ATLAS_ALLOW_HOST_DB=1.',
    ].join('\n'),
  };
}

export function loadConfig(cwd = process.cwd()): AtlasConfig {
  loadAtlasEnv(cwd);

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
  const databaseFile = e.ATLAS_DB_PATH && e.ATLAS_DB_PATH.trim() !== '' ? abs(e.ATLAS_DB_PATH.trim()) : join(dataDir, 'atlas.db');

  // Avant de créer quoi que ce soit : sur le dépôt déployé, la base de l'hôte
  // n'est pas la bonne, et on ne la crée pas non plus.
  const garde = canonicalDatabaseGuard({ cwd, dataDir, env: process.env });
  if (garde.blocked) throw new AtlasError('FORBIDDEN', garde.reason ?? 'base canonique dans Docker', { details: { reason: 'HOST_DB_GUARD' } });

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
    paths: { dataDir, databaseFile, backupDir, artifactDir },
    backup: { retention: e.ATLAS_BACKUP_RETENTION },
    llm: {
      apiKey,
      // Le mode déclaré l'emporte. `simulation` gagne même contre une clé
      // présente : c'est le seul moyen de garantir qu'une démonstration ne
      // dépensera rien.
      mode:
        e.ATLAS_EXECUTION_MODE === 'simulation'
          ? 'simulation'
          : e.ATLAS_EXECUTION_MODE === 'live'
            ? 'live'
            : apiKey
              ? 'live'
              : 'simulation',
      declaredMode: e.ATLAS_EXECUTION_MODE,
      forbiddenModels: e.ATLAS_FORBIDDEN_MODELS.split(',')
        .map((m) => m.trim())
        .filter(Boolean),
      allowedModels: e.ATLAS_ALLOWED_MODELS.split(',')
        .map((m) => m.trim())
        .filter(Boolean),
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
    sales: {
      humanApprovalRequired: e.ATLAS_SALES_HUMAN_APPROVAL,
      minConversionScore: e.ATLAS_SALES_MIN_CONVERSION_SCORE,
      maxNewOutreachPerDay: e.ATLAS_SALES_MAX_NEW_OUTREACH_PER_DAY,
      maxBudgetUsd: e.ATLAS_SALES_MAX_BUDGET_USD,
      wallClockMs: e.ATLAS_SALES_WALL_CLOCK_MS,
      maxDomainsPerRun: e.ATLAS_SALES_MAX_DOMAINS_PER_RUN,
      maxPagesPerDomain: e.ATLAS_SALES_MAX_PAGES_PER_DOMAIN,
      maxPagesPerPriorityDomain: Math.max(
        e.ATLAS_SALES_MAX_PAGES_PER_DOMAIN,
        e.ATLAS_SALES_MAX_PAGES_PER_PRIORITY_DOMAIN,
      ),
      concurrency: e.ATLAS_SALES_CONCURRENCY,
      followUpAfterDays: e.ATLAS_SALES_FOLLOW_UP_AFTER_DAYS,
      senderName: e.ATLAS_SALES_SENDER_NAME.trim(),
      outboundEnabled: e.ATLAS_OUTBOUND_ENABLED,
      engineMode: e.ATLAS_ENGINE_MODE,
      engineEnabled: e.ATLAS_SALES_ENGINE_ENABLED,
      discoveryEnabled: e.ATLAS_SALES_DISCOVERY_ENABLED,
      dailyAiBudgetUsd: e.ATLAS_SALES_DAILY_AI_BUDGET_USD,
      dailySearchBudget: e.ATLAS_SALES_DAILY_SEARCH_BUDGET,
      hourlySendCap: e.ATLAS_SALES_HOURLY_SEND_CAP,
      minSendDelaySeconds: e.ATLAS_SALES_MIN_SEND_DELAY_SECONDS,
      sendWindow: e.ATLAS_SALES_SEND_WINDOW,
      weekendEnabled: e.ATLAS_SALES_WEEKEND_ENABLED,
      timezone: e.ATLAS_SALES_TIMEZONE,
      maxFollowUps: e.ATLAS_SALES_MAX_FOLLOWUPS,
      bouncePauseRate: e.ATLAS_SALES_BOUNCE_PAUSE_RATE,
      bounceMinSample: e.ATLAS_SALES_BOUNCE_MIN_SAMPLE,
    },
    ai: {
      live: e.ATLAS_AI_LIVE,
      openaiModel: e.ATLAS_OPENAI_MODEL,
      openaiReviewModel: e.ATLAS_OPENAI_REVIEW_MODEL || e.ATLAS_OPENAI_MODEL,
      anthropicModel: e.ATLAS_ANTHROPIC_MODEL,
      anthropicEngineeringModel: e.ATLAS_ANTHROPIC_ENGINEERING_MODEL || e.ATLAS_ANTHROPIC_MODEL,
      openaiTimeoutMs: e.ATLAS_OPENAI_TASK_TIMEOUT_MS,
      claudeTimeoutMs: e.ATLAS_CLAUDE_TASK_TIMEOUT_MS,
      maxChainDepth: e.ATLAS_MAX_AI_CHAIN_DEPTH,
      maxTasksPerChain: e.ATLAS_MAX_AI_TASKS_PER_CHAIN,
      maxChainCostUsd: e.ATLAS_MAX_CHAIN_COST_USD,
      maxChainRuntimeMinutes: e.ATLAS_MAX_CHAIN_RUNTIME_MINUTES,
      dailyBudgetUsd: e.ATLAS_AI_DAILY_BUDGET_USD,
      monthlyBudgetUsd: e.ATLAS_AI_MONTHLY_BUDGET_USD,
      maxTaskCostUsd: e.ATLAS_MAX_TASK_COST_USD,
      // Un plafond a zero est une absence de plafond declaree, pas un plafond
      // nul : le mode le dit, la valeur ne sert que s'il vaut CONFIGURED.
      dailyBudgetMode: e.ATLAS_AI_DAILY_BUDGET_USD > 0 ? 'CONFIGURED' : 'UNLIMITED',
      monthlyBudgetMode: e.ATLAS_AI_MONTHLY_BUDGET_USD > 0 ? 'CONFIGURED' : 'UNLIMITED',
      unknownCostPolicy: e.ATLAS_UNKNOWN_COST_POLICY,
    },
    engineering: {
      maxFilesChanged: e.ATLAS_MAX_FILES_CHANGED_PER_TASK,
      maxDiffLines: e.ATLAS_MAX_DIFF_LINES_PER_TASK,
      maxIterations: e.ATLAS_MAX_ENGINEERING_ITERATIONS,
      workspaceRoot: e.ATLAS_ENGINEERING_WORKSPACE_ROOT,
      allowFileDelete: e.ATLAS_ALLOW_FILE_DELETE,
      claudeCodeBin: e.ATLAS_CLAUDE_CODE_BIN,
      claudeCodeTimeoutMs: e.ATLAS_CLAUDE_CODE_TIMEOUT_MS,
    },
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
