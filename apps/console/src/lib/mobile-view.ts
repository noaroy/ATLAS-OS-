import type { RevenueMobile, MobileProspectRow, ProspectDetail } from './api.ts';
import { blockerLabel, blockerLabels, deltaVsYesterday, type Tone } from './mobile-labels.ts';

/**
 * Ce que chaque écran mobile décide d'afficher — sans React, pour être testé.
 * L'écran ne fait qu'appeler : aucun chiffre n'est calculé côté navigateur
 * au-delà d'un choix de présentation.
 */

// ─── Le chiffre qui domine l'accueil ───────────────────────────────────────

export interface HeroMetric {
  value: number;
  label: string;
  series: number[];
  seriesLabel: string;
  delta: { text: string; tone: Tone } | null;
}

/**
 * Qualifiés aujourd'hui s'il y en a ; sinon trouvés aujourd'hui s'il y en a ;
 * sinon qualifiés (zéro) — un zéro mesuré se dit, il ne se cache pas.
 */
export function heroMetric(data: RevenueMobile): HeroMetric {
  const k = data.kpis;
  const t = data.trends;
  if (k.qualifiedToday > 0 || k.discoveredToday === 0) {
    return {
      value: k.qualifiedToday,
      label: k.qualifiedToday === 1 ? 'prospect qualifié aujourd’hui' : 'prospects qualifiés aujourd’hui',
      series: t.qualified, seriesLabel: 'Qualifiés', delta: deltaVsYesterday(t.qualified),
    };
  }
  return {
    value: k.discoveredToday,
    label: k.discoveredToday === 1 ? 'prospect trouvé aujourd’hui' : 'prospects trouvés aujourd’hui',
    series: t.found, seriesLabel: 'Trouvés', delta: deltaVsYesterday(t.found),
  };
}

// ─── Le funnel compact ─────────────────────────────────────────────────────

export interface FunnelStep {
  key: string;
  label: string;
  count: number | null;
  /** Part du premier palier, pour la jauge (0 à 1). */
  share: number;
}

const FUNNEL: Array<[string, string]> = [
  ['DISCOVERED', 'Trouvés'], ['QUALIFIED', 'Qualifiés'], ['CONTACT_READY', 'Prêts'], ['SENT', 'Envoyés'],
  ['REPLY', 'Réponses'], ['MEETING', 'RDV'], ['WON', 'Gagnés'],
];

/** Sept étapes ; « Proposition » (non consignée) n'y figure pas. */
export function funnelSteps(data: RevenueMobile): { steps: FunnelStep[]; replyRate: number | null } {
  const byKey = new Map(data.funnel.map((s) => [s.key, s.count]));
  const top = byKey.get('DISCOVERED') ?? 0;
  const steps = FUNNEL.map(([key, label]) => {
    const count = byKey.get(key) ?? null;
    // Racine carrée : un funnel de B2B perd deux ordres de grandeur ; en linéaire,
    // tout ce qui suit « Envoyés » serait invisible.
    const share = top > 0 && count !== null ? Math.sqrt(Math.min(1, count / top)) : 0;
    return { key, label, count, share };
  });
  const sent = byKey.get('SENT') ?? null;
  const reply = byKey.get('REPLY') ?? null;
  return { steps, replyRate: sent && reply !== null ? reply / sent : null };
}

// ─── « À faire » : trois cartes au plus ────────────────────────────────────

export interface HomeAction {
  key: string;
  title: string;
  hint: string;
  to: string;
  tone: Tone;
  icon: string;
}

export function homeActions(data: RevenueMobile): HomeAction[] {
  const t = data.todo;
  const out: HomeAction[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
  if (t.hotLeads > 0) {
    out.push({ key: 'hot', title: plural(t.hotLeads, 'réponse chaude', 'réponses chaudes'), hint: 'À lire et traiter maintenant', to: '/m/outreach?tab=replies', tone: 'good', icon: 'reply' });
  }
  if (t.approvals > 0) {
    out.push({ key: 'approve', title: plural(t.approvals, 'brouillon à approuver', 'brouillons à approuver'), hint: 'Relire avant tout envoi', to: '/m/outreach?tab=approve', tone: 'warn', icon: 'mail' });
  }
  if (t.followUps > 0) {
    out.push({ key: 'follow', title: plural(t.followUps, 'relance due', 'relances dues'), hint: 'Silence depuis le premier message', to: '/m/outreach?tab=sent', tone: 'info', icon: 'send' });
  }
  const blocker = mainBlocker(data);
  if (blocker) out.push(blocker);
  return out.slice(0, 3);
}

/** Le blocage qui mérite l'attention du fondateur — un seul, le plus grave. */
function mainBlocker(data: RevenueMobile): HomeAction | null {
  const h = data.header;
  if (h.killSwitch.paused) {
    return { key: 'pause', title: 'Envois en pause', hint: h.killSwitch.reason ?? 'Pause générale active', to: '/m/system', tone: 'warn', icon: 'pause' };
  }
  const down = h.services.find((s) => s.state === 'down');
  if (down) return { key: 'down', title: `${down.label} en panne`, hint: down.detail, to: '/m/system', tone: 'bad', icon: 'alert' };
  const f = data.loops.factory;
  if (f.runs24h > 0 && f.processed24h < f.target24h && f.mainBlocker) {
    const raw = f.mainBlocker.replace(/\s*\(\d+\)$/, '');
    return {
      key: 'factory', title: `Fabrique sous l’objectif — ${f.processed24h}/${f.target24h}`,
      hint: `Blocage le plus fréquent : ${blockerLabel(raw).toLowerCase()}`, to: '/m/prospects?f=blocked', tone: 'warn', icon: 'alert',
    };
  }
  return null;
}

// ─── Filtres de la liste de prospects ──────────────────────────────────────

export type ProspectFilter = 'all' | 'priority' | 'ready' | 'blocked' | 'contacted' | 'replies';

export const PROSPECT_FILTERS: Array<[ProspectFilter, string]> = [
  ['all', 'Tous'], ['priority', 'Prioritaires'], ['ready', 'Prêts'], ['blocked', 'Bloqués'], ['contacted', 'Contactés'], ['replies', 'Réponses'],
];

const CONTACTED = new Set(['SENT', 'DELIVERED', 'FAILED', 'BOUNCED', 'REPLIED', 'POSITIVE_REPLY', 'NEGATIVE_REPLY', 'MEETING', 'PROPOSAL', 'WON', 'LOST']);
const REPLIED = new Set(['REPLIED', 'POSITIVE_REPLY', 'NEGATIVE_REPLY', 'MEETING', 'PROPOSAL', 'WON']);

export function matchesFilter(row: MobileProspectRow, filter: ProspectFilter): boolean {
  switch (filter) {
    case 'all': return true;
    case 'priority': return row.tier === 'PRIORITY';
    case 'ready': return (row.sendEligible && !CONTACTED.has(row.commercialState)) || row.commercialState === 'READY' || row.commercialState === 'QUEUED';
    case 'blocked': return row.factoryClass === 'NEEDS_ENRICHMENT' || row.factoryClass === 'BLOCKED';
    case 'contacted': return CONTACTED.has(row.commercialState);
    case 'replies': return REPLIED.has(row.commercialState);
  }
}

export function filterProspects(rows: readonly MobileProspectRow[], filter: ProspectFilter, query: string): MobileProspectRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => matchesFilter(r, filter) && (!q || r.companyName.toLowerCase().includes(q) || r.domain.includes(q)));
}

