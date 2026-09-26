import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, lstatSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '@atlas/core';
import type { AtlasConfig } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';
import { FixtureAiProvider } from '@atlas/llm';
import { makeTestConfig } from '../../testing/src/index.ts';
import {
  AtlasDaemon, WorkerRegistry, OpenAiWorker, ClaudeCodeWorker, HermesRouter,
  inspectRepo, createWorkspace, removeWorkspace, linkNodeModules,
  serverWorkerTypes, DEFAULT_WORKER_TYPES, ENGINEERING_WORKER_TYPES,
  verdictFromTasks, decideAutonomy,
  providerReadinessOf, verifyProvider, assessModelProviders, PROVIDER_VERIFY_TTL_MS,
  softwareLoopStatus, externalRunnerAlive, ENGINEER_HOST_LABEL,
  type AutopilotObservation, type AutopilotProposal,
} from '../src/index.ts';

/**
 * La boucle logicielle : ce qu'il faut pour qu'ATLAS s'améliore seul, et ce
 * qui doit rester impossible.
 *
 *   revue → tâche d'ingénierie → Claude Code dans un worktree isolé → tests →
 *   revue → READY_FOR_HUMAN_DEPLOYMENT. Puis une personne.
 *
 * Chaque test tient une pièce : le sens de « fournisseur prêt » (sonde,
 * cache, jamais une clé imprimée) ; le runner et le dépôt, jugés là où ils
 * vivent ; le daemon qui laisse Hermes enchaîner sans qu'une personne porte
 * les résultats ; le worktree qui ne touche ni le dépôt principal ni ses
 * secrets ; et le déploiement, qui n'existe pas ici — Compose et le Dockerfile
 * en font foi.
 */

const logger = createLogger({ level: 'error', pretty: false });
const ROOT = resolve(import.meta.dirname, '../../..');
const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const REAL_NOW = () => new Date();

let dir: string;
let repos: Repositories;
let config: AtlasConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-loop-'));
  repos = createRepositories(join(dir, 'loop.db'), logger);
  config = makeTestConfig(dir);
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Un dépôt git minimal, avec un secret qui doit rester intact. */
function seedRepo(): string {
  const repoRoot = join(dir, 'repo');
  mkdirSync(join(repoRoot, 'fixture'), { recursive: true });
  git(['init', '--quiet', '-b', 'main'], repoRoot);
  git(['config', 'user.email', 'test@atlas.local'], repoRoot);
  git(['config', 'user.name', 'ATLAS Test'], repoRoot);
  writeFileSync(join(repoRoot, 'fixture', 'add.ts'), 'export function add(a, b) {\n  return a + b;\n}\n', 'utf8');
  writeFileSync(join(repoRoot, '.env'), 'SECRET=intact\nANTHROPIC_API_KEY=sk-prod-never-copied\n', 'utf8');
  writeFileSync(join(repoRoot, '.gitignore'), '.env\nnode_modules/\n', 'utf8');
  git(['add', '-A'], repoRoot);
  git(['commit', '--quiet', '-m', 'base'], repoRoot);
  return repoRoot;
}

/** Un faux Claude Code : édite réellement le fichier, rend son JSON, ne lit aucun secret. */
function writeFakeClaudeCode(root: string): string {
  const script = join(root, 'cc.cjs');
  writeFileSync(script, [
    "if (process.argv.includes('--version')) { console.log('claude 1.0.0-fixture'); process.exit(0); }",
    'const chunks = [];',
    "process.stdin.on('data', (c) => chunks.push(c));",
    "process.stdin.on('end', () => {",
    "  const fs = require('node:fs');",
    "  fs.writeFileSync('fixture/add.ts', 'export function add(a, b) {\\n  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new TypeError(\\'nombres finis\\');\\n  return a + b;\\n}\\n');",
    "  fs.writeFileSync('fixture/seen-env.txt', String(fs.existsSync('.env')));",
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
  if (process.platform !== 'win32') execFileSync('chmod', ['+x', launcher]);
  return launcher;
}

const fakeFetch = (status: number, calls: Array<{ url: string; headers: Record<string, string> }> = []): typeof fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
    return new Response(status === 200 ? '{"data":[]}' : '{"error":"x"}', { status });
  }) as unknown as typeof fetch;

// ─── Le sens de « prêt » ──────────────────────────────────────────────────────

