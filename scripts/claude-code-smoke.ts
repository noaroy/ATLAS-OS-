/**
 * La mission réelle, minuscule, dès que Claude Code est installé.
 *
 * Tout le câblage est éprouvé contre un faux binaire : la file, le daemon, le
 * registre, le worktree, l'audit git, le nettoyage d'arborescence. Ce qu'un faux
 * binaire ne peut pas prouver, c'est que le vrai réponde dans le format attendu,
 * dans un temps raisonnable, et qu'il se laisse tuer proprement.
 *
 * D'où ce script : une mission sans intérêt métier — ajouter une validation à
 * une fonction de fixture — passée par le chemin complet, et mesurée.
 *
 * Rien n'est appliqué au dépôt : le worktree reste en attente d'approbation,
 * exactement comme une mission ordinaire. Aucun crédit d'API n'est requis
 * au-delà de l'abonnement qui autorise déjà Claude Code.
 *
 *   npm run claude-code:smoke
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger, loadConfig } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import {
  AtlasDaemon, WorkerRegistry, ClaudeCodeWorker,
  detectClaudeCode, detectClaudeCodeAuth, inspectRepo,
} from '../packages/runtime/src/index.ts';

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m',
};

const config = loadConfig(process.cwd());
const logger = createLogger({ level: 'error', pretty: false });

console.log(`\n  ${c.bold}CLAUDE CODE — MISSION RÉELLE MINIMALE${c.reset}\n`);

// --- Les préalables, avant de créer quoi que ce soit ---
const availability = detectClaudeCode(config.engineering.claudeCodeBin);
if (!availability.available) {
  console.log(`  ${c.cyan}ACTION REQUISE${c.reset} — Claude Code n’est pas installé.`);
  console.log(`  ${c.dim}${availability.detail}${c.reset}\n`);
  console.log('    npm i -g @anthropic-ai/claude-code');
  console.log('    claude            (une fois, pour se connecter)');
  console.log(`\n  ${c.dim}puis relancer : npm run claude-code:smoke${c.reset}\n`);
  process.exit(2);
}

const auth = detectClaudeCodeAuth(availability);
if (auth.state !== 'READY') {
  console.log(`  ${c.cyan}ACTION REQUISE${c.reset} — ${auth.detail}\n`);
  console.log('    claude            (une fois, pour se connecter)\n');
  process.exit(2);
}

console.log(`  ${c.dim}binaire : ${availability.detail}${c.reset}`);
console.log(`  ${c.dim}auth    : ${auth.detail}${c.reset}\n`);

// --- Un dépôt jetable : le vrai n'est jamais l'objet de l'épreuve ---
const dir = mkdtempSync(join(tmpdir(), 'atlas-smoke-'));
const repoRoot = join(dir, 'depot');
mkdirSync(join(repoRoot, 'fixture'), { recursive: true });
writeFileSync(
  join(repoRoot, 'fixture', 'add.ts'),
  'export const add = (a: number, b: number): number => a + b;\n',
  'utf8',
);
const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
git('init', '-q');
git('config', 'user.email', 'smoke@atlas.local');
git('config', 'user.name', 'ATLAS smoke');
git('add', '.');
git('commit', '-qm', 'depart');

const repos = createRepositories(join(dir, 'smoke.db'), logger);
const measures: Array<[string, string]> = [];
let ok = false;

try {
  const task = repos.tasks.create({
    taskType: 'ENGINEERING_CHANGE',
    department: 'ENGINEERING',
    workerType: 'CLAUDE_CODE',
    payload: {
      objective: 'faire refuser NaN à la fonction add, en levant une erreur explicite',
      allowed_paths: ['fixture'],
      acceptance_criteria: 'add(NaN, 1) lève une erreur ; add(1, 2) rend toujours 3',
    },
  }).task;

  const registry = new WorkerRegistry().register(
    new ClaudeCodeWorker({
      repos, logger, repoRoot,
      binary: config.engineering.claudeCodeBin,
      // Une mission minuscule : au-delà, quelque chose ne va pas, et attendre
      // davantage n'y changerait rien.
      timeoutMs: 180_000,
      worktreeRoot: join(dir, 'worktrees'),
      maxFilesChanged: 3,
      maxDiffLines: 120,
    }),
  );

  const started = Date.now();
  await new AtlasDaemon({
    repos, registry, logger,
    leaseMs: 30_000, heartbeatMs: 5_000, maxIdleMs: 500, maxCycles: 2,
  }).run();
  const elapsedMs = Date.now() - started;

  const after = repos.tasks.byId(task.taskId)!;
  const workspace = repos.tasks.workspaceFor(task.taskId);
  const result = (after.result ?? {}) as Record<string, unknown>;
  const files = (result.files_changed as string[] | undefined) ?? [];

  measures.push(['durée', `${(elapsedMs / 1000).toFixed(1)} s`]);
  measures.push(['état final', after.status]);
  measures.push(['tentatives', String(after.attemptCount)]);
  measures.push(['fichiers modifiés', files.length ? files.join(', ') : 'aucun']);
  measures.push(['état du workspace', workspace?.state ?? 'aucun']);
  measures.push(['résultat structuré', result.summary ? 'oui' : 'non']);
  measures.push(['dernier battement', after.leaseUntil ? 'bail tenu' : 'bail rendu']);
  measures.push(['dépôt de départ', inspectRepo(repoRoot).clean ? 'intact' : 'MODIFIÉ']);

  ok = after.status === 'DONE'
    && files.length > 0
    && Boolean(result.summary)
    && inspectRepo(repoRoot).clean;

  if (after.status !== 'DONE') {
    measures.push(['motif', `${after.errorCode ?? '?'} — ${after.errorMessage ?? 'sans détail'}`]);
  }
} finally {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
}

// Le recu : le controle de production le relit plutot que de supposer qu'une
// mission reelle a eu lieu. Sans lui, « eprouve » resterait une affirmation.
const receipt = join(config.paths.backupDir, 'claude-code-smoke.json');
mkdirSync(config.paths.backupDir, { recursive: true });
writeFileSync(
  receipt,
  JSON.stringify({ at: new Date().toISOString(), ok, measures }, null, 2),
  'utf8',
);

const width = Math.max(...measures.map(([k]) => k.length));
for (const [k, v] of measures) console.log(`  ${k.padEnd(width)}  ${c.dim}${v}${c.reset}`);

console.log(
  `\n  ${ok ? `${c.green}MISSION RÉELLE RÉUSSIE${c.reset}` : `${c.red}ÉCHEC${c.reset}`}`
  + `  ${c.dim}— aucun changement appliqué au dépôt principal${c.reset}\n`,
);
process.exitCode = ok ? 0 : 1;
