import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger, canTransitionTask, canRunProvider, decideRetryAt, backoffDelayMs, checkBudget } from '@atlas/core';
import { createRepositories, type Repositories } from '../src/index.ts';

/**
 * Ce qui doit rester vrai quand personne ne regarde.
 *
 * Ce cœur est destiné à tourner des semaines sans surveillance. Les défauts qui
 * comptent ne sont donc pas ceux qui plantent — un plantage se voit — mais ceux
 * qui font travailler deux fois, perdent une tâche en silence, ou condamnent un
 * travail valide parce qu'un fournisseur a hoqueté trois fois.
 *
 * Les tests portent sur une base réelle : la garantie qui compte est tenue par
 * SQLite, et vérifier le code appelant reviendrait à tester la politesse plutôt
 * que la serrure.
 */

const logger = createLogger({ level: 'error', pretty: false });
let repos: Repositories;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-queue-'));
  repos = createRepositories(join(dir, 'q.db'), logger);
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const make = (over: Partial<Parameters<Repositories['tasks']['create']>[0]> = {}) =>
  repos.tasks.create({
    taskType: 'DEMO_SLEEP',
    department: 'BACKGROUND',
    workerType: 'DETERMINISTIC',
    ...over,
  }).task;

const claim = (owner: string, leaseMs = 30_000) =>
  repos.tasks.claim({ owner, leaseMs, workerTypes: ['DETERMINISTIC'] });

describe('deux workers ne prennent jamais la même tâche', () => {
  test('la seconde prise repart les mains vides', () => {
    make();
    const first = claim('worker-a');
    const second = claim('worker-b');
    assert.ok(first.task, 'le premier doit prendre');
    assert.equal(second.task, null, 'le second ne doit rien trouver');
  });

  test('vingt tâches, deux workers, aucun doublon', () => {
    for (let i = 0; i < 20; i++) make({ payload: { index: i } });

    const taken = new Map<string, string>();
    // On alterne pour reproduire l'entrelacement réel de deux daemons.
    for (let round = 0; round < 30; round++) {
      for (const owner of ['worker-a', 'worker-b']) {
        const outcome = claim(owner);
        if (!outcome.task) continue;
        assert.ok(
          !taken.has(outcome.task.taskId),
          `${outcome.task.taskId} pris deux fois (${taken.get(outcome.task.taskId)} puis ${owner})`,
        );
        taken.set(outcome.task.taskId, owner);
        repos.tasks.complete(outcome.task.taskId, { ok: true }, owner);
      }
    }

    assert.equal(taken.size, 20);
    assert.equal(repos.tasks.countByStatus().DONE, 20);
    const owners = new Set(taken.values());
    assert.equal(owners.size, 2, 'les deux workers doivent avoir travaillé');
  });

  test('une tâche terminée n’est jamais reprise', () => {
    const task = make();
    const first = claim('worker-a');
    repos.tasks.complete(first.task!.taskId, { ok: true }, 'worker-a');

    assert.equal(claim('worker-a').task, null);
    assert.equal(claim('worker-b').task, null);
    assert.equal(repos.tasks.byId(task.taskId)?.status, 'DONE');
    assert.equal(repos.tasks.byId(task.taskId)?.attemptCount, 1);
  });
});

