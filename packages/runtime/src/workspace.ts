import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync, mkdtempSync, symlinkSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { checkPath, auditChangedFiles, type PathGuardOptions } from './repo-guard.ts';
import { redactSecrets } from './ai-contracts.ts';

/**
 * L'espace où une tâche d'ingénierie a le droit d'écrire.
 *
 * Un worktree git par tâche, créé depuis un commit connu. Le dépôt principal
 * n'est jamais touché pendant le travail — il ne l'est qu'après une décision
 * explicite, et par un patch qu'un humain a relu.
 *
 * La raison tient en une phrase : le travail non commité d'une personne et
 * celui d'un agent ne se distinguent plus une fois mélangés, et aucune commande
 * git ne sait les démêler après coup. Le worktree n'est pas une précaution de
 * confort, c'est la seule façon de garder les deux séparables.
 */

export interface Workspace {
  workspaceId: string;
  taskId: string;
  path: string;
  baseCommit: string;
  branch: string;
}

export interface FileEdit {
  path: string;
  action: 'CREATE' | 'MODIFY' | 'DELETE';
  /** Absent pour une suppression. */
  content?: string;
}

export interface EditOutcome {
  applied: string[];
  refused: Array<{ path: string; reason: string; violation: string | null }>;
}

export interface DiffSummary {
  filesChanged: string[];
  filesAdded: string[];
  filesDeleted: string[];
  diffLines: number;
  diff: string;
  diffHash: string;
  stat: string;
}

const git = (args: string[], cwd: string, timeoutMs = 30_000): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });

/** L'empreinte d'un diff. Elle scelle ce qui a été relu. */
export function hashDiff(diff: string): string {
  return createHash('sha256').update(diff).digest('hex').slice(0, 32);
}

export type RepoCleanliness =
  | { clean: true; head: string }
  | { clean: false; head: string; dirtyFiles: string[] };

/**
 * Le dépôt principal porte-t-il du travail non sauvegardé ?
 *
 * Vérifié avant toute application. Écraser le travail de quelqu'un est le seul
 * dégât de cette mission qui ne se répare pas : un fichier modifié et jamais
 * commité n'existe nulle part ailleurs.
 */
export function inspectRepo(repoRoot: string): RepoCleanliness {
  const head = git(['rev-parse', 'HEAD'], repoRoot).trim();
  const status = git(['status', '--porcelain'], repoRoot).trim();
  if (!status) return { clean: true, head };
  return {
    clean: false,
    head,
    dirtyFiles: status.split('\n').map((line) => line.slice(2).trim()).filter(Boolean),
  };
}

export interface CreateWorkspaceOptions {
  repoRoot: string;
  taskId: string;
  /** Où poser les worktrees. Un répertoire temporaire par défaut. */
  root?: string;
  baseCommit?: string;
}

/**
 * Créer le worktree d'une tâche.
 *
 * La branche porte l'identifiant de tâche : deux tâches ne peuvent pas se
 * retrouver sur la même, et un worktree oublié se rattache à ce qui l'a créé.
 */
export function createWorkspace(options: CreateWorkspaceOptions): Workspace {
  const baseCommit = (options.baseCommit
    ?? git(['rev-parse', 'HEAD'], options.repoRoot)).trim();
  const root = options.root
    ?? mkdtempSync(join(tmpdir(), 'atlas-ws-'));
  mkdirSync(root, { recursive: true });

  const path = join(root, options.taskId);
  const branch = `atlas/${options.taskId}`;
  git(['worktree', 'add', '--detach', path, baseCommit], options.repoRoot, 120_000);
  git(['checkout', '-B', branch], path, 60_000);
  linkNodeModules(options.repoRoot, path);

  return { workspaceId: `ws_${options.taskId}`, taskId: options.taskId, path, baseCommit, branch };
}

