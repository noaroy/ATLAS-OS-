import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../core/src/logger.ts';
import type { AtlasConfig } from '../../core/src/index.ts';
import { createRepositories, type Repositories, type TaskRow } from '../../data/src/index.ts';
import { classifyAiError, type AiProvider, type AiRequest, type AiResponse } from '../../llm/src/index.ts';
import { makeTestConfig } from '../../testing/src/index.ts';
import {
  parseSupervisorDecision, runSupervisorPoll, startObjective, scheduleSupervisorPoll, createSupervisorHandlers,
  supervisorStatus, supervisorReadiness, childClaimKey, SUPERVISOR_DECISION_SCHEMA, SUPERVISOR_POLL_TASK_TYPE,
  SUPERVISOR_LEDGER, routeTask, AtlasDaemon, WorkerRegistry, HermesRouter, DeterministicWorker,
  type GptSupervisorDeps, type Worker, type WorkerOutcome,
} from '../src/index.ts';

/**
 * Le superviseur GPT, éprouvé sans OpenAI.
 *
 * GPT est remplacé par un fournisseur scripté : chaque appel reçoit le prompt
 * réel et rend le texte que le scénario décide — décision valide, prose,
 * délai, refus. Le reste est le code réel : la file de tâches, le registre des
 * opérations externes, Hermes, les tables du superviseur, et SQLite comme
 * arbitre des courses.
 */

const logger = createLogger({ level: 'error', pretty: false });
const PRICING = { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 };
const OPENAI_KEY_VALUE = 'sk-proj-SUPERVISORTESTKEY0123456789abcdefghij';

let dir: string;
let repos: Repositories;
let config: AtlasConfig;

type Step = (req: AiRequest, ids: { objectiveId: string; taskId: string }) => string | Error | Promise<string | Error>;

/** Un GPT scripté : il lit les identifiants dans le prompt, comme le vrai doit les recopier. */
class ScriptedProvider implements AiProvider {
  readonly provider = 'OPENAI' as const;
  readonly calls: AiRequest[] = [];
  constructor(private readonly script: Step[], readonly model = 'gpt-5', private readonly configured = true, private readonly cost = 0.003) {}
  status() {
    return this.configured
      ? { configured: true, code: 'OPENAI_READY', detail: 'modèle gpt-5' }
      : { configured: false, code: 'OPENAI_NOT_CONFIGURED', detail: 'variable absente : ATLAS_OPENAI_API_KEY' };
  }
  async execute(req: AiRequest): Promise<AiResponse> {
    this.calls.push(req);
    const step = this.script[Math.min(this.calls.length - 1, this.script.length - 1)]!;
    const objectiveId = /"objective_id": "([^"]+)"/.exec(req.prompt)?.[1] ?? '';
    const taskId = /"reviewed_task_id": "([^"]+)"/.exec(req.prompt)?.[1] ?? '';
    const out = await step(req, { objectiveId, taskId });
    if (out instanceof Error) throw out;
    return {
      text: out, structured: null,
      usage: { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 0, costUsd: this.cost, costBasis: 'KNOWN' },
      model: this.model, provider: 'OPENAI', durationMs: 3, truncated: false,
    };
  }
  classifyError(error: unknown) {
    const e = error as { status?: number; message?: string };
    return classifyAiError({ status: e.status ?? null, message: e.message ?? String(error) });
  }
}

const decision = (kind: string, over: Record<string, unknown> = {}): Step => (_req, ids) => JSON.stringify({
  schema: SUPERVISOR_DECISION_SCHEMA,
  objective_id: ids.objectiveId,
  reviewed_task_id: ids.taskId,
  decision: kind,
  summary: `décision ${kind}`,
  reasons: ['relu sur le diff constaté'],
  next_task: kind === 'NEXT_TASK' || kind === 'CORRECT'
    ? { objective: `Étape suivante numéro ${Math.random().toString(36).slice(2, 8)} : ajouter les tests de fixture/add.ts`, acceptance_criteria: ['les tests passent'], test_commands: [] }
    : null,
  blocked_reason: kind === 'BLOCKED' ? 'une décision humaine est nécessaire' : null,
  ...over,
});

const liveConfig = (over: Partial<AtlasConfig['supervisor']> = {}, ai: Partial<AtlasConfig['ai']> = {}): AtlasConfig => ({
  ...config,
  ai: { ...config.ai, live: true, ...ai },
  supervisor: { ...config.supervisor, enabled: true, ...over },
});

const deps = (provider: AiProvider, over: Partial<GptSupervisorDeps> = {}, cfg: AtlasConfig = liveConfig()): GptSupervisorDeps => ({
  repos, config: cfg, logger, provider, actor: 'test-supervisor', pricing: () => PRICING, ...over,
});

const start = (key = 'obj-1', objective = 'Ajouter une validation des entrées dans fixture/add.ts', cfg: AtlasConfig = liveConfig()) => {
  const outcome = startObjective(repos, cfg, {
    key, objective, allowedPaths: ['fixture/add.ts', 'fixture/add.test.ts'], testCommands: ['npm run typecheck'],
    acceptanceCriteria: ['add refuse les entrées non finies'],
  });
  assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.reasons.join(' · '));
  if (!outcome.ok) throw new Error('start');
  return outcome;
};

/**
 * Faire « travailler » Claude Code sur une tâche, sans binaire : la tâche est
 * prise, terminée en READY_FOR_REVIEW avec un diff et une attestation
 * d'abonnement — exactement ce que ClaudeCodeWorker consigne.
 */
