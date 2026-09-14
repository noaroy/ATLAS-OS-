import type { Logger } from '@atlas/core';
import { nowIso } from '@atlas/core';
import type { Repositories } from '@atlas/data';
import type { LlmProvider } from '@atlas/llm';
import { textOf } from '@atlas/llm';
import {
  filterResults, planQueries, canonicalKey, normaliseDomain as normaliseHost,
  type SearchProvider, type SearchProviderContext, type DiscoveryQuery,
} from '@atlas/intelligence';
import {
  type ClientBrief, parseClientBrief, adjustBrief, normaliseDomain, allCriteria,
  buildBlockCatalogue, pageTitle, resolveContacts,
  extractCountryEvidence, collectCountrySignals, corroborateCountry, countryFit,
  collectIdentitySignals, corroborateIdentity,
  criteriaSchema, criteriaPrompt, CRITERIA_SYSTEM, resolveQualification, scanCompetitors,
  decideCandidate, scoreCriteria,
  siteLinks, planPages, relevancePrecheck, extractSiteFacts, selectBlocksForModel, generalistRisk, rankContactChannels,
  triageCandidate,
  type CriterionResult, type CompetitorHit, type SpecialisationResult, type CandidateDecision, type TriageStatus,
} from '@atlas/departments';
import { sha256, type ClientCandidate } from '@atlas/data';

/**
 * Une mission client, conduite par lots, sans agent.
 *
 * L'orchestrateur agent a échoué cinq fois sur cinq à l'étape recherche : il
 * enrichissait et cherchait des contacts pendant la découverte, et son budget
 * de jetons partait avant la qualification. Ici rien n'est laissé à un modèle
 * sauf ce qui relève du jugement — lire des passages numérotés et dire ce
 * qu'ils établissent. Tout le reste est du code, dans un ordre fixe :
 *
 *   brief → requêtes → moteur → filtre → dédoublonnage → pages → pays →
 *   concurrents → qualification par critère → contacts → note → écriture
 *
 * Chaque candidat est écrit dès qu'il est traité, avec son état. Une erreur
 * sur le soixantième ne touche pas aux cinquante-neuf premiers ; une mission
 * interrompue reprend à la ligne suivante ; un candidat terminé n'est jamais
 * retraité ni repayé. Le rapport, lui, lit tous les lots d'une mission.
 */
export interface ClientMissionDeps {
  repos: Repositories;
  search: SearchProvider;
  /**
   * Lit des pages. Rend la liste des pages, ou — mieux — les pages avec les
   * tentatives et les échecs : c'est ce qui permet de mesurer le temps perdu
   * sur les sites qui ne répondent pas, pas seulement le temps passé.
   */
  fetchPages: (urls: readonly string[], maxPages: number, options?: { timeoutMs?: number }) => Promise<Array<{ url: string; html: string }> | FetchedPages>;
  llm: Pick<LlmProvider, 'complete'>;
  model: string;
  logger: Logger;
  now?: () => string;
  /** Coût prudent d'une qualification, pour le contrôle avant appel. Mesuré : 0,004–0,012 $. */
  estimatedCostPerCandidateUsd?: number;
}

export interface FetchedPages {
  pages: Array<{ url: string; html: string }>;
  attempts: number;
  failures: Array<{ url: string; kind: string; reason: string }>;
}

/** Les postes de temps d'un candidat, en millisecondes. Mesurés, jamais estimés. */
export interface CandidateTiming {
  fetch: number; parse: number; country: number; identity: number; competitors: number;
  llm: number; contacts: number; persist: number; total: number;
}

const PHASES: ReadonlyArray<keyof Omit<CandidateTiming, 'total'>> = ['fetch', 'parse', 'country', 'identity', 'competitors', 'llm', 'contacts', 'persist'];

const timingVide = (): CandidateTiming => ({ fetch: 0, parse: 0, country: 0, identity: 0, competitors: 0, llm: 0, contacts: 0, persist: 0, total: 0 });

/**
 * Ce qu'un lot a mesuré de lui-même. Quatre familles — recherche, filtre,
 * traitement, qualité — et le temps par poste. Ce sont ces chiffres qui
 * permettent de comparer un lot d'avant à un lot d'après : sans eux, une
 * « optimisation » est une impression.
 */
export interface BatchMetrics {
  search: { queries: number; rawResults: number; uniqueDomains: number; ms: number; yields: number[]; stoppedBecause: string | null };
  filter: { directoryExcluded: number; noTextExcluded: number; relevanceExcluded: number; countryExcluded: number; competitorExcluded: number };
  process: {
    candidates: number;
    /** Requêtes réseau réellement faites, échecs compris. */
    pagesAttempted: number;
    /** Pages obtenues par le réseau. */
    pagesFetched: number;
    /** Pages lues au total, mémoire comprise — ce que les candidats ont eu sous les yeux. */
    pagesRead: number;
    pagesUseful: number;
    fetchFailures: number; fetchTimeouts: number;
    /** Entrées servies par la mémoire, pages et échecs confondus. */
    cacheHits: number;
    llmCalls: number; llmCached: number; inputTokens: number; outputTokens: number; costUsd: number;
  };
  quality: {
    retained: number; reviewRequired: number; excluded: number; failed: number; toConfirmTotal: number; candidatesWithToConfirm: number;
    autoApproved: number; humanReview: number; autoExcluded: number;
  };
  timing: CandidateTiming & { batchMs: number; avgCandidateMs: number; concurrency: number; slowest: Array<{ domain: string; ms: number; fetch: number; llm: number }> };
}

export interface ClientRunContext {
  kind: 'client-mission';
  briefs: ClientBrief[];
  batches: BatchSummary[];
  /** L'état du pilote automatique, s'il a été engagé sur cette mission. */
  autopilot?: Record<string, unknown>;
}

export interface BatchSummary {
  batch: number;
  briefVersion: number;
  startedAt: string;
  finishedAt: string;
  queriesRun: number;
  rawResults: number;
  discovered: number;
  filteredOut: number;
  processed: number;
  retained: number;
  reviewRequired: number;
  excluded: number;
  failed: number;
  costUsd: number;
  stoppedBecause: string | null;
  /** Absent sur les lots écrits avant l'instrumentation. */
  metrics?: BatchMetrics;
}

export interface BatchOptions {
  runId: string;
  batchSize: number;
  maxQueries?: number;
  /** Plafond de dépense modèle pour toute la mission. */
  runBudgetUsd: number;
  /** Plafond pour ce lot seul. */
  batchBudgetUsd: number;
  /** Plafond quotidien global (toutes missions), 0 = non configuré. */
  dailyBudgetUsd: number;
  /** Ne découvre rien : reprend seulement ce qui est en attente. */
  resumeOnly?: boolean;
  /** Combien de candidats de front. Quatre par défaut ; un pour un lot strictement séquentiel. */
  concurrency?: number;
  /** Lire et juger en passant par la mémoire des pages et des qualifications. Vrai par défaut. */
  cache?: boolean;
  /**
   * Le coupe-circuit : consulté avant chaque candidat. Vrai = finir le
   * candidat en cours, écrire, et rendre la main — rien d'entamé n'est perdu.
   */
  shouldStop?: () => boolean;
  /** Domaines à ne pas retraiter, en plus de ceux du brief. */
  exclude?: string[];
  /**
   * Des sociétés nommées à qualifier sans recherche : celles que le client
   * cite, celles qu'un moteur a rendues hier, celles à reprendre après un
   * correctif. Inscrites comme découvertes, traitées comme les autres.
   */
  seedDomains?: string[];
  createdBy: string;
}

/**
 * Les valeurs par défaut de `client:mission batch`, en un seul endroit.
 *
 * Le preflight affichait « plafond mission 0.4 $ » en lisant
 * ATLAS_MAX_MISSION_COST_USD — une valeur que ce pipeline n'applique pas :
 * le lot écrase le plafond du ledger par --budget. Deux écrans, deux vérités.
 * Ici la seule : ce que `batch` appliquera, lu aussi par le preflight.
 */
export const CLIENT_BATCH_DEFAULTS = Object.freeze({
  batchSize: 20,
  maxQueries: 8,
  /** Plafond cumulé de la mission (tous lots, tous jours), en dollars. */
  runBudgetUsd: 1.0,
  /** Plafond d'un lot seul, en dollars. */
  batchBudgetUsd: 0.4,
});

