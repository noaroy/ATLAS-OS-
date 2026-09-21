import { spawn } from 'node:child_process';
import type { AiProvider, AiCapability } from '@atlas/llm';
import type { Repositories, TaskRow } from '@atlas/data';
import type { Worker, WorkerContext, WorkerOutcome } from './workers.ts';
import {
  validateAiResult,
  checkCommand,
  redactSecrets,
  type AiTaskResult,
} from './ai-contracts.ts';
import { runEngineeringTask } from './engineering.ts';
import { removeWorkspace, repoRootOf } from './workspace.ts';

/**
 * Les deux workers de modèle.
 *
 * Ils partagent tout ce qui compte : la traduction d'une erreur fournisseur en
 * décision, la validation du résultat, la comptabilisation de l'usage. Ce qui
 * les distingue est ce qu'ils ont le droit de faire — l'un lit, l'autre écrit —
 * et cela se voit dans leurs permissions, pas dans leur code d'appel.
 *
 * Aucun des deux ne crée de tâche. Ils *proposent* des suites dans leur
 * résultat ; c'est le routeur qui décide de les créer, après avoir vérifié les
 * bornes. La distinction est ce qui empêche deux modèles de s'échanger du
 * travail jusqu'à épuisement du budget.
 */

const MAX_CONTEXT_CHARS = 40_000;

export interface AiWorkerOptions {
  repos: Repositories;
  provider: AiProvider;
  timeoutMs: number;
  maxOutputTokens?: number;
}

/**
 * Le contexte envoyé au modèle, borné et tracé.
 *
 * Jamais le dépôt entier : la charge utile porte des références, et seules les
 * références demandées sont lues. La coupe est signalée dans le texte plutôt
 * que silencieuse — un modèle qui raisonne sur un fichier tronqué sans le
 * savoir produit une réponse assurée et fausse.
 */
function buildContext(task: TaskRow): { text: string; chars: number; truncated: boolean } {
  const payload = task.payload as Record<string, unknown>;
  const parts: string[] = [];

  const add = (label: string, value: unknown) => {
    if (value == null) return;
    const rendered = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (rendered.trim()) parts.push(`## ${label}\n${rendered}`);
  };

  add('Objectif', payload.objective);
  add('Critères d’acceptation', payload.acceptance_criteria);
  add('Contraintes', payload.constraints);
  add('Références dépôt', payload.repo_refs);
  add('Références fichiers', payload.file_refs);
  add('Références symboles', payload.symbol_refs);
  add('Références graphe', payload.graph_refs);
  add('Contexte', payload.context);
  add('Résultats de tests', payload.test_results);
  add('Limites connues', payload.known_limitations);

  const joined = parts.join('\n\n');
  const truncated = joined.length > MAX_CONTEXT_CHARS;
  return {
    text: truncated
      ? `${joined.slice(0, MAX_CONTEXT_CHARS)}\n\n[contexte tronqué à ${MAX_CONTEXT_CHARS} caractères]`
      : joined,
    chars: joined.length,
    truncated,
  };
}

const RESULT_INSTRUCTIONS = `Réponds UNIQUEMENT par un objet JSON, sans texte autour, de cette forme :
{
  "status": "PASS" | "PASS_WITH_NOTES" | "CHANGES_REQUIRED" | "NEEDS_HUMAN" | "DONE" | "FAILED",
  "summary": "une phrase",
  "confidence": 0.0 à 1.0,
  "findings": [{ "severity": "INFO|WARN|ERROR", "detail": "...", "reference": "fichier:ligne" }],
  "recommendations": ["..."],
  "next_tasks": [{ "task_type": "...", "objective": "...", "rationale": "..." }],
  "artifacts": [{ "kind": "file", "ref": "chemin" }]
}`;

/**
 * Traduire un échec d'appel en décision de file.
 *
 * Le point délicat : une limitation ne doit pas consommer de tentative, et une
 * clé refusée ne doit pas être retentée. Les deux se ressemblent dans un
 * journal et demandent l'inverse l'une de l'autre.
 */