describe('1. un fournisseur : CONFIGURED, READY, STALE, BLOCKED, ABSENT — jamais « clé présente = prêt »', () => {
  test('les transitions, depuis la santé enregistrée, sans réseau', () => {
    const now = REAL_NOW();
    const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
    const base = { provider: 'OPENAI' as const, configured: true, live: true, now };

    assert.equal(providerReadinessOf({ ...base, live: false, health: null }).state, 'ABSENT');
    assert.equal(providerReadinessOf({ ...base, configured: false, health: null }).state, 'ABSENT');
    const configured = providerReadinessOf({ ...base, health: null });
    assert.equal(configured.state, 'CONFIGURED');
    assert.equal(configured.ready, false, 'une clé présente ne vaut pas un fournisseur qui répond');

    const ready = providerReadinessOf({ ...base, health: { provider: 'OPENAI', state: 'AVAILABLE', reason: 'sonde', retryAt: null, retrySource: 'NONE', observedAt: at(60_000) } });
    assert.equal(ready.state, 'READY');
    assert.equal(ready.ready, true);

    const stale = providerReadinessOf({ ...base, health: { provider: 'OPENAI', state: 'AVAILABLE', reason: 'sonde', retryAt: null, retrySource: 'NONE', observedAt: at(PROVIDER_VERIFY_TTL_MS + 60_000) } });
    assert.equal(stale.state, 'STALE');
    assert.equal(stale.ready, true, 'STALE reste utilisable : à revérifier, pas à bloquer');

    for (const state of ['AUTH_ERROR', 'QUOTA_EXHAUSTED', 'BUDGET_EXHAUSTED', 'DEGRADED'] as const) {
      const v = providerReadinessOf({ ...base, health: { provider: 'OPENAI', state, reason: 'x', retryAt: null, retrySource: 'NONE', observedAt: at(1_000) } });
      assert.equal(v.state, 'BLOCKED', state);
      assert.equal(v.ready, false);
    }
    const limited = providerReadinessOf({ ...base, health: { provider: 'OPENAI', state: 'RATE_LIMITED', reason: '429', retryAt: at(-600_000), retrySource: 'BACKOFF', observedAt: at(1_000) } });
    assert.equal(limited.state, 'BLOCKED');
    const limitExpired = providerReadinessOf({ ...base, health: { provider: 'OPENAI', state: 'RATE_LIMITED', reason: '429', retryAt: at(600_000), retrySource: 'BACKOFF', observedAt: at(1_000) } });
    assert.equal(limitExpired.state, 'READY', 'une limitation échue ne bloque plus');
  });

  test('la sonde : un GET gratuit, enregistré, rejoué seulement au-delà de six heures — et la clé n’apparaît nulle part', async () => {
    const env = { ATLAS_OPENAI_API_KEY: 'sk-test-SECRET-0123456789' };
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const first = await verifyProvider(repos, 'OPENAI', { fetchImpl: fakeFetch(200, calls), env });
    assert.equal(first.probed, true);
    assert.equal(first.health?.state, 'AVAILABLE');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://api.openai.com/v1/models');

    const second = await verifyProvider(repos, 'OPENAI', { fetchImpl: fakeFetch(200, calls), env });
    assert.equal(second.probed, false, 'dans le délai : pas de seconde sonde');
    assert.equal(calls.length, 1);

    // Une observation ancienne est rejouée ; un refus devient AUTH_ERROR, un 429 RATE_LIMITED.
    const refused = await verifyProvider(repos, 'OPENAI', { fetchImpl: fakeFetch(401, calls), env, ttlMs: 0 });
    assert.equal(refused.health?.state, 'AUTH_ERROR');
    const limited = await verifyProvider(repos, 'ANTHROPIC', { fetchImpl: fakeFetch(429, calls), env: { ANTHROPIC_API_KEY: 'sk-ant-SECRET' }, ttlMs: 0 });
    assert.equal(limited.health?.state, 'RATE_LIMITED');
    assert.ok(limited.health?.retryAt);

    // Sans clé : rien n'est sondé, rien n'est écrit.
    const none = await verifyProvider(repos, 'OPENAI', { fetchImpl: fakeFetch(200, calls), env: {}, ttlMs: 0 });
    assert.equal(none.probed, false);

    const stored = repos.tasks.providerHealth('OPENAI')!;
    for (const text of [stored.reason ?? '', JSON.stringify(stored), refused.health?.reason ?? '', limited.health?.reason ?? '']) {
      assert.ok(!text.includes('SECRET'), `aucune clé dans « ${text} »`);
    }
  });

  test('assessModelProviders : ATLAS_AI_LIVE=false → ABSENT sans sonde ; live + clés → sondé une fois, READY', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const env = { ATLAS_OPENAI_API_KEY: 'sk-o-SECRET', ANTHROPIC_API_KEY: 'sk-a-SECRET' };
    const off = await assessModelProviders(repos, config, { fetchImpl: fakeFetch(200, calls), env });
    assert.equal(off.OPENAI.state, 'ABSENT');
    assert.equal(off.ANTHROPIC.state, 'ABSENT');
    assert.equal(calls.length, 0, 'à faux, aucun réseau');

    const live: AtlasConfig = { ...config, ai: { ...config.ai, live: true } };
    const on = await assessModelProviders(repos, live, { fetchImpl: fakeFetch(200, calls), env });
    assert.equal(on.OPENAI.state, 'READY');
    assert.equal(on.ANTHROPIC.state, 'READY');
    assert.equal(calls.length, 2);
    const again = await assessModelProviders(repos, live, { fetchImpl: fakeFetch(500, calls), env });
    assert.equal(again.OPENAI.state, 'READY', 'la sonde récente fait foi : pas rejouée');
    assert.equal(calls.length, 2);
    for (const v of Object.values(on)) assert.ok(!v.detail.includes('SECRET'));
    const notVerified = await assessModelProviders(repos, live, { fetchImpl: fakeFetch(200, calls), env: { ATLAS_OPENAI_API_KEY: 'sk-o-SECRET' }, verify: false });
    assert.equal(notVerified.ANTHROPIC.state, 'ABSENT');
    assert.equal(calls.length, 2, 'verify:false : jamais de réseau');
  });
});