export interface ClientBudgetLimits {
  /** Cumulé sur toute la mission — `--budget`, sinon le défaut. */
  mission: { usd: number; source: '--budget' | 'défaut --budget' };
  /** Ce lot seul — `--batch-budget`, sinon le défaut. */
  batch: { usd: number; source: '--batch-budget' | 'défaut --batch-budget' };
  /** Toutes missions confondues, par jour UTC — ATLAS_AI_DAILY_BUDGET_USD ; 0 = non configuré. */
  daily: { usd: number; source: 'ATLAS_AI_DAILY_BUDGET_USD'; configured: boolean };
}

/** Un plafond passé en argument : un nombre positif ou nul, ou une erreur — jamais NaN, qui ne borne rien. */
function plafondArgument(nom: string, brut: string | undefined, defaut: number): { usd: number; explicite: boolean } {
  if (brut === undefined || brut === '') return { usd: defaut, explicite: false };
  const usd = Number(brut);
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`--${nom}=${brut} : un plafond est un nombre de dollars positif`);
  return { usd, explicite: true };
}

/**
 * Les plafonds qu'un lot appliquera réellement, et d'où chacun vient.
 *
 * `batch` et le preflight passent par ici : ce que l'un affiche est ce que
 * l'autre applique, par construction.
 */
export function clientBudgetLimits(
  ai: { dailyBudgetUsd: number; dailyBudgetMode: 'UNLIMITED' | 'CONFIGURED' | 'DISABLED' },
  args: { budget?: string | undefined; batchBudget?: string | undefined } = {},
): ClientBudgetLimits {
  const mission = plafondArgument('budget', args.budget, CLIENT_BATCH_DEFAULTS.runBudgetUsd);
  const batch = plafondArgument('batch-budget', args.batchBudget, CLIENT_BATCH_DEFAULTS.batchBudgetUsd);
  const configured = ai.dailyBudgetMode === 'CONFIGURED';
  return {
    mission: { usd: mission.usd, source: mission.explicite ? '--budget' : 'défaut --budget' },
    batch: { usd: batch.usd, source: batch.explicite ? '--batch-budget' : 'défaut --batch-budget' },
    daily: { usd: configured ? ai.dailyBudgetUsd : 0, source: 'ATLAS_AI_DAILY_BUDGET_USD', configured },
  };
}

/** Les trois plafonds, une ligne chacun, tels que le preflight les affiche. */
export function describeClientBudgetLimits(limits: ClientBudgetLimits): string[] {
  return [
    `mission : ${limits.mission.usd.toFixed(2)} $ (${limits.mission.source})`,
    `lot     : ${limits.batch.usd.toFixed(2)} $ (${limits.batch.source})`,
    limits.daily.configured
      ? `jour    : ${limits.daily.usd.toFixed(2)} $ (${limits.daily.source})`
      : `jour    : non configuré (${limits.daily.source} absent — aucun plafond quotidien)`,
  ];
}

const DEPARTMENT = 'business-expansion';

/** Les rôles du département, au pluriel et en français : c'est un client qui lit le titre. */
const ROLE_LABELS: Record<string, string> = {
  distributor: 'distributeurs', reseller: 'revendeurs', 'commercial-partner': 'partenaires commerciaux',
  integrator: 'intégrateurs', supplier: 'fournisseurs', oem: 'partenaires OEM',
};
const roleLabel = (key: string): string => ROLE_LABELS[key] ?? key;
const capitaliser = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);
/** Accueil compris. La lecture moyenne visée est de deux à trois pages : le site désigne les suivantes. */
const PAGES_PAR_CANDIDAT = 5;
/** Les passages montrés au modèle, au plus : ceux qui portent un terme du brief ou se présentent. */
const MAX_BLOCS_MODELE = 60;
/**
 * Le catalogue garde plus de passages par page que le modèle n'en verra : la
 * sélection choisit parmi tout ce que la page dit, pas parmi ses quarante
 * premières lignes — sur une page produits, l'essentiel est souvent en bas.
 */
const MAX_BLOCS_PAR_PAGE_CATALOGUE = 120;
/** Trois requêtes de suite sans nouveau candidat : le moteur tourne en rond. */
const QUERIES_SANS_RENDEMENT = 3;

/** Les pages d'identité et de contact, dans la langue du marché, à lire en premier. */
const LOCAL_CONTACT_PATHS: Record<string, string[]> = {
  suède: ['/kontakt', '/kontakta-oss', '/om-oss'], suede: ['/kontakt', '/kontakta-oss', '/om-oss'],
  sweden: ['/kontakt', '/kontakta-oss', '/om-oss'], sverige: ['/kontakt', '/kontakta-oss', '/om-oss'], se: ['/kontakt', '/kontakta-oss', '/om-oss'],
  allemagne: ['/kontakt', '/impressum'], germany: ['/kontakt', '/impressum'], de: ['/kontakt', '/impressum'],
  france: ['/contact', '/mentions-legales'], fr: ['/contact', '/mentions-legales'],
};

/** Le début du jour UTC, pour le plafond quotidien. */
export const startOfUtcDay = (iso: string): string => `${iso.slice(0, 10)}T00:00:00.000Z`;

export function createClientRun(repos: Repositories, brief: ClientBrief, createdBy: string): string {
  const context: ClientRunContext = { kind: 'client-mission', briefs: [brief], batches: [] };
  const roles = brief.targetRoles.map(roleLabel);
  const mission = repos.missions.create({
    title: `${brief.client.internalTest ? '[INTERNAL_TEST] ' : ''}${capitaliser(roles.join(', '))} en ${brief.market.countryLabel}`,
    objective: `Identifier et qualifier des ${roles.join(', ')} en ${brief.market.countryLabel} pour ${brief.client.name} : ${brief.client.offering}`,
    context: context as unknown as Record<string, unknown>,
    createdBy,
    tags: ['client-mission', brief.client.internalTest ? 'internal-test' : 'client'],
    departmentKey: DEPARTMENT,
  });
  return mission.id;
}

export function loadClientRun(repos: Repositories, runId: string): { context: ClientRunContext; brief: ClientBrief } {
  const mission = repos.missions.require(runId);
  const context = (mission.context ?? {}) as Partial<ClientRunContext>;
  if (context.kind !== 'client-mission' || !Array.isArray(context.briefs) || context.briefs.length === 0) {
    throw new Error(`la mission ${runId} n’est pas une mission client`);
  }
  const brief = context.briefs[context.briefs.length - 1]!;
  const check = parseClientBrief(brief);
  if (!check.ok) throw new Error(`brief invalide en base : ${check.errors.join(' ; ')}`);
  return {
    context: { kind: 'client-mission', briefs: context.briefs, batches: context.batches ?? [], ...(context.autopilot ? { autopilot: context.autopilot } : {}) },
    brief: check.brief!,
  };
}

function saveContext(repos: Repositories, runId: string, context: ClientRunContext): void {
  repos.missions.setContext(runId, context as unknown as Record<string, unknown>);
}

/**
 * La boucle d'ajustement : un brief v(n+1), les exclusions appliquées, le
 * travail v(n) intact.
 */
export function adjustClientRun(repos: Repositories, runId: string, adjustment: Parameters<typeof adjustBrief>[1]): ClientBrief {
  const { context, brief } = loadClientRun(repos, runId);
  const suivant = adjustBrief(brief, adjustment);
  const check = parseClientBrief(suivant);
  if (!check.ok) throw new Error(`brief v${suivant.version} invalide : ${check.errors.join(' ; ')}`);
  for (const d of adjustment.excludeDomains ?? []) {
    const c = repos.clientCandidates.excludeByClient(runId, normaliseDomain(d), 'écartée par le client', suivant.version);
    if (c?.opportunityId) repos.opportunities.setStage(c.opportunityId, 'rejected');
  }
  /*
   * `--keep` est la commande RETAIN de la file de revue : elle doit changer
   * l'état du candidat, pas seulement une liste dans le brief. Une société
   * gardée passe retenue, sauf si le même ajustement l'écarte.
   */
  const ecartes = new Set((adjustment.excludeDomains ?? []).map(normaliseDomain));
  for (const d of adjustment.keepDomains ?? []) {
    const domaine = normaliseDomain(d);
    if (!domaine || ecartes.has(domaine)) continue;
    const c = repos.clientCandidates.keepByClient(runId, domaine, 'conservée par le client', suivant.version);
    if (c?.opportunityId) repos.opportunities.setStage(c.opportunityId, 'scored');
  }
  saveContext(repos, runId, { ...context, briefs: [...context.briefs, check.brief!] });
  return check.brief!;
}