function outcomeForError(provider: AiProvider, error: unknown): WorkerOutcome {
  const verdict = provider.classifyError(error);
  switch (verdict.kind) {
    case 'RATE_LIMITED':
    case 'QUOTA_EXHAUSTED':
      return {
        kind: 'PAUSED_QUOTA',
        provider: provider.provider,
        errorCode: verdict.kind,
        // Le message est nettoyé : une réponse d'erreur peut contenir un
        // fragment de la requête, et cette chaîne finit en base.
        errorMessage: redactSecrets(verdict.message).slice(0, 400),
        retryAfterHeader: verdict.retryAfterHeader,
        rateLimitResetHeader: verdict.rateLimitResetHeader,
      };
    case 'AUTH_ERROR':
      // Aucune attente ne répare une clé refusée. Réessayer serait une boucle
      // silencieuse et gratuite en apparence — sauf qu'elle occupe la file.
      return {
        kind: 'WAITING_HUMAN',
        errorCode: 'AUTH_ERROR',
        errorMessage:
          `${provider.provider} refuse l'authentification. `
          + 'Une intervention humaine est nécessaire : aucune reprise automatique.',
      };
    default:
      return {
        kind: 'FAILED',
        errorCode: verdict.kind,
        errorMessage: redactSecrets(verdict.message).slice(0, 400),
      };
  }
}

/** Consigner l'usage, quel que soit le sort de l'appel. */
function recordUsage(
  repos: Repositories,
  task: TaskRow,
  provider: AiProvider,
  capability: AiCapability,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number;
           costUsd: number | null; costBasis: string },
  durationMs: number,
  outcome: string,
  errorCode?: string | null,
): void {
  repos.tasks.recordAiCall({
    taskId: task.taskId,
    chainId: task.chainId,
    provider: provider.provider,
    model: provider.model,
    capability,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    costUsd: usage.costUsd,
    costBasis: usage.costBasis,
    durationMs,
    outcome,
    errorCode: errorCode ?? null,
  });
}

/**
 * Le worker OpenAI : il raisonne, il ne touche à rien.
 *
 * Lecture seule par construction — il n'a aucun moyen d'écrire un fichier ni de
 * lancer une commande. Ce n'est pas une politique qu'il faut vérifier : c'est
 * une capacité qu'il n'a pas.
 */
export class OpenAiWorker implements Worker {
  readonly type = 'OPENAI';
  readonly capabilities: readonly string[] = [
    'REASONING', 'REVIEW', 'COMMERCIAL_ANALYSIS',
    'AMBIGUITY_RESOLUTION', 'PLANNING', 'STRUCTURED_EXTRACTION',
    'ARCHITECTURE_REVIEW', 'FINAL_REVIEW',
  ];

  constructor(private readonly options: AiWorkerOptions) {}

  canHandle(task: TaskRow): boolean {
    return task.workerType === 'OPENAI';
  }

  async execute(task: TaskRow, context: WorkerContext): Promise<WorkerOutcome> {
    const { repos, provider } = this.options;
    const status = provider.status();
    if (!status.configured) {
      return {
        kind: 'WAITING_HUMAN',
        errorCode: status.code,
        errorMessage: status.detail,
      };
    }

    const capability = (task.payload.capability as AiCapability) ?? 'REASONING';
    const built = buildContext(task);
    const startedAt = Date.now();

    let response;
    try {
      response = await provider.execute({
        system:
          'Tu es un relecteur au sein d’ATLAS. Tu analyses, tu ne modifies rien. '
          + 'Tu ne disposes d’aucun outil d’écriture ni d’envoi. '
          + RESULT_INSTRUCTIONS,
        prompt: built.text || String(task.payload.objective ?? task.taskType),
        responseSchema: { type: 'object' },
        maxOutputTokens: this.options.maxOutputTokens ?? 2_000,
        timeoutMs: this.options.timeoutMs,
        capability,
        // La clé est stable pour la tâche et la tentative : un retry après
        // coupure réseau ne se paie pas deux fois côté fournisseur.
        idempotencyKey: `${task.taskId}:${task.attemptCount}`,
      });
    } catch (error) {
      const outcome = outcomeForError(provider, error);
      recordUsage(
        repos, task, provider, capability,
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: null, costBasis: 'UNKNOWN_PRICE' },
        Date.now() - startedAt, outcome.kind, outcome.errorCode,
      );
      return outcome;
    }

    context.heartbeat();
    recordUsage(repos, task, provider, capability, response.usage, response.durationMs, 'OK');

    const check = validateAiResult(response.structured);
    if (!check.valid) {
      // Un schéma invalide est retentable — un modèle se reprend souvent au
      // second essai. Mais borné par max_attempts : après quoi la file passera
      // la main plutôt que d'insister.
      return {
        kind: 'FAILED',
        errorCode: 'SCHEMA_INVALID',
        errorMessage: `sortie non conforme : ${check.violations.join(' · ')}`,
        costUsd: response.usage.costUsd,
      };
    }

