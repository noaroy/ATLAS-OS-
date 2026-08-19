/**
 * Lire une réponse sans lui prêter d'intention.
 *
 * Après un envoi, trois choses arrivent : un rebond, une absence automatique,
 * ou quelqu'un qui écrit. Les deux premières se reconnaissent à des marqueurs
 * qui ne varient pas — `mailer-daemon`, un code 550, « je serai absent
 * jusqu'au ». Aucun modèle n'est nécessaire, et en appeler un reviendrait à
 * payer pour retrouver ce qu'un `if` établit.
 *
 * La troisième est le piège. Une réponse humaine dit rarement « je suis
 * intéressé » ; elle pose une question, renvoie vers un collègue, ou reste
 * polie et vide. Deviner l'intention derrière produit exactement le genre
 * d'erreur qui se paie plus tard, quand on relance quelqu'un qui avait dit
 * non. Le classement s'arrête donc à `REPLIED` : il constate qu'une personne
 * a écrit, et laisse un humain dire ce qu'elle voulait.
 *
 * Le doute a son propre verdict, `NEEDS_REVIEW`. Une classification qui ne
 * sait pas doit pouvoir le dire, sans quoi elle range dans la première case
 * venue et la boîte devient un inventaire de suppositions.
 */

export type InboundKind = 'EMAIL_REPLY' | 'AUTO_REPLY' | 'BOUNCE' | 'FORM_REPLY' | 'MANUAL_NOTE';

export type ReplyClassification =
  /** Le message n'est pas arrivé. */
  | 'BOUNCED'
  /** Une machine a répondu à la place de quelqu'un. */
  | 'AUTO_REPLY'
  /** Une personne a écrit. Ce qu'elle veut n'est pas décidé ici. */
  | 'REPLIED'
  /** Ni l'un ni l'autre avec certitude : à lire par un humain. */
  | 'NEEDS_REVIEW';

export interface ClassificationResult {
  classification: ReplyClassification;
  /** 0..1 — ce que valent les marqueurs trouvés. */
  confidence: number;
  /** Ce qui a déclenché le verdict, nommé. Un classement muet ne s'audite pas. */
  signals: string[];
  /**
   * La date de retour annoncée par une absence, quand elle est écrite en
   * clair. Jamais déduite d'un « bientôt » ou d'un « la semaine prochaine ».
   */
  returnDate: string | null;
  reason: string;
}

/** Un rebond se signe : l'expéditeur, le sujet, ou un code SMTP. */
const BOUNCE_SENDERS = [
  'mailer-daemon', 'mailerdaemon', 'postmaster', 'no-reply@', 'noreply@',
  'bounce', 'bounces@',
];

const BOUNCE_MARKERS = [
  'undelivered mail returned to sender',
  'delivery status notification',
  'delivery has failed',
  'undeliverable',
  'mail delivery failed',
  'echec de la remise',
  'echec de distribution',
  'message non remis',
  'adresse introuvable',
  'adresse e-mail introuvable',
  'address not found',
  'recipient address rejected',
  'user unknown',
  'mailbox unavailable',
  'does not exist',
  "n'existe pas",
];

/** Les codes SMTP d'échec définitif. Un 4xx est temporaire, pas un rebond. */
const BOUNCE_CODES = /\b(5\.[0-7]\.\d{1,3}|55[0-9]|53[0-9])\b/;

const AUTO_REPLY_MARKERS = [
  'out of office', 'ooo', 'automatic reply', 'auto-reply', 'autoreply',
  'reponse automatique', 'message automatique', 'absence du bureau',
  'je suis actuellement absent', 'je suis absente', 'je suis absent',
  'actuellement en conge', 'en conges', 'en vacances', 'absent du bureau',
  'de retour le', 'je serai de retour', 'back on', 'i am currently away',
  'i will be out', 'notre equipe est en conge', 'fermeture annuelle',
  'jusqu a mon retour', 'pendant mon absence',
];

/** Une réponse humaine réelle : quelqu'un s'adresse à nous. */
const HUMAN_MARKERS = [
  'bonjour', 'bonsoir', 'madame', 'monsieur', 'merci pour votre',
  'suite a votre', 'nous vous remercions', 'pourriez-vous', 'pouvez-vous',
  'je vous propose', 'je reviens vers vous', 'notre societe', 'cordialement',
  'bien a vous', 'hello', 'thanks for reaching out', 'could you',
];

