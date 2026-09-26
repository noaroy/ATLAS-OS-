import { createHash } from 'node:crypto';
import type { AtlasConfig } from '@atlas/core';
import type { TaskRow } from '@atlas/data';
import { taskFingerprint } from '../ai-contracts.ts';
import { routeTask } from '../hermes-router.ts';
import { objectiveIdFor } from '../gpt-supervisor/engine.ts';
import { SUPERVISOR_OBJECTIVE_SCHEMA } from '../gpt-supervisor/types.ts';
import {
  CONTROLLER_ACCEPTED_TASK_TYPE, CONTROLLER_LEDGER, CONTROLLER_TASK_SCHEMA, COMMENTED_STATES, STATE_LABELS,
  type ControllerDeps, type ControllerPollReport, type ControllerResult, type ControllerState, type EnvelopeVerdict,
} from './types.ts';
import { buildControllerResult, parseControllerIssue, renderResultComment, resultMarker } from './schema.ts';
import {
  createGithubClient, controllerTokenSource, readControllerToken, isValidRepoSlug,
  type ControllerGithub, type GithubIssue, type TokenSource,
} from './github.ts';

/**
 * Le pont contrôleur : un tour de sondage.
 *
 * Deux mouvements, et le même tour les fait tous deux :
 *
 * 1. **L'entrée.** Une issue ouverte, portant l'étiquette, écrite par un auteur
 *    autorisé, dont le corps contient une enveloppe valide, devient exactement
 *    une tâche ENGINEERING_CHANGE — par `repos.tasks.create`, routée par
 *    `routeTask`, avec une clé d'idempotence tirée de l'empreinte. Le lien
 *    issue → tâche est consigné dans le registre des opérations externes : une
 *    issue n'a qu'une tâche, pour toujours.
 * 2. **La sortie.** L'état de la tâche est relu et publié sur la même issue :
 *    un commentaire `atlas.controller-result.v1` par état, une étiquette
 *    d'état à la fois.
 *
 * Aucun modèle n'est appelé ici, et Claude Code n'est jamais lancé : c'est le
 * worker existant qui prend la tâche, dans son worktree, et qui s'arrête à
 * READY_FOR_REVIEW. GitHub absent ou non prêt : rien n'est créé.
 */

export interface ControllerReadiness {
  ready: boolean;
  enabled: boolean;
  repo: string;
  repoValid: boolean;
  authors: number;
  label: string;
  tokenSource: TokenSource;
  reasons: string[];
}

/**
 * Le pont a-t-il le droit de sonder ?
 *
 * Fermé par défaut, et chaque condition manquante est nommée. Aucun appel
 * réseau : la présence du jeton se constate, sa valeur ne se lit pas.
 */
export function controllerReadiness(config: AtlasConfig, env: NodeJS.ProcessEnv = process.env): ControllerReadiness {
  const c = config.controller;
  const reasons: string[] = [];
  if (!c.enabled) reasons.push('ATLAS_CONTROLLER_ENABLED=false');
  const repoValid = isValidRepoSlug(c.repo);
  if (!c.repo) reasons.push('ATLAS_CONTROLLER_REPO vide : tout est refusé');
  else if (!repoValid) reasons.push('ATLAS_CONTROLLER_REPO invalide (attendu : propriétaire/dépôt)');
  if (c.authors.length === 0) reasons.push('ATLAS_CONTROLLER_AUTHORS vide : tout est refusé');
  if (!c.label) reasons.push('ATLAS_CONTROLLER_LABEL vide');
  const tokenSource = controllerTokenSource(env);
  if (!tokenSource) reasons.push('aucun jeton : ATLAS_CONTROLLER_GITHUB_TOKEN (ou GITHUB_TOKEN) absent');
  return {
    ready: reasons.length === 0,
    enabled: c.enabled,
    repo: c.repo,
    repoValid,
    authors: c.authors.length,
    label: c.label,
    tokenSource,
    reasons,
  };
}

export const intakeKey = (repo: string, issue: number) => `controller:intake:${repo.toLowerCase()}#${issue}`;
export const resultKey = (taskId: string, state: ControllerState) => `controller:result:${taskId}:${state}`;
export const rejectKey = (repo: string, issue: number, body: string) =>
  `controller:reject:${repo.toLowerCase()}#${issue}:${createHash('sha256').update(body).digest('hex').slice(0, 16)}`;