function toDiscoveryQuery(brief: ClientBrief): DiscoveryQuery {
  return {
    targetTypes: brief.targetRoles.map((key) => ({ key, label: key, description: '' })),
    countries: [brief.market.country],
    industries: brief.industries,
    keywords: brief.productKeywords,
    exclusions: brief.excludedDomains,
    clientOffering: brief.client.offering,
    limit: 50,
  };
}

interface SpendGuard {
  runId: string; batchStartedAt: string; runBudgetUsd: number; batchBudgetUsd: number; dailyBudgetUsd: number;
  estimate: number;
  /** Les appels partis et pas encore comptés : chacun réserve une estimation. */
  inFlight: number;
}

/** Ce que la mission, le lot et la journée ont déjà coûté — mesuré, pas estimé. */
export function spendSoFar(repos: Repositories, guard: Pick<SpendGuard, 'runId' | 'batchStartedAt'>, now: string): { run: number; batch: number; day: number } {
  // Des sommes en base, jamais une liste bornée : une mission de trois
  // cents lots ne doit pas voir sa garde s'arrêter de compter.
  const run = repos.llmCalls.totals(guard.runId).costUsd;
  const batch = repos.llmCalls.costSince(guard.runId, guard.batchStartedAt);
  const day = repos.llmCalls.usageSince(startOfUtcDay(now)).knownCostUsd;
  return { run, batch, day };
}

/** Peut-on engager un appel de plus ? Rend la raison du refus, sinon `null`. */
export function budgetStop(repos: Repositories, guard: Omit<SpendGuard, 'inFlight'> & { inFlight?: number }, now: string): string | null {
  const s = spendSoFar(repos, guard, now);
  // Ce qui est en vol n'est pas encore dans le registre : on le compte comme dépensé.
  const reserve = guard.estimate * (1 + (guard.inFlight ?? 0));
  if (s.run + reserve > guard.runBudgetUsd) return `plafond de mission atteint (${s.run.toFixed(4)} $ + ${reserve.toFixed(3)} $ > ${guard.runBudgetUsd} $)`;
  if (s.batch + reserve > guard.batchBudgetUsd) return `plafond du lot atteint (${s.batch.toFixed(4)} $ + ${reserve.toFixed(3)} $ > ${guard.batchBudgetUsd} $)`;
  if (guard.dailyBudgetUsd > 0 && s.day + reserve > guard.dailyBudgetUsd) return `plafond quotidien atteint (${s.day.toFixed(4)} $ + ${reserve.toFixed(3)} $ > ${guard.dailyBudgetUsd} $)`;
  return null;
}

/**
 * Un lot : découvrir jusqu'à N nouveaux candidats, puis traiter jusqu'à N
 * candidats en attente — les nouveaux, et ceux qu'un lot précédent a laissés
 * en échec reprenable.
 */
export async function runClientBatch(deps: ClientMissionDeps, options: BatchOptions): Promise<BatchSummary> {
  const { repos } = deps;
  const now = deps.now ?? nowIso;
  const { context, brief } = loadClientRun(repos, options.runId);
  const batch = context.batches.length + 1;
  const startedAt = now();
  const ctx: SearchProviderContext = { logger: deps.logger, timeoutMs: 20_000 };
  const exclus = new Set([...brief.excludedDomains, ...(options.exclude ?? [])].map(normaliseDomain));
  const summary: BatchSummary = {
    batch, briefVersion: brief.version, startedAt, finishedAt: startedAt,
    queriesRun: 0, rawResults: 0, discovered: 0, filteredOut: 0, processed: 0,
    retained: 0, reviewRequired: 0, excluded: 0, failed: 0, costUsd: 0, stoppedBecause: null,
  };
  const guard: SpendGuard = {
    runId: options.runId, batchStartedAt: startedAt, runBudgetUsd: options.runBudgetUsd,
    batchBudgetUsd: options.batchBudgetUsd, dailyBudgetUsd: options.dailyBudgetUsd,
    estimate: deps.estimatedCostPerCandidateUsd ?? 0.012,
    inFlight: 0,
  };
  const t0 = Date.now();
  const metrics: BatchMetrics = {
    search: { queries: 0, rawResults: 0, uniqueDomains: 0, ms: 0, yields: [], stoppedBecause: null },
    filter: { directoryExcluded: 0, noTextExcluded: 0, relevanceExcluded: 0, countryExcluded: 0, competitorExcluded: 0 },
    process: { candidates: 0, pagesAttempted: 0, pagesFetched: 0, pagesRead: 0, pagesUseful: 0, fetchFailures: 0, fetchTimeouts: 0, cacheHits: 0, llmCalls: 0, llmCached: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    quality: { retained: 0, reviewRequired: 0, excluded: 0, failed: 0, toConfirmTotal: 0, candidatesWithToConfirm: 0, autoApproved: 0, humanReview: 0, autoExcluded: 0 },
    timing: { ...timingVide(), batchMs: 0, avgCandidateMs: 0, concurrency: 1, slowest: [] },
  };
  const domainesVus = new Set<string>();
  // Les mémoires ont une durée de vie ; sans purge, elles n'ont pas de taille.
  if (options.cache ?? true) { repos.clientCache.purgePages(); repos.clientCache.purgeQualifications(); }

  // ── Sociétés nommées : inscrites sans moteur ──────────────────────────────
  for (const brut of options.seedDomains ?? []) {
    const domaine = normaliseDomain(brut);
    if (!domaine || exclus.has(domaine)) continue;
    const { created } = repos.clientCandidates.discover({
      runId: options.runId, domain: domaine, url: `https://${domaine}/`, batch, briefVersion: brief.version,
    });
    if (created) summary.discovered += 1;
  }

  // ── Découverte ────────────────────────────────────────────────────────────
  if (!options.resumeOnly) {
    const connus = repos.clientCandidates.knownDomains(options.runId);
    const plan = planQueries(toDiscoveryQuery(brief), { maxQueries: options.maxQueries ?? 8 });
    /*
     * On ne cherche pas pour chercher. Le lot s'arrête quand il est plein,
     * quand le plan est épuisé, ou quand trois requêtes de suite n'ont rien
     * apporté de nouveau — le moteur tourne alors en rond sur les mêmes
     * sites, et chaque requête de plus coûte sans rapporter.
     */
    let sansNouveau = 0;
    for (const q of plan) {
      if (summary.discovered >= options.batchSize) { metrics.search.stoppedBecause = 'lot plein'; break; }
      const avantRequete = summary.discovered;
      let results;
      const tRecherche = Date.now();
      try {
        results = await deps.search.search(
          { query: q.query, count: 10, ...(q.country ? { country: q.country } : {}), ...(q.language ? { language: q.language } : {}) },
          ctx,
        );
      } catch (err) {
        deps.logger.warn('requête en échec', { query: q.query, error: err instanceof Error ? err.message : String(err) });
        // Une requête en échec ne rapporte rien : elle compte pour l'arrêt.
        // Sans cela, un moteur mort faisait dérouler tout le plan, un délai
        // complet par requête.
        metrics.search.yields.push(0);
        sansNouveau += 1;
        if (sansNouveau >= QUERIES_SANS_RENDEMENT) { metrics.search.stoppedBecause = `${sansNouveau} requêtes de suite sans nouveau candidat`; break; }
        continue;
      }
      metrics.search.ms += Date.now() - tRecherche;
      summary.queriesRun += 1;
      summary.rawResults += results.results.length;
      for (const r of results.results) { const d = normaliseHost(r.url); if (d) domainesVus.add(d); }
      if (results.outcome !== 'ok' && results.results.length === 0) {
        // Un moteur qui ne rend rien ne bloque pas le lot : les autres requêtes
        // peuvent réussir, et le résumé dit ce qui s'est passé. Mais il compte
        // pour l'arrêt, comme une requête sans nouveau candidat.
        metrics.search.yields.push(0);
        sansNouveau += 1;
        if (sansNouveau >= QUERIES_SANS_RENDEMENT) { metrics.search.stoppedBecause = `${sansNouveau} requêtes de suite sans nouveau candidat`; break; }
        continue;
      }
      const filtre = filterResults(results.results, { exclusions: [...exclus], maxCandidates: 50 });
      for (const rejet of filtre.rejected) {
        const domaine = normaliseHost(rejet.url);
        if (!domaine || connus.has(domaine)) continue;
        connus.add(domaine);
        const { candidate } = repos.clientCandidates.discover({
          runId: options.runId, domain: domaine, url: rejet.url, batch, briefVersion: brief.version,
        });
        repos.clientCandidates.setStage(candidate.id, 'EXCLUDED', { category: 'DIRECTORY', reason: rejet.reason });
        summary.filteredOut += 1;
        metrics.filter.directoryExcluded += 1;
      }
      for (const cand of filtre.candidates) {
        if (summary.discovered >= options.batchSize) break;
        const domaine = normaliseDomain(cand.domain);
        if (!domaine || connus.has(domaine) || exclus.has(domaine)) continue;
        connus.add(domaine);
        repos.clientCandidates.discover({
          runId: options.runId, domain: domaine, url: cand.primaryUrl,
          name: cand.likelyName || null, batch, briefVersion: brief.version,
        });
        summary.discovered += 1;
      }
      const rendement = summary.discovered - avantRequete;
      metrics.search.yields.push(rendement);
      sansNouveau = rendement === 0 ? sansNouveau + 1 : 0;
      if (sansNouveau >= QUERIES_SANS_RENDEMENT) { metrics.search.stoppedBecause = `${sansNouveau} requêtes de suite sans nouveau candidat`; break; }
    }
    if (!metrics.search.stoppedBecause) metrics.search.stoppedBecause = summary.discovered >= options.batchSize ? 'lot plein' : 'plan de requêtes épuisé';
  }

  // ── Traitement : plusieurs candidats de front, chacun écrit dès qu'il l'est ─
  const attente = repos.clientCandidates.pending(options.runId, options.batchSize)
    .filter((c) => !exclus.has(c.domain));
  /*
   * Un candidat coûte surtout de l'attente : le réseau, puis le modèle —
   * douze secondes par réponse sur le premier lot réel. Quatre candidats de
   * front recouvrent ces attentes sans multiplier les requêtes vers un même
   * site : chaque candidat est un hôte, et ne lit jamais plus de deux pages
   * à la fois. Les écritures SQLite sont synchrones : aucune ne s'entrelace.
   */
  const largeur = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, attente.length));
  let prochain = 0;
  let arrete = false;
  const cache = options.cache ?? true;
  const travailleur = async (): Promise<void> => {
    for (;;) {
      if (arrete) return;
      if (options.shouldStop?.()) { summary.stoppedBecause = summary.stoppedBecause ?? 'arrêt demandé'; arrete = true; return; }
      const i = prochain;
      prochain += 1;
      const candidat = attente[i];
      if (!candidat) return;
      const arret = budgetStop(repos, guard, now());
      if (arret) { summary.stoppedBecause = arret; arrete = true; return; }
      const mesure: CandidateMeasure = { timing: timingVide(), pagesAttempted: 0, pagesFetched: 0, pagesRead: 0, pagesUseful: 0, fetchFailures: 0, fetchTimeouts: 0, cacheHits: 0, llmCalls: 0, llmCached: 0, inputTokens: 0, outputTokens: 0, toConfirm: 0, exclusion: null, triage: null };
      const tCandidat = Date.now();
      try {
        const verdict = await processCandidate(deps, brief, options.runId, candidat, guard, now, mesure, { cache });
        summary.processed += 1;
        if (verdict === 'RETAINED') summary.retained += 1;
        else if (verdict === 'REVIEW_REQUIRED') summary.reviewRequired += 1;
        else if (verdict === 'EXCLUDED') summary.excluded += 1;
        else summary.failed += 1;
      } catch (err) {
        if (err instanceof BudgetStopError) {
          // Le plafond n'est pas la faute du candidat : il reste en attente,
          // sans tentative comptée, et le lot s'arrête pour tout le monde.
          summary.stoppedBecause = err.message;
          arrete = true;
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        repos.clientCandidates.markFailed(candidat.id, message);
        summary.failed += 1;
        deps.logger.warn('candidat en échec', { domain: candidat.domain, error: message });
      }
      mesure.timing.total = Date.now() - tCandidat;
      accumuler(metrics, candidat.domain, mesure);
    }
  };
  await Promise.all(Array.from({ length: largeur }, () => travailleur()));

  summary.finishedAt = now();
  summary.costUsd = spendSoFar(repos, guard, now()).batch;
  metrics.search.queries = summary.queriesRun;
  metrics.search.rawResults = summary.rawResults;
  metrics.search.uniqueDomains = domainesVus.size;
  metrics.process.costUsd = summary.costUsd;
  metrics.quality.retained = summary.retained;
  metrics.quality.reviewRequired = summary.reviewRequired;
  metrics.quality.excluded = summary.excluded + summary.filteredOut;
  metrics.quality.failed = summary.failed;
  metrics.timing.batchMs = Date.now() - t0;
  metrics.timing.avgCandidateMs = metrics.process.candidates > 0 ? Math.round(metrics.timing.total / metrics.process.candidates) : 0;
  metrics.timing.slowest = metrics.timing.slowest.sort((a, b) => b.ms - a.ms).slice(0, 5);
  metrics.timing.concurrency = largeur;
  summary.metrics = metrics;
  saveContext(repos, options.runId, { ...context, batches: [...context.batches, summary] });
  return summary;
}

