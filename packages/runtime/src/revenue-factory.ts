import { canonicalDomainOf, type AtlasConfig, type Logger } from '@atlas/core';
import { isCommercialEmail } from '@atlas/data';
import type {
  Repositories, SalesProspect, FactoryClass, FactoryVerdictInput, FactoryContactRoute, FactoryRecommendation,
  FactoryEvidenceRef, TaskRow,
} from '@atlas/data';
import {
  contactPagesFor, contactLinksIn, resolveContacts, collectSourcedFacts, scoreSalesProspect, whyNotACompanyName,
  isTechnicalDomain, isCommercialEvidence, isOfficialPage, quoteExistsInSource, cleanedText, chooseVariant, type SalesAssessment,
} from '@atlas/departments';
import { fetchRawPages } from '@atlas/intelligence';
import type { WorkerContext, WorkerOutcome } from './workers.ts';
import { SALES_ENGINE_TASKS, registryRecommendationsFor, replyReceivedFor, readStrategy } from './sales-engine.ts';
import { EXPANSION_TASK_TYPE, promoteExpansionBacklog } from './expansion/engine.ts';

/**
 * La fabrique de revenu — boucle A.
 *
 *   DISCOVER → FAST_REVENUE_CHECK → CONTACT_SEARCH → EVIDENCE
 *     → RECOMMENDATIONS → DEDUPE → REVENUE_SCORE → CLASSIFY → SEND_ELIGIBLE | NEXT
 *
 * Elle n'invente rien et ne découvre rien d'elle-même : elle prend ce que la
 * découverte (lot, expansion) a versé au registre commercial et le mène, une
 * entreprise après l'autre, jusqu'à un état explicite — HOT, WARM,
 * NEEDS_ENRICHMENT, DROP, DUPLICATE ou BLOCKED — et, à part, `send_eligible`.
 *
 * Pourquoi elle existe : sur l'image serveur, la qualification et la lecture
 * des contacts ne vivaient que dans `scripts/sales-batch.ts`, que l'image
 * dist-only n'embarque pas. Les prospects versés par l'expansion restaient
 * donc DISCOVERED, sans palier ni contact, et n'arrivaient jamais au premier
 * contact. La fabrique fait ce travail dans le daemon, avec les briques
 * existantes et sans appel de modèle :
 *
 *   · contacts : `contactPagesFor` + `resolveContacts` — lus sur le site
 *     officiel, jamais déduits d'une convention de nommage ;
 *   · faits : `collectSourcedFacts`, arrêt dès deux faits distincts ;
 *   · recommandations : `registryRecommendationsFor` — le graphe d'expansion
 *     du prospect, VERIFIED + OFFICIAL, commercial, 2 à 3 ou aucune. S'il en
 *     manque, la fabrique pose une expansion ciblée sur ce prospect : la
 *     recherche de ses partenaires est aussi une découverte ;
 *   · score : celui de la qualification existante s'il y en a un ; sinon un
 *     score déterministe, bâti sur ce qui a été observé — une dimension sans
 *     signal n'est pas évaluée, elle ne vaut pas zéro ;
 *   · gardes : `firstTouchReadiness`, suppression, réponse, envoi, identité.
 *
 * Une fois SEND_ELIGIBLE, plus rien n'est enrichi : le dossier est persisté
 * et la fabrique passe au suivant. Le premier contact (boucle B) ne consomme
 * que ce qu'elle a déclaré éligible.
 */

export const REVENUE_FACTORY_TASK = SALES_ENGINE_TASKS.FACTORY;
export const FACTORY_ACTOR = 'revenue-factory';
export const FACTORY_DAILY_TARGET = 50;

/** Les blocages qu'un passage de plus peut lever : tout le reste est terminal. */
const ENRICHABLE = [
  'NO_OBSERVED_EMAIL', 'EMAIL_NOT_COMMERCIAL', 'RECOMMENDATIONS_BELOW_2', 'IDENTITY_UNVERIFIED',
  'FETCH_FAILED', 'INSUFFICIENT_SIGNAL', 'STATE_DISCOVERED', 'NO_WEBSITE',
] as const;
const isEnrichable = (blocker: string): boolean =>
  (ENRICHABLE as readonly string[]).includes(blocker) || blocker.startsWith('SOURCED_FACTS_');

const COMMERCIAL_RELATIONSHIPS = new Set([
  'DISTRIBUTOR', 'RESELLER', 'INTEGRATOR', 'IMPORTER', 'WHOLESALER', 'INSTALLER',
  'MAINTENANCE_PARTNER', 'OEM_PARTNER', 'COMPLEMENTARY_VENDOR', 'LIKELY_CUSTOMER', 'VISIBLE_PARTNER',
]);

export interface FactoryLimits {
  /** Entreprises par tour. */
  batchSize: number;
  /** Entreprises examinées en parallèle : la lecture des sites est le seul temps long. */
  concurrency: number;
  /** Pages lues au plus par entreprise, contact et faits compris. */
  maxPagesPerCompany: number;
  /** Durée maximale d'un tour. */
  wallClockMs: number;
  /** Passages avant d'abandonner une entreprise sans aucun signal commercial. */
  maxAttempts: number;
  /** Délai avant de repasser une entreprise à enrichir. */
  retryAfterMs: number;
  /** Délai avant de revérifier les gardes d'une entreprise éligible non encore contactée. */
  recheckEligibleAfterMs: number;
  /** Expansions ciblées posées au plus par tour (recherche de recommandations). */
  maxExpansionsPerRun: number;
}

