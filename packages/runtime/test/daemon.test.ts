import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';
import {
  AtlasDaemon,
  WorkerRegistry,
  DeterministicWorker,
  DisabledModelWorker,
  HumanWorker,
  DEMO_HANDLERS,
  DEMO_TASK_TYPES,
} from '../src/index.ts';

/**
 * Le daemon, joué en entier.
 *
 * Les tests de la file vérifient les serrures ; ceux-ci vérifient que le daemon
 * les utilise. C'est la distinction qui a déjà coûté cher ailleurs dans ce
 * système : une garde juste, testée, et branchée à côté du chemin qu'elle
 * protège ne protège rien.
 *
 * Aucun appel de modèle : les workers OPENAI et CLAUDE sont enregistrés et
 * refusent, ce qui est précisément ce qu'on veut voir se produire.
 */

const logger = createLogger({ level: 'error', pretty: false });
let repos: Repositories;
let dir: string;
let dbPath: string;

const registry = () =>
  new WorkerRegistry()
    .register(new DeterministicWorker(DEMO_HANDLERS))
    .register(new DisabledModelWorker('OPENAI'))
    .register(new DisabledModelWorker('CLAUDE'))
    .register(new HumanWorker());

const daemonFor = (over: Partial<ConstructorParameters<typeof AtlasDaemon>[0]> = {}) =>
  new AtlasDaemon({
    repos,
    registry: registry(),
    logger,
    leaseMs: 5_000,
    heartbeatMs: 200,
    maxIdleMs: 60,
    maxCycles: 12,
    ...over,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-daemon-'));
  dbPath = join(dir, 'd.db');
  repos = createRepositories(dbPath, logger);
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const add = (over: Partial<Parameters<Repositories['tasks']['create']>[0]> = {}) =>
  repos.tasks.create({
    taskType: DEMO_TASK_TYPES.SLEEP,
    department: 'BACKGROUND',
    workerType: 'DETERMINISTIC',
    payload: { durationMs: 5 },
    ...over,
  }).task;

describe('exécution normale', () => {
  test('le daemon termine les tâches et s’arrête proprement', async () => {
    const a = add({ payload: { durationMs: 5, label: 'A' } });
    const b = add({ payload: { durationMs: 10, label: 'B' } });

    const stats = await daemonFor({ maxCycles: 6 }).run();

    assert.equal(repos.tasks.byId(a.taskId)?.status, 'DONE');
    assert.equal(repos.tasks.byId(b.taskId)?.status, 'DONE');
    assert.equal(stats.completed, 2);
  });

  test('une tâche en pause quota n’arrête pas les suivantes', async () => {
    const c = add({
      taskType: DEMO_TASK_TYPES.QUOTA,
      payload: { provider: 'ANTHROPIC', retryAfterSeconds: 3600 },
    });
    const d = add({ payload: { durationMs: 5, label: 'D' } });

    await daemonFor({ maxCycles: 8 }).run();

    assert.equal(repos.tasks.byId(c.taskId)?.status, 'PAUSED_QUOTA');
    assert.equal(repos.tasks.byId(d.taskId)?.status, 'DONE', 'D doit passer malgré C');
    assert.equal(repos.tasks.providerHealth('ANTHROPIC')?.state, 'QUOTA_EXHAUSTED');
  });

  test('la reprise après quota est automatique, sans intervention', async () => {
    const c = add({
      taskType: DEMO_TASK_TYPES.QUOTA,
      payload: { provider: 'ANTHROPIC', retryAfterSeconds: 3600 },
    });
    await daemonFor({ maxCycles: 4 }).run();
    assert.equal(repos.tasks.byId(c.taskId)?.status, 'PAUSED_QUOTA');

    // Le fournisseur redevient disponible : l'échéance est ramenée dans le
    // passé, exactement ce que ferait un Retry-After plus court.
    repos.tasks.recordProviderHealth({ provider: 'ANTHROPIC', state: 'AVAILABLE' });
    repos.tasks['db']
      .prepare('UPDATE tasks SET available_at = ? WHERE task_id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), c.taskId);

    // La tâche redevient exécutable : on remplace le worker de quota par un
    // worker qui aboutit, comme le ferait un fournisseur revenu.
    const revived = new WorkerRegistry().register(
      new DeterministicWorker({
        [DEMO_TASK_TYPES.QUOTA]: async () => ({ kind: 'DONE', result: { reprise: true } }),
      }),
    );
    await daemonFor({ registry: revived, maxCycles: 4 }).run();

    assert.equal(repos.tasks.byId(c.taskId)?.status, 'DONE');
  });

  test('les workers de modèle refusent sans rien appeler', async () => {
    const task = add({ taskType: 'ANY', workerType: 'CLAUDE' });
    await daemonFor({ maxCycles: 3 }).run();

    const after = repos.tasks.byId(task.taskId)!;
    assert.equal(after.status, 'WAITING_HUMAN');
    // Pas FAILED : la tâche n'a pas échoué, le worker n'est pas branché. La
    // distinction évite de brûler des tentatives sur une absence.
    assert.notEqual(after.status, 'FAILED');
  });

  test('une tâche humaine attend sans bloquer la file', async () => {
    const approval = add({ taskType: 'APPROVE_EMAIL', workerType: 'HUMAN', priority: 100 });
    const work = add({ payload: { durationMs: 5 } });

    await daemonFor({ maxCycles: 6 }).run();

    assert.equal(repos.tasks.byId(approval.taskId)?.status, 'WAITING_HUMAN');
    assert.equal(repos.tasks.byId(work.taskId)?.status, 'DONE');
  });
});

describe('reprise après plantage', () => {
  test('un daemon tué laisse une tâche récupérable, puis elle aboutit', async () => {
    const task = add({ payload: { durationMs: 5 } });

    // Le plantage : la tâche est prise, aucun résultat n'est consigné, et le
    // bail est déjà périmé — l'état exact que laisse un `kill -9`.
    repos.tasks.claim({ owner: 'daemon-mort', leaseMs: -1_000, workerTypes: ['DETERMINISTIC'] });
    assert.equal(repos.tasks.byId(task.taskId)?.status, 'RUNNING');

    // Redémarrage sur le même fichier, comme un vrai relancement.
    repos.close();
    repos = createRepositories(dbPath, logger);

    const stats = await daemonFor({ maxCycles: 5 }).run();
    assert.ok(stats.recovered >= 1, 'le bail expiré doit être récupéré');
    assert.equal(repos.tasks.byId(task.taskId)?.status, 'DONE');
  });

  test('une tâche déjà terminée n’est jamais rejouée au redémarrage', async () => {
    const done = add({ payload: { durationMs: 5, label: 'déjà faite' } });
    await daemonFor({ maxCycles: 3 }).run();
    assert.equal(repos.tasks.byId(done.taskId)?.status, 'DONE');
    const attemptsBefore = repos.tasks.byId(done.taskId)!.attemptCount;

    repos.close();
    repos = createRepositories(dbPath, logger);
    await daemonFor({ maxCycles: 3 }).run();

    const after = repos.tasks.byId(done.taskId)!;
    assert.equal(after.status, 'DONE');
    assert.equal(after.attemptCount, attemptsBefore, 'aucune tentative supplémentaire');
  });

  test('le démarrage ne touche pas une tâche dont le bail court encore', async () => {
    const task = add();
    repos.tasks.claim({ owner: 'worker-vivant', leaseMs: 120_000, workerTypes: ['DETERMINISTIC'] });

    const outcome = daemonFor({ maxCycles: 1 }).boot();
    assert.equal(outcome.recovered, 0);
    assert.equal(repos.tasks.byId(task.taskId)?.status, 'RUNNING');
  });
});

describe('arrêt propre', () => {
  test('un arrêt demandé cesse de prendre des tâches', async () => {
    for (let i = 0; i < 5; i++) add({ payload: { durationMs: 5, index: i } });

    const daemon = daemonFor({ maxCycles: 50 });
    const running = daemon.run();
    // Laisse un tour ou deux se produire, puis demande l'arrêt.
    await new Promise((resolve) => setTimeout(resolve, 40));
    daemon.requestStop('test');
    const stats = await running;

    assert.equal(daemon.stopping, true);
    const remaining = repos.tasks.countByStatus();
    // Ce qui reste est QUEUED, jamais perdu : rien ne disparaît à l'arrêt.
    const accounted = (remaining.DONE ?? 0) + (remaining.QUEUED ?? 0) + (remaining.RUNNING ?? 0)
      + (remaining.RETRY_SCHEDULED ?? 0);
    assert.equal(accounted, 5, 'aucune tâche ne doit se perdre');
    assert.ok(stats.cycles > 0);
  });

  test('un travail long s’interrompt quand l’arrêt est demandé', async () => {
    const task = add({ taskType: DEMO_TASK_TYPES.LONG, payload: { durationMs: 5_000 } });

    const daemon = daemonFor({ maxCycles: 3, leaseMs: 60_000 });
    const running = daemon.run();
    await new Promise((resolve) => setTimeout(resolve, 60));
    daemon.requestStop('test');
    await running;

    const after = repos.tasks.byId(task.taskId)!;
    // Interrompue, donc reprenable — pas silencieusement abandonnée.
    assert.ok(
      ['RETRY_SCHEDULED', 'QUEUED', 'FAILED'].includes(after.status),
      `état inattendu : ${after.status}`,
    );
  });
});

describe('deux daemons en parallèle', () => {
  test('vingt tâches, deux daemons, aucun doublon', async () => {
    for (let i = 0; i < 20; i++) add({ payload: { durationMs: 2, index: i } });

    // Deux connexions distinctes sur le même fichier : deux processus, vus de
    // SQLite. C'est la situation que la prise atomique doit tenir.
    const secondRepos = createRepositories(dbPath, logger);
    try {
      const [statsA, statsB] = await Promise.all([
        daemonFor({ owner: 'daemon-a', maxCycles: 40 }).run(),
        new AtlasDaemon({
          repos: secondRepos, registry: registry(), logger,
          leaseMs: 5_000, heartbeatMs: 200, maxIdleMs: 40,
          owner: 'daemon-b', maxCycles: 40,
        }).run(),
      ]);

      const counts = repos.tasks.countByStatus();
      assert.equal(counts.DONE, 20, 'les vingt doivent être terminées');
      assert.equal(counts.FAILED ?? 0, 0);

      // Chaque tâche n'a été tentée qu'une fois : c'est la preuve du non-doublon.
      for (const task of repos.tasks.list({ status: 'DONE', limit: 50 })) {
        assert.equal(task.attemptCount, 1, `${task.taskId} tentée ${task.attemptCount} fois`);
      }
      assert.equal(statsA.completed + statsB.completed, 20);
    } finally {
      secondRepos.close();
    }
  });
});

describe('repos', () => {
  test('sans tâche, le daemon dort et ne consomme rien', async () => {
    const stats = await daemonFor({ maxCycles: 3, maxIdleMs: 30 }).run();

    assert.equal(stats.claimed, 0);
    assert.equal(stats.completed, 0);
    // Il a bien attendu plutôt que de tourner à vide : le temps passé au repos
    // est mesuré, et c'est un `setTimeout`, pas une boucle.
    assert.ok(stats.idleMs > 0, 'le daemon doit avoir dormi');
    assert.equal(repos.tasks.countByStatus().RUNNING ?? 0, 0);
  });

  test('l’attente se cale sur la prochaine échéance connue', () => {
    add({ availableAt: new Date(Date.now() + 3_600_000).toISOString() });
    const wait = repos.tasks.msUntilNextWork();
    assert.ok(wait !== null && wait > 3_000_000, `attente calculée : ${wait}`);
  });
});
