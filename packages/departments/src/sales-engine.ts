/**
 * Le moteur commercial en production : les règles, sans base ni réseau.
 *
 * Tout ce qui est ici se vérifie par un test et se relit sans exécuter quoi
 * que ce soit. Le fichier ne réécrit rien de ce qui existait : le classement
 * des réponses part de `classifyInbound` et `detectOptOut`, la porte d'envoi
 * candidat par candidat reste `evaluateSendGate`, les relances restent
 * `evaluateFollowUp`. Ce qui s'ajoute, c'est la couche que la boucle n'avait
 * pas : la politique d'envoi globale (interrupteur, fenêtre, plafonds, pause),
 * l'intention commerciale d'une réponse, l'entonnoir et ses taux, la décision
 * de vie d'un segment, les recommandations avec leurs seuils d'échantillon,
 * et les changements de stratégie bornés.
 *
 * Trois règles ne bougent jamais. Une valeur inconnue s'affiche `null`, pas
 * `0`. Un échantillon trop petit donne INSUFFICIENT_DATA, pas une conclusion.
 * Et un client gagné, un rendez-vous, un chiffre d'affaires ne se déduisent
 * pas : ils entrent par une personne.
 */

import { classifyInbound, detectOptOut, type ReplyClassification } from './reply-intake.ts';
import type { ContactIntent, OutreachSuitability } from './contact-intent.ts';

// ─── Intention commerciale d'une réponse (§16) ──────────────────────────────

export const REPLY_INTENTS = [
  'POSITIVE', 'INTERESTED_LATER', 'QUESTION', 'NEUTRAL', 'NEGATIVE',
  'NOT_RELEVANT', 'OPT_OUT', 'BOUNCE', 'OUT_OF_OFFICE',
] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];

/** Les classes qui comptent comme « réponse positive » dans les taux. */
export const POSITIVE_REPLY_INTENTS: readonly ReplyIntent[] = ['POSITIVE', 'INTERESTED_LATER', 'QUESTION'];
/** Les classes qui placent l'entreprise dans la file des réponses chaudes. */
export const HOT_LEAD_INTENTS: readonly ReplyIntent[] = ['POSITIVE', 'QUESTION', 'INTERESTED_LATER'];
/** Les classes après lesquelles plus aucune relance ne doit partir. */
export const STOP_FOLLOW_UP_INTENTS: readonly ReplyIntent[] = [
  'POSITIVE', 'INTERESTED_LATER', 'QUESTION', 'NEUTRAL', 'NEGATIVE', 'NOT_RELEVANT', 'OPT_OUT', 'BOUNCE',
];

export interface ReplyIntentVerdict {
  intent: ReplyIntent;
  /** 0..1 — ce que valent les marqueurs trouvés. */
  confidence: number;
  signals: string[];
  /** Le classement de premier niveau dont l'intention découle. */
  classification: ReplyClassification;
}