    return {
      kind: check.value!.status === 'NEEDS_HUMAN' ? 'WAITING_HUMAN' : 'DONE',
      result: {
        ...check.value,
        input_context_chars: built.chars,
        context_truncated: built.truncated,
        provider: provider.provider,
        model: response.model,
      } as unknown as Record<string, unknown>,
      costUsd: response.usage.costUsd,
      errorMessage:
        check.value!.status === 'NEEDS_HUMAN' ? check.value!.summary : undefined,
    };
  }
}

export interface ClaudeWorkerOptions extends AiWorkerOptions {
  /** La racine du dépôt sur laquelle les commandes autorisées s'exécutent. */
  workspaceRoot: string;
  /** Clé du verrou d'écriture. Une seule tâche mutante à la fois. */
  repoLockKey?: string;
  /**
   * Où poser les worktrees. Un répertoire temporaire si rien n'est donné.
   *
   * Séparé de `workspaceRoot` à dessein : l'un est le dépôt qu'on lit, l'autre
   * l'endroit où l'on écrit. Les confondre ferait écrire dans le dépôt.
   */
  worktreeRoot?: string;
  maxIterations?: number;
  maxFilesChanged?: number;
  maxDiffLines?: number;
  allowFileDelete?: boolean;
}

/**
 * Le worker Claude : ingénierie, sous verrou.
 *
 * Deux protections le distinguent, et aucune n'est optionnelle.
 *
 * La première est le verrou d'écriture : une seule tâche mutante à la fois sur
 * le même espace de travail. Deux agents qui modifient les mêmes fichiers en
 * parallèle produisent un état que ni l'un ni l'autre n'a voulu, et que les
 * tests ne décrivent plus.
 *
 * La seconde est la liste blanche de commandes, avec mise à mort de
 * l'arborescence complète au délai. La démonstration précédente a montré que
 * tuer le wrapper ne suffit pas : le processus enfant survit, continue de
 * travailler, et le système croit l'avoir arrêté.
 */
export class ClaudeWorker implements Worker {
  readonly type = 'CLAUDE';
  readonly capabilities: readonly string[] = [
    'ENGINEERING', 'DEBUGGING', 'REPO_ANALYSIS', 'TESTING',
    'BUILD_VALIDATION', 'CODE_REVIEW', 'REFACTOR',
  ];

  constructor(private readonly options: ClaudeWorkerOptions) {}

  canHandle(task: TaskRow): boolean {
    return task.workerType === 'CLAUDE';
  }

  private get lockKey(): string {
    return this.options.repoLockKey ?? 'REPO_WRITE';
  }

  /** Cette tâche modifie-t-elle le dépôt ? Seules celles-là prennent le verrou. */
  private mutates(task: TaskRow): boolean {
    return task.taskType === 'ENGINEERING_CHANGE' || Boolean(task.payload.allowed_paths);
  }

