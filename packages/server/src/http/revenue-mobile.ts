import type { AtlasConfig } from '@atlas/core';
import type { Repositories, SalesProspect } from '@atlas/data';
import { buildSalesDashboard, readGlobalPause, todaySnapshot, type SalesDashboard, type SystemLight } from '@atlas/runtime';
import { withoutEnvNames } from './command-center.ts';

/**
 * L'écran de téléphone : piloter le revenu d'un coup d'œil.
 *
 * Ce n'est pas un second tableau de bord. L'entonnoir, les cartes, les leads
 * chauds et les voyants viennent de `buildSalesDashboard` — la page unique du
 * moteur commercial — et ne sont pas recalculés ici. Cette vue n'ajoute que ce
 * qu'elle seule demande : la journée en cours, le coût par fournisseur, et la
 * dernière vraie action de la boucle revenue.
 *
 * Elle est lue toutes les dix secondes depuis un réseau mobile, d'où deux
 * contraintes :
 *
 *   · Rien ici ne sonde l'extérieur — ni moteur de recherche, ni portée Gmail,
 *     ni `git status`. À cette cadence, une sonde finit par brider ce qu'elle
 *     observe. Ce qui ne se lit pas en base vaut `null`.
 *   · Aucune valeur d'environnement ne sort, ni nom de variable d'identifiant :
 *     la page est servie par un hébergeur tiers.
 *
 * `DOWN` n'est jamais rendu par le serveur : un serveur qui répond n'est pas en
 * panne. C'est le navigateur qui le constate, quand la lecture ne revient plus.
 */

export type OutboundMode = 'OFF' | 'INTERNAL_TEST' | 'ACTIVE';
export type MobileStatus = 'ONLINE' | 'DEGRADED';

export interface MobileFunnelStage {
  key: string;
  label: string;
  count: number | null;
  rate: number | null;
}

export interface RevenueMobile {
  generatedAt: string;
  header: {
    status: MobileStatus;
    reasons: string[];
    outbound: OutboundMode;
    sendWindow: { window: string; open: boolean };
    killSwitch: { paused: boolean; reason: string | null; by: string | null; at: string | null };
    aiCostTodayUsd: number | null;
    aiCostUnknownCalls: number;
    services: Array<{ id: string; label: string; state: SystemLight['state']; detail: string }>;
  };
  kpis: {
    discoveredToday: number;
    qualifiedToday: number;
    highPriorityToday: number;
    contactReadyToday: number;
    sentToday: number;
    repliesToday: number;
    positiveRepliesToday: number;
    meetings: number;
    /** Aucune proposition n'est consignée en base : `null`, jamais zéro. */
    proposals: number | null;
    clientsWon: number;
    revenueSigned: number;
    currency: string;
    pipelinePotential: number | null;
  };
  funnel: MobileFunnelStage[];
  todo: SalesDashboard['todo'] & {
    approvedToSend: number;
    dailyCap: number;
    sentToday: number;
    hourlyCap: number;
  };
  hotLeads: Array<Pick<SalesDashboard['hotLeads'][number], 'domain' | 'companyName' | 'intent' | 'receivedAt' | 'subject' | 'excerpt'>>;
  loop: {
    lastRevenueActionAt: string | null;
    lastRevenueAction: string | null;
    lastExpansion: {
      id: string; status: string; startedAt: string; finishedAt: string | null;
      universe: number | null; qualified: number | null; highPriority: number | null;
      costUsd: number; stopReason: string | null;
    } | null;
  };
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

/** Même règle que l'entonnoir du moteur commercial : un tier, et rien de rejeté. */
const isQualified = (p: SalesProspect): boolean =>
  p.tier !== null && p.tier !== 'REJECTED' && p.state !== 'REJECTED';
/** Qualifié, et une coordonnée lue sur une page officielle — pas devinée. */
const isContactReady = (p: SalesProspect): boolean => isQualified(p) && p.contactObserved;

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
  const services: RevenueMobile['header']['services'] = [
    { id: 'gmail', label: 'Gmail', light: sys.gmail },
    { id: 'search', label: 'Search', light: sys.search },
    { id: 'workers', label: 'Workers', light: sys.workers },
    { id: 'llm', label: 'Inference', light: sys.llm },
    { id: 'database', label: 'DB', light: sys.database },
  ].map(({ id, label, light }) => ({ id, label, state: light.state, detail: withoutEnvNames(light.detail) }));

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
  const runs = repos.expansion.runs(50);
  const runsToday = runs.filter((r) => r.startedAt >= startOfDay);
  const search = runsToday.length === 0 ? null : round4(runsToday.reduce((a, r) => a + r.searchCostUsd, 0));
  const parts = [openai, anthropic, search].filter((v): v is number => v !== null);
  const total = parts.length === 0 ? null : round4(parts.reduce((a, b) => a + b, 0));