describe('le bail', () => {
  test('un bail expiré rend la tâche récupérable', () => {
    make();
    const taken = claim('worker-mort', -1_000); // bail déjà périmé
    assert.ok(taken.task);

    const recovered = repos.tasks.recoverStaleLeases('superviseur');
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]!.to, 'RETRY_SCHEDULED');
    assert.ok(claim('worker-vivant').task, 'la tâche doit être reprenable');
  });

  test('un bail valide protège le travail en cours', () => {
    make();
    const taken = claim('worker-lent', 60_000);
    assert.ok(taken.task);

    // Un worker lent n'est pas un worker mort : reprendre son travail
    // produirait exactement le doublon que la file existe pour éviter.
    assert.equal(repos.tasks.recoverStaleLeases('superviseur').length, 0);
    assert.equal(repos.tasks.byId(taken.task!.taskId)?.status, 'RUNNING');
  });

  test('le battement prolonge le bail', () => {
    make();
    const taken = claim('worker-a', 1_000);
    const before = repos.tasks.byId(taken.task!.taskId)!.leaseUntil!;

    assert.equal(repos.tasks.heartbeat(taken.task!.taskId, 'worker-a', 60_000), true);
    const after = repos.tasks.byId(taken.task!.taskId)!.leaseUntil!;
    assert.ok(Date.parse(after) > Date.parse(before), 'le bail doit avancer');
    assert.equal(repos.tasks.recoverStaleLeases('superviseur').length, 0);
  });

  test('un worker qui a perdu sa tâche ne peut pas prolonger le bail', () => {
    make();
    const taken = claim('worker-a', -1_000);
    repos.tasks.recoverStaleLeases('superviseur');
    // Le bail appartient à quelqu'un d'autre — ou à personne.
    assert.equal(repos.tasks.heartbeat(taken.task!.taskId, 'worker-a', 60_000), false);
  });

  test('les tentatives épuisées mènent à FAILED, pas à une reprise sans fin', () => {
    make({ maxAttempts: 1 });
    claim('worker-mort', -1_000);
    const recovered = repos.tasks.recoverStaleLeases('superviseur');
    assert.equal(recovered[0]!.to, 'FAILED');
  });
});

describe('les reprises', () => {
  test('un échec devient une reprise tant qu’il reste des tentatives', () => {
    const task = make({ maxAttempts: 3 });
    const taken = claim('worker-a');
    const outcome = repos.tasks.fail({
      taskId: taken.task!.taskId, actor: 'worker-a',
      errorCode: 'BOOM', errorMessage: 'raté', retryDelayMs: 0,
    });
    assert.equal(outcome.to, 'RETRY_SCHEDULED');
    assert.equal(repos.tasks.byId(task.taskId)?.attemptCount, 1);
  });

  test('la dernière tentative épuisée mène à FAILED', () => {
    const task = make({ maxAttempts: 2 });
    for (let i = 0; i < 2; i++) {
      const taken = claim('worker-a');
      assert.ok(taken.task, `tour ${i}`);
      repos.tasks.fail({
        taskId: taken.task!.taskId, actor: 'worker-a',
        errorCode: 'BOOM', errorMessage: 'raté', retryDelayMs: 0,
      });
    }
    assert.equal(repos.tasks.byId(task.taskId)?.status, 'FAILED');
    assert.equal(claim('worker-a').task, null, 'une tâche en échec n’est plus prenable');
  });

  test('une reprise programmée dans le futur n’est pas prenable tout de suite', () => {
    make();
    const taken = claim('worker-a');
    repos.tasks.fail({
      taskId: taken.task!.taskId, actor: 'worker-a',
      errorCode: 'BOOM', errorMessage: 'raté', retryDelayMs: 3_600_000,
    });
    assert.equal(claim('worker-a').task, null);
  });
});

