import type { AtlasConfig } from '@atlas/core';
import type { Repositories, ExpansionRun, ExpansionCandidate, ExpansionStage, SourceTrust, EntityKind } from '@atlas/data';
import { fetchRawPages, type SearchResult } from '@atlas/intelligence';
import { ATLAS_SALES_ICP, classifyPageType, looksLikeCompanySite, whyNotACompanyName, looksLikePageTitle, extractCountryEvidence, isTechnicalDomain, siteLinks } from '@atlas/departments';
import type {
  ExpansionDeps, ExpansionOptions, ExpansionLimits, ExpansionIcp, ExpansionSeed, ExpansionStats, ExpansionReport,
  Finding, Hypothesis, SeedProfile, StrategyKey, EntityRef, RelationshipType,
} from './types.ts';
import { DEFAULT_EXPANSION_LIMITS, DEFAULT_SEARCH_PACING } from './types.ts';
import {
  entityKeyOf, refFrom, isJunkDomain, looksLikeListicle, trustOf, countryHintOf, countryMentionedIn, normaliseCountry,
  htmlToText, titleOf, metaDescriptionOf, externalLinks, nameFromLink, domainOfUrl, flatten, normaliseCompanyName, cleanCompanyName,
  looksLikeCreditLink, looksLikeNavigationLabel, looksLikeInstitution, keywordHit,
} from './normalize.ts';
import { strategiesFor, keywordsFrom, SITE_PAGES } from './strategies.ts';
import { scoreCandidate } from './score.ts';
import { profileActivity, confirmRelationships } from './llm.ts';

/**
 * Le moteur : une graine, des hypothèses, des preuves, un graphe borné.
 *
 *   pour chaque graine (profondeur 0, puis 1, puis 2 au plus) :
 *     lire sa page d'accueil → profil d'activité (mots de métier)
 *     pour chaque stratégie : planifier des hypothèses
 *     exécuter chaque hypothèse sous les plafonds → trouvailles (cible, relation, preuve)
 *     normaliser, dédoublonner (une entité par clé), écrire relations et preuves
 *     lire le site des meilleurs candidats (pays prouvé, activité) si le plafond de lectures le permet
 *     qualifier, noter, étager : UNIVERSE → RELEVANT → QUALIFIED → HIGH_PRIORITY
 *     les enfants sûrs deviennent graines de la profondeur suivante
 *     écrire la progression — un arrêt reprend ici, sans rien refaire
 *
 * Les plafonds sont durs : graines, enfants par graine, candidats, requêtes,
 * lectures, coût IA, profondeur, durée. Le premier atteint arrête ce qu'il
 * plafonne et le dit dans `stoppedBy` — jamais en silence.
 *
 * Rien ici n'écrit à personne. Un candidat prioritaire peut être *versé*
 * dans la file commerciale (état DISCOVERED, avec ses preuves) par
 * `promoteCandidates` — et suit alors les gardes existantes.
 */

export const EXPANSION_TASK_TYPE = 'PROSPECT_EXPANSION';

interface Counters {
  searchCalls: number;
  searchCostUsd: number;
  fetches: number;
  aiCalls: number;
  aiCostUsd: number;
  rawCandidates: number;
  stoppedBy: Set<string>;
  /** Lectures de pages d'identité (F2) pour ce tour — non persisté, remis à zéro à chaque reprise. */
  identityFetches: number;
}

interface QueueItem {
  seed: ExpansionSeed;
  depth: number;
  /** La graine de profondeur 0 dont descend cet élément. */
  rootKey: string;
}

interface Progress {
  queue: QueueItem[];
  processed: string[];
  rawCandidates: number;
  stoppedBy: string[];
  startedAt: string;
  /** Lectures de pages d'identité (F2) : persisté pour que le plafond par tour survive une reprise. */
  identityFetches: number;
}

const MAX_RESULTS_PER_QUERY = 10;

export function salesIcpFor(config: AtlasConfig): ExpansionIcp {
  void config;
  return { countries: [...ATLAS_SALES_ICP.countries], keywords: [], exclusions: [...ATLAS_SALES_ICP.exclusions.keywords] };
}

export function resolveLimits(partial: Partial<ExpansionLimits> | undefined): ExpansionLimits {
  const limits = { ...DEFAULT_EXPANSION_LIMITS, ...(partial ?? {}) };
  for (const k of Object.keys(limits) as Array<keyof ExpansionLimits>) {
    if (!Number.isFinite(limits[k]) || limits[k] < 0) limits[k] = DEFAULT_EXPANSION_LIMITS[k];
  }
  limits.maxDepth = Math.min(limits.maxDepth, 2);
  return limits;
}

/** Le budget IA commercial qu'il reste aujourd'hui — celui des workers, partagé. */
export function salesAiBudgetRemaining(repos: Repositories, config: AtlasConfig, now: Date): number {
  const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const spent = repos.llmCalls.usageSince(dayStart).knownCostUsd;
  return Math.max(0, config.sales.dailyAiBudgetUsd - spent);
}

// ─── Le tour ─────────────────────────────────────────────────────────────────

