import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@atlas/core';
import type { AtlasConfig } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';
import { makeTestConfig } from '@atlas/testing';
import { FixtureAiProvider, type FixtureReply } from '@atlas/llm';
import { runCollabLoop } from '../src/collab-loop.ts';

/**
 * La boucle de collaboration, éprouvée sans réseau ni dépense.
 *
 * Chaque fournisseur est une `FixtureAiProvider` : les réponses sont écrites
 * d'avance, dans l'ordre où elles seront consommées. Le point central de ces
 * tests est le comportement constaté en conditions réelles — GPT peut couper
 * sa réponse avant d'écrire le JSON attendu — et sa correction : une relance
 * bornée, spécifique à GPT, jamais pour Claude.
 */

const logger = createLogger({ level: 'error', pretty: false });
let dir: string;
let repos: Repositories;
let config: AtlasConfig;

const reply = (body: Record<string, unknown>, extra: Partial<FixtureReply> = {}): FixtureReply => ({ body, ...extra });

const VALID_TURN = (message: string, done = false, action: string | null = null) => ({
  message, proposed_action: action, confidence: 0.7, done, reason: 'motif de test',
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-collab-'));
  repos = createRepositories(join(dir, 'c.db'), logger);
  config = makeTestConfig(dir);
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('runCollabLoop', () => {
  test('un tour Claude valide est analysé et gardé tel quel', async () => {
    const anthropic = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [
      reply(VALID_TURN('analyse initiale de Claude')),
    ]);
    const openai = new FixtureAiProvider('OPENAI', 'gpt-5', [reply(VALID_TURN('réponse de GPT', true))]);

    const report = await runCollabLoop(
      { repos, config, providers: { anthropic, openai }, logger },
      { objective: 'tester un tour Claude valide', maxRounds: 1 },
    );

    const claudeTurn = report.turns.find((t) => t.speaker === 'ANTHROPIC');
    assert.ok(claudeTurn);
    assert.equal(claudeTurn.message, 'analyse initiale de Claude');
    assert.equal(claudeTurn.attempts, 1);
    assert.equal(claudeTurn.confidence, 0.7);
  });

  test('un tour GPT valide est analysé et gardé tel quel', async () => {
    const anthropic = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [
      reply(VALID_TURN('analyse de Claude')),
    ]);
    const openai = new FixtureAiProvider('OPENAI', 'gpt-5', [
      reply(VALID_TURN('critique de GPT', false, 'vérifier X avant de conclure')),
    ]);

    const report = await runCollabLoop(
      { repos, config, providers: { anthropic, openai }, logger },
      { objective: 'tester un tour GPT valide', maxRounds: 1 },
    );

    const gptTurn = report.turns.find((t) => t.speaker === 'OPENAI');
    assert.ok(gptTurn);
    assert.equal(gptTurn.message, 'critique de GPT');
    assert.equal(gptTurn.proposedAction, 'vérifier X avant de conclure');
    assert.equal(gptTurn.attempts, 1);
  });

  test('le parsing JSON extrait exactement les champs attendus', async () => {
    const anthropic = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [
      reply({ message: 'texte', proposed_action: 'agir', confidence: 0.42, done: true, reason: 'parce que' }),
    ]);
    const openai = new FixtureAiProvider('OPENAI', 'gpt-5', [reply(VALID_TURN('x'))]);

    const report = await runCollabLoop(
      { repos, config, providers: { anthropic, openai }, logger },
      { objective: 'tester le parsing', maxRounds: 1 },
    );

    const t = report.turns[0];
    assert.ok(t);
    assert.equal(t.message, 'texte');
    assert.equal(t.proposedAction, 'agir');
    assert.equal(t.confidence, 0.42);
    assert.equal(t.done, true);
    assert.equal(t.reason, 'parce que');
  });

  test('une réponse vide devient un tour invalide, sans arrêter le dialogue', async () => {
    const anthropic = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [
      reply({}), // ni message, ni rien d'exploitable
      reply(VALID_TURN('reprise après la sortie vide', true)),
    ]);
    const openai = new FixtureAiProvider('OPENAI', 'gpt-5', [reply(VALID_TURN('gpt', true))]);

    const report = await runCollabLoop(
      { repos, config, providers: { anthropic, openai }, logger },
      { objective: 'tester une réponse vide', maxRounds: 2 },
    );

    const first = report.turns[0];
    assert.ok(first);
    assert.ok(first.message.startsWith('sortie invalide'));
    assert.equal(first.done, false);
    // Le dialogue continue : un tour invalide n'arrête rien.
    assert.ok(report.turns.length > 1);
  });

  test('GPT tronqué relance une fois, avec un effort de raisonnement réduit et un budget accru', async () => {
    const anthropic = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [
      reply(VALID_TURN('claude', true)),
    ]);
    const openai = new FixtureAiProvider('OPENAI', 'gpt-5', [
      reply({}, { truncated: true }), // budget épuisé en raisonnement caché, rien d'écrit
      reply(VALID_TURN('gpt après relance', true)),
    ]);

    const report = await runCollabLoop(
      { repos, config, providers: { anthropic, openai }, logger },
      { objective: 'tester la relance GPT', maxRounds: 1 },
    );

    const gptTurn = report.turns.find((t) => t.speaker === 'OPENAI');
    assert.ok(gptTurn);
    assert.equal(gptTurn.message, 'gpt après relance');
    assert.equal(gptTurn.attempts, 2);
    assert.equal(openai.calls.length, 2);
    const [firstCall, secondCall] = openai.calls;
    assert.ok(firstCall && secondCall);
    assert.equal(firstCall.reasoningEffort, 'low');
    assert.equal(secondCall.reasoningEffort, 'minimal');
    // Le budget de la relance reste borné, jamais illimité.
    assert.ok(secondCall.maxOutputTokens > firstCall.maxOutputTokens);
    assert.ok(secondCall.maxOutputTokens <= 4_500);
  });

  test('Claude ne relance jamais, même sur une sortie invalide', async () => {
    const anthropic = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [
      reply({}), // invalide
      reply(VALID_TURN('ne devrait jamais être consommé')),
    ]);
    const openai = new FixtureAiProvider('OPENAI', 'gpt-5', [reply(VALID_TURN('gpt', true))]);

    const report = await runCollabLoop(
      { repos, config, providers: { anthropic, openai }, logger },
      { objective: 'Claude sans relance', maxRounds: 1 },
    );

    assert.equal(anthropic.calls.length, 1);
    const claudeTurn = report.turns.find((t) => t.speaker === 'ANTHROPIC');
    assert.ok(claudeTurn);
    assert.equal(claudeTurn.attempts, 1);
    assert.ok(claudeTurn.message.startsWith('sortie invalide'));
  });

  test('chaque tentative, y compris une relance, est facturée dans ai_calls', async () => {
    const anthropic = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [
      reply(VALID_TURN('claude', true)),
    ]);
    const openai = new FixtureAiProvider('OPENAI', 'gpt-5', [
      reply({}, { truncated: true, usage: { inputTokens: 100, outputTokens: 100 } }),
      reply(VALID_TURN('gpt', true), { usage: { inputTokens: 100, outputTokens: 100 } }),
    ]);

    await runCollabLoop(
      { repos, config, providers: { anthropic, openai }, logger },
      { objective: 'tester la comptabilité des relances', maxRounds: 1 },
    );

    // Fixture: coût simulé (SIMULATED, 0 $) mais chaque tentative doit tout
    // de même laisser une trace : deux appels GPT, un appel Claude.
    const calls = repos.tasks.aiUsageSince('1970-01-01T00:00:00.000Z');
    assert.equal(calls.calls, 3);
  });

  test('le plafond du dialogue arrête avant le tour suivant', async () => {
    const anthropic = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [
      reply(VALID_TURN('claude cher'), { usage: { inputTokens: 1, outputTokens: 1 } }),
    ]);
    const openai = new FixtureAiProvider('OPENAI', 'gpt-5', [reply(VALID_TURN('ne devrait jamais tourner'))]);
    // Le fournisseur figé rend un coût nul (SIMULATED) : on force le plafond à
    // zéro pour vérifier que la garde arrête avant tout appel.
    const report = await runCollabLoop(
      { repos, config, providers: { anthropic, openai }, logger },
      { objective: 'tester le plafond du dialogue', maxRounds: 3, maxCostUsd: 0 },
    );

    assert.equal(report.turns.length, 0);
    assert.match(report.stoppedReason, /plafond du dialogue atteint/);
    assert.equal(anthropic.calls.length, 0);
    assert.equal(openai.calls.length, 0);
  });

  test('le budget du jour épuisé arrête le dialogue avant le premier appel', async () => {
    // Une dépense déjà connue aujourd'hui, au-delà d'un plafond configuré.
    repos.tasks.recordAiCall({
      taskId: null, chainId: null, provider: 'ANTHROPIC', model: 'claude-haiku-4-5-20251001',
      capability: 'REASONING', inputTokens: 1_000, outputTokens: 1_000, costUsd: 5, costBasis: 'KNOWN', outcome: 'OK',
    });
    const cfg: AtlasConfig = { ...config, ai: { ...config.ai, dailyBudgetMode: 'CONFIGURED', dailyBudgetUsd: 1 } };
    const anthropic = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [reply(VALID_TURN('x'))]);
    const openai = new FixtureAiProvider('OPENAI', 'gpt-5', [reply(VALID_TURN('y'))]);

    const report = await runCollabLoop(
      { repos, config: cfg, providers: { anthropic, openai }, logger },
      { objective: 'tester le budget du jour', maxRounds: 2 },
    );

    assert.equal(report.turns.length, 0);
    assert.match(report.stoppedReason, /budget du jour/);
  });

  test('convergence : le dialogue s’arrête quand les deux camps se déclarent d’accord', async () => {
    const anthropic = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [
      reply(VALID_TURN('analyse initiale', false)),
      reply(VALID_TURN('je suis d’accord', true)),
    ]);
    const openai = new FixtureAiProvider('OPENAI', 'gpt-5', [
      reply(VALID_TURN('critique initiale', false)),
      reply(VALID_TURN('accord confirmé', true)),
    ]);

    const report = await runCollabLoop(
      { repos, config, providers: { anthropic, openai }, logger },
      { objective: 'tester la convergence', maxRounds: 6 },
    );

    assert.equal(report.converged, true);
    assert.equal(report.turns.length, 4);
    assert.match(report.stoppedReason, /les deux parties considèrent l.objectif atteint/);
  });

  test('arrêt sur max-rounds quand aucun camp ne se déclare d’accord', async () => {
    const anthropic = new FixtureAiProvider('ANTHROPIC', 'claude-haiku-4-5-20251001', [
      reply(VALID_TURN('toujours en discussion', false)),
    ]);
    const openai = new FixtureAiProvider('OPENAI', 'gpt-5', [
      reply(VALID_TURN('toujours en désaccord', false)),
    ]);

    const report = await runCollabLoop(
      { repos, config, providers: { anthropic, openai }, logger },
      { objective: 'tester l’arrêt sur plafond de tours', maxRounds: 2 },
    );

    assert.equal(report.converged, false);
    assert.equal(report.turns.length, 4);
    assert.equal(report.stoppedReason, '2 tour(s) : plafond atteint');
  });
});