// ─── Le runner et le dépôt, jugés là où ils vivent ──────────────────────────

describe('2. la boucle logicielle, pièce par pièce', () => {
  test('intégrée, sans binaire, hors dépôt : fermée — et les deux constantes ne bougent pas', async () => {
    const cfg: AtlasConfig = { ...config, engineering: { ...config.engineering, claudeCodeBin: join(dir, 'absent-claude-binary'), repo: dir } };
    const loop = await softwareLoopStatus(repos, cfg, { cwd: dir, verifyProviders: false });
    assert.equal(loop.runner, 'embedded');
    assert.equal(loop.claudeCodeRunner.state, 'ABSENT');
    assert.equal(loop.claudeCodeRunner.ready, false);
    assert.equal(loop.repositoryWorkspace.state, 'ABSENT', 'un dossier temporaire n’est pas un dépôt');
    assert.equal(loop.usable, false);
    assert.ok(loop.blockers.some((b) => /Claude Code/.test(b)));
    assert.ok(loop.blockers.some((b) => /dépôt/.test(b)));
    assert.equal(loop.autoDeploy, 'DISABLED');
    assert.equal(loop.humanDeployGate, 'ENABLED');
  });

  test('intégrée, sur un dépôt : le dépôt est lu (propre / modifié), jamais modifié', async () => {
    const repoRoot = seedRepo();
    const cfg: AtlasConfig = { ...config, engineering: { ...config.engineering, repo: repoRoot, claudeCodeBin: join(dir, 'absent') } };
    const clean = await softwareLoopStatus(repos, cfg, { verifyProviders: false, probeClaudeCode: false });
    assert.equal(clean.repositoryWorkspace.state, 'READY');
    assert.equal(basename(clean.repositoryWorkspace.root ?? ''), 'repo');
    assert.equal(clean.claudeCodeRunner.state, 'CONFIGURED', 'non sondé : dit tel quel');
    writeFileSync(join(repoRoot, 'fixture', 'add.ts'), '// modifié\n', 'utf8');
    const dirty = await softwareLoopStatus(repos, cfg, { verifyProviders: false, probeClaudeCode: false });
    assert.equal(dirty.repositoryWorkspace.state, 'DIRTY');
    assert.equal(dirty.repositoryWorkspace.ready, true, 'les worktrees partent du dernier commit : utilisable');
    assert.equal(inspectRepo(repoRoot).clean, false, 'la lecture n’a rien nettoyé');
  });

  test('externe : ce processus n’a ni binaire ni dépôt — c’est voulu ; ce qui compte est que atlas-engineer vive', async () => {
    const cfg: AtlasConfig = { ...config, engineering: { ...config.engineering, runner: 'external' } };
    const never = await softwareLoopStatus(repos, cfg, { verifyProviders: false });
    assert.equal(never.runner, 'external');
    assert.equal(never.claudeCodeRunner.state, 'ABSENT');
    assert.match(never.claudeCodeRunner.detail, /jamais démarré/);
    assert.equal(never.repositoryWorkspace.root, null);

    // Un autre daemon (le serveur) ne compte pas : seul le runner sous son nom.
    const server = repos.tasks.startDaemonRun('atlas-server', 1);
    repos.tasks.heartbeatDaemonRun(server);
    assert.equal(externalRunnerAlive(repos, REAL_NOW()).alive, false);

    const run = repos.tasks.startDaemonRun(ENGINEER_HOST_LABEL, 4242);
    repos.tasks.heartbeatDaemonRun(run);
    const alive = await softwareLoopStatus(repos, cfg, { verifyProviders: false });
    assert.equal(alive.claudeCodeRunner.state, 'EXTERNAL');
    assert.equal(alive.claudeCodeRunner.ready, true);
    assert.equal(alive.repositoryWorkspace.state, 'EXTERNAL');
    assert.match(alive.repositoryWorkspace.detail, /\/work\/repo/);

    // Un battement trop vieux : mort, même sans arrêt consigné.
    const late = await softwareLoopStatus(repos, cfg, { verifyProviders: false, now: new Date(Date.now() + 3 * 3_600_000) });
    assert.equal(late.claudeCodeRunner.state, 'ABSENT');
    assert.match(late.claudeCodeRunner.detail, /sans battement/);

    repos.tasks.stopDaemonRun(run, 'test');
    const stopped = await softwareLoopStatus(repos, cfg, { verifyProviders: false });
    assert.equal(stopped.claudeCodeRunner.state, 'ABSENT');
    assert.match(stopped.claudeCodeRunner.detail, /arrêté/);
    assert.equal(stopped.autoDeploy, 'DISABLED');
    assert.equal(stopped.humanDeployGate, 'ENABLED');
  });

  test('Claude Code indisponible → une tâche d’ingénierie ne se confie pas : BLOCKED, fermé par défaut', () => {
    const observation = {
      providers: {
        DETERMINISTIC: { ready: true, detail: 'ok' }, OPENAI: { ready: true, detail: 'ok' }, CLAUDE: { ready: true, detail: 'ok' },
        CLAUDE_CODE: { ready: false, detail: 'Claude Code : binaire absent', state: 'ABSENT' }, SEARCH: { ready: true, detail: 'ok' },
      },
      spend: { todayUsd: 0, unknownCalls: 0, dailyLimitUsd: null, mode: 'UNLIMITED', remainingUsd: null, salesDailyBudgetUsd: 1, salesSpentTodayUsd: 0, salesRemainingUsd: 1 },
    } as unknown as AutopilotObservation;
    const p: AutopilotProposal = {
      objective: 'corriger', category: 'RELIABILITY', expectedBusinessValue: 'MEDIUM', expectedCostUsd: 0.2, expectedFounderTimeMinutes: 0,
      confidence: 0.8, urgency: 'NORMAL', evidence: [], risk: 'LOW', reversibility: 'REVERSIBLE', recommendedAgent: 'CLAUDE_CODE',
      requiresHumanApproval: false, reason: 'test', execution: { kind: 'INTERNAL_TASK', taskType: 'ENGINEERING_CHANGE', department: 'ENGINEERING' },
    };
    const verdict = decideAutonomy(p, { observation, config, cycleSpentUsd: 0 });
    assert.equal(verdict.verdict, 'BLOCKED');
    assert.match(verdict.reason, /binaire absent/);
  });

  test('le daemon du serveur, en ingénierie externe, ne prend jamais CLAUDE / CLAUDE_CODE', async () => {
    assert.deepEqual([...serverWorkerTypes('embedded')], [...DEFAULT_WORKER_TYPES]);
    const external = serverWorkerTypes('external');
    for (const t of ENGINEERING_WORKER_TYPES) assert.ok(!external.includes(t), `${t} reste au runner`);
    assert.ok(external.includes('DETERMINISTIC') && external.includes('OPENAI') && external.includes('HUMAN'));

    const task = repos.tasks.create({ taskType: 'ENGINEERING_CHANGE', department: 'ENGINEERING', workerType: 'CLAUDE_CODE', payload: { objective: 'x' } }).task;
    const registry = new WorkerRegistry().register(new ClaudeCodeWorker({ repos, logger, repoRoot: dir, timeoutMs: 1_000, maxFilesChanged: 1, maxDiffLines: 10, binary: join(dir, 'absent') }));
    await new AtlasDaemon({ repos, registry, logger, workerTypes: serverWorkerTypes('external'), leaseMs: 10_000, heartbeatMs: 500, maxIdleMs: 20, maxCycles: 2 }).run();
    assert.equal(repos.tasks.byId(task.taskId)!.status, 'QUEUED', 'laissée en file pour atlas-engineer, pas échouée faute de binaire');
  });
});

