import { directionOf } from './message-direction.ts';
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
 *
 * Le ton des messages sortants de ce chemin suit
 * `docs/SALES_HUMANIZATION_POLICY.md` -- source de verite unique. Les regles
 * verifiables sont appliquees par `checkHumanization` ; ce fichier ne les
 * recopie pas.
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

/**
 * L'accusé de réception : une machine qui confirme, pas une personne qui répond.
 *
 * Famille distincte de l'absence du bureau, et elle manquait. Un formulaire de
 * contact renvoie un message qui dit « Bonjour », fait deux cents mots, recopie
 * votre demande — et franchissait donc le seuil de la réponse humaine. Groupe
 * DIS figurait ainsi au tableau des décisions à prendre pour un courrier
 * intitulé « Confirmation de réception de votre demande ».
 *
 * Ces formules-ci sont décisives à elles seules dans un sujet : aucune personne
 * n'intitule sa réponse « accusé de réception ».
 */
const ACKNOWLEDGMENT_SUBJECT_MARKERS = [
  'confirmation de reception', 'accuse de reception', 'accusé de réception',
  'demande bien recue', 'votre demande a bien ete',
  'we received your', 'your request has been received', 'thanks for contacting',
  'merci de nous avoir contacte', 'nous avons bien recu votre demande',
];

/**
 * Dans un corps, la même formule est moins sûre : une vraie réponse peut
 * commencer par accuser réception avant de dire quelque chose. Il en faut donc
 * deux, dont une qui annonce explicitement qu'on recontactera plus tard — c'est
 * ce report qui distingue l'accusé de la réponse.
 */
