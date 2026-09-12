/**
 * La relance, et surtout son plafond.
 *
 * Relancer une fois est du travail commercial ; relancer trois fois est du
 * harcèlement automatisé, et c'est la seule chose qui puisse transformer cet
 * outil en nuisance. Le plafond est donc structurel : la file ne sait produire
 * qu'une relance par entreprise, et le silence qui suit met fin à l'affaire.
 *
 * Trois refus priment sur le calendrier, quelle que soit l'échéance :
 * un `DO_NOT_CONTACT`, un refus explicite, et une relance déjà partie. Aucun
 * ne se rattrape par un délai qui passe.
 */
import type { ConversationStatus } from './reply-intake.ts';

export type FollowUpVerdict =
  | 'DUE'
  /** L'échéance n'est pas atteinte. */
  | 'TOO_EARLY'
  /** Une relance est déjà partie : il n'y en a pas de seconde. */
  | 'ALREADY_FOLLOWED_UP'
  /** L'entreprise a répondu : la relance n'a plus d'objet. */
  | 'ANSWERED'
  /** Refus explicite, ou mise à l'écart. */
  | 'FORBIDDEN';

export interface FollowUpInput {
  domain: string;
  status: ConversationStatus;
  /** Date du premier envoi, au format AAAA-MM-JJ. */
  contactedOn: string;
  /** Combien de relances sont déjà parties pour cette entreprise. */
  followUpsSent: number;
  /** Le registre global refuse-t-il ce domaine aujourd'hui ? */
  doNotContact: boolean;
  /** Jours ouvrés à laisser passer avant de relancer. */
  afterBusinessDays: number;
  /**
   * La derniere activite reelle sur ce dossier — notre dernier envoi, ou leur
   * dernier message. Absente, l'echeance court depuis le premier contact.
   */
  lastActivityOn?: string | null;
  /** La date d'évaluation, injectée pour que le test ne dépende pas du jour. */
  today: string;
}

export interface FollowUpDecision {
  verdict: FollowUpVerdict;
  dueOn: string | null;
  reason: string;
}

/** Le maximum absolu. Ce n'est pas un réglage : c'est une limite. */
export const MAX_FOLLOW_UPS_PER_COMPANY = 1;

/**
 * Le délai plancher avant une première relance : trois jours ouvrés.
 *
 * Le délai était réglable à partir de un. Une entreprise contactée le lundi
 * redevenait donc relançable le mardi, si la configuration le disait — et une
 * relance à vingt-quatre heures ne lit pas comme une relance, elle lit comme
 * une machine.
 *
 * Le plancher vit ici, et non dans la configuration seule : six appelants
 * passent leur propre `afterBusinessDays`, et une garde qui n'existe qu'au
 * chargement de la configuration ne protège aucun d'eux. Un réglage plus long
 * reste possible ; plus court est ramené au plancher.
 */
export const MIN_FOLLOW_UP_BUSINESS_DAYS = 3;

/** Les états où plus rien ne part, jamais. */
const FORBIDDEN_STATUSES: readonly ConversationStatus[] = ['NOT_INTERESTED', 'LOST', 'WON'];

/** Les états qui prouvent qu'on a eu quelqu'un : relancer serait déplacé. */
const ANSWERED_STATUSES: readonly ConversationStatus[] = [
  'REPLIED', 'INTERESTED', 'NEEDS_INFO', 'MEETING_REQUESTED',
];

/**
 * Ajoute des jours ouvrés à une date.
 *
 * Les jours ouvrés, et non les jours calendaires : une relance envoyée trois
 * jours après un envoi du jeudi tombe le dimanche, ce qui est à la fois inutile
 * et légèrement impoli.
 */
export function addBusinessDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  let remaining = days;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return date.toISOString().slice(0, 10);
}

export function evaluateFollowUp(input: FollowUpInput): FollowUpDecision {
  // L'ordre est délibéré : les interdits d'abord, avant tout calcul de date.
  // Une échéance atteinte ne rouvre pas une porte fermée.
  if (input.doNotContact) {
    return { verdict: 'FORBIDDEN', dueOn: null, reason: 'registre global : DO_NOT_CONTACT' };
  }
  if (FORBIDDEN_STATUSES.includes(input.status)) {
    return {
      verdict: 'FORBIDDEN',
      dueOn: null,
      reason: `état ${input.status} : aucune relance`,
    };
  }
  if (ANSWERED_STATUSES.includes(input.status)) {
    return {
      verdict: 'ANSWERED',
      dueOn: null,
      reason: `${input.status} : quelqu'un a répondu, la relance n'a plus d'objet`,
    };
  }
  if (input.followUpsSent >= MAX_FOLLOW_UPS_PER_COMPANY) {
    return {
      verdict: 'ALREADY_FOLLOWED_UP',
      dueOn: null,
      reason: `${input.followUpsSent} relance(s) déjà partie(s) : le silence clôt l'affaire`,
    };
  }

  /**
   * L'echeance court depuis la derniere action, pas depuis le premier contact.
   *
   * Le calcul partait de `contactedOn` et ignorait tout ce qui avait suivi :
   * une entreprise a qui l'on venait d'envoyer un apercu gratuit se retrouvait
   * « a relancer » le jour meme, parce que le premier message datait de la
   * semaine precedente. Relancer quelqu'un deux jours apres lui avoir envoye ce
   * qu'il attendait est la meilleure facon de perdre une affaire en cours.
   *
   * Toute activite reelle remet le compteur a zero : un message que nous avons
   * envoye, une reponse recue. Le silence se mesure depuis le dernier echange,
   * ce qui est la seule definition utile du silence.
   */
  // Une activite datee dans le futur ne repousse rien : une horloge dereglee ou
  // une donnee fausse suspendrait la relance pour des annees, en silence.
  const activite = input.lastActivityOn && input.lastActivityOn <= input.today
    ? input.lastActivityOn
    : null;
  const depart = activite && activite > input.contactedOn ? activite : input.contactedOn;
  // Le plancher s'applique ici, au calcul, et pas au reglage : c'est le seul
  // endroit que les six appelants traversent tous.
  const delai = Math.max(input.afterBusinessDays, MIN_FOLLOW_UP_BUSINESS_DAYS);
  const dueOn = addBusinessDays(depart, delai);
  const depuisAction = depart !== input.contactedOn;

  if (input.today < dueOn) {
    return {
      verdict: 'TOO_EARLY',
      dueOn,
      reason: depuisAction
        ? `échéance au ${dueOn}, comptée depuis la dernière activité du ${depart}`
        : `échéance au ${dueOn}`,
    };
  }
  return {
    verdict: 'DUE',
    dueOn,
    reason: depuisAction
      ? `échéance du ${dueOn} atteinte, sans nouvelle depuis le ${depart}`
      : `échéance du ${dueOn} atteinte`,
  };
}
