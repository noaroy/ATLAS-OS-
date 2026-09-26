import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../core/src/logger.ts';
import type { AtlasConfig } from '../../core/src/index.ts';
import { createRepositories, type Repositories } from '../../data/src/index.ts';
import { classifyAiError, type AiProvider, type AiRequest, type AiResponse } from '../../llm/src/index.ts';
import { makeTestConfig } from '../../testing/src/index.ts';
import {
  startObjective, scheduleSupervisorPoll, createSupervisorHandlers, runControllerPoll, parseControllerIssue,
  AtlasDaemon, WorkerRegistry, DeterministicWorker, ClaudeCodeWorker, HermesRouter,
  SUPERVISOR_DECISION_SCHEMA, SUPERVISOR_POLL_TASK_TYPE,
  type ControllerGithub, type GithubIssue,
} from '../src/index.ts';

/**
 * Le parcours complet, sur un vrai dépôt git et un vrai worker.
 *
 * Seuls deux acteurs sont remplacés : GPT (un fournisseur scripté) et le
 * binaire `claude` (un faux qui respecte le contrat headless). Tout le reste
 * est le code de production : startObjective, la file, le daemon, Hermes,
 * ClaudeCodeWorker (worktree, diff constaté par git, audit, empilement du
 * diff relu), le tour SUPERVISOR_REVIEW_POLL servi par le worker déterministe.
 */

const logger = createLogger({ level: 'error', pretty: false });
const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8' });

let dir: string;
let repoRoot: string;
let repos: Repositories;
let config: AtlasConfig;
let savedBilling: string | undefined;

/** Le faux Claude Code : étape 1 valide add.ts, étape 2 écrit ses tests. Il propose toujours une suite. */
function fakeClaude(): string {
  const script = join(dir, 'fake-claude.cjs');
  writeFileSync(script, [
    "if (process.argv.includes('--version')) { console.log('fake-claude 1.0.0'); process.exit(0); }",
    "const chunks = [];",
    "process.stdin.on('data', (c) => chunks.push(c));",
    "process.stdin.on('end', () => {",
    "  const mission = Buffer.concat(chunks).toString();",
    "  const fs = require('node:fs');",
    "  if (mission.includes('ETAPE-2')) {",
    "    if (!fs.readFileSync('fixture/add.ts', 'utf8').includes('isFinite')) { console.error('le diff du cycle 1 manque'); process.exit(4); }",
    "    fs.writeFileSync('fixture/add.test.ts', 'import { add } from \"./add\";\\nif (add(1, 2) !== 3) throw new Error(\"add\");\\n');",
    "  } else {",
    "    fs.writeFileSync('fixture/add.ts', 'export function add(a, b) {\\n  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new TypeError(\"add\");\\n  return a + b;\\n}\\n');",
    "  }",
    "  console.log(JSON.stringify({ status: 'DONE', summary: 'fait', confidence: 0.9, plan: 'p', findings: [], recommendations: [],",
    "    next_tasks: [{ task_type: 'FINAL_REVIEW', objective: 'relire la validation ajoutée au module add' }], artifacts: [] }));",
    "});",
  ].join('\n'), 'utf8');
  const launcher = join(dir, 'fake-claude.sh');
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, 'utf8');
  chmodSync(launcher, 0o755);
  return launcher;
}

class ScriptedGpt implements AiProvider {
  readonly provider = 'OPENAI' as const;
  readonly model = 'gpt-5';
  readonly calls: AiRequest[] = [];
  constructor(private readonly replies: Array<(ids: { objectiveId: string; taskId: string }, prompt: string) => Record<string, unknown>>) {}
  status() { return { configured: true, code: 'OPENAI_READY', detail: 'modèle gpt-5' }; }
  async execute(req: AiRequest): Promise<AiResponse> {
    this.calls.push(req);
    const objectiveId = /"objective_id": "([^"]+)"/.exec(req.prompt)?.[1] ?? '';
    const taskId = /"reviewed_task_id": "([^"]+)"/.exec(req.prompt)?.[1] ?? '';
    const body = this.replies[Math.min(this.calls.length - 1, this.replies.length - 1)]!({ objectiveId, taskId }, req.prompt);
    return {
      text: JSON.stringify(body), structured: null,
      usage: { inputTokens: 2_000, outputTokens: 300, cacheReadTokens: 0, costUsd: 0.0055, costBasis: 'KNOWN' },
      model: this.model, provider: 'OPENAI', durationMs: 2, truncated: false,
    };
  }
  classifyError(error: unknown) { return classifyAiError({ status: null, message: String(error) }); }
}