function finishTask(taskId: string, over: {
  diffHash?: string; base?: string; billing?: string | null; status?: 'READY' | 'FAILED' | 'NEEDS_HUMAN'; diff?: string; summary?: string;
} = {}): TaskRow {
  const claimed = repos.tasks.claim({ owner: 'fake-engineer', leaseMs: 60_000, workerTypes: ['CLAUDE_CODE'] });
  assert.equal(claimed.task?.taskId, taskId, `la tâche ${taskId} devait être la prochaine prise`);
  const task = claimed.task!;
  const diff = over.diff ?? `diff --git a/fixture/add.ts b/fixture/add.ts\n+// ${over.diffHash ?? taskId}\n`;
  repos.tasks.saveArtifact({ taskId, kind: 'DIFF', content: diff });
  repos.tasks.recordAiCall({
    taskId, chainId: task.chainId, provider: 'ANTHROPIC', model: 'claude-code', capability: 'ENGINEERING',
    inputTokens: 0, outputTokens: 0, costUsd: null, costBasis: 'UNKNOWN_PRICE', outcome: 'OK',
  });
  if (over.status === 'FAILED') {
    repos.tasks.fail({ taskId, actor: 'fake-engineer', errorCode: 'CLAUDE_CODE_FAILED', errorMessage: 'le processus a rendu 3' });
    return repos.tasks.byId(taskId)!;
  }
  if (over.status === 'NEEDS_HUMAN') {
    repos.tasks.waitForHuman(taskId, 'fake-engineer', 'CHANGE_BUDGET_EXCEEDED : 900 lignes', 'CHANGE_BUDGET_EXCEEDED');
    return repos.tasks.byId(taskId)!;
  }
  repos.tasks.complete(taskId, {
    status: 'ENGINEERING_READY_FOR_REVIEW',
    summary: over.summary ?? 'validation ajoutée',
    files_changed: ['fixture/add.ts'], files_added: [], files_deleted: [],
    diff_lines: 2, diff_hash: over.diffHash ?? `hash-${taskId}`, base_commit: over.base ?? 'a'.repeat(40),
    ...(over.billing === null ? {} : { claude_code_billing: over.billing ?? 'SUBSCRIPTION' }),
  }, 'fake-engineer');
  return repos.tasks.byId(taskId)!;
}

const objectiveTasks = (chainId: string) => repos.tasks.chainTasks(chainId).filter((t) => t.taskType === 'ENGINEERING_CHANGE');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-gpt-supervisor-'));
  config = makeTestConfig(dir);
  repos = createRepositories(join(dir, 'atlas.db'), logger);
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

// ─── La décision ─────────────────────────────────────────────────────────────

describe('la décision GPT : un objet JSON versionné, et rien d’autre', () => {
  const ids = { objectiveId: 'sob_1', taskId: 'tsk_1' };
  const valid = (over: Record<string, unknown> = {}) => JSON.stringify({
    schema: SUPERVISOR_DECISION_SCHEMA, objective_id: 'sob_1', reviewed_task_id: 'tsk_1', decision: 'COMPLETE',
    summary: 'fait', reasons: ['ok'], next_task: null, blocked_reason: null, ...over,
  });

  test('une décision conforme se lit', () => {
    const v = parseSupervisorDecision(`  ${valid()}\n`, ids);
    assert.equal(v.ok, true);
    if (v.ok) assert.equal(v.decision.decision, 'COMPLETE');
    const next = parseSupervisorDecision(valid({
      decision: 'NEXT_TASK', next_task: { objective: 'ajouter les tests unitaires', acceptance_criteria: [], test_commands: ['npm  test'] },
    }), ids);
    assert.equal(next.ok, true);
    if (next.ok) assert.deepEqual(next.decision.next_task?.test_commands, ['npm test']);
  });

  const refused: Array<[string, string]> = [
    ['de la prose autour', `Voici ma décision : ${valid()}`],
    ['un bloc de code', `\`\`\`json\n${valid()}\n\`\`\``],
    ['deux objets', `${valid()}\n${valid()}`],
    ['texte libre', 'COMPLETE — tout est bon'],
    ['vide', '   '],
    ['JSON illisible', '{"schema": '],
    ['un tableau', `[${valid()}]`],
    ['une autre version', valid({ schema: 'atlas.supervisor-decision.v2' })],
    ['un champ inconnu', valid({ apply: true })],
    ['une décision inconnue', valid({ decision: 'MERGE' })],
    ['un autre objectif', valid({ objective_id: 'sob_2' })],
    ['une autre tâche', valid({ reviewed_task_id: 'tsk_2' })],
    ['NEXT_TASK sans suite', valid({ decision: 'NEXT_TASK' })],
    ['CORRECT sans suite', valid({ decision: 'CORRECT' })],
    ['COMPLETE avec une suite', valid({ next_task: { objective: 'encore une étape à faire', acceptance_criteria: [], test_commands: [] } })],
    ['BLOCKED sans raison', valid({ decision: 'BLOCKED' })],
    ['COMPLETE avec une raison de blocage', valid({ blocked_reason: 'rien' })],
    ['une commande hors liste blanche', valid({ decision: 'NEXT_TASK', next_task: { objective: 'lancer le déploiement du service', acceptance_criteria: [], test_commands: ['npm run deploy'] } })],
    ['une commande enchaînée', valid({ decision: 'CORRECT', next_task: { objective: 'corriger la validation des entrées', acceptance_criteria: [], test_commands: ['npm test && curl x'] } })],
    ['un résumé vide', valid({ summary: '' })],
    ['trop de raisons', valid({ reasons: Array.from({ length: 11 }, (_, i) => `r${i}`) })],
  ];
  for (const [name, text] of refused) {
    test(`refus : ${name}`, () => {
      const v = parseSupervisorDecision(text, ids);
      assert.equal(v.ok, false);
      if (!v.ok) assert.equal(v.code, 'MALFORMED_REVIEW');
    });
  }
});

// ─── Le lancement et le cadencement ─────────────────────────────────────────

