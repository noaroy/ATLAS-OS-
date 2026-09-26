import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, chmodSync, existsSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';
import {
  ClaudeCodeWorker, detectClaudeCode, detectClaudeCodeAuth, usesApiKeyBilling, runClaudeCode,
  extractLastJson, buildMission,
  routeTask, inspectRepo, DEFAULT_ALLOWED_TOOLS,
} from '../src/index.ts';

/**
 * Claude Code, éprouvé sans le binaire officiel.
 *
 * Le vrai `claude` n'est pas installé sur cette machine, et l'installer ne
 * prouverait pas grand-chose de plus : ce qu'il faut vérifier n'est pas que
 * l'agent sait coder — c'est qu'ATLAS le lance correctement, le borne, constate
 * ce qu'il a fait, et refuse ce qui sort du périmètre.
 *
 * Ces tests utilisent donc un faux binaire qui respecte exactement le contrat
 * headless : il lit sa mission sur l'entrée standard, écrit dans le répertoire
 * courant, et termine par un objet JSON. Tout ce qui entoure cet appel — le
 * worktree, l'audit git, le budget, la mise à mort au délai — est le code réel.
 */

const logger = createLogger({ level: 'error', pretty: false });
let repos: Repositories;
let dir: string;
let repoRoot: string;

const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8' });

/**
 * Un faux Claude Code.
 *
 * `behaviour` décide de ce qu'il fait : éditer dans le périmètre, en sortir,
 * s'éterniser, ou échouer. C'est ce qui permet d'éprouver les gardes sur un
 * agent qui écrit lui-même, plutôt que sur un modèle qui propose.
 */