// ─── Le worktree isolé ───────────────────────────────────────────────────────

describe('3. un worktree jetable : le dépôt principal et ses secrets restent hors d’atteinte', () => {
  test('création, isolement, retrait', () => {
    const repoRoot = seedRepo();
    mkdirSync(join(repoRoot, 'node_modules', 'marker'), { recursive: true });
    writeFileSync(join(repoRoot, 'node_modules', 'marker', 'index.js'), 'module.exports = 1;\n', 'utf8');
    const head = inspectRepo(repoRoot).head;

    const ws = createWorkspace({ repoRoot, taskId: 'tsk_iso', root: join(dir, 'ws') });
    assert.ok(existsSync(join(ws.path, 'fixture', 'add.ts')));
    assert.equal(ws.baseCommit, head);
    assert.equal(existsSync(join(ws.path, '.env')), false, 'le secret ignoré par git n’est pas dans le worktree');
    assert.match(readFileSync(join(repoRoot, '.env'), 'utf8'), /SECRET=intact/);

    // Les dépendances : par lien (POSIX), jamais par copie ; sous Windows, rien — et c'est dit.
    const linked = linkNodeModules(repoRoot, ws.path);
    if (process.platform === 'win32') {
      assert.equal(linked, false);
      assert.equal(existsSync(join(ws.path, 'node_modules')), false, 'aucune jonction sous Windows');
    } else {
      assert.equal(lstatSync(join(ws.path, 'node_modules')).isSymbolicLink(), true, 'créé à la création du worktree');
      assert.equal(linked, false, 'déjà présent : rien de plus');
    }

    // Écrire dans le worktree ne touche pas le dépôt principal.
    writeFileSync(join(ws.path, 'fixture', 'add.ts'), '// édité dans le worktree\n', 'utf8');
    assert.equal(inspectRepo(repoRoot).clean, true);
    assert.match(readFileSync(join(repoRoot, 'fixture', 'add.ts'), 'utf8'), /return a \+ b/);

    assert.equal(removeWorkspace(repoRoot, ws), true);
    assert.equal(existsSync(ws.path), false);
    assert.ok(existsSync(join(repoRoot, 'node_modules', 'marker', 'index.js')), 'retirer le worktree n’a pas suivi le lien');
    assert.equal(inspectRepo(repoRoot).clean, true);
  });
});

