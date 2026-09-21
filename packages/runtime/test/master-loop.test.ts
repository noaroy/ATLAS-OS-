import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '@atlas/core';
import type { AtlasConfig } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';
import { makeTestConfig } from '@atlas/testing';
import { FixtureAiProvider } from '@atlas/llm';
import { ClaudeWorker, WorkerRegistry, inspectRepo } from '../src/index.ts';
import { runMasterLoop } from '../src/master-loop.ts';

/**
 * La boucle maîtresse, éprouvée sans réseau ni dépense.
 *
 * Trois fournisseurs figés jouent trois rôles distincts : Claude et GPT
 * décident (le binôme de `collab:loop`), un troisième — un autre appel du même
 * Claude, dans le rôle de l'agent d'ingénierie — exécute dans un vrai dépôt
 * git temporaire. C'est ce dernier point qui compte : l'exécution n'est pas
 * simulée, elle produit un vrai worktree, un vrai diff, un vrai audit —
 * exactement ce que `local:loop` ferait seul.
 */

const logger = createLogger({ level: 'error', pretty: false });
let dir: string;
let repos: Repositories;
let config: AtlasConfig;
let repoRoot: string;

const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function makeRepo(root: string): string {
  mkdirSync(root, { recursive: true });
  git(['init', '--quiet', '-b', 'main'], root);
  git(['config', 'user.email', 'test@atlas.local'], root);
  git(['config', 'user.name', 'ATLAS Test'], root);
  mkdirSync(join(root, 'fixture'), { recursive: true });
  writeFileSync(join(root, 'fixture', 'add.ts'), 'export const VALUE = 1;\n', 'utf8');
  git(['add', '-A'], root);
  git(['commit', '--quiet', '-m', 'base'], root);
  return root;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-master-'));
  repos = createRepositories(join(dir, 'm.db'), logger);
  config = makeTestConfig(dir);
  repoRoot = makeRepo(join(dir, 'repo'));
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Un tour de décision, tel qu'un fournisseur figé le rendrait. */
const decisionTurn = (input: {
  done?: boolean;
  objectiveReached?: boolean;
  actionObjective?: string | null;
  allowedPaths?: string[] | null;
  testCommands?: string[];
}) => ({
  body: {
    message: 'analyse', proposed_action: null, confidence: 0.8, done: input.done ?? true, reason: 'motif',
    objective_reached: input.objectiveReached ?? false,
    action_objective: input.actionObjective ?? null,
    action_allowed_paths: input.allowedPaths ?? null,
    action_test_commands: input.testCommands ?? [],
  },
});

const registryWith = (editsReplies: Record<string, unknown>[]) => {
  const engineeringProvider = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', editsReplies.map((body) => ({ body })));
  const registry = new WorkerRegistry().register(new ClaudeWorker({
    repos, provider: engineeringProvider, timeoutMs: 30_000,
    workspaceRoot: repoRoot, worktreeRoot: join(dir, 'ws'), maxIterations: 1,
  }));
  return { registry, engineeringProvider };
};

const VALID_EDIT = {
  status: 'DONE', summary: 'constante ajoutée', confidence: 0.9,
  plan: 'ajouter VERSION', findings: [], recommendations: [], next_tasks: [], artifacts: [],
  edits: [{ path: 'fixture/add.ts', action: 'MODIFY', content: 'export const VALUE = 1;\nexport const VERSION = 2;\n' }],
};

const OUT_OF_SCOPE_EDIT = {
  status: 'DONE', summary: 'sortie de périmètre', confidence: 0.9,
  plan: 'toucher ailleurs', findings: [], recommendations: [], next_tasks: [], artifacts: [],
  edits: [{ path: '../evasion.ts', action: 'CREATE', content: 'volé' }],
};

describe('runMasterLoop', () => {
  test('objectif atteint dès le premier cycle : aucune exécution locale', async () => {
    const anthropic = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [decisionTurn({ objectiveReached: true })]);
    const openai = new FixtureAiProvider('OPENAI', 'gpt-5', [decisionTurn({ objectiveReached: true })]);
    const { registry, engineeringProvider } = registryWith([VALID_EDIT]);

    const report = await runMasterLoop(
      { repos, config, providers: { anthropic, openai }, registry, logger },
      { objective: 'objectif déjà satisfait', maxCycles: 3 },
    );

    assert.equal(report.finalStatus, 'OBJECTIVE_REACHED');
    assert.equal(report.cycles.length, 1);
    assert.equal(report.cycles[0]?.execution, null);
    assert.equal(engineeringProvider.calls.length, 0, 'aucun appel d’ingénierie ne doit avoir eu lieu');
  });

  test('un cycle productif s’arrête sur READY_FOR_HUMAN_DEPLOYMENT, sans toucher au dépôt principal', async () => {
    const anthropic = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [decisionTurn({})]);
    const openai = new FixtureAiProvider('OPENAI', 'gpt-5', [
      decisionTurn({ objectiveReached: false, actionObjective: 'ajouter une constante VERSION', allowedPaths: ['fixture'] }),
    ]);
    const { registry } = registryWith([VALID_EDIT]);

    const report = await runMasterLoop(
      { repos, config, providers: { anthropic, openai }, registry, logger },
      { objective: 'ajouter une constante de version', maxCycles: 3 },
    );

    assert.equal(report.finalStatus, 'READY_FOR_HUMAN_DEPLOYMENT');
    assert.equal(report.cycles.length, 1);
    const execution = report.cycles[0]?.execution;
    assert.ok(execution);
    assert.equal(execution.workspace?.state, 'READY_FOR_REVIEW');
    assert.equal(execution.workspace?.filesChanged, 1);

    // La branche principale n'a jamais bougé : le travail vit dans un worktree.
    assert.equal(inspectRepo(repoRoot).clean, true);
    assert.equal(git(['branch', '--show-current'], repoRoot).trim(), 'main');

    if (execution.workspace) {
      execFileSync('git', ['worktree', 'remove', '--force', execution.workspace.path], { cwd: repoRoot });
    }
  });

  test('une action hors périmètre arrête la boucle (BLOCKED), sans nouvelle tentative', async () => {
    const anthropic = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [decisionTurn({})]);
    const openai = new FixtureAiProvider('OPENAI', 'gpt-5', [
      decisionTurn({ objectiveReached: false, actionObjective: 'toucher hors périmètre', allowedPaths: ['fixture'] }),
    ]);
    const { registry } = registryWith([OUT_OF_SCOPE_EDIT]);

    const report = await runMasterLoop(
      { repos, config, providers: { anthropic, openai }, registry, logger },
      // Un seul essai : une violation de périmètre est déterministe, la
      // retenter n'aurait fait qu'attendre pour de vrai le délai de reprise.
      { objective: 'tenter une sortie de périmètre', maxCycles: 5, localMaxAttempts: 1 },
    );

    assert.equal(report.finalStatus, 'BLOCKED');
    assert.equal(report.cycles.length, 1);
    assert.match(report.cycles[0]?.execution?.verdict.reason ?? '', /SECURITY_VIOLATION/);
    assert.equal(inspectRepo(repoRoot).clean, true);
  });

  test('une décision incomplète (sans chemin autorisé) ne déclenche aucune exécution, et le plafond de cycles finit par arrêter la boucle', async () => {
    const anthropic = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [decisionTurn({})]);
    const openai = new FixtureAiProvider('OPENAI', 'gpt-5', [
      decisionTurn({ objectiveReached: false, actionObjective: 'faire quelque chose', allowedPaths: [] }),
    ]);
    const { registry, engineeringProvider } = registryWith([VALID_EDIT]);

    const report = await runMasterLoop(
      { repos, config, providers: { anthropic, openai }, registry, logger },
      { objective: 'décision toujours incomplète', maxCycles: 2, collabMaxRoundsPerCycle: 1 },
    );

    assert.equal(report.finalStatus, 'BOUNDS_EXHAUSTED');
    assert.equal(report.cycles.length, 2);
    for (const rec of report.cycles) {
      assert.equal(rec.decision, null);
      assert.equal(rec.execution, null);
    }
    assert.equal(engineeringProvider.calls.length, 0);
  });

  test('un plafond de coût nul arrête tout avant le premier appel', async () => {
    const anthropic = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [decisionTurn({ objectiveReached: true })]);
    const openai = new FixtureAiProvider('OPENAI', 'gpt-5', [decisionTurn({ objectiveReached: true })]);
    const { registry } = registryWith([VALID_EDIT]);

    const report = await runMasterLoop(
      { repos, config, providers: { anthropic, openai }, registry, logger },
      { objective: 'jamais lancé', maxCostUsd: 0 },
    );

    assert.equal(report.finalStatus, 'BOUNDS_EXHAUSTED');
    assert.equal(report.cycles.length, 0);
    assert.equal(anthropic.calls.length, 0);
    assert.equal(openai.calls.length, 0);
  });

  test('un délai maximal nul arrête tout avant le premier appel', async () => {
    const anthropic = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [decisionTurn({ objectiveReached: true })]);
    const openai = new FixtureAiProvider('OPENAI', 'gpt-5', [decisionTurn({ objectiveReached: true })]);
    const { registry } = registryWith([VALID_EDIT]);

    const report = await runMasterLoop(
      { repos, config, providers: { anthropic, openai }, registry, logger },
      { objective: 'jamais lancé', maxWallMs: 0 },
    );

    assert.equal(report.finalStatus, 'BOUNDS_EXHAUSTED');
    assert.equal(report.cycles.length, 0);
  });

  test('une action non résolue dans ses propres bornes nourrit le cycle suivant', async () => {
    const anthropic = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [decisionTurn({}), decisionTurn({})]);
    const openai = new FixtureAiProvider('OPENAI', 'gpt-5', [
      decisionTurn({ objectiveReached: false, actionObjective: 'première tentative', allowedPaths: ['fixture'] }),
      decisionTurn({ objectiveReached: true }),
    ]);
    const { registry, engineeringProvider } = registryWith([VALID_EDIT]);

    const report = await runMasterLoop(
      { repos, config, providers: { anthropic, openai }, registry, logger },
      { objective: 'converger en deux cycles', maxCycles: 3, localMaxCyclesPerAction: 0 },
    );

    assert.equal(report.finalStatus, 'OBJECTIVE_REACHED');
    assert.equal(report.cycles.length, 2);
    const first = report.cycles[0];
    assert.ok(first?.execution);
    // Bornée à 0 tour de daemon : la tâche n'a jamais été prise, donc jamais résolue.
    assert.equal(first.execution.stopped, 'MAX_CYCLES');
    assert.equal(first.execution.verdict.status, 'QUEUED');
    assert.equal(engineeringProvider.calls.length, 0, 'aucun tour de daemon : aucun appel d’ingénierie');

    // Le résultat du premier cycle doit être visible dans le prompt du second.
    const secondAnthropicCall = anthropic.calls[1];
    assert.ok(secondAnthropicCall);
    assert.match(secondAnthropicCall.prompt, /QUEUED/);
  });
});