const reply = (kind: string, next: string | null = null) => (ids: { objectiveId: string; taskId: string }) => ({
  schema: SUPERVISOR_DECISION_SCHEMA, objective_id: ids.objectiveId, reviewed_task_id: ids.taskId, decision: kind,
  summary: `revue : ${kind}`, reasons: ['diff constaté relu'],
  next_task: next ? { objective: next, acceptance_criteria: ['un test couvre add'], test_commands: [] } : null,
  blocked_reason: null,
});

const liveConfig = (): AtlasConfig => ({
  ...config,
  ai: { ...config.ai, live: true },
  supervisor: { ...config.supervisor, enabled: true },
  engineering: { ...config.engineering, workspaceRoot: join(dir, 'ws') },
});

beforeEach(() => {
  savedBilling = process.env.ATLAS_CLAUDE_CODE_USE_API_KEY;
  delete process.env.ATLAS_CLAUDE_CODE_USE_API_KEY;
  dir = mkdtempSync(join(tmpdir(), 'atlas-gpt-sup-int-'));
  config = makeTestConfig(dir);
  repos = createRepositories(join(dir, 'atlas.db'), logger);
  repoRoot = join(dir, 'repo');
  mkdirSync(join(repoRoot, 'fixture'), { recursive: true });
  git(['init', '--quiet', '-b', 'main'], repoRoot);
  git(['config', 'user.email', 'test@atlas.local'], repoRoot);
  git(['config', 'user.name', 'ATLAS Test'], repoRoot);
  writeFileSync(join(repoRoot, '.gitignore'), 'node_modules/\n.env\n', 'utf8');
  writeFileSync(join(repoRoot, 'fixture', 'add.ts'), 'export function add(a, b) {\n  return a + b;\n}\n', 'utf8');
  writeFileSync(join(repoRoot, '.env'), 'SECRET=ne-doit-jamais-sortir\n', 'utf8');
  git(['add', '-A'], repoRoot);
  git(['commit', '--quiet', '-m', 'base'], repoRoot);
});

afterEach(() => {
  repos.close();
  if (savedBilling === undefined) delete process.env.ATLAS_CLAUDE_CODE_USE_API_KEY;
  else process.env.ATLAS_CLAUDE_CODE_USE_API_KEY = savedBilling;
  rmSync(dir, { recursive: true, force: true });
});

/** Un tour de daemon : exactement une tâche prise, puis arrêt. Chaque tour est un « processus » neuf. */
async function daemonTurn(cfg: AtlasConfig, gpt: AiProvider): Promise<void> {
  const registry = new WorkerRegistry()
    .register(new DeterministicWorker(createSupervisorHandlers({ repos, config: cfg, logger, provider: gpt, actor: 'server', pricing: () => ({ input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }) })))
    .register(new ClaudeCodeWorker({
      repos, logger, repoRoot, worktreeRoot: join(dir, 'ws'), timeoutMs: 30_000, maxFilesChanged: 15, maxDiffLines: 800, binary: fakeClaude(),
    }));
  const hermes = new HermesRouter({ repos, logger, limits: { maxDepth: 4, maxTasks: 12, maxCostUsd: 1, maxRuntimeMinutes: 60, unknownCostPolicy: 'BLOCK' } });
  const daemon = new AtlasDaemon({ repos, registry, logger, hermes, workerTypes: ['DETERMINISTIC', 'CLAUDE_CODE'], maxCycles: 1, maxIdleMs: 5, hostLabel: 'test' });
  await daemon.run();
}

let period = 0;
const schedule = (cfg: AtlasConfig) => {
  period += 1;
  const created = scheduleSupervisorPoll(repos, cfg, new Date(Date.now() - 1_000_000_000 + period * cfg.supervisor.pollMinutes * 60_000));
  assert.equal(created.created.length, 1);
};