function fakeClaudeCode(behaviour: 'edit' | 'escape' | 'hang' | 'fail' | 'nojson' | 'tamper'): string {
  const script = join(dir, `fake-claude-${behaviour}.cjs`);
  const body = [
    // `--version` repond avant toute lecture : une sonde n'envoie rien sur
    // l'entree standard, et attendre sa fermeture ferait echouer la detection.
    "if (process.argv.includes('--version')) { console.log('fake-claude 1.0.0'); process.exit(0); }",
    "const chunks = [];",
    "process.stdin.on('data', (c) => chunks.push(c));",
    "process.stdin.on('end', () => {",
    "  const mission = Buffer.concat(chunks).toString();",
    "  const fs = require('node:fs');",
    `  const mode = ${JSON.stringify(behaviour)};`,
    "  if (mode === 'hang') { setTimeout(() => {}, 120000); return; }",
    "  if (mode === 'fail') { console.error('erreur interne'); process.exit(3); }",
    "  if (mode === 'escape') {",
    "    fs.writeFileSync('README.md', 'écrasé hors périmètre\\n');",
    "  } else {",
    // `tamper` : l'édition légitime, plus un node_modules réel à la place du lien.
    "    if (mode === 'tamper') {",
    "      fs.rmSync('node_modules');",
    "      fs.mkdirSync('node_modules/dep', { recursive: true });",
    "      fs.writeFileSync('node_modules/dep/index.js', 'module.exports = \"piégé\";\\n');",
    "    }",
    "    fs.mkdirSync('fixture', { recursive: true });",
    "    fs.writeFileSync('fixture/add.ts',",
    "      'export function add(a, b) {\\n  if (!Number.isFinite(a)) throw new TypeError(\\\"a\\\");\\n  return a + b;\\n}\\n');",
    "  }",
    "  console.log('[progression] mission reçue :', mission.slice(0, 40));",
    "  if (mode === 'nojson') { console.log('terminé sans structure'); process.exit(0); }",
    "  console.log(JSON.stringify({",
    "    status: 'DONE', summary: 'validation ajoutée', confidence: 0.9,",
    "    plan: 'refuser les entrées non finies', findings: [], recommendations: [],",
    "    next_tasks: [{ task_type: 'FINAL_REVIEW', objective: 'valider la correction apportée' }],",
    "    artifacts: [],",
    "  }));",
    "  process.exit(0);",
    "});",
  ].join('\n');
  writeFileSync(script, body, 'utf8');

  // Un lanceur, pour que le worker appelle « un binaire » et non « node avec un
  // argument » : c'est la forme réelle de l'invocation.
  const launcher = join(dir, `fake-claude-${behaviour}${process.platform === 'win32' ? '.cmd' : '.sh'}`);
  writeFileSync(
    launcher,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
    'utf8',
  );
  if (process.platform !== 'win32') chmodSync(launcher, 0o755);
  return launcher;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-cc-'));
  repos = createRepositories(join(dir, 'cc.db'), logger);
  repoRoot = join(dir, 'repo');
  mkdirSync(join(repoRoot, 'fixture'), { recursive: true });
  git(['init', '--quiet', '-b', 'main'], repoRoot);
  git(['config', 'user.email', 'test@atlas.local'], repoRoot);
  git(['config', 'user.name', 'ATLAS Test'], repoRoot);
  writeFileSync(join(repoRoot, 'fixture', 'add.ts'), 'export function add(a, b) {\n  return a + b;\n}\n', 'utf8');
  writeFileSync(join(repoRoot, 'README.md'), '# fixture\n', 'utf8');
  writeFileSync(join(repoRoot, '.env'), 'SECRET=ne-doit-jamais-sortir\n', 'utf8');
  git(['add', '-A'], repoRoot);
  git(['commit', '--quiet', '-m', 'base'], repoRoot);
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const worker = (binary: string, over: Record<string, unknown> = {}) =>
  new ClaudeCodeWorker({
    repos, logger, repoRoot,
    worktreeRoot: join(dir, 'ws'),
    timeoutMs: 30_000, maxFilesChanged: 15, maxDiffLines: 800,
    binary, ...over,
  });

const newTask = (payload: Record<string, unknown>) =>
  repos.tasks.create({
    taskType: 'ENGINEERING_CHANGE', department: 'ENGINEERING',
    workerType: 'CLAUDE_CODE', payload,
  }).task;

const ctx = () => ({
  logger, heartbeat: () => true, shuttingDown: () => false, correlationId: null,
});

describe('le routage nomme Claude Code', () => {
  test('l’ingénierie qui modifie du code lui revient', () => {
    assert.equal(routeTask('ENGINEERING_CHANGE').target, 'CLAUDE_CODE');
    assert.equal(routeTask('CODE_FIX').target, 'CLAUDE_CODE');
    // L'analyse sans écriture reste sur l'API : moins cher, sans worktree.
    assert.equal(routeTask('REPO_ANALYSIS').target, 'CLAUDE');
    assert.equal(routeTask('FINAL_REVIEW').target, 'OPENAI');
  });
});

describe('la détection du binaire', () => {
  test('un binaire absent se rapporte, il ne fait pas échouer', () => {
    const verdict = detectClaudeCode('binaire-qui-n-existe-pas-du-tout');
    assert.equal(verdict.available, false);
    assert.equal(verdict.available === false && verdict.code, 'CLAUDE_CODE_UNAVAILABLE');
    assert.match(verdict.available === false ? verdict.detail : '', /claude-code|introuvable/);
  });

  test('une tâche attend un humain quand le binaire manque', async () => {
    const outcome = await worker('binaire-absent').execute(
      newTask({ objective: 'o', allowed_paths: ['fixture'] }), ctx(),
    );
    assert.equal(outcome.kind, 'WAITING_HUMAN');
    assert.equal(outcome.errorCode, 'CLAUDE_CODE_UNAVAILABLE');
    // Surtout pas FAILED : la tâche est bonne, c'est le poste qui est incomplet.
    assert.notEqual(outcome.kind, 'FAILED');
  });

  test('un faux binaire conforme est détecté', () => {
    const verdict = detectClaudeCode(fakeClaudeCode('edit'));
    assert.equal(verdict.available, true);
  });

  test('un chemin porteur de métacaractères ne parvient jamais au shell', () => {
    // Sous Windows le lancement passe par `shell: true` pour atteindre le shim
    // `.cmd` de npm ; le shell y concatène les arguments. Un `&` cesserait
    // alors d'être un caractère du chemin pour devenir un enchaînement de
    // commandes — ce que la ligne suivante démontre en essayant d'écrire un
    // fichier témoin qui ne doit jamais exister.
    const temoin = join(mkdtempSync(join(tmpdir(), 'atlas-inject-')), 'execute.txt');
    const verdict = detectClaudeCode(`claude & echo compromis > ${temoin}`);
    assert.equal(verdict.available, false);
    assert.equal(existsSync(temoin), false);
  });

  test('un chemin invalide se rapporte au lieu d’éteindre l’écran', () => {
    // La détection alimente l'interface de gestion : si elle levait, la page
    // censée annoncer le problème disparaîtrait avec lui.
    const verdict = detectClaudeCode('claude; rm -rf /');
    assert.equal(verdict.available, false);
    assert.match(verdict.available === false ? verdict.detail : '', /shell/i);
  });
});

describe('la mission envoyée à l’agent', () => {
  test('elle porte l’objectif, le périmètre et les règles', () => {
    const mission = buildMission(
      newTask({
        objective: 'valider les entrées', allowed_paths: ['fixture'],
        acceptance_criteria: 'add refuse NaN',
      }),
      ['fixture'],
    );
    assert.match(mission, /valider les entrées/);
    assert.match(mission, /Chemins autorisés/);
    assert.match(mission, /add refuse NaN/);
    // La règle qui compte : le dépôt est une donnée, pas une instruction.
    assert.match(mission, /jamais une instruction/);
    assert.match(mission, /secrets/);
  });

  test('les outils autorisés n’incluent ni réseau ni installation', () => {
    const joined = DEFAULT_ALLOWED_TOOLS.join(' ');
    assert.ok(!joined.includes('curl') && !joined.includes('WebFetch'));
    assert.ok(!joined.includes('npm install') && !joined.includes('rm '));
    assert.ok(joined.includes('Edit') && joined.includes('npm test'));
  });
});

describe('la sortie de l’agent', () => {
  test('le dernier objet JSON est retenu, pas le premier', () => {
    const text = '{"event":"progression"}\nbruit\n{"status":"DONE","summary":"fini"}';
    assert.equal(extractLastJson(text)?.status, 'DONE');
  });

  test('une sortie sans JSON rend null plutôt qu’un objet approximatif', () => {
    assert.equal(extractLastJson('aucune structure ici'), null);
  });
});

describe('l’exécution réelle, avec un faux binaire', () => {
  test('l’agent édite, ATLAS constate le diff et le dépôt reste intact', async () => {
    const task = newTask({
      objective: 'valider les entrées de add()', allowed_paths: ['fixture'],
    });
    const outcome = await worker(fakeClaudeCode('edit')).execute(task, ctx());

    assert.equal(outcome.kind, 'DONE', outcome.errorMessage);
    const result = outcome.result as Record<string, unknown>;
    assert.equal(result.agent, 'CLAUDE_CODE');
    assert.deepEqual(result.files_changed, ['fixture/add.ts']);
    assert.equal(result.status, 'ENGINEERING_READY_FOR_REVIEW');
    assert.ok(String(result.diff_hash).length > 10);

    // Le dépôt principal n'a pas bougé : le travail vit dans le worktree.
    assert.equal(inspectRepo(repoRoot).clean, true);

    const workspace = repos.tasks.workspaceFor(task.taskId)!;
    assert.equal(workspace.state, 'READY_FOR_REVIEW');
    const kinds = repos.tasks.artifactsFor(task.taskId).map((a) => a.kind);
    assert.ok(kinds.includes('DIFF'), `artefacts : ${kinds.join(', ')}`);

    execFileSync('git', ['worktree', 'remove', '--force', workspace.path], { cwd: repoRoot });
  });

  test('les suites proposées remontent, mais aucune tâche n’est créée', async () => {
    const task = newTask({ objective: 'o', allowed_paths: ['fixture'] });
    const before = Object.values(repos.tasks.countByStatus()).reduce((s, n) => s + n, 0);
    const outcome = await worker(fakeClaudeCode('edit')).execute(task, ctx());

    const result = outcome.result as Record<string, unknown>;
    assert.equal((result.next_tasks as unknown[]).length, 1, 'la proposition remonte');
    // C'est Hermes qui crée, jamais le worker.
    assert.equal(Object.values(repos.tasks.countByStatus()).reduce((s, n) => s + n, 0), before);

    const workspace = repos.tasks.workspaceFor(task.taskId)!;
    execFileSync('git', ['worktree', 'remove', '--force', workspace.path], { cwd: repoRoot });
  });

  test('un agent qui sort du périmètre fait échouer la tâche entière', async () => {
    const task = newTask({ objective: 'o', allowed_paths: ['fixture'] });
    const outcome = await worker(fakeClaudeCode('escape')).execute(task, ctx());

    assert.equal(outcome.kind, 'FAILED');
    assert.equal(outcome.errorCode, 'SECURITY_VIOLATION');
    // Le point du test : l'agent a bien écrit — c'est l'audit git qui l'attrape,
    // pas une vérification avant écriture qu'il aurait pu contourner.
    assert.match(String(outcome.errorMessage), /README\.md/);
    assert.equal(repos.tasks.workspaceFor(task.taskId)?.state, 'ABANDONED');
    assert.equal(inspectRepo(repoRoot).clean, true, 'le dépôt principal reste intact');
  });

  test('un dépassement de délai tue l’arborescence', async () => {
    const task = newTask({ objective: 'o', allowed_paths: ['fixture'] });
    const outcome = await worker(fakeClaudeCode('hang'), { timeoutMs: 2_000 })
      .execute(task, ctx());

    assert.equal(outcome.kind, 'FAILED');
    assert.equal(outcome.errorCode, 'TIMEOUT');
    assert.match(String(outcome.errorMessage), /arborescence tuée/);
    assert.equal(repos.tasks.workspaceFor(task.taskId)?.state, 'ABANDONED');
  });

  test('un échec du processus est rapporté sans perdre le diff', async () => {
    const task = newTask({ objective: 'o', allowed_paths: ['fixture'] });
    const outcome = await worker(fakeClaudeCode('fail')).execute(task, ctx());
    assert.equal(outcome.kind, 'FAILED');
    assert.equal(outcome.errorCode, 'CLAUDE_CODE_FAILED');
    const workspace = repos.tasks.workspaceFor(task.taskId);
    if (workspace) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', workspace.path], { cwd: repoRoot });
      } catch { /* déjà retiré */ }
    }
  });

  test('une sortie sans structure n’empêche pas de constater le travail', async () => {
    const task = newTask({ objective: 'o', allowed_paths: ['fixture'] });
    const outcome = await worker(fakeClaudeCode('nojson')).execute(task, ctx());
    // Le diff existe, il est constaté par git : l'absence de résumé structuré
    // ne doit pas faire perdre un travail réellement effectué.
    assert.equal(outcome.kind, 'DONE');
    assert.deepEqual((outcome.result as Record<string, unknown>).files_changed, ['fixture/add.ts']);

    const workspace = repos.tasks.workspaceFor(task.taskId)!;
    execFileSync('git', ['worktree', 'remove', '--force', workspace.path], { cwd: repoRoot });
  });

  test('sans périmètre déclaré, rien n’est lancé', async () => {
    const outcome = await worker(fakeClaudeCode('edit')).execute(
      newTask({ objective: 'o' }), ctx(),
    );
    assert.equal(outcome.kind, 'FAILED');
    assert.equal(outcome.errorCode, 'NO_ALLOWED_PATHS');
  });

  test('le secret du dépôt n’est jamais modifié', async () => {
    const task = newTask({ objective: 'o', allowed_paths: ['fixture'] });
    await worker(fakeClaudeCode('edit')).execute(task, ctx());
    assert.match(readFileSync(join(repoRoot, '.env'), 'utf8'), /ne-doit-jamais-sortir/);
    const workspace = repos.tasks.workspaceFor(task.taskId)!;
    execFileSync('git', ['worktree', 'remove', '--force', workspace.path], { cwd: repoRoot });
  });
});