export const DEFAULT_FACTORY_LIMITS: FactoryLimits = {
  batchSize: 12,
  concurrency: 4,
  maxPagesPerCompany: 10,
  wallClockMs: 8 * 60_000,
  maxAttempts: 4,
  retryAfterMs: 6 * 3_600_000,
  recheckEligibleAfterMs: 24 * 3_600_000,
  maxExpansionsPerRun: 2,
};

export type FetchPages = (urls: readonly string[], maxPages: number) => Promise<{
  pages: ReadonlyArray<{ url: string; html: string }>;
  failures?: ReadonlyArray<{ url: string }>;
}>;

export interface FactoryDeps {
  repos: Repositories;
  config: AtlasConfig;
  logger: Logger;
  /** La lecture des pages, injectée : la fabrique se teste alors sans réseau. */
  fetchPages?: FetchPages;
  now?: () => Date;
}

export interface FactoryReport {
  runId: string;
  processed: number;
  byClass: Record<FactoryClass, number>;
  sendEligible: number;
  contactsFound: number;
  factsAdded: number;
  recommendationsReady: number;
  pagesFetched: number;
  fetchFailures: number;
  expansionsEnqueued: number;
  /** Prospects versés depuis le graphe d'expansion au début du tour (file courte). */
  promotedFromExpansion: number;
  errors: Array<{ domain: string; error: string }>;
  elapsedMs: number;
  costUsd: number;
  stopReason: string;
  queueRemaining: number;
}

const TIER_RANK: Record<string, number> = { PRIORITY: 0, GOOD_FIT: 1, WATCH: 2 };

/** Un domaine, un prospect : le mieux classé, puis le plus récent. */
function primaryOf(rows: readonly SalesProspect[]): SalesProspect {
  return [...rows].sort((a, b) => (TIER_RANK[a.tier ?? ''] ?? 3) - (TIER_RANK[b.tier ?? ''] ?? 3)
    || (b.score ?? -1) - (a.score ?? -1)
    || b.updatedAt.localeCompare(a.updatedAt)
    || a.id.localeCompare(b.id))[0]!;
}

/**
 * Le doublon d'une autre entreprise déjà connue : un sous-domaine d'un domaine
 * du registre (`shop.acme.fr` quand `acme.fr` existe). Deux domaines de pays
 * différents (`acme.fr`, `acme.de`) ne sont pas fusionnés : ce sont souvent
 * deux filiales, deux interlocuteurs.
 */
export function duplicateOf(domain: string, known: ReadonlySet<string>): string | null {
  const parts = domain.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join('.');
    if (parent !== domain && known.has(parent)) return parent;
  }
  return null;
}

export interface QueueItem {
  domain: string;
  prospect: SalesProspect;
  rows: number;
  reason: 'NEW' | 'RETRY_ENRICHMENT' | 'RECHECK_ELIGIBLE';
}

/**
 * Qui passer maintenant : d'abord ce qui n'a jamais été examiné (le plus
 * récent d'abord — c'est le plus frais), puis les entreprises à enrichir dont
 * le délai est écoulé, puis les éligibles non contactées à revérifier.
 */
export function factoryQueue(repos: Repositories, now: Date, limits: FactoryLimits = DEFAULT_FACTORY_LIMITS): QueueItem[] {
  const byDomain = new Map<string, SalesProspect[]>();
  for (const p of repos.sales.discoveredSince(null)) {
    if (!p.domain) continue;
    const domain = canonicalDomainOf(p.domain);
    if (!domain) continue;
    const list = byDomain.get(domain) ?? [];
    list.push(p);
    byDomain.set(domain, list);
  }
  const seen = repos.revenueFactory.lastProcessed();
  const fresh: QueueItem[] = [];
  const retry: QueueItem[] = [];
  const recheck: QueueItem[] = [];
  for (const [domain, rows] of byDomain) {
    const prospect = primaryOf(rows);
    const last = seen.get(domain);
    if (!last) { fresh.push({ domain, prospect, rows: rows.length, reason: 'NEW' }); continue; }
    const age = now.getTime() - Date.parse(last.processedAt);
    if (last.classification === 'NEEDS_ENRICHMENT' && age >= limits.retryAfterMs) {
      retry.push({ domain, prospect, rows: rows.length, reason: 'RETRY_ENRICHMENT' });
    } else if ((last.classification === 'HOT' || last.classification === 'WARM') && age >= limits.recheckEligibleAfterMs) {
      recheck.push({ domain, prospect, rows: rows.length, reason: 'RECHECK_ELIGIBLE' });
    }
  }
  fresh.sort((a, b) => b.prospect.discoveredAt.localeCompare(a.prospect.discoveredAt) || a.domain.localeCompare(b.domain));
  retry.sort((a, b) => (TIER_RANK[a.prospect.tier ?? ''] ?? 3) - (TIER_RANK[b.prospect.tier ?? ''] ?? 3) || a.domain.localeCompare(b.domain));
  recheck.sort((a, b) => a.domain.localeCompare(b.domain));
  return [...fresh, ...retry, ...recheck];
}