describe('READY_FOR_REVIEW → GPT → une suite Claude Code → READY_FOR_REVIEW → GPT → COMPLETE', () => {
  test('deux tours sur un vrai worktree : le diff s’empile, le dépôt principal ne bouge pas', async () => {
    const cfg = liveConfig();
    const headBefore = git(['rev-parse', 'HEAD'], repoRoot).trim();
    const gpt = new ScriptedGpt([
      reply('NEXT_TASK', 'ETAPE-2 : ajouter fixture/add.test.ts qui vérifie add(1, 2) === 3'),
      reply('COMPLETE'),
    ]);
    const started = startObjective(repos, cfg, {
      key: 'integration-1', objective: 'Valider les entrées de add dans fixture/add.ts, puis le tester',
      allowedPaths: ['fixture/add.ts', 'fixture/add.test.ts'], testCommands: [],
    });
    assert.ok(started.ok);
    if (!started.ok) return;
    const { objective, rootTask } = started;

    // Tour 1 : Claude Code (faux binaire) travaille la racine.
    await daemonTurn(cfg, gpt);
    const root = repos.tasks.byId(rootTask.taskId)!;
    assert.equal(root.status, 'DONE');
    assert.equal(root.result?.status, 'ENGINEERING_READY_FOR_REVIEW');
    assert.equal(root.result?.claude_code_billing, 'SUBSCRIPTION');
    assert.equal(repos.tasks.childrenOf(root.taskId).length, 0, 'Hermes n’a rien créé de ses next_tasks');

    // Tour 2 : le superviseur relit, GPT décide NEXT_TASK, une suite naît.
    schedule(cfg);
    await daemonTurn(cfg, gpt);
    assert.equal(gpt.calls.length, 1);
    assert.match(gpt.calls[0]!.prompt, /isFinite/, 'GPT relit le diff réel');
    let tasks = repos.tasks.chainTasks(objective.chainId).filter((t) => t.taskType === 'ENGINEERING_CHANGE');
    assert.equal(tasks.length, 2);
    const child = tasks[1]!;
    assert.equal(child.workerType, 'CLAUDE_CODE');
    assert.equal(child.status, 'QUEUED');

    // Tour 3 : Claude Code travaille la suite, sur le diff relu.
    await daemonTurn(cfg, gpt);
    const done = repos.tasks.byId(child.taskId)!;
    assert.equal(done.status, 'DONE', `${done.errorCode} ${done.errorMessage}`);
    assert.equal(done.result?.base_commit, root.result?.base_commit, 'même base');
    const files = [...(done.result?.files_changed as string[]), ...(done.result?.files_added as string[])].sort();
    assert.deepEqual(files, ['fixture/add.test.ts', 'fixture/add.ts'], 'le diff est cumulé');
    assert.notEqual(done.result?.diff_hash, root.result?.diff_hash);

    // Tour 4 : le superviseur relit la suite, GPT décide COMPLETE.
    schedule(cfg);
    await daemonTurn(cfg, gpt);
    assert.equal(gpt.calls.length, 2);
    assert.match(gpt.calls[1]!.prompt, /add\.test\.ts/);
    assert.match(gpt.calls[1]!.prompt, /Cycles précédents/);

    const final = repos.supervisor.objective(objective.objectiveId)!;
    assert.equal(final.status, 'COMPLETE');
    assert.equal(final.result?.final_task_id, child.taskId);
    assert.equal(final.result?.applied, false);
    tasks = repos.tasks.chainTasks(objective.chainId).filter((t) => t.taskType === 'ENGINEERING_CHANGE');
    assert.equal(tasks.length, 2, 'exactement une suite en tout');
    assert.equal(repos.tasks.list({ status: 'QUEUED' }).length, 0);

    // Un tour de plus ne fait rien.
    schedule(cfg);
    await daemonTurn(cfg, gpt);
    assert.equal(gpt.calls.length, 2);

    // Le dépôt principal : même HEAD, rien de modifié. Les worktrees relus restent.
    assert.equal(git(['rev-parse', 'HEAD'], repoRoot).trim(), headBefore);
    assert.equal(git(['status', '--porcelain'], repoRoot).trim(), '');
    assert.equal(readFileSync(join(repoRoot, 'fixture', 'add.ts'), 'utf8'), 'export function add(a, b) {\n  return a + b;\n}\n');
    assert.ok(existsSync(repos.tasks.workspaceFor(root.taskId)!.path));
    assert.ok(existsSync(join(repos.tasks.workspaceFor(child.taskId)!.path, 'fixture', 'add.test.ts')));
    const polls = repos.tasks.list({ limit: 50 }).filter((t) => t.taskType === SUPERVISOR_POLL_TASK_TYPE);
    assert.ok(polls.every((t) => t.status === 'DONE'));
  });

  test('un worktree retouché après sa revue n’est pas empilé : STACK_DIFF_CHANGED, puis BLOCKED', async () => {
    const cfg = liveConfig();
    const gpt = new ScriptedGpt([reply('NEXT_TASK', 'ETAPE-2 : ajouter fixture/add.test.ts')]);
    const started = startObjective(repos, cfg, {
      key: 'integration-tamper', objective: 'Valider les entrées de add dans fixture/add.ts, puis le tester',
      allowedPaths: ['fixture/add.ts', 'fixture/add.test.ts'],
    });
    assert.ok(started.ok);
    if (!started.ok) return;
    await daemonTurn(cfg, gpt);
    schedule(cfg);
    await daemonTurn(cfg, gpt);
    // Quelqu'un modifie le worktree relu, après la décision.
    const rootWs = repos.tasks.workspaceFor(started.rootTask.taskId)!;
    writeFileSync(join(rootWs.path, 'fixture', 'add.ts'), '// retouché\n', 'utf8');
    await daemonTurn(cfg, gpt);
    const child = repos.tasks.chainTasks(started.objective.chainId).filter((t) => t.taskType === 'ENGINEERING_CHANGE')[1]!;
    const failed = repos.tasks.byId(child.taskId)!;
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.errorCode, 'STACK_DIFF_CHANGED');
    schedule(cfg);
    await daemonTurn(cfg, gpt);
    const obj = repos.supervisor.objective(started.objective.objectiveId)!;
    assert.equal(obj.status, 'BLOCKED');
    assert.equal(obj.terminalCode, 'TASK_NOT_READY');
    assert.match(obj.terminalReason ?? '', /STACK_DIFF_CHANGED/);
    assert.equal(gpt.calls.length, 1, 'aucune revue GPT d’une tâche en échec');
  });
});

