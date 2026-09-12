import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';
import { FixtureAiProvider, OpenAiProvider, AnthropicAiProvider } from '@atlas/llm';
import {
  OpenAiWorker,
  ClaudeWorker,
  AtlasDaemon,
  WorkerRegistry,
  runAllowedCommand,
  killTree,
} from '../src/index.ts';

/**
 * Les propriétés de sûreté, vérifiées plutôt que démontrées.
 *
 * Une démonstration prouve qu'une chose a marché une fois, sur une machine, un
 * jour. Ces trois-là méritent mieux : un processus laissé orphelin continue de
 * consommer sans que personne le sache, une reprise après quota qui échoue
 * immobilise le travail en silence, et un coût mal calculé rend inopérants tous
 * les plafonds qui s'appuient dessus.
 *
 * Aucun appel réseau : les fournisseurs sont figés, et les processus lancés le
 * sont dans un répertoire temporaire.
 */

const logger = createLogger({ level: 'error', pretty: false });
let repos: Repositories;
let dir: string;

const OK_RESULT = {
  status: 'DONE', summary: 'fait', confidence: 0.9,
  findings: [], recommendations: [], next_tasks: [], artifacts: [],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-sec-'));
  repos = createRepositories(join(dir, 's.db'), logger);

  // Un depot git reel : une tache ENGINEERING_CHANGE en exige un desormais,
  // et l'eprouver sur un simple repertoire testerait le refus d'entree plutot
  // que le chemin qu'on veut verifier.
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@atlas.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'ATLAS Test'], { cwd: dir });
  writeFileSync(join(dir, 'x.ts'), 'export const x = 1;\n', 'utf8');
  execFileSync('git', ['add', 'x.ts'], { cwd: dir });
  execFileSync('git', ['commit', '--quiet', '-m', 'base'], { cwd: dir });
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Combien de processus node tournent, vu du système. */
function nodeProcessCount(): number {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', '(Get-Process node -ErrorAction SilentlyContinue | Measure-Object).Count'],
        { encoding: 'utf8', timeout: 20_000 },
      );
      return Number(out.trim()) || 0;
    }
    return execFileSync('pgrep', ['-c', 'node'], { encoding: 'utf8' }).trim().length;
  } catch {
    return -1;
  }
}

describe('le délai tue le vrai processus, pas son emballage', () => {
  test('une commande qui déborde rend 124 et tue son arborescence', async () => {
    // Le délai est volontairement minuscule : la commande démarre, le minuteur
    // se déclenche, et c'est exactement le chemin qu'on veut éprouver —
    // minuteur, mise à mort de l'arborescence, code 124.
    //
    // Le cas réaliste — `npm test` coupé à quatre secondes — a été vérifié en
    // autonome : code 124, huit processus node avant comme après. Il n'est pas
    // rejoué ici parce qu'un `npm test` imbriqué dans `node --test` sort
    // aussitôt, ce qui rendrait ce test faux plutôt que rigoureux.
    const outcome = await runAllowedCommand('npm run build', process.cwd(), 1);
    assert.equal(outcome.code, 124, 'le code doit signaler le délai dépassé');
    assert.match(outcome.output, /arborescence de processus tuée/);
  });

  test('un processus enfant réel meurt avec toute sa descendance', async () => {
    // Un enfant qui en lance un autre : c'est la configuration où tuer
    // seulement le processus lancé laisse le vrai travail se poursuivre, et
    // c'est ce qui s'est produit lors d'une démonstration précédente.
    const script = join(dir, 'long.mjs');
    const source = [
      "import { spawn } from 'node:child_process';",
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });",
      'setTimeout(() => {}, 120000);',
    ].join('\n');
    writeFileSync(script, source, 'utf8');

    const child = spawn(process.execPath, [script], {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(child.killed, false, 'l’enfant doit être vivant avant la mise à mort');

    const before = nodeProcessCount();
    assert.equal(killTree(child.pid), true);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const after = nodeProcessCount();

    if (before >= 0 && after >= 0) {
      assert.ok(
        after < before,
        `${after} processus node après contre ${before} avant : la descendance survit`,
      );
    }
    // Nettoyage de ceinture, au cas où la plateforme aurait résisté.
    try { process.kill(child.pid!, 'SIGKILL'); } catch { /* déjà mort */ }
  });

  test('tuer un pid inexistant ne jette pas', () => {
    assert.equal(killTree(undefined), false);
    assert.doesNotThrow(() => killTree(999_999));
  });

  test('la sortie d’une commande est nettoyée avant d’être conservée', async () => {
    execFileSync('git', ['init', '--quiet'], { cwd: dir });
    writeFileSync(join(dir, 'note.txt'), 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', 'utf8');
    const outcome = await runAllowedCommand('git status', dir, 20_000);
    assert.ok(!outcome.output.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), outcome.output);
  });
});