const fold = (value: string | null | undefined): string =>
  (value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const MARKERS: Record<
  Exclude<ReplyIntent, 'OPT_OUT' | 'BOUNCE' | 'OUT_OF_OFFICE' | 'NEUTRAL'>,
  readonly RegExp[]
> = {
  POSITIVE: [
    /\b(interess[ée]s?|interesse)\b/, /\binterested\b/, /\brendez[- ]?vous\b/, /\bmeeting\b/,
    /\b(un )?(appel|call)\b/, /\b(planifi|schedul|book)/, /\bavec plaisir\b/, /\bvolontiers\b/,
    /\b(oui|yes)[ ,.!]/, /\bd'accord\b/, /\bok pour\b/, /\bcela m'interesse\b/, /\bsounds good\b/,
    /\blet'?s talk\b/, /\bhappy to\b/, /\benvoyez[- ]moi\b/, /\bsend me\b/, /\bdisponibilit/,
    /\bavailab/, /\bdemo\b/, /\bdevis\b/, /\bquote\b/, /\bproposition\b/, /\bproposal\b/,
  ],
  INTERESTED_LATER: [
    /\bplus tard\b/, /\blater\b/, /\bpas (pour )?(le moment|maintenant|tout de suite)\b/,
    /\bnot (right )?now\b/, /\brevenir vers vous\b/, /\bget back to you\b/, /\bdans quelques (mois|semaines)\b/,
    /\bin a few (months|weeks)\b/, /\b(q[1-4]|trimestre|quarter)\b/, /\brentree\b/, /\bl'annee prochaine\b/,
    /\bnext year\b/, /\brecontact/, /\bre-?contact\b/, /\bgardons contact\b/, /\bkeep in touch\b/,
  ],
  QUESTION: [
    /\?/, /\bcombien\b/, /\bhow much\b/, /\bcomment\b/, /\bhow (do|does|would)\b/, /\bquel(le)?s?\b/,
    /\bwhat (is|are|would)\b/, /\bpouvez[- ]vous\b/, /\bcould you\b/, /\bcan you\b/, /\bprecis(er|ions)\b/,
    /\bdetails?\b/, /\bexemple\b/, /\bexample\b/, /\btarif/, /\bpricing\b/, /\bprix\b/,
  ],
  NEGATIVE: [
    /\bpas interess/, /\bnot interested\b/, /\bno thank/, /\bnon merci\b/, /\bne (sommes|suis) pas interess/,
    /\baucun besoin\b/, /\bno need\b/, /\bpas de besoin\b/, /\bne donnera pas suite\b/, /\bdecline\b/,
    /\bnous avons deja\b/, /\bwe already (have|work)\b/, /\bne (nous )?convient pas\b/, /\bnot a (good )?fit\b/,
    /\bpas prioritaire\b/, /\bmerci de ne plus\b/,
  ],
  NOT_RELEVANT: [
    /\bmauvais(e)? (personne|interlocuteur|destinataire|adresse)\b/, /\bwrong (person|contact|address)\b/,
    /\bne (me )?concerne pas\b/, /\bnot (the )?right (person|contact)\b/, /\bne (travaille|suis) plus\b/,
    /\bno longer (work|with)\b/, /\bhors (sujet|perimetre)\b/, /\bnot relevant\b/, /\bne fait pas partie de mes\b/,
    /\bpas (en charge|responsable) de\b/, /\bnot (in charge|responsible)\b/,
  ],
};

const WEIGHT: Record<keyof typeof MARKERS, number> = {
  NEGATIVE: 3, NOT_RELEVANT: 3, INTERESTED_LATER: 2.5, POSITIVE: 2, QUESTION: 1,
};

/**
 * L'intention d'une réponse humaine, par-dessus le classement de premier
 * niveau. Un rebond reste un rebond, une absence reste une absence, un
 * désabonnement gagne sur tout : on ne « lit » l'intention que d'un message
 * écrit par une personne. Dans le doute, NEUTRAL avec une confiance basse —
 * une réponse neutre est lue par quelqu'un, elle n'est jamais rangée d'office.
 */
export function classifyReplyIntent(input: {
  subject?: string | null;
  body?: string | null;
  sender?: string | null;
  classification?: ReplyClassification;
}): ReplyIntentVerdict {
  const base = input.classification
    ?? classifyInbound({ kind: 'EMAIL_REPLY', subject: input.subject, sender: input.sender, body: input.body }).classification;
  const signals: string[] = [];

  if (base === 'BOUNCED') return { intent: 'BOUNCE', confidence: 0.95, signals: ['classification:BOUNCED'], classification: base };

  const optOut = detectOptOut({ subject: input.subject, body: input.body });
  if (optOut.optedOut) {
    return { intent: 'OPT_OUT', confidence: 0.95, signals: [`opt-out:${optOut.reason}`], classification: base };
  }
  if (base === 'AUTO_REPLY') {
    return { intent: 'OUT_OF_OFFICE', confidence: 0.85, signals: ['classification:AUTO_REPLY'], classification: base };
  }

  const haystack = `${fold(input.subject)} ${fold(input.body)}`.replace(/\s+/g, ' ').trim();
  if (!haystack) return { intent: 'NEUTRAL', confidence: 0.2, signals: ['vide'], classification: base };

  const scores = new Map<keyof typeof MARKERS, number>();
  for (const [intent, patterns] of Object.entries(MARKERS) as Array<[keyof typeof MARKERS, readonly RegExp[]]>) {
    let hits = 0;
    for (const pattern of patterns) {
      if (pattern.test(haystack)) {
        hits += 1;
        signals.push(`${intent}:${pattern.source.slice(0, 24)}`);
      }
    }
    if (hits > 0) scores.set(intent, hits * WEIGHT[intent]);
  }

  if (scores.size === 0) return { intent: 'NEUTRAL', confidence: 0.35, signals: ['aucun marqueur'], classification: base };

  // Le refus et le « mauvais interlocuteur » l'emportent sur un point
  // d'interrogation de politesse ; une question l'emporte sur un « oui » isolé.
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [intent, top] = ranked[0]!;
  const second = ranked[1]?.[1] ?? 0;
  const total = ranked.reduce((sum, [, v]) => sum + v, 0);
  const confidence = Math.min(0.9, 0.45 + (top - second) / Math.max(total, 1) * 0.45);

  // Une question adressée en même temps qu'un refus n'est pas une ouverture.
  if (intent === 'QUESTION' && scores.has('NEGATIVE')) {
    return { intent: 'NEGATIVE', confidence: Math.max(0.5, confidence - 0.1), signals, classification: base };
  }
  return { intent, confidence, signals, classification: base };
}

// ─── Confiance dans un contact (§9) ─────────────────────────────────────────

export type ContactConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * Ce que vaut une adresse avant qu'on lui écrive. Observée sur le site
 * officiel, à intention commerciale, même domaine : HIGH. Observée mais
 * générique : MEDIUM. Déduite, hors domaine, ou d'intention inconnue : LOW —
 * et LOW ne part jamais seule.
 */
export function contactConfidence(input: {
  observed: boolean;
  sameDomain: boolean;
  intent: ContactIntent | null;
  suitability: OutreachSuitability | null;
  sourceUrl: string | null;
}): { level: ContactConfidence; reasons: string[] } {
  const reasons: string[] = [];
  if (!input.observed) reasons.push('adresse non observée sur une page');
  if (!input.sameDomain) reasons.push('adresse hors du domaine officiel');
  if (!input.sourceUrl) reasons.push('aucune page source');
  if (input.suitability === 'BLOCKED') reasons.push('canal bloqué');
  if (!input.intent) reasons.push('intention du canal inconnue');
  if (reasons.length > 0) return { level: 'LOW', reasons };

  if (input.intent === 'SALES' || input.intent === 'EXPORT') {
    return { level: 'HIGH', reasons: [`canal ${input.intent} observé sur le domaine officiel`] };
  }
  if (input.intent === 'GENERAL') return { level: 'MEDIUM', reasons: ['boîte générale observée : la porte d’entrée, pas le décideur'] };
  return { level: 'LOW', reasons: [`intention ${input.intent} : pas un canal commercial`] };
}

// ─── Politique d'envoi globale (§12–13, §42–43, §65–67, §69) ─────────────────

export interface SendPolicy {
  dailyCapPerMailbox: number;
  hourlyCap: number;
  minDelaySeconds: number;
  /** « HH:MM-HH:MM », heure locale de `timezone`. */
  sendWindow: string;
  weekendEnabled: boolean;
  timezone: string;
  maxFollowUps: number;
  bouncePauseRate: number;
  bounceMinSample: number;
}

export type PolicyBlockReason =
  | 'OUTBOUND_DISABLED'
  | 'INTERNAL_TEST_MODE'
  | 'GLOBAL_PAUSE'
  | 'CAMPAIGN_NOT_APPROVED'
  | 'CAMPAIGN_NOT_ACTIVE'
  | 'SUPPRESSED'
  | 'REPLY_RECEIVED'
  | 'MAX_FOLLOWUPS_REACHED'
  | 'DAILY_CAP_REACHED'
  | 'HOURLY_CAP_REACHED'
  | 'MIN_DELAY_NOT_ELAPSED'
  | 'OUTSIDE_SEND_WINDOW'
  | 'WEEKEND'
  | 'BOUNCE_RATE_TOO_HIGH'
  | 'TRANSPORT_UNAVAILABLE';

export interface SendPolicyState {
  now: Date;
  outboundEnabled: boolean;
  engineMode: 'INTERNAL_TEST' | 'PRODUCTION';
  globalPause: { paused: boolean; reason?: string | null };
  /** null quand l'entreprise n'est rattachée à aucun segment : on ne devine pas. */
  campaign: { approvedForSend: boolean; status: string } | null;
  suppressed: { suppressed: boolean; detail?: string | null };
  replyReceived: boolean;
  purpose: 'FIRST_TOUCH' | 'FOLLOW_UP';
  followUpsSent: number;
  sentToday: number;
  sentThisHour: number;
  lastSentAt: string | null;
  bounces: { sent: number; bounced: number };
  transportConfigured: boolean;
}

export interface SendPolicyVerdict {
  allowed: boolean;
  blocks: Array<{ reason: PolicyBlockReason; detail: string }>;
  window: { open: boolean; detail: string };
}

/** Heure locale d'un instant dans un fuseau, sans bibliothèque. */
export function localClock(now: Date, timezone: string): { weekday: number; minutes: number; label: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  return {
    weekday: Math.max(0, weekdays.indexOf(get('weekday'))),
    minutes: hour * 60 + minute,
    label: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${timezone}`,
  };
}

const parseWindow = (window: string): { start: number; end: number } | null => {
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window.trim());
  if (!m) return null;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (start >= end) return null;
  return { start, end };
};

export function isWithinSendWindow(
  now: Date,
  policy: Pick<SendPolicy, 'sendWindow' | 'timezone' | 'weekendEnabled'>,
): { open: boolean; detail: string; weekend: boolean } {
  const clock = localClock(now, policy.timezone);
  const weekend = clock.weekday === 0 || clock.weekday === 6;
  const window = parseWindow(policy.sendWindow);
  if (!window) return { open: false, detail: `fenêtre illisible « ${policy.sendWindow} »`, weekend };
  if (weekend && !policy.weekendEnabled) {
    return { open: false, detail: `week-end (${clock.label}) : envoi désactivé`, weekend };
  }
  const open = clock.minutes >= window.start && clock.minutes < window.end;
  return {
    open,
    weekend,
    detail: open
      ? `${clock.label} dans ${policy.sendWindow}`
      : `${clock.label} hors de ${policy.sendWindow}`,
  };
}

/**
 * La politique d'envoi, évaluée avant `evaluateSendGate` et indépendamment de
 * lui. Chaque blocage est nommé et tous sont rendus : un opérateur qui lit
 * « OUTBOUND_DISABLED, OUTSIDE_SEND_WINDOW » sait exactement quoi changer, et
 * quoi ne pas changer.
 */
export function evaluateSendPolicy(policy: SendPolicy, state: SendPolicyState): SendPolicyVerdict {
  const blocks: SendPolicyVerdict['blocks'] = [];
  const block = (reason: PolicyBlockReason, detail: string) => blocks.push({ reason, detail });

  if (!state.outboundEnabled) block('OUTBOUND_DISABLED', 'ATLAS_OUTBOUND_ENABLED est faux : aucun envoi réel');
  if (state.engineMode !== 'PRODUCTION') {
    block('INTERNAL_TEST_MODE', `mode ${state.engineMode} : un vrai prospect n'est jamais contacté`);
  }
  if (state.globalPause.paused) block('GLOBAL_PAUSE', `pause générale${state.globalPause.reason ? ` — ${state.globalPause.reason}` : ''}`);
  if (!state.transportConfigured) block('TRANSPORT_UNAVAILABLE', "l'expéditeur n'a pas la portée d'envoi");

  if (!state.campaign) block('CAMPAIGN_NOT_APPROVED', 'aucune campagne rattachée : une approbation explicite est exigée');
  else {
    if (!state.campaign.approvedForSend) block('CAMPAIGN_NOT_APPROVED', 'campagne non approuvée pour l’envoi (APPROVED_FOR_SEND)');
    if (!['TESTING', 'VALIDATED', 'SCALE'].includes(state.campaign.status)) {
      block('CAMPAIGN_NOT_ACTIVE', `campagne ${state.campaign.status}`);
    }
  }

  if (state.suppressed.suppressed) block('SUPPRESSED', state.suppressed.detail ?? 'liste de suppression');
  if (state.replyReceived) block('REPLY_RECEIVED', 'une réponse est arrivée : plus aucun message automatique');
  if (state.purpose === 'FOLLOW_UP' && state.followUpsSent >= policy.maxFollowUps) {
    block('MAX_FOLLOWUPS_REACHED', `${state.followUpsSent} relance(s) déjà partie(s), maximum ${policy.maxFollowUps}`);
  }

  if (state.sentToday >= policy.dailyCapPerMailbox) {
    block('DAILY_CAP_REACHED', `${state.sentToday}/${policy.dailyCapPerMailbox} aujourd'hui`);
  }
  if (state.sentThisHour >= policy.hourlyCap) {
    block('HOURLY_CAP_REACHED', `${state.sentThisHour}/${policy.hourlyCap} cette heure`);
  }
  if (state.lastSentAt) {
    const elapsed = (state.now.getTime() - Date.parse(state.lastSentAt)) / 1000;
    if (elapsed < policy.minDelaySeconds) {
      block('MIN_DELAY_NOT_ELAPSED', `${Math.round(elapsed)} s depuis le dernier envoi, minimum ${policy.minDelaySeconds} s`);
    }
  }

  const window = isWithinSendWindow(state.now, policy);
  if (!window.open) block(window.weekend && !policy.weekendEnabled ? 'WEEKEND' : 'OUTSIDE_SEND_WINDOW', window.detail);

  const alarm = deliverabilityAlarm(state.bounces, { rate: policy.bouncePauseRate, minSample: policy.bounceMinSample });
  if (alarm.alarm) block('BOUNCE_RATE_TOO_HIGH', alarm.reason);

  return { allowed: blocks.length === 0, blocks, window: { open: window.open, detail: window.detail } };
}

// ─── Délivrabilité (§69–70) ─────────────────────────────────────────────────

export function deliverabilityAlarm(
  counts: { sent: number; bounced: number },
  threshold: { rate: number; minSample: number },
): { alarm: boolean; rate: number | null; reason: string } {
  if (counts.sent < threshold.minSample) {
    return {
      alarm: false,
      rate: counts.sent > 0 ? counts.bounced / counts.sent : null,
      reason: `${counts.sent} envoi(s) : échantillon sous ${threshold.minSample}, pas de verdict`,
    };
  }
  const rate = counts.bounced / counts.sent;
  if (rate >= threshold.rate) {
    return {
      alarm: true,
      rate,
      reason: `${counts.bounced}/${counts.sent} rebonds (${(rate * 100).toFixed(1)} %) ≥ ${(threshold.rate * 100).toFixed(1)} %`,
    };
  }
  return { alarm: false, rate, reason: `${(rate * 100).toFixed(1)} % de rebonds sous le seuil` };
}

// ─── Variantes (§11) ────────────────────────────────────────────────────────

/** FNV-1a 32 bits : stable d'une exécution à l'autre, sans dépendance. */
export function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * La variante d'une entreprise, tirée une fois pour toutes de sa clé. Même
 * clé, mêmes poids : même variante — un message préparé deux fois ne change
 * pas de version entre-temps.
 */
export function chooseVariant(key: string, variants: ReadonlyArray<{ key: string; weight: number }>): string | null {
  const live = variants.filter((v) => v.weight > 0);
  if (live.length === 0) return null;
  const total = live.reduce((sum, v) => sum + v.weight, 0);
  const point = (stableHash(key) % 10_000) / 10_000 * total;
  let cursor = 0;
  for (const variant of live) {
    cursor += variant.weight;
    if (point < cursor) return variant.key;
  }
  return live[live.length - 1]!.key;
}

// ─── Entonnoir et indicateurs (§19–25, §57–63) ───────────────────────────────

export interface SalesFunnelCounts {
  discovered: number;
  icpQualified: number;
  contactsFound: number;
  contacted: number;
  replied: number;
  positiveReplies: number;
  meetings: number;
  clients: number;
  revenueWon: number;
  spendUsd: number | null;
}

export interface SalesFunnelRates {
  qualifiedRate: number | null;
  contactFoundRate: number | null;
  contactedRate: number | null;
  replyRate: number | null;
  positiveReplyRate: number | null;
  meetingPerContact: number | null;
  clientPerContact: number | null;
  revenuePer100: number | null;
  cac: number | null;
}

const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

export const revenuePer100 = (revenue: number, contacted: number): number | null =>
  contacted > 0 ? (revenue / contacted) * 100 : null;

/** Coût d'acquisition : dépense / clients. Sans client, pas de CAC — « — ». */
export const cac = (spendUsd: number | null, clients: number): number | null =>
  spendUsd === null || clients <= 0 ? null : spendUsd / clients;

export function funnelRates(f: SalesFunnelCounts): SalesFunnelRates {
  return {
    qualifiedRate: ratio(f.icpQualified, f.discovered),
    contactFoundRate: ratio(f.contactsFound, f.icpQualified),
    contactedRate: ratio(f.contacted, f.contactsFound),
    replyRate: ratio(f.replied, f.contacted),
    positiveReplyRate: ratio(f.positiveReplies, f.contacted),
    meetingPerContact: ratio(f.meetings, f.contacted),
    clientPerContact: ratio(f.clients, f.contacted),
    revenuePer100: revenuePer100(f.revenueWon, f.contacted),
    cac: cac(f.spendUsd, f.clients),
  };
}

/**
 * Le pipeline potentiel, expliqué. Il n'existe que si l'on connaît une valeur
 * moyenne de contrat et un taux rendez-vous → client observés ; sinon la
 * valeur est nulle et l'explication dit pourquoi. Rien n'est extrapolé d'un
 * chiffre qu'on n'a pas.
 */
export function pipelinePotential(input: {
  openMeetings: number;
  hotLeads: number;
  averageDealValue: number | null;
  meetingToClientRate: number | null;
  leadToMeetingRate: number | null;
}): { value: number | null; explanation: string[] } {
  const explanation: string[] = [];
  if (input.averageDealValue === null) {
    explanation.push('aucun client gagné avec montant : valeur moyenne inconnue');
    return { value: null, explanation };
  }
  let value = 0;
  if (input.meetingToClientRate !== null) {
    const fromMeetings = input.openMeetings * input.meetingToClientRate * input.averageDealValue;
    value += fromMeetings;
    explanation.push(`${input.openMeetings} rendez-vous × ${(input.meetingToClientRate * 100).toFixed(0)} % × ${input.averageDealValue.toFixed(0)} = ${fromMeetings.toFixed(0)}`);
  } else explanation.push('taux rendez-vous → client inconnu : rendez-vous non valorisés');
  if (input.leadToMeetingRate !== null && input.meetingToClientRate !== null) {
    const fromLeads = input.hotLeads * input.leadToMeetingRate * input.meetingToClientRate * input.averageDealValue;
    value += fromLeads;
    explanation.push(`${input.hotLeads} réponses chaudes × ${(input.leadToMeetingRate * 100).toFixed(0)} % × ${(input.meetingToClientRate * 100).toFixed(0)} % × ${input.averageDealValue.toFixed(0)} = ${fromLeads.toFixed(0)}`);
  } else explanation.push('taux réponse → rendez-vous inconnu : réponses chaudes non valorisées');
  return { value: Math.round(value), explanation };
}

// ─── Vie d'un segment (§3–4) ────────────────────────────────────────────────

export interface SegmentStats {
  contacted: number;
  replied: number;
  positive: number;
  meetings: number;
  clients: number;
  revenue: number;
}

export interface SegmentThresholds {
  /** Taille du test avant toute conclusion (50–100). */
  testSize: number;
  /** En dessous, le segment est réduit après le test. */
  minPositiveRate: number;
  /** Au-dessus, le segment mérite d'être élargi. */
  scalePositiveRate: number;
}

export const DEFAULT_SEGMENT_THRESHOLDS: SegmentThresholds = {
  testSize: 50, minPositiveRate: 0.03, scalePositiveRate: 0.06,
};

export type SegmentAction = 'INSUFFICIENT_DATA' | 'CONTINUE_TEST' | 'VALIDATE' | 'SCALE' | 'REDUCE' | 'HOLD';

export function segmentDecision(
  status: string,
  stats: SegmentStats,
  thresholds: SegmentThresholds = DEFAULT_SEGMENT_THRESHOLDS,
): { action: SegmentAction; reason: string; positiveRate: number | null } {
  const positiveRate = ratio(stats.positive, stats.contacted);
  if (status === 'PAUSED' || status === 'STOPPED') return { action: 'HOLD', reason: `segment ${status}`, positiveRate };
  if (stats.contacted < thresholds.testSize) {
    return {
      action: stats.contacted === 0 ? 'INSUFFICIENT_DATA' : 'CONTINUE_TEST',
      reason: `${stats.contacted}/${thresholds.testSize} contactés : le test n'est pas fini`,
      positiveRate,
    };
  }
  if (positiveRate !== null && positiveRate >= thresholds.scalePositiveRate) {
    return {
      action: status === 'SCALE' ? 'HOLD' : 'SCALE',
      reason: `${(positiveRate * 100).toFixed(1)} % de réponses positives sur ${stats.contacted} ≥ ${(thresholds.scalePositiveRate * 100).toFixed(0)} %`,
      positiveRate,
    };
  }
  if (positiveRate !== null && positiveRate >= thresholds.minPositiveRate) {
    return {
      action: status === 'TESTING' ? 'VALIDATE' : 'HOLD',
      reason: `${(positiveRate * 100).toFixed(1)} % de réponses positives : segment viable, pas encore à élargir`,
      positiveRate,
    };
  }
  if (stats.meetings > 0 || stats.clients > 0) {
    return { action: 'HOLD', reason: 'peu de réponses mais des rendez-vous ou clients : on garde', positiveRate };
  }
  return {
    action: 'REDUCE',
    reason: `${((positiveRate ?? 0) * 100).toFixed(1)} % de réponses positives sur ${stats.contacted} < ${(thresholds.minPositiveRate * 100).toFixed(0)} %, sans rendez-vous`,
    positiveRate,
  };
}

// ─── Comparaison de variantes (§11, §29) ────────────────────────────────────

export interface VariantStats {
  key: string;
  contacted: number;
  replied: number;
  positive: number;
  meetings: number;
  clients: number;
  revenue: number;
}

/**
 * Deux proportions comparées : différence, écart réduit, et verdict. Le seuil
 * de confiance est volontairement modeste (z ≥ 1.64, unilatéral à 95 %) :
 * on ne prouve pas un théorème, on décide où mettre le prochain message.
 */
export function compareVariants(
  a: VariantStats,
  b: VariantStats,
  minSample = 40,
): { lift: number | null; z: number | null; confident: boolean; reason: string } {
  if (a.contacted < minSample || b.contacted < minSample) {
    return {
      lift: null, z: null, confident: false,
      reason: `INSUFFICIENT_DATA : ${a.key} ${a.contacted}, ${b.key} ${b.contacted}, minimum ${minSample} chacun`,
    };
  }
  const pa = a.positive / a.contacted;
  const pb = b.positive / b.contacted;
  const pooled = (a.positive + b.positive) / (a.contacted + b.contacted);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.contacted + 1 / b.contacted));
  const z = se === 0 ? 0 : (pa - pb) / se;
  const lift = pb === 0 ? (pa > 0 ? Infinity : 0) : (pa - pb) / pb;
  const confident = Math.abs(z) >= 1.64;
  return {
    lift: Number.isFinite(lift) ? lift : null,
    z,
    confident,
    reason: confident
      ? `${a.key} ${(pa * 100).toFixed(1)} % vs ${b.key} ${(pb * 100).toFixed(1)} % (z = ${z.toFixed(2)})`
      : `écart non concluant : ${(pa * 100).toFixed(1)} % vs ${(pb * 100).toFixed(1)} % (z = ${z.toFixed(2)})`,
  };
}