  /**
   * Le vrai travail d'ingénierie : worktree isolé, éditions vérifiées, diff.
   *
   * Séparé du chemin d'analyse parce que les deux n'ont pas les mêmes droits ni
   * les mêmes issues. Une analyse rend un avis ; ceci produit un patch, et le
   * patch attend une décision humaine avant de toucher au dépôt.
   */
  private async engineer(task: TaskRow, context: WorkerContext): Promise<WorkerOutcome> {
    const { repos, provider } = this.options;

    // Les commandes demandées passent en premier, avant même de chercher le
    // dépôt. Un refus de sécurité doit être rapporté pour ce qu'il est :
    // annoncer « pas un dépôt git » quand le vrai problème est une commande
    // interdite envoie la lecture sur une fausse piste.
    const requested = Array.isArray(task.payload.test_commands)
      ? (task.payload.test_commands as unknown[]).map(String)
      : [];
    for (const command of requested) {
      const verdict = checkCommand(command);
      if (!verdict.allowed) {
        return {
          kind: 'FAILED',
          errorCode: 'COMMAND_NOT_ALLOWED',
          errorMessage: verdict.reason,
        };
      }
    }

    const repoRoot = repoRootOf(this.options.workspaceRoot);
    if (!repoRoot) {
      return {
        kind: 'FAILED',
        errorCode: 'NOT_A_REPOSITORY',
        errorMessage: `${this.options.workspaceRoot} n'est pas un dépôt git`,
      };
    }

    const outcome = await runEngineeringTask(task, {
      repos,
      provider,
      logger: context.logger,
      repoRoot,
      workspaceRoot: this.options.worktreeRoot,
      timeoutMs: this.options.timeoutMs,
      maxIterations: this.options.maxIterations ?? 3,
      maxFiles: this.options.maxFilesChanged ?? 15,
      maxLines: this.options.maxDiffLines ?? 800,
      allowDelete:
        this.options.allowFileDelete === true
        || task.payload.ALLOW_FILE_DELETE === true,
    });
    context.heartbeat();

    // Une erreur de fournisseur est traduite ici, pas dans le module
    // d'ingénierie : une limitation de débit doit mettre la tâche en pause,
    // sans consommer de tentative ni réveiller personne.
    if (outcome.providerError) {
      if (outcome.workspace) removeWorkspace(repoRoot, outcome.workspace);
      return outcomeForError(provider, outcome.providerError);
    }

    if (!outcome.workspace) {
      return { kind: 'FAILED', errorCode: 'WORKSPACE_UNAVAILABLE', errorMessage: outcome.reason };
    }

    repos.tasks.openWorkspace({
      workspaceId: outcome.workspace.workspaceId,
      taskId: task.taskId,
      baseCommit: outcome.workspace.baseCommit,
      branch: outcome.workspace.branch,
      path: outcome.workspace.path,
    });

    const artifacts: Array<{ kind: string; ref: string }> = [];
    const keep = (kind: string, content: string) => {
      if (!content.trim()) return;
      artifacts.push({
        kind,
        ref: repos.tasks.saveArtifact({
          taskId: task.taskId, workspaceId: outcome.workspace!.workspaceId, kind, content,
        }),
      });
    };
    keep('PLAN', outcome.plan);
    if (outcome.diff) keep('DIFF', outcome.diff.diff);
    if (outcome.commands.length > 0) {
      const report = outcome.commands
        .map((c) => `$ ${c.command}\n${c.output}`)
        .join('\n\n');
      keep('TEST_REPORT', report);
    }

    const base = {
      plan: outcome.plan,
      baseline: outcome.baseline,
      iterations: outcome.iterations,
      files_changed: outcome.diff?.filesChanged ?? [],
      files_added: outcome.diff?.filesAdded ?? [],
      files_deleted: outcome.diff?.filesDeleted ?? [],
      diff_summary: outcome.diff?.stat ?? '',
      diff_lines: outcome.diff?.diffLines ?? 0,
      diff_hash: outcome.diff?.diffHash ?? null,
      commands_run: outcome.commands.map((c) => ({ command: c.command, code: c.code })),
      edits_applied: outcome.editsApplied,
      edits_refused: outcome.editsRefused,
      workspace_id: outcome.workspace.workspaceId,
      base_commit: outcome.workspace.baseCommit,
      artifacts,
      summary: outcome.result?.summary ?? outcome.reason,
    };

    // Une sortie de périmètre ne se corrige pas au tour suivant : le worktree
    // est abandonné, et son diff ne sera jamais appliqué.
    if (outcome.securityViolations.length > 0) {
      keep('SECURITY_REPORT', JSON.stringify(outcome.securityViolations, null, 2));
      repos.tasks.setWorkspaceState({
        workspaceId: outcome.workspace.workspaceId, state: 'ABANDONED',
      });
      removeWorkspace(repoRoot, outcome.workspace);
      return {
        kind: 'FAILED',
        errorCode: 'SECURITY_VIOLATION',
        errorMessage: outcome.reason,
        result: { ...base, security_violations: outcome.securityViolations },
      };
    }

    if (outcome.phase === 'BLOCKED') {
      repos.tasks.setWorkspaceState({
        workspaceId: outcome.workspace.workspaceId,
        state: 'READY_FOR_REVIEW',
        diffHash: outcome.diff?.diffHash ?? null,
        filesChanged: (outcome.diff?.filesChanged.length ?? 0) + (outcome.diff?.filesAdded.length ?? 0),
        diffLines: outcome.diff?.diffLines ?? 0,
      });
      // Budget dépassé ou itérations épuisées : la tâche attend un humain
      // plutôt que d'insister ou d'échouer. Le travail fait reste consultable.
      return {
        kind: 'WAITING_HUMAN',
        errorCode: outcome.reason.split(' :')[0],
        errorMessage: outcome.reason,
        result: base,
      };
    }

    repos.tasks.setWorkspaceState({
      workspaceId: outcome.workspace.workspaceId,
      state: 'READY_FOR_REVIEW',
      diffHash: outcome.diff!.diffHash,
      filesChanged: outcome.diff!.filesChanged.length + outcome.diff!.filesAdded.length,
      diffLines: outcome.diff!.diffLines,
    });

    // Le coût réel de la tâche, pas celui d'un seul appel : une tâche
    // d'ingénierie itère, et chaque itération a été facturée séparément dans
    // `ai_calls`. Le sommer ici est ce qui évite qu'un travail réellement payé
    // apparaisse gratuit dans `task.actualCost` — et donc dans tout ce qui en
    // dérive (verdict de l'Autopilot, tableau de bord des coûts).
    const spend = repos.tasks.chainCost(task.chainId ?? task.taskId);
    return {
      kind: 'DONE',
      result: { ...base, status: 'ENGINEERING_READY_FOR_REVIEW' },
      costUsd: spend.calls > 0 ? spend.knownUsd : null,
    };
  }

