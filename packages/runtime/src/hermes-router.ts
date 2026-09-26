import type { Logger } from '@atlas/core';
import type { Repositories, TaskRow } from '@atlas/data';
import { taskFingerprint, targetOf, type AiTaskResult } from './ai-contracts.ts';

/**
 * Qui fait quoi, et jusqu'où.
 *
 * Deux responsabilités, volontairement dans le même fichier parce qu'elles se
 * contredisent si on les sépare : décider qui traite une tâche, et décider si
 * une tâche a le droit d'exister.
 *
 * Le routage est déterministe. Appeler un modèle pour choisir quel modèle
 * appeler coûte de l'argent et du temps pour répondre à une question dont la
 * réponse est écrite dans une table — et fait dépendre le routage de la
 * disponibilité du service qu'il est censé router.
 *
 * Les bornes existent parce qu'une revue peut demander une correction, qui peut
 * demander une revue. C'est utile deux fois et ruineux la troisième : sans
 * limite, deux modèles se renvoient la balle jusqu'à épuisement du budget, et
 * personne ne le voit avant la facture.
 */

export type RouteTarget = 'OPENAI' | 'CLAUDE' | 'CLAUDE_CODE' | 'DETERMINISTIC' | 'DETERMINISTIC_EXTERNAL' | 'HUMAN';

/**
 * La table de routage.
 *
 * Le raisonnement d'un côté, le dépôt de l'autre. Ce n'est pas une hiérarchie :
 * c'est une différence de permissions. Celui qui relit n'a pas besoin d'écrire,
 * et celui qui écrit travaille sous verrou.
 */
const ROUTES: Readonly<Record<string, RouteTarget>> = {
  // L'ingenierie qui modifie du code va a Claude Code : c'est un agent qui lit
  // le depot et decide lui-meme quoi ouvrir, la ou l'API rend du texte qu'ATLAS
  // doit ensuite transformer en ecritures.
  ENGINEERING_CHANGE: 'CLAUDE_CODE',
  CODE_FIX: 'CLAUDE_CODE',
  TEST_FAILURE: 'CLAUDE_CODE',
  TEST_FAILURE_FIX: 'CLAUDE_CODE',
  BUILD_FIX: 'CLAUDE_CODE',
  REFACTOR: 'CLAUDE_CODE',
  DEBUGGING: 'CLAUDE_CODE',
  BUILD_VALIDATION: 'CLAUDE_CODE',
  // L'analyse sans ecriture reste sur l'API : moins cher, et sans worktree.
  REPO_ANALYSIS: 'CLAUDE',

  ARCHITECTURE_REVIEW: 'OPENAI',
  FINAL_REVIEW: 'OPENAI',
  CODE_REVIEW: 'OPENAI',
  COMMERCIAL_REPLY_ANALYSIS: 'OPENAI',
  PROSPECT_AMBIGUITY: 'OPENAI',
  AMBIGUITY_RESOLUTION: 'OPENAI',
  COMMERCIAL_ANALYSIS: 'OPENAI',
  PLANNING: 'OPENAI',
  STRUCTURED_EXTRACTION: 'OPENAI',

  APPROVE_EMAIL: 'HUMAN',
  ANSWER_CLIENT: 'HUMAN',
  APPROVE_PAYMENT: 'HUMAN',

  // Un script en sous-processus (`scripts/sales-batch.ts`), pas d'appel modèle
  // direct — mais un script que l'image serveur dist-only n'embarque pas. Le
  // runner externe (`atlas-engineer`), lui, a le dépôt complet et `tsx` : c'est
  // la même distinction que CLAUDE_CODE, pour la même raison.
  SALES_DISCOVERY: 'DETERMINISTIC_EXTERNAL',
  // L'expansion de prospects est une bibliothèque : recherche, lecture de
  // pages, modèle plafonné et dépôts vivent dans l'image serveur. Le worker
  // déterministe du serveur la sert ; aucun script, aucune voie externe.
  PROSPECT_EXPANSION: 'DETERMINISTIC',
  // Le sondage du pont contrôleur : lire des issues GitHub, valider une
  // enveloppe, poser une tâche ENGINEERING_CHANGE, publier un résultat. Aucun
  // modèle — c'est ENGINEERING_CHANGE, routée plus haut, qui porte le travail.
  CONTROLLER_BRIDGE_POLL: 'DETERMINISTIC',
  // Le sondage du superviseur GPT : relire les tâches d'objectif arrivées en
  // READY_FOR_REVIEW, appeler GPT, poser au plus une suite. Servi par le
  // daemon du serveur (celui qui a la clé OpenAI) ; la suite, elle, est une
  // ENGINEERING_CHANGE routée plus haut vers CLAUDE_CODE.
  SUPERVISOR_REVIEW_POLL: 'DETERMINISTIC',
};