// ─── Recommandations (§26–36) ───────────────────────────────────────────────

export type RecommendationKind =
  | 'SCALE_SEGMENT' | 'REDUCE_SEGMENT' | 'TEST_NEW_MESSAGE' | 'PROMOTE_MESSAGE' | 'TEST_PERSONA'
  | 'CHANGE_ANGLE' | 'IMPROVE_CONTACT_SOURCE' | 'CHANGE_FOLLOWUP' | 'ENGINEERING_INSIGHT';

export interface RecommendationDraft {
  kind: RecommendationKind;
  title: string;
  reason: string;
  evidence: Record<string, unknown>;
  sampleSize: number;
  expectedImpact: string;
  risk: 'low' | 'medium' | 'high';
  /** Ce que VALIDER appliquerait, borné à un paramètre commercial. Null pour un insight. */
  change: StrategyChange | null;
  humanRequired: boolean;
  fingerprint: string;
}

export interface InsufficientData {
  subject: string;
  sample: number;
  needed: number;
}

export interface RecommendInput {
  segments: Array<{ id: string; name: string; status: string; explorationWeight: number; stats: SegmentStats }>;
  variants: Array<{ dimension: string; stats: VariantStats[] }>;
  followUps: { sent: number; replied: number } | null;
  frictions: Record<string, number>;
  discovered: number;
  contacted: number;
  thresholds?: Partial<SegmentThresholds> & { minSample?: number; minVariantSample?: number };
}