  async execute(task: TaskRow, context: WorkerContext): Promise<WorkerOutcome> {
    const { repos, provider } = this.options;
    const status = provider.status();
    if (!status.configured) {
      return { kind: 'WAITING_HUMAN', errorCode: status.code, errorMessage: status.detail };
    }

    const needsLock = this.mutates(task);
    let lockOwner: string | null = null;

    if (needsLock) {
      const owner = `${task.taskId}`;
      const lock = repos.tasks.acquireRepoLock({
        lockKey: this.lockKey,
        taskId: task.taskId,
        owner,
        mode: 'WRITE',
        leaseMs: this.options.timeoutMs + 60_000,
      });
      if (!lock.acquired) {
        // Pas un échec : une autre tâche d'ingénierie travaille. Celle-ci
        // repassera, et n'a pas à brûler de tentative pour avoir attendu.
        return {
          kind: 'PAUSED_QUOTA',
          provider: 'REPO_LOCK',
          errorCode: 'REPO_LOCKED',
          errorMessage: `verrou d'écriture ${lock.reason}`,
          retryAfterHeader: '60',
        };
      }
      lockOwner = owner;
    }

    try {
      // Une tâche d'ingénierie passe par le chemin réel — worktree, éditions,
      // diff. Les autres restent sur l'analyse, qui n'écrit rien.
      return task.taskType === 'ENGINEERING_CHANGE'
        ? await this.engineer(task, context)
        : await this.run(task, context);
    } finally {
      if (lockOwner) repos.tasks.releaseRepoLock(this.lockKey, lockOwner);
    }
  }

  private async run(task: TaskRow, context: WorkerContext): Promise<WorkerOutcome> {
    const { repos, provider } = this.options;
    const capability = (task.payload.capability as AiCapability) ?? 'ENGINEERING';
    const built = buildContext(task);
    const startedAt = Date.now();

    // Les commandes demandées sont vérifiées AVANT tout appel de modèle :
    // découvrir qu'une commande est interdite après avoir payé l'analyse
    // serait payer pour rien.
    const requested = Array.isArray(task.payload.test_commands)
      ? (task.payload.test_commands as unknown[]).map(String)
      : [];
    for (const command of requested) {
      const verdict = checkCommand(command);
      if (!verdict.allowed) {
        return {
          kind: 'FAILED',
          errorCode: 'COMMAND_NOT_ALLOWED',
          errorMessage: verdict.reason,
        };
      }
    }

    let response;
    try {
      response = await provider.execute({
        system:
          'Tu es un agent d’ingénierie au sein d’ATLAS. Tu travailles uniquement dans '
          + 'les chemins autorisés, tu ne lances que les commandes autorisées, et tu ne '
          + 'touches ni aux secrets, ni aux envois, ni aux paiements. '
          + RESULT_INSTRUCTIONS,
        prompt: built.text || String(task.payload.objective ?? task.taskType),
        responseSchema: { type: 'object' },
        maxOutputTokens: this.options.maxOutputTokens ?? 4_000,
        timeoutMs: this.options.timeoutMs,
        capability,
        idempotencyKey: `${task.taskId}:${task.attemptCount}`,
      });
    } catch (error) {
      const outcome = outcomeForError(provider, error);
      recordUsage(
        repos, task, provider, capability,
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: null, costBasis: 'UNKNOWN_PRICE' },
        Date.now() - startedAt, outcome.kind, outcome.errorCode,
      );
      return outcome;
    }

