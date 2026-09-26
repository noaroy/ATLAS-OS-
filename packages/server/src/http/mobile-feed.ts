import { canonicalDomainOf } from '@atlas/core';
import { isCommercialEmail, type Repositories, type SalesProspect, type FactoryVerdict } from '@atlas/data';
import { classifyReplyIntent, sameMailbox, isTechnicalDomain } from '@atlas/departments';
import { commercialStateOf, type CommercialState } from '@atlas/runtime';
import { buildApprovals } from './command-center.ts';

/**
 * Les lectures de l'application mobile, en plus de `/api/cc/revenue`.
 *
 * Rien n'est calculé qui ne soit déjà consigné : la liste des prospects lit le
 * registre commercial et les verdicts de la fabrique, la boîte d'envoi lit les
 * brouillons, les envois et les réponses, les tendances comptent des lignes
 * horodatées. Aucune écriture, aucune sonde externe, aucun identifiant.
 */

const DAY_MS = 86_400_000;

// ─── Tendances sur 7 jours ──────────────────────────────────────────────────

export interface MobileTrends {
  /** Les sept jours UTC, du plus ancien au plus récent (aujourd'hui compris). */
  days: string[];
  found: number[];
  qualified: number[];
  replies: number[];
}

/**
 * Trois séries, comptées sur des horodatages réels :
 *   · found     — prospects versés au registre, par jour de découverte ;
 *   · qualified — parmi eux, ceux qui sont qualifiés (palier attribué, hors
 *                 rejet) — la définition exacte du KPI « qualifiés aujourd'hui »,
 *                 pour que le dernier point de la courbe soit le chiffre affiché ;
 *   · replies   — réponses reçues (hors notre propre boîte), une par domaine et par jour.
 */
export function buildMobileTrends(repos: Repositories, now: Date, mailbox = process.env.GMAIL_USER ?? ''): MobileTrends {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Array.from({ length: 7 }, (_, i) => new Date(today - (6 - i) * DAY_MS).toISOString().slice(0, 10));
  const since = `${days[0]}T00:00:00.000Z`;
  const index = new Map(days.map((d, i) => [d, i]));
  const found = days.map(() => 0);
  const qualified = days.map(() => 0);
  const replies = days.map(() => new Set<string>());

  for (const p of repos.sales.discoveredSince(since)) {
    const i = index.get(p.discoveredAt.slice(0, 10));
    if (i === undefined || !p.domain || isTechnicalDomain(p.domain)) continue;
    found[i]! += 1;
    if (p.tier !== null && p.tier !== 'REJECTED' && p.state !== 'REJECTED') qualified[i]! += 1;
  }
  for (const e of repos.conversations.eventsSince(since)) {
    if (e.classification !== 'REPLIED' && e.classification !== 'NEEDS_REVIEW') continue;
    if (mailbox && e.sender && sameMailbox(e.sender, mailbox)) continue;
    if (e.kind === 'MANUAL_NOTE') continue;
    const i = index.get(e.occurredAt.slice(0, 10));
    if (i !== undefined) replies[i]!.add(e.domain);
  }
  return { days, found, qualified, replies: replies.map((s) => s.size) };
}

// ─── Activité récente ───────────────────────────────────────────────────────

export type ActivityKind = 'FACTORY' | 'DRAFT' | 'SENT' | 'REPLY' | 'OUTCOME';

export interface MobileActivity {
  at: string;
  kind: ActivityKind;
  title: string;
  detail: string | null;
  domain: string | null;
}

/** Les derniers faits revenue, toutes sources confondues, les plus récents d'abord. */
export function buildMobileActivity(repos: Repositories, limit = 4, mailbox = process.env.GMAIL_USER ?? ''): MobileActivity[] {
  const items: MobileActivity[] = [];
  for (const run of repos.revenueFactory.runs(5)) {
    if (run.status !== 'DONE' || run.processed === 0) continue;
    const stats = run.stats as { sendEligible?: number };
    items.push({
      at: run.finishedAt ?? run.startedAt, kind: 'FACTORY',
      title: `${run.processed} entreprise${run.processed > 1 ? 's' : ''} analysée${run.processed > 1 ? 's' : ''}`,
      detail: typeof stats.sendEligible === 'number' && stats.sendEligible > 0 ? `${stats.sendEligible} prête${stats.sendEligible > 1 ? 's' : ''} pour un premier contact` : null,
      domain: null,
    });
  }
  for (const d of [...repos.salesLoop.draftsInState('READY_FOR_APPROVAL'), ...repos.salesLoop.draftsInState('APPROVED_TO_SEND')].slice(-5)) {
    items.push({ at: d.createdAt, kind: 'DRAFT', title: `Brouillon prêt — ${d.companyName}`, detail: d.subject, domain: d.domain });
  }
  const companyOf = new Map(repos.conversations.all().map((c) => [c.canonicalDomain, c.companyName]));
  for (const s of repos.salesLoop.sentLog(5)) {
    if (s.phase !== 'SENT' || !s.occurredAt) continue;
    items.push({ at: s.occurredAt, kind: 'SENT', title: `Message envoyé — ${companyOf.get(s.domain) ?? s.domain}`, detail: s.subject, domain: s.domain });
  }
  for (const e of repos.conversations.eventsSince(new Date(Date.now() - 30 * DAY_MS).toISOString()).slice(-20)) {
    if (e.classification !== 'REPLIED' && e.classification !== 'NEEDS_REVIEW') continue;
    if (mailbox && e.sender && sameMailbox(e.sender, mailbox)) continue;
    if (e.kind === 'MANUAL_NOTE') {
      items.push({ at: e.occurredAt, kind: 'OUTCOME', title: `${outcomeLabel(e.rawSubject)} — ${e.companyName}`, detail: null, domain: e.domain });
      continue;
    }
    items.push({ at: e.occurredAt, kind: 'REPLY', title: `Réponse de ${e.companyName}`, detail: e.rawSubject, domain: e.domain });
  }
  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}