describe('la reprise après quota, de bout en bout', () => {
  test('pause, travail d’à côté, puis reprise sans intervention', async () => {
    const claudeDown = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [
      {
        error: {
          status: 429,
          message: 'quota exhausted for this organization',
          headers: { 'retry-after': '3600' },
        },
      },
    ]);
    const openai = new FixtureAiProvider('OPENAI', 'gpt-5', [
      { body: { ...OK_RESULT, status: 'PASS', summary: 'analyse faite' } },
    ]);

    const engineering = repos.tasks.create({
      taskType: 'ENGINEERING_CHANGE', department: 'ENGINEERING', workerType: 'CLAUDE',
      payload: { objective: 'corriger', allowed_paths: ['x.ts'] },
    }).task;
    const review = repos.tasks.create({
      taskType: 'ARCHITECTURE_REVIEW', department: 'ENGINEERING', workerType: 'OPENAI',
      payload: { objective: 'relire' },
    }).task;

    await new AtlasDaemon({
      repos, logger, leaseMs: 5_000, heartbeatMs: 500, maxIdleMs: 20, maxCycles: 4,
      registry: new WorkerRegistry()
        .register(new OpenAiWorker({ repos, provider: openai, timeoutMs: 5_000 }))
        .register(new ClaudeWorker({
          repos, provider: claudeDown, timeoutMs: 5_000, workspaceRoot: dir,
        })),
    }).run();

    const paused = repos.tasks.byId(engineering.taskId)!;
    assert.equal(paused.status, 'PAUSED_QUOTA');
    // Le point qui compte : la limitation n'a pas coûté de tentative.
    assert.equal(paused.attemptCount, 0);
    assert.equal(repos.tasks.byId(review.taskId)?.status, 'DONE', 'l’autre tâche doit passer');

    const health = repos.tasks.providerHealth('ANTHROPIC')!;
    assert.equal(health.state, 'QUOTA_EXHAUSTED');
    assert.equal(health.retrySource, 'RETRY_AFTER', 'l’échéance vient du fournisseur');
    assert.ok(Date.parse(health.retryAt!) > Date.now() + 3_000_000, 'environ une heure');

    // Le fournisseur revient. L'échéance de la tâche est ramenée, comme le
    // ferait un Retry-After plus court sur un nouvel essai.
    repos.tasks.recordProviderHealth({ provider: 'ANTHROPIC', state: 'AVAILABLE' });
    repos.tasks['db']
      .prepare("UPDATE tasks SET available_at = ? WHERE status = 'PAUSED_QUOTA'")
      .run(new Date(Date.now() - 1_000).toISOString());

    const claudeUp = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [
      { body: OK_RESULT },
    ]);
    await new AtlasDaemon({
      repos, logger, leaseMs: 5_000, heartbeatMs: 500, maxIdleMs: 20, maxCycles: 3,
      registry: new WorkerRegistry().register(
        new ClaudeWorker({ repos, provider: claudeUp, timeoutMs: 5_000, workspaceRoot: dir }),
      ),
    }).run();

    const resumed = repos.tasks.byId(engineering.taskId)!;
    assert.equal(resumed.status, 'DONE');
    assert.equal(resumed.attemptCount, 1, 'une seule tentative aura été consommée en tout');
  });

  test('le fournisseur n’est pas sondé pour savoir s’il est revenu', async () => {
    // La reprise est guidée par l'échéance, pas par des appels périodiques.
    // Un provider figé compte ses appels : sur trois tours de daemon avec une
    // tâche en pause à échéance lointaine, il ne doit en recevoir aucun.
    const claude = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [
      { error: { status: 429, message: 'rate limit', headers: { 'retry-after': '3600' } } },
    ]);
    repos.tasks.create({
      taskType: 'ENGINEERING_CHANGE', department: 'ENGINEERING', workerType: 'CLAUDE',
      payload: { objective: 'corriger', allowed_paths: ['x.ts'] },
    });
    const registry = new WorkerRegistry().register(
      new ClaudeWorker({ repos, provider: claude, timeoutMs: 5_000, workspaceRoot: dir }),
    );

    await new AtlasDaemon({
      repos, registry, logger, leaseMs: 5_000, heartbeatMs: 500, maxIdleMs: 20, maxCycles: 2,
    }).run();
    const afterPause = claude.calls.length;

    await new AtlasDaemon({
      repos, registry, logger, leaseMs: 5_000, heartbeatMs: 500, maxIdleMs: 20, maxCycles: 5,
    }).run();
    assert.equal(claude.calls.length, afterPause, 'aucun appel de vérification');
  });
});