/**
 * Tous les types de tâche que la table sait router.
 *
 * Exposé pour qu'on puisse vérifier ailleurs qu'aucun ne vise un worker que le
 * daemon ne sert pas. Le rapprochement doit se faire sur cette table même, pas
 * sur une liste recopiée : c'est une recopie qui a laissé `CLAUDE_CODE` hors du
 * daemon pendant que tout paraissait vert.
 */
export const ROUTED_TASK_TYPES: readonly string[] = Object.keys(ROUTES);

/** Toutes les destinations possibles. Le typage force l'exhaustivité. */
export const ROUTE_TARGETS: readonly RouteTarget[] = [
  'OPENAI', 'CLAUDE', 'CLAUDE_CODE', 'DETERMINISTIC', 'HUMAN',
];

export interface RouteDecision {
  target: RouteTarget;
  reason: string;
}

/**
 * À qui revient cette tâche.
 *
 * Un type inconnu part au worker déterministe, qui refusera faute de
 * traitement enregistré. Le refus est explicite et nommé — préférable à un
 * envoi « au mieux » vers un modèle, qui coûterait de l'argent pour produire
 * une réponse à une question que personne n'a définie.
 */
export function routeTask(taskType: string): RouteDecision {
  const target = ROUTES[taskType];
  if (target) return { target, reason: `${taskType} → ${target}` };
  return {
    target: 'DETERMINISTIC',
    reason: `${taskType} n'a pas de route déclarée : traitement déterministe`,
  };
}

/**
 * La politique de repli.
 *
 * Il n'y en a pas entre les deux modèles, et c'est délibéré. Basculer une tâche
 * d'ingénierie vers un modèle sans accès au dépôt produirait une réponse
 * plausible sur du code qu'il n'a pas lu. Une indisponibilité se traduit par
 * une attente, pas par un changement d'exécutant.
 */
export function fallbackFor(target: RouteTarget): { allowed: false; reason: string } {
  return {
    allowed: false,
    reason:
      `aucun repli depuis ${target} : les capacités ne sont pas interchangeables. `
      + 'Une indisponibilité met la tâche en pause, elle ne la déplace pas.',
  };
}

export type ChainBlockReason =
  | 'MAX_DEPTH'
  | 'MAX_TASKS'
  | 'MAX_COST'
  /**
   * Le plafond existe, mais la dépense n'est pas calculable.
   *
   * Distinct de `MAX_COST` : là on sait qu'on a dépassé, ici on ne sait pas où
   * l'on en est. Traiter le second comme le premier serait pessimiste ; le
   * traiter comme « sous le plafond » serait faux, et c'est ce qui était fait —
   * un appel au tarif inconnu comptait pour zéro.
   */
  | 'COST_UNKNOWN_BLOCKED'
  | 'MAX_RUNTIME'
  | 'DUPLICATE_CHILD_BLOCKED'
  | 'ANCESTOR_IDENTICAL';

export interface ChainLimits {
  maxDepth: number;
  maxTasks: number;
  maxCostUsd: number;
  maxRuntimeMinutes: number;
  /**
   * Ce qu'on fait d'une chaîne dont le coût n'est pas calculable.
   *
   * `BLOCK` par défaut : un modèle absent de la table tarifaire a bien dépensé
   * quelque chose, et laisser courir une chaîne dont on ne sait pas mesurer la
   * dépense revient à n'avoir aucun plafond.
   */
  unknownCostPolicy?: 'BLOCK' | 'ALLOW';
}

export interface ChainVerdict {
  allowed: boolean;
  reason: string;
  blockedBy: ChainBlockReason | null;
}

export interface HermesOptions {
  repos: Repositories;
  logger: Logger;
  limits: ChainLimits;
}

export class HermesRouter {
  constructor(private readonly options: HermesOptions) {}

