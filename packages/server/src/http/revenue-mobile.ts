import { canonicalDomainOf, type AtlasConfig } from '@atlas/core';
import type { Repositories, SalesProspect } from '@atlas/data';
import {
  buildSalesDashboard, readGlobalPause, registryRecommendationsFor, replyReceivedFor, todaySnapshot,
  type SalesDashboard, type SystemLight,
} from '@atlas/runtime';
import { withoutEnvNames } from './command-center.ts';

/**
 * L'écran de téléphone : piloter le revenu d'un coup d'œil.
 *
 * Ce n'est pas un second tableau de bord. L'entonnoir, les cartes, les
 * opportunités, les leads chauds et les voyants viennent de
 * `buildSalesDashboard` — la page unique du moteur commercial — et ne sont pas
 * recalculés ici. Cette vue n'ajoute que ce qu'elle seule demande : la journée
 * en cours, l'étape « contact-ready », le coût par fournisseur, les brouillons
 * en attente, les dernières expansions et la dernière vraie action revenue.
 *
 * Lue toutes les dix secondes depuis un réseau mobile, elle ne sonde rien à
 * l'extérieur (ni moteur de recherche, ni Gmail, ni git) et ne renvoie aucune
 * valeur ni aucun nom de variable d'identifiant.
 *
 * `DOWN` n'est jamais rendu par le serveur : un serveur qui répond n'est pas en
 * panne. Le navigateur le constate quand la lecture ne revient plus.
 */

export type OutboundMode = 'OFF' | 'INTERNAL_TEST' | 'ACTIVE';

export interface MobileFunnelStage {
  key: 'DISCOVERED' | 'QUALIFIED' | 'CONTACT_READY' | 'SENT' | 'REPLY' | 'MEETING' | 'PROPOSAL' | 'WON';
  count: number | null;
  /** Part de la dernière étape connue avant celle-ci. */
  rate: number | null;
}

export interface RevenueMobile {
  generatedAt: string;
  header: {
    status: 'ONLINE' | 'DEGRADED';
    reasons: string[];
    outbound: OutboundMode;
    sendWindow: { window: string; open: boolean };
    killSwitch: { paused: boolean; reason: string | null; by: string | null; at: string | null };
    aiCostTodayUsd: number | null;
    aiCostUnknownCalls: number;
    lastRevenueActionAt: string | null;
    lastRevenueAction: string | null;
    lastSyncAt: string | null;
    lastCycleAt: string | null;
    services: Array<{ id: string; label: string; state: SystemLight['state']; detail: string }>;
  };
  kpis: {
    discoveredToday: number;
    qualifiedToday: number;
    highPriority: number;
    contactReady: number;
    sentToday: number;
    repliesToday: number;
    positiveRepliesToday: number;
    meetings: number;
    /** Aucune proposition n'est consignée en base : `null`, jamais zéro. */
    proposals: number | null;
    won: number;
    revenueSigned: number;
    currency: string;
    pipelinePotential: number | null;
  };
  funnel: MobileFunnelStage[];
  priorityProspects: Array<{
    domain: string; companyName: string; tier: string | null; score: number | null;
    whyFit: string | null; contactReady: boolean;
  }>;
  drafts: {
    awaitingApproval: number;
    approvedToSend: number;
    items: Array<{ id: string; domain: string; companyName: string; recipient: string; subject: string; createdAt: string }>;
  };
  todo: SalesDashboard['todo'];
  caps: { dailyNewOutreach: number; sentToday: number; hourly: number };
  expansions: Array<{
    id: string; status: string; startedAt: string; finishedAt: string | null;
    seeds: number; universe: number | null; qualified: number | null; highPriority: number | null;
    costUsd: number; stopReason: string | null;
  }>;
  costs: {
    todayUsd: { openai: number | null; anthropic: number | null; search: number | null; total: number | null };
    caps: { aiDailyUsd: number | null; salesAiDailyUsd: number | null };
    perQualifiedUsd: number | null;
    perContactReadyUsd: number | null;
    perClientUsd: number | null;
  };
  definitions: Record<string, string>;
}

export function outboundModeOf(config: AtlasConfig): OutboundMode {
  if (!config.sales.outboundEnabled) return 'OFF';
  return config.sales.engineMode === 'PRODUCTION' ? 'ACTIVE' : 'INTERNAL_TEST';
}

/** La règle de l'entonnoir du moteur : un palier, et rien de rejeté. */
const isQualified = (p: SalesProspect): boolean =>
  p.tier !== null && p.tier !== 'REJECTED' && p.state !== 'REJECTED';
/** Qualifié, avec une adresse lue sur une page officielle — pas devinée. */
const isContactReady = (p: SalesProspect): boolean =>
  isQualified(p) && p.contactObserved && Boolean(p.contactEmail);