/** Ce qu'un candidat a coûté en temps, pages et jetons — rempli au fil du traitement. */
interface CandidateMeasure {
  timing: CandidateTiming;
  pagesAttempted: number; pagesFetched: number; pagesRead: number; pagesUseful: number; fetchFailures: number; fetchTimeouts: number; cacheHits: number;
  llmCalls: number; llmCached: number; inputTokens: number; outputTokens: number;
  toConfirm: number;
  exclusion: 'NO_TEXT' | 'COUNTRY' | 'COMPETITOR' | 'RELEVANCE' | null;
  triage: TriageStatus | null;
}

function accumuler(m: BatchMetrics, domain: string, c: CandidateMeasure): void {
  m.process.candidates += 1;
  m.process.pagesAttempted += c.pagesAttempted;
  m.process.pagesFetched += c.pagesFetched;
  m.process.pagesRead += c.pagesRead;
  m.process.pagesUseful += c.pagesUseful;
  m.process.fetchFailures += c.fetchFailures;
  m.process.fetchTimeouts += c.fetchTimeouts;
  m.process.cacheHits += c.cacheHits;
  m.process.llmCalls += c.llmCalls;
  m.process.llmCached += c.llmCached;
  m.process.inputTokens += c.inputTokens;
  m.process.outputTokens += c.outputTokens;
  m.quality.toConfirmTotal += c.toConfirm;
  if (c.toConfirm > 0) m.quality.candidatesWithToConfirm += 1;
  if (c.exclusion === 'NO_TEXT') m.filter.noTextExcluded += 1;
  if (c.exclusion === 'COUNTRY') m.filter.countryExcluded += 1;
  if (c.exclusion === 'COMPETITOR') m.filter.competitorExcluded += 1;
  if (c.exclusion === 'RELEVANCE') m.filter.relevanceExcluded += 1;
  if (c.triage === 'AUTO_APPROVED') m.quality.autoApproved += 1;
  if (c.triage === 'HUMAN_REVIEW') m.quality.humanReview += 1;
  if (c.triage === 'AUTO_EXCLUDED') m.quality.autoExcluded += 1;
  for (const k of PHASES) m.timing[k] += c.timing[k];
  m.timing.total += c.timing.total;
  m.timing.slowest.push({ domain, ms: c.timing.total, fetch: c.timing.fetch, llm: c.timing.llm });
}

const chrono = () => { const t = Date.now(); return () => Date.now() - t; };

/** Le plafond atteint entre deux lectures : un arrêt, pas une panne. */
class BudgetStopError extends Error {}

type Verdict = CandidateDecision['outcome'] | 'FAILED';

/** Un délai court d'abord ; un site qui n'a pas répondu a droit au long à la reprise. */
const TIMEOUT_FIRST_MS = 10_000;
const TIMEOUT_RETRY_MS = 20_000;
/** Les pages secondaires, plus courtes encore — et allongées elles aussi à la reprise. */
const TIMEOUT_PLAN_FIRST_MS = 8_000;
const TIMEOUT_PLAN_RETRY_MS = 12_000;
const DEFAULT_CONCURRENCY = 4;
/** Deux pages d'un même site à la fois, jamais plus : on lit, on ne bombarde pas. */
const PER_HOST_CONCURRENCY = 2;

/**
 * Lit des pages en passant par la mémoire : une adresse déjà lue — ou déjà
 * en échec — dans les quatorze derniers jours n'est pas redemandée. Ce qui
 * est lu pour de vrai y est écrit pour la prochaine fois.
 */
