/**
 * La boucle commerciale, vue comme une machine a etats.
 *
 * Sans machine explicite, l'etat d'un prospect se devine en relisant plusieurs
 * tables : un message parti, une reponse recue, une relance prevue. Chaque
 * lecteur reconstruit alors sa propre version, et deux parties du systeme
 * finissent par ne plus etre d'accord sur ce qui reste a faire.
 *
 * Les transitions sont declarees ici, une fois. Ce qui n'y figure pas est
 * refuse : passer directement de la qualification a l'envoi, par exemple, est
 * une transition qui n'existe pas — c'est le verrou d'approbation, exprime
 * comme une absence plutot que comme un test qu'on peut oublier d'ecrire.
 */

export type LoopState =
  | 'DISCOVERING'
  | 'QUALIFYING'
  | 'READY_FOR_APPROVAL'
  | 'APPROVED_TO_SEND'
  | 'SENDING'
  | 'CONTACTED'
  | 'WAITING_REPLY'
  | 'REPLIED'
  | 'ACTION_REQUIRED'
  | 'FOLLOW_UP_REQUIRED'
  | 'WON'
  | 'LOST'
  | 'BLOCKED';

/**
 * Ce qui peut suivre quoi.
 *
 * `BLOCKED` est atteignable depuis presque partout : une garde peut refuser un
 * prospect a tout moment, y compris apres qu'un message est parti — un opt-out
 * arrive toujours apres l'envoi. L'inverse n'est pas vrai : on ne sort de
 * `BLOCKED` que par une reprise explicite en qualification.
 */
const TRANSITIONS: Readonly<Record<LoopState, readonly LoopState[]>> = {
  DISCOVERING: ['QUALIFYING', 'BLOCKED'],
  QUALIFYING: ['READY_FOR_APPROVAL', 'BLOCKED'],
  // Il n'y a pas de chemin de READY_FOR_APPROVAL vers SENDING : l'approbation
  // n'est pas une etape qu'on peut sauter, c'est un passage oblige.
  READY_FOR_APPROVAL: ['APPROVED_TO_SEND', 'BLOCKED', 'LOST'],
  APPROVED_TO_SEND: ['SENDING', 'BLOCKED'],
  SENDING: ['CONTACTED', 'BLOCKED', 'ACTION_REQUIRED'],
  CONTACTED: ['WAITING_REPLY', 'REPLIED', 'BLOCKED', 'ACTION_REQUIRED'],
  WAITING_REPLY: ['REPLIED', 'FOLLOW_UP_REQUIRED', 'BLOCKED', 'LOST'],
  REPLIED: ['ACTION_REQUIRED', 'WON', 'LOST', 'FOLLOW_UP_REQUIRED', 'BLOCKED'],
  ACTION_REQUIRED: ['READY_FOR_APPROVAL', 'WON', 'LOST', 'BLOCKED'],
  FOLLOW_UP_REQUIRED: ['READY_FOR_APPROVAL', 'LOST', 'BLOCKED'],
  // Un etat terminal ne se rouvre pas tout seul. Reprendre une affaire gagnee
  // ou perdue est une decision, elle passe par une nouvelle qualification.
  WON: ['QUALIFYING'],
  LOST: ['QUALIFYING'],
  BLOCKED: ['QUALIFYING'],
};

/** Les etats ou plus rien ne part sans qu'un humain le decide. */
export const TERMINAL_STATES: readonly LoopState[] = ['WON', 'LOST', 'BLOCKED'];

/** Les etats qui demandent une lecture humaine avant de continuer. */
export const HUMAN_ATTENTION_STATES: readonly LoopState[] = [
  'READY_FOR_APPROVAL', 'ACTION_REQUIRED', 'REPLIED', 'FOLLOW_UP_REQUIRED',
];

export interface TransitionCheck {
  allowed: boolean;
  reason: string;
}

/**
 * Une transition est-elle legitime ?
 *
 * Rend une raison lisible plutot qu'un booleen nu : quand un envoi est refuse,
 * la question suivante est toujours « pourquoi », et une reponse construite au
 * moment du refus vaut mieux qu'une reconstitution.
 */
export function canTransitionLoop(from: LoopState | null, to: LoopState): TransitionCheck {
  if (from === null) {
    return to === 'DISCOVERING' || to === 'QUALIFYING'
      ? { allowed: true, reason: `entree dans la boucle en ${to}` }
      : {
          allowed: false,
          reason: `un prospect entre par DISCOVERING ou QUALIFYING, jamais directement en ${to}`,
        };
  }
  if (from === to) {
    return { allowed: false, reason: `deja en ${to} : une transition doit changer quelque chose` };
  }
  const allowed = TRANSITIONS[from];
  if (!allowed.includes(to)) {
    return {
      allowed: false,
      reason: `transition refusee : ${from} → ${to}. Depuis ${from}, seuls ${allowed.join(', ')} sont atteignables.`,
    };
  }
  return { allowed: true, reason: `${from} → ${to}` };
}

/** Ce qui reste a faire, en clair, pour un etat donne. */
export function nextActionFor(state: LoopState): string {
  switch (state) {
    case 'DISCOVERING': return 'chercher des candidats';
    case 'QUALIFYING': return 'verifier identite, ICP et faits observes';
    case 'READY_FOR_APPROVAL': return 'relire le brouillon et approuver, ou refuser';
    case 'APPROVED_TO_SEND': return 'envoyer — approbation obtenue';
    case 'SENDING': return 'envoi en cours';
    case 'CONTACTED': return 'attendre une reponse';
    case 'WAITING_REPLY': return 'attendre, puis relancer a echeance';
    case 'REPLIED': return 'lire la reponse et decider';
    case 'ACTION_REQUIRED': return 'une decision humaine est attendue';
    case 'FOLLOW_UP_REQUIRED': return 'preparer la relance unique';
    case 'WON': return 'client gagne — livrer';
    case 'LOST': return 'affaire close';
    case 'BLOCKED': return 'aucune action : une garde refuse ce prospect';
  }
}