export const taskIdempotencyKey = (fingerprint: string) => `controller:task:v1:${fingerprint}`;

/**
 * L'état publié, lu sur la tâche.
 *
 * DONE ne vaut READY_FOR_REVIEW que si le worker l'a dit — c'est le statut que
 * rend ClaudeCodeWorker. Une pause, une attente humaine valent BLOCKED ; un
 * échec ou une annulation, FAILED. Rien ici ne vaut « appliqué ».
 */
export function controllerStateOf(task: TaskRow): ControllerState {
  switch (task.status) {
    case 'QUEUED':
    case 'WAITING_DEPENDENCY':
    case 'RETRY_SCHEDULED':
      return 'QUEUED';
    case 'RUNNING':
      return 'RUNNING';
    case 'DONE':
      return task.result?.status === 'ENGINEERING_READY_FOR_REVIEW' ? 'READY_FOR_REVIEW' : 'BLOCKED';
    case 'WAITING_HUMAN':
    case 'PAUSED_QUOTA':
    case 'PAUSED_BUDGET':
      return 'BLOCKED';
    case 'FAILED':
    case 'CANCELLED':
    default:
      return 'FAILED';
  }
}

const asStrings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

/** Le résultat d'une tâche, tel qu'il peut sortir : ni chemin local, ni sortie brute. */
export function resultForTask(task: TaskRow, repo: string, issue: number, state: ControllerState, deps: Pick<ControllerDeps, 'repos'>): ControllerResult {
  const payload = task.payload as Record<string, unknown>;
  const controller = (payload.controller ?? {}) as Record<string, unknown>;
  const result = (task.result ?? {}) as Record<string, unknown>;
  const workspace = deps.repos.tasks.workspaceFor(task.taskId);
  const limits = payload.limits as ControllerResult['effective_limits'] | undefined;

  const summaries: Record<ControllerState, string> = {
    QUEUED: `tâche ${task.taskId} en file pour ${task.workerType}`,
    RUNNING: `tâche ${task.taskId} en cours`,
    READY_FOR_REVIEW: typeof result.summary === 'string' ? result.summary : 'diff prêt pour revue',
    BLOCKED: task.errorMessage ?? (typeof result.summary === 'string' ? result.summary : 'décision humaine attendue'),
    FAILED: task.errorMessage ?? 'échec sans motif',
    REJECTED: 'refusée',
  };

  const hasDiff = workspace !== null || Array.isArray(result.files_changed);
  return buildControllerResult({
    state,
    repo,
    issue,
    correlationId: task.correlationId,
    fingerprint: typeof controller.fingerprint === 'string' ? controller.fingerprint : null,
    taskId: task.taskId,
    worker: task.workerType,
    summary: summaries[state],
    errorCode: state === 'BLOCKED' || state === 'FAILED' ? task.errorCode : null,
    limits: limits ?? null,
    clamped: asStrings(controller.clamped_limits),
    diff: hasDiff
      ? {
        files_changed: asStrings(result.files_changed),
        files_added: asStrings(result.files_added),
        files_deleted: asStrings(result.files_deleted),
        diff_lines: typeof result.diff_lines === 'number' ? result.diff_lines : workspace?.diffLines ?? 0,
        diff_hash: typeof result.diff_hash === 'string' ? result.diff_hash : workspace?.diffHash ?? null,
        base_commit: typeof result.base_commit === 'string' ? result.base_commit : workspace?.baseCommit ?? null,
        workspace_state: workspace?.state ?? null,
      }
      : null,
  });
}

/** Les contraintes posées sur toute tâche née du pont, quoi que dise l'enveloppe. */
const FIXED_CONSTRAINTS = [
  'Ne rien appliquer au dépôt principal, ne rien commiter sur main, ne rien pousser, ne rien déployer.',
  'S’arrêter à READY_FOR_REVIEW : le diff reste dans le worktree, en attente d’une personne.',
  'Ne toucher ni aux secrets, ni à .env, ni à .git, ni à .github, ni à deployment/.',
];

function emptyReport(): ControllerPollReport {
  return {
    ran: false, skipped: [], issuesSeen: 0, issuesIgnored: 0, tasksCreated: [], tasksExisting: [],
    rejected: [], commentsPosted: 0, held: [], labelsChanged: 0, errors: [], messagesSent: 0,
  };
}