// ─── La chaîne, sans personne au milieu, jusqu'à la porte humaine ───────────

describe('4. revue → ingénierie → revue, enchaînées par le daemon, arrêtées à READY_FOR_HUMAN_DEPLOYMENT', () => {
  test('Hermes crée les suites depuis le daemon ; le diff attend une personne ; rien n’est déployé, rien n’est envoyé', async () => {
    const repoRoot = seedRepo();
    const fakeBin = writeFakeClaudeCode(dir);
    const openai = new FixtureAiProvider('OPENAI', 'gpt-5', [
      { body: { status: 'CHANGES_REQUIRED', summary: 'add() accepte NaN', confidence: 0.92, findings: [], recommendations: [], artifacts: [], next_tasks: [{ task_type: 'ENGINEERING_CHANGE', objective: 'valider les entrées de add' }] }, usage: { inputTokens: 1000, outputTokens: 200 } },
      { body: { status: 'PASS', summary: 'validation couverte', confidence: 0.95, findings: [], recommendations: [], artifacts: [], next_tasks: [] }, usage: { inputTokens: 800, outputTokens: 100 } },
    ]);
    const registry = new WorkerRegistry()
      .register(new OpenAiWorker({ repos, provider: openai, timeoutMs: 30_000 }))
      .register(new ClaudeCodeWorker({ repos, logger, repoRoot, worktreeRoot: join(dir, 'ws'), timeoutMs: 60_000, maxFilesChanged: 15, maxDiffLines: 800, binary: fakeBin }));
    const hermes = new HermesRouter({ repos, logger, limits: { maxDepth: 4, maxTasks: 12, maxCostUsd: 1, maxRuntimeMinutes: 60, unknownCostPolicy: 'ALLOW' } });

    const root = repos.tasks.create({
      taskType: 'ARCHITECTURE_REVIEW', department: 'ENGINEERING', workerType: 'OPENAI',
      payload: { objective: 'relire le module fixture', repo_target: 'fixture/add.ts', allowed_paths: ['fixture'], autopilot_action_id: 'act_test' },
    }).task;

    // Un seul daemon, avec Hermes : personne ne relance rien entre deux tâches.
    const stats = await new AtlasDaemon({ repos, registry, logger, hermes, hostLabel: ENGINEER_HOST_LABEL, leaseMs: 60_000, heartbeatMs: 1_000, maxIdleMs: 50, maxCycles: 8 }).run();
    assert.ok(stats.completed >= 3, `${stats.completed} terminée(s)`);

    const chain = repos.tasks.chainTasks(root.chainId ?? root.taskId);
    assert.deepEqual(chain.map((t) => `${t.workerType}:${t.taskType}:${t.status}`), [
      'OPENAI:ARCHITECTURE_REVIEW:DONE', 'CLAUDE_CODE:ENGINEERING_CHANGE:DONE', 'OPENAI:FINAL_REVIEW:DONE',
    ]);
    assert.deepEqual(chain[1]!.payload.allowed_paths, ['fixture'], 'le périmètre hérité par Hermes');
    assert.equal((chain[2]!.result as { status: string }).status, 'PASS');

    // Le daemon s'est inscrit sous le nom du runner : la boucle le voit vivant… jusqu'à son arrêt.
    const runs = repos.tasks.daemonRuns(5).filter((r) => r.host === ENGINEER_HOST_LABEL);
    assert.equal(runs.length, 1);
    assert.ok(runs[0]!.stoppedAt, 'arrêt consigné');

    // Le verdict de l'Autopilot : READY_FOR_HUMAN_DEPLOYMENT — WAITING_HUMAN, jamais DONE, jamais appliqué.
    const verdict = verdictFromTasks(repos, repos.tasks.byId(root.taskId)!);
    assert.equal(verdict.status, 'WAITING_HUMAN');
    assert.match(verdict.reason, /READY_FOR_HUMAN_DEPLOYMENT/);
    assert.equal(repos.tasks.workspacesInState('READY_FOR_REVIEW').length, 1);
    assert.equal(repos.tasks.workspacesInState('APPLIED').length, 0);

    // Le dépôt principal : intact, secret compris ; le worktree n'a jamais vu le .env.
    assert.equal(inspectRepo(repoRoot).clean, true);
    assert.match(readFileSync(join(repoRoot, 'fixture', 'add.ts'), 'utf8'), /return a \+ b;\n}\n$/);
    assert.match(readFileSync(join(repoRoot, '.env'), 'utf8'), /sk-prod-never-copied/);
    const workspace = repos.tasks.workspacesInState('READY_FOR_REVIEW')[0]!;
    assert.equal(readFileSync(join(workspace.path, 'fixture', 'seen-env.txt'), 'utf8'), 'false');

    // Aucun e-mail, aucun envoi : la chaîne d'ingénierie ne connaît pas la boîte.
    assert.equal(repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z'), 0);
    assert.ok(!repos.tasks.list({ limit: 100 }).some((t) => t.taskType === 'SALES_SEND'));

    execFileSync('git', ['worktree', 'remove', '--force', workspace.path], { cwd: repoRoot });
  });

  test('une suite hors de la table de routage (un envoi, par exemple) ne crée rien, même avec Hermes', async () => {
    const openai = new FixtureAiProvider('OPENAI', 'gpt-5', [{ body: { status: 'PASS', summary: 'x', confidence: 0.9, findings: [], recommendations: [], artifacts: [], next_tasks: [{ task_type: 'SALES_SEND', objective: 'écrire au prospect' }, { task_type: 'APPROVE_PAYMENT', objective: 'payer' }] } }]);
    const registry = new WorkerRegistry().register(new OpenAiWorker({ repos, provider: openai, timeoutMs: 30_000 }));
    const hermes = new HermesRouter({ repos, logger, limits: { maxDepth: 4, maxTasks: 12, maxCostUsd: 1, maxRuntimeMinutes: 60, unknownCostPolicy: 'ALLOW' } });
    const root = repos.tasks.create({ taskType: 'ARCHITECTURE_REVIEW', department: 'ENGINEERING', workerType: 'OPENAI', payload: { objective: 'relire' } }).task;
    await new AtlasDaemon({ repos, registry, logger, hermes, leaseMs: 30_000, heartbeatMs: 500, maxIdleMs: 20, maxCycles: 3 }).run();
    const all = repos.tasks.list({ limit: 20 });
    assert.equal(all.length, 2, 'la revue, et la porte humaine APPROVE_PAYMENT (routée vers HUMAN) — jamais un envoi');
    assert.ok(!all.some((t) => t.taskType === 'SALES_SEND'));
    assert.equal(all.find((t) => t.taskType === 'APPROVE_PAYMENT')?.workerType, 'HUMAN');
    assert.equal(repos.tasks.byId(root.taskId)!.status, 'DONE');
  });

  test('sans Hermes, le daemon ne crée rien : la suite vit dans le résultat, pas dans la file', async () => {
    const openai = new FixtureAiProvider('OPENAI', 'gpt-5', [{ body: { status: 'CHANGES_REQUIRED', summary: 'x', confidence: 0.9, findings: [], recommendations: [], artifacts: [], next_tasks: [{ task_type: 'ENGINEERING_CHANGE', objective: 'corriger' }] } }]);
    const registry = new WorkerRegistry().register(new OpenAiWorker({ repos, provider: openai, timeoutMs: 30_000 }));
    repos.tasks.create({ taskType: 'ARCHITECTURE_REVIEW', department: 'ENGINEERING', workerType: 'OPENAI', payload: { objective: 'relire' } });
    await new AtlasDaemon({ repos, registry, logger, leaseMs: 30_000, heartbeatMs: 500, maxIdleMs: 20, maxCycles: 2 }).run();
    assert.equal(Object.values(repos.tasks.countByStatus()).reduce((s, n) => s + n, 0), 1);
  });
});

