import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';
import { FixtureAiProvider } from '@atlas/llm';
import {
  AtlasDaemon, WorkerRegistry, OpenAiWorker, ClaudeCodeWorker, HermesRouter,
  inspectRepo, readQuotaFromOutput, routeTask,
  DEFAULT_WORKER_TYPES, ROUTE_TARGETS, ROUTED_TASK_TYPES,
} from '../src/index.ts';

/**
 * La chaîne complète, sans personne au milieu.
 *
 * C'est l'exigence qui donne son sens à tout le reste : OpenAI relit, propose
 * une correction, Claude Code l'écrit, OpenAI revalide — et aucun humain ne
 * transporte quoi que ce soit d'un agent à l'autre. Tout passe par la file, les
 * résultats structurés et Hermes.
 *
 * Écrit comme un test plutôt que comme une démonstration : une démonstration
 * prouve qu'une chose a marché un jour, un test la rejoue à chaque `npm test`.
 * Les fournisseurs sont figés et le binaire est un faux — ce qui est vérifié
 * n'est pas la qualité du code produit, c'est que la chaîne circule seule.
 */

const logger = createLogger({ level: 'error', pretty: false });
let repos: Repositories;
let dir: string;
let repoRoot: string;
let fakeBin: string;

const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8' });

/** Un faux Claude Code qui édite réellement le fichier, puis rend son JSON. */
function writeFakeClaudeCode(root: string): string {
  const script = join(root, 'cc.cjs');
  writeFileSync(script, [
    "if (process.argv.includes('--version')) { console.log('claude 1.0.0-fixture'); process.exit(0); }",
    'const chunks = [];',
    "process.stdin.on('data', (c) => chunks.push(c));",
    "process.stdin.on('end', () => {",
    "  const fs = require('node:fs');",
    "  fs.writeFileSync('fixture/add.ts', 'export function add(a, b) {\\n'",
    "    + '  if (!Number.isFinite(a) || !Number.isFinite(b)) {\\n'",
    "    + '    throw new TypeError(\\\"add attend deux nombres finis\\\");\\n'",
    "    + '  }\\n  return a + b;\\n}\\n');",
    '  console.log(JSON.stringify({',
    "    status: 'DONE', summary: 'validation des entrées ajoutée', confidence: 0.93,",
    "    plan: 'refuser NaN et Infinity', findings: [], recommendations: [], artifacts: [],",
    "    next_tasks: [{ task_type: 'FINAL_REVIEW', objective: 'valider la correction apportée au module' }],",
    '  }));',
    '});',
  ].join('\n'), 'utf8');

  const launcher = join(root, `cc${process.platform === 'win32' ? '.cmd' : '.sh'}`);
  writeFileSync(
    launcher,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
    'utf8',
  );
  if (process.platform !== 'win32') {
    execFileSync('chmod', ['+x', launcher]);
  }
  return launcher;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-chain-'));
  repos = createRepositories(join(dir, 'chain.db'), logger);
  fakeBin = writeFakeClaudeCode(dir);

  repoRoot = join(dir, 'repo');
  mkdirSync(join(repoRoot, 'fixture'), { recursive: true });
  git(['init', '--quiet', '-b', 'main'], repoRoot);
  git(['config', 'user.email', 'test@atlas.local'], repoRoot);
  git(['config', 'user.name', 'ATLAS Test'], repoRoot);
  writeFileSync(join(repoRoot, 'fixture', 'add.ts'), 'export function add(a, b) {\n  return a + b;\n}\n', 'utf8');
  writeFileSync(join(repoRoot, '.env'), 'SECRET=intact\n', 'utf8');
  git(['add', '-A'], repoRoot);
  git(['commit', '--quiet', '-m', 'base'], repoRoot);
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('OpenAI vers Claude Code vers OpenAI, sans intervention', () => {
  test('la chaîne circule seule et le dépôt reste intact', async () => {
    const reviewBody = {
      confidence: 0.92, findings: [], recommendations: [], artifacts: [],
    };
    const openai = new FixtureAiProvider('OPENAI', 'gpt-5', [
      {
        body: {
          ...reviewBody, status: 'CHANGES_REQUIRED',
          summary: 'add() accepte NaN et Infinity',
          next_tasks: [{
            task_type: 'ENGINEERING_CHANGE',
            objective: 'valider les entrées de la fonction add',
          }],
        },
        usage: { inputTokens: 1200, outputTokens: 300 },
      },
      {
        body: {
          ...reviewBody, status: 'PASS',
          summary: 'la validation couvre NaN et Infinity, aucune régression',
          next_tasks: [],
        },
        usage: { inputTokens: 900, outputTokens: 180 },
      },
    ]);

    const registry = new WorkerRegistry()
      .register(new OpenAiWorker({ repos, provider: openai, timeoutMs: 30_000 }))
      .register(new ClaudeCodeWorker({
        repos, logger, repoRoot, worktreeRoot: join(dir, 'ws'),
        timeoutMs: 60_000, maxFilesChanged: 15, maxDiffLines: 800, binary: fakeBin,
      }));

    const hermes = new HermesRouter({
      repos, logger,
      limits: {
        maxDepth: 4, maxTasks: 12, maxCostUsd: 1,
        maxRuntimeMinutes: 60, unknownCostPolicy: 'ALLOW',
      },
    });

    const root = repos.tasks.create({
      taskType: 'ARCHITECTURE_REVIEW', department: 'ENGINEERING', workerType: 'OPENAI',
      payload: {
        objective: 'relire le module fixture',
        repo_target: 'fixture/add.ts',
        allowed_paths: ['fixture'],
      },
    }).task;
    const chainId = root.chainId!;

    // La boucle du système : le daemon exécute, Hermes décide de la suite.
    // Aucun humain n'intervient entre les deux.
    for (let round = 0; round < 6; round++) {
      await new AtlasDaemon({
        repos, registry, logger, leaseMs: 60_000, heartbeatMs: 1_000,
        maxIdleMs: 20, maxCycles: 2,
      }).run();

      for (const task of repos.tasks.chainTasks(chainId)) {
        const result = task.result as Record<string, unknown> | null;
        if (task.status !== 'DONE' || !result) continue;
        if (!(result.next_tasks as unknown[])?.length) continue;

        // Hermes crée l'enfant et lui transmet le périmètre du parent. Rien
        // n'est édité à la main : c'est précisément ce que cette architecture
        // existe pour supprimer.
        hermes.createChildren(task, result as never);
      }
    }

    const chain = repos.tasks.chainTasks(chainId);
    const types = chain.map((t) => `${t.workerType}:${t.taskType}:${t.status}`);

    assert.equal(chain.length, 3, `chaîne obtenue : ${types.join(' | ')}`);
    assert.equal(chain[0]?.workerType, 'OPENAI');
    assert.equal(chain[1]?.workerType, 'CLAUDE_CODE');
    assert.equal(chain[2]?.workerType, 'OPENAI');
    for (const task of chain) {
      assert.equal(task.status, 'DONE', `${task.taskType} : ${task.status}`);
    }

    // Le périmètre a été hérité, pas injecté : la tâche intermédiaire est née
    // avec ses `allowed_paths` par le seul fait de Hermes.
    assert.deepEqual(chain[1]!.payload.allowed_paths, ['fixture']);

    // Claude Code a réellement édité, dans son worktree.
    const engineering = chain[1]!.result as Record<string, unknown>;
    assert.deepEqual(engineering.files_changed, ['fixture/add.ts']);
    assert.equal(engineering.agent, 'CLAUDE_CODE');

    // La revue finale a vu la correction et l'a validée.
    const review = chain[2]!.result as Record<string, unknown>;
    assert.equal(review.status, 'PASS');

    // Rien n'a touché le dépôt principal ni les secrets.
    assert.equal(inspectRepo(repoRoot).clean, true, 'le dépôt principal reste intact');
    assert.match(readFileSync(join(repoRoot, '.env'), 'utf8'), /SECRET=intact/);

    // Le patch attend une décision : il n'a pas été appliqué tout seul.
    assert.equal(repos.tasks.workspacesInState('READY_FOR_REVIEW').length, 1);
    assert.equal(repos.tasks.workspacesInState('APPLIED').length, 0);

    const workspace = repos.tasks.workspacesInState('READY_FOR_REVIEW')[0]!;
    execFileSync('git', ['worktree', 'remove', '--force', workspace.path], { cwd: repoRoot });
  });

  test('le worker ne crée jamais de tâche : seul Hermes le fait', async () => {
    const openai = new FixtureAiProvider('OPENAI', 'gpt-5', [{
      body: {
        status: 'CHANGES_REQUIRED', summary: 'à corriger', confidence: 0.9,
        findings: [], recommendations: [], artifacts: [],
        next_tasks: [{ task_type: 'ENGINEERING_CHANGE', objective: 'corriger ceci' }],
      },
    }]);
    const registry = new WorkerRegistry()
      .register(new OpenAiWorker({ repos, provider: openai, timeoutMs: 30_000 }));

    repos.tasks.create({
      taskType: 'ARCHITECTURE_REVIEW', department: 'ENGINEERING', workerType: 'OPENAI',
      payload: { objective: 'relire' },
    });

    await new AtlasDaemon({
      repos, registry, logger, leaseMs: 30_000, heartbeatMs: 500,
      maxIdleMs: 20, maxCycles: 2,
    }).run();

    // Une seule tâche : la proposition vit dans le résultat, pas dans la file.
    assert.equal(
      Object.values(repos.tasks.countByStatus()).reduce((sum, n) => sum + n, 0),
      1,
    );
  });

  test('une tâche Claude Code survit à un redémarrage du daemon', async () => {
    const registry = () => new WorkerRegistry().register(new ClaudeCodeWorker({
      repos, logger, repoRoot, worktreeRoot: join(dir, 'ws'),
      timeoutMs: 60_000, maxFilesChanged: 15, maxDiffLines: 800, binary: fakeBin,
    }));

    const task = repos.tasks.create({
      taskType: 'ENGINEERING_CHANGE', department: 'ENGINEERING', workerType: 'CLAUDE_CODE',
      payload: { objective: 'valider les entrées', allowed_paths: ['fixture'] },
    }).task;

    // Le plantage : la tâche est prise, aucun résultat n'est consigné, et le
    // bail est déjà périmé — l'état exact que laisse un `kill -9`.
    repos.tasks.claim({ owner: 'daemon-mort', leaseMs: -1_000, workerTypes: ['CLAUDE_CODE'] });
    assert.equal(repos.tasks.byId(task.taskId)?.status, 'RUNNING');

    // Redémarrage sur le même fichier de base.
    const path = join(dir, 'chain.db');
    repos.close();
    repos = createRepositories(path, logger);

    const stats = await new AtlasDaemon({
      repos, registry: registry(), logger,
      leaseMs: 60_000, heartbeatMs: 1_000, maxIdleMs: 20, maxCycles: 4,
    }).run();

    assert.ok(stats.recovered >= 1, 'le bail expiré doit être récupéré');
    assert.equal(repos.tasks.byId(task.taskId)?.status, 'DONE');

    const workspace = repos.tasks.workspaceFor(task.taskId)!;
    execFileSync('git', ['worktree', 'remove', '--force', workspace.path], { cwd: repoRoot });
  });

  test('sans binaire, la tâche ne reste pas QUEUED et ne boucle pas', async () => {
    const registry = new WorkerRegistry().register(new ClaudeCodeWorker({
      repos, logger, repoRoot, worktreeRoot: join(dir, 'ws'),
      timeoutMs: 30_000, maxFilesChanged: 15, maxDiffLines: 800,
      binary: 'claude-qui-n-existe-pas',
    }));

    const task = repos.tasks.create({
      taskType: 'ENGINEERING_CHANGE', department: 'ENGINEERING', workerType: 'CLAUDE_CODE',
      payload: { objective: 'o', allowed_paths: ['fixture'] },
      maxAttempts: 3,
    }).task;

    // Plusieurs tours : une tâche qui bouclerait consommerait ses tentatives.
    await new AtlasDaemon({
      repos, registry, logger, leaseMs: 30_000, heartbeatMs: 500,
      maxIdleMs: 20, maxCycles: 6,
    }).run();

    const after = repos.tasks.byId(task.taskId)!;
    assert.equal(after.status, 'WAITING_HUMAN', 'elle doit sortir de la file');
    assert.notEqual(after.status, 'QUEUED', 'surtout pas QUEUED indéfiniment');
    // Une seule tentative : la boucle ne l'a pas reprise en rond.
    assert.equal(after.attemptCount, 1);

    // Et l'instruction est là, lisible, dans l'historique.
    const reason = repos.tasks.historyFor(task.taskId).at(-1)?.reason ?? '';
    assert.match(reason, /claude-code/i, `motif : ${reason}`);
  });

  test('une limitation lue dans la sortie met en pause au lieu d’échouer', () => {
    const limited = readQuotaFromOutput('Error: rate limit reached, please retry later');
    assert.equal(limited.limited, true);
    assert.equal(limited.kind, 'RATE_LIMITED');

    const quota = readQuotaFromOutput('You exceeded your current quota for this organization');
    assert.equal(quota.kind, 'QUOTA_EXHAUSTED');

    // Une sortie ordinaire n'est pas une limitation : la confondre mettrait en
    // pause des tâches qui ont simplement échoué.
    assert.equal(readQuotaFromOutput('tests failed: 3 assertions').limited, false);
  });
});

describe('le daemon sert tout ce vers quoi Hermes route', () => {
  test('aucune destination de routage n’est absente du daemon', () => {
    // Le bug qui a motivé ce test : `CLAUDE_CODE` manquait de la liste servie
    // par défaut. Une tâche d'ingénierie restait QUEUED pour toujours — pas
    // d'erreur, pas de journal, rien à voir dans l'interface. Le rapprochement
    // se fait ici entre les deux tables réelles, jamais entre deux recopies.
    for (const target of ROUTE_TARGETS) {
      assert.ok(
        DEFAULT_WORKER_TYPES.includes(target as (typeof DEFAULT_WORKER_TYPES)[number]),
        `${target} est une destination de routage mais le daemon ne la sert pas : `
        + 'toute tâche qui la vise resterait QUEUED indéfiniment',
      );
    }
  });

  test('chaque type de tâche routé atteint un worker servi', () => {
    for (const taskType of ROUTED_TASK_TYPES) {
      const { target } = routeTask(taskType);
      assert.ok(
        DEFAULT_WORKER_TYPES.includes(target as (typeof DEFAULT_WORKER_TYPES)[number]),
        `${taskType} est routé vers ${target}, que le daemon ne sert pas`,
      );
    }
  });
});

describe('une panne permanente n’est pas réessayée', () => {
  test('un type de tâche sans traitement appelle une personne, sans boucler', async () => {
    // Réessayer n'enregistrera jamais le traitement manquant. La tâche
    // consommerait ses tentatives puis finirait en FAILED — un état qui se lit
    // « le travail a échoué » là où il faut lire « personne n'a été chargé
    // de le faire ».
    const dir = mkdtempSync(join(tmpdir(), 'atlas-nohandler-'));
    const repos = createRepositories(join(dir, 'db.sqlite'), createLogger({ level: 'error', pretty: false }));
    try {
      const task = repos.tasks.create({
        taskType: 'TYPE_QUI_N_EXISTE_PAS', department: 'ENGINEERING',
        workerType: 'DETERMINISTIC', payload: {},
      }).task;

      const daemon = new AtlasDaemon({
        repos,
        registry: new WorkerRegistry(),
        logger: createLogger({ level: 'error', pretty: false }),
        maxCycles: 2,
        maxIdleMs: 50,
      });
      await daemon.run();

      const after = repos.tasks.byId(task.taskId)!;
      assert.equal(after.status, 'WAITING_HUMAN');
      assert.equal(after.attemptCount, 1, 'une seule tentative : pas de boucle');
      assert.notEqual(after.status, 'RETRY_SCHEDULED');
      // Le motif doit être lisible là où la file humaine le lit.
    assert.match(after.errorMessage ?? '', /aucun worker/);
    assert.equal(after.errorCode, 'NO_WORKER');
    } finally {
      repos.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
