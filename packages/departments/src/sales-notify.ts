/**
 * Ce qui mérite de déranger quelqu'un.
 *
 * Une boîte de réception commerciale reçoit surtout du bruit : accusés de
 * lecture, absences, désabonnements, rebonds déjà compris. Notifier tout
 * revient à ne rien notifier — au bout d'une semaine, la notification est
 * ignorée, et c'est le message intéressant qui se perd avec le reste.
 *
 * La règle retenue est donc restrictive et assumée : on ne prévient que
 * lorsqu'une décision humaine est réellement attendue. Le doute compte comme
 * une décision attendue — un message qu'on n'a pas su classer est exactement
 * celui qu'il faut faire lire.
 */
import type { ConversationStatus, ReplyClassification } from './reply-intake.ts';

export type NotifyDecision = 'NOTIFY' | 'SILENT';

export interface NotifyInput {
  status: ConversationStatus;
  classification: ReplyClassification;
  /** 0..1 — ce que vaut le classement automatique. */
  confidence: number;
  subject: string | null;
  bodyExcerpt: string | null;
  /** Le nom de l'entreprise, pour la réponse proposée. */
  company?: string | null;
}

export interface Notification {
  decision: NotifyDecision;
  /** Pourquoi on dérange, ou pourquoi on se tait. Jamais muet. */
  reason: string;
  intent: ConversationStatus;
  confidence: number;
  recommendedNextAction: string;
  /** Le résumé du message reçu, tiré de son texte — jamais reformulé. */
  summary: string;
  /**
   * Une réponse prête à relire.
   *
   * Proposée, jamais envoyée : c'est un point de départ pour la personne qui
   * répondra, pas un message qui part seul. Elle ne contient aucun fait sur le
   * prospect — seulement ce que nous, nous proposons — précisément pour qu'un
   * texte pré-écrit ne puisse jamais affirmer quelque chose de faux sur lui.
   */
  draftReply: string | null;
}

/**
 * Les états qui appellent une décision humaine immédiate.
 *
 * `REPLIED` y figure : une personne a écrit et personne ne sait encore ce
 * qu'elle veut. C'est le cas où l'on perd une vente en attendant.
 */
const ALWAYS_NOTIFY: readonly ConversationStatus[] = [
  'INTERESTED', 'NEEDS_INFO', 'MEETING_REQUESTED', 'REPLIED', 'WON', 'NEEDS_REVIEW',
];

/**
 * Le bruit reconnaissable.
 *
 * Ces marqueurs ne servent qu'à taire une notification, jamais à fermer une
 * conversation : confondre un désabonnement de newsletter avec un refus
 * commercial fermerait une porte que personne n'a fermée.
 */
const NEWSLETTER_MARKERS = [
  'se desabonner', 'unsubscribe', 'newsletter', 'desinscription',
  'vous recevez cet email', 'gerer vos preferences', 'view this email in your browser',
  'notification automatique', 'ne pas repondre a ce message', 'no-reply', 'noreply',
];

/** Les confirmations techniques : utiles à consigner, inutiles à signaler. */
const TECHNICAL_MARKERS = [
  'accuse de reception', 'read receipt', 'delivery status notification',
  'votre message a bien ete recu', 'ticket cree', 'demande enregistree',
  'votre demande a bien ete prise en compte',
];

const fold = (text: string): string =>
  text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

function looksLike(markers: readonly string[], input: NotifyInput): string | null {
  const haystack = fold(`${input.subject ?? ''} ${input.bodyExcerpt ?? ''}`);
  return markers.find((m) => haystack.includes(m)) ?? null;
}

/** Ce qu'il faut faire ensuite, dit en clair plutôt que déduit à la lecture. */
export function recommendedActionFor(status: ConversationStatus): string {
  switch (status) {
    case 'INTERESTED':
      return 'répondre dans la journée : proposer les 3 exemples gratuits et demander la cible';
    case 'NEEDS_INFO':
      return 'répondre à la question posée, sans relancer sur le prix';
    case 'MEETING_REQUESTED':
      return 'proposer deux créneaux précis';
    case 'REPLIED':
      return 'lire le message et décider de la suite';
    case 'WON':
      return 'livrer, puis consigner le règlement';
    case 'NEEDS_REVIEW':
      return 'lire le message : le classement automatique n a pas tranché';
    case 'BOUNCED':
      return 'vérifier l adresse ; ne pas réessayer la même';
    case 'NOT_INTERESTED':
      return 'aucune relance : marquer DO_NOT_CONTACT';
    case 'AUTO_REPLY':
      return 'attendre le retour annoncé';
    case 'FOLLOW_UP_REQUIRED':
      return 'préparer la relance unique';
    case 'FOLLOW_UP_SCHEDULED':
      return 'attendre l échéance';
    case 'CONTACTED':
      return 'attendre une réponse';
    case 'LOST':
      return 'affaire close';
  }
}