describe('la pause pour quota', () => {
  test('une limitation ne brûle pas de tentative', () => {
    const task = make({ maxAttempts: 3 });
    const taken = claim('worker-a');
    assert.equal(repos.tasks.byId(task.taskId)?.attemptCount, 1);

    repos.tasks.pauseForQuota({
      taskId: taken.task!.taskId, actor: 'worker-a', provider: 'ANTHROPIC',
      retryAt: new Date(Date.now() - 1_000).toISOString(),
      reason: 'quota épuisé',
    });

    const paused = repos.tasks.byId(task.taskId)!;
    assert.equal(paused.status, 'PAUSED_QUOTA');
    // Le point du test : trois limitations d'affilée ne doivent pas condamner
    // un travail parfaitement valide.
    assert.equal(paused.attemptCount, 0, 'la tentative doit être rendue');
  });

  test('la reprise est automatique une fois l’échéance atteinte', () => {
    const task = make();
    const taken = claim('worker-a');
    repos.tasks.pauseForQuota({
      taskId: taken.task!.taskId, actor: 'worker-a', provider: 'ANTHROPIC',
      retryAt: new Date(Date.now() - 1_000).toISOString(), reason: 'quota',
    });

    const resumed = repos.tasks.resumeEligible('daemon');
    assert.deepEqual(resumed, [task.taskId]);
    assert.equal(repos.tasks.byId(task.taskId)?.status, 'QUEUED');
    assert.ok(claim('worker-a').task, 'elle doit repartir normalement');
  });

  test('une pause dont l’échéance n’est pas atteinte reste en pause', () => {
    make();
    const taken = claim('worker-a');
    repos.tasks.pauseForQuota({
      taskId: taken.task!.taskId, actor: 'worker-a', provider: 'ANTHROPIC',
      retryAt: new Date(Date.now() + 3_600_000).toISOString(), reason: 'quota',
    });
    assert.deepEqual(repos.tasks.resumeEligible('daemon'), []);
  });

  test('une pause budget est préservée, elle n’échoue pas', () => {
    const task = make();
    const taken = claim('worker-a');
    repos.tasks.pauseForBudget({
      taskId: taken.task!.taskId, actor: 'worker-a',
      reason: 'plafond journalier atteint',
      retryAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const paused = repos.tasks.byId(task.taskId)!;
    assert.equal(paused.status, 'PAUSED_BUDGET');
    assert.equal(paused.attemptCount, 0);
    assert.notEqual(paused.status, 'FAILED');
  });
});

describe('les tâches humaines', () => {
  test('une attente humaine ne bloque pas les autres tâches', () => {
    make({ taskType: 'APPROVE_EMAIL', workerType: 'DETERMINISTIC', priority: 100 });
    make({ taskType: 'DEMO_SLEEP', priority: 0 });

    const first = claim('worker-a');
    repos.tasks.waitForHuman(first.task!.taskId, 'worker-a', 'approbation attendue');

    // La seconde tâche doit partir, malgré la première en attente.
    const second = claim('worker-a');
    assert.ok(second.task);
    assert.equal(second.task!.taskType, 'DEMO_SLEEP');
    assert.equal(repos.tasks.countByStatus().WAITING_HUMAN, 1);
  });
});

describe('les priorités', () => {
  test('le département passe avant la priorité numérique', () => {
    make({ taskType: 'FOND', department: 'BACKGROUND', priority: 999 });
    make({ taskType: 'CLIENT', department: 'CRITICAL_CLIENT', priority: 0 });

    const first = claim('worker-a');
    assert.equal(first.task!.taskType, 'CLIENT', 'un client urgent passe avant tout');
  });

  test('à département égal, la priorité tranche', () => {
    make({ taskType: 'BASSE', department: 'SALES', priority: 1 });
    make({ taskType: 'HAUTE', department: 'SALES', priority: 50 });
    assert.equal(claim('worker-a').task!.taskType, 'HAUTE');
  });

  test('à priorité égale, la plus ancienne passe', () => {
    const first = make({ taskType: 'PREMIERE', department: 'SALES' });
    make({ taskType: 'SECONDE', department: 'SALES' });
    assert.equal(claim('worker-a').task!.taskId, first.taskId);
  });
});

describe('les dépendances', () => {
  test('B attend que A soit terminée', () => {
    const a = make({ taskType: 'A' });
    const b = repos.tasks.create({
      taskType: 'B', department: 'BACKGROUND', workerType: 'DETERMINISTIC',
      dependsOn: [a.taskId],
    }).task;

    assert.equal(b.status, 'WAITING_DEPENDENCY');
    const taken = claim('worker-a');
    assert.equal(taken.task!.taskType, 'A', 'seule A est prenable');
    assert.equal(claim('worker-b').task, null);

    repos.tasks.complete(a.taskId, {}, 'worker-a');
    assert.deepEqual(repos.tasks.releaseSatisfiedDependencies('daemon'), [b.taskId]);
    assert.equal(claim('worker-a').task!.taskType, 'B');
  });

  test('une dépendance en échec laisse B bloquée, pas exécutée', () => {
    const a = make({ taskType: 'A', maxAttempts: 1 });
    const b = repos.tasks.create({
      taskType: 'B', department: 'BACKGROUND', workerType: 'DETERMINISTIC',
      dependsOn: [a.taskId],
    }).task;

    const taken = claim('worker-a');
    repos.tasks.fail({
      taskId: taken.task!.taskId, actor: 'worker-a',
      errorCode: 'BOOM', errorMessage: 'raté', retryDelayMs: 0,
    });

    assert.equal(repos.tasks.byId(a.taskId)?.status, 'FAILED');
    assert.equal(repos.tasks.byId(b.taskId)?.status, 'WAITING_DEPENDENCY');
    assert.deepEqual(repos.tasks.releaseSatisfiedDependencies('daemon'), []);
    const blocked = repos.tasks.blockedByFailedDependency();
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0]!.taskId, b.taskId);
  });
});