describe('le lien node_modules du worktree', { skip: process.platform === 'win32' && 'liens POSIX seulement' }, () => {
  // La forme réelle du dépôt ATLAS : `node_modules/` ignoré, dépendances
  // installées à la racine. C'est ce qui faisait échouer l'essai du Controller
  // Bridge en SECURITY_VIOLATION sur une mission par ailleurs irréprochable.
  beforeEach(() => {
    writeFileSync(join(repoRoot, '.gitignore'), 'node_modules/\n.env\n', 'utf8');
    git(['add', '.gitignore'], repoRoot);
    git(['commit', '--quiet', '-m', 'gitignore'], repoRoot);
    mkdirSync(join(repoRoot, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(repoRoot, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n', 'utf8');
  });

  test('le lien posé par le runner ne fait pas échouer une mission dans le périmètre', async () => {
    const task = newTask({ objective: 'valider add()', allowed_paths: ['fixture'] });
    const outcome = await worker(fakeClaudeCode('edit')).execute(task, ctx());

    assert.equal(outcome.kind, 'DONE', `${outcome.errorCode} ${outcome.errorMessage}`);
    const result = outcome.result as Record<string, unknown>;
    assert.deepEqual(result.files_changed, ['fixture/add.ts']);
    assert.deepEqual(result.files_added, []);
    assert.doesNotMatch(String(result.diff_summary), /node_modules/);
    assert.match(String(result.diff_summary), /fixture\/add\.ts/);

    const workspace = repos.tasks.workspaceFor(task.taskId)!;
    execFileSync('git', ['worktree', 'remove', '--force', workspace.path], { cwd: repoRoot });
    assert.ok(existsSync(join(repoRoot, 'node_modules', 'dep', 'index.js')));
  });

  test('un agent qui remplace node_modules fait échouer la tâche', async () => {
    const task = newTask({ objective: 'o', allowed_paths: ['fixture'] });
    const outcome = await worker(fakeClaudeCode('tamper')).execute(task, ctx());

    assert.equal(outcome.kind, 'FAILED');
    assert.equal(outcome.errorCode, 'SECURITY_VIOLATION');
    assert.match(String(outcome.errorMessage), /node_modules/);
    assert.equal(repos.tasks.workspaceFor(task.taskId)?.state, 'ABANDONED');
    assert.equal(inspectRepo(repoRoot).clean, true, 'le dépôt principal reste intact');
    assert.match(readFileSync(join(repoRoot, 'node_modules', 'dep', 'index.js'), 'utf8'), /= 1;/);
  });
});

describe('la facturation de Claude Code', () => {
  const sauvegarde = { ...process.env };
  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = sauvegarde.ANTHROPIC_API_KEY;
    process.env.ATLAS_CLAUDE_CODE_USE_API_KEY = sauvegarde.ATLAS_CLAUDE_CODE_USE_API_KEY;
  });

  test('par défaut, la clé d’API n’est pas reconnue comme authentification', () => {
    // Elle est retirée de l'environnement transmis au binaire : l'annoncer
    // comme « prêt » vaudrait feu vert pour un chemin que le worker n'emprunte
    // pas. La mission démarrerait, puis s'arrêterait faute de session.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-factice-pour-le-test';
    delete process.env.ATLAS_CLAUDE_CODE_USE_API_KEY;
    const verdict = detectClaudeCodeAuth(
      { available: true, binary: 'claude', detail: 'factice' },
      mkdtempSync(join(tmpdir(), 'atlas-home-vide-')),
    );
    assert.equal(verdict.state, 'MANUAL_ACTION_REQUIRED');
    assert.equal(usesApiKeyBilling(), false, 'l’abonnement est le mode par défaut');
  });

  test('la facturation à l’appel doit être choisie, jamais héritée', () => {
    // Le risque concret : `.env` porte une clé, ATLAS la propageait au binaire,
    // et une mission d'ingénierie se mettait à facturer sans que rien ne le
    // demande ni ne l'annonce.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-factice-pour-le-test';
    process.env.ATLAS_CLAUDE_CODE_USE_API_KEY = 'true';
    const verdict = detectClaudeCodeAuth(
      { available: true, binary: 'claude', detail: 'factice' },
      mkdtempSync(join(tmpdir(), 'atlas-home-vide-')),
    );
    assert.equal(verdict.state, 'READY');
    assert.match(verdict.detail, /FACTURATION/, 'le mode payant se dit à voix haute');
  });

  /**
   * Un faux binaire qui ne fait que dire s'il a reçu la clé. C'est l'invariant
   * d'atlas-engineer : la clé est dans l'environnement du runner — les workers
   * Anthropic directs s'en servent — mais jamais dans celui de Claude Code.
   */
  const keySeenByBinary = async (): Promise<unknown> => {
    const script = join(dir, 'fake-claude-env.cjs');
    writeFileSync(script, [
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  console.log(JSON.stringify({ hasKey: Boolean(process.env.ANTHROPIC_API_KEY) }));",
      "});",
    ].join('\n'), 'utf8');
    const launcher = join(dir, `fake-claude-env${process.platform === 'win32' ? '.cmd' : '.sh'}`);
    writeFileSync(
      launcher,
      process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
      'utf8',
    );
    if (process.platform !== 'win32') chmodSync(launcher, 0o755);
    const run = await runClaudeCode({
      binary: launcher, prompt: 'mission', cwd: dir, timeoutMs: 15_000,
      allowedTools: DEFAULT_ALLOWED_TOOLS, logger,
    });
    assert.equal(run.ok, true, run.raw);
    return run.payload?.hasKey;
  };

  test('abonnement : la clé reste au runner, le binaire ne la reçoit pas', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-factice-pour-le-test';
    process.env.ATLAS_CLAUDE_CODE_USE_API_KEY = 'false';
    assert.equal(await keySeenByBinary(), false, 'Claude Code ne facture jamais à la clé');
    assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-ant-factice-pour-le-test', 'les autres workers la gardent');
  });

  test('facturation à la clé choisie : le binaire la reçoit', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-factice-pour-le-test';
    process.env.ATLAS_CLAUDE_CODE_USE_API_KEY = 'true';
    assert.equal(await keySeenByBinary(), true);
  });

  test('sans binaire, l’authentification est indéterminable, pas absente', () => {
    const verdict = detectClaudeCodeAuth({
      available: false, code: 'CLAUDE_CODE_UNAVAILABLE', detail: 'absent',
    });
    assert.equal(verdict.state, 'UNKNOWN');
  });
});