async function lirePages(
  deps: ClientMissionDeps, domain: string, urls: readonly string[], maxPages: number,
  timeoutMs: number, useCache: boolean, mesure: CandidateMeasure,
): Promise<FetchedPages> {
  const cache = useCache ? deps.repos.clientCache : null;
  const pages: FetchedPages['pages'] = [];
  const failures: FetchedPages['failures'] = [];
  const aLire: string[] = [];
  for (const url of urls) {
    const hit = cache?.getPage(url);
    if (!hit) { aLire.push(url); continue; }
    mesure.cacheHits += 1;
    if (hit.ok && hit.html) pages.push({ url: hit.finalUrl ?? url, html: hit.html });
    else failures.push({ url, kind: hit.kind ?? 'OTHER', reason: `en mémoire : ${hit.kind ?? 'échec'}` });
  }
  if (pages.length < maxPages && aLire.length > 0) {
    const lu = await deps.fetchPages(aLire, maxPages - pages.length, { timeoutMs });
    const r: FetchedPages = Array.isArray(lu) ? { pages: lu, attempts: lu.length, failures: [] } : lu;
    mesure.pagesAttempted += r.attempts;
    mesure.fetchFailures += r.failures.length;
    mesure.fetchTimeouts += r.failures.filter((f) => f.kind === 'TIMEOUT').length;
    /*
     * La page est rangée sous l'adresse demandée : c'est elle qu'on
     * redemandera. Après redirection, l'adresse rendue diffère ; on retrouve
     * la demandée par élimination des échecs, dans l'ordre — jamais par la
     * position dans la liste complète, qui décale d'un cran dès qu'une
     * adresse a échoué avant et rangeait la page du contact sous l'accueil.
     */
    const echouees = new Set(r.failures.map((f) => f.url.replace(/\/+$/, '').toLowerCase()));
    const reussies = aLire.filter((u) => !echouees.has(u.replace(/\/+$/, '').toLowerCase()));
    r.pages.forEach((p, i) => {
      pages.push(p);
      const demandee = reussies.find((u) => memeAdresse(u, p.url)) ?? reussies[i] ?? p.url;
      cache?.putPage({ url: demandee, finalUrl: p.url, domain, ok: true, html: p.html });
    });
    mesure.pagesFetched += r.pages.length;
    for (const f of r.failures) {
      failures.push(f);
      // Seul ce qui ne changera pas demain est mémorisé : une page qui
      // n'existe pas, une adresse interdite. Un délai, une panne serveur ou
      // une erreur inconnue se retentent.
      if (f.kind === 'HTTP_4XX' || f.kind === 'BLOCKED') cache?.putPage({ url: f.url, domain, ok: false, kind: f.kind });
    }
  }
  mesure.pagesRead += pages.length;
  return { pages, attempts: mesure.pagesAttempted, failures };
}

/** Les pages du plan, deux à la fois sur le même hôte. */
async function lirePlan(
  deps: ClientMissionDeps, domain: string, urls: readonly string[], timeoutMs: number, useCache: boolean, mesure: CandidateMeasure,
): Promise<FetchedPages> {
  const pages: FetchedPages['pages'] = [];
  const failures: FetchedPages['failures'] = [];
  let index = 0;
  const lecteur = async (): Promise<void> => {
    for (;;) {
      const url = urls[index];
      index += 1;
      if (!url) return;
      const r = await lirePages(deps, domain, [url], 1, timeoutMs, useCache, mesure);
      pages.push(...r.pages);
      failures.push(...r.failures);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PER_HOST_CONCURRENCY, urls.length) }, () => lecteur()));
  // L'ordre du plan est l'ordre de lecture : identité d'abord, puis produits.
  pages.sort((a, b) => urls.findIndex((u) => memeAdresse(u, a.url)) - urls.findIndex((u) => memeAdresse(u, b.url)));
  return { pages, attempts: mesure.pagesAttempted, failures };
}

const memeAdresse = (a: string, b: string): boolean => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();

/** Le pays d'après ces pages : preuve forte, sinon concordance, sinon rien — et ce qui le contredit. */
function evaluerPays(pages: ReadonlyArray<{ url: string; html: string }>, brief: ClientBrief) {
  const fort = extractCountryEvidence(pages);
  const signaux = collectCountrySignals(pages);
  const concordance = corroborateCountry(signaux);
  let pays = fort.country ?? concordance.country;
  /*
   * Une preuve forte contredite par un identifiant concret d'un autre pays
   * — téléphone, TVA — n'est plus une preuve : c'est une question. Une
   * simple mention d'un voisin sur une page d'identité ne contredit rien :
   * trinex.se cite la Norvège et le Danemark, ses marchés. Kafeko Nordic,
   * lui, déclare SE et publie un +358.
   */
  const contradiction = pays
    ? [...new Set(signaux.filter((x) => x.country !== pays && x.type !== 'MENTION_IN_IDENTITY_PAGE').map((x) => `${x.country} (${x.type} ${x.rawValue})`))]
    : [];
  if (pays && contradiction.length > 0 && !(fort.basis === 'OFFICIAL_ID')) pays = null;
  const fit = countryFit(pays, [brief.market.countryLabel]);
  const citationConcordance = concordance.country ? concordance.signals.map((x) => x.rawValue).join(' · ') : null;
  return {
    pays, fort, contradiction, fit,
    detail: {
      country: pays,
      basis: fort.country && pays ? fort.basis : pays ? 'CORROBORATION' : 'NONE',
      quote: pays ? (fort.quote ?? citationConcordance) : null,
      sourceUrl: pays ? (fort.sourceUrl ?? concordance.signals[0]?.sourceUrl ?? null) : null,
      fit: fit.fit,
      contradiction,
    },
  };
}

/** Ce qui, dans le brief, change la question posée au modèle. Même brief, même clé. */
function briefHash(brief: ClientBrief): string {
  return sha256(JSON.stringify({
    offering: brief.client.offering, market: brief.market.countryLabel, roles: brief.targetRoles,
    keywords: brief.productKeywords, industries: brief.industries,
    criteria: allCriteria(brief).map((c) => [c.key, c.kind, c.label, c.hint ?? '']),
  }));
}