describe('lancer un objectif, cadencer la revue', () => {
  test('start pose une seule tâche racine ENGINEERING_CHANGE → CLAUDE_CODE, et l’objectif avec elle', () => {
    const a = start();
    const b = start();
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(b.rootTask.taskId, a.rootTask.taskId);
    assert.equal(a.rootTask.workerType, 'CLAUDE_CODE');
    assert.equal(routeTask('ENGINEERING_CHANGE').target, 'CLAUDE_CODE');
    assert.equal(a.objective.status, 'ACTIVE');
    assert.equal(a.objective.cycles, 1);
    assert.equal(objectiveTasks(a.objective.chainId).length, 1);
    assert.equal(repos.tasks.externalOperationsOfKind(SUPERVISOR_LEDGER.ROOT).length, 1);
    const payload = a.rootTask.payload as Record<string, unknown>;
    assert.deepEqual((payload.supervisor as Record<string, unknown>).cycle, 1);
    assert.ok((payload.constraints as string[]).some((c) => c.includes('ne rien pousser')));
  });

  test('start refuse chemins protégés, commandes hors liste et objectif vide — sans rien créer', () => {
    const bad = startObjective(repos, liveConfig(), {
      key: 'bad', objective: 'court', allowedPaths: ['.env', '../etc', 'deployment/x'], testCommands: ['rm -rf /'],
    });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.ok(bad.reasons.length >= 4);
    assert.equal(repos.tasks.list().length, 0);
  });

  test('le tour se pose une fois par période, et seulement ouvert', () => {
    const now = new Date('2026-09-24T22:00:30Z');
    assert.deepEqual(scheduleSupervisorPoll(repos, config, now), { created: [], existing: [] });
    const cfg = liveConfig();
    assert.equal(scheduleSupervisorPoll(repos, cfg, now).created.length, 1);
    assert.equal(scheduleSupervisorPoll(repos, cfg, new Date('2026-09-24T22:01:10Z')).existing.length, 1);
    assert.equal(routeTask(SUPERVISOR_POLL_TASK_TYPE).target, 'DETERMINISTIC');
  });

  test('fermé, sans clé, ou sans ATLAS_AI_LIVE : aucune revue, aucun appel', async () => {
    const o = start();
    finishTask(o.rootTask.taskId);
    for (const [cfg, provider] of [
      [config, new ScriptedProvider([decision('COMPLETE')])],
      [liveConfig({}, { live: false }), new ScriptedProvider([decision('COMPLETE')])],
      [liveConfig(), new ScriptedProvider([decision('COMPLETE')], 'gpt-5', false)],
    ] as const) {
      const report = await runSupervisorPoll(deps(provider, {}, cfg));
      assert.equal(report.ran, false);
      assert.ok(report.skipped.length > 0);
      assert.equal(provider.calls.length, 0);
    }
    assert.equal(repos.supervisor.reviewsFor(o.objective.objectiveId).length, 0);
    assert.equal(supervisorReadiness({ config: liveConfig(), provider: new ScriptedProvider([]), pricing: () => PRICING }).ready, true);
  });
});

// ─── Le parcours : deux tours ───────────────────────────────────────────────

describe('READY_FOR_REVIEW → GPT → exactement une suite → READY_FOR_REVIEW → COMPLETE', () => {
  test('deux tours de contrôleur, sans personne, et rien d’appliqué', async () => {
    const o = start();
    const provider = new ScriptedProvider([decision('NEXT_TASK'), decision('COMPLETE')]);

    // Rien à relire tant que Claude Code n'a pas rendu.
    let report = await runSupervisorPoll(deps(provider));
    assert.equal(report.reviewed.length, 0);
    assert.equal(provider.calls.length, 0);

    finishTask(o.rootTask.taskId, { diffHash: 'h1' });
    report = await runSupervisorPoll(deps(provider));
    assert.equal(report.reviewed.length, 1);
    assert.equal(report.reviewed[0]!.decision, 'NEXT_TASK');
    assert.equal(provider.calls.length, 1);

    let tasks = objectiveTasks(o.objective.chainId);
    assert.equal(tasks.length, 2, 'exactement une suite');
    const child = tasks[1]!;
    assert.equal(child.workerType, 'CLAUDE_CODE');
    assert.equal(child.parentTaskId, o.rootTask.taskId);
    assert.equal(child.chainDepth, 1);
    assert.equal(child.status, 'QUEUED');
    assert.equal(child.maxAttempts, 1);
    const sup = child.payload.supervisor as Record<string, unknown>;
    assert.equal(sup.cycle, 2);
    assert.equal(sup.stack_on_task_id, o.rootTask.taskId);
    assert.equal(sup.base_commit, 'a'.repeat(40));
    assert.deepEqual(child.payload.allowed_paths, ['fixture/add.ts', 'fixture/add.test.ts'], 'le périmètre est celui de l’objectif');
    assert.deepEqual(child.payload.test_commands, ['npm run typecheck']);
    assert.equal(repos.supervisor.objective(o.objective.objectiveId)!.cycles, 2);
    assert.ok(repos.tasks.externalOperation(childClaimKey(o.objective.objectiveId, 2))?.confirmed);

    // Relancer le tour ne relit rien et ne pose rien : idempotent.
    report = await runSupervisorPoll(deps(provider));
    assert.equal(report.reviewed.length, 0);
    assert.equal(report.deferred.length, 0);
    assert.deepEqual(repos.supervisor.pendingTaskIds(10), [], 'une tâche décidée n’est même plus candidate');
    assert.equal(provider.calls.length, 1);
    assert.equal(objectiveTasks(o.objective.chainId).length, 2);

    // Redémarrage : une autre connexion, un autre processus, rien en mémoire.
    repos.close();
    repos = createRepositories(join(dir, 'atlas.db'), logger);

    finishTask(child.taskId, { diffHash: 'h2' });
    report = await runSupervisorPoll(deps(provider));
    assert.equal(report.reviewed[0]!.decision, 'COMPLETE');
    assert.equal(provider.calls.length, 2);

    const done = repos.supervisor.objective(o.objective.objectiveId)!;
    assert.equal(done.status, 'COMPLETE');
    assert.equal(done.terminalCode, 'COMPLETE');
    assert.equal(done.result?.final_task_id, child.taskId);
    assert.equal(done.result?.diff_hash, 'h2');
    assert.equal(done.result?.applied, false);
    assert.equal(done.result?.pushed, false);
    assert.equal(done.result?.deployed, false);
    tasks = objectiveTasks(o.objective.chainId);
    assert.equal(tasks.length, 2, 'COMPLETE ne pose rien');

    const reviews = repos.supervisor.reviewsFor(o.objective.objectiveId);
    assert.deepEqual(reviews.map((r) => [r.cycle, r.decision, r.reviewer, r.state]), [
      [1, 'NEXT_TASK', 'GPT', 'DECIDED'], [2, 'COMPLETE', 'GPT', 'DECIDED'],
    ]);
    assert.equal(reviews[0]!.childTaskId, child.taskId);
    assert.ok(reviews.every((r) => r.decisionJson?.schema === SUPERVISOR_DECISION_SCHEMA));

    // Un objectif terminé ne se relit plus.
    report = await runSupervisorPoll(deps(provider));
    assert.equal(provider.calls.length, 2);

    // Les revues GPT sont comptées dans la chaîne, au tarif connu.
    const cost = repos.tasks.chainCost(o.objective.chainId);
    assert.equal(cost.knownUsd, 0.006);

    const status = supervisorStatus(repos, liveConfig());
    assert.equal(status.objectives[0]!.objective.status, 'COMPLETE');
    assert.equal(status.objectives[0]!.tasks.length, 2);
  });

  test('CORRECT pose une correction comptée, sur le diff relu', async () => {
    const o = start();
    finishTask(o.rootTask.taskId);
    await runSupervisorPoll(deps(new ScriptedProvider([decision('CORRECT')])));
    const obj = repos.supervisor.objective(o.objective.objectiveId)!;
    assert.equal(obj.cycles, 2);
    assert.equal(obj.corrections, 1);
    const child = objectiveTasks(o.objective.chainId)[1]!;
    assert.equal((child.payload.supervisor as Record<string, unknown>).decision, 'CORRECT');
  });

  test('GPT BLOCKED arrête l’objectif avec sa raison, sans suite', async () => {
    const o = start();
    finishTask(o.rootTask.taskId);
    await runSupervisorPoll(deps(new ScriptedProvider([decision('BLOCKED')])));
    const obj = repos.supervisor.objective(o.objective.objectiveId)!;
    assert.equal(obj.status, 'BLOCKED');
    assert.equal(obj.terminalCode, 'GPT_BLOCKED');
    assert.equal(obj.terminalReason, 'une décision humaine est nécessaire');
    assert.equal(objectiveTasks(o.objective.chainId).length, 1);
  });
});

