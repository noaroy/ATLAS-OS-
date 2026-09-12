/**
 * Jusqu'où ATLAS agit seul, et ce qui mérite de déranger quelqu'un.
 *
 * Deux réglages qui se ressemblent et ne font pas la même chose. Le niveau
 * d'autonomie décide de ce qui part *sans* demander ; la politique de
 * notification décide de ce qui remonte *après*. Les confondre produit soit un
 * système muet qui agit dans le dos, soit un système bavard qu'on cesse de
 * lire — et un système qu'on cesse de lire est aussi dangereux qu'un système
 * muet.
 *
 * Le niveau ne monte jamais tout seul. Il n'existe aucune règle qui le fasse
 * évoluer : c'est une décision, elle se prend en changeant la configuration.
 */

export type AutonomyLevel = 0 | 1 | 2 | 3;

export interface AutonomyPolicy {
  level: AutonomyLevel;
  label: string;
  description: string;
  /** Ce qui part sans demander à ce niveau. */
  autonomous: readonly string[];
  /** Ce qui exige une décision humaine, quel que soit le reste. */
  requiresApproval: readonly string[];
}

/**
 * Les quatre niveaux.
 *
 * Trois choses ne quittent jamais la colonne « approbation », à aucun niveau :
 * l'envoi d'un message commercial, un paiement, et l'application d'un patch au
 * dépôt. Elles ont en commun d'être irréversibles pour quelqu'un d'autre que
 * nous — un destinataire, un compte, un dépôt de travail.
 */
export const AUTONOMY_LEVELS: Readonly<Record<AutonomyLevel, AutonomyPolicy>> = {
  0: {
    level: 0,
    label: 'MANUEL',
    description: 'ATLAS n’agit pas seul. Il prépare, on décide de tout.',
    autonomous: [],
    requiresApproval: ['*'],
  },
  1: {
    level: 1,
    label: 'PRÉPARE, TU APPROUVES',
    description:
      'ATLAS cherche, qualifie, rédige et analyse seul. Tout ce qui sort — message, '
      + 'paiement, patch — attend une décision.',
    autonomous: [
      'SALES_DISCOVERY', 'SALES_QUALIFICATION', 'SALES_REPLY_CHECK',
      'ARCHITECTURE_REVIEW', 'FINAL_REVIEW', 'REPO_ANALYSIS',
      'ENGINEERING_CHANGE', 'MAINTENANCE',
    ],
    requiresApproval: ['SALES_OUTREACH', 'PAYMENT', 'ENGINEERING_APPLY', 'CLIENT_REPLY'],
  },
  2: {
    level: 2,
    label: 'RÉPÉTITIF AUTONOME',
    description:
      'Les gestes répétitifs et réversibles se font seuls : relances de suivi déjà '
      + 'approuvées dans leur forme, vérifications, rapports.',
    autonomous: [
      'SALES_DISCOVERY', 'SALES_QUALIFICATION', 'SALES_REPLY_CHECK', 'SALES_FOLLOW_UP',
      'ARCHITECTURE_REVIEW', 'FINAL_REVIEW', 'REPO_ANALYSIS', 'ENGINEERING_CHANGE',
      'MAINTENANCE', 'REPORT',
    ],
    requiresApproval: ['SALES_OUTREACH', 'PAYMENT', 'ENGINEERING_APPLY', 'CLIENT_REPLY'],
  },
  3: {
    level: 3,
    label: 'AUTONOMIE ÉLEVÉE',
    description:
      'ATLAS mène la prospection seul. L’humain ne tranche que sur ce qui engage : '
      + 'réponse à un client, paiement, application au dépôt.',
    autonomous: [
      'SALES_DISCOVERY', 'SALES_QUALIFICATION', 'SALES_REPLY_CHECK', 'SALES_FOLLOW_UP',
      'SALES_OUTREACH', 'ARCHITECTURE_REVIEW', 'FINAL_REVIEW', 'REPO_ANALYSIS',
      'ENGINEERING_CHANGE', 'MAINTENANCE', 'REPORT',
    ],
    // Même au plus haut niveau : ce qui est irréversible pour un tiers reste
    // une décision humaine.
    requiresApproval: ['PAYMENT', 'ENGINEERING_APPLY', 'CLIENT_REPLY'],
  },
};

export interface AutonomyVerdict {
  autonomous: boolean;
  reason: string;
}

/** Cette action peut-elle avoir lieu sans demander ? */
export function canActAlone(level: AutonomyLevel, action: string): AutonomyVerdict {
  const policy = AUTONOMY_LEVELS[level];
  if (policy.requiresApproval.includes('*')) {
    return { autonomous: false, reason: `niveau ${level} : tout passe par une décision` };
  }
  if (policy.requiresApproval.includes(action)) {
    return { autonomous: false, reason: `${action} exige une approbation à tous les niveaux` };
  }
  return policy.autonomous.includes(action)
    ? { autonomous: true, reason: `${action} est autonome au niveau ${level}` }
    : { autonomous: false, reason: `${action} n’est pas autonome au niveau ${level}` };
}

// --- Notifications ----------------------------------------------------------

/** Ce qui justifie d'interrompre quelqu'un. */
export type NotifiableEvent =
  | 'PROSPECT_INTERESTED'
  | 'CLIENT_REQUEST'
  | 'SALE'
  | 'DECISION_REQUIRED'
  | 'BLOCKING_ERROR'
  | 'BUDGET_THRESHOLD'
  | 'SYSTEM_DOWN';

const NOTIFY: readonly NotifiableEvent[] = [
  'PROSPECT_INTERESTED', 'CLIENT_REQUEST', 'SALE',
  'DECISION_REQUIRED', 'BLOCKING_ERROR', 'BUDGET_THRESHOLD', 'SYSTEM_DOWN',
];

/**
 * Faut-il notifier, ou laisser au tableau de bord ?
 *
 * La liste est courte à dessein. Une notification par événement produit, au
 * bout d'une semaine, un utilisateur qui les ignore toutes — et c'est
 * exactement le message important qui se perd alors.
 */
export function shouldInterrupt(event: string): { notify: boolean; reason: string } {
  return NOTIFY.includes(event as NotifiableEvent)
    ? { notify: true, reason: `${event} appelle une réaction` }
    : { notify: false, reason: `${event} appartient au tableau de bord, pas à une alerte` };
}