  /**
   * Cette tâche enfant a-t-elle le droit de naître ?
   *
   * L'ordre des vérifications suit leur coût : profondeur et nombre se lisent
   * sur la ligne du parent, le coût demande une agrégation, l'empreinte une
   * recherche. Aucune n'est chère, mais l'ordre reste celui du bon sens.
   */
  canCreateChild(parent: TaskRow, child: { taskType: string; objective: string; target?: string | null }): ChainVerdict {
    const { repos, limits } = this.options;
    const chainId = parent.chainId ?? parent.taskId;

    if (parent.chainDepth + 1 > limits.maxDepth) {
      return {
        allowed: false,
        blockedBy: 'MAX_DEPTH',
        reason: `profondeur ${parent.chainDepth + 1} au-delà du plafond ${limits.maxDepth}`,
      };
    }

    const tasks = repos.tasks.chainTasks(chainId);
    if (tasks.length + 1 > limits.maxTasks) {
      return {
        allowed: false,
        blockedBy: 'MAX_TASKS',
        reason: `${tasks.length} tâches dans la chaîne, plafond ${limits.maxTasks}`,
      };
    }

    const cost = repos.tasks.chainCost(chainId);
    if (cost.knownUsd >= limits.maxCostUsd) {
      return {
        allowed: false,
        blockedBy: 'MAX_COST',
        reason:
          `${cost.knownUsd.toFixed(4)} $ dépensés, plafond ${limits.maxCostUsd} $`
          + (cost.unknownCalls > 0 ? ` (+ ${cost.unknownCalls} appel(s) au tarif inconnu)` : ''),
      };
    }

    // Un plafond actif et une dépense non calculable ne font pas bon ménage :
    // sous le plafond « d'après ce qu'on sait » n'est pas sous le plafond.
    if (
      (limits.unknownCostPolicy ?? 'BLOCK') === 'BLOCK'
      && limits.maxCostUsd > 0
      && cost.unknownCalls > 0
    ) {
      return {
        allowed: false,
        blockedBy: 'COST_UNKNOWN_BLOCKED',
        reason:
          `${cost.unknownCalls} appel(s) au tarif inconnu : la dépense de cette chaîne `
          + `n'est pas calculable, et le plafond de ${limits.maxCostUsd} $ ne peut pas être vérifié`,
      };
    }

    const runtime = repos.tasks.chainRuntimeMinutes(chainId);
    if (runtime > limits.maxRuntimeMinutes) {
      return {
        allowed: false,
        blockedBy: 'MAX_RUNTIME',
        reason: `chaîne ouverte depuis ${runtime} min, plafond ${limits.maxRuntimeMinutes} min`,
      };
    }

    const fingerprint = taskFingerprint({
      taskType: child.taskType,
      objective: child.objective,
      target: child.target,
    });

    // La même demande, déjà présente dans la chaîne. C'est la forme que prend
    // le renvoi de balle : chacun redemande à l'autre ce qu'il vient de lui
    // demander, sous une formulation à peine différente.
    const twin = repos.tasks.fingerprintInChain(chainId, fingerprint);
    if (twin) {
      return {
        allowed: false,
        blockedBy: twin.taskId === parent.taskId ? 'ANCESTOR_IDENTICAL' : 'DUPLICATE_CHILD_BLOCKED',
        reason: `demande identique déjà présente dans la chaîne (${twin.taskId})`,
      };
    }

    return { allowed: true, blockedBy: null, reason: 'dans les bornes' };
  }