/**
 * Les dépendances installées du dépôt, visibles depuis le worktree.
 *
 * Un worktree naît sans `node_modules` — c'est ignoré par git — et `npm test`
 * ou `npm run build` y échoueraient avant d'avoir jugé quoi que ce soit. Un
 * lien symbolique vers celles du dépôt suffit, et il est retiré avec le
 * worktree : `git worktree remove` délie, il ne suit pas.
 *
 * POSIX seulement. Sous Windows, une jonction est *traversée* par une
 * suppression récursive : retirer le worktree a déjà effacé les vraies
 * dépendances du dépôt. On ne le refait pas ; le poste Windows installe les
 * siennes.
 */
export function linkNodeModules(repoRoot: string, worktreePath: string): boolean {
  if (process.platform === 'win32') return false;
  const source = join(repoRoot, 'node_modules');
  const target = join(worktreePath, 'node_modules');
  if (!existsSync(source) || existsSync(target)) return false;
  try {
    symlinkSync(source, target, 'dir');
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Rendre le worktree.
 *
 * `--force` parce qu'un worktree contenant des modifications non commitées
 * refuse d'être retiré : c'est le cas normal ici, le travail vit dans le patch,
 * pas dans le worktree.
 */
export function removeWorkspace(repoRoot: string, workspace: Workspace): boolean {
  try {
    git(['worktree', 'remove', '--force', workspace.path], repoRoot, 60_000);
    return true;
  } catch {
    // Un worktree déjà disparu n'est pas une erreur : on nettoie la référence.
    try { git(['worktree', 'prune'], repoRoot); } catch { /* rien à faire */ }
    try { rmSync(workspace.path, { recursive: true, force: true }); } catch { /* idem */ }
    return false;
  }
}

/**
 * Appliquer les éditions proposées, chemin par chemin.
 *
 * Chaque écriture est vérifiée avant d'avoir lieu, jamais après. Une édition
 * refusée n'interrompt pas les autres — le refus est rapporté, et c'est
 * l'audit final qui décidera du sort de la tâche. Cela évite qu'une proposition
 * douteuse noyée dans dix bonnes fasse perdre tout le travail.
 *
 * La suppression est refusée par défaut : c'est la seule opération dont le
 * résultat est plus difficile à relire qu'à subir.
 */
export function applyEdits(
  workspace: Workspace,
  edits: readonly FileEdit[],
  options: { allowedPaths: readonly string[]; allowDelete: boolean },
): EditOutcome {
  const guard: PathGuardOptions = {
    workspaceRoot: workspace.path,
    allowedPaths: options.allowedPaths,
  };
  const applied: string[] = [];
  const refused: EditOutcome['refused'] = [];

  for (const edit of edits) {
    const verdict = checkPath(edit.path, guard);
    if (!verdict.allowed) {
      refused.push({ path: edit.path, reason: verdict.reason, violation: verdict.violation });
      continue;
    }
    if (edit.action === 'DELETE' && !options.allowDelete) {
      refused.push({
        path: edit.path,
        reason: 'suppression refusée : ALLOW_FILE_DELETE n’est pas activé pour cette tâche',
        violation: null,
      });
      continue;
    }

    const target = verdict.realPath!;
    try {
      if (edit.action === 'DELETE') {
        if (existsSync(target)) unlinkSync(target);
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, edit.content ?? '', 'utf8');
      }
      applied.push(edit.path);
    } catch (error) {
      refused.push({
        path: edit.path,
        reason: redactSecrets(error instanceof Error ? error.message : String(error)),
        violation: null,
      });
    }
  }
  return { applied, refused };
}

/**
 * Ce qui a réellement changé, vu par git.
 *
 * `git status --porcelain` plutôt que la liste des éditions demandées : une
 * commande autorisée peut avoir écrit un fichier au passage, et c'est
 * précisément ce qu'il faut voir. La confiance va à ce que le dépôt constate,
 * pas à ce que le modèle annonce.
 */
export function captureDiff(workspace: Workspace): DiffSummary {
  const status = git(['status', '--porcelain'], workspace.path).trim();
  const filesChanged: string[] = [];
  const filesAdded: string[] = [];
  const filesDeleted: string[] = [];

  for (const line of status.split('\n').filter(Boolean)) {
    const code = line.slice(0, 2);
    // Le format porcelain est `XY<espace>chemin`, mais la largeur de la
    // separation varie selon que la modification est indexee ou non. Decouper
    // a une position fixe mangeait la premiere lettre du chemin — assez pour
    // que l'audit de perimetre voie « ixture/add.ts » et le refuse comme hors
    // perimetre. On prend les deux caracteres d'etat, puis tout le reste.
    const path = line.slice(2).trim().replace(/^"|"$/g, '');
    if (code.includes('D')) filesDeleted.push(path);
    else if (code.includes('?') || code.includes('A')) filesAdded.push(path);
    else filesChanged.push(path);
  }

  // Les nouveaux fichiers sont indexés pour figurer dans le diff : sans cela,
  // un fichier créé n'apparaîtrait nulle part et le patch serait incomplet.
  if (filesAdded.length > 0) {
    try { git(['add', '-N', '--', ...filesAdded], workspace.path); } catch { /* rien */ }
  }

  const diff = git(['diff', 'HEAD'], workspace.path, 60_000);
  const stat = git(['diff', '--stat', 'HEAD'], workspace.path).trim();
  const diffLines = diff
    .split('\n')
    .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line)).length;

  return {
    filesChanged, filesAdded, filesDeleted,
    diffLines,
    diff: redactSecrets(diff),
    diffHash: hashDiff(diff),
    stat,
  };
}