/** Les faits commerciaux, comptés comme le premier contact les compte. */
function commercialFacts(repos: Repositories, prospectId: string) {
  return repos.sales.evidenceFor(prospectId).filter((e) => e.nature !== 'inferred'
    && isCommercialEvidence(e) && /^https?:\/\//i.test(e.sourceUrl ?? ''));
}

/**
 * Le score déterministe : chaque dimension n'est évaluée que si un signal
 * observé la soutient. Aucune capacité à payer n'est affirmée sans preuve —
 * la dimension reste simplement hors du calcul.
 */
export function deterministicAssessments(input: {
  contactKind: 'EMAIL' | 'FORM' | 'PHONE' | null;
  commercialEmail: boolean;
  personName: string | null;
  personRole: string | null;
  factKinds: readonly string[];
  incomingCommercialRelationships: number;
}): SalesAssessment[] {
  const out: SalesAssessment[] = [];
  const has = (k: string) => input.factKinds.includes(k);
  if (input.contactKind) {
    const value = input.contactKind === 'EMAIL' && input.commercialEmail ? 85 : input.contactKind === 'FORM' ? 55 : 45;
    out.push({ dimension: 'accessibility', value, confidence: 0.8, evidenceIds: [], rationale: `route ${input.contactKind.toLowerCase()} observée sur le site officiel` });
  }
  if (input.personName) {
    out.push({ dimension: 'contactQuality', value: input.personRole ? 80 : 55, confidence: 0.7, evidenceIds: [], rationale: input.personRole ? 'personne nommée avec une fonction' : 'personne nommée, fonction non publiée' });
  }
  if (has('DISTRIBUTION') || has('SALES_HIRING') || has('EXPORT')) {
    out.push({ dimension: 'expansionSignal', value: 80, confidence: 0.75, evidenceIds: [], rationale: 'cherche revendeurs, export ou commerciaux (fait sourcé)' });
  } else if (has('NEW_CAPACITY')) {
    out.push({ dimension: 'expansionSignal', value: 60, confidence: 0.6, evidenceIds: [], rationale: 'nouveauté à faire connaître (fait sourcé)' });
  }
  if (has('DISTRIBUTION') || has('SALES_HIRING')) {
    out.push({ dimension: 'needFit', value: 75, confidence: 0.7, evidenceIds: [], rationale: 'besoin de clients ou de partenaires affiché' });
  } else if (has('NAMED_MARKETS') || has('EXPORT')) {
    out.push({ dimension: 'needFit', value: 60, confidence: 0.6, evidenceIds: [], rationale: 'marchés cibles nommés' });
  }
  if (input.incomingCommercialRelationships > 0 || has('NAMED_MARKETS')) {
    out.push({ dimension: 'b2bFit', value: 70, confidence: 0.65, evidenceIds: [], rationale: input.incomingCommercialRelationships > 0 ? 'relation commerciale vérifiée avec une entreprise du registre' : 'vend à des secteurs nommés' });
  }
  return out;
}

export function classOf(tier: string | null): FactoryClass {
  if (tier === 'PRIORITY') return 'HOT';
  if (tier === 'GOOD_FIT' || tier === 'WATCH') return 'WARM';
  return 'DROP';
}

interface WorkResult {
  input: FactoryVerdictInput;
  contactFound: boolean;
  factsAdded: number;
  pagesFetched: number;
  fetchFailures: number;
  expansion: boolean;
}

/** Un seul prospect, de bout en bout. Ne lance jamais d'exception pour une page illisible. */
async function processOne(
  deps: Required<Pick<FactoryDeps, 'repos' | 'config' | 'fetchPages'>> & { now: Date; runId: string; limits: FactoryLimits; knownDomains: ReadonlySet<string>; expansionBudget: { left: number } },
  item: QueueItem,
): Promise<WorkResult> {
  const { repos, config, now, runId, limits } = deps;
  const domain = item.domain;
  let p = item.prospect;
  const blockers: string[] = [];
  let pagesFetched = 0;
  let fetchFailures = 0;
  let contactFound = false;
  let factsAdded = 0;
  let expansion = false;
  const dedupe = item.rows > 1 ? `MERGED:${item.rows}` : 'UNIQUE';
  const attempts = (repos.revenueFactory.verdict(domain)?.attempts ?? 0) + 1;

  const verdict = (classification: FactoryClass, extra: Partial<FactoryVerdictInput> & { nextAction: string }): WorkResult => ({
    input: {
      domain, prospectId: p.id, companyName: p.companyName, corporateGroup: null, classification,
      sendEligible: false, revenueScore: p.score, scoreMethod: p.score !== null ? scoreMethodOf(p) : null,
      qualificationReason: p.whyFit, evidence: evidenceRefs(repos, p.id), contactRoutes: routesOf(p),
      recommendations: [], dedupeResult: dedupe, blockers, processingCostUsd: 0, pagesFetched, runId,
      processedAt: now.toISOString(), ...extra,
    },
    contactFound, factsAdded, pagesFetched, fetchFailures, expansion,
  });

  // ── DEDUPE et gardes terminales, avant toute lecture ──────────────────
  if (isTechnicalDomain(domain)) { blockers.push('TECHNICAL_DOMAIN'); return verdict('DROP', { nextAction: 'aucune — entité technique' }); }
  const parent = duplicateOf(domain, deps.knownDomains);
  if (parent) { blockers.push(`DUPLICATE_OF:${parent}`); return verdict('DUPLICATE', { dedupeResult: `DUPLICATE_OF:${parent}`, nextAction: `suivre ${parent}` }); }
  const ledger = repos.sales.ledgerFor(domain);
  if (ledger?.kind === 'DO_NOT_CONTACT') { blockers.push('DO_NOT_CONTACT'); return verdict('BLOCKED', { nextAction: 'aucune — ne pas contacter' }); }
  if (repos.salesEngine.isSuppressed({ email: p.contactEmail, domain, company: p.companyName }).suppressed) {
    blockers.push('SUPPRESSED'); return verdict('BLOCKED', { nextAction: 'aucune — liste de suppression' });
  }
  if (replyReceivedFor(repos, domain)) { blockers.push('REPLY_RECEIVED'); return verdict('BLOCKED', { nextAction: 'boucle B — lire la réponse' }); }
  if (ledger?.kind === 'CONTACTED' || repos.salesLoop.lastSentTo(domain) !== null || p.contactedAt) {
    blockers.push('ALREADY_CONTACTED'); return verdict('BLOCKED', { nextAction: 'boucle B — conversation en cours' });
  }
  if (p.state === 'REJECTED' || p.tier === 'REJECTED') { blockers.push('REJECTED_BY_QUALIFICATION'); return verdict('DROP', { nextAction: 'aucune — hors cible' }); }
  if (repos.sales.firstTouchReadiness(p.id).blockers.includes('INVALIDATED')) { blockers.push('INVALIDATED'); return verdict('DROP', { nextAction: 'aucune — dossier invalidé' }); }

  // ── Une entreprise déjà éligible n'est plus enrichie : on revérifie ses gardes ──
  const already = repos.revenueFactory.verdict(domain);
  const enrich = !(already?.sendEligible && item.reason === 'RECHECK_ELIGIBLE');

  let pages: Array<{ url: string; html: string }> = [];
  // L'identité est vérifiée dès qu'une page du domaine officiel a été lue :
  // un fait, la coordonnée retenue, ou la page d'entreprise qui l'a fait découvrir.
  const officialUrl = (url: string | null): boolean => Boolean(url) && isOfficialPage(url!, domain);
  let officialSeen = commercialFacts(repos, p.id).some((e) => officialUrl(e.sourceUrl))
    || officialUrl(p.contactSourceUrl)
    || (p.pageType === 'OFFICIAL_COMPANY_SITE' && officialUrl(p.sourceUrl));
  const hasWebsite = Boolean(p.website || domain);

  // ── CONTACT_SEARCH : sur le site officiel, jamais déduit ──────────────
  const contactKnown = p.contactObserved && Boolean(p.contactEmail || p.contactPage || p.contactPhone);
  // Le site déclaré d'abord ; s'il ne rend rien et que son origine diffère du
  // domaine canonique (www, http), le domaine canonique. Un site qui ne répond
  // que sur l'une des deux adresses est courant.
  let website = p.website;
  if (enrich && !contactKnown && hasWebsite) {
    const urls = contactPagesFor(p.website, domain);
    try {
      let first = await deps.fetchPages(urls, Math.min(4, limits.maxPagesPerCompany));
      fetchFailures += first.failures?.length ?? 0;
      const canonical = contactPagesFor(null, domain);
      if (first.pages.length === 0 && canonical[0] !== urls[0]) {
        first = await deps.fetchPages(canonical, Math.min(4, limits.maxPagesPerCompany));
        fetchFailures += first.failures?.length ?? 0;
        if (first.pages.length > 0) website = `https://${domain}`;
      }
      pages.push(...first.pages);
      const home = first.pages.find((pg) => safePath(pg.url) === '/');
      const extra = home ? contactLinksIn(home.html, home.url, domain).filter((u) => !pages.some((pg) => pg.url === u)).slice(0, 2) : [];
      if (extra.length > 0) {
        const more = await deps.fetchPages(extra, extra.length);
        pages.push(...more.pages);
        fetchFailures += more.failures?.length ?? 0;
      }
    } catch {
      fetchFailures += urls.length;
    }
    pagesFetched += pages.length;
    const official = pages.filter((pg) => isOfficialPage(pg.url, domain));
    if (official.length > 0) officialSeen = true;
    const contacts = resolveContacts({ officialDomain: domain, pages: official });
    if (contacts.primary) {
      // La même règle que le lot : une boîte personnelle, juridique ou support
      // n'est pas une route commerciale.
      const retenu = contacts.primary;
      const commercial = retenu.suitability !== 'LOW' && retenu.intent !== 'PERSONAL';
      const email = retenu.type === 'EMAIL' && commercial ? retenu : null;
      const phone = retenu.type === 'PHONE' ? retenu : contacts.publicPhones[0] ?? null;
      p = repos.sales.setContact(p.id, {
        name: contacts.contactPersonName, role: contacts.contactPersonRole,
        email: email?.value ?? null, phone: phone?.value ?? null,
        contactPage: contacts.contactFormUrl?.value ?? null, sourceUrl: retenu.sourceUrl,
        confidence: retenu.confidence === 'HIGH' ? 0.9 : retenu.confidence === 'MEDIUM' ? 0.7 : 0.5,
        method: contacts.method, confidenceLabel: retenu.confidence, observed: true,
      });
      contactFound = true;
    }
    if (pages.length === 0) blockers.push('FETCH_FAILED');
  } else if (!hasWebsite) {
    blockers.push('NO_WEBSITE');
  }

  // ── EVIDENCE : deux faits distincts suffisent ─────────────────────────
  const factsBefore = commercialFacts(repos, p.id);
  if (enrich && factsBefore.length < 2 && hasWebsite && !blockers.includes('FETCH_FAILED')) {
    const room = Math.max(0, limits.maxPagesPerCompany - pagesFetched);
    try {
      const outcome = await collectSourcedFacts({
        website, domain, maxPages: pages.length + room, targetFacts: 2 - factsBefore.length,
        seedPages: pages, deadline: Date.now() + 60_000,
        fetchPages: async (urls, maxPages) => {
          const r = await deps.fetchPages(urls, maxPages);
          pages.push(...r.pages);
          pagesFetched += r.pages.length;
          fetchFailures += r.failures?.length ?? 0;
          return { pages: r.pages, failures: r.failures ?? [] };
        },
      });
      const known = new Set(repos.sales.evidenceFor(p.id).map((e) => e.claim.trim()));
      for (const fact of outcome.facts) {
        if (known.has(fact.claim.trim())) continue;
        // Relu à sa source, mot pour mot, avec la vérification du pipeline
        // verbatim : seule une citation retrouvée telle quelle dans le texte de
        // la page lue porte le préfixe `verbatim:` — et peut donc être citée
        // au destinataire. Sinon le fait compte, mais ne sera jamais cité.
        const page = pages.find((pg) => sameUrl(pg.url, fact.sourceUrl));
        const verbatim = Boolean(page) && quoteExistsInSource(fact.claim, cleanedText(page!.html));
        repos.sales.addEvidence({
          prospectId: p.id, field: `${verbatim ? 'verbatim:' : ''}signal:${fact.kind.toLowerCase()}`, claim: fact.claim, nature: 'observed',
          sourceUrl: fact.sourceUrl, basis: `Relevé sur ${fact.sourceUrl} — motif « ${fact.marker} ».`, confidence: 0.8,
        });
        known.add(fact.claim.trim());
        factsAdded += 1;
        if (isOfficialPage(fact.sourceUrl, domain)) officialSeen = true;
      }
    } catch {
      fetchFailures += 1;
    }
  }

  // ── REVENUE_SCORE : la qualification existante, sinon le score observé ──
  const facts = commercialFacts(repos, p.id);
  const factKinds = facts.map((e) => /(?:^|:)signal:(\w+)$/.exec(e.field)?.[1]?.toUpperCase() ?? '').filter(Boolean);
  // Un score déterministe se recalcule à chaque passage : de nouveaux faits
  // le changent. Une qualification faite ailleurs (lot, revue) n'est jamais
  // réécrite ici.
  if (p.tier === null || p.score === null || scoreMethodOf(p) === 'factory-deterministic') {
    const incoming = repos.expansion.relationshipsTo(domain).filter((r) => r.status === 'VERIFIED' && COMMERCIAL_RELATIONSHIPS.has(r.relationshipType)).length;
    const assessments = deterministicAssessments({
      contactKind: p.contactEmail ? 'EMAIL' : p.contactPage ? 'FORM' : p.contactPhone ? 'PHONE' : null,
      commercialEmail: Boolean(p.contactEmail) && !repos.sales.firstTouchReadiness(p.id).blockers.includes('EMAIL_NOT_COMMERCIAL'),
      personName: p.contactName, personRole: p.contactRole, factKinds, incomingCommercialRelationships: incoming,
    });
    if (assessments.length < 2) {
      // Trop peu de signaux pour juger : ce n'est pas un mauvais prospect,
      // c'est un prospect qu'on ne connaît pas encore. Il est repassé, puis
      // abandonné après `maxAttempts` passages sans rien de nouveau.
      blockers.push('INSUFFICIENT_SIGNAL');
      if (attempts >= limits.maxAttempts) {
        return verdict('DROP', { blockers: [...blockers, `NO_SIGNAL_AFTER_${attempts}_ATTEMPTS`], nextAction: 'aucune — aucun signal commercial observable' });
      }
      return verdict('NEEDS_ENRICHMENT', { nextAction: 'repasser : contact et faits à lire' });
    }
    const evidence = repos.sales.evidenceFor(p.id);
    const score = scoreSalesProspect({
      assessments,
      evidence: {
        observed: evidence.filter((e) => e.nature === 'observed').length,
        reported: evidence.filter((e) => e.nature === 'reported').length,
        inferred: evidence.filter((e) => e.nature === 'inferred').length,
        sourced: evidence.filter((e) => Boolean(e.sourceUrl)).length,
      },
    });
    const why = assessments.map((a) => a.rationale).join(' · ');
    p = repos.sales.setScore(p.id, { score: score.total, tier: score.tier, detail: { ...score, method: 'factory-deterministic' }, whyFit: why });
    if (score.tier === 'REJECTED') {
      p = repos.sales.setState(p.id, 'REJECTED', { rejectReason: `score observé ${score.total} sous le seuil` });
      blockers.push('LOW_REVENUE_SCORE');
      return verdict('DROP', { revenueScore: score.total, scoreMethod: 'factory-deterministic', qualificationReason: why, nextAction: 'aucune — score trop faible' });
    }
  }
  if (p.state === 'DISCOVERED') p = repos.sales.setState(p.id, 'QUALIFIED');

  // ── RECOMMENDATIONS : le graphe du prospect, 2 à 3 ou aucune ──────────
  const recommendations = recommendationsFor(repos, p);
  if (recommendations.length < 2 && enrich && deps.expansionBudget.left > 0 && config.sales.discoveryEnabled) {
    if (enqueueTargetedExpansion(repos, p, now)) {
      deps.expansionBudget.left -= 1;
      expansion = true;
    }
  }

  // ── La campagne : héritée de la graine qui a fait découvrir l'entreprise ──
  // La politique d'envoi exige une campagne rattachée ET approuvée. Un
  // prospect versé par l'expansion n'en avait aucune : il aurait été bloqué
  // à l'envoi. Il hérite du segment de sa graine — la même lignée — et
  // l'approbation de ce segment reste une décision humaine.
  const campaign = inheritCampaign(repos, p, domain);

  // ── Les gardes du premier contact, et l'identité ──────────────────────
  for (const b of repos.sales.firstTouchReadiness(p.id).blockers) {
    if (!blockers.includes(b)) blockers.push(b);
  }
  if (recommendations.length < 2) blockers.push('RECOMMENDATIONS_BELOW_2');
  if (!officialSeen || whyNotACompanyName(p.companyName)) blockers.push('IDENTITY_UNVERIFIED');

  const commercialClass = classOf(p.tier);
  const eligible = blockers.length === 0 && commercialClass !== 'DROP';
  const classification: FactoryClass = eligible
    ? commercialClass
    : blockers.every(isEnrichable) ? 'NEEDS_ENRICHMENT' : 'BLOCKED';
  const nextAction = eligible
    ? campaign ? 'boucle B — premier contact' : 'boucle B — premier contact (campagne à rattacher et approuver)'
    : classification === 'NEEDS_ENRICHMENT'
      ? nextEnrichmentStep(blockers, expansion)
      : `aucune — ${blockers.filter((b) => !isEnrichable(b)).join(', ')}`;

  return verdict(classification, {
    sendEligible: eligible, revenueScore: p.score, scoreMethod: scoreMethodOf(p), qualificationReason: p.whyFit,
    recommendations, contactRoutes: routesOf(p), evidence: evidenceRefs(repos, p.id), nextAction,
  });
}

/**
 * Le segment de la graine, pour un prospect qui n'en a pas. Rien n'est
 * deviné : sans graine attribuée, le prospect reste sans campagne, et la
 * politique d'envoi le bloquera jusqu'à ce qu'une personne en rattache une.
 */
function inheritCampaign(repos: Repositories, p: SalesProspect, domain: string): boolean {
  if (repos.salesEngine.attributionFor(domain)) return true;
  const sources = repos.expansion.relationshipsTo(domain)
    .filter((r) => r.status === 'VERIFIED')
    .sort((a, b) => b.confidence - a.confidence);
  for (const r of sources) {
    const parent = repos.salesEngine.attributionFor(canonicalDomainOf(r.sourceKey));
    if (!parent?.segmentId) continue;
    const strategy = readStrategy(repos);
    repos.salesEngine.attribute({
      domain, prospectId: p.id, segmentId: parent.segmentId, angle: parent.angle, discoveredAt: p.discoveredAt,
      messageVariant: chooseVariant(domain, Object.entries(strategy.messageAllocation).map(([key, weight]) => ({ key, weight }))),
    });
    return true;
  }
  return false;
}

function nextEnrichmentStep(blockers: readonly string[], expansionQueued: boolean): string {
  if (blockers.includes('FETCH_FAILED')) return 'repasser : site illisible à ce passage';
  if (blockers.includes('NO_OBSERVED_EMAIL') || blockers.includes('EMAIL_NOT_COMMERCIAL')) return 'trouver une adresse commerciale publiée';
  if (blockers.some((b) => b.startsWith('SOURCED_FACTS_'))) return 'lire deux faits sourcés';
  if (blockers.includes('RECOMMENDATIONS_BELOW_2')) return expansionQueued ? 'expansion ciblée posée : attendre ses relations' : 'rechercher les partenaires (expansion ciblée)';
  if (blockers.includes('IDENTITY_UNVERIFIED')) return 'confirmer l’identité sur le site officiel';
  return 'repasser';
}

function scoreMethodOf(p: SalesProspect): string {
  const method = (p.scoreDetail as { method?: unknown } | null)?.method;
  return typeof method === 'string' ? method : 'qualification';
}

function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => { try { const x = new URL(u); return `${x.host}${x.pathname.replace(/\/+$/, '')}`; } catch { return u; } };
  return norm(a) === norm(b);
}