describe('le pont contrôleur peut ouvrir un objectif autonome', () => {
  const REPO = 'acme/atlas';
  const envelope = (autonomous?: boolean) => ({
    schema: 'atlas.controller-task.v1', task_type: 'ENGINEERING_CHANGE', correlation_id: 'ctl-auto-1',
    objective: 'Valider les entrées de add dans fixture/add.ts', allowed_paths: ['fixture/add.ts'],
    apply: false, push: false, deploy: false, ...(autonomous === undefined ? {} : { autonomous }),
  });

  test('autonomous est facultatif, booléen, faux par défaut', () => {
    const ctx = { repo: REPO, issue: 1, config };
    const plain = parseControllerIssue(JSON.stringify(envelope()), ctx);
    assert.ok(plain.ok && plain.envelope.autonomous === false);
    const auto = parseControllerIssue(JSON.stringify(envelope(true)), ctx);
    assert.ok(auto.ok && auto.envelope.autonomous === true);
    const bad = parseControllerIssue(JSON.stringify({ ...envelope(), autonomous: 'yes' }), ctx);
    assert.equal(bad.ok, false);
  });

  test('une issue autonomous:true donne une racine d’objectif, adoptée à la première revue', async () => {
    const issue: GithubIssue = {
      number: 7, title: 't', body: `\`\`\`json\n${JSON.stringify(envelope(true))}\n\`\`\``,
      author: 'noa', labels: ['atlas:controller-task'], isPullRequest: false,
    };
    const github: ControllerGithub = {
      listOpenIssues: async () => [issue], listComments: async () => [], createComment: async () => ({ id: 1 }),
      addLabels: async () => {}, removeLabel: async () => {}, redact: (t) => t,
    };
    const cfg: AtlasConfig = { ...liveConfig(), controller: { ...config.controller, enabled: true, repo: REPO, authors: ['noa'] } };
    const report = await runControllerPoll({ repos, config: cfg, logger, github, env: { ATLAS_CONTROLLER_GITHUB_TOKEN: 'x' } });
    assert.equal(report.tasksCreated.length, 1);
    const root = repos.tasks.byId(report.tasksCreated[0]!)!;
    const sup = root.payload.supervisor as Record<string, unknown>;
    assert.equal(sup.cycle, 1);
    assert.equal(sup.source, 'controller-bridge');
    assert.equal(repos.supervisor.objective(sup.objective_id as string), null, 'pas encore inscrit');

    const gpt = new ScriptedGpt([reply('COMPLETE')]);
    await daemonTurn(cfg, gpt);
    schedule(cfg);
    await daemonTurn(cfg, gpt);
    const obj = repos.supervisor.objective(sup.objective_id as string)!;
    assert.equal(obj.source, 'controller-bridge');
    assert.equal(obj.rootTaskId, root.taskId);
    assert.equal(obj.status, 'COMPLETE');
  });
});