    context.heartbeat();
    recordUsage(repos, task, provider, capability, response.usage, response.durationMs, 'OK');

    const check = validateAiResult(response.structured);
    if (!check.valid) {
      return {
        kind: 'FAILED',
        errorCode: 'SCHEMA_INVALID',
        errorMessage: `sortie non conforme : ${check.violations.join(' · ')}`,
        costUsd: response.usage.costUsd,
      };
    }

    // Les commandes de vérification tournent après l'analyse, dans l'espace de
    // travail, avec un battement entre chacune : une suite de tests longue ne
    // doit pas faire expirer le bail d'une tâche parfaitement saine.
    const commandResults: Array<{ command: string; code: number | null; output: string }> = [];
    for (const command of requested) {
      if (context.shuttingDown()) break;
      const outcome = await runAllowedCommand(command, this.options.workspaceRoot, this.options.timeoutMs);
      commandResults.push(outcome);
      context.heartbeat();
    }

    const failed = commandResults.find((r) => r.code !== 0);
    return {
      kind: failed ? 'FAILED' : check.value!.status === 'NEEDS_HUMAN' ? 'WAITING_HUMAN' : 'DONE',
      result: {
        ...check.value,
        commands_run: commandResults,
        input_context_chars: built.chars,
        context_truncated: built.truncated,
        provider: provider.provider,
        model: response.model,
      } as unknown as Record<string, unknown>,
      costUsd: response.usage.costUsd,
      errorCode: failed ? 'COMMAND_FAILED' : undefined,
      errorMessage: failed ? `« ${failed.command} » a rendu ${failed.code}` : undefined,
    };
  }
}

/**
 * Lancer une commande autorisée, et la tuer vraiment si elle déborde.
 *
 * `detached` puis `kill(-pid)` : le signal part au groupe de processus entier.
 * Tuer seulement le processus lancé laisserait ses enfants tourner — c'est
 * exactement ce qui s'est produit lors d'une démonstration précédente, où un
 * `kill` sur le wrapper a laissé le vrai travail se poursuivre pendant que le
 * système le croyait arrêté.
 *
 * Sur Windows, les groupes n'existent pas de la même façon : on retombe sur
 * `taskkill /T`, qui parcourt l'arborescence. Le comportement est le même, le
 * mécanisme non — et c'est dit ici plutôt que découvert.
 */
export async function runAllowedCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ command: string; code: number | null; output: string; pid: number | null }> {
  const verdict = checkCommand(command);
  if (!verdict.allowed) {
    return { command, code: 126, output: verdict.reason, pid: null };
  }

  const [file, ...args] = command.split(' ');
  const useShell = process.platform === 'win32';
  return new Promise((resolve) => {
    // Sous shell, la commande passe entière plutôt qu'en arguments séparés :
    // Node avertit à juste titre que des arguments non échappés concaténés dans
    // un shell sont une porte d'entrée. Ici la commande sort d'une liste
    // blanche sans métacaractère — mais s'appuyer sur cette garantie pour
    // ignorer l'avertissement reviendrait à la rendre invisible au prochain
    // lecteur.
    const child = useShell
      ? spawn(command, { cwd, shell: true, env: process.env })
      : spawn(file!, args, {
      cwd,
      detached: true,
      // L'environnement est transmis tel quel : les commandes autorisées en ont
      // besoin (npm, git). La sortie, elle, est nettoyée avant d'être conservée.
      env: process.env,
    });

    let output = '';
    const capture = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 20_000) output = output.slice(-20_000);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    let settled = false;
    const finish = (code: number | null, note?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        code,
        output: redactSecrets(note ? `${output}\n${note}` : output).trim().slice(-8_000),
        pid: child.pid ?? null,
      });
    };

    const timer = setTimeout(() => {
      killTree(child.pid);
      finish(124, `[délai de ${timeoutMs} ms dépassé : arborescence de processus tuée]`);
    }, timeoutMs);

    child.on('error', (error) => finish(127, `[échec de lancement : ${error.message}]`));
    child.on('close', (code) => finish(code));
  });
}

/** Tuer un processus et toute sa descendance, selon la plateforme. */
export function killTree(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      // Le négatif vise le groupe : le processus et ses enfants.
      process.kill(-pid, 'SIGKILL');
    }
    return true;
  } catch {
    return false;
  }
}