function safePath(url: string): string {
  try { return new URL(url).pathname; } catch { return ''; }
}

/**
 * Les routes professionnelles : une adresse commerciale sur le domaine de
 * l'entreprise (ni webmail, ni guichet juridique), un formulaire, un
 * téléphone. Une adresse non commerciale n'est pas comptée comme route.
 */
function routesOf(p: SalesProspect): FactoryContactRoute[] {
  const routes: FactoryContactRoute[] = [];
  const domain = p.domain ? canonicalDomainOf(p.domain) : null;
  if (p.contactEmail && isCommercialEmail(p.contactEmail, domain) && p.contactSuitability !== 'BLOCKED') {
    routes.push({ kind: 'EMAIL', value: p.contactEmail, sourceUrl: p.contactSourceUrl, observed: p.contactObserved });
  }
  if (p.contactPage) routes.push({ kind: 'FORM', value: p.contactPage, sourceUrl: p.contactSourceUrl, observed: p.contactObserved });
  if (p.contactPhone) routes.push({ kind: 'PHONE', value: p.contactPhone, sourceUrl: p.contactSourceUrl, observed: p.contactObserved });
  return routes;
}

function evidenceRefs(repos: Repositories, prospectId: string): FactoryEvidenceRef[] {
  return commercialFacts(repos, prospectId).slice(0, 6).map((e) => ({ claim: e.claim, sourceUrl: e.sourceUrl!, nature: e.nature }));
}