  const qualifiedAll = all.filter(isQualified).length;
  const contactReadyAll = all.filter(isContactReady).length;
  const lifetime = lifetimeAiCost(repos);
  const per = (n: number): number | null => (lifetime === null || n <= 0 ? null : round4(lifetime / n));

  // ── Boucle revenue : la dernière vraie action, où qu'elle ait eu lieu ──
  const lastRun = runs[0] ?? null;
  const latest = ([
    [all.length > 0 ? all[all.length - 1]!.discoveredAt : null, 'prospect découvert'],
    [lastRun?.updatedAt ?? null, 'expansion'],
    [latestSend(repos), 'message envoyé'],
  ] as Array<[string | null, string]>)
    .filter((c): c is [string, string] => c[0] !== null)
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))[0] ?? null;

  const stat = (key: string): number | null => {
    const v = lastRun?.stats?.[key];
    return typeof v === 'number' ? v : null;
  };

  // ── Entonnoir : celui du moteur, avec l'étape « proposition » dite absente ──
  const funnel: MobileFunnelStage[] = [];
  for (const row of dashboard.funnel) {
    if (row.stage === 'clients') funnel.push({ key: 'proposal', label: 'Propositions', count: null, rate: null });
    funnel.push({ key: row.stage, label: row.label, count: row.count, rate: row.rate });
  }

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
      services,
    },
    kpis: {
      discoveredToday: todays.length,
      qualifiedToday: todays.filter(isQualified).length,
      highPriorityToday: todays.filter((p) => p.tier === 'PRIORITY').length,
      contactReadyToday: todays.filter(isContactReady).length,
      sentToday,
      repliesToday: snapshot.replies,
      positiveRepliesToday: snapshot.positiveReplies,
      meetings: dashboard.cards.meetings,
      proposals: null,
      clientsWon: dashboard.cards.clientsSigned,
      revenueSigned: dashboard.cards.revenueSigned,
      currency: dashboard.cards.currency,
      pipelinePotential: dashboard.cards.pipelinePotential,
    },
    funnel,
    todo: {
      ...dashboard.todo,
      approvedToSend: repos.salesLoop.draftsInState('APPROVED_TO_SEND').length,
      dailyCap: config.sales.maxNewOutreachPerDay,
      sentToday,
      hourlyCap: config.sales.hourlySendCap,
    },
    hotLeads: dashboard.hotLeads
      .filter((h) => h.status === 'OPEN')
      .slice(0, 5)
      .map(({ domain, companyName, intent, receivedAt, subject, excerpt }) => ({
        domain, companyName, intent, receivedAt, subject, excerpt,
      })),
    loop: {
      lastRevenueActionAt: latest?.[0] ?? null,
      lastRevenueAction: latest?.[1] ?? null,
      lastExpansion: lastRun
        ? {
            id: lastRun.id,
            status: lastRun.status,
            startedAt: lastRun.startedAt,
            finishedAt: lastRun.finishedAt,
            universe: stat('universe'),
            qualified: stat('qualified'),
            highPriority: stat('highPriority'),
            costUsd: round4(lastRun.aiCostUsd + lastRun.searchCostUsd),
            stopReason: lastRun.error ?? (lastRun.status === 'RUNNING' ? null : lastRun.summary),
          }
        : null,
    },
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
      qualified: 'tier attribué, hors REJECTED',
      highPriority: 'tier PRIORITY',
      contactReady: 'qualifié ET coordonnée observée sur une page officielle',
      funnel: 'entonnoir du moteur commercial, depuis l’origine',
      today: 'journée UTC',
      proposal: 'non consigné en base — N/A',
      costPer: 'coût IA total consigné / volume de l’étape',
    },
  };
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
