/**
 * Appliquer au dépôt principal ce qu'une tâche a produit — ou refuser.
 *
 * C'est le seul endroit du système qui modifie le dépôt de quelqu'un. Il est
 * donc séparé, explicite, et ne s'exécute jamais depuis le daemon : une
 * application déclenchée par une boucle automatique serait un `git apply` que
 * personne n'a demandé.
 *
 * Six conditions, toutes vérifiées avant la moindre écriture : la revue est
 * passée, le diff n'a pas bougé depuis, la base est la même, le dépôt ne porte
 * pas de travail non sauvegardé, le verrou d'écriture est tenu, et
 * l'application n'a pas déjà eu lieu.
 *
 *   atlas-apply list                        ce qui attend une décision
 *   atlas-apply show <taskId>               le diff et son contexte
 *   atlas-apply approve <taskId> --by=nom   autorise sans appliquer
 *   atlas-apply run <taskId> --by=nom       applique une fois
 *   atlas-apply revert <taskId> --by=nom    défait ce qui vient d'être appliqué
 */
import { createLogger, nowIso, loadAtlasEnv, loadConfig } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import { applyToRepo, revertApply, inspectRepo, hashDiff } from '../packages/runtime/src/index.ts';

// Avant toute lecture de process.env : sans cet appel, `.env.local` n'existe
// pas pour ce processus et la configuration parait absente sans qu'aucune
// erreur ne le dise.
loadAtlasEnv();

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m',
};

const [action = 'list', ...rest] = process.argv.slice(2);
const flag = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const logger = createLogger({ level: 'error', pretty: false });
const config = loadConfig(process.cwd());
const repos = createRepositories(config.paths.databaseFile, logger);
const repoRoot = flag('repo') ?? process.cwd();

/** Le diff conservé pour cette tâche, tel qu'il a été relu. */
function diffOf(taskId: string): string | null {
  const artifact = repos.tasks
    .artifactsFor(taskId)
    .filter((a) => a.kind === 'DIFF')
    .at(-1);
  return artifact ? repos.tasks.artifact(artifact.artifactId)?.content ?? null : null;
}

