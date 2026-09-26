/**
 * Ce que le fondateur lit, à la place de ce que la base stocke.
 *
 * Les valeurs internes (RECOMMENDATIONS_BELOW_2, READY_FOR_APPROVAL,
 * SOURCED_FACTS_0/2…) ne changent pas : elles restent la vérité des dépôts et
 * des tests. Ce module ne fait que les traduire pour l'écran. Une valeur
 * inconnue n'est jamais masquée : elle est rendue lisible (minuscules, sans
 * soulignés) plutôt qu'inventée.
 */

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

export interface Label {
  text: string;
  tone: Tone;
}

const humanize = (raw: string): string => {
  const t = raw.replace(/[_:]+/g, ' ').trim().toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

// ─── Paliers ────────────────────────────────────────────────────────────────

const TIERS: Record<string, Label> = {
  PRIORITY: { text: 'Prioritaire', tone: 'good' },
  GOOD_FIT: { text: 'Bon fit', tone: 'info' },
  WATCH: { text: 'À surveiller', tone: 'neutral' },
  REJECTED: { text: 'Écarté', tone: 'neutral' },
};

export function tierLabel(tier: string | null | undefined): Label {
  if (!tier) return { text: 'Non évalué', tone: 'neutral' };
  return TIERS[tier] ?? { text: humanize(tier), tone: 'neutral' };
}

// ─── États : fabrique, commerce, brouillons, réponses ──────────────────────

const STATES: Record<string, Label> = {
  // Fabrique (boucle A)
  HOT: { text: 'Prioritaire', tone: 'good' },
  WARM: { text: 'Qualifié', tone: 'info' },
  NEEDS_ENRICHMENT: { text: 'À enrichir', tone: 'warn' },
  DROP: { text: 'Écarté', tone: 'neutral' },
  DUPLICATE: { text: 'Doublon', tone: 'neutral' },
  BLOCKED: { text: 'Bloqué', tone: 'bad' },
  // État commercial (boucle B)
  NONE: { text: 'Pas encore contacté', tone: 'neutral' },
  READY: { text: 'À approuver', tone: 'warn' },
  QUEUED: { text: 'En file d’envoi', tone: 'info' },
  PAUSED: { text: 'En pause', tone: 'warn' },
  SENT: { text: 'Envoyé', tone: 'info' },
  DELIVERED: { text: 'Délivré', tone: 'info' },
  FAILED: { text: 'Échec d’envoi', tone: 'bad' },
  BOUNCED: { text: 'Adresse en échec', tone: 'bad' },
  REPLIED: { text: 'A répondu', tone: 'good' },
  POSITIVE_REPLY: { text: 'Réponse positive', tone: 'good' },
  NEGATIVE_REPLY: { text: 'Réponse négative', tone: 'neutral' },
  MEETING: { text: 'Rendez-vous', tone: 'good' },
  PROPOSAL: { text: 'Proposition envoyée', tone: 'good' },
  WON: { text: 'Client gagné', tone: 'good' },
  LOST: { text: 'Perdu', tone: 'neutral' },
  SUPPRESSED: { text: 'Ne plus contacter', tone: 'neutral' },
  // Brouillons et registre
  READY_FOR_APPROVAL: { text: 'À approuver', tone: 'warn' },
  READY_FOR_REVIEW: { text: 'À relire', tone: 'warn' },
  APPROVED_TO_SEND: { text: 'Approuvé', tone: 'info' },
  ABANDONED: { text: 'Abandonné', tone: 'neutral' },
  // Prospects
  DISCOVERED: { text: 'Découvert', tone: 'neutral' },
  QUALIFIED: { text: 'Qualifié', tone: 'info' },
  APPROVED_TO_CONTACT: { text: 'Approuvé', tone: 'info' },
  CONTACTED: { text: 'Contacté', tone: 'info' },
  // Intentions de réponse
  POSITIVE: { text: 'Intéressé', tone: 'good' },
  INTERESTED_LATER: { text: 'Plus tard', tone: 'info' },
  QUESTION: { text: 'Question', tone: 'good' },
  NEUTRAL: { text: 'Réponse neutre', tone: 'neutral' },
  NEGATIVE: { text: 'Pas intéressé', tone: 'neutral' },
  NOT_RELEVANT: { text: 'Mauvais contact', tone: 'neutral' },
  OPT_OUT: { text: 'Désinscription', tone: 'neutral' },
  BOUNCE: { text: 'Rebond', tone: 'bad' },
  OUT_OF_OFFICE: { text: 'Absent', tone: 'neutral' },
};

export function stateLabel(state: string | null | undefined): Label {
  if (!state) return { text: '—', tone: 'neutral' };
  return STATES[state] ?? { text: humanize(state), tone: 'neutral' };
}

// ─── Blocages ───────────────────────────────────────────────────────────────

const BLOCKERS: Record<string, string> = {
  NO_OBSERVED_EMAIL: 'Adresse email à trouver',
  EMAIL_NOT_COMMERCIAL: 'Contact à vérifier',
  RECOMMENDATIONS_BELOW_2: 'Cibles à enrichir',
  IDENTITY_UNVERIFIED: 'Identité à confirmer',
  FETCH_FAILED: 'Site illisible pour l’instant',
  INSUFFICIENT_SIGNAL: 'Trop peu d’informations publiques',
  NO_WEBSITE: 'Site web inconnu',
  NO_DOMAIN: 'Domaine inconnu',
  ALREADY_CONTACTED: 'Déjà contacté',
  REPLY_RECEIVED: 'A déjà répondu',
  ALREADY_SENT: 'Message déjà envoyé',
  PRIOR_FIRST_TOUCH: 'Premier message déjà préparé',
  SUPPRESSED: 'Ne plus contacter',
  DO_NOT_CONTACT: 'Ne plus contacter',
  INVALIDATED: 'Dossier invalidé',
  TECHNICAL_DOMAIN: 'Entité technique',
  REJECTED_BY_QUALIFICATION: 'Hors cible',
  LOW_REVENUE_SCORE: 'Potentiel trop faible',
  FACTORY_NOT_ELIGIBLE: 'Pas encore prêt',
  NO_SOURCED_FACT: 'Aucun fait citable',
  NOT_GROUNDED: 'Personnalisation non vérifiée',
  INSUFFICIENT_RECOMMENDATIONS: 'Cibles à enrichir',
  NO_COMPANY: 'Nom d’entreprise manquant',
  // Porte qualité
  RECIPIENT_UNVERIFIED: 'Destinataire non vérifié',
  PROVENANCE_MISSING: 'Source manquante',
  NOT_PERSONALIZED: 'Message pas assez personnalisé',
  UNSUPPORTED_BUYING_INTENT: 'Affirmation non sourcée',
  PLACEHOLDER_LEFT: 'Modèle non rempli',
  BODY_TOO_SHORT: 'Message trop court',
  BODY_TOO_LONG: 'Message trop long',
  SUBJECT_INVALID: 'Objet invalide',
  // Politique d'envoi
  OUTBOUND_DISABLED: 'Envoi coupé',
  INTERNAL_TEST_MODE: 'Mode test',
  GLOBAL_PAUSE: 'Pause générale',
  CAMPAIGN_NOT_APPROVED: 'Campagne à approuver',
  CAMPAIGN_NOT_ACTIVE: 'Campagne inactive',
  DAILY_CAP_REACHED: 'Plafond du jour atteint',
  HOURLY_CAP_REACHED: 'Plafond horaire atteint',
  OUTSIDE_SEND_WINDOW: 'Hors fenêtre d’envoi',
  WEEKEND: 'Week-end',
  MIN_DELAY_NOT_ELAPSED: 'Délai entre envois',
  BOUNCE_RATE_TOO_HIGH: 'Trop de rebonds',
  TRANSPORT_UNAVAILABLE: 'Messagerie indisponible',
  MAX_FOLLOWUPS_REACHED: 'Relance déjà faite',
};

/** Un motif de blocage, en français. Les motifs paramétrés gardent leur chiffre. */
export function blockerLabel(raw: string): string {
  const facts = /^SOURCED_FACTS_(\d+)\/(\d+)$/.exec(raw);
  if (facts) return `Preuves à compléter (${facts[1]}/${facts[2]})`;
  if (raw.startsWith('QUALITY_GATE:')) return blockerLabel(raw.slice('QUALITY_GATE:'.length));
  if (raw.startsWith('DUPLICATE_OF:')) return `Doublon de ${raw.slice('DUPLICATE_OF:'.length)}`;
  if (raw.startsWith('NO_SIGNAL_AFTER_')) return 'Aucun signal après plusieurs passages';
  if (raw.startsWith('STATE_')) return `État : ${stateLabel(raw.slice(6)).text.toLowerCase()}`;
  if (raw.startsWith('LEDGER_')) return stateLabel(raw.slice(7)).text;
  if (raw.startsWith('CLAIM_REFUSED')) return 'Envoi déjà réservé';
  if (raw.startsWith('CONTACT')) return 'Contact à vérifier';
  return BLOCKERS[raw] ?? humanize(raw);
}

/** La même liste, sans doublons de sens (deux codes peuvent dire la même chose). */
export function blockerLabels(raws: readonly string[]): string[] {
  return [...new Set(raws.map(blockerLabel))];
}

// ─── Envoi, services, activité ──────────────────────────────────────────────

export function outboundLabel(mode: string): Label {
  if (mode === 'ACTIVE') return { text: 'Envoi actif', tone: 'good' };
  if (mode === 'INTERNAL_TEST') return { text: 'Envoi en test', tone: 'info' };
  return { text: 'Envoi coupé', tone: 'neutral' };
}

export function serviceTone(state: string): Tone {
  return state === 'ok' ? 'good' : state === 'warn' ? 'warn' : state === 'down' ? 'bad' : 'neutral';
}

export function serviceStateLabel(state: string): string {
  return state === 'ok' ? 'Opérationnel' : state === 'warn' ? 'À surveiller' : state === 'down' ? 'En panne' : 'Désactivé';
}

export function headlineLabel(status: string): Label {
  switch (status) {
    case 'ONLINE': return { text: 'En ligne', tone: 'good' };
    case 'DEGRADED': return { text: 'Dégradé', tone: 'warn' };
    case 'STALE': return { text: 'Données anciennes', tone: 'warn' };
    case 'DOWN': return { text: 'Hors ligne', tone: 'bad' };
    default: return { text: 'Connexion…', tone: 'neutral' };
  }
}

// ─── Formats ────────────────────────────────────────────────────────────────

/** « JD » pour « Jean Dupont SAS », « AC » pour « acme-corp.fr ». */
export function initials(name: string): string {
  const clean = name.replace(/\b(sas|sarl|sa|gmbh|ltd|inc|group|groupe)\b/gi, '').replace(/[^\p{L}\p{N}\s-]/gu, ' ').trim();
  const words = clean.split(/[\s-]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** Une teinte stable par nom, choisie parmi quelques teintes sobres. */
export function avatarHue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return [210, 190, 250, 160, 30, 340][h % 6]!;
}

/** « à l’instant », « il y a 3 min », « hier », « il y a 4 j ». */
export function since(iso: string | null | undefined, now: number): string {
  if (!iso) return 'jamais';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return '—';
  if (s < 45) return 'à l’instant';
  if (s < 3600) return `il y a ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86_400) return `il y a ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86_400);
  return d === 1 ? 'hier' : `il y a ${d} j`;
}

/** 1 284 · 12,9 k · 1,2 M — compact, en français. */
export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs < 10_000) return new Intl.NumberFormat('fr-FR').format(Math.round(n));
  if (abs < 1_000_000) return `${(n / 1000).toFixed(abs < 100_000 ? 1 : 0).replace('.', ',')} k`;
  return `${(n / 1_000_000).toFixed(1).replace('.', ',')} M`;
}

