/**
 * Ce qu'une tâche peut devenir, et ce qu'elle ne peut pas.
 *
 * Un système qui tourne seul pendant des semaines n'a personne pour rattraper
 * une transition absurde. `DONE → RUNNING` rejouerait un travail déjà fait ;
 * `PAUSED_QUOTA → FAILED` transformerait une indisponibilité passagère en échec
 * définitif. Ces deux-là ne figurent pas dans la table, et c'est la seule
 * manière fiable de les empêcher : un test qu'on peut oublier d'écrire ne
 * protège rien.
 *
 * Le module est pur — aucune base, aucun réseau — pour que ces règles soient
 * vérifiables sur des cas figés plutôt que sur un système en marche.
 */

export type TaskStatus =
  /** Prête, elle attend qu'un worker la prenne. */
  | 'QUEUED'
  /** Un worker la tient, sous bail. */
  | 'RUNNING'
  /**
   * Le fournisseur est momentanément indisponible.
   *
   * Distinct d'un échec, et c'est tout l'intérêt : une tâche mise en pause pour
   * quota ne consomme pas de tentative. Sinon trois limitations d'affilée —
   * situation banale — suffiraient à condamner un travail parfaitement valide.
   */
  | 'PAUSED_QUOTA'
  /** Le budget refuse la dépense. La tâche reste entière. */
  | 'PAUSED_BUDGET'
  /** Une décision humaine est attendue. N'empêche aucune autre tâche. */
  | 'WAITING_HUMAN'
  /** Une dépendance n'est pas encore satisfaite. */
  | 'WAITING_DEPENDENCY'
  /** Elle repassera d'elle-même, après le délai de reprise. */
  | 'RETRY_SCHEDULED'
  | 'DONE'
  | 'FAILED'
  | 'CANCELLED';

/**
 * Les transitions autorisées.
 *
 * `DONE`, `FAILED` et `CANCELLED` sont terminaux : rien n'en sort. Une tâche
 * qu'on veut refaire est une nouvelle tâche, pas une résurrection — la
 * distinction garde l'historique lisible et empêche un compteur de succès de
 * bouger sous les pieds de qui le lit.
 */
const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  QUEUED: ['RUNNING', 'CANCELLED', 'WAITING_DEPENDENCY', 'PAUSED_BUDGET'],
  RUNNING: [
    'DONE', 'FAILED', 'RETRY_SCHEDULED', 'PAUSED_QUOTA', 'PAUSED_BUDGET',
    'WAITING_HUMAN', 'CANCELLED',
  ],
  // Une pause se lève vers la file, jamais directement vers l'exécution : la
  // reprise repasse par la sélection normale, avec ses priorités et ses gardes.
  PAUSED_QUOTA: ['QUEUED', 'CANCELLED', 'FAILED'],
  PAUSED_BUDGET: ['QUEUED', 'CANCELLED', 'FAILED'],
  WAITING_HUMAN: ['QUEUED', 'CANCELLED', 'DONE', 'FAILED'],
  WAITING_DEPENDENCY: ['QUEUED', 'CANCELLED', 'FAILED'],
  RETRY_SCHEDULED: ['QUEUED', 'RUNNING', 'CANCELLED', 'FAILED'],
  DONE: [],
  FAILED: [],
  CANCELLED: [],
};

/** Les états depuis lesquels un worker peut prendre la tâche. */
export const CLAIMABLE_STATUSES: readonly TaskStatus[] = ['QUEUED', 'RETRY_SCHEDULED'];

/** Les états terminaux : plus rien ne bouge sans créer une autre tâche. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['DONE', 'FAILED', 'CANCELLED'];

/** Les états qui attendent quelque chose d'extérieur, sans bloquer la file. */
export const WAITING_TASK_STATUSES: readonly TaskStatus[] = [
  'PAUSED_QUOTA', 'PAUSED_BUDGET', 'WAITING_HUMAN', 'WAITING_DEPENDENCY',
];

export interface TaskTransitionCheck {
  allowed: boolean;
  reason: string;
}

export function canTransitionTask(
  from: TaskStatus | null,
  to: TaskStatus,
): TaskTransitionCheck {
  if (from === null) {
    return to === 'QUEUED' || to === 'WAITING_DEPENDENCY'
      ? { allowed: true, reason: `création en ${to}` }
      : { allowed: false, reason: `une tâche naît QUEUED ou WAITING_DEPENDENCY, pas ${to}` };
  }
  if (from === to) {
    return { allowed: false, reason: `déjà en ${to}` };
  }
  const allowed = TRANSITIONS[from];
  if (allowed.length === 0) {
    return { allowed: false, reason: `${from} est terminal : refaire ce travail exige une nouvelle tâche` };
  }
  if (!allowed.includes(to)) {
    return {
      allowed: false,
      reason: `transition refusée : ${from} → ${to}. Depuis ${from} : ${allowed.join(', ')}.`,
    };
  }
  return { allowed: true, reason: `${from} → ${to}` };
}

/**
 * L'ordre dans lequel les départements passent.
 *
 * Un client qui attend une réponse passe avant une tâche de fond, toujours.
 * L'ordre est déclaré ici plutôt que dispersé dans une requête SQL, pour qu'il
 * se discute — c'est une décision commerciale, pas un détail d'implémentation.
 */
export const DEPARTMENT_ORDER = [
  'CRITICAL_CLIENT',
  'CLIENT_REPLY',
  'SALES',
  'ENGINEERING',
  'BACKGROUND',
  'MAINTENANCE',
] as const;

export type Department = (typeof DEPARTMENT_ORDER)[number];

/** Le rang d'un département. Un nom inconnu passe en dernier, jamais en premier. */
export function departmentRank(department: string): number {
  const index = DEPARTMENT_ORDER.indexOf(department as Department);
  return index === -1 ? DEPARTMENT_ORDER.length : index;
}

export type WorkerType = 'DETERMINISTIC' | 'OPENAI' | 'CLAUDE' | 'HUMAN';
