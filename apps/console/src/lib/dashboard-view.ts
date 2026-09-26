/**
 * Les règles d'affichage de la page d'accueil, sans React ni réseau.
 *
 * Tout ce qui décide d'un libellé, d'un état de fraîcheur ou d'une phrase
 * vit ici pour être vérifié par un test. La page ne fait qu'appeler.
 */

// ─── Fraîcheur et connexion ─────────────────────────────────────────────────

export type FreshnessState = 'fresh' | 'stale' | 'dead' | 'never';

export interface Freshness {
  state: FreshnessState;
  /** « À jour · il y a 4 s », « Données potentiellement obsolètes »… */
  label: string;
  ageSeconds: number | null;
}

/** Au-delà de quatre cycles de rafraîchissement manqués, les chiffres ne se lisent plus comme actuels. */
export const STALE_AFTER_MS = 45_000;
export const DEAD_AFTER_MS = 120_000;

/**
 * Ce que valent les chiffres à l'écran, d'après la dernière lecture réussie.
 * Une lecture qui échoue ne remet rien à zéro : la dernière valeur connue
 * reste, et son âge se voit.
 */
export function freshnessOf(lastOkAt: number | null, now: number, offline: boolean): Freshness {
  if (lastOkAt === null) return { state: 'never', label: 'Lecture en cours…', ageSeconds: null };
  const ageMs = Math.max(0, now - lastOkAt);
  const ageSeconds = Math.round(ageMs / 1000);
  if (ageMs >= DEAD_AFTER_MS) return { state: 'dead', label: `Données obsolètes — dernière lecture il y a ${relativeAge(ageSeconds)}`, ageSeconds };
  if (ageMs >= STALE_AFTER_MS || offline) {
    return { state: 'stale', label: `Données potentiellement obsolètes — il y a ${relativeAge(ageSeconds)}`, ageSeconds };
  }
  return { state: 'fresh', label: ageSeconds < 5 ? 'À jour' : `Mis à jour il y a ${ageSeconds} s`, ageSeconds };
}