/**
 * Un tour de sondage.
 *
 * Borné : une page d'issues, au plus `maxIssuesPerPoll` issues qui demandent
 * une écriture. Une issue dont tout est déjà publié ne coûte qu'une lecture
 * dans la liste. Une erreur GitHub sur la liste arrête le tour sans rien créer ;
 * une erreur sur une issue n'arrête que cette issue.
 */
export async function runControllerPoll(deps: ControllerDeps): Promise<ControllerPollReport> {
  const { repos, config, logger } = deps;
  const report = emptyReport();
  const env = deps.env ?? process.env;
  const readiness = controllerReadiness(config, env);
  if (!readiness.ready) {
    report.skipped = readiness.reasons;
    logger.info('pont contrôleur : fermé, aucun appel GitHub', { reasons: readiness.reasons });
    return report;
  }

  const repo = config.controller.repo;
  const authors = new Set(config.controller.authors.map((a) => a.toLowerCase()));
  const actor = deps.actor ?? 'controller-bridge';
  let github: ControllerGithub;
  try {
    github = deps.github ?? createGithubClient({ repo, token: readControllerToken(env)! });
  } catch (error) {
    report.errors.push(describe(error));
    return report;
  }
  const redact = (text: string) => github.redact(text);
  const marker = (key: string) => resultMarker(key, config.security.sessionSecret);

  let issues: GithubIssue[];
  try {
    issues = await github.listOpenIssues(config.controller.label, 100);
  } catch (error) {
    report.errors.push(redact(describe(error)));
    logger.warn('pont contrôleur : GitHub indisponible, aucune tâche créée', { error: redact(describe(error)) });
    return report;
  }
  report.ran = true;
  report.issuesSeen = issues.length;

  /**
   * Publier un commentaire au plus une fois par clé — à deux sondeurs comme
   * après un arrêt.
   *
   * La réservation précède le POST : c'est elle, et non la lecture qui la
   * précède, qui désigne le seul sondeur autorisé à publier. Une réservation
   * trouvée sans confirmation — un autre sondeur en vol, un arrêt entre la
   * réservation et la confirmation, un échec consigné — n'est jamais
   * republiée : le marqueur signé est cherché, confirmé s'il est là ; sinon la
   * publication est retenue, et c'est une personne qui décide.
   *
   * `blockedBy` : une réservation qui rend ce commentaire caduc — un refus ne
   * se publie pas sur une issue déjà prise par une tâche.
   */
  const publishOnce = async (
    issue: number, key: string, kind: string, taskId: string | null, result: ControllerResult, blockedBy: string | null = null,
  ): Promise<'done' | 'posted' | 'reconciled' | 'held' | 'superseded'> => {
    const existing = repos.tasks.externalOperation(key);
    if (existing?.confirmed) return 'done';
    const signature = marker(key);
    const already = (await github.listComments(issue)).find((c) => c.body.includes(signature));
    const reservation = existing ? null : repos.tasks.reserveExternalOperation({
      idempotencyKey: key, kind, taskId, target: `${repo}#${issue}`, summary: result.state, claimedBy: actor, blockedBy,
    });
    if (reservation?.blocked) return 'superseded';
    if (reservation?.confirmed) return 'done';
    if (already) {
      repos.tasks.confirmExternalOperation({ idempotencyKey: key, phase: 'CONFIRMED', externalRef: String(already.id) });
      return 'reconciled';
    }
    if (!reservation?.reserved) {
      report.held.push(`#${issue} ${key}${existing?.failed ? ' (échec consigné)' : ''}`);
      logger.warn('pont contrôleur : publication engagée sans marqueur signé, retenue', { issue, key, failed: existing?.failed ?? false });
      return 'held';
    }
    let id: number;
    try {
      ({ id } = await github.createComment(issue, renderResultComment(result, signature, redact)));
    } catch (error) {
      // La place reste prise : GitHub a pu publier avant de répondre. Le
      // prochain tour cherchera le marqueur, et ne republiera pas sans lui.
      repos.tasks.confirmExternalOperation({ idempotencyKey: key, phase: 'FAILED', error: redact(describe(error)).slice(0, 500) });
      throw error;
    }
    report.commentsPosted += 1;
    repos.tasks.confirmExternalOperation({ idempotencyKey: key, phase: 'CONFIRMED', externalRef: String(id) });
    return 'posted';
  };

  /** Une seule étiquette d'état : retirer les autres, poser la bonne. */
  const reconcileLabels = async (issue: GithubIssue, state: ControllerState): Promise<void> => {
    const wanted = STATE_LABELS[state];
    const stale = Object.values(STATE_LABELS).filter((l) => l !== wanted && issue.labels.includes(l));
    for (const label of stale) {
      await github.removeLabel(issue.number, label);
      report.labelsChanged += 1;
    }
    if (!issue.labels.includes(wanted)) {
      await github.addLabels(issue.number, [wanted]);
      report.labelsChanged += 1;
    }
  };

  const followUp = async (issue: GithubIssue, taskId: string): Promise<boolean> => {
    const task = repos.tasks.byId(taskId);
    if (!task) {
      report.errors.push(`#${issue.number} : tâche ${taskId} introuvable`);
      return false;
    }
    const state = controllerStateOf(task);
    const needsComment = COMMENTED_STATES.includes(state) && !repos.tasks.externalOperation(resultKey(taskId, state))?.confirmed;
    const needsLabel = !issue.labels.includes(STATE_LABELS[state])
      || Object.values(STATE_LABELS).some((l) => l !== STATE_LABELS[state] && issue.labels.includes(l));
    if (!needsComment && !needsLabel) return false;
    // Une publication retenue n'écrit rien : elle ne compte pas dans le
    // plafond du tour, et n'affame pas les issues suivantes.
    let wrote = needsLabel;
    if (needsComment) {
      const published = await publishOnce(issue.number, resultKey(taskId, state), CONTROLLER_LEDGER.RESULT, taskId,
        resultForTask(task, repo, issue.number, state, deps));
      wrote ||= published === 'posted' || published === 'reconciled';
    }
    await reconcileLabels(issue, state);
    return wrote;
  };

  const publishRejection = async (issue: GithubIssue, verdict: Extract<EnvelopeVerdict, { ok: false }>): Promise<boolean> => {
    const key = rejectKey(repo, issue.number, issue.body);
    const claimKey = intakeKey(repo, issue.number);
    const needsComment = !repos.tasks.externalOperation(key)?.confirmed;
    const needsLabel = !issue.labels.includes(STATE_LABELS.REJECTED);
    if (!needsComment && !needsLabel) return false;
    // Un autre sondeur a pu prendre l'issue sur une version valide du corps
    // pendant que celui-ci lisait une version refusée : la tâche l'emporte, on
    // la suit au lieu de la contredire.
    const superseded = (): Promise<boolean> => {
      const taskId = repos.tasks.externalOperation(claimKey)?.taskId;
      logger.info('pont contrôleur : refus caduc, l’issue est déjà prise', { issue: issue.number, taskId });
      return taskId ? followUp(issue, taskId) : Promise.resolve(false);
    };
    let wrote = needsLabel;
    if (needsComment) {
      const published = await publishOnce(issue.number, key, CONTROLLER_LEDGER.REJECT, null, buildControllerResult({
        state: 'REJECTED', repo, issue: issue.number, correlationId: verdict.correlationId,
        summary: `enveloppe refusée : ${verdict.code}`, errorCode: verdict.code, reasons: verdict.reasons,
      }), claimKey);
      if (published === 'superseded') return superseded();
      wrote ||= published === 'posted' || published === 'reconciled';
    }
    // Les étiquettes se corrigent au tour suivant ; relire la prise juste
    // avant d'écrire évite seulement de les faire osciller.
    if (repos.tasks.externalOperation(claimKey)?.taskId) return superseded();
    report.rejected.push(issue.number);
    logger.info('pont contrôleur : enveloppe refusée', { issue: issue.number, code: verdict.code });
    await reconcileLabels(issue, 'REJECTED');
    return wrote;
  };

  const intake = async (issue: GithubIssue): Promise<boolean> => {
    const verdict = parseControllerIssue(issue.body, { repo, issue: issue.number, config });
    if (!verdict.ok) return publishRejection(issue, verdict);

    // Le routage existant, et lui seul, désigne le worker. Le pont n'a pas
    // d'avis : si la table cessait de nommer Claude Code, il refuserait
    // plutôt que d'envoyer une tâche d'écriture ailleurs.
    const route = routeTask(CONTROLLER_ACCEPTED_TASK_TYPE);
    if (route.target !== 'CLAUDE_CODE') {
      report.errors.push(`#${issue.number} : ${CONTROLLER_ACCEPTED_TASK_TYPE} routée vers ${route.target}, refus`);
      return false;
    }

    const { envelope, limits, fingerprint } = verdict;
    // La tâche et le lien issue → tâche naissent dans la même transaction, et
    // seulement si l'issue n'a pas déjà été prise : deux sondeurs, ou deux
    // versions du corps lues à quelques instants d'écart, ne font jamais deux
    // tâches. La lecture faite avant d'entrer ici n'est qu'un raccourci.
    const claim = repos.tasks.createClaimedTask({
      taskType: CONTROLLER_ACCEPTED_TASK_TYPE,
      department: 'ENGINEERING',
      workerType: route.target,
      priority: 10,
      // Une tentative : une demande contrôleur ne relance pas seule une
      // mission facturée. Une pause de quota ne consomme pas de tentative.
      maxAttempts: 1,
      idempotencyKey: taskIdempotencyKey(fingerprint),
      correlationId: envelope.correlation_id,
      fingerprint: taskFingerprint({ taskType: CONTROLLER_ACCEPTED_TASK_TYPE, objective: envelope.objective, target: repo }),
      metadata: { source: 'controller-bridge', repo, issue: issue.number, fingerprint },
      payload: {
        objective: envelope.objective,
        allowed_paths: envelope.allowed_paths,
        test_commands: envelope.test_commands,
        acceptance_criteria: envelope.acceptance_criteria,
        constraints: [...envelope.constraints, ...FIXED_CONSTRAINTS],
        limits: limits.effective,
        repo_target: repo,
        context: `Demande reçue par le pont contrôleur (${repo}#${issue.number}, ${CONTROLLER_TASK_SCHEMA}).`,
        controller: {
          schema: CONTROLLER_TASK_SCHEMA,
          repo,
          issue: issue.number,
          correlation_id: envelope.correlation_id,
          fingerprint,
          author: issue.author.toLowerCase(),
          requested_limits: limits.requested,
          system_limits: limits.system,
          clamped_limits: limits.clamped,
          autonomous: envelope.autonomous,
          apply: false, push: false, deploy: false,
        },
        // L'objectif autonome, sur demande seulement : le superviseur GPT
        // l'adoptera à la première revue. Sans ce bloc, rien ne change.
        ...(envelope.autonomous
          ? {
            supervisor: {
              schema: SUPERVISOR_OBJECTIVE_SCHEMA, objective_id: objectiveIdFor(`controller:${fingerprint}`), cycle: 1,
              source: 'controller-bridge', apply: false, push: false, deploy: false,
            },
          }
          : {}),
      },
    }, {
      idempotencyKey: intakeKey(repo, issue.number), kind: CONTROLLER_LEDGER.INTAKE,
      target: `${repo}#${issue.number}`, summary: fingerprint, claimedBy: actor,
    });
    if (!claim.claimed) {
      logger.info('pont contrôleur : issue déjà prise, aucune tâche créée', { issue: issue.number, taskId: claim.taskId });
      if (!claim.taskId) {
        report.errors.push(`#${issue.number} : issue consignée sans tâche, rien n’est créé`);
        return false;
      }
      return followUp(issue, claim.taskId);
    }
    (claim.created ? report.tasksCreated : report.tasksExisting).push(claim.task.taskId);
    logger.info('pont contrôleur : tâche d’ingénierie posée', {
      issue: issue.number, taskId: claim.task.taskId, created: claim.created, worker: route.target,
    });
    await followUp(issue, claim.task.taskId);
    return true;
  };

  let worked = 0;
  for (const issue of issues) {
    if (worked >= config.controller.maxIssuesPerPoll) {
      report.skipped.push(`plafond de ${config.controller.maxIssuesPerPoll} issue(s) par tour atteint`);
      break;
    }
    // Ce que le pont ignore, il l'ignore sans écrire : ni commentaire, ni
    // étiquette. Répondre à un inconnu serait déjà lui obéir un peu.
    if (issue.isPullRequest || !issue.labels.includes(config.controller.label) || !authors.has(issue.author.toLowerCase())) {
      report.issuesIgnored += 1;
      continue;
    }
    try {
      const known = repos.tasks.externalOperation(intakeKey(repo, issue.number));
      const acted = known?.taskId ? await followUp(issue, known.taskId) : await intake(issue);
      if (acted) worked += 1;
    } catch (error) {
      worked += 1;
      const message = redact(describe(error));
      report.errors.push(`#${issue.number} : ${message}`);
      logger.warn('pont contrôleur : issue en erreur', { issue: issue.number, error: message });
    }
  }
  return report;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