export function recommend(input: RecommendInput): { recommendations: RecommendationDraft[]; insufficient: InsufficientData[] } {
  const thresholds: SegmentThresholds = { ...DEFAULT_SEGMENT_THRESHOLDS, ...input.thresholds };
  const minSample = input.thresholds?.minSample ?? thresholds.testSize;
  const minVariantSample = input.thresholds?.minVariantSample ?? 40;
  const recommendations: RecommendationDraft[] = [];
  const insufficient: InsufficientData[] = [];

  for (const segment of input.segments) {
    const decision = segmentDecision(segment.status, segment.stats, { ...thresholds, testSize: minSample });
    if (decision.action === 'INSUFFICIENT_DATA' || decision.action === 'CONTINUE_TEST') {
      insufficient.push({ subject: `segment ${segment.name}`, sample: segment.stats.contacted, needed: minSample });
      continue;
    }
    if (decision.action === 'SCALE') {
      recommendations.push({
        kind: 'SCALE_SEGMENT',
        title: `Élargir le segment ${segment.name}`,
        reason: decision.reason,
        evidence: { segmentId: segment.id, ...segment.stats, positiveRate: decision.positiveRate },
        sampleSize: segment.stats.contacted,
        expectedImpact: 'plus de réponses positives par 100 contacts au même coût unitaire',
        risk: 'medium',
        change: { param: 'segmentWeights', key: segment.id, delta: +0.25 },
        // Une hausse de volume est toujours une décision humaine (§75).
        humanRequired: true,
        fingerprint: `SCALE_SEGMENT:${segment.id}`,
      });
    } else if (decision.action === 'REDUCE') {
      recommendations.push({
        kind: 'REDUCE_SEGMENT',
        title: `Réduire le segment ${segment.name}`,
        reason: decision.reason,
        evidence: { segmentId: segment.id, ...segment.stats, positiveRate: decision.positiveRate },
        sampleSize: segment.stats.contacted,
        expectedImpact: 'moins de messages sans réponse ; budget réorienté',
        risk: 'low',
        change: { param: 'segmentWeights', key: segment.id, delta: -0.25 },
        humanRequired: true,
        fingerprint: `REDUCE_SEGMENT:${segment.id}`,
      });
    }
  }

  for (const group of input.variants) {
    const ranked = [...group.stats].sort((a, b) => ratio(b.positive, b.contacted)! - ratio(a.positive, a.contacted)!);
    const eligible = ranked.filter((v) => v.contacted >= minVariantSample);
    for (const v of ranked.filter((v) => v.contacted < minVariantSample)) {
      insufficient.push({ subject: `${group.dimension} ${v.key}`, sample: v.contacted, needed: minVariantSample });
    }
    if (eligible.length >= 2) {
      const [best, second] = [eligible[0]!, eligible[1]!];
      const comparison = compareVariants(best, second, minVariantSample);
      if (comparison.confident && (comparison.lift ?? 0) > 0) {
        recommendations.push({
          kind: 'PROMOTE_MESSAGE',
          title: `Donner plus de place à la variante ${best.key} (${group.dimension})`,
          reason: comparison.reason,
          evidence: { dimension: group.dimension, best, second, lift: comparison.lift, z: comparison.z },
          sampleSize: best.contacted + second.contacted,
          expectedImpact: `+${((comparison.lift ?? 0) * 100).toFixed(0)} % de réponses positives sur ce volume`,
          risk: 'low',
          change: { param: 'messageAllocation', key: best.key, delta: +0.2 },
          humanRequired: true,
          fingerprint: `PROMOTE_MESSAGE:${group.dimension}:${best.key}`,
        });
      }
      const allLow = eligible.every((v) => (ratio(v.positive, v.contacted) ?? 0) < thresholds.minPositiveRate);
      if (allLow) {
        recommendations.push({
          kind: 'TEST_NEW_MESSAGE',
          title: `Tester un nouveau message (${group.dimension})`,
          reason: `toutes les variantes sous ${(thresholds.minPositiveRate * 100).toFixed(0)} % de réponses positives sur ${eligible.reduce((s, v) => s + v.contacted, 0)} contacts`,
          evidence: { dimension: group.dimension, variants: eligible },
          sampleSize: eligible.reduce((s, v) => s + v.contacted, 0),
          expectedImpact: 'une variante neuve, allouée à 20 %, pour sortir du plateau',
          risk: 'medium',
          change: null,
          humanRequired: true,
          fingerprint: `TEST_NEW_MESSAGE:${group.dimension}`,
        });
      }
    }
  }

  if (input.followUps && input.followUps.sent >= minVariantSample && input.followUps.replied === 0) {
    recommendations.push({
      kind: 'CHANGE_FOLLOWUP',
      title: 'Revoir la relance',
      reason: `${input.followUps.sent} relances, aucune réponse`,
      evidence: { ...input.followUps },
      sampleSize: input.followUps.sent,
      expectedImpact: 'une relance qui apporte un fait nouveau plutôt qu’un rappel',
      risk: 'low',
      change: null,
      humanRequired: true,
      fingerprint: 'CHANGE_FOLLOWUP',
    });
  }

  const contactNotFound = input.frictions.CONTACT_NOT_FOUND ?? 0;
  if (input.discovered >= minSample && contactNotFound / Math.max(1, input.discovered) >= 0.4) {
    recommendations.push({
      kind: 'IMPROVE_CONTACT_SOURCE',
      title: 'Améliorer la source de contacts',
      reason: `${contactNotFound} entreprises sans canal écrit sur ${input.discovered} découvertes (${((contactNotFound / input.discovered) * 100).toFixed(0)} %)`,
      evidence: { contactNotFound, discovered: input.discovered },
      sampleSize: input.discovered,
      expectedImpact: 'plus de qualifiés convertis en contactés, sans découvrir davantage',
      risk: 'low',
      change: null,
      humanRequired: true,
      fingerprint: 'IMPROVE_CONTACT_SOURCE',
    });
  }

  for (const insight of engineeringInsights(input.frictions, { discovered: input.discovered, contacted: input.contacted })) {
    recommendations.push({
      kind: 'ENGINEERING_INSIGHT',
      title: insight.title,
      reason: insight.detail,
      evidence: insight.evidence,
      sampleSize: insight.count,
      expectedImpact: 'moins de friction dans le pipeline ; aucun changement automatique de code',
      risk: 'low',
      change: null,
      humanRequired: true,
      fingerprint: `ENGINEERING_INSIGHT:${insight.fingerprint}`,
    });
  }

  return { recommendations, insufficient };
}