export function buildRevenueMobile(
  repos: Repositories,
  config: AtlasConfig,
  options: { now?: Date; gmailConfigured?: boolean | null } = {},
): RevenueMobile {
  const now = options.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const startOfDay = `${today}T00:00:00.000Z`;

  const dashboard = buildSalesDashboard(repos, config, {
    range: 'all', now, gmailConfigured: options.gmailConfigured ?? null,
  });
  const snapshot = todaySnapshot(repos, today);
  const pause = readGlobalPause(repos);
  const all = repos.sales.discoveredSince(null);
  const todays = all.filter((p) => p.discoveredAt >= startOfDay);

  // ── Voyants : ceux de la page unique, sans nom de variable ────────────
  const sys = dashboard.system;
  const services = ([
    ['gmail', 'Gmail', sys.gmail], ['search', 'Search', sys.search], ['workers', 'Workers', sys.workers],
    ['llm', 'Inference', sys.llm], ['database', 'DB', sys.database],
  ] as const).map(([id, label, light]) => ({ id, label, state: light.state, detail: withoutEnvNames(light.detail) }));

  const reasons: string[] = [];
  if (pause.paused) reasons.push(`kill switch actif${pause.reason ? ` — ${pause.reason}` : ''}`);
  for (const s of services) if (s.state === 'down') reasons.push(`${s.label} : ${s.detail}`);

  // ── Coûts du jour, par fournisseur ────────────────────────────────────
  const providerToday = (provider: 'OPENAI' | 'ANTHROPIC'): number | null => {
    const workers = repos.tasks.aiUsageSince(startOfDay, provider);
    const missions = repos.llmCalls.breakdownSince(startOfDay, 'provider')
      .filter((row) => row.label.toUpperCase() === provider);
    const calls = workers.calls + missions.reduce((a, r) => a + r.calls, 0);
    return calls === 0 ? null : round4(workers.knownCostUsd + missions.reduce((a, r) => a + r.knownCostUsd, 0));
  };
  const openai = providerToday('OPENAI');
  const anthropic = providerToday('ANTHROPIC');
  const runs = repos.expansion.runs(10);
  const runsToday = runs.filter((r) => r.startedAt >= startOfDay);
  const search = runsToday.length === 0 ? null : round4(runsToday.reduce((a, r) => a + r.searchCostUsd, 0));
  const parts = [openai, anthropic, search].filter((v): v is number => v !== null);
  const total = parts.length === 0 ? null : round4(parts.reduce((a, b) => a + b, 0));

  const qualifiedAll = all.filter(isQualified).length;
  const contactReadyAll = all.filter(isContactReady).length;
  const lifetime = lifetimeAiCost(repos);
  const per = (n: number): number | null => (lifetime === null || n <= 0 ? null : round4(lifetime / n));

  // ── La dernière vraie action revenue, où qu'elle ait eu lieu ──────────
  const lastRun = runs[0] ?? null;
  const latest = ([
    [all.length > 0 ? all[all.length - 1]!.discoveredAt : null, 'prospect découvert'],
    [lastRun?.updatedAt ?? null, 'expansion'],
    [latestSend(repos), 'message envoyé'],
  ] as Array<[string | null, string]>)
    .filter((c): c is [string, string] => c[0] !== null)
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))[0] ?? null;

  // ── Entonnoir : les volumes du moteur, plus l'étape contact-ready ─────
  const count = (stage: string): number | null => dashboard.funnel.find((f) => f.stage === stage)?.count ?? null;
  const stages: Array<[MobileFunnelStage['key'], number | null]> = [
    ['DISCOVERED', count('discovered')],
    ['QUALIFIED', count('icpQualified')],
    ['CONTACT_READY', contactReadyAll],
    ['SENT', count('contacted')],
    ['REPLY', count('replied')],
    ['MEETING', count('meetings')],
    ['PROPOSAL', null],
    ['WON', count('clients')],
  ];
  const funnel = stages.map(([key, n], i) => ({ key, count: n, rate: i === 0 ? null : rateOf(n, lastKnown(stages, i)) }));

  const awaiting = repos.salesLoop.draftsInState('READY_FOR_APPROVAL');
  const readyByDomain = new Map(all.filter((p) => p.domain).map((p) => [canonicalDomainOf(p.domain!), isContactReady(p)]));
  const stat = (run: (typeof runs)[number], key: string): number | null => {
    const v = run.stats?.[key];
    return typeof v === 'number' ? v : null;
  };
  const sentToday = repos.salesLoop.sentSince(startOfDay);

  return {
    generatedAt: now.toISOString(),
    header: {
      status: reasons.length === 0 ? 'ONLINE' : 'DEGRADED',
      reasons,
      outbound: outboundModeOf(config),
      sendWindow: { window: sys.outbound.window, open: sys.outbound.windowOpen },
      killSwitch: pause,
      aiCostTodayUsd: snapshot.aiCostUsd,
      aiCostUnknownCalls: snapshot.aiCostUnknownCalls,
      lastRevenueActionAt: latest?.[0] ?? null,
      lastRevenueAction: latest?.[1] ?? null,
      lastSyncAt: sys.gmail.lastAttemptAt,
      lastCycleAt: sys.lastCycleAt,
      services,
    },
    kpis: {
      discoveredToday: todays.length,
      qualifiedToday: todays.filter(isQualified).length,
      highPriority: dashboard.opportunities.filter((o) => o.tier === 'PRIORITY').length,
      contactReady: contactReadyAll,
      sentToday,
      repliesToday: snapshot.replies,
      positiveRepliesToday: snapshot.positiveReplies,
      meetings: dashboard.cards.meetings,
      proposals: null,
      won: dashboard.cards.clientsSigned,
      revenueSigned: dashboard.cards.revenueSigned,
      currency: dashboard.cards.currency,
      pipelinePotential: dashboard.cards.pipelinePotential,
    },
    funnel,
    priorityProspects: dashboard.opportunities.slice(0, 8).map((o) => ({
      domain: o.domain, companyName: o.companyName, tier: o.tier, score: o.score, whyFit: o.whyFit,
      contactReady: readyByDomain.get(canonicalDomainOf(o.domain)) ?? false,
    })),
    drafts: {
      awaitingApproval: awaiting.length,
      approvedToSend: repos.salesLoop.draftsInState('APPROVED_TO_SEND').length,
      items: awaiting.slice(-5).reverse().map((d) => ({
        id: d.id, domain: d.domain, companyName: d.companyName, recipient: d.recipient, subject: d.subject, createdAt: d.createdAt,
      })),
    },
    todo: dashboard.todo,
    caps: { dailyNewOutreach: config.sales.maxNewOutreachPerDay, sentToday, hourly: config.sales.hourlySendCap },
    expansions: runs.slice(0, 5).map((r) => ({
      id: r.id, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, seeds: r.seeds.length,
      universe: stat(r, 'universe'), qualified: stat(r, 'qualified'), highPriority: stat(r, 'highPriority'),
      costUsd: round4(r.aiCostUsd + r.searchCostUsd),
      stopReason: r.error ?? (r.status === 'RUNNING' ? null : r.summary),
    })),
    costs: {
      todayUsd: { openai, anthropic, search, total },
      caps: {
        aiDailyUsd: config.ai.dailyBudgetUsd > 0 ? config.ai.dailyBudgetUsd : null,
        salesAiDailyUsd: config.sales.dailyAiBudgetUsd > 0 ? config.sales.dailyAiBudgetUsd : null,
      },
      perQualifiedUsd: per(qualifiedAll),
      perContactReadyUsd: per(contactReadyAll),
      perClientUsd: per(dashboard.cards.clientsSigned),
    },
    definitions: {
      funnel: 'volumes du moteur commercial depuis l’origine ; taux = part de l’étape connue précédente',
      contactReady: 'qualifié ET adresse lue sur une page officielle',
      highPriority: 'opportunités ouvertes au palier PRIORITY',
      today: 'journée UTC',
      proposal: 'non consigné en base — N/A',
      costPer: 'coût IA total consigné / volume de l’étape',
    },
  };
}