export function money(n: number | null | undefined, currency = 'EUR'): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
}

/** Les dollars d'IA gardent des centimes de centime ; une absence reste « — ». */
export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url.slice(0, 40); }
}

/** L'écart d'hier à aujourd'hui, en mots : « +3 vs hier », « = hier ». */
export function deltaVsYesterday(series: readonly number[]): { text: string; tone: Tone } | null {
  if (series.length < 2) return null;
  const today = series[series.length - 1]!;
  const yesterday = series[series.length - 2]!;
  const d = today - yesterday;
  if (today === 0 && yesterday === 0) return null;
  if (d === 0) return { text: '= hier', tone: 'neutral' };
  return { text: `${d > 0 ? '+' : '−'}${Math.abs(d)} vs hier`, tone: d > 0 ? 'good' : 'neutral' };
}

/** Un échec de lecture, dit au fondateur : jamais l'anglais brut du navigateur. */
export function errorLabel(raw: string | null | undefined): string {
  const m = (raw ?? '').trim();
  if (!m || /failed to fetch|networkerror|load failed|network request failed|err_/i.test(m)) return 'Serveur injoignable. Vérifiez la connexion, puis réessayez.';
  if (/\b401\b|unauthori[sz]ed|session/i.test(m)) return 'Session expirée. Reconnectez-vous.';
  if (/\b5\d\d\b|internal server error/i.test(m)) return 'Le serveur a rencontré une erreur. Réessayez dans un instant.';
  if (/timeout|timed out|délai/i.test(m)) return 'Le serveur met trop de temps à répondre.';
  return m;
}