// ─── Concurrence, reprise, doublons ─────────────────────────────────────────

describe('idempotence : redémarrage, sondeurs concurrents, doublons', () => {
  test('deux sondeurs simultanés : une revue, un appel, une suite', async () => {
    const o = start();
    finishTask(o.rootTask.taskId);
    const slow: Step = async (req, ids) => {
      await new Promise((r) => setTimeout(r, 30));
      return decision('NEXT_TASK')(req, ids) as string;
    };
    const p1 = new ScriptedProvider([slow]);
    const p2 = new ScriptedProvider([slow]);
    const other = createRepositories(join(dir, 'atlas.db'), logger);
    try {
      const [a, b] = await Promise.all([
        runSupervisorPoll(deps(p1, { actor: 'poller-a' })),
        runSupervisorPoll({ ...deps(p2, { actor: 'poller-b' }), repos: other }),
      ]);
      assert.equal(p1.calls.length + p2.calls.length, 1, 'un seul appel GPT');
      assert.equal(a.reviewed.length + b.reviewed.length, 1);
    } finally {
      other.close();
    }
    assert.equal(objectiveTasks(o.objective.chainId).length, 2);
  });

  test('une réservation morte est reprise après son bail, une fois ; au-delà, REVIEW_STALLED', async () => {
    const o = start();
    finishTask(o.rootTask.taskId);
    const t0 = new Date();
    // Un processus a réservé puis est mort pendant l'appel.
    const dead = repos.supervisor.reserveReview({
      objectiveId: o.objective.objectiveId, taskId: o.rootTask.taskId, cycle: 1, owner: 'dead-process', leaseMs: 1_000, maxAttempts: 2,
      now: t0.toISOString(),
    });
    assert.equal(dead.reserved, true);

    const provider = new ScriptedProvider([decision('NEXT_TASK')]);
    // Bail courant : personne ne reprend.
    let report = await runSupervisorPoll(deps(provider, { now: () => t0 }));
    assert.equal(provider.calls.length, 0);
    assert.equal(report.deferred.length, 1);

    // Bail expiré : reprise, tentative 2, décision.
    const later = new Date(t0.getTime() + 5_000);
    report = await runSupervisorPoll(deps(provider, { now: () => later }));
    assert.equal(provider.calls.length, 1);
    const review = repos.supervisor.reviewForTask(o.rootTask.taskId)!;
    assert.equal(review.state, 'DECIDED');
    assert.equal(review.attempts, 2);
    assert.equal(review.reservedBy, 'test-supervisor');

    // Le processus mort ne peut plus conclure : sa réservation n'est plus la sienne.
    const late = repos.supervisor.decide({
      reviewId: review.reviewId, owner: 'dead-process', reviewer: 'GPT', decision: 'COMPLETE', code: 'COMPLETE', reason: 'trop tard',
      objectiveEffect: { kind: 'COMPLETE', result: {} },
    });
    assert.equal(late.recorded, false);
    assert.equal(repos.supervisor.objective(o.objective.objectiveId)!.status, 'ACTIVE');

    // Tentatives épuisées sur le cycle suivant : l'objectif s'arrête, avec la preuve.
    const child = objectiveTasks(o.objective.chainId)[1]!;
    finishTask(child.taskId);
    for (const owner of ['dead-1', 'dead-2']) {
      const r = repos.supervisor.reserveReview({
        objectiveId: o.objective.objectiveId, taskId: child.taskId, cycle: 2, owner, leaseMs: 1_000, maxAttempts: 2,
        now: owner === 'dead-1' ? t0.toISOString() : new Date(t0.getTime() + 2_000).toISOString(),
      });
      assert.equal(r.reserved, true);
    }
    report = await runSupervisorPoll(deps(provider, { now: () => new Date(t0.getTime() + 10_000) }));
    assert.equal(provider.calls.length, 1, 'aucun appel sur une revue épuisée');
    const obj = repos.supervisor.objective(o.objective.objectiveId)!;
    assert.equal(obj.status, 'BLOCKED');
    assert.equal(obj.terminalCode, 'REVIEW_STALLED');
  });

  test('un sondeur lent dont la réservation a été reprise ne peut plus conclure', () => {
    const o = start();
    finishTask(o.rootTask.taskId);
    const t0 = Date.now();
    const a = repos.supervisor.reserveReview({ objectiveId: o.objective.objectiveId, taskId: o.rootTask.taskId, cycle: 1, owner: 'slow-a', leaseMs: 1_000, maxAttempts: 2, now: new Date(t0).toISOString() });
    const b = repos.supervisor.reserveReview({ objectiveId: o.objective.objectiveId, taskId: o.rootTask.taskId, cycle: 1, owner: 'fast-b', leaseMs: 60_000, maxAttempts: 2, now: new Date(t0 + 5_000).toISOString() });
    assert.ok(a.reserved && b.reserved);
    if (!a.reserved) return;
    const late = repos.supervisor.decide({
      reviewId: a.review.reviewId, owner: 'slow-a', reviewer: 'GPT', decision: 'COMPLETE', code: 'COMPLETE', reason: 'a',
      objectiveEffect: { kind: 'COMPLETE', result: {} },
    });
    assert.equal(late.recorded, false);
    assert.equal(repos.supervisor.objective(o.objective.objectiveId)!.status, 'ACTIVE');
    const won = repos.supervisor.decide({
      reviewId: a.review.reviewId, owner: 'fast-b', reviewer: 'GPT', decision: 'BLOCKED', code: 'GPT_BLOCKED', reason: 'b',
      objectiveEffect: { kind: 'BLOCKED' },
    });
    assert.equal(won.recorded, true);
    assert.equal(repos.supervisor.objective(o.objective.objectiveId)!.terminalCode, 'GPT_BLOCKED');
  });

  test('la clé de cycle interdit une seconde suite, même par une autre revue', () => {
    const o = start();
    finishTask(o.rootTask.taskId);
    const r = repos.supervisor.reserveReview({
      objectiveId: o.objective.objectiveId, taskId: o.rootTask.taskId, cycle: 1, owner: 'x', leaseMs: 60_000, maxAttempts: 2,
    });
    assert.equal(r.reserved, true);
    if (!r.reserved) return;
    // Une suite existe déjà pour le cycle 2 (un autre chemin l'a posée).
    repos.tasks.reserveExternalOperation({ idempotencyKey: childClaimKey(o.objective.objectiveId, 2), kind: SUPERVISOR_LEDGER.CHILD, claimedBy: 'autre' });
    const outcome = repos.supervisor.decide({
      reviewId: r.review.reviewId, owner: 'x', reviewer: 'GPT', decision: 'NEXT_TASK', code: 'NEXT_TASK', reason: 'suite',
      objectiveEffect: { kind: 'CONTINUE', correction: false },
      child: {
        task: { taskType: 'ENGINEERING_CHANGE', department: 'ENGINEERING', workerType: 'CLAUDE_CODE', payload: {} },
        claimKey: childClaimKey(o.objective.objectiveId, 2), claimKind: SUPERVISOR_LEDGER.CHILD, claimedBy: 'x',
      },
    });
    assert.equal(outcome.recorded, false);
    assert.equal(objectiveTasks(o.objective.chainId).length, 1, 'aucune seconde suite');
    assert.equal(repos.supervisor.objective(o.objective.objectiveId)!.cycles, 1, 'l’objectif n’a pas avancé');
    assert.equal(repos.supervisor.reviewForTask(o.rootTask.taskId)!.state, 'RESERVED', 'rien n’est scellé à moitié');
  });

  test('une tâche n’a qu’une revue, un cycle n’a qu’une revue (contraintes SQLite)', () => {
    const o = start();
    const a = repos.supervisor.reserveReview({ objectiveId: o.objective.objectiveId, taskId: o.rootTask.taskId, cycle: 1, owner: 'a', leaseMs: 60_000, maxAttempts: 2 });
    const b = repos.supervisor.reserveReview({ objectiveId: o.objective.objectiveId, taskId: o.rootTask.taskId, cycle: 1, owner: 'b', leaseMs: 60_000, maxAttempts: 2 });
    const c = repos.supervisor.reserveReview({ objectiveId: o.objective.objectiveId, taskId: 'tsk_autre', cycle: 1, owner: 'c', leaseMs: 60_000, maxAttempts: 2 });
    assert.equal(a.reserved, true);
    assert.equal(b.reserved, false);
    assert.equal(c.reserved, false);
    assert.throws(() => repos.db.prepare(
      `INSERT INTO supervisor_reviews (review_id, objective_id, task_id, cycle, state, reserved_by, reserved_at, lease_until)
       VALUES ('svr_x', ?, 'tsk_y', 1, 'RESERVED', 'z', 'n', 'n')`,
    ).run(o.objective.objectiveId), /UNIQUE/);
  });
});