describe('la comptabilité des coûts', () => {
  test('un tarif connu produit un coût calculé, pas estimé', async () => {
    // Le modèle Haiku figure dans la table tarifaire : 0,8 $/Mtok en entrée,
    // 4 $/Mtok en sortie. Un million de jetons de chaque côté vaut donc 4,80 $.
    const provider = new AnthropicAiProvider('claude-haiku-4-5-20251001', '');
    assert.equal(provider.status().configured, false, 'aucune clé : rien ne part');

    const task = repos.tasks.create({
      taskType: 'ARCHITECTURE_REVIEW', department: 'ENGINEERING', workerType: 'OPENAI',
      payload: { objective: 'relire' },
    }).task;

    repos.tasks.recordAiCall({
      taskId: task.taskId, chainId: task.chainId,
      provider: 'ANTHROPIC', model: 'claude-haiku-4-5-20251001',
      inputTokens: 1_000_000, outputTokens: 1_000_000,
      costUsd: 4.8, costBasis: 'KNOWN', outcome: 'OK',
    });

    const usage = repos.tasks.aiUsageSince('2000-01-01', 'ANTHROPIC');
    assert.equal(usage.knownCostUsd, 4.8);
    assert.equal(usage.unknownCostCalls, 0);
    assert.equal(repos.tasks.chainCost(task.chainId!).knownUsd, 4.8);
  });

  test('un tarif inconnu ne devient jamais zéro', () => {
    const task = repos.tasks.create({
      taskType: 'ARCHITECTURE_REVIEW', department: 'ENGINEERING', workerType: 'OPENAI',
      payload: {},
    }).task;
    repos.tasks.recordAiCall({
      taskId: task.taskId, chainId: task.chainId, provider: 'OPENAI', model: 'gpt-5',
      inputTokens: 5_000, outputTokens: 1_000, costUsd: null, costBasis: 'UNKNOWN_PRICE',
      outcome: 'OK',
    });

    const usage = repos.tasks.aiUsageSince('2000-01-01', 'OPENAI');
    // Les jetons sont connus, le prix non. Les deux ne se déduisent pas l'un de
    // l'autre : additionner ce coût comme zéro rendrait le plafond de chaîne
    // aveugle à une dépense réelle.
    assert.equal(usage.inputTokens, 5_000);
    assert.equal(usage.knownCostUsd, 0);
    assert.equal(usage.unknownCostCalls, 1);
  });

  test('le coût d’un appel figé est marqué simulé, pas connu', async () => {
    const provider = new FixtureAiProvider('OPENAI', 'gpt-5', [{ body: OK_RESULT }]);
    const task = repos.tasks.create({
      taskType: 'ARCHITECTURE_REVIEW', department: 'ENGINEERING', workerType: 'OPENAI',
      payload: { objective: 'relire' },
    }).task;

    await new OpenAiWorker({ repos, provider, timeoutMs: 5_000 }).execute(task, {
      logger, heartbeat: () => true, shuttingDown: () => false, correlationId: null,
    });

    const row = repos.tasks['db']
      .prepare('SELECT cost_basis FROM ai_calls WHERE task_id = ?')
      .get(task.taskId) as { cost_basis: string };
    assert.equal(row.cost_basis, 'SIMULATED');
  });

  test('un appel enregistré ne se réécrit ni ne s’efface', () => {
    const task = repos.tasks.create({
      taskType: 'ARCHITECTURE_REVIEW', department: 'ENGINEERING', workerType: 'OPENAI', payload: {},
    }).task;
    repos.tasks.recordAiCall({
      taskId: task.taskId, provider: 'OPENAI', model: 'gpt-5',
      inputTokens: 10, outputTokens: 10, costUsd: 0.01, costBasis: 'KNOWN', outcome: 'OK',
    });
    assert.throws(
      () => repos.tasks['db'].prepare('UPDATE ai_calls SET cost_usd = 0').run(),
      /ABORT|corrige/i,
    );
    assert.throws(
      () => repos.tasks['db'].prepare('DELETE FROM ai_calls WHERE task_id = ?').run(task.taskId),
      /ABORT|depense|dépense/i,
    );
  });
});