/**
 * Le résumé : les premiers mots du message, coupés proprement.
 *
 * Volontairement mécanique. Un résumé rédigé serait une interprétation de plus
 * entre le prospect et la personne qui décide, et c'est exactement ce qu'il ne
 * faut pas ajouter dans une boîte commerciale.
 */
export function summarise(bodyExcerpt: string | null, max = 180): string {
  const text = (bodyExcerpt ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return 'message sans corps lisible';
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 60 ? lastSpace : max)}…`;
}

/**
 * Les réponses prêtes, par intention.
 *
 * Aucune ne nomme le prospect et aucune n'affirme quoi que ce soit sur lui :
 * un texte pré-écrit ne peut pas vérifier ses propres affirmations, donc il
 * n'en fait aucune. Ce sont les formulations déjà employées à la main, mises au
 * même endroit pour cesser d'être réécrites à chaque fois.
 *
 * Les crochets sont volontaires. Ils marquent ce qu'un humain doit écrire, et
 * une réponse qui en contient encore se voit immédiatement à la relecture.
 */
export function draftReplyFor(status: ConversationStatus): string | null {
  switch (status) {
    case 'INTERESTED':
      return [
        'Bonjour,',
        '',
        "Merci de votre retour. Pour cadrer précisément : quel type d'entreprises",
        'cherchez-vous — des distributeurs qui revendraient vos produits, ou des',
        'utilisateurs finaux ? Et sur quelle zone ?',
        '',
        'Dites-moi ces deux points et je vous envoie 3 exemples complets,',
        'gratuitement, pour que vous jugiez le format avant tout engagement.',
        '',
        'Bien cordialement,',
      ].join('\n');
    case 'NEEDS_INFO':
      return [
        'Bonjour,',
        '',
        'Bien noté, je réponds sur ce point précis.',
        '',
        '[à compléter : répondre à la question posée, sans relancer sur le prix]',
        '',
        'Si cela répond à votre question, je vous prépare les 3 exemples gratuits',
        'sur la cible de votre choix.',
        '',
        'Bien cordialement,',
      ].join('\n');
    case 'MEETING_REQUESTED':
      return [
        'Bonjour,',
        '',
        'Volontiers. Je vous propose deux créneaux :',
        '',
        '[à compléter : deux créneaux précis]',
        '',
        "Si aucun ne convient, dites-moi vos disponibilités et je m'adapte.",
        '',
        'Bien cordialement,',
      ].join('\n');
    case 'NOT_INTERESTED':
      return [
        'Bonjour,',
        '',
        "Entendu, je n'insiste pas. Je vous retire de mes envois.",
        '',
        'Bonne continuation,',
      ].join('\n');
    case 'REPLIED':
    case 'NEEDS_REVIEW':
      // Rien de pré-écrit : on ne sait pas encore ce qui a été demandé, et une
      // réponse générique à un message non lu est la meilleure façon de perdre
      // un prospect qui avait posé une vraie question.
      return null;
    default:
      return null;
  }
}

/**
 * Faut-il prévenir ?
 *
 * L'ordre compte. Le bruit est écarté d'abord, mais seulement pour les états
 * qui n'appellent aucune décision : une newsletter reste une newsletter, alors
 * qu'un message contenant le mot « unsubscribe » dans son pied de page peut
 * parfaitement être une réponse humaine intéressée.
 */
export function shouldNotify(input: NotifyInput): Notification {
  const base = {
    intent: input.status,
    confidence: input.confidence,
    recommendedNextAction: recommendedActionFor(input.status),
    summary: summarise(input.bodyExcerpt),
    draftReply: draftReplyFor(input.status),
  };

  if (ALWAYS_NOTIFY.includes(input.status)) {
    // Un classement humain ou une réponse humaine prime sur tout marqueur de
    // pied de page. C'est le sens de l'ordre choisi ici.
    return {
      ...base,
      decision: 'NOTIFY',
      reason:
        input.status === 'NEEDS_REVIEW'
          ? `classement incertain (${input.confidence.toFixed(2)}) : une lecture humaine tranche`
          : `${input.status} appelle une décision`,
    };
  }

  const newsletter = looksLike(NEWSLETTER_MARKERS, input);
  if (newsletter) {
    return { ...base, decision: 'SILENT', reason: `envoi de masse reconnu : « ${newsletter} »` };
  }

  const technical = looksLike(TECHNICAL_MARKERS, input);
  if (technical) {
    return { ...base, decision: 'SILENT', reason: `confirmation technique : « ${technical} »` };
  }

  if (input.classification === 'AUTO_REPLY') {
    return { ...base, decision: 'SILENT', reason: 'réponse automatique sans action attendue' };
  }
  if (input.classification === 'BOUNCED') {
    return { ...base, decision: 'SILENT', reason: 'rebond déjà consigné et compris' };
  }

  return { ...base, decision: 'SILENT', reason: `${input.status} n appelle aucune décision` };
}