// ─── Les gardes de boucle ───────────────────────────────────────────────────

describe('les gardes : chaque boucle s’arrête, et dit pourquoi', () => {
  /** Mener un objectif jusqu'à la revue du cycle `n`, chaque cycle rendant `hashes[i]`. */
  async function driveTo(hashes: string[], script: Step[], cfg = liveConfig()) {
    const o = start('obj-guards', 'Ajouter une validation des entrées dans fixture/add.ts', cfg);
    const provider = new ScriptedProvider(script);
    for (const [i, hash] of hashes.entries()) {
      const task = objectiveTasks(o.objective.chainId)[i];
      if (!task) break;
      finishTask(task.taskId, { diffHash: hash });
      await runSupervisorPoll(deps(provider, {}, cfg));
    }
    return { o, provider, objective: repos.supervisor.objective(o.objective.objectiveId)! };
  }

  test('REPEATED_DIFF : le même diff qu’au cycle précédent, sans appel GPT', async () => {
    const { objective, provider } = await driveTo(['h1', 'h1'], [decision('NEXT_TASK')]);
    assert.equal(objective.status, 'BLOCKED');
    assert.equal(objective.terminalCode, 'REPEATED_DIFF');
    assert.equal(provider.calls.length, 1);
  });

  test('OSCILLATION : un diff revenu à celui d’un cycle plus ancien', async () => {
    const { objective, provider } = await driveTo(['h1', 'h2', 'h1'], [decision('NEXT_TASK')], liveConfig({ maxCycles: 5 }));
    assert.equal(objective.terminalCode, 'OSCILLATION');
    assert.equal(provider.calls.length, 2);
  });

  test('MAX_CYCLES : une suite demandée au dernier cycle arrête l’objectif, sans suite', async () => {
    const { o, objective } = await driveTo(['h1', 'h2'], [decision('NEXT_TASK')], liveConfig({ maxCycles: 2 }));
    assert.equal(objective.terminalCode, 'MAX_CYCLES');
    assert.equal(objectiveTasks(o.objective.chainId).length, 2);
  });

  test('MAX_CORRECTIONS : au-delà du plafond, CORRECT est refusé', async () => {
    const { o, objective } = await driveTo(['h1'], [decision('CORRECT')], liveConfig({ maxCorrections: 0 }));
    assert.equal(objective.terminalCode, 'MAX_CORRECTIONS');
    assert.equal(objectiveTasks(o.objective.chainId).length, 1);
  });

  test('REPEATED_TASK : GPT redemande la consigne déjà donnée (empreinte Hermes)', async () => {
    const same = decision('NEXT_TASK', { next_task: { objective: 'Ajouter une validation des entrées dans fixture/add.ts', acceptance_criteria: [], test_commands: [] } });
    const { o, objective } = await driveTo(['h1'], [same]);
    assert.equal(objective.terminalCode, 'REPEATED_TASK');
    assert.equal(objectiveTasks(o.objective.chainId).length, 1);
  });

  test('DUPLICATE_CHILD : une tâche encore ouverte dans l’objectif interdit une suite', async () => {
    const o = start();
    finishTask(o.rootTask.taskId);
    // Un intrus dans la chaîne, encore en file.
    repos.tasks.create({ taskType: 'ENGINEERING_CHANGE', department: 'ENGINEERING', workerType: 'CLAUDE_CODE', chainId: o.objective.chainId, payload: {} });
    await runSupervisorPoll(deps(new ScriptedProvider([decision('NEXT_TASK')])));
    assert.equal(repos.supervisor.objective(o.objective.objectiveId)!.terminalCode, 'DUPLICATE_CHILD');
  });

  test('STALE_BASE : une suite partie d’une autre base', async () => {
    const o = start();
    const provider = new ScriptedProvider([decision('NEXT_TASK')]);
    finishTask(o.rootTask.taskId, { base: 'a'.repeat(40) });
    await runSupervisorPoll(deps(provider));
    finishTask(objectiveTasks(o.objective.chainId)[1]!.taskId, { base: 'b'.repeat(40) });
    await runSupervisorPoll(deps(provider));
    const obj = repos.supervisor.objective(o.objective.objectiveId)!;
    assert.equal(obj.terminalCode, 'STALE_BASE');
    assert.equal(provider.calls.length, 1);
  });

  test('TASK_NOT_READY : une tâche en échec ou en attente humaine arrête l’objectif, sans GPT', async () => {
    for (const status of ['FAILED', 'NEEDS_HUMAN'] as const) {
      const o = start(`obj-${status}`);
      const provider = new ScriptedProvider([decision('COMPLETE')]);
      finishTask(o.rootTask.taskId, { status });
      await runSupervisorPoll(deps(provider));
      const obj = repos.supervisor.objective(o.objective.objectiveId)!;
      assert.equal(obj.terminalCode, 'TASK_NOT_READY');
      assert.match(obj.terminalReason ?? '', status === 'FAILED' ? /CLAUDE_CODE_FAILED/ : /CHANGE_BUDGET_EXCEEDED/);
      assert.equal(provider.calls.length, 0);
    }
  });

  test('MALFORMED_REVIEW : deux sorties illisibles, puis arrêt ; une seule illisible est rattrapée', async () => {
    const o = start();
    finishTask(o.rootTask.taskId);
    const prose = new ScriptedProvider([() => 'Je pense que c’est bon.', () => '```json\n{}\n```']);
    await runSupervisorPoll(deps(prose));
    let obj = repos.supervisor.objective(o.objective.objectiveId)!;
    assert.equal(obj.terminalCode, 'MALFORMED_REVIEW');
    assert.equal(prose.calls.length, 2);
    assert.equal(prose.calls[0]!.reasoningEffort, 'low');
    assert.equal(prose.calls[1]!.reasoningEffort, 'minimal');
    assert.equal(objectiveTasks(o.objective.chainId).length, 1);
    assert.equal(repos.supervisor.reviewForTask(o.rootTask.taskId)!.calls, 2);

    const o2 = start('obj-rattrape');
    finishTask(o2.rootTask.taskId);
    await runSupervisorPoll(deps(new ScriptedProvider([() => 'pas du JSON', decision('COMPLETE')])));
    obj = repos.supervisor.objective(o2.objective.objectiveId)!;
    assert.equal(obj.status, 'COMPLETE');
  });
});

