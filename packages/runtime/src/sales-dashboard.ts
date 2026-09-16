import type { AtlasConfig } from '@atlas/core';
import type { Repositories } from '@atlas/data';
import {
  classifyReplyIntent,
  funnelRates,
  pipelinePotential,
  segmentDecision,
  POSITIVE_REPLY_INTENTS,
  HOT_LEAD_INTENTS,
  isWithinSendWindow,
  sameMailbox,
  type ReplyIntent,
  type SalesFunnelCounts,
} from '@atlas/departments';
import { GmailInboxProvider } from '@atlas/intelligence';
import { readGlobalPause, gatherSalesStats, sendPolicyOf, SALES_SETTINGS } from './sales-engine.ts';

/**
 * La page unique. Une lecture, sept sections, dans l'ordre où l'on se pose
 * les questions le matin : qu'est-ce que ça rapporte, où ça coince, quel
 * marché marche, que propose ATLAS, qui a répondu, est-ce que ça tourne.
 *
 * Tout ce qui n'est pas mesuré est `null`, jamais zéro. Un CAC sans client
 * est un tiret, pas un chiffre. Le même objet sert la page et la ligne de
 * commande : un chiffre affiché à deux endroits vient d'un seul calcul.
 */

export type DashboardRange = '7d' | '30d' | 'all';

export interface SalesDashboard {
  generatedAt: string;
  range: DashboardRange;
  since: string | null;
  segmentId: string | null;
  cards: {
    /** Rendez-vous sur la période choisie (entreprises distinctes). */
    meetings: number;
    meetingsThisWeek: number;
    clientsSigned: number;
    revenueSigned: number;
    currency: string;
    pipelinePotential: number | null;
    pipelineExplanation: string[];
  };
  /**
   * Ce qu'une personne doit faire maintenant. Chaque compteur vient d'une
   * file réelle : réponses chaudes ouvertes, dossiers à relire, relances dues,
   * recommandations proposées, campagnes à approuver (en PRODUCTION seulement).
   */
  todo: {
    hotLeads: number;
    approvals: number;
    followUps: number;
    recommendations: number;
    segmentsToApprove: number;
    total: number;
  };
  funnel: Array<{ stage: string; label: string; count: number; rate: number | null }>;
  performance: {
    positiveReplyRate: number | null;
    replyRate: number | null;
    meetingPerContact: number | null;
    clientPerContact: number | null;
    cac: number | null;
    revenuePer100: number | null;
    spendUsd: number | null;
  };
  segments: Array<{
    id: string;
    name: string;
    status: string;
    approvedForSend: boolean;
    contacted: number;
    positiveReplies: number;
    meetings: number;
    clients: number;
    revenuePer100: number | null;
    decision: string;
    decisionReason: string;
  }>;
  best: {
    segment: { id: string; name: string; positiveRate: number } | null;
    messageVariant: { key: string; positiveRate: number; contacted: number } | null;
  };
  recommendations: Array<{
    id: string;
    kind: string;
    title: string;
    reason: string;
    sampleSize: number;
    expectedImpact: string | null;
    risk: string;
    status: string;
    humanRequired: boolean;
    hasChange: boolean;
    /** Les chiffres qui portent la recommandation, pour la dire en clair. */
    evidence: Record<string, unknown>;
    createdAt: string;
  }>;
  insufficient: Array<{ subject: string; sample: number; needed: number }>;
  hotLeads: Array<{
    domain: string;
    companyName: string;
    /** La personne qui a écrit, telle que le prospect ou l'expéditeur la nomme. */
    contact: string | null;
    sender: string | null;
    intent: ReplyIntent;
    confidence: number;
    receivedAt: string;
    subject: string | null;
    excerpt: string | null;
    status: 'OPEN' | 'HANDLED';
  }>;
  hotLeadsTotal: number;
  system: {
    search: SystemLight;
    llm: SystemLight;
    gmail: SystemLight;
    workers: SystemLight;
    database: SystemLight;
    outbound: { enabled: boolean; mode: string; paused: boolean; pauseReason: string | null; window: string; windowOpen: boolean };
    lastCycleAt: string | null;
    openInsights: number;
    detail: string[];
  };
}

export interface SystemLight {
  state: 'ok' | 'warn' | 'down' | 'off';
  detail: string;
}

const rangeSince = (range: DashboardRange, now: Date): string | null =>
  range === 'all' ? null : new Date(now.getTime() - (range === '7d' ? 7 : 30) * 86_400_000).toISOString();