try {
  if (action === 'list') {
    const ready = repos.tasks.workspacesInState('READY_FOR_REVIEW');
    const approved = repos.tasks.workspacesInState('APPROVED_TO_APPLY');
    console.log(`\n  ${c.bold}EN ATTENTE DE DÉCISION${c.reset} — ${ready.length}\n`);
    for (const w of ready) {
      console.log(
        `  ${w.taskId}  ${String(w.filesChanged).padStart(3)} fichier(s)  ` +
          `${String(w.diffLines).padStart(4)} ligne(s)  ${c.dim}base ${w.baseCommit.slice(0, 8)}${c.reset}`,
      );
    }
    console.log(`\n  ${c.bold}APPROUVÉES, NON APPLIQUÉES${c.reset} — ${approved.length}\n`);
    for (const w of approved) console.log(`  ${w.taskId}  ${c.dim}${w.path}${c.reset}`);
    console.log();
  } else if (action === 'show') {
    const taskId = rest[0] ?? '';
    const workspace = repos.tasks.workspaceFor(taskId);
    if (!workspace) {
      console.error(`aucun espace de travail pour ${taskId}`);
      process.exit(1);
    }
    const task = repos.tasks.byId(taskId);
    console.log(`\n  ${c.bold}${taskId}${c.reset}  ${workspace.state}`);
    console.log(`  base       ${workspace.baseCommit}`);
    console.log(`  fichiers   ${workspace.filesChanged}  ·  lignes ${workspace.diffLines}`);
    console.log(`  empreinte  ${workspace.diffHash ?? '—'}`);
    const result = task?.result as Record<string, unknown> | null;
    if (result?.plan) console.log(`\n  ${c.bold}PLAN${c.reset}\n${String(result.plan)}`);
    if (result?.diff_summary) console.log(`\n  ${c.bold}RÉSUMÉ${c.reset}\n${String(result.diff_summary)}`);
    const diff = diffOf(taskId);
    if (diff) {
      console.log(`\n  ${c.bold}DIFF${c.reset} ${c.dim}(${diff.split('\n').length} lignes)${c.reset}`);
      console.log(diff.slice(0, 4_000));
    }
    console.log();
  } else if (action === 'approve') {
    const taskId = rest[0];
    const by = flag('by');
    if (!taskId || !by) {
      console.error('usage: atlas-apply approve <taskId> --by=<nom>');
      process.exit(1);
    }
    const workspace = repos.tasks.workspaceFor(taskId);
    if (!workspace || workspace.state !== 'READY_FOR_REVIEW') {
      console.error(`état ${workspace?.state ?? 'inconnu'} : seule une tâche en revue s’approuve`);
      process.exit(1);
    }
    repos.tasks.setWorkspaceState({ workspaceId: workspace.workspaceId, state: 'APPROVED_TO_APPLY' });
    repos.tasks.saveArtifact({
      taskId, workspaceId: workspace.workspaceId, kind: 'FINAL_REVIEW',
      content: `approuvé par ${by} le ${nowIso()}`,
    });
    console.log(`${taskId} → APPROVED_TO_APPLY (par ${by})`);
  } else if (action === 'run') {
    const taskId = rest[0];
    const by = flag('by');
    if (!taskId || !by) {
      console.error('usage: atlas-apply run <taskId> --by=<nom>');
      process.exit(1);
    }
    const workspace = repos.tasks.workspaceFor(taskId);
    if (!workspace) {
      console.error(`aucun espace de travail pour ${taskId}`);
      process.exit(1);
    }
    if (workspace.state !== 'APPROVED_TO_APPLY') {
      // Le verrou principal : sans approbation explicite, rien ne part.
      console.error(
        `état ${workspace.state} : l’application exige APPROVED_TO_APPLY. ` +
          'Approuvez d’abord avec atlas-apply approve.',
      );
      process.exit(1);
    }

    const diff = diffOf(taskId);
    if (!diff) {
      console.error('aucun diff conservé pour cette tâche');
      process.exit(1);
    }

    // L'idempotence porte sur la tâche ET sur le contenu du diff : rejouer la
    // même application est refusé, mais un diff différent reste une opération
    // distincte plutôt qu'un doublon.
    const key = `ENGINEERING_APPLY:${taskId}:${hashDiff(diff)}`;
    const reservation = repos.tasks.reserveExternalOperation({
      idempotencyKey: key, kind: 'EXTERNAL_UPDATE', taskId,
      target: repoRoot, summary: `application du diff de ${taskId}`, claimedBy: by,
    });
    if (!reservation.reserved) {
      console.log(`${c.amber}Application refusée${c.reset} — ${reservation.reason}`);
      process.exit(0);
    }

    // Le verrou d'écriture est tenu pendant l'application : une tâche
    // d'ingénierie ne doit pas écrire dans le worktree pendant qu'on applique.
    const lock = repos.tasks.acquireRepoLock({
      lockKey: 'REPO_WRITE', taskId, owner: `apply:${taskId}`, mode: 'WRITE', leaseMs: 120_000,
    });
    if (!lock.acquired) {
      repos.tasks.confirmExternalOperation({
        idempotencyKey: key, phase: 'FAILED', error: `verrou ${lock.reason}`,
      });
      console.error(`verrou d’écriture ${lock.reason}`);
      process.exit(1);
    }

    try {
      repos.tasks.setWorkspaceState({ workspaceId: workspace.workspaceId, state: 'APPLYING' });
      const outcome = applyToRepo({
        repoRoot,
        baseCommit: workspace.baseCommit,
        reviewedDiffHash: workspace.diffHash ?? hashDiff(diff),
        diff,
        allowDirty: process.argv.includes('--allow-dirty'),
      });

      if (!outcome.applied) {
        repos.tasks.setWorkspaceState({ workspaceId: workspace.workspaceId, state: 'READY_FOR_REVIEW' });
        repos.tasks.confirmExternalOperation({
          idempotencyKey: key, phase: 'FAILED', error: outcome.reason,
        });
        console.error(`${c.red}${outcome.blockedBy}${c.reset} — ${outcome.reason}`);
        process.exit(1);
      }

      repos.tasks.setWorkspaceState({ workspaceId: workspace.workspaceId, state: 'APPLIED' });
      repos.tasks.confirmExternalOperation({
        idempotencyKey: key, phase: 'CONFIRMED', externalRef: workspace.diffHash,
      });
      console.log(`${c.green}APPLIED${c.reset} ${taskId} — ${outcome.reason} (par ${by})`);
    } finally {
      repos.tasks.releaseRepoLock('REPO_WRITE', `apply:${taskId}`);
    }
  } else if (action === 'revert') {
    const taskId = rest[0];
    const by = flag('by');
    if (!taskId || !by) {
      console.error('usage: atlas-apply revert <taskId> --by=<nom>');
      process.exit(1);
    }
    const diff = diffOf(taskId);
    if (!diff) {
      console.error('aucun diff conservé pour cette tâche');
      process.exit(1);
    }
    const outcome = revertApply(repoRoot, diff);
    if (!outcome.reverted) {
      console.error(`${c.red}échec du retrait${c.reset} — ${outcome.reason}`);
      process.exit(1);
    }
    const workspace = repos.tasks.workspaceFor(taskId);
    if (workspace) {
      repos.tasks.setWorkspaceState({ workspaceId: workspace.workspaceId, state: 'READY_FOR_REVIEW' });
    }
    console.log(`${taskId} — patch retiré (par ${by})`);
  } else if (action === 'repo') {
    const state = inspectRepo(repoRoot);
    console.log(`\n  dépôt   ${repoRoot}`);
    console.log(`  HEAD    ${state.head}`);
    console.log(
      state.clean
        ? `  état    ${c.green}propre${c.reset}`
        : `  état    ${c.amber}${state.dirtyFiles.length} fichier(s) non commité(s)${c.reset}`,
    );
    console.log();
  } else {
    console.error(`action inconnue : « ${action} ». Attendu : list | show | approve | run | revert | repo`);
    process.exit(1);
  }
} finally {
  repos.close();
}