// ─── La fiche prospect ──────────────────────────────────────────────────────

/** Un domaine tel qu'un chemin d'URL peut le porter, rien de plus. */
const DOMAIN_PARAM = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function isDomainParam(value: string): boolean {
  return DOMAIN_PARAM.test(value.trim().toLowerCase());
}

/**
 * Tout ce qu'ATLAS sait d'un prospect, en lecture seule.
 *
 * Les blocages repris ici sont ceux que le premier contact vérifie avant
 * d'écrire un brouillon (`firstTouchReadiness`, suppression, réponse reçue,
 * envoi déjà fait, premier contact actif). La récupération d'un brouillon
 * ABANDONED, elle, écrit : elle reste au moteur et n'est jamais déclenchée
 * depuis un écran.
 *
 * Les recommandations sont celles que le message citerait : le graphe
 * d'expansion du prospect, filtré par `registryRecommendationsFor` —
 * relations VERIFIED, source OFFICIAL, commerciales, jamais le prospect ni un
 * sous-domaine, 2 à 3 ou aucune.
 */
export function buildProspectDetail(repos: Repositories, rawDomain: string) {
  const domain = canonicalDomainOf(rawDomain);
  const rows = repos.sales.discoveredSince(null).filter((p) => p.domain && canonicalDomainOf(p.domain) === domain);
  if (rows.length === 0) return null;
  const TIER: Record<string, number> = { PRIORITY: 0, GOOD_FIT: 1, WATCH: 2 };
  const p = [...rows].sort((a, b) => (TIER[a.tier ?? ''] ?? 3) - (TIER[b.tier ?? ''] ?? 3)
    || (b.score ?? -1) - (a.score ?? -1) || b.updatedAt.localeCompare(a.updatedAt))[0]!;

  const blockers = [...repos.sales.firstTouchReadiness(p.id).blockers];
  const suppression = repos.salesEngine.isSuppressed({ email: p.contactEmail, domain, company: p.companyName });
  if (suppression.suppressed) blockers.push('SUPPRESSED');
  if (replyReceivedFor(repos, domain)) blockers.push('REPLY_RECEIVED');
  if (repos.salesLoop.lastSentTo(domain) !== null) blockers.push('ALREADY_SENT');
  const drafts = repos.salesLoop.draftsForDomain(domain);
  if (drafts.some((d) => d.purpose === 'FIRST_TOUCH' && d.state !== 'ABANDONED')) blockers.push('PRIOR_FIRST_TOUCH');

  const recommendations = registryRecommendationsFor(repos, p);
  if (recommendations.length === 0) blockers.push('RECOMMENDATIONS_BELOW_2');

  const evidence = repos.sales.evidenceFor(p.id);

  return {
    generatedAt: new Date().toISOString(),
    identity: {
      prospectId: p.id, companyName: p.companyName, domain, website: p.website, country: p.country,
      industry: p.industry, identityConfidence: p.identityConfidence, identitySources: p.identitySources ?? [],
      discoveredAt: p.discoveredAt, sourceUrl: p.sourceUrl, query: p.query, duplicates: rows.length - 1,
    },
    qualification: { state: p.state, tier: p.tier, score: p.score, whyFit: p.whyFit, rejectReason: p.rejectReason },
    contact: {
      name: p.contactName, role: p.contactRole, email: p.contactEmail, phone: p.contactPhone, page: p.contactPage,
      method: p.contactMethod, observed: p.contactObserved, sourceUrl: p.contactSourceUrl,
      confidence: p.contactConfidence, suitability: p.contactSuitability,
    },
    evidence: evidence.map((e) => ({
      field: e.field, claim: e.claim, nature: e.nature, sourceUrl: e.sourceUrl, confidence: e.confidence, collectedAt: e.collectedAt,
    })),
    urls: [...new Set([p.sourceUrl, p.contactSourceUrl, ...evidence.map((e) => e.sourceUrl), ...recommendations.map((r) => r.sourceUrl)]
      .filter((u): u is string => Boolean(u) && /^https?:\/\//i.test(u!)))],
    recommendations,
    drafts: drafts.map((d) => ({
      id: d.id, purpose: d.purpose, state: d.state, recipient: d.recipient, subject: d.subject, body: d.body,
      sources: d.sources, createdAt: d.createdAt, createdBy: d.createdBy,
    })),
    history: {
      loop: repos.salesLoop.historyFor(domain).map((t) => ({ at: t.occurredAt, from: t.fromState, to: t.toState, reason: t.reason, actor: t.actor })),
      ledger: repos.sales.ledgerHistory(domain).map((l) => ({ at: l.recordedAt, kind: l.kind, note: l.note, by: l.recordedBy })),
      currentLoopState: repos.salesLoop.currentState(domain),
      lastSentAt: repos.salesLoop.lastSentTo(domain),
    },
    blockers,
    firstTouchReady: blockers.length === 0,
  };
}

export type ProspectDetail = NonNullable<ReturnType<typeof buildProspectDetail>>;

function rateOf(count: number | null, previous: number | null): number | null {
  if (count === null || previous === null || previous <= 0) return null;
  return count / previous;
}

function lastKnown(stages: Array<[string, number | null]>, index: number): number | null {
  for (let i = index - 1; i >= 0; i--) if (stages[i]![1] !== null) return stages[i]![1];
  return null;
}

function lifetimeAiCost(repos: Repositories): number | null {
  const origin = '1970-01-01T00:00:00.000Z';
  const workers = repos.tasks.aiUsageSince(origin);
  const missions = repos.llmCalls.usageSince(origin);
  if (workers.calls + missions.calls === 0) return null;
  return workers.knownCostUsd + missions.knownCostUsd;
}

function latestSend(repos: Repositories): string | null {
  return repos.salesLoop.sentLog(20).find((r) => r.phase === 'SENT')?.occurredAt ?? null;
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;