export type ChangeBudgetVerdict =
  | { withinBudget: true; reason: string }
  | { withinBudget: false; reason: string; exceeded: 'FILES' | 'LINES' };

/**
 * Le diff tient-il dans ce qu'on avait accepté de changer ?
 *
 * Une mission simple qui réécrit la moitié du dépôt a mal compris sa mission,
 * et le dire tôt coûte moins cher que de relire deux mille lignes pour s'en
 * apercevoir. Le dépassement n'est pas un échec : la tâche attend un humain.
 */
export function checkChangeBudget(
  diff: DiffSummary,
  limits: { maxFiles: number; maxLines: number },
): ChangeBudgetVerdict {
  const total = diff.filesChanged.length + diff.filesAdded.length + diff.filesDeleted.length;
  if (total > limits.maxFiles) {
    return {
      withinBudget: false,
      exceeded: 'FILES',
      reason: `${total} fichiers touchés, plafond ${limits.maxFiles}`,
    };
  }
  if (diff.diffLines > limits.maxLines) {
    return {
      withinBudget: false,
      exceeded: 'LINES',
      reason: `${diff.diffLines} lignes modifiées, plafond ${limits.maxLines}`,
    };
  }
  return { withinBudget: true, reason: `${total} fichier(s), ${diff.diffLines} ligne(s)` };
}

/** Le périmètre a-t-il été respecté, une fois le travail fait ? */
export function auditWorkspace(
  workspace: Workspace,
  diff: DiffSummary,
  allowedPaths: readonly string[],
): { clean: boolean; violations: Array<{ path: string; reason: string }> } {
  return auditChangedFiles(
    [...diff.filesChanged, ...diff.filesAdded, ...diff.filesDeleted],
    { workspaceRoot: workspace.path, allowedPaths },
  );
}

export type ApplyVerdict =
  | { applied: true; reason: string }
  | { applied: false; reason: string; blockedBy: 'STALE_BASE' | 'DIRTY_REPO' | 'DIFF_CHANGED' | 'CONFLICT' | 'EMPTY' };

export interface ApplyOptions {
  repoRoot: string;
  baseCommit: string;
  /** L'empreinte relue. Un diff qui a bougé depuis n'est plus celui-là. */
  reviewedDiffHash: string;
  diff: string;
  /** Autoriser l'application sur un dépôt qui porte du travail non commité. */
  allowDirty?: boolean;
}