// ─── Insights d'ingénierie (§35, §78) ────────────────────────────────────────

export interface InsightDraft {
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
  fingerprint: string;
  count: number;
}

const FRICTION_INSIGHTS: Record<string, { title: string; detail: (n: number, ctx: { discovered: number; contacted: number }) => string; minCount: number }> = {
  SEARCH_FAILURE: {
    title: 'Le moteur de recherche échoue trop souvent',
    detail: (n) => `${n} échecs de recherche sur la période : vérifier SearXNG, ses moteurs et ses délais`,
    minCount: 5,
  },
  LLM_FAILURE: {
    title: 'Le modèle échoue ou dépasse ses bornes',
    detail: (n) => `${n} appels de modèle en échec : sortie inexploitable, délai ou quota`,
    minCount: 3,
  },
  COUNTRY_UNCERTAIN: {
    title: 'Le pays reste incertain trop souvent',
    detail: (n, ctx) => `${n} entreprises sans preuve de pays sur ${ctx.discovered} découvertes : enrichir les indices d'adresse`,
    minCount: 10,
  },
  LOW_SIGNAL: {
    title: 'Peu de signaux d’achat trouvés',
    detail: (n, ctx) => `${n} entreprises sans signal commercial exploitable sur ${ctx.discovered} découvertes`,
    minCount: 10,
  },
  SEND_BLOCKED: {
    title: 'Des envois approuvés restent bloqués',
    detail: (n) => `${n} tentatives d'envoi bloquées par la politique : lire les motifs dans les frictions`,
    minCount: 10,
  },
  DISCOVERY_UNAVAILABLE: {
    title: 'La découverte automatique ne peut pas tourner',
    detail: (n) => `${n} cycles de découverte sautés : source, tsx ou budget absents sur ce serveur`,
    minCount: 3,
  },
  GMAIL_UNAVAILABLE: {
    title: 'La boîte Gmail n’est pas lisible',
    detail: (n) => `${n} synchronisations impossibles : jeton, portée ou réseau`,
    minCount: 3,
  },
};