function outcomeLabel(subject: string | null): string {
  const kind = (subject ?? '').split(' ')[0];
  return kind === 'WON' ? 'Client gagné' : kind === 'LOST' ? 'Affaire perdue' : kind === 'PROPOSAL_SENT' ? 'Proposition envoyée' : 'Rendez-vous';
}

// ─── Liste des prospects ────────────────────────────────────────────────────

export interface MobileProspectRow {
  domain: string;
  companyName: string;
  score: number | null;
  tier: string | null;
  /** Le verdict de la fabrique, s'il y en a un. */
  factoryClass: FactoryVerdict['classification'] | null;
  sendEligible: boolean;
  /** L'état commercial dérivé (boucle B). NONE tant que rien n'a été rédigé. */
  commercialState: CommercialState;
  contactReady: boolean;
  /** Le premier motif de blocage, brut — l'écran le traduit. */
  mainBlocker: string | null;
  blockers: number;
  discoveredAt: string;
  lastActivityAt: string;
}

const TIER_RANK: Record<string, number> = { PRIORITY: 0, GOOD_FIT: 1, WATCH: 2 };
const STATE_RANK: Partial<Record<CommercialState, number>> = {
  POSITIVE_REPLY: 0, MEETING: 1, PROPOSAL: 2, REPLIED: 3, READY: 4, QUEUED: 5, PAUSED: 5, SENT: 6, DELIVERED: 6,
};

/**
 * Une ligne par entreprise (domaine canonique), triée pour le fondateur :
 * ce qui a répondu, puis ce qui attend une décision, puis ce qui est prêt,
 * puis le reste par palier et score.
 */
export function buildProspectList(repos: Repositories, now: Date, limit = 300): { total: number; rows: MobileProspectRow[] } {
  const byDomain = new Map<string, SalesProspect[]>();
  for (const p of repos.sales.discoveredSince(null)) {
    if (!p.domain || isTechnicalDomain(p.domain)) continue;
    const d = canonicalDomainOf(p.domain);
    if (!d) continue;
    byDomain.set(d, [...(byDomain.get(d) ?? []), p]);
  }
  const verdicts = new Map(repos.revenueFactory.verdicts({ limit: 100_000 }).map((v) => [v.domain, v]));
  const active = new Set<string>([
    ...repos.salesLoop.draftsInState('READY_FOR_APPROVAL').map((d) => d.domain),
    ...repos.salesLoop.draftsInState('APPROVED_TO_SEND').map((d) => d.domain),
    ...repos.salesLoop.sentLog(1000).map((r) => r.domain),
    ...repos.salesEngine.outcomes({}).map((o) => o.domain),
    ...repos.conversations.all().map((c) => c.canonicalDomain),
  ]);

  const rows: MobileProspectRow[] = [];
  for (const [domain, list] of byDomain) {
    const p = [...list].sort((a, b) => (TIER_RANK[a.tier ?? ''] ?? 3) - (TIER_RANK[b.tier ?? ''] ?? 3)
      || (b.score ?? -1) - (a.score ?? -1) || b.updatedAt.localeCompare(a.updatedAt))[0]!;
    const v = verdicts.get(domain) ?? null;
    const state: CommercialState = active.has(domain) ? commercialStateOf(repos, domain, now).state : 'NONE';
    const contactReady = p.contactObserved && Boolean(p.contactEmail) && isCommercialEmail(p.contactEmail!, domain);
    rows.push({
      domain, companyName: p.companyName, score: p.score, tier: p.tier,
      factoryClass: v?.classification ?? null, sendEligible: v?.sendEligible ?? false,
      commercialState: state, contactReady,
      mainBlocker: v?.blockers[0] ?? null, blockers: v?.blockers.length ?? 0,
      discoveredAt: p.discoveredAt,
      lastActivityAt: [p.updatedAt, v?.processedAt ?? ''].sort().at(-1)!,
    });
  }
  rows.sort((a, b) => (STATE_RANK[a.commercialState] ?? 9) - (STATE_RANK[b.commercialState] ?? 9)
    || Number(b.sendEligible) - Number(a.sendEligible)
    || (TIER_RANK[a.tier ?? ''] ?? 3) - (TIER_RANK[b.tier ?? ''] ?? 3)
    || (b.score ?? -1) - (a.score ?? -1)
    || b.lastActivityAt.localeCompare(a.lastActivityAt)
    || a.domain.localeCompare(b.domain));
  return { total: rows.length, rows: rows.slice(0, limit) };
}