// ─── Temps et coût ──────────────────────────────────────────────────────────

describe('bornes de temps et de coût, fermées sur l’inconnu', () => {
  test('OBJECTIVE_TIMEOUT : l’objectif s’arrête et sa tâche en file est annulée', async () => {
    const o = start();
    const later = new Date(Date.parse(o.objective.deadlineAt) + 1_000);
    const report = await runSupervisorPoll(deps(new ScriptedProvider([decision('COMPLETE')]), { now: () => later }));
    assert.deepEqual(report.timedOut, [o.objective.objectiveId]);
    const obj = repos.supervisor.objective(o.objective.objectiveId)!;
    assert.equal(obj.terminalCode, 'OBJECTIVE_TIMEOUT');
    assert.equal(repos.tasks.byId(o.rootTask.taskId)!.status, 'CANCELLED');
  });

  test('délai de revue : l’appel coupé laisse un coût inconnu, et la reprise s’arrête sur COST_UNKNOWN', async () => {
    const o = start();
    finishTask(o.rootTask.taskId);
    const provider = new ScriptedProvider([() => Object.assign(new Error('openai: timeout after 180000 ms'), { status: undefined })]);
    const cfg = liveConfig({ reviewTimeoutMs: 10_000 });
    const t0 = new Date();
    await runSupervisorPoll(deps(provider, { now: () => t0 }, cfg));
    assert.equal(provider.calls[0]!.timeoutMs, 10_000, 'le délai par revue est transmis');
    assert.equal(repos.supervisor.reviewForTask(o.rootTask.taskId)!.state, 'RESERVED');
    assert.equal(repos.tasks.unknownCostCalls(o.objective.chainId).filter((c) => c.provider === 'OPENAI').length, 1);
    // Le bail court encore : rien.
    await runSupervisorPoll(deps(provider, { now: () => new Date(t0.getTime() + 1_000) }, cfg));
    assert.equal(provider.calls.length, 1);
    // Bail expiré : la garde de coût tient avant tout nouvel appel.
    await runSupervisorPoll(deps(provider, { now: () => new Date(t0.getTime() + 200_000) }, cfg));
    assert.equal(provider.calls.length, 1);
    assert.equal(repos.supervisor.objective(o.objective.objectiveId)!.terminalCode, 'COST_UNKNOWN');
  });

  test('tarif du relecteur inconnu : superviseur fermé, aucun appel, aucun objectif arrêté', async () => {
    const o = start();
    finishTask(o.rootTask.taskId);
    const provider = new ScriptedProvider([decision('COMPLETE')]);
    const report = await runSupervisorPoll(deps(provider, { pricing: () => null }));
    assert.equal(report.ran, false);
    assert.match(report.skipped.join(' '), /sans tarif/);
    assert.equal(provider.calls.length, 0);
    assert.equal(repos.supervisor.objective(o.objective.objectiveId)!.status, 'ACTIVE');
    assert.equal(repos.supervisor.reviewForTask(o.rootTask.taskId), null);
  });

  test('Claude Code sans attestation d’abonnement, ou facturé à la clé : COST_UNKNOWN, aucun appel', async () => {
    for (const billing of [null, 'API_KEY']) {
      const o = start(`obj-billing-${billing}`);
      finishTask(o.rootTask.taskId, { billing });
      const provider = new ScriptedProvider([decision('COMPLETE')]);
      await runSupervisorPoll(deps(provider));
      assert.equal(provider.calls.length, 0);
      const obj = repos.supervisor.objective(o.objective.objectiveId)!;
      assert.equal(obj.terminalCode, 'COST_UNKNOWN');
      assert.match(obj.terminalReason ?? '', /abonnement/);
    }
  });

  test('une réponse GPT sans tarif arrête l’objectif, même lisible', async () => {
    const o = start();
    finishTask(o.rootTask.taskId);
    class Unpriced extends ScriptedProvider {
      override async execute(req: AiRequest): Promise<AiResponse> {
        const r = await super.execute(req);
        return { ...r, usage: { ...r.usage, costUsd: null, costBasis: 'UNKNOWN_PRICE' } };
      }
    }
    await runSupervisorPoll(deps(new Unpriced([decision('NEXT_TASK')])));
    assert.equal(repos.supervisor.objective(o.objective.objectiveId)!.terminalCode, 'COST_UNKNOWN');
    assert.equal(objectiveTasks(o.objective.chainId).length, 1);
  });

  test('plafond de l’objectif : OBJECTIVE_COST_CAP avant la dépense', async () => {
    const o = start('obj-cap', 'Ajouter une validation des entrées dans fixture/add.ts', liveConfig({ maxObjectiveCostUsd: 0.01 }));
    finishTask(o.rootTask.taskId);
    const provider = new ScriptedProvider([decision('COMPLETE')]);
    await runSupervisorPoll(deps(provider, {}, liveConfig({ maxObjectiveCostUsd: 0.01 })));
    assert.equal(provider.calls.length, 0);
    assert.equal(repos.supervisor.objective(o.objective.objectiveId)!.terminalCode, 'OBJECTIVE_COST_CAP');
  });

  test('plafond de chaîne existant (ATLAS_MAX_CHAIN_COST_USD) : respecté', async () => {
    const o = start();
    finishTask(o.rootTask.taskId);
    const provider = new ScriptedProvider([decision('COMPLETE')]);
    await runSupervisorPoll(deps(provider, {}, liveConfig({}, { maxChainCostUsd: 0.001 })));
    assert.equal(provider.calls.length, 0);
    assert.equal(repos.supervisor.objective(o.objective.objectiveId)!.terminalCode, 'CHAIN_LIMIT');
  });

  test('budget du jour épuisé : revue différée avec une note, rien d’arrêté, aucun appel', async () => {
    const o = start();
    finishTask(o.rootTask.taskId);
    repos.tasks.recordAiCall({ provider: 'ANTHROPIC', model: 'claude-haiku-4-5-20251001', inputTokens: 1, outputTokens: 1, costUsd: 1.99, costBasis: 'KNOWN', outcome: 'OK' });
    const cfg = liveConfig({}, { dailyBudgetUsd: 2, dailyBudgetMode: 'CONFIGURED' });
    const provider = new ScriptedProvider([decision('COMPLETE')]);
    const report = await runSupervisorPoll(deps(provider, {}, cfg));
    assert.equal(provider.calls.length, 0);
    assert.equal(report.deferred.length, 1);
    const obj = repos.supervisor.objective(o.objective.objectiveId)!;
    assert.equal(obj.status, 'ACTIVE');
    assert.match(obj.lastNote ?? '', /budget IA/);
    assert.equal(repos.supervisor.reviewForTask(o.rootTask.taskId), null, 'aucune réservation laissée');
  });

  test('clé refusée : PROVIDER_AUTH ; limitation : différée, réservation rendue', async () => {
    const o = start();
    finishTask(o.rootTask.taskId);
    await runSupervisorPoll(deps(new ScriptedProvider([() => Object.assign(new Error('rate limit reached'), { status: 429 })])));
    assert.equal(repos.supervisor.reviewForTask(o.rootTask.taskId), null);
    assert.equal(repos.supervisor.objective(o.objective.objectiveId)!.status, 'ACTIVE');
    await runSupervisorPoll(deps(new ScriptedProvider([() => Object.assign(new Error('invalid api key'), { status: 401 })])));
    assert.equal(repos.supervisor.objective(o.objective.objectiveId)!.terminalCode, 'PROVIDER_AUTH');
  });
});