export function parseFilter(raw: string | null): ProspectFilter {
  return PROSPECT_FILTERS.some(([k]) => k === raw) ? (raw as ProspectFilter) : 'all';
}

// ─── Onglets de la boîte d'envoi ───────────────────────────────────────────

export type OutreachTab = 'approve' | 'ready' | 'sent' | 'replies' | 'blocked';

export const OUTREACH_TABS: Array<[OutreachTab, string]> = [
  ['approve', 'À approuver'], ['ready', 'Prêts'], ['sent', 'Envoyés'], ['replies', 'Réponses'], ['blocked', 'Bloqués'],
];

export function parseTab(raw: string | null): OutreachTab {
  return OUTREACH_TABS.some(([k]) => k === raw) ? (raw as OutreachTab) : 'approve';
}

// ─── Le verdict d'une fiche prospect ────────────────────────────────────────

/**
 * Codes qui disent où en est la conversation, pas ce qui manque : un prospect
 * déjà écrit, contacté ou qui a répondu n'est pas « bloqué ».
 */
const PROGRESS_CODES = new Set(['PRIOR_FIRST_TOUCH', 'ALREADY_SENT', 'ALREADY_CONTACTED', 'REPLY_RECEIVED']);
const STOP_CODES = new Set(['SUPPRESSED', 'DO_NOT_CONTACT']);
const isProgress = (code: string) => PROGRESS_CODES.has(code) || code.startsWith('LEDGER_');

export interface ProspectVerdict {
  tone: Tone;
  icon: 'check' | 'alert' | 'mail' | 'reply' | 'send' | 'shield';
  title: string;
  /** Ce qui manque encore, en français ; vide quand rien ne manque. */
  items: string[];
}

export function prospectVerdict(d: Pick<ProspectDetail, 'blockers' | 'firstTouchReady' | 'drafts'> & { factory?: ProspectDetail['factory'] }): ProspectVerdict {
  // La boucle B n'écrit que ce que la fabrique a déclaré éligible : un verdict
  // non éligible compte ses propres motifs parmi ce qui manque.
  const factoryHold = d.factory && !d.factory.sendEligible ? (d.factory.blockers.length ? d.factory.blockers : ['FACTORY_NOT_ELIGIBLE']) : [];
  const missing = blockerLabels([...d.blockers, ...factoryHold].filter((b) => !isProgress(b) && !STOP_CODES.has(b)));
  const draft = [...d.drafts].reverse().find((x) => x.state !== 'ABANDONED' && x.state !== 'REJECTED') ?? null;
  if (d.blockers.some((b) => STOP_CODES.has(b))) return { tone: 'neutral', icon: 'shield', title: 'Ne plus contacter', items: [] };
  if (d.blockers.includes('REPLY_RECEIVED')) return { tone: 'good', icon: 'reply', title: 'A répondu — conversation en cours', items: [] };
  if (d.blockers.includes('ALREADY_SENT') || d.blockers.includes('ALREADY_CONTACTED') || d.blockers.some((b) => b.startsWith('LEDGER_'))) {
    return { tone: 'info', icon: 'send', title: 'Déjà contacté — en attente de réponse', items: [] };
  }
  if (draft?.state === 'READY_FOR_APPROVAL') return { tone: 'warn', icon: 'mail', title: 'Brouillon prêt — à approuver', items: missing };
  if (draft && ['APPROVED_TO_SEND', 'QUEUED', 'SENDING'].includes(draft.state)) {
    return { tone: 'info', icon: 'send', title: 'Approuvé — en attente d’envoi', items: missing };
  }
  if (missing.length === 0) return { tone: 'good', icon: 'check', title: 'Prêt pour premier contact', items: [] };
  return { tone: 'warn', icon: 'alert', title: `Bloqué — ${missing.length} élément${missing.length > 1 ? 's' : ''} manquant${missing.length > 1 ? 's' : ''}`, items: missing };
}