export function engineeringInsights(
  frictions: Record<string, number>,
  context: { discovered: number; contacted: number },
): InsightDraft[] {
  const drafts: InsightDraft[] = [];
  for (const [kind, count] of Object.entries(frictions)) {
    const rule = FRICTION_INSIGHTS[kind];
    if (!rule || count < rule.minCount) continue;
    drafts.push({
      title: rule.title,
      detail: rule.detail(count, context),
      evidence: { kind, count, ...context },
      fingerprint: kind,
      count,
    });
  }
  return drafts.sort((a, b) => b.count - a.count);
}

// ─── Stratégie commerciale versionnée (§31–33, §75–77) ───────────────────────

export const STRATEGY_PARAMS = ['segmentWeights', 'messageAllocation', 'personaPriority', 'angleWeights'] as const;
export type StrategyParam = (typeof STRATEGY_PARAMS)[number];

export interface Strategy {
  segmentWeights: Record<string, number>;
  messageAllocation: Record<string, number>;
  personaPriority: string[];
  angleWeights: Record<string, number>;
}

export const DEFAULT_STRATEGY: Strategy = {
  segmentWeights: {},
  messageAllocation: { A: 1 },
  personaPriority: ['dirigeant', 'directeur commercial', 'responsable export', 'business development'],
  angleWeights: { 'prospects-qualifies': 1 },
};