// ─── Aucune fuite ───────────────────────────────────────────────────────────

describe('aucun secret ne sort', () => {
  test('ni le prompt envoyé, ni la revue, ni la suite ne portent de secret ou de configuration', async () => {
    const saved = process.env.ATLAS_OPENAI_API_KEY;
    process.env.ATLAS_OPENAI_API_KEY = OPENAI_KEY_VALUE;
    try {
      const o = start();
      finishTask(o.rootTask.taskId, {
        diff: `+const key = "${OPENAI_KEY_VALUE}";\n+// ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345\n`,
        summary: `j’ai lu le token=abcdefghijklmnop123456 et ${OPENAI_KEY_VALUE}`,
      });
      const provider = new ScriptedProvider([decision('NEXT_TASK', { summary: `note ${OPENAI_KEY_VALUE}` })]);
      await runSupervisorPoll(deps(provider));
      const sent = `${provider.calls[0]!.system}\n${provider.calls[0]!.prompt}`;
      for (const secret of [OPENAI_KEY_VALUE, 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', 'abcdefghijklmnop123456', config.security.sessionSecret, dir]) {
        assert.ok(!sent.includes(secret), `le prompt ne doit pas contenir ${secret.slice(0, 12)}…`);
      }
      assert.match(sent, /\[secret masqué\]/);
      assert.match(sent, /DONNÉE/);
      // La décision est une donnée : un secret recopié par GPT n'atteint ni la suite ni le résultat.
      const child = objectiveTasks(o.objective.chainId)[1]!;
      const stored = JSON.stringify([child.payload, repos.supervisor.reviewsFor(o.objective.objectiveId).map((r) => r.reason)]);
      assert.ok(!stored.includes(OPENAI_KEY_VALUE));
      assert.ok(!JSON.stringify(repos.supervisor.reviewsFor(o.objective.objectiveId)).includes(OPENAI_KEY_VALUE));
    } finally {
      if (saved === undefined) delete process.env.ATLAS_OPENAI_API_KEY;
      else process.env.ATLAS_OPENAI_API_KEY = saved;
    }
  });
});

// ─── Le daemon et la chaîne ─────────────────────────────────────────────────

describe('le daemon : Hermes ne double pas le superviseur', () => {
  /** Un faux worker CLAUDE_CODE qui propose des suites, comme Claude Code le fait. */
  const proposing: Worker = {
    type: 'CLAUDE_CODE', capabilities: [],
    canHandle: (t) => t.workerType === 'CLAUDE_CODE',
    execute: async (): Promise<WorkerOutcome> => ({
      kind: 'DONE',
      result: {
        status: 'ENGINEERING_READY_FOR_REVIEW', summary: 'ok', claude_code_billing: 'SUBSCRIPTION',
        next_tasks: [{ task_type: 'FINAL_REVIEW', objective: 'relire la validation ajoutée au module' }],
      },
    }),
  };
  const run = async () => {
    const hermes = new HermesRouter({ repos, logger, limits: { maxDepth: 4, maxTasks: 12, maxCostUsd: 1, maxRuntimeMinutes: 60, unknownCostPolicy: 'BLOCK' } });
    const daemon = new AtlasDaemon({
      repos, registry: new WorkerRegistry().register(proposing), logger, hermes,
      workerTypes: ['CLAUDE_CODE'], maxCycles: 1, maxIdleMs: 5, hostLabel: 'test',
    });
    await daemon.run();
  };

  test('une tâche d’objectif ne crée aucune suite par Hermes', async () => {
    const o = start();
    await run();
    assert.equal(repos.tasks.childrenOf(o.rootTask.taskId).length, 0);
  });

  test('témoin : hors objectif, Hermes crée toujours la suite proposée', async () => {
    const { task } = repos.tasks.create({ taskType: 'ENGINEERING_CHANGE', department: 'ENGINEERING', workerType: 'CLAUDE_CODE', payload: { objective: 'x' } });
    await run();
    assert.equal(repos.tasks.childrenOf(task.taskId).length, 1);
  });

  test('le tour cadencé est servi par le worker déterministe du serveur', async () => {
    const o = start();
    finishTask(o.rootTask.taskId);
    const provider = new ScriptedProvider([decision('COMPLETE')]);
    const cfg = liveConfig();
    scheduleSupervisorPoll(repos, cfg, new Date());
    const daemon = new AtlasDaemon({
      repos, logger, workerTypes: ['DETERMINISTIC'], maxCycles: 1, maxIdleMs: 5, hostLabel: 'test',
      registry: new WorkerRegistry().register(new DeterministicWorker(createSupervisorHandlers(deps(provider, {}, cfg)))),
    });
    await daemon.run();
    const poll = repos.tasks.lastFinishedOfType(SUPERVISOR_POLL_TASK_TYPE)!;
    assert.equal(poll.status, 'DONE');
    assert.equal((poll.result as Record<string, unknown>).messagesSent, 0);
    assert.equal(repos.supervisor.objective(o.objective.objectiveId)!.status, 'COMPLETE');
  });
});