  /**
   * Créer les suites qu'un worker a proposées.
   *
   * Le worker propose, Hermes dispose. Cette séparation est ce qui empêche deux
   * modèles de se créer mutuellement du travail : aucun des deux n'a la main
   * sur la file, et les bornes sont vérifiées à un seul endroit.
   *
   * Une proposition refusée n'est pas perdue : elle est journalisée avec son
   * motif, et la tâche parente passe en attente humaine quand la chaîne bute
   * sur une borne plutôt que sur un doublon.
   */
  createChildren(parent: TaskRow, result: Pick<AiTaskResult, 'next_tasks' | 'summary'> & Partial<AiTaskResult>): {
    created: TaskRow[];
    blocked: Array<{ objective: string; reason: string; blockedBy: ChainBlockReason }>;
  } {
    const { repos, logger } = this.options;
    const created: TaskRow[] = [];
    const blocked: Array<{ objective: string; reason: string; blockedBy: ChainBlockReason }> = [];
    const chainId = parent.chainId ?? parent.taskId;

    // Un parent déjà traité ne se retraite pas. La garde anti-doublon
    // rattraperait le cas, mais elle est là pour le renvoi de balle entre deux
    // modèles — pas pour compenser une boucle qui repasse sur ses propres pas.
    // S'en remettre à elle noierait le vrai signal sous des refus de routine.
    if (repos.tasks.childrenOf(parent.taskId).length > 0) {
      return { created, blocked };
    }

    for (const proposal of result.next_tasks) {
      // La cible vient du parent, ou n'existe pas. Retomber sur le type de
      // tâche ferait entrer celui-ci deux fois dans l'empreinte, et surtout
      // ferait diverger ce calcul de celui que fait `canCreateChild`.
      const target = targetOf(parent.payload.repo_target as string | undefined);
      const verdict = this.canCreateChild(parent, {
        taskType: proposal.task_type,
        objective: proposal.objective,
        target,
      });

      if (!verdict.allowed) {
        blocked.push({
          objective: proposal.objective,
          reason: verdict.reason,
          blockedBy: verdict.blockedBy!,
        });
        logger.warn('tâche enfant refusée', {
          parentTaskId: parent.taskId,
          chainId,
          blockedBy: verdict.blockedBy,
          reason: verdict.reason,
        });
        continue;
      }

      const route = routeTask(proposal.task_type);
      const outcome = repos.tasks.create({
        taskType: proposal.task_type,
        department: proposal.department ?? parent.department,
        workerType: route.target,
        priority: parent.priority,
        payload: {
          objective: proposal.objective,
          rationale: proposal.rationale,
          parent_summary: result.summary,
          ...(parent.payload.repo_refs ? { repo_refs: parent.payload.repo_refs } : {}),
          ...(parent.payload.repo_target ? { repo_target: parent.payload.repo_target } : {}),
          // Le périmètre descend avec la chaîne.
          //
          // Sans cela, une tâche d'ingénierie créée par Hermes naîtrait sans
          // `allowed_paths` et serait refusée faute de périmètre — ce qui
          // obligerait quelqu'un à l'éditer à la main, c'est-à-dire à devenir
          // le maillon humain que cette architecture existe pour supprimer.
          //
          // L'enfant hérite, il n'élargit jamais : on transmet exactement ce
          // que le parent avait le droit de toucher.
          ...(parent.payload.allowed_paths
            ? { allowed_paths: parent.payload.allowed_paths } : {}),
          ...(parent.payload.test_commands
            ? { test_commands: parent.payload.test_commands } : {}),
          ...(parent.payload.acceptance_criteria
            ? { acceptance_criteria: parent.payload.acceptance_criteria } : {}),
        },
        parentTaskId: parent.taskId,
        correlationId: parent.correlationId ?? chainId,
        chainId,
        chainDepth: parent.chainDepth + 1,
        fingerprint: taskFingerprint({
          taskType: proposal.task_type,
          objective: proposal.objective,
          target,
        }),
      });

      created.push(outcome.task);
      logger.info('tâche enfant créée', {
        parentTaskId: parent.taskId,
        taskId: outcome.task.taskId,
        chainId,
        worker: route.target,
        reason: route.reason,
      });
    }

    return { created, blocked };
  }

  /** L'état d'une chaîne, pour l'afficher sans le recalculer partout. */
  chainSummary(chainId: string): {
    chainId: string;
    tasks: number;
    depth: number;
    knownCostUsd: number;
    unknownCostCalls: number;
    runtimeMinutes: number;
    open: number;
    waitingHuman: number;
    pausedQuota: number;
  } {
    const tasks = this.options.repos.tasks.chainTasks(chainId);
    const cost = this.options.repos.tasks.chainCost(chainId);
    return {
      chainId,
      tasks: tasks.length,
      depth: tasks.reduce((max, t) => Math.max(max, t.chainDepth), 0),
      knownCostUsd: cost.knownUsd,
      unknownCostCalls: cost.unknownCalls,
      runtimeMinutes: this.options.repos.tasks.chainRuntimeMinutes(chainId),
      open: tasks.filter((t) => ['QUEUED', 'RUNNING', 'RETRY_SCHEDULED'].includes(t.status)).length,
      waitingHuman: tasks.filter((t) => t.status === 'WAITING_HUMAN').length,
      pausedQuota: tasks.filter((t) => t.status === 'PAUSED_QUOTA').length,
    };
  }
}