/**
 * Appliquer le patch au dépôt principal — ou refuser proprement.
 *
 * Toutes les conditions sont vérifiées avant la moindre écriture, et
 * l'application elle-même passe par `git apply --index`, qui est atomique :
 * git refuse le patch entier plutôt que d'en poser la moitié.
 *
 * Aucun `git reset --hard` nulle part. Sur un dépôt qui porte du travail non
 * sauvegardé, cette commande est une perte définitive — et un système
 * autonome ne doit pas disposer d'un outil dont le pire cas est irréparable.
 */
export function applyToRepo(options: ApplyOptions): ApplyVerdict {
  if (!options.diff.trim()) {
    return { applied: false, blockedBy: 'EMPTY', reason: 'le patch est vide : rien à appliquer' };
  }
  if (hashDiff(options.diff) !== options.reviewedDiffHash) {
    return {
      applied: false,
      blockedBy: 'DIFF_CHANGED',
      reason: 'le diff a changé depuis la revue : ce n’est plus ce qui a été approuvé',
    };
  }

  const state = inspectRepo(options.repoRoot);
  if (state.head !== options.baseCommit) {
    return {
      applied: false,
      blockedBy: 'STALE_BASE',
      reason: `le dépôt est en ${state.head.slice(0, 8)}, le patch vise ${options.baseCommit.slice(0, 8)}`,
    };
  }
  if (!state.clean && !options.allowDirty) {
    return {
      applied: false,
      blockedBy: 'DIRTY_REPO',
      reason:
        `${state.dirtyFiles.length} fichier(s) modifié(s) et non commité(s) : `
        + 'application refusée pour ne rien écraser',
    };
  }

  const patch = join(tmpdir(), `atlas-apply-${Date.now()}.patch`);
  writeFileSync(patch, options.diff, 'utf8');
  try {
    // `--check` d'abord : git dit si le patch passerait, sans rien écrire.
    git(['apply', '--check', '--whitespace=nowarn', patch], options.repoRoot, 60_000);
    git(['apply', '--index', '--whitespace=nowarn', patch], options.repoRoot, 60_000);
    return { applied: true, reason: 'patch appliqué et indexé' };
  } catch (error) {
    return {
      applied: false,
      blockedBy: 'CONFLICT',
      reason: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 300),
    };
  } finally {
    try { unlinkSync(patch); } catch { /* le fichier temporaire peut avoir disparu */ }
  }
}

/**
 * Annuler une application.
 *
 * `git apply -R` défait exactement ce que le patch a posé, sans toucher à quoi
 * que ce soit d'autre. C'est la différence avec un `reset` : celui-ci ramènerait
 * le dépôt à un état, celui-là retire une modification précise.
 */
export function revertApply(repoRoot: string, diff: string): { reverted: boolean; reason: string } {
  const patch = join(tmpdir(), `atlas-revert-${Date.now()}.patch`);
  writeFileSync(patch, diff, 'utf8');
  try {
    git(['apply', '-R', '--index', '--whitespace=nowarn', patch], repoRoot, 60_000);
    return { reverted: true, reason: 'patch retiré' };
  } catch (error) {
    return {
      reverted: false,
      reason: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 300),
    };
  } finally {
    try { unlinkSync(patch); } catch { /* idem */ }
  }
}

/** Lire un fichier du workspace, sous les mêmes gardes que l'écriture. */
export function readWorkspaceFile(
  workspace: Workspace,
  path: string,
  allowedPaths: readonly string[],
): { ok: boolean; content: string | null; reason: string } {
  const verdict = checkPath(path, { workspaceRoot: workspace.path, allowedPaths });
  if (!verdict.allowed) return { ok: false, content: null, reason: verdict.reason };
  if (!existsSync(verdict.realPath!)) {
    return { ok: false, content: null, reason: `${path} n’existe pas` };
  }
  return { ok: true, content: readFileSync(verdict.realPath!, 'utf8'), reason: 'lu' };
}

/** La racine du dépôt contenant un chemin, ou `null` s'il n'y en a pas. */
export function repoRootOf(path: string): string | null {
  try {
    return git(['rev-parse', '--show-toplevel'], resolve(path)).trim();
  } catch {
    return null;
  }
}