const minutesAgo = (iso: string | null, now: Date): number | null =>
  iso ? Math.round((now.getTime() - Date.parse(iso)) / 60_000) : null;

/** « 4 min », « 3 h », « 2 j » — un âge qui se lit sans calculer. */
const humanMinutes = (minutes: number | null): string =>
  minutes === null ? '—' : minutes < 60 ? `${minutes} min` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} j`;

export function buildSalesDashboard(
  repos: Repositories,
  config: AtlasConfig,
  options: { range?: DashboardRange; segmentId?: string | null; now?: Date; gmailConfigured?: boolean | null; mailbox?: string | null } = {},
): SalesDashboard {
  const now = options.now ?? new Date();
  const mailbox = (options.mailbox ?? process.env.GMAIL_USER ?? '').trim();
  const range = options.range ?? '30d';
  const since = rangeSince(range, now);
  const segmentId = options.segmentId ?? null;

  // ── L'entonnoir ─────────────────────────────────────────────────────────
  const prospects = repos.sales.discoveredSince(since);
  const attributions = repos.salesEngine.attributions({ segmentId, contactedSince: null });
  const attributedDomains = segmentId ? new Set(attributions.map((a) => a.domain)) : null;
  const inScope = (domain: string | null): boolean => !attributedDomains || (domain !== null && attributedDomains.has(domain));

  const scopedProspects = prospects.filter((p) => inScope(p.domain));
  const discovered = scopedProspects.length;
  const icpQualified = scopedProspects.filter((p) => p.tier && p.tier !== 'REJECTED' && p.state !== 'REJECTED').length;
  const contactsFound = scopedProspects.filter((p) => Boolean(p.contactEmail || p.contactPage)).length;

  // Le registre fait foi pour « contacté » : c'est lui que chaque envoi écrit.
  // Une entrée de simulation (expéditeur à blanc, INTERNAL_TEST) n'est pas un
  // contact : elle reste au registre pour l'audit, pas dans le chiffre.
  const isSimulated = (note: string | null): boolean => /^simulation\b/i.test(note ?? '');
  const ledger = repos.sales.ledgerDomains().filter((row) =>
    row.kind === 'CONTACTED' && !isSimulated(row.note) && (!since || row.recordedAt >= since) && inScope(row.domain));
  const contactedDomains = new Set(ledger.map((r) => r.domain));
  const contacted = contactedDomains.size;

  const events = repos.conversations.eventsSince(since).filter((e) => inScope(e.domain));
  const intentByDomain = new Map<string, Array<{ intent: ReplyIntent; confidence: number; at: string; subject: string | null; excerpt: string | null; companyName: string; sender: string | null }>>();
  for (const e of events) {
    if (e.classification !== 'REPLIED' && e.classification !== 'NEEDS_REVIEW') continue;
    // Nos propres courriers, importés comme réponses avant la garde de
    // direction, ne sont pas des réponses : ils restent en base, pas ici.
    if (mailbox && e.sender && sameMailbox(e.sender, mailbox)) continue;
    const verdict = classifyReplyIntent({ subject: e.rawSubject, body: e.bodyExcerpt, sender: e.sender, classification: e.classification as 'REPLIED' | 'NEEDS_REVIEW' });
    const list = intentByDomain.get(e.domain) ?? [];
    list.push({ intent: verdict.intent, confidence: verdict.confidence, at: e.occurredAt, subject: e.rawSubject, excerpt: e.bodyExcerpt ? e.bodyExcerpt.slice(0, 180) : null, companyName: e.companyName, sender: e.sender });
    intentByDomain.set(e.domain, list);
  }
  const replied = intentByDomain.size;
  const positiveDomains = [...intentByDomain.entries()].filter(([, list]) => list.some((l) => POSITIVE_REPLY_INTENTS.includes(l.intent)));
  const positiveReplies = positiveDomains.length;

  const outcomes = repos.salesEngine.outcomes({ since, segmentId });
  const meetingDomains = new Set(outcomes.filter((o) => o.kind === 'MEETING_BOOKED' || o.kind === 'MEETING_DONE').map((o) => o.domain));
  const wonOutcomes = outcomes.filter((o) => o.kind === 'WON');
  const clientDomains = new Set(wonOutcomes.map((o) => o.domain));
  const revenueWon = wonOutcomes.reduce((s, o) => s + (o.revenueAmount ?? 0), 0);
  const spend = repos.llmCalls.usageSince(since ?? '1970-01-01T00:00:00.000Z');
  const spendUsd = spend.calls > 0 ? spend.knownCostUsd : null;

  const counts: SalesFunnelCounts = {
    discovered, icpQualified, contactsFound, contacted, replied, positiveReplies,
    meetings: meetingDomains.size, clients: clientDomains.size, revenueWon, spendUsd,
  };
  const rates = funnelRates(counts);
  const funnel: SalesDashboard['funnel'] = [
    { stage: 'discovered', label: 'Découverts', count: discovered, rate: null },
    { stage: 'icpQualified', label: 'Qualifiés ICP', count: icpQualified, rate: rates.qualifiedRate },
    { stage: 'contactsFound', label: 'Contacts trouvés', count: contactsFound, rate: rates.contactFoundRate },
    { stage: 'contacted', label: 'Contactés', count: contacted, rate: rates.contactedRate },
    { stage: 'replied', label: 'Réponses', count: replied, rate: rates.replyRate },
    { stage: 'positiveReplies', label: 'Réponses positives', count: positiveReplies, rate: rates.positiveReplyRate },
    { stage: 'meetings', label: 'Rendez-vous', count: meetingDomains.size, rate: rates.meetingPerContact },
    { stage: 'clients', label: 'Clients', count: clientDomains.size, rate: rates.clientPerContact },
  ];

  // ── Les cartes ──────────────────────────────────────────────────────────
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const allOutcomes = repos.salesEngine.outcomes({ segmentId });
  const allProspects = repos.sales.discoveredSince(null);
  const meetingsThisWeek = new Set(allOutcomes.filter((o) => (o.kind === 'MEETING_BOOKED' || o.kind === 'MEETING_DONE') && o.occurredAt >= weekAgo).map((o) => o.domain)).size;
  const allWon = allOutcomes.filter((o) => o.kind === 'WON' && (!since || o.occurredAt >= since));
  const averageDeal = allWon.length > 0 ? allWon.reduce((s, o) => s + (o.revenueAmount ?? 0), 0) / allWon.length : null;
  const meetingDomainsAll = new Set(allOutcomes.filter((o) => o.kind === 'MEETING_BOOKED' || o.kind === 'MEETING_DONE').map((o) => o.domain));
  const openMeetings = [...meetingDomainsAll].filter((d) => !allOutcomes.some((o) => o.domain === d && (o.kind === 'WON' || o.kind === 'LOST'))).length;
  const wonFromMeetings = [...meetingDomainsAll].filter((d) => allOutcomes.some((o) => o.domain === d && o.kind === 'WON')).length;
  const meetingToClientRate = meetingDomainsAll.size >= 3 ? wonFromMeetings / meetingDomainsAll.size : null;

  // ── Les réponses chaudes ────────────────────────────────────────────────
  // Le contact affiché vient du prospect quand on l'a établi (nom, rôle lus
  // sur le site), sinon du nom d'expéditeur. Jamais inventé.
  const prospectByDomain = new Map(repos.sales.discoveredSince(null).filter((p) => p.domain).map((p) => [p.domain!, p]));
  const hot = [...intentByDomain.entries()]
    .map(([domain, list]) => {
      const last = [...list].sort((a, b) => b.at.localeCompare(a.at))[0]!;
      const hottest = list.find((l) => HOT_LEAD_INTENTS.includes(l.intent));
      return { domain, last, hottest };
    })
    .filter((h) => h.hottest && !allOutcomes.some((o) => o.domain === h.domain && (o.kind === 'WON' || o.kind === 'LOST')))
    .map((h) => {
      const review = repos.salesEngine.leadReview(h.domain);
      return {
        domain: h.domain,
        companyName: h.last.companyName,
        contact: contactLabel(prospectByDomain.get(h.domain), h.last.sender),
        sender: h.last.sender,
        intent: h.hottest!.intent,
        confidence: h.hottest!.confidence,
        receivedAt: h.last.at,
        subject: h.last.subject,
        excerpt: h.last.excerpt,
        status: (review?.status ?? 'OPEN') as 'OPEN' | 'HANDLED',
      };
    })
    .sort((a, b) => (a.status === b.status ? b.receivedAt.localeCompare(a.receivedAt) : a.status === 'OPEN' ? -1 : 1));
  const openHot = hot.filter((h) => h.status === 'OPEN');
  const leadToMeetingRate = hot.length >= 5 ? hot.filter((h) => meetingDomainsAll.has(h.domain)).length / hot.length : null;

  const potential = pipelinePotential({
    openMeetings, hotLeads: openHot.length, averageDealValue: averageDeal, meetingToClientRate, leadToMeetingRate,
  });

  // ── Les segments ────────────────────────────────────────────────────────
  const stats = gatherSalesStats(repos, since);
  const segments = repos.salesEngine.segments().map((s) => {
    const st = stats.bySegment.get(s.id) ?? { contacted: 0, replied: 0, positive: 0, meetings: 0, clients: 0, revenue: 0 };
    const decision = segmentDecision(s.status, st);
    return {
      id: s.id, name: s.name, status: s.status, approvedForSend: s.approvedForSend,
      contacted: st.contacted, positiveReplies: st.positive, meetings: st.meetings, clients: st.clients,
      revenuePer100: st.contacted > 0 ? (st.revenue / st.contacted) * 100 : null,
      decision: decision.action, decisionReason: decision.reason,
    };
  });
  const bestSegment = segments
    .filter((s) => s.contacted >= 10)
    .map((s) => ({ id: s.id, name: s.name, positiveRate: s.positiveReplies / s.contacted }))
    .sort((a, b) => b.positiveRate - a.positiveRate)[0] ?? null;
  const bestVariant = [...stats.byVariant.values()]
    .filter((v) => v.contacted >= 10)
    .map((v) => ({ key: v.key, positiveRate: v.positive / v.contacted, contacted: v.contacted }))
    .sort((a, b) => b.positiveRate - a.positiveRate)[0] ?? null;

  // ── Les recommandations ─────────────────────────────────────────────────
  const recommendations = repos.salesEngine.recommendations({ status: ['PROPOSED', 'TESTING'], limit: 10 })
    .sort((a, b) => b.sampleSize - a.sampleSize)
    .slice(0, 3)
    .map((r) => ({
      id: r.id, kind: r.kind, title: r.title, reason: r.reason, sampleSize: r.sampleSize,
      expectedImpact: r.expectedImpact, risk: r.risk, status: r.status, humanRequired: r.humanRequired,
      hasChange: r.change !== null, evidence: r.evidence, createdAt: r.createdAt,
    }));
  const lastOptimization = repos.settings.get<{ insufficient?: Array<{ subject: string; sample: number; needed: number }> }>(SALES_SETTINGS.LAST_OPTIMIZATION, {});

  // ── À faire ─────────────────────────────────────────────────────────────
  const approvals = repos.salesLoop.draftsInState('READY_FOR_APPROVAL').length
    + allProspects.filter((p) => p.state === 'READY_FOR_REVIEW').length;
  const followUpsDue = repos.salesLoop.domainsInState('FOLLOW_UP_REQUIRED').length;
  const proposedRecommendations = repos.salesEngine.recommendations({ status: 'PROPOSED', limit: 100 }).length;
  const segmentsToApprove = config.sales.engineMode === 'PRODUCTION'
    ? repos.salesEngine.segments({ status: ['TESTING', 'VALIDATED', 'SCALE'] }).filter((s) => !s.approvedForSend).length
    : 0;
  const todo: SalesDashboard['todo'] = {
    hotLeads: openHot.length,
    approvals,
    followUps: followUpsDue,
    recommendations: proposedRecommendations,
    segmentsToApprove,
    total: openHot.length + approvals + followUpsDue + proposedRecommendations + segmentsToApprove,
  };

  // ── Le système ──────────────────────────────────────────────────────────
  const frictions = repos.salesEngine.frictions({ since: new Date(now.getTime() - 3_600_000).toISOString(), limit: 500 });
  const recent = (kind: string) => frictions.filter((f) => f.kind === kind).length;
  const pause = readGlobalPause(repos);
  const policy = sendPolicyOf(config);
  const window = isWithinSendWindow(now, policy);
  const daemon = repos.tasks.lastDaemonRun();
  const daemonAge = daemon && !daemon.stoppedAt ? minutesAgo(daemon.lastHeartbeatAt ?? daemon.startedAt, now) : null;
  const lastCycle = repos.settings.get<{ at: string } | null>(SALES_SETTINGS.LAST_CYCLES, null);
  const gmailConfigured = options.gmailConfigured ?? new GmailInboxProvider({ logger: silentLogger }).status().configured;
  const checkpoint = repos.conversations.syncCheckpoint('gmail', mailbox);
  const detail: string[] = [];

  const search: SystemLight = config.search.provider === 'none'
    ? { state: 'off', detail: 'aucun moteur configuré' }
    : recent('SEARCH_FAILURE') >= 3
      ? { state: 'down', detail: `${recent('SEARCH_FAILURE')} échecs de recherche dans l'heure` }
      : { state: 'ok', detail: `${config.search.provider}` };
  const llm: SystemLight = config.llm.mode !== 'live'
    ? { state: 'off', detail: `mode ${config.llm.mode}` }
    : recent('LLM_FAILURE') >= 3
      ? { state: 'warn', detail: `${recent('LLM_FAILURE')} échecs de modèle dans l'heure` }
      : { state: 'ok', detail: 'live' };
  const gmail: SystemLight = !gmailConfigured
    ? { state: 'off', detail: 'Gmail non configuré' }
    : recent('GMAIL_UNAVAILABLE') > 0
      ? { state: 'down', detail: 'synchronisation impossible dans l’heure' }
      : checkpoint && (minutesAgo(checkpoint.lastSyncedAt, now) ?? 0) > 90
        ? { state: 'warn', detail: `dernière lecture il y a ${humanMinutes(minutesAgo(checkpoint.lastSyncedAt, now))}` }
        : { state: 'ok', detail: checkpoint ? `lu il y a ${humanMinutes(minutesAgo(checkpoint.lastSyncedAt, now))}` : 'prêt, jamais lu' };
  const workers: SystemLight = !daemon || daemon.stoppedAt
    ? { state: 'down', detail: daemon ? `daemon arrêté ${daemon.stoppedAt?.slice(0, 16)}` : 'aucun daemon n’a jamais tourné' }
    : daemonAge !== null && daemonAge > 5
      ? { state: 'warn', detail: `dernier battement il y a ${humanMinutes(daemonAge)}` }
      : { state: 'ok', detail: `battement il y a ${humanMinutes(daemonAge ?? 0)}` };
  const database: SystemLight = { state: 'ok', detail: 'lecture réussie' };
  if (pause.paused) detail.push(`PAUSE — ${pause.reason ?? 'sans motif'} (${pause.by ?? '?'})`);
  if (!config.sales.outboundEnabled) detail.push('ATLAS_OUTBOUND_ENABLED=false : aucun envoi réel');
  if (config.sales.engineMode !== 'PRODUCTION') detail.push(`mode ${config.sales.engineMode} : aucun vrai prospect contacté`);

  return {
    generatedAt: now.toISOString(),
    range,
    since,
    segmentId,
    cards: {
      meetings: meetingDomains.size,
      meetingsThisWeek,
      clientsSigned: clientDomains.size,
      revenueSigned: revenueWon,
      currency: wonOutcomes[0]?.currency ?? 'EUR',
      pipelinePotential: potential.value,
      pipelineExplanation: potential.explanation,
    },
    funnel,
    todo,
    performance: {
      positiveReplyRate: rates.positiveReplyRate,
      replyRate: rates.replyRate,
      meetingPerContact: rates.meetingPerContact,
      clientPerContact: rates.clientPerContact,
      cac: rates.cac,
      revenuePer100: rates.revenuePer100,
      spendUsd,
    },
    segments,
    best: { segment: bestSegment, messageVariant: bestVariant },
    recommendations,
    insufficient: lastOptimization.insufficient ?? [],
    hotLeads: hot.slice(0, 10),
    hotLeadsTotal: openHot.length,
    system: {
      search, llm, gmail, workers, database,
      outbound: {
        enabled: config.sales.outboundEnabled, mode: config.sales.engineMode,
        paused: pause.paused, pauseReason: pause.reason, window: policy.sendWindow, windowOpen: window.open,
      },
      lastCycleAt: lastCycle?.at ?? null,
      openInsights: repos.salesEngine.insights({ status: 'OPEN' }).length,
      detail,
    },
  };
}

/** « Prénom Nom · rôle », ou le nom d'expéditeur, ou rien — jamais une invention. */
function contactLabel(prospect: { contactName: string | null; contactRole: string | null } | undefined, sender: string | null): string | null {
  const name = prospect?.contactName?.trim() || null;
  const role = prospect?.contactRole?.trim() || null;
  if (name && role) return `${name} · ${role}`;
  if (name) return name;
  if (role) return role;
  if (!sender) return null;
  const display = /^\s*"?([^"<]+?)"?\s*<[^>]+>/.exec(sender)?.[1]?.trim();
  return display && !display.includes('@') ? display : null;
}

const silentLogger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return silentLogger; },
} as unknown as import('@atlas/core').Logger;