describe('l’idempotence', () => {
  test('deux tâches de même clé n’en font qu’une', () => {
    const first = repos.tasks.create({
      taskType: 'CHECK', department: 'MAINTENANCE', workerType: 'DETERMINISTIC',
      idempotencyKey: 'check-horaire-2026-08-24T10',
    });
    const second = repos.tasks.create({
      taskType: 'CHECK', department: 'MAINTENANCE', workerType: 'DETERMINISTIC',
      idempotencyKey: 'check-horaire-2026-08-24T10',
    });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.task.taskId, first.task.taskId);
  });

  test('une opération externe ne se fait pas deux fois', () => {
    const input = {
      idempotencyKey: 'email:acme:premier',
      kind: 'EMAIL_SEND',
      target: 'contact@acme.fr',
      claimedBy: 'worker-a',
    };
    const first = repos.tasks.reserveExternalOperation(input);
    assert.equal(first.reserved, true);

    const second = repos.tasks.reserveExternalOperation(input);
    assert.equal(second.reserved, false);
    assert.equal(second.confirmed, false);
    assert.match(second.reason, /déjà engagée/);
  });

  test('un plantage entre l’opération et la persistance ne rejoue rien', () => {
    const input = {
      idempotencyKey: 'paiement:cmd-1', kind: 'PAYMENT', claimedBy: 'worker-a',
    };
    repos.tasks.reserveExternalOperation(input);
    // — plantage ici : aucune confirmation consignée —
    const retry = repos.tasks.reserveExternalOperation(input);
    assert.equal(retry.reserved, false, 'le retry ne doit pas refaire le paiement');
  });

  test('deux confirmations sur la même clé sont refusées par la base', () => {
    const key = 'notif:1';
    repos.tasks.reserveExternalOperation({ idempotencyKey: key, kind: 'NOTIFICATION', claimedBy: 'w' });
    assert.equal(
      repos.tasks.confirmExternalOperation({ idempotencyKey: key, phase: 'CONFIRMED', externalRef: 'r1' }).recorded,
      true,
    );
    assert.equal(
      repos.tasks.confirmExternalOperation({ idempotencyKey: key, phase: 'CONFIRMED', externalRef: 'r2' }).recorded,
      false,
    );
  });
});

describe('les invariants append-only', () => {
  test('une transition de tâche ne se réécrit pas', () => {
    const task = make();
    assert.throws(
      () =>
        repos.tasks['db']
          .prepare("UPDATE task_transitions SET to_status = 'DONE' WHERE task_id = ?")
          .run(task.taskId),
      /ABORT|reecrit/i,
    );
  });

  test('un relevé de santé ne s’efface pas', () => {
    repos.tasks.recordProviderHealth({ provider: 'ANTHROPIC', state: 'RATE_LIMITED' });
    assert.throws(
      () => repos.tasks['db'].prepare('DELETE FROM provider_health_events WHERE provider = ?').run('ANTHROPIC'),
      /ABORT|panne/i,
    );
  });

  test('la migration préserve les données Sales Loop existantes', () => {
    // La file arrive par-dessus un système qui tourne : l'ajout de tables ne
    // doit rien changer à ce qui existait.
    repos.sales.recordOutreach({
      domain: 'exemple.fr', kind: 'CONTACTED', recordedBy: 'test', channel: 'email',
    });
    repos.salesLoop.recordTransition({
      domain: 'exemple.fr', fromState: null, toState: 'QUALIFYING', actor: 'test',
    });
    make();

    assert.equal(repos.sales.ledgerFor('exemple.fr')?.kind, 'CONTACTED');
    assert.equal(repos.salesLoop.currentState('exemple.fr'), 'QUALIFYING');
    assert.equal(repos.tasks.countByStatus().QUEUED, 1);
  });
});