/** Le verdict d'un candidat, écrit à chaque étape. Lève si la lecture échoue. */
async function processCandidate(
  deps: ClientMissionDeps,
  brief: ClientBrief,
  runId: string,
  candidat: ClientCandidate,
  guard: SpendGuard,
  now: () => string,
  mesure: CandidateMeasure,
  options: { cache: boolean },
): Promise<Verdict> {
  const { repos } = deps;
  const cc = repos.clientCandidates;
  const T = mesure.timing;
  const site = `https://${candidat.domain}`;
  const timeoutMs = candidat.attempts > 0 ? TIMEOUT_RETRY_MS : TIMEOUT_FIRST_MS;
  const locales = LOCAL_CONTACT_PATHS[brief.market.country.toLowerCase()] ?? LOCAL_CONTACT_PATHS[brief.market.countryLabel.toLowerCase()] ?? [];

  // ── 1. L'accueil, et la page trouvée si ce n'est pas lui ──────────────────
  let fin = chrono();
  // « https://www.x.se/ » et « https://x.se/ » sont la même page : une seule requête.
  const sansWww = (u: string) => u.replace(/^https?:\/\/www\./i, 'https://').replace(/\/+$/, '').toLowerCase();
  const premieres = [`${site}/`, candidat.url].filter((u, i, a) => a.findIndex((x) => sansWww(x) === sansWww(u)) === i);
  const lu1 = await lirePages(deps, candidat.domain, premieres, 2, timeoutMs, options.cache, mesure);
  T.fetch += fin();
  if (lu1.pages.length === 0) {
    const lent = lu1.failures.some((f) => f.kind === 'TIMEOUT');
    cc.markFailed(candidat.id, lent ? `site lent : aucune réponse en ${timeoutMs / 1000} s` : `aucune page lisible (${lu1.failures.map((f) => f.kind).join(', ') || 'rien lu'})`);
    return 'FAILED';
  }
  const pages: Array<{ url: string; html: string }> = [...lu1.pages];
  const accueil = pages.find((p) => { try { return new URL(p.url).pathname.replace(/\/+$/, '') === ''; } catch { return false; } }) ?? pages[0]!;

  // ── 2. CHEAP_FILTER : du texte, et de quoi parler ─────────────────────────
  fin = chrono();
  let catalogue = buildBlockCatalogue(pages, { maxBlocksPerPage: MAX_BLOCS_PAR_PAGE_CATALOGUE });
  T.parse += fin();
  if (catalogue.size === 0) {
    mesure.exclusion = 'NO_TEXT';
    cc.setStage(candidat.id, 'EXCLUDED', { category: 'INSUFFICIENT_EVIDENCE', reason: 'pages sans texte lisible', detail: { pagesRead: pages.map((p) => p.url) } });
    return 'EXCLUDED';
  }
  fin = chrono();
  let paysEval = evaluerPays(pages, brief);
  T.country += fin();
  let precheck = relevancePrecheck(pages, brief);
  const links = siteLinks(accueil.html, accueil.url, candidat.domain);

  // ── 3. Les pages suivantes : celles que le site désigne, pas celles qu'on devine ─
  const plan = planPages({
    links, countryKnown: Boolean(paysEval.pays), relevanceHits: precheck.hits.length,
    maxPages: PAGES_PAR_CANDIDAT - (pages.length - 1), fallbackIdentityPaths: locales, origin: site,
  });
  /*
   * RELEVANCE_PRECHECK : un accueil qui ne porte aucun terme du brief mérite
   * une page produits avant conclusion — pas quatre. Si elle n'en porte pas
   * davantage, la société est hors sujet, et la raison le dit : quels termes
   * ont été cherchés, sur quelles pages.
   */
  const aLire = precheck.hits.length === 0
    ? plan.filter((p) => p.kind === 'PRODUCTS').slice(0, 1).concat(plan.filter((p) => p.kind !== 'PRODUCTS').slice(0, 1))
    : plan;
  if (aLire.length > 0) {
    fin = chrono();
    const lu2 = await lirePlan(deps, candidat.domain, aLire.map((p) => p.url), candidat.attempts > 0 ? TIMEOUT_PLAN_RETRY_MS : TIMEOUT_PLAN_FIRST_MS, options.cache, mesure);
    T.fetch += fin();
    for (const p of lu2.pages) if (!pages.some((x) => memeAdresse(x.url, p.url))) pages.push(p);
    fin = chrono();
    catalogue = buildBlockCatalogue(pages, { maxBlocksPerPage: MAX_BLOCS_PAR_PAGE_CATALOGUE });
    T.parse += fin();
    precheck = relevancePrecheck(pages, brief);
  }
  mesure.pagesUseful = catalogue.blocksByUrl.size;
  const pagesLues = pages.map((p) => p.url);
  cc.setStage(candidat.id, 'FETCHED', { detail: { pagesRead: pagesLues, pagePlan: aLire.map((p) => `${p.kind}: ${p.url} (${p.why})`), relevance: { hits: precheck.hits, productHits: precheck.productHits } } });

  // ── 4. COUNTRY_CHECK, sur tout ce qui a été lu ────────────────────────────
  fin = chrono();
  paysEval = evaluerPays(pages, brief);
  const { pays, fort, contradiction, fit } = paysEval;
  const paysDetail = paysEval.detail;
  T.country += fin();
  if (fit.fit === 'OUT_OF_SCOPE') {
    const base = paysDetail.basis === 'OFFICIAL_ID' ? 'prouvé par identifiant national'
      : paysDetail.basis === 'DECLARED_METADATA' ? 'déclaré par le site'
      : paysDetail.basis === 'POSTAL_ADDRESS' ? 'établi par l’adresse publiée'
      : 'établi par concordance (téléphone, mention)';
    const raison = `pays ${base} : ${pays}`;
    /*
     * Une preuve — identifiant, métadonnée, adresse — écarte seule. Une
     * concordance de signaux faibles (un indicatif, une mention) ne fait
     * qu'une présomption : cyklop.com, groupe allemand avec des pages
     * suédoises, sort ainsi. La présomption va en revue, P3, sans appel
     * modèle — un humain la confirme en trente secondes.
     */
    const prouve = paysDetail.basis !== 'CORROBORATION';
    mesure.exclusion = prouve ? 'COUNTRY' : null;
    mesure.triage = prouve ? 'AUTO_EXCLUDED' : 'HUMAN_REVIEW';
    cc.setStage(candidat.id, prouve ? 'EXCLUDED' : 'REVIEW_REQUIRED', {
      name: titreDuSite(pages) ?? candidat.domain,
      category: 'WRONG_COUNTRY', reason: raison, evidenceQuote: paysDetail.quote, evidenceUrl: paysDetail.sourceUrl,
      detail: {
        country: paysDetail,
        triage: prouve
          ? { status: 'AUTO_EXCLUDED', priority: null, recommendation: 'EXCLUDE', reasons: [raison] }
          : { status: 'HUMAN_REVIEW', priority: 'P3', recommendation: 'EXCLUDE', reasons: [`${raison} — présomption, pas une preuve`] },
        score: { total: 0, confidence: 0 },
      },
    });
    return prouve ? 'EXCLUDED' : 'REVIEW_REQUIRED';
  }

  // ── RELEVANCE_PRECHECK : hors sujet, sans modèle ──────────────────────────
  if (precheck.hits.length === 0) {
    const termes = [...brief.productKeywords, ...brief.industries].slice(0, 8).join(', ');
    /*
     * Deux pages sans aucun terme du brief : hors sujet, écartée seule. Une
     * seule page lisible — un accueil rendu par script, un site sans lien —
     * ne suffit pas à une exclusion « claire » : la société va en revue, P3,
     * sans appel modèle, et un humain la ferme en dix secondes.
     */
    const clair = pages.length >= 2;
    mesure.exclusion = clair ? 'RELEVANCE' : null;
    mesure.triage = clair ? 'AUTO_EXCLUDED' : 'HUMAN_REVIEW';
    const raison = clair
      ? `aucun terme du brief sur ${pages.length} pages lues — cherchés : ${termes} et les mots de rôle`
      : `aucun terme du brief sur la seule page lisible — cherchés : ${termes} ; site à vérifier à la main`;
    cc.setStage(candidat.id, clair ? 'EXCLUDED' : 'REVIEW_REQUIRED', {
      name: titreDuSite(pages) ?? candidat.domain, category: 'LOW_RELEVANCE',
      reason: raison,
      evidenceUrl: accueil.url,
      detail: {
        triage: clair
          ? { status: 'AUTO_EXCLUDED', priority: null, recommendation: 'EXCLUDE', reasons: ['hors sujet : aucun terme du brief'] }
          : { status: 'HUMAN_REVIEW', priority: 'P3', recommendation: 'EXCLUDE', reasons: [raison] },
        score: { total: 0, confidence: 0 },
      },
    });
    return clair ? 'EXCLUDED' : 'REVIEW_REQUIRED';
  }

  // ── 5. Identité, concurrents, contacts : tout ce qui ne coûte rien ────────
  fin = chrono();
  const identite = corroborateIdentity(collectIdentitySignals(pages), candidat.domain);
  const nom = identite.name ?? titreDuSite(pages) ?? candidat.domain;
  T.identity += fin();

  fin = chrono();
  const concurrents: CompetitorHit[] = scanCompetitors(catalogue, brief.competitorExclusions);
  T.competitors += fin();
  if (concurrents.length > 0) {
    mesure.exclusion = 'COMPETITOR';
    mesure.triage = 'AUTO_EXCLUDED';
    const h = concurrents[0]!;
    const company = persistCompany(deps, brief, runId, candidat, nom, pays, null, []);
    persistEvidence(deps, runId, company.id, null, concurrents.map((x) => ({
      field: `competitor:${x.competitor}`, claim: x.quote, sourceUrl: x.sourceUrl, nature: 'observed' as const, basis: `marque concurrente citée : ${x.competitor}`,
    })));
    cc.setStage(candidat.id, 'EXCLUDED', {
      name: nom, category: 'COMPETITOR', reason: `cite ${[...new Set(concurrents.map((x) => x.competitor))].join(', ')}`,
      evidenceQuote: h.quote, evidenceUrl: h.sourceUrl, companyId: company.id,
      detail: { country: paysDetail, competitors: concurrents, triage: { status: 'AUTO_EXCLUDED', priority: null, recommendation: 'EXCLUDE', reasons: [`cite ${h.competitor}`] } },
    });
    return 'EXCLUDED';
  }

  fin = chrono();
  const contacts = resolveContacts({ officialDomain: candidat.domain, pages });
  const canal = rankContactChannels({
    emails: contacts.publicEmails, phones: contacts.publicPhones, form: contacts.contactFormUrl,
    officialDomain: candidat.domain, personName: contacts.contactPersonName, personRole: contacts.contactPersonRole,
  });
  const emailChoisi = canal.method === 'EMAIL' ? contacts.publicEmails.find((e) => e.value === canal.value) ?? null : null;
  const contactDetail = {
    method: canal.method, value: canal.value, sourceUrl: canal.sourceUrl, intent: canal.intent,
    confidence: canal.confidence, why: canal.why, rejected: canal.rejected.slice(0, 6),
    email: canal.method === 'EMAIL' ? canal.value : null,
    emailSourceUrl: canal.method === 'EMAIL' ? canal.sourceUrl : null,
    emailIntent: canal.method === 'EMAIL' ? canal.intent : null,
    emailDomainMatch: canal.method === 'EMAIL' ? (canal.sameDomain ? 'SAME_DOMAIN' : 'CROSS_DOMAIN') : null,
    personalEmailsSeen: contacts.publicEmails.filter((e) => e.intent === 'PERSONAL').length,
    phone: contacts.publicPhones[0]?.value ?? null,
    formUrl: contacts.contactFormUrl?.value ?? null,
    personName: contacts.contactPersonName,
    personRole: contacts.contactPersonRole,
  };
  const facts = extractSiteFacts(pages, [...contacts.publicEmails, ...contacts.publicPhones], precheck);
  T.contacts += fin();

  // ── 6. La qualification : le seul appel modèle, et seulement s'il n'a pas déjà eu lieu ─
  const selection = selectBlocksForModel(catalogue, brief, { maxBlocks: MAX_BLOCS_MODELE });
  const prompt = criteriaPrompt(brief, { name: nom, url: candidat.url }, { text: selection.text }, {
    country: pays, countryBasis: paysDetail.basis, orgNr: facts.orgNr, vat: facts.vat, postalAddress: facts.postalAddress,
    emails: facts.emails, briefTermsSeen: facts.briefTermsSeen,
  });
  // La clé porte le prompt entier : mêmes passages ET mêmes faits en tête, sinon la question n'est pas la même.
  const cleQualification = repos.clientCache.qualificationKey(candidat.domain, briefHash(brief), sha256(prompt));
  const enMemoire = options.cache ? repos.clientCache.getQualification(cleQualification) : null;
  let parsed: unknown;
  let coutAppel = 0;
  fin = chrono();
  if (enMemoire) {
    parsed = enMemoire.output;
    mesure.llmCached += 1;
  } else {
    const arret = budgetStop(repos, guard, now());
    if (arret) throw new BudgetStopError(arret);
    guard.inFlight += 1;
    let reponse;
    try {
      reponse = await deps.llm.complete({
        model: deps.model,
        system: CRITERIA_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        jsonSchema: criteriaSchema(brief),
        maxTokens: 1200,
        /*
         * Un taskRef PAR candidat. Le fournisseur budgété plafonne les appels
         * par étape (ATLAS_MAX_LLM_CALLS_PER_STEP, 12) ; un taskRef commun à
         * tout le lot faisait tomber le treizième candidat en échec.
         */
        meta: { missionId: runId, taskRef: `client-qualification:${candidat.domain}`, agentKey: 'analyst', purpose: 'client-qualification', subject: candidat.domain },
      });
    } finally {
      guard.inFlight -= 1;
    }
    mesure.llmCalls += 1;
    mesure.inputTokens += reponse.usage?.inputTokens ?? 0;
    mesure.outputTokens += reponse.usage?.outputTokens ?? 0;
    /*
     * Le coût de CET appel : la somme du registre pour cette étape depuis le
     * début du lot. Avec quatre candidats de front, « la dépense de la mission
     * avant et après » attribuait à l'un les appels des trois autres.
     */
    coutAppel = Math.max(0, repos.llmCalls.costSince(runId, guard.batchStartedAt, `client-qualification:${candidat.domain}`));
    const brut = textOf(reponse.content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const a = brut.indexOf('{');
    const b = brut.lastIndexOf('}');
    try {
      parsed = a >= 0 && b > a ? JSON.parse(brut.slice(a, b + 1)) : null;
    } catch {
      parsed = null;
    }
    /*
     * Une sortie sans qualification n'est ni jugée ni mémorisée : la mémoire
     * rendrait ensuite « critère non traité » à chaque lecture, pour rien.
     * L'échec est reprenable ; la reprise repose la question.
     */
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { criteria?: unknown }).criteria)) {
      throw new Error('réponse du modèle illisible : aucune qualification exploitable');
    }
    if (options.cache) repos.clientCache.putQualification({ key: cleQualification, domain: candidat.domain, briefHash: briefHash(brief), contentHash: sha256(prompt), model: deps.model, output: parsed });
  }
  const qualification = resolveQualification(parsed, brief, catalogue);
  T.llm += fin();
  cc.setStage(candidat.id, 'QUALIFIED', { name: nom, addCostUsd: coutAppel, detail: { contacts: contactDetail, blocksSent: selection.kept, blocksTotal: selection.total, qualificationCache: enMemoire ? 'HIT' : 'MISS' } });

  // ── 7. Décision, tri, note : déterministes ────────────────────────────────
  const risque = generalistRisk({ pages, links, precheck, modelVerdict: qualification.specialisation.verdict, modelNote: qualification.specialisation.note });
  const decision = decideCandidate({
    criteria: qualification.criteria, specialisation: qualification.specialisation,
    competitors: [], preferSpecialist: brief.preferSpecialist, countryStatus: fit.fit,
  });
  if (canal.method === 'EMAIL' && canal.sameDomain === false) decision.toConfirm.push('canal (adresse hors du domaine du site)');
  else if (canal.method === 'EMAIL' && canal.confidence === 'LOW') decision.toConfirm.push('canal (boîte sans intention lisible)');
  if (contradiction.length > 0) {
    const detail = `pays (signaux contradictoires : ${contradiction.join(', ')})`;
    const i = decision.toConfirm.indexOf('pays');
    if (i >= 0) decision.toConfirm[i] = detail; else decision.toConfirm.push(detail);
  }
  const score = scoreCriteria(qualification.criteria);
  const triage = triageCandidate({
    decision, criteria: qualification.criteria, specialisation: qualification.specialisation,
    countryStatus: fit.fit, contradiction, score: { total: score.total, confidence: score.confidence },
    generalistRisk: risque.score, contact: { method: canal.method, confidence: canal.confidence },
    preferSpecialist: brief.preferSpecialist, relevanceHits: precheck.hits.length,
  });
  mesure.toConfirm = decision.toConfirm.length;
  mesure.triage = triage.status;

  // ── 8. Écriture : société, preuves, contacts, opportunité ─────────────────
  fin = chrono();
  const company = persistCompany(deps, brief, runId, candidat, nom, pays, qualification.activity, qualification.sectors);
  const opportunity = repos.opportunities.findByCompany(runId, company.id)
    ?? repos.opportunities.register({
      missionId: runId, departmentKey: DEPARTMENT, companyId: company.id,
      targetTypes: brief.targetRoles, discoveredBy: 'client-mission',
    }).opportunity;

  const preuves: Array<{ field: string; claim: string; sourceUrl: string; nature: 'observed' | 'inferred'; basis: string | null }> = [];
  for (const c of qualification.criteria) {
    for (const e of c.evidence) {
      preuves.push({ field: `criterion:${c.key}`, claim: e.evidenceQuote, sourceUrl: e.sourceUrl, nature: 'observed', basis: `${c.verdict} — ${c.note}` });
    }
  }
  for (const e of qualification.specialisation.evidence) {
    preuves.push({ field: 'specialisation', claim: e.evidenceQuote, sourceUrl: e.sourceUrl, nature: 'observed', basis: `${qualification.specialisation.verdict} — ${qualification.specialisation.note}` });
  }
  if (pays && paysDetail.quote && paysDetail.sourceUrl) {
    preuves.push({ field: 'country', claim: paysDetail.quote, sourceUrl: paysDetail.sourceUrl, nature: 'observed', basis: `${paysDetail.basis} → ${pays}` });
  }
  if (qualification.activity) {
    preuves.push({ field: 'activity', claim: qualification.activity, sourceUrl: candidat.url, nature: 'inferred', basis: 'résumé du modèle à partir des pages lues — à relire' });
  }
  const evidenceIds = persistEvidence(deps, runId, company.id, opportunity.id, preuves);
  persistContacts(deps, company.id, { ...contacts, publicEmails: emailChoisi ? [emailChoisi] : [] }, evidenceIds[0] ?? null);
  const idsParChamp = new Map<string, string[]>();
  preuves.forEach((p, i) => {
    const id = evidenceIds[i];
    if (id) idsParChamp.set(p.field, [...(idsParChamp.get(p.field) ?? []), id]);
  });

  const checks = qualification.criteria.map((c) => ({
    criterion: `${c.key} · ${c.label}`,
    passed: c.verdict === 'ESTABLISHED',
    detail: `${c.verdict}${c.downgraded ? ` (${c.downgraded})` : ''} — ${c.note}`,
    evidenceIds: idsParChamp.get(`criterion:${c.key}`) ?? [],
  }));
  repos.opportunities.setQualification(opportunity.id, {
    verdict: triage.status === 'AUTO_APPROVED' ? 'qualified' : triage.status === 'AUTO_EXCLUDED' ? 'rejected' : 'uncertain',
    checks, rationale: triage.reasons.length ? triage.reasons.join(' ; ') : decision.reason, confidence: score.confidence, decidedBy: 'client-mission', decidedAt: now(),
  });
  repos.opportunities.setScore(opportunity.id, {
    total: score.total, confidence: score.confidence,
    components: score.components.map((k) => ({
      dimension: k.dimension, label: k.label, value: k.value, weight: k.weight, contribution: k.contribution,
      rationale: k.rationale, confidence: k.confidence,
      evidenceIds: idsParChamp.get(`criterion:${k.dimension}`) ?? [], computed: false,
    })),
    roleFits: [], modelVersion: 'client-criteria-v2', scoredBy: 'client-mission', scoredAt: now(),
  });
  repos.opportunities.setStage(opportunity.id, triage.status === 'AUTO_EXCLUDED' ? 'rejected' : 'scored');

  const stage = triage.status === 'AUTO_APPROVED' ? 'RETAINED' : triage.status === 'HUMAN_REVIEW' ? 'REVIEW_REQUIRED' : 'EXCLUDED';
  const premierePreuve = qualification.criteria.flatMap((c) => c.evidence)[0];
  const preuveExclusion = qualification.criteria.find((c) => c.kind === 'required' && c.verdict === 'NOT_ESTABLISHED')?.evidence[0]
    ?? qualification.specialisation.evidence[0] ?? premierePreuve;
  cc.setStage(candidat.id, stage, {
    name: nom, companyId: company.id, opportunityId: opportunity.id,
    category: decision.category, reason: triage.reasons[0] ?? decision.reason,
    evidenceQuote: stage === 'EXCLUDED' ? (preuveExclusion?.evidenceQuote ?? null) : (premierePreuve?.evidenceQuote ?? null),
    evidenceUrl: stage === 'EXCLUDED' ? (preuveExclusion?.sourceUrl ?? null) : (premierePreuve?.sourceUrl ?? null),
    detail: {
      country: paysDetail,
      activity: qualification.activity,
      sectors: qualification.sectors,
      criteria: summariseCriteria(qualification.criteria),
      specialisation: summariseSpecialisation(qualification.specialisation),
      generalistRisk: risque,
      toConfirm: decision.toConfirm,
      score: { total: score.total, confidence: score.confidence },
      triage,
      decision: { outcome: decision.outcome, category: decision.category, reason: decision.reason },
      verifiedAt: now(),
      identity: { name: nom, confidence: identite.confidence, reason: identite.reason },
      timing: { ...T, persist: fin() },
    },
  });
  T.persist += fin();
  return stage === 'RETAINED' ? 'RETAINED' : stage === 'REVIEW_REQUIRED' ? 'REVIEW_REQUIRED' : 'EXCLUDED';
}