/** Les recommandations du message, avec la confiance de la relation qui les porte. */
function recommendationsFor(repos: Repositories, p: SalesProspect): FactoryRecommendation[] {
  const recs = registryRecommendationsFor(repos, p);
  if (recs.length === 0 || !p.domain) return [];
  const rels = repos.expansion.relationshipsOf(canonicalDomainOf(p.domain));
  return recs.map((r) => ({
    company: r.company, domain: r.domain, reason: r.fitReason, sourceUrl: r.sourceUrl, evidenceQuote: r.evidenceQuote,
    confidence: rels.find((x) => canonicalDomainOf(x.targetKey) === r.domain && x.evidenceUrl === r.sourceUrl)?.confidence ?? null,
  }));
}

/**
 * Une expansion ciblée : les partenaires du prospect, cherchés par le moteur
 * d'expansion existant. Une par prospect et par période de trois jours — la
 * clé d'idempotence l'assure, redémarrage compris.
 */
function enqueueTargetedExpansion(repos: Repositories, p: SalesProspect, now: Date): boolean {
  const period = Math.floor(now.getTime() / (3 * 86_400_000));
  const key = `factory-expand:${canonicalDomainOf(p.domain!)}:${period}`;
  const { created } = repos.tasks.create({
    taskType: EXPANSION_TASK_TYPE, department: 'sales', workerType: 'DETERMINISTIC', priority: 8,
    payload: { seedProspectIds: [p.id], trigger: FACTORY_ACTOR, purpose: 'SALES' },
    availableAt: now.toISOString(), maxAttempts: 1, idempotencyKey: key, correlationId: key,
  });
  return created;
}