export function relativeAge(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} j`;
}

/** « Il y a 23 min », « Il y a 3 j » — depuis un horodatage ISO. */
export function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return `Il y a ${relativeAge(seconds)}`;
}

/**
 * L'état affiché en tête de l'écran de téléphone.
 *
 * Le serveur ne sait dire que ONLINE ou DEGRADED : un serveur qui répond n'est
 * pas en panne. DOWN se constate ici — aucune lecture n'a jamais abouti malgré
 * des essais, ou la dernière réussite est trop ancienne. Entre les deux, des
 * chiffres encore affichés mais vieillis se disent STALE, jamais ONLINE.
 */
export type HeadlineStatus = 'LOADING' | 'ONLINE' | 'DEGRADED' | 'STALE' | 'DOWN';

export function headlineStatus(
  fresh: Freshness,
  failures: number,
  serverStatus: 'ONLINE' | 'DEGRADED' | null,
): HeadlineStatus {
  if (fresh.state === 'never') return failures > 0 ? 'DOWN' : 'LOADING';
  if (fresh.state === 'dead') return 'DOWN';
  if (fresh.state === 'stale') return 'STALE';
  return serverStatus ?? 'LOADING';
}

/**
 * La reprise après une coupure : la lecture suivante réussie remet la
 * fraîcheur à zéro. Pure : (état précédent, résultat) → nouvel état.
 */
export interface LiveState<T> {
  data: T | null;
  lastOkAt: number | null;
  failures: number;
  lastError: string | null;
}

export function applyResult<T>(state: LiveState<T>, result: { ok: true; data: T; at: number } | { ok: false; error: string }): LiveState<T> {
  if (result.ok) return { data: result.data, lastOkAt: result.at, failures: 0, lastError: null };
  // Échec : rien n'est perdu, la dernière valeur reste, l'échec se compte.
  return { ...state, failures: state.failures + 1, lastError: result.error };
}

// ─── Segments ───────────────────────────────────────────────────────────────

export const SEGMENT_STATE_LABEL: Record<string, string> = {
  TESTING: 'TEST', VALIDATED: 'VALIDÉ', SCALE: 'SCALE', PAUSED: 'PAUSE', STOPPED: 'ARRÊT',
};

/** Le résultat qui compte le plus, dans l'ordre : clients, RDV, réponses positives, contactés. */
export function mainResultOf(segment: { clients: number; meetings: number; positiveReplies: number; contacted: number }): string {
  if (segment.clients > 0) return `${segment.clients} client${segment.clients > 1 ? 's' : ''}`;
  if (segment.meetings > 0) return `${segment.meetings} RDV`;
  if (segment.positiveReplies > 0) return `${segment.positiveReplies} réponse${segment.positiveReplies > 1 ? 's' : ''} positive${segment.positiveReplies > 1 ? 's' : ''}`;
  if (segment.contacted > 0) return `${segment.contacted} contactée${segment.contacted > 1 ? 's' : ''}`;
  return 'aucun contact';
}

/** Les segments les plus parlants d'abord ; cinq au plus. */
export function rankSegments<T extends { clients: number; meetings: number; positiveReplies: number; contacted: number }>(segments: T[], limit = 5): T[] {
  return [...segments]
    .sort((a, b) => b.clients - a.clients || b.meetings - a.meetings || b.positiveReplies - a.positiveReplies || b.contacted - a.contacted)
    .slice(0, limit);
}

// ─── À faire ────────────────────────────────────────────────────────────────

export interface TodoLine {
  key: 'hotLeads' | 'approvals' | 'followUps' | 'recommendations' | 'segmentsToApprove';
  count: number;
  label: string;
  href: string;
}

export function todoLines(todo: { hotLeads: number; approvals: number; followUps: number; recommendations: number; segmentsToApprove: number }): TodoLine[] {
  const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);
  const lines: TodoLine[] = [
    { key: 'hotLeads', count: todo.hotLeads, label: `${todo.hotLeads} ${plural(todo.hotLeads, 'réponse à traiter', 'réponses à traiter')}`, href: '#hot-leads' },
    { key: 'approvals', count: todo.approvals, label: `${todo.approvals} ${plural(todo.approvals, 'prospect à vérifier', 'prospects à vérifier')}`, href: '/cc/approvals' },
    { key: 'followUps', count: todo.followUps, label: `${todo.followUps} ${plural(todo.followUps, 'relance à préparer', 'relances à préparer')}`, href: '/cc/follow-ups' },
    { key: 'recommendations', count: todo.recommendations, label: `${todo.recommendations} ${plural(todo.recommendations, 'recommandation ATLAS', 'recommandations ATLAS')}`, href: '#improvement' },
    { key: 'segmentsToApprove', count: todo.segmentsToApprove, label: `${todo.segmentsToApprove} ${plural(todo.segmentsToApprove, 'campagne à approuver', 'campagnes à approuver')}`, href: '#segments' },
  ];
  return lines.filter((l) => l.count > 0);
}

// ─── Recommandation, en langage humain ──────────────────────────────────────

export interface HumanRecommendation {
  eyebrow: string;
  headline: string;
  question: string;
  yes: string;
  no: string;
  /** Ce que « oui » fait réellement : un test borné, ou une décision consignée. */
  yesDecision: 'test' | 'approve';
}

const pct = (n: unknown): string => (typeof n === 'number' ? `${(n * 100).toFixed(1).replace(/\.0$/, '')} %` : '—');

export function describeRecommendation(r: {
  kind: string;
  title: string;
  reason: string;
  evidence?: Record<string, unknown>;
  hasChange: boolean;
}): HumanRecommendation {
  const e = r.evidence ?? {};
  const name = typeof e.name === 'string' ? e.name : r.title.replace(/^(Élargir|Réduire) le segment /, '');
  switch (r.kind) {
    case 'SCALE_SEGMENT':
      return {
        eyebrow: 'ATLAS a repéré une opportunité',
        headline: `Le segment ${name} répond mieux que les autres (${pct(e.positiveRate)} de réponses positives sur ${String(e.contacted ?? '?')} contacts).`,
        question: 'Augmenter progressivement sa priorité ?',
        yes: 'Oui, tester', no: 'Pas maintenant', yesDecision: 'test',
      };
    case 'REDUCE_SEGMENT':
      return {
        eyebrow: 'ATLAS propose un ajustement',
        headline: `Le segment ${name} ne répond presque pas (${pct(e.positiveRate)} sur ${String(e.contacted ?? '?')} contacts, sans rendez-vous).`,
        question: 'Réduire progressivement sa part ?',
        yes: 'Oui, tester', no: 'Pas maintenant', yesDecision: 'test',
      };
    case 'PROMOTE_MESSAGE': {
      const best = e.best as { key?: string } | undefined;
      return {
        eyebrow: 'ATLAS a repéré une opportunité',
        headline: `Le message ${best?.key ?? ''} obtient plus de réponses positives que les autres.`,
        question: 'Lui donner plus de place ?',
        yes: 'Oui, tester', no: 'Pas maintenant', yesDecision: 'test',
      };
    }
    case 'TEST_NEW_MESSAGE':
      return {
        eyebrow: 'ATLAS propose un test',
        headline: 'Aucune variante de message ne dépasse le plancher de réponses positives.',
        question: 'Écrire une nouvelle variante et la tester sur 20 % des envois ?',
        yes: 'Oui, je m’en occupe', no: 'Pas maintenant', yesDecision: 'approve',
      };
    case 'CHANGE_FOLLOWUP':
      return {
        eyebrow: 'ATLAS propose un ajustement',
        headline: 'Les relances envoyées n’ont obtenu aucune réponse.',
        question: 'Revoir le texte de la relance ?',
        yes: 'Oui, je m’en occupe', no: 'Pas maintenant', yesDecision: 'approve',
      };
    case 'IMPROVE_CONTACT_SOURCE':
      return {
        eyebrow: 'ATLAS a repéré une friction',
        headline: 'Beaucoup d’entreprises qualifiées n’ont aucun canal écrit trouvé.',
        question: 'Améliorer la source de contacts avant de découvrir davantage ?',
        yes: 'Oui, je m’en occupe', no: 'Pas maintenant', yesDecision: 'approve',
      };
    default:
      return {
        eyebrow: 'ATLAS a une remarque',
        headline: r.title,
        question: r.reason,
        yes: r.hasChange ? 'Oui, tester' : 'Vu', no: 'Pas maintenant', yesDecision: r.hasChange ? 'test' : 'approve',
      };
  }
}

// ─── Système ────────────────────────────────────────────────────────────────

export function systemProblems(system: {
  search: { state: string; detail: string };
  llm: { state: string; detail: string };
  gmail: { state: string; detail: string };
  workers: { state: string; detail: string };
  outbound: { paused: boolean; pauseReason: string | null };
}): string[] {
  const problems: string[] = [];
  const names: Record<string, string> = { search: 'Recherche', gmail: 'Email', llm: 'IA', workers: 'Workers' };
  for (const key of ['search', 'gmail', 'llm', 'workers'] as const) {
    const light = system[key];
    if (light.state === 'warn' || light.state === 'down') problems.push(`${names[key]} : ${light.detail}`);
  }
  if (system.outbound.paused) problems.push(`Envois en pause${system.outbound.pauseReason ? ` — ${system.outbound.pauseReason}` : ''}`);
  return problems;
}

/**
 * Le verdict en une ligne : ce qui empêche un premier contact de partir.
 * Une lecture de l'état publié, rien de plus — un voyant éteint n'est pas
 * un blocage, un interrupteur fermé ou un mode d'essai l'est.
 */
export interface SystemVerdict {
  tone: 'ok' | 'warn' | 'bad';
  headline: string;
  blockers: string[];
}

export function systemVerdict(system: Parameters<typeof systemProblems>[0] & {
  outbound: { enabled: boolean; mode: string; paused: boolean; pauseReason: string | null };
}): SystemVerdict {
  const blockers = systemProblems(system);
  if (!system.outbound.enabled) blockers.push('Envoi sortant désactivé (interrupteur fermé)');
  if (system.outbound.mode !== 'PRODUCTION') blockers.push(`Mode ${system.outbound.mode} : aucun envoi réel`);
  const down = (['search', 'gmail', 'llm', 'workers'] as const).some((k) => system[k].state === 'down');
  if (down || system.outbound.paused || !system.outbound.enabled) {
    return { tone: 'bad', headline: 'Bloqué — aucun premier contact ne part', blockers };
  }
  if (blockers.length > 0) return { tone: 'warn', headline: 'En marche, avec des réserves', blockers };
  return { tone: 'ok', headline: 'En marche — rien ne bloque', blockers };
}

// ─── Opportunités ───────────────────────────────────────────────────────────

const TIER_LABEL: Record<string, string> = { PRIORITY: 'Priorité', GOOD_FIT: 'Bon profil', WATCH: 'À surveiller' };

/** Où en est le contact d'une opportunité : observé sur une page officielle, sinon à trouver. */
export function opportunitySummary(o: {
  tier: string | null;
  score: number | null;
  contact: { email: string | null; observed: boolean };
}): { tier: string; contact: string; ready: boolean } {
  const ready = Boolean(o.contact.email) && o.contact.observed;
  return {
    tier: o.tier ? `${TIER_LABEL[o.tier] ?? o.tier}${o.score !== null ? ` · ${o.score}` : ''}` : 'Non évalué',
    contact: ready ? `Email observé : ${o.contact.email}` : o.contact.email ? 'Email non vérifié' : 'Contact à trouver',
    ready,
  };
}