export interface StrategyChange {
  param: StrategyParam;
  /** La clé touchée (segment, variante, angle). Absente pour `personaPriority`. */
  key?: string;
  /** Variation additive d'un poids, bornée par `maxStep`. */
  delta?: number;
  /** Valeur absolue (poids) ou ordre complet (personas). */
  value?: number | string[];
}

/** Le pas maximal d'un poids en une seule décision : jamais tout d'un coup. */
export const MAX_STRATEGY_STEP = 0.25;

/**
 * Applique un changement à la stratégie, ou explique pourquoi non. Seuls les
 * quatre paramètres commerciaux existent ; un poids ne bouge que d'un pas
 * borné et reste dans [0, 2] ; l'ordre des personas doit rester une
 * permutation de l'existant plus, au plus, un ajout.
 */
export function applyStrategyChange(
  strategy: Strategy,
  change: StrategyChange,
  options: { maxStep?: number } = {},
): { next: Strategy; applied: boolean; reason: string } {
  const maxStep = options.maxStep ?? MAX_STRATEGY_STEP;
  if (!STRATEGY_PARAMS.includes(change.param)) {
    return { next: strategy, applied: false, reason: `paramètre hors périmètre : ${String(change.param)}` };
  }
  const next: Strategy = {
    segmentWeights: { ...strategy.segmentWeights },
    messageAllocation: { ...strategy.messageAllocation },
    personaPriority: [...strategy.personaPriority],
    angleWeights: { ...strategy.angleWeights },
  };

  if (change.param === 'personaPriority') {
    if (!Array.isArray(change.value)) return { next: strategy, applied: false, reason: 'un ordre de personas est attendu' };
    const added = change.value.filter((p) => !strategy.personaPriority.includes(p));
    if (added.length > 1) return { next: strategy, applied: false, reason: `au plus un persona nouveau par décision (${added.length} proposés)` };
    next.personaPriority = [...change.value];
    return { next, applied: true, reason: `ordre des personas : ${next.personaPriority.join(' > ')}` };
  }

  if (!change.key) return { next: strategy, applied: false, reason: `une clé est requise pour ${change.param}` };
  const table = next[change.param];
  const current = table[change.key] ?? (change.param === 'segmentWeights' ? 1 : 0);
  let target: number;
  if (typeof change.delta === 'number') {
    if (Math.abs(change.delta) > maxStep) {
      return { next: strategy, applied: false, reason: `pas ${change.delta} au-delà du maximum ${maxStep}` };
    }
    target = current + change.delta;
  } else if (typeof change.value === 'number') {
    if (Math.abs(change.value - current) > maxStep) {
      return { next: strategy, applied: false, reason: `${current} → ${change.value} dépasse le pas maximal ${maxStep}` };
    }
    target = change.value;
  } else return { next: strategy, applied: false, reason: 'ni delta ni valeur' };

  target = Math.min(2, Math.max(0, Number(target.toFixed(4))));
  table[change.key] = target;
  return { next, applied: true, reason: `${change.param}.${change.key} : ${current} → ${target}` };
}