/**
 * Quand il n'y a plus rien de frais à examiner, la capacité ne reste pas
 * inoccupée : une expansion générale (les graines les plus fortes) est posée,
 * au plus une par période de six heures.
 */
function enqueueSupplyExpansion(repos: Repositories, now: Date): boolean {
  const period = Math.floor(now.getTime() / (6 * 3_600_000));
  const key = `factory-supply:${period}`;
  const { created } = repos.tasks.create({
    taskType: EXPANSION_TASK_TYPE, department: 'sales', workerType: 'DETERMINISTIC', priority: 6,
    payload: { trigger: `${FACTORY_ACTOR}:supply`, purpose: 'SALES' },
    availableAt: now.toISOString(), maxAttempts: 1, idempotencyKey: key, correlationId: key,
  });
  return created;
}

const defaultFetchPages = (logger: Logger): FetchPages => async (urls, maxPages) => {
  const outcome = await fetchRawPages(urls, { logger, timeoutMs: 12_000, maxPages });
  return { pages: outcome.pages.map((pg) => ({ url: pg.url, html: pg.html })), failures: outcome.failures };
};

/**
 * Un tour de fabrique : une file, des entreprises examinées en parallèle, un
 * verdict chacune, et un compte rendu. Une entreprise qui échoue ne fait pas
 * échouer le tour ; un tour laissé ouvert par un arrêt est clos au suivant.
 */