/** Le titre de la page d'accueil, débarrassé de son slogan après le séparateur. */
export function titreDuSite(pages: ReadonlyArray<{ url: string; html: string }>): string | null {
  const accueil = pages.find((p) => { try { return new URL(p.url).pathname.replace(/\/+$/, '') === ''; } catch { return false; } }) ?? pages[0];
  const brut = accueil ? pageTitle(accueil.html) : null;
  if (!brut) return null;
  // « Rörkopplingar, manometrar & säkerhetsventiler |&nbsp[iTEMS » : le
  // séparateur n'est pas toujours entouré d'espaces, et une entité peut y
  // coller. On coupe au premier séparateur, espaces ou pas, puis on nettoie.
  const segments = brut.replace(/\u00a0/g, ' ').split(/\s*[|–—]\s*|\s+-\s+/).map((t) => t.replace(/[\[\]]/g, '').trim()).filter((t) => t.length >= 2 && t.length <= 60);
  if (segments.length === 0) return null;
  // « Start | Svenska kraftnät » : le premier segment est le nom de la page, pas celui de la société.
  const generique = /^(?:start|startsida|hem|home|homepage|accueil|welcome|välkommen|valkommen|index|startseite|willkommen)$/i;
  const utiles = segments.filter((t) => !generique.test(t));
  if (utiles.length === 0) return null;
  // Le segment qui reprend le domaine l'emporte : « Pronova » pour pronovaab.se.
  const racine = (() => { try { return new URL((accueil ?? pages[0])!.url).hostname.replace(/^www\./, '').split('.')[0] ?? ''; } catch { return ''; } })();
  const plat = (t: string) => t.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const parDomaine = racine.length >= 3 ? utiles.find((t) => plat(t).includes(racine.slice(0, Math.min(racine.length, 6))) || racine.includes(plat(t).slice(0, 6))) : undefined;
  return parDomaine ?? utiles[0]!;
}