export async function runExpansion(deps: ExpansionDeps, options: ExpansionOptions): Promise<{ run: ExpansionRun; report: ExpansionReport }> {
  const { repos, config, logger } = deps;
  const now = options.now ?? (() => new Date());
  const startedMs = Date.now();
  const purpose = options.purpose ?? 'SALES';
  const icp = options.icp ?? salesIcpFor(config);
  const limits = resolveLimits(options.limits);
  const strategies = strategiesFor(options.strategies);
  const heartbeat = options.heartbeat ?? (() => {});
  const fetchHtml = deps.fetchHtml ?? defaultFetchHtml(deps);

  // Les graines : sans doublon, sans entité technique, sous le plafond.
  const seeds: ExpansionSeed[] = [];
  const seen = new Set<string>();
  for (const raw of options.seeds) {
    const ref = refFrom({ name: raw.name, domain: raw.domain, url: raw.website, country: raw.country });
    if (ref.domain && isTechnicalDomain(ref.domain)) continue;
    const key = entityKeyOf(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    seeds.push({ ...ref, prospectId: raw.prospectId ?? null, activity: raw.activity ?? null });
    if (seeds.length >= limits.maxSeeds) break;
  }

  // Le tour : nouveau, ou repris là où il s'était arrêté.
  let run: ExpansionRun;
  let progress: Progress;
  const resumed = options.resumeRunId ? repos.expansion.run(options.resumeRunId) : null;
  if (resumed && resumed.status === 'RUNNING') {
    run = resumed;
    const p = resumed.progress as Partial<Progress>;
    progress = { queue: p.queue ?? [], processed: p.processed ?? [], rawCandidates: p.rawCandidates ?? 0, stoppedBy: p.stoppedBy ?? [], startedAt: p.startedAt ?? resumed.startedAt, identityFetches: p.identityFetches ?? 0 };
    logger.info('expansion : reprise', { runId: run.id, restants: progress.queue.length, traités: progress.processed.length });
  } else if (resumed) {
    return { run: resumed, report: expansionReport(repos, resumed.id) };
  } else {
    if (seeds.length === 0) throw new Error('aucune graine exploitable : une expansion part d’au moins une entreprise');
    run = repos.expansion.startRun({
      purpose, trigger: options.trigger ?? 'cli', missionId: options.missionId ?? null,
      seeds: seeds.map((s) => ({ ...s })), strategies: strategies.map((s) => s.key), limits: { ...limits }, icp: { ...icp }, startedAt: now().toISOString(),
    });
    progress = { queue: seeds.map((seed) => ({ seed, depth: 0, rootKey: entityKeyOf(seed) })), processed: [], rawCandidates: 0, stoppedBy: [], startedAt: now().toISOString(), identityFetches: 0 };
    for (const seed of seeds) {
      repos.expansion.upsertCandidate({ runId: run.id, entityKey: entityKeyOf(seed), companyName: seed.name, canonicalDomain: seed.domain, website: seed.website, country: seed.country, depth: 0, seedKey: entityKeyOf(seed), isSeed: true, discoveredAt: now().toISOString() });
    }
    repos.expansion.saveProgress(run.id, progress as unknown as Record<string, unknown>);
  }

  const counters: Counters = {
    searchCalls: run.searchCalls, searchCostUsd: run.searchCostUsd, fetches: run.fetches, aiCalls: run.aiCalls, aiCostUsd: run.aiCostUsd,
    rawCandidates: progress.rawCandidates, stoppedBy: new Set(progress.stoppedBy), identityFetches: progress.identityFetches,
  };
  const aiBudgetToday = purpose === 'SALES' ? salesAiBudgetRemaining(repos, config, now()) : Number.POSITIVE_INFINITY;
  const seedKeys = new Set(run.seeds.map((s) => entityKeyOf({ domain: typeof s.domain === 'string' ? s.domain : null, name: String(s.name ?? '') })));
  const reserve = Math.min(Math.floor(limits.maxFetches / 2), 16);
  const searchAllowance = Math.max(3, Math.ceil(limits.maxSearchCalls / Math.max(1, run.seeds.length)));
  const ctx: Ctx = { deps, run, icp, limits, counters, now, fetchHtml, heartbeat, aiBudgetToday, missionId: options.missionId ?? null, seedKeys, reserve, searchAllowance };

  let status: 'DONE' | 'CAPPED' | 'FAILED' = 'DONE';
  let error: string | null = null;
  try {
    while (progress.queue.length > 0) {
      heartbeat();
      if (Date.now() - startedMs > limits.maxWallMs) { counters.stoppedBy.add('MAX_WALL_MS'); break; }
      if (companiesInRun(repos, run.id) >= limits.maxCandidates) { counters.stoppedBy.add('MAX_CANDIDATES'); break; }
      const item = progress.queue.shift()!;
      const key = entityKeyOf(item.seed);
      if (progress.processed.includes(key)) continue;
      const children = await expandSeed(ctx, item, strategies);
      progress.processed.push(key);
      progress.rawCandidates = counters.rawCandidates;
      progress.identityFetches = counters.identityFetches;
      // Une graine à la profondeur d révèle des candidats à d+1. Un enfant ne
      // devient graine que si ses propres candidats (d+2) restent sous la
      // profondeur maximale : profondeur 1 = les expansions directes, rien
      // de plus ; profondeur 2 = un cran de plus, jamais deux.
      if (item.depth + 2 <= limits.maxDepth) {
        for (const child of children.slice(0, limits.maxChildrenPerSeed)) {
          const childKey = entityKeyOf(child);
          if (progress.processed.includes(childKey) || progress.queue.some((q) => entityKeyOf(q.seed) === childKey)) continue;
          progress.queue.push({ seed: child, depth: item.depth + 1, rootKey: item.rootKey });
        }
      }
      progress.stoppedBy = [...counters.stoppedBy];
      repos.expansion.saveProgress(run.id, progress as unknown as Record<string, unknown>, {
        searchCalls: counters.searchCalls, searchCostUsd: counters.searchCostUsd, aiCalls: counters.aiCalls, aiCostUsd: counters.aiCostUsd, fetches: counters.fetches,
      });
    }
    if (progress.queue.length > 0) status = 'CAPPED';
  } catch (err) {
    status = 'FAILED';
    error = err instanceof Error ? err.message : String(err);
    logger.error('expansion : échec', { runId: run.id, error });
  }

  const stats = computeStats(repos, run.id, { seeds: seeds.length || run.seeds.length, counters, durationMs: Date.now() - startedMs, startedAt: progress.startedAt, now: now() });
  const summary = summaryOf(stats);
  const finished = repos.expansion.finishRun(run.id, { status, stats: stats as unknown as Record<string, unknown>, summary, error, finishedAt: now().toISOString() });
  return { run: finished, report: expansionReport(repos, finished.id) };
}

/**
 * Un tour RUNNING est-il abandonné ?
 *
 * `updated_at` sert de battement : chaque graine traitée le rafraîchit
 * (`saveProgress`). Un tour mort ne le rafraîchit plus. Trente minutes sans
 * écriture — largement au-delà du temps d'une graine — distingue un tour
 * juste lent d'un tour laissé par un processus disparu.
 */
export const RUN_STALE_AFTER_MS = 30 * 60_000;

export function isRunStale(run: ExpansionRun, now: Date = new Date()): boolean {
  return now.getTime() - Date.parse(run.updatedAt) > RUN_STALE_AFTER_MS;
}

/** Reprendre tout tour laissé RUNNING par un processus mort. */
export async function resumeOpenExpansions(deps: ExpansionDeps, options: Omit<ExpansionOptions, 'seeds' | 'resumeRunId'> = {}): Promise<ExpansionRun[]> {
  const out: ExpansionRun[] = [];
  for (const open of deps.repos.expansion.openRuns()) {
    const { run } = await runExpansion(deps, {
      ...options, seeds: open.seeds as unknown as ExpansionSeed[], resumeRunId: open.id, purpose: open.purpose, missionId: open.missionId,
      // Les plafonds du tour, que l'appelant peut relever à la reprise (une durée épuisée, par exemple).
      strategies: open.strategies as StrategyKey[], limits: { ...(open.limits as Partial<ExpansionLimits>), ...(options.limits ?? {}) }, icp: (open.icp as unknown as ExpansionIcp) ?? undefined,
    });
    out.push(run);
  }
  return out;
}

function companiesInRun(repos: Repositories, runId: string): number {
  const c = repos.expansion.countByStage(runId);
  return c.UNIVERSE + c.RELEVANT + c.QUALIFIED + c.HIGH_PRIORITY + c.REJECTED;
}

// ─── Une graine ──────────────────────────────────────────────────────────────

interface Ctx {
  deps: ExpansionDeps;
  run: ExpansionRun;
  icp: ExpansionIcp;
  limits: ExpansionLimits;
  counters: Counters;
  now: () => Date;
  fetchHtml: (url: string) => Promise<string | null>;
  heartbeat: () => void;
  aiBudgetToday: number;
  missionId: string | null;
  /** Les graines de profondeur 0 : jamais des candidats, même retrouvées comme cibles. */
  seedKeys: Set<string>;
  /** Les lectures gardées pour l'enrichissement des candidats. */
  reserve: number;
  /** Les requêtes qu'une graine peut consommer. */
  searchAllowance: number;
}

async function expandSeed(ctx: Ctx, item: QueueItem, strategies: ReturnType<typeof strategiesFor>): Promise<ExpansionSeed[]> {
  const { deps, run, limits, counters } = ctx;
  const { repos, logger } = deps;
  const seedKey = entityKeyOf(item.seed);
  const profile = await profileSeed(ctx, item.seed);
  logger.info('expansion : graine', { runId: run.id, seed: item.seed.name, depth: item.depth, keywords: profile.keywords });

  // Chaque graine a sa part de requêtes : sans cela, la première épuisait
  // le plafond et les suivantes n'avaient que leurs pages officielles.
  //
  // Chaque stratégie a aussi sa part de trouvailles : sans quota, une seule
  // fédération de cinquante membres remplissait presque tout le tour d'un
  // seul type de relation. Le quota reprend le plafond global existant
  // (maxChildrenPerSeed * 3) et le répartit entre les stratégies actives —
  // au moins trois chacune, pour qu'une stratégie pauvre ne soit pas privée.
  const searchesBefore = counters.searchCalls;
  const findings: Finding[] = [];
  const strategyQuota = Math.max(3, Math.ceil((limits.maxChildrenPerSeed * 3) / Math.max(1, strategies.length)));
  for (const strategy of strategies) {
    let fromStrategy = 0;
    for (const hypothesis of strategy.plan(profile, ctx.icp)) {
      ctx.heartbeat();
      if (findings.length >= limits.maxChildrenPerSeed * 3) break;
      if (fromStrategy >= strategyQuota) break;
      if (hypothesis.kind !== 'READ_SITE' && counters.searchCalls - searchesBefore >= ctx.searchAllowance) break;
      const got = await execute(ctx, profile, hypothesis, strategy.key);
      const room = strategyQuota - fromStrategy;
      const kept = got.length > room ? got.slice(0, room) : got;
      findings.push(...kept);
      fromStrategy += kept.length;
    }
  }
  counters.rawCandidates += findings.length;

  // Normaliser, dédoublonner, écrire : une entité par clé, ses relations, ses preuves.
  //
  // Deux textes se distinguent : ce que la cible *dit d'elle-même* (le titre
  // et l'extrait de son propre site) et le *contexte* du lien qui la nomme
  // sur une page tierce. Le second sert d'indice ; il ne juge pas le métier —
  // une page « exposants du salon » dirait « salon » de chaque exposant, et
  // le profil les écarterait tous comme événementiel.
  const byKey = new Map<string, { ref: EntityRef & { kind: EntityKind }; snippets: string[]; contexts: string[]; findings: Finding[] }>();
  for (const f of findings) {
    const ref = refFrom({ name: f.target.name, domain: f.target.domain, url: f.target.website, country: f.target.country, kind: f.target.kind });
    const key = entityKeyOf(ref);
    if (ref.domain && (isJunkDomain(ref.domain) || isTechnicalDomain(ref.domain))) continue;
    if (looksLikeInstitution(ref.domain, ref.name)) continue;
    const entry = byKey.get(key) ?? { ref, snippets: [], contexts: [], findings: [] };
    if (f.snippet) (f.describesTarget ? entry.snippets : entry.contexts).push(f.snippet);
    if (!entry.ref.country && ref.country) entry.ref.country = ref.country;
    entry.findings.push(f);
    byKey.set(key, entry);
  }

  // L'avis du modèle sur les relations déduites — borné, optionnel.
  const opinions = await confirmInferred(ctx, profile, byKey);

  const children: Array<{ seed: ExpansionSeed; confidence: number; stage: ExpansionStage }> = [];
  for (const [key, entry] of byKey) {
    if (companiesInRun(repos, run.id) >= limits.maxCandidates && !repos.expansion.candidate(run.id, key)) {
      counters.stoppedBy.add('MAX_CANDIDATES');
      break;
    }
    const opinion = opinions.get(key);
    // Une graine du tour retrouvée comme cible (membre d'une fédération, par
    // exemple) garde sa ligne de graine : ses relations s'écrivent, elle n'est
    // pas notée comme candidate.
    const isSeed = key === seedKey || ctx.seedKeys.has(key) || Boolean(repos.expansion.candidate(run.id, key)?.isSeed);
    if (!isSeed) {
      repos.expansion.upsertCandidate({
        runId: run.id, entityKey: key, entityKind: entry.ref.kind, companyName: entry.ref.name, canonicalDomain: entry.ref.domain, website: entry.ref.website,
        country: entry.ref.country, depth: item.depth + 1, seedKey: item.rootKey, discoveredAt: ctx.now().toISOString(),
      });
    }
    for (const f of entry.findings) {
      if (opinion && opinion.relationship === 'NONE' && f.status === 'INFERRED') continue;
      const relationship = opinion && opinion.relationship !== 'NONE' && f.status === 'INFERRED' ? opinion.relationship : f.relationship;
      const confidence = opinion && f.status === 'INFERRED' ? Math.max(0.05, Math.min(0.95, (f.confidence + opinion.confidence) / 2)) : f.confidence;
      const summary = opinion && f.status === 'INFERRED' && opinion.reason ? `${f.evidenceSummary} · modèle : ${opinion.reason}` : f.evidenceSummary;
      repos.expansion.addRelationship({
        runId: run.id, sourceKey: entityKeyOf(f.source), sourceName: f.source.name, sourceKind: f.source.kind, targetKey: key, targetName: entry.ref.name,
        relationshipType: relationship, confidence: Number(confidence.toFixed(2)), status: f.status, evidenceUrl: f.evidenceUrl, evidenceSummary: summary,
        sourceMethod: f.method, sourceTrust: f.trust, country: entry.ref.country, sourceDate: null, discoveredAt: ctx.now().toISOString(),
      });
      repos.expansion.addEvidence({
        runId: run.id, entityKey: key, kind: 'RELATIONSHIP', claim: `${relationship} de ${f.source.name}`, url: f.evidenceUrl, excerpt: f.snippet ?? f.evidenceSummary,
        trust: f.trust, method: f.method, confidence: Number(confidence.toFixed(2)), collectedAt: ctx.now().toISOString(),
      });
    }
    if (isSeed) byKey.delete(key);
  }

  // Enrichir les meilleurs : lire leur site, prouver le pays, lire l'activité — puis noter tout le monde.
  const provisional = [...byKey.keys()].map((key) => ({ key, verdict: scoreOf(ctx, key, item.depth + 1, byKey.get(key)!, opinions.get(key)?.relevant ?? null, false) }))
    .sort((a, b) => b.verdict.score - a.verdict.score);
  for (const { key, verdict } of provisional) {
    if (verdict.score < 30 || counters.fetches >= limits.maxFetches) break;
    const entry = byKey.get(key)!;
    if (!entry.ref.domain || entry.ref.kind !== 'COMPANY') continue;
    await enrichCandidate(ctx, key, entry.ref, verdict.score);
  }

  for (const [key, entry] of byKey) {
    const existing = repos.expansion.candidate(run.id, key);
    if (!existing) continue;
    const proven = repos.expansion.evidenceOf(key).some((e) => e.kind === 'COUNTRY');
    const verdict = scoreOf(ctx, key, existing.depth, entry, opinions.get(key)?.relevant ?? null, proven);
    repos.expansion.setCandidateVerdict(existing.id, { stage: verdict.stage, icpStatus: verdict.icpStatus, score: verdict.score, scoreDetail: verdict.detail, rejectReason: verdict.rejectReason, country: (typeof verdict.detail.country === 'string' ? verdict.detail.country : null) ?? existing.country ?? entry.ref.country });
    const bestConfidence = Number(verdict.detail.bestConfidence ?? 0);
    if (entry.ref.kind === 'COMPANY' && (verdict.stage === 'QUALIFIED' || verdict.stage === 'HIGH_PRIORITY') && bestConfidence >= limits.minChildConfidence) {
      children.push({ seed: { ...entry.ref, activity: entry.snippets[0] ?? null }, confidence: bestConfidence, stage: verdict.stage });
    }
  }
  children.sort((a, b) => (a.stage === b.stage ? b.confidence - a.confidence : a.stage === 'HIGH_PRIORITY' ? -1 : 1));
  return children.map((c) => c.seed);
}

function scoreOf(ctx: Ctx, key: string, depth: number, entry: { snippets: string[]; contexts: string[] }, aiRelevant: boolean | null, countryProven: boolean) {
  const { repos } = ctx.deps;
  const candidate = repos.expansion.candidate(ctx.run.id, key);
  const relationships = repos.expansion.relationshipsTo(key);
  const evidence = repos.expansion.evidenceOf(key);
  const countryEvidence = evidence.find((e) => e.kind === 'COUNTRY');
  // Ce que la cible dit d'elle-même : son site lu (IDENTITY, ACTIVITY), puis ce qu'un résultat de recherche sur son site en disait.
  const own = [...evidence.filter((e) => e.kind === 'IDENTITY' || e.kind === 'ACTIVITY').map((e) => e.excerpt ?? e.claim), ...entry.snippets];
  return scoreCandidate({
    name: candidate?.companyName ?? key, domain: candidate?.canonicalDomain ?? null,
    country: countryEvidence ? normaliseCountry(countryEvidence.claim.replace(/^pays : /i, '')) : candidate?.country ?? null,
    countryProven: countryProven || Boolean(countryEvidence), depth, snippet: own.join(' · ').slice(0, 800) || null,
    context: entry.contexts.join(' · ').slice(0, 800) || null, aiRelevant, relationships, evidence, icp: ctx.icp,
  });
}

// ─── Le profil d'une graine ──────────────────────────────────────────────────

async function profileSeed(ctx: Ctx, seed: ExpansionSeed): Promise<SeedProfile> {
  const ref = refFrom({ name: seed.name, domain: seed.domain, url: seed.website, country: seed.country });
  const profile: SeedProfile = { entity: ref, activity: seed.activity ?? null, keywords: [], homepageUrl: null, homepageText: null };
  if (ref.domain && ctx.counters.fetches < ctx.limits.maxFetches) {
    const url = `https://${ref.domain}/`;
    const html = await readPage(ctx, url);
    if (html) {
      profile.homepageUrl = url;
      profile.homepageText = htmlToText(html, 4_000);
      const title = titleOf(html);
      const description = metaDescriptionOf(html);
      profile.activity = profile.activity ?? description ?? title;
      profile.keywords = keywordsFrom([title, description, profile.homepageText.slice(0, 1_200)]);
      if (!profile.entity.country) profile.entity.country = normaliseCountry(extractCountryEvidence([{ url, html }]).country) ?? countryMentionedIn(profile.homepageText.slice(0, 2_000)) ?? countryHintOf(ref.domain);
    }
  }
  if (profile.keywords.length === 0) profile.keywords = keywordsFrom([seed.activity, seed.name]);
  // Le modèle affine les mots de métier — quand il existe, et sous le plafond.
  if (ctx.deps.provider && profile.homepageText) {
    const outcome = await profileActivity(ctx.deps.provider, ctx.deps.config, profile, { runId: ctx.run.id, missionId: ctx.missionId }, (bound) => canSpendAi(ctx, bound));
    if (outcome.called) ctx.counters.aiCalls += 1;
    ctx.counters.aiCostUsd += outcome.costUsd;
    if (outcome.value) {
      profile.activity = outcome.value.activity ?? profile.activity;
      const terms = outcome.value.searchTerms.map((t) => flatten(t).trim()).filter((t) => t.length >= 3);
      if (terms.length > 0) profile.keywords = [...new Set([...terms, ...profile.keywords])].slice(0, 6);
      if (!profile.entity.country && outcome.value.country) profile.entity.country = normaliseCountry(outcome.value.country);
    }
  }
  return profile;
}

/**
 * La réservation d'un appel IA, avant qu'il parte.
 *
 * `boundUsd` est le coût maximal de l'appel au tarif connu ; `null`, le tarif
 * est inconnu et l'appel n'a pas lieu. Le budget commercial du jour est relu à
 * chaque réservation : d'autres workers le consomment pendant le tour.
 */
function canSpendAi(ctx: Ctx, boundUsd: number | null): boolean {
  if (boundUsd === null) { ctx.counters.stoppedBy.add('AI_PRICE_UNKNOWN'); return false; }
  if (ctx.counters.aiCostUsd + boundUsd > ctx.limits.maxAiCostUsd) { ctx.counters.stoppedBy.add('MAX_AI_COST'); return false; }
  if (ctx.counters.aiCostUsd + boundUsd > ctx.aiBudgetToday) { ctx.counters.stoppedBy.add('DAILY_AI_BUDGET'); return false; }
  if (ctx.run.purpose === 'SALES' && boundUsd > salesAiBudgetRemaining(ctx.deps.repos, ctx.deps.config, ctx.now())) {
    ctx.counters.stoppedBy.add('DAILY_AI_BUDGET');
    return false;
  }
  return true;
}

// ─── Exécuter une hypothèse ─────────────────────────────────────────────────

async function execute(ctx: Ctx, seed: SeedProfile, hypothesis: Hypothesis, method: StrategyKey): Promise<Finding[]> {
  switch (hypothesis.kind) {
    case 'READ_SITE': return readSite(ctx, seed, hypothesis, method);
    case 'SEARCH_COMPANIES': return searchCompanies(ctx, seed, hypothesis, method);
    case 'SEARCH_LISTINGS': return searchListings(ctx, seed, hypothesis, method);
  }
}

/** Le site de la source nomme d'autres entreprises : preuve OFFICIAL, relation VERIFIED. */
async function readSite(ctx: Ctx, seed: SeedProfile, h: Extract<Hypothesis, { kind: 'READ_SITE' }>, method: StrategyKey): Promise<Finding[]> {
  const domain = h.entity.domain;
  if (!domain) return [];
  const source = { ...h.entity, kind: 'COMPANY' as EntityKind };
  const homeUrl = `https://${domain}/`;
  const home = seed.homepageUrl === homeUrl && seed.homepageText ? await readPage(ctx, homeUrl, true) : await readPage(ctx, homeUrl);
  if (!home) return [];
  // Les pages du site qui promettent des distributeurs, partenaires, marques…
  const candidatesPages = internalLinks(home, homeUrl, domain)
    .map((l) => ({ ...l, page: h.pages.find((p) => p.match.test(`${l.path} ${l.text}`)) }))
    .filter((l): l is typeof l & { page: NonNullable<typeof l.page> } => Boolean(l.page))
    .slice(0, h.maxPages);
  const findings: Finding[] = [];
  const pagesToRead: Array<{ url: string; relationship: RelationshipType; label: string }> = candidatesPages.map((l) => ({ url: l.url, relationship: l.page.relationship, label: l.page.label }));
  // La page d'accueil elle-même porte parfois la liste (« nos distributeurs » en pied de page).
  for (const p of pagesToRead) {
    if (ctx.counters.fetches >= ctx.limits.maxFetches) { ctx.counters.stoppedBy.add('MAX_FETCHES'); break; }
    const html = await readPage(ctx, p.url);
    if (!html) continue;
    const ownLabel = domain.split('.')[0] ?? '';
    for (const link of externalLinks(html, p.url, domain, 60)) {
      if (looksLikeCreditLink(link.context, link.text)) continue;
      // « acme.boutique-platform.com » : la boutique ou le catalogue de la graine sur une plateforme, pas un tiers.
      if (ownLabel.length >= 4 && link.domain.startsWith(`${ownLabel}.`)) continue;
      const name = looksLikeNavigationLabel(link.text) ? nameFromLink({ ...link, text: '' }) : nameFromLink(link);
      if (whyNotACompanyName(name) && !/^[A-Z][a-z]+$/.test(name)) continue;
      findings.push({
        source, target: { name, domain: link.domain, website: link.url, country: countryHintOf(link.domain) },
        relationship: p.relationship, confidence: link.text && flatten(link.text).includes(flatten(name).slice(0, 6)) ? 0.85 : 0.8,
        status: 'VERIFIED', trust: 'OFFICIAL', evidenceUrl: p.url,
        evidenceSummary: `${p.label} de ${source.name} : lien vers ${link.domain}${link.text ? ` (« ${link.text.slice(0, 60)} »)` : ''}`,
        method, snippet: link.context || null, describesTarget: false,
      });
    }
  }
  return findings;
}

/** Une requête dont les résultats sont des sites d'entreprise : relation INFERRED, preuve SECONDARY — sauf quand la cible le dit elle-même. */
async function searchCompanies(ctx: Ctx, seed: SeedProfile, h: Extract<Hypothesis, { kind: 'SEARCH_COMPANIES' }>, method: StrategyKey): Promise<Finding[]> {
  const results = await search(ctx, h.query, h.country);
  const findings: Finding[] = [];
  const seedName = flatten(seed.entity.name);
  const seedWord = normaliseCompanyName(seed.entity.name).split(' ')[0] ?? seedName;
  const seedLabel = (seed.entity.domain ?? '').split('.')[0] ?? '';
  for (const r of results) {
    const domain = domainOfUrl(r.url);
    if (!domain || isJunkDomain(domain) || domain === seed.entity.domain) continue;
    if (looksLikeListicle(r.url, r.title)) continue;
    const page = classifyPageType({ url: r.url, domain, title: r.title, snippet: r.snippet });
    if (!page.ownerIsCandidate || !looksLikeCompanySite(r.url).ok) continue;
    const mentionsSeed = seedWord.length >= 4 && flatten(`${r.title} ${r.snippet}`).includes(seedWord);
    const needsMention = h.relationship !== 'SIMILAR_COMPANY';
    if (needsMention && !mentionsSeed) continue;
    const name = r.title ? refFrom({ name: r.title, url: r.url }).name : domain;
    if (whyNotACompanyName(name)) continue;
    // Une page *sur la graine* chez un tiers (fiche d'annuaire « Cirmeca à
    // Menetou-Salon », catalogue « advance-beauty.plateforme.com ») n'est pas
    // une autre entreprise : le titre nomme la graine, ou le sous-domaine la porte.
    if (seedWord.length >= 4 && normaliseCompanyName(name).startsWith(seedWord)) continue;
    if (seedLabel.length >= 4 && domain.startsWith(`${seedLabel}.`)) continue;
    const verified = needsMention && mentionsSeed;
    const target: EntityRef = { name, domain, website: `https://${domain}`, country: countryMentionedIn(r.snippet) ?? countryHintOf(domain) };
    findings.push({
      source: seed.entity, target,
      relationship: h.relationship, confidence: verified ? Math.min(0.9, h.baseConfidence + 0.3) : h.baseConfidence,
      status: verified ? 'VERIFIED' : 'INFERRED', trust: trustOf(r.url, seed.entity, target), evidenceUrl: r.url,
      evidenceSummary: verified ? `${domain} cite ${seed.entity.name} : « ${r.snippet.slice(0, 140)} »` : `résultat pour « ${h.query} » : ${r.title.slice(0, 80)}`,
      method, snippet: `${r.title} — ${r.snippet}`.slice(0, 400), describesTarget: true,
    });
  }
  return findings;
}

/** Un salon ou une fédération : trouver le site, puis la page des exposants / membres, puis les liens qu'elle porte. */
async function searchListings(ctx: Ctx, seed: SeedProfile, h: Extract<Hypothesis, { kind: 'SEARCH_LISTINGS' }>, method: StrategyKey): Promise<Finding[]> {
  const results = await search(ctx, h.query, h.country);
  const findings: Finding[] = [];
  const sites = new Map<string, SearchResult>();
  for (const r of results) {
    const domain = domainOfUrl(r.url);
    if (!domain || isJunkDomain(domain, { allowInstitutions: true }) || domain === seed.entity.domain) continue;
    if (!h.listingSite.test(`${domain} ${r.title} ${r.snippet.slice(0, 160)}`)) continue;
    if (!sites.has(domain)) sites.set(domain, r);
    if (sites.size >= h.maxSites) break;
  }
  for (const [domain, r] of sites) {
    if (ctx.counters.fetches >= ctx.limits.maxFetches) { ctx.counters.stoppedBy.add('MAX_FETCHES'); break; }
    const listing: EntityRef & { kind: EntityKind } = { name: refFrom({ name: r.title, url: r.url }).name, domain, website: `https://${domain}`, country: h.country, kind: h.listingKind };
    const first = await readPage(ctx, r.url);
    if (!first) continue;
    // L'événement ou la fédération doit parler du métier de la graine — et
    // pas d'un mot : un salon des technologies éducatives cite « cobotique »
    // une fois et n'est pas celui d'un fabricant de machines. Deux mots de
    // métier dans la page, ou le premier dans le titre.
    const firstText = htmlToText(first, 8_000);
    const firstTitle = titleOf(first) ?? '';
    const hits = seed.keywords.filter((k) => keywordHit(firstText, k)).length;
    const titled = seed.keywords.length > 0 && keywordHit(firstTitle, seed.keywords[0]!);
    if (seed.keywords.length > 0 && hits < 2 && !titled) continue;
    // Seule la page des membres / exposants fait foi : la page d'accueil d'un
    // salon lie ses outils, ses partenaires média, ses offres d'emploi — pas
    // ses exposants. Si le résultat n'est pas cette page, on la cherche depuis lui.
    const pages: Array<{ url: string; html: string }> = [];
    if (h.memberPage.test(r.url) || h.memberPage.test(titleOf(first) ?? '')) pages.push({ url: r.url, html: first });
    else {
      const memberLinks = internalLinks(first, r.url, domain).filter((l) => h.memberPage.test(`${l.path} ${l.text}`)).slice(0, 2);
      for (const l of memberLinks) {
        if (ctx.counters.fetches >= ctx.limits.maxFetches - ctx.reserve) break;
        const html = await readPage(ctx, l.url);
        if (html) pages.push({ url: l.url, html });
      }
    }
    for (const page of pages) {
      const links = externalLinks(page.html, page.url, domain, 80).filter((l) => !looksLikeCreditLink(l.context, l.text));
      // Une page de membres en liste au moins quelques-uns ; deux liens sortants sont un pied de page, pas une liste.
      if (links.length < 3) continue;
      // Une seule liste ne remplit pas le tour : au plus une part d'enfants par page.
      for (const link of links.slice(0, ctx.limits.maxChildrenPerSeed)) {
        const name = looksLikeNavigationLabel(link.text) ? nameFromLink({ ...link, text: '' }) : nameFromLink(link);
        if (whyNotACompanyName(name) && !/^[A-Z][a-z]+$/.test(name)) continue;
        findings.push({
          source: listing, target: { name, domain: link.domain, website: link.url, country: countryHintOf(link.domain) },
          relationship: h.relationship, confidence: 0.8, status: 'VERIFIED', trust: 'ASSOCIATION_EVENT', evidenceUrl: page.url,
          evidenceSummary: `${h.listingKind === 'EVENT' ? 'exposant' : 'membre'} listé par ${listing.name} : ${link.domain}`,
          method, snippet: link.context || null, describesTarget: false,
        });
      }
    }
  }
  return findings;
}

// ─── Les briques : recherche, lecture, liens internes ───────────────────────

const lastSearchAt = new WeakMap<Ctx, number>();
const sleep = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

async function search(ctx: Ctx, query: string, country: string | null): Promise<SearchResult[]> {
  const { deps, counters, limits } = ctx;
  if (!deps.search) return [];
  if (counters.searchCalls >= limits.maxSearchCalls) { counters.stoppedBy.add('MAX_SEARCH_CALLS'); return []; }
  // Le moteur a basculé (disjoncteur ouvert pour deux minutes) : inutile de
  // brûler le plafond sur des appels à vide. Le tour le dit, et ses graines
  // ne comptent pas comme explorées.
  if (counters.stoppedBy.has('SEARCH_UNAVAILABLE')) return [];
  const pacing = deps.pacing ?? DEFAULT_SEARCH_PACING;
  const since = Date.now() - (lastSearchAt.get(ctx) ?? 0);
  if (since < pacing.searchGapMs) await sleep(pacing.searchGapMs - since);
  counters.searchCalls += 1;
  const request = { query, country: countryCode(country), count: MAX_RESULTS_PER_QUERY };
  const context = { logger: deps.logger, timeoutMs: deps.config.search.timeoutMs };
  try {
    let response = await deps.search.search(request, context);
    lastSearchAt.set(ctx, Date.now());
    counters.searchCostUsd += response.costUsd ?? 0;
    // Un moteur qui dit « trop vite » : on recule une fois, sans compter un second appel plafonné.
    if (response.outcome === 'rate-limited' && pacing.backoffMs > 0) {
      await sleep(pacing.backoffMs);
      response = await deps.search.search(request, context);
      lastSearchAt.set(ctx, Date.now());
      counters.searchCostUsd += response.costUsd ?? 0;
    }
    if (response.outcome === 'rate-limited') counters.stoppedBy.add('SEARCH_RATE_LIMITED');
    if (response.outcome === 'unavailable') { counters.stoppedBy.add('SEARCH_UNAVAILABLE'); counters.searchCalls -= 1; }
    deps.logger.info('expansion : recherche', { query, country: request.country, outcome: response.outcome, results: response.results.length, hosts: response.results.slice(0, 6).map((r) => domainOfUrl(r.url)).join(', ') });
    return response.results;
  } catch (err) {
    lastSearchAt.set(ctx, Date.now());
    deps.logger.warn('expansion : recherche en échec', { query, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

const COUNTRY_CODES: Record<string, string> = { France: 'FR', Belgique: 'BE', Suisse: 'CH', Luxembourg: 'LU', Suède: 'SE', Allemagne: 'DE', Autriche: 'AT', Norvège: 'NO', Danemark: 'DK', Finlande: 'FI', 'Pays-Bas': 'NL', Italie: 'IT', Espagne: 'ES', Canada: 'CA', 'Royaume-Uni': 'GB' };
function countryCode(country: string | null): string | null {
  if (!country) return null;
  return COUNTRY_CODES[country] ?? (country.length === 2 ? country.toUpperCase() : null);
}

const pageCache = new WeakMap<Ctx, Map<string, string | null>>();

/**
 * Lire une page, sous le plafond de lectures.
 *
 * Les hypothèses (pages du site, salons, fédérations) laissent une *réserve*
 * aux lectures d'enrichissement — celles qui prouvent le pays et l'activité
 * d'un candidat. Sans elle, trois graines épuisaient le plafond avant qu'un
 * seul candidat ne soit lu, et rien ne pouvait devenir prioritaire.
 */
async function readPage(ctx: Ctx, url: string, free = false, purpose: 'hypothesis' | 'enrich' = 'hypothesis'): Promise<string | null> {
  let cache = pageCache.get(ctx);
  if (!cache) { cache = new Map(); pageCache.set(ctx, cache); }
  if (cache.has(url)) return cache.get(url)!;
  if (!free) {
    const ceiling = purpose === 'enrich' ? ctx.limits.maxFetches : ctx.limits.maxFetches - ctx.reserve;
    if (ctx.counters.fetches >= ceiling) { ctx.counters.stoppedBy.add('MAX_FETCHES'); return null; }
    ctx.counters.fetches += 1;
  }
  const html = await ctx.fetchHtml(url);
  cache.set(url, html);
  return html;
}

function defaultFetchHtml(deps: ExpansionDeps): (url: string) => Promise<string | null> {
  return async (url) => {
    const outcome = await fetchRawPages([url], { logger: deps.logger, timeoutMs: deps.config.search.timeoutMs, maxPages: 1 });
    return outcome.pages[0]?.html ?? null;
  };
}

function internalLinks(html: string, pageUrl: string, domain: string): Array<{ url: string; path: string; text: string }> {
  const out: Array<{ url: string; path: string; text: string }> = [];
  const seen = new Set<string>();
  const anchor = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,160}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(html)) !== null && out.length < 150) {
    let abs: URL;
    try { abs = new URL(m[1]!.trim(), pageUrl); } catch { continue; }
    if (abs.protocol !== 'https:' && abs.protocol !== 'http:') continue;
    const host = abs.hostname.replace(/^www\./, '').toLowerCase();
    if (host !== domain && !host.endsWith(`.${domain}`)) continue;
    if (/\.(pdf|jpe?g|png|gif|svg|zip|docx?|xlsx?|mp4)(\?|$)/i.test(abs.pathname)) continue;
    const path = abs.pathname.replace(/\/+$/, '');
    if (!path || seen.has(path)) continue;
    seen.add(path);
    abs.protocol = 'https:';
    abs.hash = '';
    out.push({ url: abs.href, path, text: htmlToText(m[2]!, 100).replace(/\n/g, ' ').trim() });
  }
  return out;
}

// ─── L'avis du modèle ────────────────────────────────────────────────────────

async function confirmInferred(ctx: Ctx, seed: SeedProfile, byKey: Map<string, { ref: EntityRef & { kind: EntityKind }; snippets: string[]; findings: Finding[] }>): Promise<Map<string, { relationship: RelationshipType | 'NONE'; relevant: boolean; confidence: number; reason: string }>> {
  const out = new Map<string, { relationship: RelationshipType | 'NONE'; relevant: boolean; confidence: number; reason: string }>();
  if (!ctx.deps.provider) return out;
  const inferred = [...byKey.entries()]
    .filter(([, e]) => e.ref.kind === 'COMPANY' && e.findings.some((f) => f.status === 'INFERRED'))
    .map(([key, e]) => ({ key, name: e.ref.name, snippet: e.snippets[0] ?? null, proposed: e.findings.find((f) => f.status === 'INFERRED')!.relationship }));
  for (let i = 0; i < inferred.length; i += 12) {
    const batch = inferred.slice(i, i + 12);
    const outcome = await confirmRelationships(ctx.deps.provider, ctx.deps.config, seed, batch, { runId: ctx.run.id, missionId: ctx.missionId }, (bound) => canSpendAi(ctx, bound));
    if (!outcome.called) break;
    ctx.counters.aiCalls += 1;
    ctx.counters.aiCostUsd += outcome.costUsd;
    for (const o of outcome.value ?? []) out.set(o.key, o);
  }
  return out;
}

// ─── Enrichir un candidat : son site, son pays, son activité ────────────────

/**
 * Au-delà de combien de fetches identité par tour on n'en lit plus : beaucoup
 * de PME ne publient leur pays que sur une page de contact, de mentions
 * légales ou d'about — jamais sur l'accueil. Une seule page de plus par
 * candidat, sous ce plafond de tour, suffit à le prouver sans faire exploser
 * le budget de lectures.
 */
const MAX_IDENTITY_FETCHES_PER_RUN = 5;

/**
 * La page d'identité à lire en second, dans l'ordre où une PME est le plus
 * susceptible d'y publier son adresse : contact d'abord (c'est elle qui porte
 * le plus souvent l'adresse), puis les pages obligatoires (mentions légales,
 * impressum), puis les pages de présentation.
 */
const IDENTITY_PAGE_PRIORITY: readonly RegExp[] = [
  /contact/i,
  /mentions?[-_ ]?l[ée]gales?|\blegal\b/i,
  /impressum|imprint/i,
  /\babout\b|a[- ]propos/i,
  /om[- ]?oss|foretag|f[oö]retag/i,
];

function pickIdentityLink(links: ReadonlyArray<{ url: string; text: string; kind: string }>): { url: string; text: string; kind: string } | undefined {
  const identity = links.filter((l) => l.kind === 'IDENTITY');
  for (const pattern of IDENTITY_PAGE_PRIORITY) {
    const hit = identity.find((l) => pattern.test(`${l.url} ${l.text}`));
    if (hit) return hit;
  }
  return identity[0];
}

async function enrichCandidate(ctx: Ctx, key: string, ref: EntityRef & { kind: EntityKind }, preliminaryScore: number): Promise<void> {
  const { repos } = ctx.deps;
  const url = `https://${ref.domain}/`;
  const html = await readPage(ctx, url, false, 'enrich');
  if (!html) return;
  const now = ctx.now().toISOString();
  const title = titleOf(html);
  const description = metaDescriptionOf(html);
  if (title || description) {
    repos.expansion.addEvidence({ runId: ctx.run.id, entityKey: key, kind: 'IDENTITY', claim: `site officiel : ${(title ?? description ?? '').slice(0, 120)}`, url, excerpt: description ?? title, trust: 'OFFICIAL', method: 'SITE', confidence: 0.9, collectedAt: now });
    const candidate = repos.expansion.candidate(ctx.run.id, key);
    if (candidate && description) repos.expansion.addEvidence({ runId: ctx.run.id, entityKey: key, kind: 'ACTIVITY', claim: description.slice(0, 200), url, excerpt: null, trust: 'OFFICIAL', method: 'SITE', confidence: 0.8, collectedAt: now });
  }
  const verdict = extractCountryEvidence([{ url, html }]);
  if (verdict.country) {
    repos.expansion.addEvidence({ runId: ctx.run.id, entityKey: key, kind: 'COUNTRY', claim: `pays : ${normaliseCountry(verdict.country) ?? verdict.country}`, url: verdict.sourceUrl ?? url, excerpt: verdict.quote, trust: 'OFFICIAL', method: verdict.basis, confidence: 0.9, collectedAt: now });
    return;
  }
  // L'accueil ne prouve pas le pays : beaucoup de PME ne l'écrivent que sur
  // leur page de contact ou leurs mentions légales. Une seule page de plus,
  // choisie parmi les liens IDENTITY déjà classés — jamais devinée, jamais
  // une recherche ou un appel modèle de plus.
  if (preliminaryScore < 50) return;
  if (ctx.counters.identityFetches >= MAX_IDENTITY_FETCHES_PER_RUN) return;
  if (ctx.counters.fetches >= ctx.limits.maxFetches) return;
  const identityLink = pickIdentityLink(siteLinks(html, url, ref.domain ?? ''));
  if (!identityLink) return;
  const identityHtml = await readPage(ctx, identityLink.url, false, 'enrich');
  if (!identityHtml) return;
  ctx.counters.identityFetches += 1;
  const identityVerdict = extractCountryEvidence([{ url: identityLink.url, html: identityHtml }]);
  if (identityVerdict.country) {
    repos.expansion.addEvidence({
      runId: ctx.run.id, entityKey: key, kind: 'COUNTRY', claim: `pays : ${normaliseCountry(identityVerdict.country) ?? identityVerdict.country}`,
      url: identityVerdict.sourceUrl ?? identityLink.url, excerpt: identityVerdict.quote, trust: 'OFFICIAL', method: identityVerdict.basis, confidence: 0.9, collectedAt: now,
    });
  }
}

// ─── Les chiffres, le rapport, le graphe ────────────────────────────────────

function computeStats(repos: Repositories, runId: string, input: { seeds: number; counters: Counters; durationMs: number; startedAt: string; now: Date }): ExpansionStats {
  const funnelCounts = repos.expansion.countByStage(runId);
  const universe = funnelCounts.UNIVERSE + funnelCounts.RELEVANT + funnelCounts.QUALIFIED + funnelCounts.HIGH_PRIORITY + funnelCounts.REJECTED;
  const relevant = funnelCounts.RELEVANT + funnelCounts.QUALIFIED + funnelCounts.HIGH_PRIORITY;
  const qualified = funnelCounts.QUALIFIED + funnelCounts.HIGH_PRIORITY;
  const companies = repos.expansion.candidates(runId, { kind: 'COMPANY', limit: 5_000 }).filter((c) => !c.isSeed);
  const withEvidence = companies.filter((c) => repos.expansion.evidenceOf(c.entityKey).length > 0).length;
  const knownBefore = new Set(repos.sales.knownDomains());
  const newCompanies = companies.filter((c) => !c.canonicalDomain || !knownBefore.has(c.canonicalDomain)).length;
  const rels = repos.expansion.relationshipsForRun(runId);
  const byStrategy: Record<string, number> = {};
  for (const r of rels) byStrategy[r.sourceMethod] = (byStrategy[r.sourceMethod] ?? 0) + 1;
  const cost = input.counters.searchCostUsd + input.counters.aiCostUsd;
  const retained = relevant;
  return {
    seeds: input.seeds, rawCandidates: input.counters.rawCandidates, uniqueCompanies: companies.length, newCompanies, relationships: rels.length,
    byRelationship: repos.expansion.relationshipCounts(runId), byStrategy, evidence: repos.expansion.evidenceCountsByTrust(runId),
    funnel: { universe, relevant, qualified, highPriority: funnelCounts.HIGH_PRIORITY, rejected: funnelCounts.REJECTED },
    relevantRate: universe > 0 ? Number((relevant / universe).toFixed(3)) : null,
    qualificationRate: universe > 0 ? Number((qualified / universe).toFixed(3)) : null,
    evidenceRate: companies.length > 0 ? Number((withEvidence / companies.length).toFixed(3)) : null,
    searchCalls: input.counters.searchCalls, fetches: input.counters.fetches, aiCalls: input.counters.aiCalls,
    searchCostUsd: Number(input.counters.searchCostUsd.toFixed(5)), aiCostUsd: Number(input.counters.aiCostUsd.toFixed(5)),
    costPerRetainedUsd: retained > 0 ? Number((cost / retained).toFixed(5)) : null,
    costPerQualifiedUsd: qualified > 0 ? Number((cost / qualified).toFixed(5)) : null,
    durationMs: input.durationMs, stoppedBy: [...input.counters.stoppedBy],
  };
}

function summaryOf(s: ExpansionStats): string {
  return `${s.seeds} graine(s) → ${s.uniqueCompanies} entreprise(s) unique(s) (${s.newCompanies} nouvelle(s)), ${s.relationships} relation(s) · ${s.funnel.relevant} pertinente(s), ${s.funnel.qualified} qualifiée(s), ${s.funnel.highPriority} prioritaire(s) · ${(s.searchCostUsd + s.aiCostUsd).toFixed(4)} $${s.stoppedBy.length ? ` · arrêté par ${s.stoppedBy.join(', ')}` : ''} · aucun message envoyé`;
}

export function expansionReport(repos: Repositories, runId: string): ExpansionReport {
  const run = repos.expansion.run(runId);
  if (!run) throw new Error(`tour d'expansion inconnu : ${runId}`);
  const stats = (run.stats as unknown as ExpansionStats | null) ?? null;
  const top = repos.expansion.candidates(runId, { kind: 'COMPANY', limit: 200 }).filter((c) => !c.isSeed && c.stage !== 'REJECTED').slice(0, 25).map((c) => {
    const rels = repos.expansion.relationshipsTo(c.entityKey);
    const ev = repos.expansion.evidenceOf(c.entityKey);
    const bestTrust = ev.reduce<SourceTrust | null>((acc, e) => (acc === null || rank(e.trust) > rank(acc) ? e.trust : acc), null);
    return { name: c.companyName, domain: c.canonicalDomain, country: c.country, stage: c.stage, score: c.score, relationships: [...new Set(rels.map((r) => r.relationshipType))], evidence: ev.length, bestTrust };
  });
  const emptyStats: ExpansionStats = {
    seeds: run.seeds.length, rawCandidates: 0, uniqueCompanies: 0, newCompanies: 0, relationships: 0, byRelationship: {}, byStrategy: {},
    evidence: { OFFICIAL: 0, ASSOCIATION_EVENT: 0, SECONDARY: 0 }, funnel: { universe: 0, relevant: 0, qualified: 0, highPriority: 0, rejected: 0 },
    relevantRate: null, qualificationRate: null, evidenceRate: null, searchCalls: run.searchCalls, fetches: run.fetches, aiCalls: run.aiCalls,
    searchCostUsd: run.searchCostUsd, aiCostUsd: run.aiCostUsd, costPerRetainedUsd: null, costPerQualifiedUsd: null, durationMs: 0, stoppedBy: [],
  };
  return { runId, status: run.status, stats: stats && 'funnel' in stats ? stats : emptyStats, topCandidates: top, summary: run.summary ?? '(en cours)' };
}

const rank = (t: SourceTrust) => (t === 'OFFICIAL' ? 3 : t === 'ASSOCIATION_EVENT' ? 2 : 1);

/** Le voisinage d'une entreprise : ce qu'on sait d'elle, et de qui elle tient. */
export function expansionGraph(repos: Repositories, entityKey: string): {
  entity: ExpansionCandidate | null;
  relationships: Array<{ direction: 'OUT' | 'IN'; other: string; otherName: string; type: string; confidence: number; status: string; trust: SourceTrust; evidenceUrl: string; summary: string }>;
  evidence: Array<{ kind: string; claim: string; url: string; trust: SourceTrust; confidence: number }>;
} {
  const key = entityKeyOf({ domain: entityKey.includes('.') ? entityKey : null, name: entityKey });
  const entity = latestCandidate(repos, key);
  const relationships = repos.expansion.relationshipsOf(key).map((r) => ({
    direction: r.sourceKey === key ? 'OUT' as const : 'IN' as const,
    other: r.sourceKey === key ? r.targetKey : r.sourceKey, otherName: r.sourceKey === key ? r.targetName : r.sourceName,
    type: r.relationshipType, confidence: r.confidence, status: r.status, trust: r.sourceTrust, evidenceUrl: r.evidenceUrl, summary: r.evidenceSummary,
  }));
  const evidence = repos.expansion.evidenceOf(key).map((e) => ({ kind: e.kind, claim: e.claim, url: e.url, trust: e.trust, confidence: e.confidence }));
  return { entity, relationships, evidence };
}

function latestCandidate(repos: Repositories, key: string): ExpansionCandidate | null {
  for (const run of repos.expansion.runs(50)) {
    const c = repos.expansion.candidate(run.id, key);
    if (c) return c;
  }
  return null;
}

// ─── Verser dans la file commerciale ────────────────────────────────────────

/**
 * Les candidats qualifiés / prioritaires d'un tour entrent dans la file
 * commerciale comme prospects DISCOVERED, avec leurs preuves — et rien de
 * plus : la qualification payante, le contact, le brouillon et l'approbation
 * restent au lot commercial et à ses gardes. Une entreprise déjà connue du
 * registre n'est pas recréée ; une entité technique jamais versée.
 */
export function promoteCandidates(repos: Repositories, runId: string, options: { minStage?: ExpansionStage; limit?: number; now?: Date } = {}): { promoted: string[]; skipped: Array<{ name: string; reason: string }> } {
  const run = repos.expansion.run(runId);
  if (!run) throw new Error(`tour d'expansion inconnu : ${runId}`);
  if (run.purpose !== 'SALES') return { promoted: [], skipped: [{ name: '*', reason: 'un tour de mission client ne verse rien dans notre file commerciale' }] };
  const minStage = options.minStage ?? 'QUALIFIED';
  const wanted: ExpansionStage[] = minStage === 'HIGH_PRIORITY' ? ['HIGH_PRIORITY'] : ['HIGH_PRIORITY', 'QUALIFIED'];
  const known = repos.sales.knownDomains();
  const batchId = `xpn_${runId.slice(-8)}`;
  const promoted: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const now = (options.now ?? new Date()).toISOString();
  for (const c of repos.expansion.candidates(runId, { kind: 'COMPANY', limit: 500 }).filter((x) => !x.isSeed && wanted.includes(x.stage))) {
    if (promoted.length >= (options.limit ?? 50)) break;
    if (c.prospectId) { skipped.push({ name: c.companyName, reason: 'déjà versé' }); continue; }
    if (!c.canonicalDomain) { skipped.push({ name: c.companyName, reason: 'sans domaine' }); continue; }
    if (isTechnicalDomain(c.canonicalDomain)) { skipped.push({ name: c.companyName, reason: 'entité technique' }); continue; }
    if (known.has(c.canonicalDomain)) { skipped.push({ name: c.companyName, reason: 'déjà dans le registre commercial' }); continue; }
    const rels = repos.expansion.relationshipsTo(c.entityKey);
    const best = rels[0];
    const { prospect } = repos.sales.discover({
      batchId, companyName: c.companyName, domain: c.canonicalDomain, website: c.website, country: c.country, industry: null,
      sourceUrl: best?.evidenceUrl ?? null, searchProvider: 'expansion', query: best ? `${best.relationshipType} de ${best.sourceName}` : null, discoveredAt: now,
      searchTitle: null, pageType: 'OFFICIAL_COMPANY_SITE',
    });
    for (const ev of repos.expansion.evidenceOf(c.entityKey).slice(0, 8)) {
      repos.sales.addEvidence({ prospectId: prospect.id, field: ev.kind.toLowerCase(), claim: ev.claim, nature: ev.trust === 'SECONDARY' ? 'reported' : 'observed', sourceUrl: ev.url, basis: `expansion:${ev.method}`, confidence: ev.confidence });
    }
    repos.expansion.linkProspect(c.id, prospect.id);
    known.add(c.canonicalDomain);
    promoted.push(prospect.id);
  }
  return { promoted, skipped };
}

/** Les graines les plus fortes du registre commercial : PRIORITY puis GOOD_FIT, avec un site, jamais techniques, jamais déjà graines récemment. */
export function strongestSeeds(repos: Repositories, options: { limit?: number; excludeSeededWithinMs?: number; now?: Date } = {}): ExpansionSeed[] {
  const now = options.now ?? new Date();
  const recentSeedKeys = new Set<string>();
  for (const run of repos.expansion.runs(30)) {
    if (run.status !== 'DONE' && run.status !== 'CAPPED') continue;
    if (options.excludeSeededWithinMs !== undefined && now.getTime() - Date.parse(run.startedAt) > options.excludeSeededWithinMs) continue;
    // Un tour sans moteur n'a pas exploré ses graines : elles restent à faire.
    const stoppedBy = ((run.stats as { stoppedBy?: string[] }).stoppedBy ?? []);
    if (stoppedBy.includes('SEARCH_UNAVAILABLE')) continue;
    for (const s of run.seeds) if (typeof s.domain === 'string') recentSeedKeys.add(s.domain);
  }
  const prospects = repos.sales.discoveredSince(null)
    .filter((p) => p.domain && !isTechnicalDomain(p.domain) && !isJunkDomain(p.domain) && (p.tier === 'PRIORITY' || p.tier === 'GOOD_FIT') && p.state !== 'REJECTED' && p.state !== 'LOST')
    .filter((p) => !whyNotACompanyName(p.companyName))
    .filter((p) => !recentSeedKeys.has(p.domain!))
    .sort((a, b) => (a.tier === b.tier ? (b.score ?? 0) - (a.score ?? 0) : a.tier === 'PRIORITY' ? -1 : 1));
  const out: ExpansionSeed[] = [];
  const seen = new Set<string>();
  for (const p of prospects) {
    const key = p.domain!;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: seedNameOf(p.companyName, p.domain!), domain: p.domain, website: p.website, country: p.country, prospectId: p.id, activity: p.whyFit ?? p.industry ?? null });
    if (out.length >= (options.limit ?? 3)) break;
  }
  return out;
}

/**
 * Le nom d'une graine, tel qu'il entrera dans une requête.
 *
 * Le registre garde parfois un titre de page (« Distributeur & Devenir
 * revendeur chez igus ») là où une raison sociale manquait. Une requête
 * « "Distributeur & Devenir revendeur chez igus" concurrents » ne trouve
 * rien ; le libellé du domaine (« igus ») trouve. On nettoie, et si c'est
 * encore un titre, on prend le domaine.
 */
export function seedNameOf(name: string, domain: string): string {
  const cleaned = cleanCompanyName(name);
  if (cleaned && !looksLikePageTitle(cleaned) && !whyNotACompanyName(cleaned) && cleaned.split(/\s+/).length <= 4) return cleaned;
  const label = domain.split('.')[0] ?? domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export { SITE_PAGES };