/**
 * Le verdict de la fabrique pour un domaine, en lecture seule : c'est lui que
 * la boucle B consulte avant d'écrire (`FACTORY_NOT_ELIGIBLE`). La fiche le
 * montre pour ne jamais dire « prêt » d'un prospect que la fabrique retient.
 */
export function factoryVerdictOf(repos: Repositories, domain: string): {
  classification: FactoryVerdict['classification']; sendEligible: boolean; blockers: string[]; processedAt: string;
} | null {
  const v = repos.revenueFactory.verdict(canonicalDomainOf(domain));
  return v ? { classification: v.classification, sendEligible: v.sendEligible, blockers: [...v.blockers], processedAt: v.processedAt } : null;
}

// ─── La boîte d'envoi ───────────────────────────────────────────────────────

export interface OutreachInboxRow {
  id: string;
  domain: string;
  company: string;
  recipient: string | null;
  subject: string | null;
  at: string;
  /** L'état brut — l'écran le traduit. */
  state: string;
  detail: string | null;
}

export interface OutreachInbox {
  generatedAt: string;
  toApprove: OutreachInboxRow[];
  ready: OutreachInboxRow[];
  sent: OutreachInboxRow[];
  replies: OutreachInboxRow[];
  blocked: OutreachInboxRow[];
}

/**
 * Cinq onglets, cinq lectures existantes :
 *   · À approuver — la file d'approbation du centre de commande (les deux magasins) ;
 *   · Prêts       — brouillons approuvés, en attente du cycle d'envoi ;
 *   · Envoyés     — le journal d'envoi (issue SENT) ;
 *   · Réponses    — la dernière réponse de chaque domaine, avec son intention ;
 *   · Bloqués     — brouillons fermés, avec le motif consigné.
 */
export function buildOutreachInbox(repos: Repositories, now: Date, mailbox = process.env.GMAIL_USER ?? ''): OutreachInbox {
  const approvals = buildApprovals(repos);
  const toApprove = approvals.pending.map((a) => ({
    id: a.id, domain: a.domain, company: a.company, recipient: a.recipient, subject: a.subject,
    at: a.createdAt, state: a.sourceState, detail: a.actionType === 'EMAIL' ? null : a.actionLabel,
  }));
  const ready = repos.salesLoop.draftsInState('APPROVED_TO_SEND').map((d) => ({
    id: d.id, domain: d.domain, company: d.companyName, recipient: d.recipient, subject: d.subject,
    at: d.createdAt, state: 'APPROVED_TO_SEND', detail: null,
  })).reverse();

  const companyOf = new Map(repos.conversations.all().map((c) => [c.canonicalDomain, c.companyName]));
  const sent = repos.salesLoop.sentLog(100).filter((r) => r.phase === 'SENT' && r.occurredAt).map((r) => ({
    id: r.idempotencyKey.slice(0, 16), domain: r.domain, company: companyOf.get(r.domain) ?? r.domain,
    recipient: r.recipient, subject: r.subject, at: r.occurredAt!, state: commercialStateOf(repos, r.domain, now).state, detail: null,
  }));

  const latest = new Map<string, OutreachInboxRow>();
  for (const e of repos.conversations.eventsSince(new Date(now.getTime() - 90 * DAY_MS).toISOString())) {
    if (e.classification !== 'REPLIED' && e.classification !== 'NEEDS_REVIEW') continue;
    if (e.kind === 'MANUAL_NOTE') continue;
    if (mailbox && e.sender && sameMailbox(e.sender, mailbox)) continue;
    const intent = classifyReplyIntent({ subject: e.rawSubject, body: e.bodyExcerpt, sender: e.sender, classification: e.classification as 'REPLIED' | 'NEEDS_REVIEW' }).intent;
    const row = {
      id: e.id, domain: e.domain, company: e.companyName, recipient: e.sender, subject: e.rawSubject,
      at: e.occurredAt, state: intent, detail: e.bodyExcerpt ? e.bodyExcerpt.slice(0, 160) : null,
    };
    const prev = latest.get(e.domain);
    if (!prev || prev.at < row.at) latest.set(e.domain, row);
  }
  const replies = [...latest.values()].sort((a, b) => (a.at < b.at ? 1 : -1));

  const blocked = repos.salesLoop.closedDrafts(50).map((d) => ({
    id: d.id, domain: d.domain, company: d.companyName, recipient: d.recipient, subject: d.subject,
    at: d.decidedAt ?? d.createdAt, state: d.state, detail: d.decisionNote,
  }));

  return { generatedAt: now.toISOString(), toApprove, ready, sent, replies, blocked };
}