// ─── Ce que le déploiement dit de lui-même ──────────────────────────────────

describe('5. atlas-engineer, tel que Compose et le Dockerfile le décrivent', () => {
  // Lus tels que git les a posés sur ce poste : un checkout Windows peut
  // les écrire en CRLF, et ce n'est pas ce que le test juge.
  const text = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
  const compose = text('deployment', 'docker-compose.yml');
  const dockerfile = text('deployment', 'Dockerfile');
  const entrypoint = text('deployment', 'engineer-entrypoint.sh');

  /** Le bloc d'un service, de son nom jusqu'au service suivant. */
  const service = (name: string): string => {
    const start = compose.indexOf(`\n  ${name}:\n`);
    assert.ok(start >= 0, `service ${name}`);
    const rest = compose.slice(start + 1);
    const next = rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/);
    return next >= 0 ? rest.slice(0, next + 1) : rest;
  };
  const envKeys = (block: string): string[] => [...block.matchAll(/^      ([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]!);

  test('profil engineering, aucun env_file, aucun port, dépôt en lecture seule, réseau à part', () => {
    const block = service('atlas-engineer');
    assert.match(block, /profiles: \["engineering"\]/);
    assert.doesNotMatch(block, /env_file/, 'le .env du serveur ne lui parvient jamais entier');
    assert.doesNotMatch(block, /^\s+ports:/m, 'aucun port');
    assert.match(block, /- \.\.:\/host-repo:ro/, 'le dépôt déployé, en lecture seule');
    assert.match(block, /- atlas-data:\/data/, 'la base canonique : la file de tâches vit là');
    assert.match(block, /- atlas-engineer-work:\/work/);
    assert.match(block, /- atlas-engineer-claude:\/home\/node\/\.claude$/m, 'la session par abonnement survit aux recréations');
    assert.match(block, /networks: \[engineering\]/, 'jamais sur le réseau du serveur');
    assert.doesNotMatch(block, /networks: \[atlas\]/);
    assert.match(block, /target: engineer/);
    assert.match(compose, /^\s+engineering:\n\s+driver: bridge/m);
    assert.match(compose, /^\s+atlas-engineer-work:$/m);
    assert.match(compose, /^volumes:\n(?: {2}[a-z0-9-]+:\n)* {2}atlas-engineer-claude:$/m, 'le volume de session, déclaré au niveau racine');
  });

  test('les variables : une liste fermée — ni Gmail, ni OpenAI, ni le secret de session réel ; envoi coupé, mode interne', () => {
    const block = service('atlas-engineer');
    const keys = envKeys(block);
    const allowed = new Set([
      'NODE_ENV', 'ATLAS_DATA_DIR', 'ATLAS_BACKUP_DIR', 'ATLAS_LOG_PRETTY', 'ATLAS_CLI_CONTEXT',
      'ATLAS_ENGINEERING_RUNNER', 'ATLAS_ENGINEER_REPO', 'ATLAS_ENGINEERING_WORKSPACE_ROOT', 'ATLAS_HOST_REPO',
      'ATLAS_CLAUDE_CODE_USE_API_KEY', 'ATLAS_CLAUDE_CODE_BIN', 'ANTHROPIC_API_KEY', 'ATLAS_AI_LIVE',
      'ATLAS_ANTHROPIC_MODEL', 'ATLAS_ANTHROPIC_ENGINEERING_MODEL',
      'ATLAS_AI_DAILY_BUDGET_USD', 'ATLAS_AI_MONTHLY_BUDGET_USD', 'ATLAS_MAX_TASK_COST_USD', 'ATLAS_MAX_AI_CHAIN_DEPTH',
      'ATLAS_MAX_AI_TASKS_PER_CHAIN', 'ATLAS_MAX_CHAIN_COST_USD', 'ATLAS_MAX_CHAIN_RUNTIME_MINUTES', 'ATLAS_UNKNOWN_COST_POLICY',
      'ATLAS_MAX_FILES_CHANGED_PER_TASK', 'ATLAS_MAX_DIFF_LINES_PER_TASK', 'ATLAS_MAX_ENGINEERING_ITERATIONS', 'ATLAS_ALLOW_FILE_DELETE',
      'ATLAS_CLAUDE_TASK_TIMEOUT_MS', 'ATLAS_CLAUDE_CODE_TIMEOUT_MS',
      'ATLAS_SESSION_SECRET', 'ATLAS_OUTBOUND_ENABLED', 'ATLAS_ENGINE_MODE',
    ]);
    assert.ok(keys.length > 10);
    for (const k of keys) assert.ok(allowed.has(k), `${k} n’est pas dans la liste fermée`);
    for (const forbidden of ['GMAIL_', 'ATLAS_OPENAI_API_KEY', 'SEARXNG', 'N8N', 'ATLAS_FOUNDER_PASSWORD']) {
      assert.ok(!keys.some((k) => k.startsWith(forbidden)), `${forbidden} ne lui parvient pas`);
    }
    assert.match(block, /ATLAS_OUTBOUND_ENABLED: "false"/);
    assert.match(block, /ATLAS_ENGINE_MODE: INTERNAL_TEST/);
    // Deux choses distinctes : Claude Code sur l'abonnement, et la clé Anthropic
    // présente pour les autres workers IA. C'est childEnv (claude-code.ts) qui
    // la retire au seul binaire Claude Code — voir claude-code.test.ts.
    assert.match(block, /ATLAS_CLAUDE_CODE_USE_API_KEY: "false"/, 'Claude Code sur l’abonnement, jamais facturé à la clé');
    assert.match(block, /ANTHROPIC_API_KEY: \$\{ANTHROPIC_API_KEY:-\}/, 'la clé des workers Anthropic directs, par interpolation, jamais en clair');
    assert.match(block, /ATLAS_SESSION_SECRET: atlas-engineer-has-no-http-server/, 'pas le secret du serveur');
    assert.match(block, /ATLAS_ENGINEER_REPO: \/work\/repo/);
    // Le serveur, lui, garde son .env entier ; et rien de ce qu'on ajoute ne le touche.
    assert.match(service('atlas'), /env_file: \.\.\/\.env/);
  });

  test('l’étape engineer : depuis cli, git + claude-code, utilisateur node ; l’étape finale reste runtime', () => {
    assert.match(dockerfile, /^FROM cli AS engineer$/m);
    const stage = dockerfile.slice(dockerfile.indexOf('FROM cli AS engineer'), dockerfile.indexOf('FROM node:24-bookworm-slim AS runtime'));
    assert.match(stage, /apt-get install -y --no-install-recommends git/);
    assert.match(stage, /npm install -g @anthropic-ai\/claude-code/);
    assert.match(stage, /^USER node$/m);
    assert.match(stage, /engineer-entrypoint\.sh/);
    assert.doesNotMatch(stage, /EXPOSE/);
    assert.doesNotMatch(stage, /COPY \.env|env_file/);
    const stages = [...dockerfile.matchAll(/^FROM .* AS (\w+)$/gm)].map((m) => m[1]);
    assert.deepEqual(stages, ['build', 'cli', 'engineer', 'runtime'], 'un build sans --target produit toujours le serveur');
  });

  test('le point d’entrée : clone jetable du dépôt monté, jamais une écriture dedans, jamais un déploiement', () => {
    assert.match(entrypoint, /^set -eu$/m);
    assert.match(entrypoint, /git clone --quiet --no-hardlinks "\$\{HOST_REPO\}" "\$\{REPO\}"/);
    assert.match(entrypoint, /fetch --quiet origin HEAD/);
    assert.match(entrypoint, /reset --quiet --hard FETCH_HEAD/);
    // Sur le dépôt hôte : lire, et rien d'autre.
    const onHost = [...entrypoint.matchAll(/git -C "\$\{HOST_REPO\}" (\S+)/g)].map((m) => m[1]);
    for (const verb of onHost) assert.ok(['rev-parse', 'log', 'status'].includes(verb!), `git ${verb} sur le dépôt hôte`);
    for (const forbidden of ['docker compose', 'up -d', 'atlas:apply', 'git push', 'systemctl', 'npm run build', 'npm install', 'npm ci']) {
      assert.ok(!entrypoint.includes(forbidden), `« ${forbidden} » n’a rien à faire ici`);
    }
    assert.match(entrypoint, /exec node --import tsx \/app\/scripts\/atlas-engineer\.ts/);

    // La syntaxe, si un bash est là pour la lire.
    const bash = process.platform === 'win32'
      ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find((p) => existsSync(p)) ?? null
      : (spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).status === 0 ? 'bash' : null);
    if (bash) {
      const r = spawnSync(bash, ['-n', join(ROOT, 'deployment', 'engineer-entrypoint.sh').replace(/\\/g, '/')], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    }
  });

  test('le runner lui-même ne sert que l’ingénierie et la découverte commerciale, et ne déploie pas', () => {
    const script = text('scripts', 'atlas-engineer.ts');
    // Exactement ces trois types : ni OPENAI, ni HUMAN, ni le DETERMINISTIC
    // ordinaire (boîte, envoi) — seulement ce que ce conteneur a de quoi servir.
    assert.match(script, /workerTypes: \['CLAUDE', 'CLAUDE_CODE', \.\.\.EXTERNAL_TOOLS_WORKER_TYPES\]/);
    assert.match(script, /hostLabel: ENGINEER_HOST_LABEL/);
    assert.match(script, /hermes/);
    // Seul le handler de découverte est repris — pas toute la carte commerciale.
    assert.match(script, /SALES_ENGINE_TASKS\.DISCOVERY\]: salesHandlers\[SALES_ENGINE_TASKS\.DISCOVERY\]/);
    for (const forbidden of ['applyToRepo', 'docker', 'GmailOutboundProvider', 'OpenAiWorker', 'SALES_SEND', 'REPLY_SYNC', 'FOLLOW_UP']) {
      assert.ok(!script.includes(forbidden), `« ${forbidden} » n’a rien à faire dans le runner`);
    }
    assert.match(text('package.json'), /"atlas:engineer": "tsx scripts\/atlas-engineer\.ts"/);
  });
});