export async function runRevenueFactory(
  deps: FactoryDeps,
  options: { trigger?: string; limits?: Partial<FactoryLimits>; heartbeat?: () => void } = {},
): Promise<FactoryReport> {
  const { repos, config } = deps;
  const limits: FactoryLimits = { ...DEFAULT_FACTORY_LIMITS, ...options.limits };
  const clock = deps.now ?? (() => new Date());
  const startedAt = clock();
  const started = Date.now();
  repos.revenueFactory.closeAbandonedRuns(new Date(startedAt.getTime() - limits.wallClockMs * 2).toISOString());
  const run = repos.revenueFactory.startRun(options.trigger ?? FACTORY_ACTOR, startedAt.toISOString());
  const fetchPages = deps.fetchPages ?? defaultFetchPages(deps.logger);

  const report: FactoryReport = {
    runId: run.runId, processed: 0,
    byClass: { HOT: 0, WARM: 0, NEEDS_ENRICHMENT: 0, DROP: 0, DUPLICATE: 0, BLOCKED: 0 },
    sendEligible: 0, contactsFound: 0, factsAdded: 0, recommendationsReady: 0, pagesFetched: 0, fetchFailures: 0,
    expansionsEnqueued: 0, promotedFromExpansion: 0, errors: [], elapsedMs: 0, costUsd: 0, stopReason: 'QUEUE_EMPTY', queueRemaining: 0,
  };

  try {
    let queue = factoryQueue(repos, startedAt, limits);
    // File courte : ce que l'expansion a déjà trouvé et qualifié entre d'abord
    // dans le registre commercial (mêmes gardes que le versement manuel).
    if (queue.length < limits.batchSize && config.sales.discoveryEnabled) {
      report.promotedFromExpansion = promoteExpansionBacklog(repos, { limit: limits.batchSize * 4, now: startedAt }).promoted.length;
      if (report.promotedFromExpansion > 0) queue = factoryQueue(repos, startedAt, limits);
    }
    const batch = queue.slice(0, limits.batchSize);
    report.queueRemaining = Math.max(0, queue.length - batch.length);
    const knownDomains = new Set(repos.sales.discoveredSince(null).map((p) => (p.domain ? canonicalDomainOf(p.domain) : '')).filter(Boolean));
    const expansionBudget = { left: limits.maxExpansionsPerRun };
    let cursor = 0;

    const worker = async () => {
      while (cursor < batch.length) {
        if (Date.now() - started > limits.wallClockMs) { report.stopReason = 'WALL_CLOCK'; return; }
        const item = batch[cursor++]!;
        options.heartbeat?.();
        try {
          const result = await processOne({ repos, config, fetchPages, now: clock(), runId: run.runId, limits, knownDomains, expansionBudget }, item);
          const saved = repos.revenueFactory.record(result.input);
          report.processed += 1;
          report.byClass[saved.classification] += 1;
          if (saved.sendEligible) report.sendEligible += 1;
          if (result.contactFound) report.contactsFound += 1;
          if (saved.recommendations.length >= 2) report.recommendationsReady += 1;
          report.factsAdded += result.factsAdded;
          report.pagesFetched += result.pagesFetched;
          report.fetchFailures += result.fetchFailures;
          if (result.expansion) report.expansionsEnqueued += 1;
        } catch (error) {
          report.errors.push({ domain: item.domain, error: error instanceof Error ? error.message : String(error) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limits.concurrency, batch.length)) }, worker));

    if (report.stopReason !== 'WALL_CLOCK') report.stopReason = queue.length > batch.length ? 'BATCH_SIZE' : 'QUEUE_EMPTY';
    // La capacité ne reste pas inoccupée : file vide, on nourrit la découverte.
    if (queue.length < limits.batchSize && config.sales.discoveryEnabled && enqueueSupplyExpansion(repos, startedAt)) {
      report.expansionsEnqueued += 1;
    }
    report.elapsedMs = Date.now() - started;
    repos.revenueFactory.finishRun(run.runId, {
      status: 'DONE', processed: report.processed, stats: statsOf(report), costUsd: report.costUsd,
      stopReason: report.stopReason, finishedAt: new Date(startedAt.getTime() + report.elapsedMs).toISOString(),
    });
    return report;
  } catch (error) {
    report.elapsedMs = Date.now() - started;
    repos.revenueFactory.finishRun(run.runId, {
      status: 'FAILED', processed: report.processed, stats: statsOf(report), costUsd: report.costUsd,
      stopReason: 'ERROR', error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function statsOf(r: FactoryReport): Record<string, unknown> {
  return {
    byClass: r.byClass, sendEligible: r.sendEligible, contactsFound: r.contactsFound, factsAdded: r.factsAdded,
    recommendationsReady: r.recommendationsReady, pagesFetched: r.pagesFetched, fetchFailures: r.fetchFailures,
    expansionsEnqueued: r.expansionsEnqueued, promotedFromExpansion: r.promotedFromExpansion, errors: r.errors.length, queueRemaining: r.queueRemaining,
  };
}

/** Le worker déterministe du daemon : un tour par tâche, et jamais un envoi. */
export function createRevenueFactoryHandlers(deps: FactoryDeps): Record<string, (task: TaskRow, context: WorkerContext) => Promise<WorkerOutcome>> {
  return {
    [REVENUE_FACTORY_TASK]: async (task, context) => {
      const report = await runRevenueFactory(deps, { trigger: `daemon:${task.taskId}`, heartbeat: () => void context.heartbeat() });
      return {
        kind: 'DONE',
        result: { ...statsOf(report), runId: report.runId, processed: report.processed, stopReason: report.stopReason, elapsedMs: report.elapsedMs, messagesSent: 0 },
        costUsd: report.costUsd,
      };
    },
  };
}