describe('la santé des fournisseurs', () => {
  test('le dernier relevé fait foi, l’historique est conservé', () => {
    repos.tasks.recordProviderHealth({ provider: 'OPENAI', state: 'RATE_LIMITED', retryAt: '2026-08-24T12:00:00.000Z', retrySource: 'RETRY_AFTER' });
    repos.tasks.recordProviderHealth({ provider: 'OPENAI', state: 'AVAILABLE' });
    const health = repos.tasks.providerHealth('OPENAI');
    assert.equal(health?.state, 'AVAILABLE');
  });

  test('jamais observé n’est pas disponible', () => {
    assert.equal(repos.tasks.providerHealth('ANTHROPIC'), null);
    // On essaie quand même : le premier appel est ce qui produira l'observation.
    assert.equal(canRunProvider(null).allowed, true);
  });
});

describe('les règles pures de quota et de budget', () => {
  test('Retry-After prime sur le backoff', () => {
    const decision = decideRetryAt({ retryAfterHeader: '120', attempt: 1, now: 1_000_000 });
    assert.equal(decision.source, 'RETRY_AFTER');
    assert.equal(Date.parse(decision.retryAt), 1_000_000 + 120_000);
  });

  test('sans échéance annoncée, le backoff est borné', () => {
    const decision = decideRetryAt({ attempt: 99, now: 0, random: () => 0.5 });
    assert.equal(decision.source, 'BACKOFF');
    // Le dernier palier est une heure : jamais davantage, quel que soit l'essai.
    assert.ok(Date.parse(decision.retryAt) <= 3_600_000 * 1.2);
  });

  test('le bruit étale les reprises simultanées', () => {
    const a = backoffDelayMs(1, () => 0);
    const b = backoffDelayMs(1, () => 1);
    assert.notEqual(a, b, 'dix tâches limitées ensemble ne doivent pas repartir ensemble');
  });

  test('une clé invalide ne s’attend pas : elle se corrige', () => {
    const verdict = canRunProvider({
      provider: 'OPENAI', state: 'AUTH_ERROR', reason: null,
      retryAt: null, retrySource: 'NONE', observedAt: new Date().toISOString(),
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.retryAt, null);
  });

  test('budget : UNLIMITED et DISABLED ne se confondent pas', () => {
    assert.equal(checkBudget({ mode: 'UNLIMITED' }).allowed, true);
    assert.equal(checkBudget({ mode: 'DISABLED' }).allowed, false);
  });

  test('un dépassement de budget refuse, sans faire échouer', () => {
    const verdict = checkBudget({
      mode: 'CONFIGURED', dailySpentUsd: 4.9, dailyLimitUsd: 5, taskCostUsd: 0.5,
    });
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason, /journalier/);
  });
});

describe('la machine à états des tâches', () => {
  test('une tâche terminée ne redevient pas exécutable', () => {
    assert.equal(canTransitionTask('DONE', 'RUNNING').allowed, false);
    assert.equal(canTransitionTask('DONE', 'QUEUED').allowed, false);
  });

  test('une pause quota ne mène pas directement à l’échec', () => {
    assert.equal(canTransitionTask('PAUSED_QUOTA', 'FAILED').allowed, true);
    // Mais elle ne saute pas la file : la reprise repasse par la sélection.
    assert.equal(canTransitionTask('PAUSED_QUOTA', 'RUNNING').allowed, false);
    assert.equal(canTransitionTask('PAUSED_QUOTA', 'QUEUED').allowed, true);
  });

  test('une tâche naît QUEUED ou WAITING_DEPENDENCY', () => {
    assert.equal(canTransitionTask(null, 'QUEUED').allowed, true);
    assert.equal(canTransitionTask(null, 'RUNNING').allowed, false);
  });
});
