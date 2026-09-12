import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '@atlas/core';
import { createRepositories } from '../src/index.ts';

/**
 * Le flux que le temps réel relit.
 *
 * Le bus d'événements d'ATLAS vit en mémoire. Un lot de prospection lancé en
 * ligne de commande est un autre processus : ses événements n'atteignent jamais
 * l'émetteur du serveur, et un écran branché sur ce seul émetteur reste
 * immobile pendant tout un cycle réel — ce qu'on demande précisément à un
 * centre de commande de ne pas faire.
 *
 * Ils atteignent en revanche cette table. La relire est ce qui rend le temps
 * réel complet, sans second canal ni second socket.
 */

const logger = createLogger({ level: 'error', pretty: false });

describe('la relecture des événements', () => {
  const withRepos = (fn: (repos: ReturnType<typeof createRepositories>) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-tail-'));
    const repos = createRepositories(join(dir, 'db.sqlite'), logger);
    try { fn(repos); } finally {
      repos.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const at = (n: number) => `2026-08-26T10:0${n}:00.000Z`;
  const append = (repos: ReturnType<typeof createRepositories>, n: number, severity = 'info') =>
    repos.events.append({
      id: `evt-${n}`, type: 'mission.started', severity: severity as 'info',
      source: 'cli', missionId: null, agentKey: null,
      message: `étape ${n}`, payload: {}, createdAt: at(n),
    });

  test('rend ce qui a été écrit après un instant, dans l’ordre du temps', () => {
    withRepos((repos) => {
      for (const n of [0, 1, 2]) append(repos, n);

      const depuis = repos.events.since(at(0));
      assert.deepEqual(depuis.map((e) => e.id), ['evt-1', 'evt-2'], 'strictement après');
      // `list` rend du plus récent au plus ancien ; un flux, lui, se rejoue
      // dans le sens où il s'est produit.
      assert.ok(depuis[0]!.createdAt < depuis[1]!.createdAt);
    });
  });

  test('relue depuis le dernier vu, elle ne rend rien de plus', () => {
    // La propriété qui empêche le flux de se répéter à chaque tour.
    withRepos((repos) => {
      for (const n of [0, 1, 2]) append(repos, n);
      assert.deepEqual(repos.events.since(at(2)), []);
    });
  });

  test('le plafond borne la relecture sans la casser', () => {
    withRepos((repos) => {
      for (const n of [0, 1, 2]) append(repos, n);
      const borne = repos.events.since(at(0), 1);
      assert.equal(borne.length, 1);
      assert.equal(borne[0]!.id, 'evt-1', 'le plus ancien non vu, pas le plus récent');
    });
  });

  test('le debug n’entre pas dans la table, donc jamais dans le flux', () => {
    // Le journal reste lisible : la trace existe pour déboguer, pas pour être
    // rejouée dans un écran de supervision.
    withRepos((repos) => {
      append(repos, 0);
      append(repos, 1, 'debug');
      assert.deepEqual(repos.events.since(at(0)).map((e) => e.id), []);
    });
  });
});