const ACKNOWLEDGMENT_BODY_MARKERS = [
  'nous avons bien recu votre demande', 'votre demande envoyee depuis notre site',
  'depuis notre site internet', 'reviendra vers vous', 'reviendrons vers vous',
  'dans les meilleurs delais', 'ne pas repondre a ce message',
  'ceci est un message automatique', 'voici le message que vous',
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
export function extractReturnDate(
  text: string,
  referenceYear: number,
  referenceDay = `${referenceYear}-01-01`,
): string | null {
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
  let explicitYear = false;

  if (written) {
    day = Number(written[1]);
    month = MOIS[written[2]!] ?? null;
    const trailing = new RegExp(`${written[0]}\\s+(\\d{4})`).exec(t);
    if (trailing) { year = Number(trailing[1]); explicitYear = true; }
  } else if (writtenEn) {
    month = MOIS[writtenEn[1]!] ?? null;
    day = Number(writtenEn[2]);
    const trailing = new RegExp(`${writtenEn[0]}(?:st|nd|rd|th)?,?\\s+(\\d{4})`).exec(t);
    if (trailing) { year = Number(trailing[1]); explicitYear = true; }
  } else if (numeric) {
    day = Number(numeric[1]);
    month = Number(numeric[2]);
    if (numeric[3]) {
      const raw = Number(numeric[3]);
      year = raw < 100 ? 2000 + raw : raw;
      explicitYear = true;
    }
  }

  if (day === null || month === null || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // Une date impossible (31 février) ne devient pas une relance.
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.getUTCDate() !== day) return null;

  /**
   * Un retour ne s'annonce jamais dans le passé.
   *
   * « De retour le 5 janvier », écrit un 20 décembre, donnait le 5 janvier de
   * l'année en cours — une date déjà passée. La relance était alors jugée due
   * immédiatement, en pleines vacances de la personne. Sans année explicite, un
   * jour antérieur à l'envoi désigne donc l'année suivante.
   */
  if (!explicitYear && iso < referenceDay) {
    const suivant = `${year + 1}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const verifie = new Date(`${suivant}T00:00:00Z`);
    return Number.isNaN(verifie.getTime()) || verifie.getUTCDate() !== day ? null : suivant;
  }
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

  // L'accusé de réception : décisif dans un sujet, à deux marqueurs dans un corps.
  const ackSubject = ACKNOWLEDGMENT_SUBJECT_MARKERS.find((m) => subject.includes(norm(m)));
  const ackBody = ACKNOWLEDGMENT_BODY_MARKERS.filter((m) => haystack.includes(m));
  const ack = ackSubject ?? (ackBody.length >= 2 ? ackBody[0] : undefined);
  if (ackSubject) signals.push(`sujet d'accusé de réception « ${ackSubject} »`);
  else if (ack) signals.push(`accusé de réception : ${ackBody.slice(0, 2).join(', ')}`);

  if (input.kind === 'AUTO_REPLY' || autoMarker || ack) {
    // La date n'est cherchée qu'autour de la formule de retour : un « 550 »
    // ou un numéro de téléphone dans la signature ne doit pas devenir une date.
    const windowStart = Math.max(0, haystack.indexOf(autoMarker ?? 'de retour le'));
    const window = haystack.slice(windowStart, windowStart + 160);
    const returnDate = extractReturnDate(window, year, (input.receivedAt ?? new Date().toISOString()).slice(0, 10));
    if (returnDate) signals.push(`retour annoncé le ${returnDate}`);

    return {
      classification: 'AUTO_REPLY',
      confidence: input.kind === 'AUTO_REPLY' ? 1 : autoMarker ? 0.9 : ackSubject ? 0.9 : 0.75,
      signals: signals.length > 0 ? signals : ['déclarée comme réponse automatique'],
      returnDate,
      reason: returnDate
        ? `Absence annoncée jusqu’au ${returnDate}. Personne n’a lu le message ; ce n’est pas une réponse.`
        : ack
          ? 'Accusé de réception : une machine confirme avoir reçu, personne n’a encore lu.'
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

// --- Le refus de recevoir --------------------------------------------------

/**
 * Le désabonnement, reconnu tout de suite.
 *
 * C'est la seule catégorie de réponse qui n'appelle aucune interprétation :
 * quelqu'un demande à ne plus rien recevoir, et la seule réaction acceptable
 * est de ne plus rien envoyer. Le traiter comme une réponse ordinaire — à lire,
 * à classer, à relancer plus tard — reviendrait à ignorer la demande le temps
 * qu'un humain la voie.
 *
 * La détection est délibérément large et le geste qu'elle déclenche est
 * irréversible dans le bon sens : `DO_NOT_CONTACT` retire l'entreprise de toute
 * découverte future. Un faux positif coûte un prospect ; un faux négatif coûte
 * un message non désiré à quelqu'un qui a dit non.
 */
const OPT_OUT_MARKERS = [
  'desabonn', 'desinscri', 'ne plus recevoir', 'ne plus me contacter',
  'ne plus nous contacter', 'retirez-moi', 'retirez moi', 'supprimez mon adresse',
  'supprimer mon adresse', 'plus de sollicitation', 'arretez de nous ecrire',
  'arretez de m ecrire', 'pas interesse', 'pas interessee', 'non merci',
  'unsubscribe', 'remove me', 'opt out', 'opt-out', 'do not contact',
  'stop mail', 'stop email', 'take me off',
];

export interface OptOutVerdict {
  optedOut: boolean;
  /** Le marqueur trouvé, pour qu'un humain puisse contester la décision. */
  marker: string | null;
  reason: string;
}

export function detectOptOut(input: { subject?: string | null; body?: string | null }): OptOutVerdict {
  const haystack = `${input.subject ?? ''} ${input.body ?? ''}`
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

  // « STOP » seul est un désabonnement ; « stop » au milieu d'une phrase ne
  // l'est pas. La casse et l'isolement font la différence.
  const bareStop = /(^|[\s>])STOP([\s.!]|$)/.test(`${input.subject ?? ''} ${input.body ?? ''}`);
  if (bareStop) {
    return { optedOut: true, marker: 'STOP', reason: 'STOP isolé : demande de désabonnement' };
  }

  const marker = OPT_OUT_MARKERS.find((m) => haystack.includes(m));
  return marker
    ? { optedOut: true, marker, reason: `demande explicite : « ${marker} »` }
    : { optedOut: false, marker: null, reason: 'aucune demande de désabonnement' };
}


/**
 * L'histoire d'une conversation, distincte de son état courant.
 *
 * La nuance a produit une métrique fausse : le taux de réponse se déduisait du
 * seul état courant `REPLIED`, si bien qu'ACRN — qui avait bel et bien répondu
 * deux fois, et à qui nous avions ensuite envoyé l'aperçu — cessait de compter
 * comme ayant répondu. Le tableau annonçait 0 % sur treize entreprises alors
 * qu'une avait engagé une vraie conversation.
 *
 * Un état courant dit ce qu'il faut faire maintenant. Une histoire dit ce qui
 * s'est passé, et rien ne l'efface : une entreprise qui a répondu une fois reste
 * une entreprise qui a répondu, quoi qu'on fasse ensuite.
 *
 * La classification est recalculée à la lecture plutôt que relue en base — même
 * raison que pour la dérivation d'état : les règles changent, et un verdict figé
 * garderait le jugement d'une règle depuis corrigée. C'est ainsi qu'un accusé de
 * réception de formulaire, classé `REPLIED` par une règle trop faible, cesse de
 * compter dès que la règle s'affine, sans qu'on ait à réécrire l'historique.
 */
export interface ReplyHistory {
  /** Une personne extérieure a écrit, au moins une fois. */
  everHumanReplied: boolean;
  lastHumanReplyAt: string | null;
  lastAutoReplyAt: string | null;
  humanReplies: number;
  autoReplies: number;
}

export function replyHistory(
  events: readonly {
    kind: string;
    source: string;
    sender: string | null;
    rawSubject: string | null;
    bodyExcerpt: string | null;
    classification: string;
    occurredAt: string;
    humanReviewed?: boolean;
    declaredStatus?: string | null;
  }[],
  mailbox: string,
): ReplyHistory {
  let lastHumanReplyAt: string | null = null;
  let lastAutoReplyAt: string | null = null;
  let humanReplies = 0;
  let autoReplies = 0;

  for (const event of events) {
    // Les corrections d'audit ne sont pas des messages : elles portent un état,
    // pas un contenu. Les compter reviendrait à inventer une réponse.
    if (event.kind === 'CORRECTION') continue;

    const venuDeGmail = event.source.startsWith('gmail');

    // Un message importé de Gmail n'entre dans l'histoire que s'il vient de
    // l'extérieur. Une note du fondateur, elle, est un constat humain délibéré :
    // elle n'a pas d'expéditeur et ne doit pas être écartée pour autant.
    if (venuDeGmail
      && directionOf({ from: event.sender ?? '', mailbox }).direction === 'OUTBOUND') {
      continue;
    }

    /**
     * Un jugement humain prime sur la règle, ici comme ailleurs.
     *
     * `deriveConversationState` le pose noir sur blanc — « il a lu ce que la
     * règle n'a que reconnu » — et cette fonction le contredisait : elle
     * reclassait tout message venu de Gmail, y compris ceux qu'une personne
     * avait explicitement tranchés. Une réponse courte mais bien réelle,
     * confirmée à la main, cessait de compter.
     */
    if (event.humanReviewed && event.declaredStatus) {
      if (event.declaredStatus === 'REPLIED') {
        humanReplies += 1;
        if (!lastHumanReplyAt || event.occurredAt > lastHumanReplyAt) {
          lastHumanReplyAt = event.occurredAt;
        }
      } else if (event.declaredStatus === 'AUTO_REPLY') {
        autoReplies += 1;
        if (!lastAutoReplyAt || event.occurredAt > lastAutoReplyAt) {
          lastAutoReplyAt = event.occurredAt;
        }
      }
      continue;
    }

    const classification = venuDeGmail
      ? classifyInbound({
        kind: 'EMAIL_REPLY',
        subject: event.rawSubject,
        sender: event.sender,
        body: event.bodyExcerpt,
        receivedAt: event.occurredAt,
      }).classification
      : event.classification;

    if (classification === 'REPLIED') {
      humanReplies += 1;
      if (!lastHumanReplyAt || event.occurredAt > lastHumanReplyAt) {
        lastHumanReplyAt = event.occurredAt;
      }
    } else if (classification === 'AUTO_REPLY') {
      autoReplies += 1;
      if (!lastAutoReplyAt || event.occurredAt > lastAutoReplyAt) {
        lastAutoReplyAt = event.occurredAt;
      }
    }
  }

  return {
    everHumanReplied: humanReplies > 0,
    lastHumanReplyAt,
    lastAutoReplyAt,
    humanReplies,
    autoReplies,
  };
}