/**
 * Ce qu'ATLAS n'a jamais le droit de décider seul (§75). Tout ce qui n'est pas
 * un ajustement fin d'un poids existant appelle une personne ; et même
 * l'ajustement fin ne s'applique seul que si `autoApplyTiny` est levé, ce qui
 * est faux par défaut (§77).
 */
export function requiresHumanApproval(
  change: StrategyChange,
  strategy: Strategy,
  options: { autoApplyTiny: boolean; tinyStep?: number } = { autoApplyTiny: false },
): { required: boolean; reason: string } {
  if (!options.autoApplyTiny) return { required: true, reason: 'les changements automatiques sont désactivés' };
  if (change.param === 'personaPriority') return { required: true, reason: 'un ordre de personas est une décision commerciale' };
  if (!change.key || !(change.key in strategy[change.param])) {
    return { required: true, reason: 'nouvelle clé : nouveau segment, message ou angle' };
  }
  const tiny = options.tinyStep ?? 0.1;
  const magnitude = typeof change.delta === 'number'
    ? Math.abs(change.delta)
    : typeof change.value === 'number' ? Math.abs(change.value - (strategy[change.param][change.key] ?? 0)) : Infinity;
  if (magnitude > tiny) return { required: true, reason: `variation ${magnitude} au-delà du pas fin ${tiny}` };
  return { required: false, reason: `ajustement fin de ${magnitude} sur une clé existante` };
}

// ─── Planification (§37–41) ─────────────────────────────────────────────────

/**
 * La clé d'une occurrence planifiée : le même travail, dans la même fenêtre,
 * porte la même clé — un planificateur qui repasse ne le crée pas deux fois.
 */
export function periodKey(kind: string, now: Date, everyMinutes: number): string {
  const bucket = Math.floor(now.getTime() / (everyMinutes * 60_000));
  return `sales:${kind}:${everyMinutes}m:${bucket}`;
}