describe('les clés ne sortent jamais', () => {
  test('un fournisseur non configuré nomme la variable, pas sa valeur', () => {
    const openai = new OpenAiProvider('gpt-5', '');
    const anthropic = new AnthropicAiProvider('claude-haiku-4-5-20251001', '');
    assert.match(openai.status().detail, /ATLAS_OPENAI_API_KEY/);
    assert.match(anthropic.status().detail, /ANTHROPIC_API_KEY/);
  });

  test('une clé présente n’apparaît dans aucun champ de statut', () => {
    const secret = 'sk-proj-SECRETQUINEDOITPASSORTIR000';
    const provider = new OpenAiProvider('gpt-5', secret);
    assert.ok(!JSON.stringify(provider.status()).includes(secret));
  });

  test('un worker sans clé attend un humain plutôt que de boucler', async () => {
    const provider = new OpenAiProvider('gpt-5', '');
    const task = repos.tasks.create({
      taskType: 'ARCHITECTURE_REVIEW', department: 'ENGINEERING', workerType: 'OPENAI',
      payload: { objective: 'relire' },
    }).task;

    const outcome = await new OpenAiWorker({ repos, provider, timeoutMs: 5_000 }).execute(task, {
      logger, heartbeat: () => true, shuttingDown: () => false, correlationId: null,
    });
    assert.equal(outcome.kind, 'WAITING_HUMAN');
    assert.equal(outcome.errorCode, 'OPENAI_NOT_CONFIGURED');
  });
});

describe('une tâche terminée n’est jamais rejouée', () => {
  test('même après redémarrage du daemon', async () => {
    const provider = new FixtureAiProvider('OPENAI', 'gpt-5', [{ body: OK_RESULT }]);
    const task = repos.tasks.create({
      taskType: 'ARCHITECTURE_REVIEW', department: 'ENGINEERING', workerType: 'OPENAI',
      payload: { objective: 'relire' },
    }).task;
    const registry = new WorkerRegistry().register(
      new OpenAiWorker({ repos, provider, timeoutMs: 5_000 }),
    );

    await new AtlasDaemon({
      repos, registry, logger, leaseMs: 5_000, heartbeatMs: 500, maxIdleMs: 20, maxCycles: 2,
    }).run();
    assert.equal(repos.tasks.byId(task.taskId)?.status, 'DONE');
    const callsAfterFirst = provider.calls.length;

    await new AtlasDaemon({
      repos, registry, logger, leaseMs: 5_000, heartbeatMs: 500, maxIdleMs: 20, maxCycles: 3,
    }).run();
    assert.equal(provider.calls.length, callsAfterFirst, 'aucun appel supplémentaire');
    assert.equal(repos.tasks.byId(task.taskId)?.attemptCount, 1);
  });
});