function summariseCriteria(criteria: readonly CriterionResult[]): Array<Record<string, unknown>> {
  return criteria.map((c) => ({
    key: c.key, label: c.label, kind: c.kind, verdict: c.verdict, note: c.note, downgraded: c.downgraded,
    evidence: c.evidence.map((e) => ({ quote: e.evidenceQuote, url: e.sourceUrl })),
  }));
}

function summariseSpecialisation(s: SpecialisationResult): Record<string, unknown> {
  return { verdict: s.verdict, note: s.note, evidence: s.evidence.map((e) => ({ quote: e.evidenceQuote, url: e.sourceUrl })) };
}

function persistCompany(
  deps: ClientMissionDeps, brief: ClientBrief, runId: string, candidat: ClientCandidate,
  nom: string, pays: string | null, activity: string | null, sectors: string[],
) {
  const { company } = deps.repos.companies.upsert({
    canonicalKey: canonicalKey({ name: nom, domain: candidat.domain }),
    name: nom,
    country: pays,
    website: `https://${candidat.domain}`,
    domain: candidat.domain,
    industries: sectors,
    description: activity,
    profile: { clientRun: runId, briefVersion: brief.version },
    dataOrigin: 'live',
  });
  return company;
}

function persistEvidence(
  deps: ClientMissionDeps, runId: string, companyId: string, opportunityId: string | null,
  preuves: ReadonlyArray<{ field: string; claim: string; sourceUrl: string; nature: 'observed' | 'inferred'; basis: string | null }>,
): string[] {
  const ids: string[] = [];
  for (const p of preuves) {
    const existante = deps.repos.companies.findIdenticalEvidence(companyId, p.field, p.claim);
    if (existante) { ids.push(existante.id); continue; }
    const host = normaliseHost(p.sourceUrl) ?? 'site';
    const source = deps.repos.companies.ensureSource({
      key: `company-website:${host}`, kind: 'company-website', label: host, reference: host, reliability: 0.8,
    });
    const e = deps.repos.companies.appendEvidence({
      companyId, opportunityId, missionId: runId,
      field: p.field, claim: p.claim, value: null, nature: p.nature,
      sourceKey: source.key, sourceRef: p.sourceUrl, sourceTitle: null, basis: p.basis,
      confidence: p.nature === 'observed' ? 0.95 : 0.6, simulated: false, collectedAt: nowIso(), agentKey: 'client-mission',
    });
    ids.push(e.id);
  }
  return ids;
}

function persistContacts(
  deps: ClientMissionDeps, companyId: string,
  contacts: ReturnType<typeof resolveContacts>, evidenceId: string | null,
): void {
  const existants = deps.repos.companies.contactsFor(companyId);
  const deja = (email: string | null, phone: string | null) =>
    existants.some((c) => (email && c.email === email) || (phone && c.phone === phone));
  const email = contacts.publicEmails[0] ?? null;
  const phone = contacts.publicPhones[0] ?? null;
  if (!email && !phone) return;
  if (deja(email?.value ?? null, phone?.value ?? null)) return;
  deps.repos.companies.addContact({
    companyId,
    // Une personne n'apparaît que si elle est publiée ; sinon le contact est la
    // boîte, nommée comme telle — « Contact général » est reconnu générique par
    // le rapport, qui ne le présentera jamais comme un interlocuteur nommé.
    name: contacts.contactPersonName ?? (email ? `Contact général (${email.value.split('@')[0]}@)` : 'Standard'),
    role: contacts.contactPersonRole,
    email: email?.value ?? null,
    phone: phone?.value ?? null,
    linkedin: null,
    confidence: email?.confidence === 'HIGH' ? 0.9 : 0.7,
    evidenceId,
  });
}