const MOIS: Record<string, number> = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6,
  juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const norm = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/**
 * La date de retour, seulement si elle est écrite.
 *
 * « de retour le 24 août », « jusqu'au 24/08/2026 ». Un « je reviens bientôt »
 * ne donne rien : une date inventée ferait relancer au mauvais moment, ce qui
 * est pire que ne pas savoir.
 */
export function extractReturnDate(text: string, referenceYear: number): string | null {
  const t = norm(text);

  const numeric = /(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?/.exec(t);
  const MONTH_NAMES =
    'janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre' +
    '|january|february|march|april|may|june|july|august|september|october|november|december';
  // Deux ordres, parce que deux langues : « 24 aout » et « September 2 ».
  // N'en lire qu'un a fait rendre `null` sur une absence anglaise pourtant
  // parfaitement datee, ce qui aurait fait perdre la relance.
  const written = new RegExp(`(\\d{1,2})(?:er)?\\s+(${MONTH_NAMES})`).exec(t);
  const writtenEn = new RegExp(`(${MONTH_NAMES})\\s+(\\d{1,2})\\b`).exec(t);

  let day: number | null = null;
  let month: number | null = null;
  let year = referenceYear;

  if (written) {
    day = Number(written[1]);
    month = MOIS[written[2]!] ?? null;
    const trailing = new RegExp(`${written[0]}\\s+(\\d{4})`).exec(t);
    if (trailing) year = Number(trailing[1]);
  } else if (writtenEn) {
    month = MOIS[writtenEn[1]!] ?? null;
    day = Number(writtenEn[2]);
    const trailing = new RegExp(`${writtenEn[0]}(?:st|nd|rd|th)?,?\\s+(\\d{4})`).exec(t);
    if (trailing) year = Number(trailing[1]);
  } else if (numeric) {
    day = Number(numeric[1]);
    month = Number(numeric[2]);
    if (numeric[3]) {
      const raw = Number(numeric[3]);
      year = raw < 100 ? 2000 + raw : raw;
    }
  }

  if (day === null || month === null || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // Une date impossible (31 février) ne devient pas une relance.
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.getUTCDate() !== day) return null;
  return iso;
}

export function classifyInbound(input: {
  kind: InboundKind;
  subject?: string | null;
  sender?: string | null;
  body?: string | null;
  /** Sert d'année par défaut quand une absence ne donne que « 24 août ». */
  receivedAt?: string;
}): ClassificationResult {
  const signals: string[] = [];
  const subject = norm(input.subject ?? '');
  const sender = norm(input.sender ?? '');
  const body = norm(input.body ?? '');
  const haystack = `${subject} ${body}`;
  const year = new Date(input.receivedAt ?? new Date().toISOString()).getUTCFullYear();

  // Une note écrite à la main est ce que l'humain en dit, pas ce qu'on devine.
  if (input.kind === 'MANUAL_NOTE') {
    return {
      classification: 'NEEDS_REVIEW',
      confidence: 1,
      signals: ['note humaine'],
      returnDate: null,
      reason: 'Note saisie à la main : c’est à son auteur de dire ce qu’elle vaut.',
    };
  }

  // ── Rebond ───────────────────────────────────────────────────────────────
  const bounceSender = BOUNCE_SENDERS.find((s) => sender.includes(s));
  const bounceMarker = BOUNCE_MARKERS.find((m) => haystack.includes(m));
  const bounceCode = BOUNCE_CODES.exec(haystack)?.[0] ?? null;

  if (bounceSender) signals.push(`expéditeur « ${bounceSender} »`);
  if (bounceMarker) signals.push(`mention « ${bounceMarker} »`);
  if (bounceCode) signals.push(`code SMTP ${bounceCode}`);

  if (input.kind === 'BOUNCE' || bounceSender || bounceMarker || bounceCode) {
    const strength = [bounceSender, bounceMarker, bounceCode].filter(Boolean).length;
    return {
      classification: 'BOUNCED',
      confidence: input.kind === 'BOUNCE' ? 1 : Math.min(0.95, 0.6 + 0.15 * strength),
      signals: signals.length > 0 ? signals : ['déclaré comme rebond'],
      returnDate: null,
      reason: 'Le message n’est pas arrivé. L’adresse doit être revue avant tout autre envoi.',
    };
  }

  // ── Absence automatique ──────────────────────────────────────────────────
  const autoMarker = AUTO_REPLY_MARKERS.find((m) => haystack.includes(m));
  if (autoMarker) signals.push(`mention « ${autoMarker} »`);

  if (input.kind === 'AUTO_REPLY' || autoMarker) {
    // La date n'est cherchée qu'autour de la formule de retour : un « 550 »
    // ou un numéro de téléphone dans la signature ne doit pas devenir une date.
    const windowStart = Math.max(0, haystack.indexOf(autoMarker ?? 'de retour le'));
    const window = haystack.slice(windowStart, windowStart + 160);
    const returnDate = extractReturnDate(window, year);
    if (returnDate) signals.push(`retour annoncé le ${returnDate}`);

    return {
      classification: 'AUTO_REPLY',
      confidence: input.kind === 'AUTO_REPLY' ? 1 : autoMarker ? 0.9 : 0.6,
      signals: signals.length > 0 ? signals : ['déclarée comme réponse automatique'],
      returnDate,
      reason: returnDate
        ? `Absence annoncée jusqu’au ${returnDate}. Personne n’a lu le message ; ce n’est pas une réponse.`
        : 'Réponse automatique sans date de retour. Personne n’a lu le message.',
    };
  }

  // ── Une personne a écrit ─────────────────────────────────────────────────
  const humanMarker = HUMAN_MARKERS.find((m) => haystack.includes(m));
  const words = body.split(/\s+/).filter(Boolean).length;

  if (humanMarker) signals.push(`formulation humaine « ${humanMarker} »`);
  if (words >= 12) signals.push(`${words} mots`);

  if (humanMarker && words >= 12) {
    return {
      classification: 'REPLIED',
      confidence: 0.85,
      signals,
      returnDate: null,
      // Le classement s'arrête là, délibérément.
      reason:
        'Une personne a écrit. Ce qu’elle veut — intérêt, refus, demande — n’est pas ' +
        'déduit ici : une intention devinée se paie à la relance suivante.',
    };
  }

  return {
    classification: 'NEEDS_REVIEW',
    confidence: 0.3,
    signals: signals.length > 0 ? signals : ['aucun marqueur reconnu'],
    returnDate: null,
    reason:
      'Ni rebond, ni absence, ni réponse clairement humaine. Le doute se dit plutôt ' +
      'que de se ranger dans la première case venue.',
  };
}

// ─── L'état d'une conversation ──────────────────────────────────────────────

export type ConversationStatus =
  | 'CONTACTED'
  | 'AUTO_REPLY'
  | 'BOUNCED'
  | 'REPLIED'
  | 'INTERESTED'
  | 'NOT_INTERESTED'
  | 'NEEDS_INFO'
  | 'FOLLOW_UP_REQUIRED'
  | 'FOLLOW_UP_SCHEDULED'
  | 'MEETING_REQUESTED'
  | 'WON'
  | 'LOST'
  | 'NEEDS_REVIEW';

/**
 * Les états qu'aucune règle ne peut atteindre seule.
 *
 * Un `WON` sans qu'un humain l'ait constaté serait une vente inventée, et le
 * chiffre d'affaires cesserait de vouloir dire quelque chose. Même chose, en
 * moins spectaculaire, pour un `NOT_INTERESTED` : conclure au refus à partir
 * d'une réponse polie ferme une porte que personne n'avait fermée.
 */
export const HUMAN_ONLY_STATUSES: readonly ConversationStatus[] = [
  'INTERESTED', 'NOT_INTERESTED', 'NEEDS_INFO', 'MEETING_REQUESTED', 'WON', 'LOST',
];

export function requiresHumanJudgement(status: ConversationStatus): boolean {
  return HUMAN_ONLY_STATUSES.includes(status);
}

export interface ConversationEvent {
  kind: InboundKind;
  classification: ReplyClassification;
  occurredAt: string;
  returnDate: string | null;
  humanReviewed: boolean;
  /** L'état posé par un humain, quand il en a posé un. */
  declaredStatus?: ConversationStatus | null;
}

export interface DerivedState {
  status: ConversationStatus;
  followUpAt: string | null;
  nextAction: string;
  reason: string;
}

/**
 * L'état d'une conversation, déduit de son historique.
 *
 * Recalculé plutôt que stocké : les règles changeront, et un état figé
 * garderait le verdict d'une règle corrigée. C'est la même raison qui a fait
 * calculer `effectiveOutreachEligibility` à la lecture.
 *
 * Un jugement humain prime toujours : il a lu ce que la règle n'a que
 * reconnu.
 */
export function deriveConversationState(
  events: readonly ConversationEvent[],
  options: { today?: string; ledgerFollowUpAt?: string | null } = {},
): DerivedState {
  const today = options.today ?? new Date().toISOString().slice(0, 10);

  if (events.length === 0) {
    return {
      status: 'CONTACTED',
      followUpAt: options.ledgerFollowUpAt ?? null,
      nextAction: options.ledgerFollowUpAt
        ? `relancer le ${options.ledgerFollowUpAt}`
        : 'attendre une réponse',
      reason: 'Message parti, rien reçu.',
    };
  }

  const ordered = [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  // Un humain qui a tranché l'emporte, quel que soit l'âge de son jugement
  // par rapport aux automatismes qui ont suivi.
  const judged = [...ordered].reverse().find((e) => e.humanReviewed && e.declaredStatus);
  if (judged?.declaredStatus) {
    const terminal = judged.declaredStatus === 'WON' || judged.declaredStatus === 'LOST'
      || judged.declaredStatus === 'NOT_INTERESTED';
    return {
      status: judged.declaredStatus,
      followUpAt: terminal ? null : (options.ledgerFollowUpAt ?? null),
      nextAction: terminal ? 'aucune — dossier clos' : 'suivre la décision humaine',
      reason: `État posé par un humain le ${judged.occurredAt.slice(0, 10)}.`,
    };
  }

  const last = ordered[ordered.length - 1]!;
  const hasHumanReply = ordered.some((e) => e.classification === 'REPLIED');

  // Une réponse humaine prime sur un rebond antérieur : elle prouve qu'un
  // chemin fonctionne, même si le premier était mauvais.
  if (hasHumanReply) {
    return {
      status: 'REPLIED',
      followUpAt: null,
      nextAction: 'lire la réponse et décider — aucun automatisme ne le fera',
      reason: 'Une personne a écrit ; son intention reste à qualifier par un humain.',
    };
  }

  if (last.classification === 'BOUNCED') {
    return {
      status: 'BOUNCED',
      followUpAt: null,
      nextAction: 'vérifier l’adresse avant tout nouvel envoi',
      reason: 'Le dernier message n’est pas arrivé.',
    };
  }

  if (last.classification === 'AUTO_REPLY') {
    const returnDate = [...ordered].reverse().find((e) => e.returnDate)?.returnDate ?? null;
    const followUpAt = returnDate ?? options.ledgerFollowUpAt ?? null;
    if (!followUpAt) {
      return {
        status: 'FOLLOW_UP_REQUIRED',
        followUpAt: null,
        nextAction: 'fixer une date de relance — l’absence n’en donnait aucune',
        reason: 'Absence automatique sans date de retour.',
      };
    }
    const due = followUpAt <= today;
    return {
      status: due ? 'FOLLOW_UP_REQUIRED' : 'FOLLOW_UP_SCHEDULED',
      followUpAt,
      nextAction: due ? `relancer — échéance passée (${followUpAt})` : `relancer le ${followUpAt}`,
      reason: due
        ? `Retour annoncé le ${followUpAt}, date atteinte.`
        : `Absence jusqu’au ${followUpAt} ; ce n’est pas une réponse commerciale.`,
    };
  }

  return {
    status: 'NEEDS_REVIEW',
    followUpAt: options.ledgerFollowUpAt ?? null,
    nextAction: 'lire le message : aucune règle ne l’a reconnu',
    reason: last.classification === 'NEEDS_REVIEW'
      ? 'Message reçu, non classé par les règles.'
      : 'Historique sans verdict clair.',
  };
}
