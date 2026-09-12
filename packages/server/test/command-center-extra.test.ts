import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../core/src/logger.ts';
import { loadConfig, type AtlasConfig } from '../../core/src/config.ts';
import { createRepositories, sendKey, type Repositories } from '../../data/src/index.ts';
import {
  buildSearchFabric, buildMultiModelTrace, buildOutreach,
  buildFollowUps, buildAnalytics, buildCosts, buildProspecting,
} from '../src/http/command-center.ts';

/**
 * Les écrans ajoutés au centre de commande.
 *
 * Chaque test tient une propriété qui a déjà été violée quelque part, ou qui
 * protège une décision qu'un opérateur prendra en regardant l'écran :
 *
 *   · Une mesure absente rend `null`. « Coût IA : N/A » s'est un jour affiché
 *     sur près de sept dollars réellement dépensés ; l'inverse — un zéro sur
 *     une absence de mesure — est plus dangereux encore, parce qu'il se lit
 *     comme une bonne nouvelle.
 *   · Une chaîne multi-modèle se constate, elle ne se déclare pas. Une mission
 *     à un seul modèle n'a rien à faire dans une vue qui prétend en montrer
 *     plusieurs.
 *   · Une réservation d'envoi n'est pas un envoi. Quatre d'entre elles ont
 *     bloqué autant de relances approuvées sans qu'un seul message parte, et
 *     sans que rien ne l'affiche.
 */

const logger = createLogger({ level: 'error', pretty: false });
let dir: string;
let repos: Repositories;
let config: AtlasConfig;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-cc2-'));
  repos = createRepositories(join(dir, 'cc.db'), logger);
  config = loadConfig(process.cwd());
});

after(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

// ─── SEARCH FABRIC ──────────────────────────────────────────────────────────

describe('le search fabric distingue l’état des volumes', () => {
  test('sans moteur configuré, rien n’est « en panne »', () => {
    const view = buildSearchFabric(repos, config, null);
    assert.equal(view.configured, false, 'aucun moteur branché est un état, pas une panne');
    assert.deepEqual(view.engines, []);
    assert.equal(view.primary, null);
  });

  test('l’ordre de bascule est publié, et le premier moteur en découle', () => {
    const fabric = {
      statuses: () => [
        {
          id: 'searxng', name: 'SearXNG', health: 'healthy', available: true,
          metrics: { calls: 12, failures: 1, averageLatencyMs: 340, lastSuccessAt: '2026-08-26T10:00:00.000Z' },
          circuit: { state: 'closed' },
        },
        {
          id: 'brave', name: 'Brave', health: 'unknown', available: false,
          availabilityReason: 'aucune clé configurée', circuit: { state: 'closed' },
        },
      ],
      plan: () => ({ order: [{ record: { id: 'searxng' } }, { record: { id: 'duckduckgo' } }], blocked: false }),
      availability: () => ({ available: true }),
    };
    const view = buildSearchFabric(repos, config, fabric);

    assert.equal(view.primary, 'searxng');
    assert.equal(view.fallback, 'duckduckgo', 'la bascule est nommée, pas supposée');
    assert.deepEqual(view.routingOrder, ['searxng', 'duckduckgo']);

    const brave = view.engines.find((e) => e.id === 'brave')!;
    assert.equal(brave.available, false);
    assert.equal(brave.inRoutingOrder, false);
    // Le motif d'indisponibilité se lit, il ne se devine pas.
    assert.equal(brave.reason, 'aucune clé configurée');
    // Et surtout : jamais la clé elle-même.
    assert.equal(JSON.stringify(view).includes('BRAVE_SEARCH_API_KEY'), false);
  });

  test('un moteur sans appel rend null, jamais zéro', () => {
    const fabric = {
      statuses: () => [{ id: 'duckduckgo', name: 'DuckDuckGo', health: 'unknown', available: true }],
      plan: () => ({ order: [{ record: { id: 'duckduckgo' } }] }),
      availability: () => ({ available: true }),
    };
    const engine = buildSearchFabric(repos, config, fabric).engines[0]!;
    assert.equal(engine.sessionCalls, null, 'null, pas 0 : le moteur n’a pas été interrogé');
  });

  test('sans requête consignée, la latence est null et non zéro', () => {
    const view = buildSearchFabric(repos, config, null);
    assert.equal(view.ledger.avgQueryMs, null);
    assert.equal(view.ledger.avgPageMs, null);
    assert.equal(view.ledger.entities, null, 'aucun compteur ne mesure les entités');
    assert.equal(view.ledger.queries, 0, 'un compte d’appels, lui, est bien zéro');
  });

  test('les volumes viennent de la base, pas du moteur vivant', () => {
    const scratch = createRepositories(join(dir, 'search.db'), logger);
    try {
      const mission = scratch.missions.create({
        title: 'T', objective: 'o', context: {}, createdBy: 'test', tokenBudget: 10,
      });
      const toolCall = (durationMs: number, ok: boolean, error: string | null, at: string) =>
        scratch.toolCalls.record({
          missionId: mission.id, taskRef: 'step', agentKey: 'scout',
          tool: 'discover_companies', category: 'research',
          durationMs, ok, error, external: true, createdAt: at,
        });
      toolCall(400, true, null, '2026-08-26T10:00:00.000Z');
      toolCall(600, false, 'timeout', '2026-08-26T10:01:00.000Z');
      const view = buildSearchFabric(scratch, config, null);
      assert.equal(view.ledger.queries, 2);
      assert.equal(view.ledger.queryFailures, 1);
      assert.equal(view.ledger.avgQueryMs, 500, 'moyenne pondérée par le volume');
      assert.equal(view.recentFailures.length, 1);
      assert.equal(view.recentFailures[0]!.error, 'timeout');
    } finally { scratch.close(); }
  });
});

// ─── CHAÎNE MULTI-MODÈLE ────────────────────────────────────────────────────

describe('une chaîne multi-modèle se constate', () => {
  const seed = (db: Repositories, models: Array<[string, string]>) => {
    const mission = db.missions.create({
      title: 'Mission multi', objective: 'o', context: {}, createdBy: 'test', tokenBudget: 100,
    });
    for (const [provider, model] of models) {
      db.llmCalls.record({
        missionId: mission.id, taskRef: 'step', agentKey: 'hermes', purpose: 'analysis',
        provider, model, inputTokens: 10, outputTokens: 5,
        cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001,
        durationMs: 100, ok: true, error: null, toolCalls: 0,
        subject: null, contextChars: null, evidenceCount: null,
        createdAt: new Date(Date.now() + models.indexOf([provider, model])).toISOString(),
      });
    }
    return mission.id;
  };

  test('une mission à un seul modèle n’y figure pas', () => {
    const scratch = createRepositories(join(dir, 'mono.db'), logger);
    try {
      seed(scratch, [['ANTHROPIC', 'claude-haiku-4-5'], ['ANTHROPIC', 'claude-haiku-4-5']]);
      const view = buildMultiModelTrace(scratch);
      assert.equal(view.missions.length, 0, 'deux appels au même modèle ne font pas une chaîne');
      assert.ok(view.note, 'l’absence est expliquée, pas laissée vide');
    } finally { scratch.close(); }
  });

  test('deux modèles distincts produisent une trace ordonnée', () => {
    const scratch = createRepositories(join(dir, 'multi.db'), logger);
    try {
      const id = seed(scratch, [
        ['ANTHROPIC', 'claude-haiku-4-5'],
        ['OPENAI', 'gpt-5-mini'],
      ]);
      const view = buildMultiModelTrace(scratch);
      assert.equal(view.missions.length, 1);
      const mission = view.missions[0]!;
      assert.equal(mission.missionId, id);
      assert.equal(mission.models, 2);
      assert.equal(mission.providers, 2);
      assert.equal(mission.steps.length, 2);
      // L'ordre est chronologique : une trace se lit dans le sens du temps.
      assert.ok(mission.steps[0]!.firstAt <= mission.steps[1]!.firstAt);
      assert.equal(view.note, null);
    } finally { scratch.close(); }
  });

  test('un appel au tarif inconnu ne devient pas un coût nul', () => {
    const scratch = createRepositories(join(dir, 'multi2.db'), logger);
    try {
      const mission = scratch.missions.create({
        title: 'M', objective: 'o', context: {}, createdBy: 'test', tokenBudget: 100,
      });
      const call = (provider: string, model: string) =>
        scratch.llmCalls.record({
          missionId: mission.id, taskRef: 's', agentKey: 'a', purpose: 'p',
          provider, model, inputTokens: 1, outputTokens: 1,
          cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null,
          durationMs: 1, ok: true, error: null, toolCalls: 0,
          subject: null, contextChars: null, evidenceCount: null,
          createdAt: new Date().toISOString(),
        });
      call('ANTHROPIC', 'a');
      call('OPENAI', 'b');
      const steps = buildMultiModelTrace(scratch).missions[0]!.steps;
      for (const step of steps) {
        assert.equal(step.unknownCostCalls, 1, 'compté à part, jamais à zéro');
      }
    } finally { scratch.close(); }
  });
});

// ─── OUTREACH ───────────────────────────────────────────────────────────────

describe('une réservation n’est pas un envoi', () => {
  const message = {
    domain: 'prospect.invalid', recipient: 'contact@prospect.invalid',
    subject: 'Sujet', body: 'Corps', purpose: 'FIRST_TOUCH',
  };

  test('une place prise sans issue est comptée à part', () => {
    const scratch = createRepositories(join(dir, 'outreach.db'), logger);
    try {
      scratch.salesLoop.claimSend({ ...message, claimedBy: 'test' });
      const view = buildOutreach(scratch, config, '2026-08-26');
      assert.equal(view.metrics.messagesSent, 0, 'rien n’est parti');
      assert.equal(view.metrics.reservedWithoutOutcome, 1);
      assert.equal(view.sent.length, 0);
      assert.equal(view.reserved.length, 1);
    } finally { scratch.close(); }
  });

  test('un envoi consigné apparaît comme envoi, et une seule fois', () => {
    const scratch = createRepositories(join(dir, 'outreach2.db'), logger);
    try {
      scratch.salesLoop.claimSend({ ...message, claimedBy: 'test' });
      scratch.salesLoop.recordSendResult({
        idempotencyKey: sendKey(message), phase: 'SENT', externalMessageId: 'm-1',
      });
      const view = buildOutreach(scratch, config, '2026-08-26');
      assert.equal(view.metrics.messagesSent, 1);
      assert.equal(view.metrics.reservedWithoutOutcome, 0);
      assert.equal(view.sent.length, 1);
      assert.equal(view.sent[0]!.messageId, 'm-1');
    } finally { scratch.close(); }
  });

  test('le quota du jour ne descend jamais sous zéro', () => {
    const view = buildOutreach(repos, config, '2026-08-26');
    assert.ok(view.metrics.dailyRemaining >= 0);
    assert.ok(view.metrics.dailyRemaining <= view.metrics.dailyCap);
  });

  test('le corps d’un message n’est pas exposé par la liste des envois', () => {
    // La liste sert à voir ce qui est parti, pas à relire chaque courriel.
    const scratch = createRepositories(join(dir, 'outreach3.db'), logger);
    try {
      scratch.salesLoop.claimSend({ ...message, claimedBy: 'test' });
      scratch.salesLoop.recordSendResult({
        idempotencyKey: sendKey(message), phase: 'SENT', externalMessageId: 'm-1',
      });
      assert.equal(JSON.stringify(buildOutreach(scratch, config)).includes('Corps'), false);
    } finally { scratch.close(); }
  });
});

// ─── RELANCES ───────────────────────────────────────────────────────────────

describe('les relances viennent d’une seule autorité', () => {
  test('l’échéance publiée est celle de la configuration', () => {
    const view = buildFollowUps(repos, config, '2026-08-26');
    assert.equal(view.afterBusinessDays, config.sales.followUpAfterDays);
  });

  test('dues et en attente ne se recouvrent pas', () => {
    const scratch = createRepositories(join(dir, 'fu.db'), logger);
    try {
      scratch.sales.discover({
        batchId: 'B', companyName: 'Ancienne', domain: 'ancienne.invalid',
        discoveredAt: '2026-08-01T00:00:00.000Z',
      });
      scratch.sales.recordOutreach({
        domain: 'ancienne.invalid', kind: 'CONTACTED', recordedBy: 'test',
        channel: 'EMAIL', recordedAt: '2026-08-01T00:00:00.000Z',
      });
      const view = buildFollowUps(scratch, config, '2026-08-26');
      const dues = new Set(view.due.map((d) => d.domain));
      for (const w of view.waiting) {
        assert.equal(dues.has(w.domain), false, `${w.domain} ne peut pas être des deux`);
      }
      assert.equal(view.metrics.contacted, view.due.length + view.waiting.length + view.metrics.replied);
    } finally { scratch.close(); }
  });
});

// ─── ANALYTIQUE ET COÛTS ────────────────────────────────────────────────────

describe('une tendance ne s’invente pas', () => {
  test('un jour sans appel n’a pas de ligne', () => {
    const scratch = createRepositories(join(dir, 'an.db'), logger);
    try {
      const view = buildAnalytics(scratch, config);
      assert.deepEqual(view.daily, [], 'aucune ligne plutôt qu’une suite de zéros');
      assert.equal(view.conversion.replyRate, null);
      assert.equal(view.conversion.costPerClientUsd, null, 'exige au moins un client payant');
    } finally { scratch.close(); }
  });

  test('les deux registres de dépense sont additionnés par fournisseur', () => {
    // Le défaut d'origine : ne lire que le registre des workers faisait
    // afficher N/A sur une dépense mission bien réelle.
    const scratch = createRepositories(join(dir, 'cost2.db'), logger);
    try {
      const mission = scratch.missions.create({
        title: 'M', objective: 'o', context: {}, createdBy: 'test', tokenBudget: 10,
      });
      scratch.llmCalls.record({
        missionId: mission.id, taskRef: 't', agentKey: 'a', purpose: 'sales-qualification',
        provider: 'ANTHROPIC', model: 'claude-haiku-4-5', inputTokens: 100, outputTokens: 50,
        cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01,
        durationMs: 10, ok: true, error: null, toolCalls: 0,
        subject: null, contextChars: null, evidenceCount: null,
        createdAt: new Date().toISOString(),
      });
      const task = scratch.tasks.create({
        taskType: 'X', department: 'ENGINEERING', workerType: 'ANTHROPIC', payload: {},
      }).task;
      scratch.tasks.recordAiCall({
        taskId: task.taskId, provider: 'ANTHROPIC', model: 'claude-haiku-4-5',
        inputTokens: 10, outputTokens: 5, costUsd: 0.02, costBasis: 'KNOWN', outcome: 'SUCCESS',
      });

      const costs = buildCosts(scratch, config);
      const anthropic = costs.byProvider.find((p) => p.provider === 'ANTHROPIC')!;
      assert.equal(anthropic.calls, 2, 'les deux registres, pas un seul');
      assert.ok(Math.abs((anthropic.costUsd ?? 0) - 0.03) < 1e-9);

      // La boucle commerciale est isolée par l'intention de l'appel.
      assert.equal(costs.salesLoop.calls, 1);
      assert.ok(costs.salesLoop.purposes.includes('sales-qualification'));

      // Et chaque ventilation existe réellement.
      assert.ok(costs.byModel.some((r) => r.label === 'claude-haiku-4-5'));
      assert.ok(costs.byAgent.some((r) => r.label === 'a'));
      assert.ok(costs.byDepartment.some((r) => r.label === 'ENGINEERING'));
    } finally { scratch.close(); }
  });

  test('un fournisseur sans appel rend null, jamais zéro', () => {
    const scratch = createRepositories(join(dir, 'cost3.db'), logger);
    try {
      const openai = buildCosts(scratch, config).byProvider.find((p) => p.provider === 'OPENAI')!;
      assert.equal(openai.calls, 0);
      assert.equal(openai.costUsd, null, 'null, pas 0 $');
    } finally { scratch.close(); }
  });
});

// ─── GARDES STRUCTURELLES ───────────────────────────────────────────────────

describe('les gardes de l’écran restent en place', () => {
  test('aucun secret ne traverse les nouveaux écrans', () => {
    const INTERDITS = [
      'sk-ant-', 'sk-proj-', 'GOCSPX-', 'refresh_token', 'client_secret',
      'ANTHROPIC_API_KEY', 'GMAIL_CLIENT_SECRET', 'BRAVE_SEARCH_API_KEY',
    ];
    const rendu = JSON.stringify([
      buildSearchFabric(repos, config, null),
      buildMultiModelTrace(repos),
      buildOutreach(repos, config),
      buildFollowUps(repos, config),
      buildAnalytics(repos, config),
    ]);
    for (const motif of INTERDITS) {
      assert.equal(rendu.includes(motif), false, `« ${motif} » ne doit pas sortir`);
    }
    for (const nom of ['ANTHROPIC_API_KEY', 'GMAIL_CLIENT_SECRET', 'SEARXNG_URL']) {
      const valeur = process.env[nom]?.trim();
      if (valeur && valeur.length > 8) {
        assert.equal(rendu.includes(valeur), false, `la valeur de ${nom} ne doit jamais sortir`);
      }
    }
  });

  test('l’écran d’approbation ne propose aucune mutation', () => {
    // La garde qui compte : une seconde voie d'envoi finirait par être celle
    // qui oublie une vérification. Les boutons existent, désactivés, avec leur
    // motif — plutôt qu'absents, ce qui laisserait croire à un oubli.
    const source = readFileSync(
      new URL('../../../apps/console/src/views/Pipeline.tsx', import.meta.url), 'utf8',
    );
    assert.match(source, /ACTION ENDPOINT UNAVAILABLE/);
    assert.match(source, /className="cc-btn cc-btn--ok" disabled/);
    // Aucun appel de mutation depuis l'écran d'approbation.
    assert.equal(/\bpost\s*\(|\bapi\.approve|cc\.approve/.test(source), false);
  });

  test('le temps réel relit ce que les autres processus écrivent', () => {
    // Un cycle lancé en ligne de commande est un autre processus : ses
    // événements n'atteignent jamais l'émetteur en mémoire du serveur. Sans
    // cette relecture, l'écran resterait immobile pendant tout un cycle réel.
    const source = readFileSync(
      new URL('../src/http/realtime.ts', import.meta.url), 'utf8',
    );
    assert.match(source, /repos\.events\.since\(/);
    // Et le même socket, pas un second.
    assert.equal((source.match(/websocket: true/g) ?? []).length, 1);
  });

  test('aucun second canal temps réel n’a été ouvert côté client', () => {
    const store = readFileSync(
      new URL('../../../apps/console/src/store.ts', import.meta.url), 'utf8',
    );
    assert.equal((store.match(/new WebSocket\(/g) ?? []).length, 1);
  });
});

describe('un chiffre plausible n’est pas un chiffre juste', () => {
  test('une recherche en mémoire n’est pas une requête web', () => {
    // Le défaut exact : `memory_search` porte le mot « search » et n'interroge
    // que la base locale. Filtré au nom, il ajoutait 74 requêtes à 2 ms et
    // faisait passer la recherche web pour instantanée.
    const scratch = createRepositories(join(dir, 'weblike.db'), logger);
    try {
      const mission = scratch.missions.create({
        title: 'T', objective: 'o', context: {}, createdBy: 'test', tokenBudget: 10,
      });
      const call = (tool: string, category: string, external: boolean, ms: number) =>
        scratch.toolCalls.record({
          missionId: mission.id, taskRef: 's', agentKey: 'a', tool, category,
          durationMs: ms, ok: true, error: null, external,
          createdAt: '2026-08-26T10:00:00.000Z',
        });
      call('memory_search', 'knowledge', false, 2);
      call('discover_companies', 'research', true, 40_000);
      call('http_fetch', 'research', true, 600);

      const view = buildSearchFabric(scratch, config, null);
      assert.equal(view.ledger.queries, 1, 'seule la découverte web est une requête');
      assert.equal(view.ledger.avgQueryMs, 40_000, 'la vraie latence, pas celle de la mémoire');
      assert.equal(view.ledger.pagesVisited, 1);
      assert.equal(
        view.byTool.some((t) => t.tool === 'memory_search'), false,
        'la mémoire n’a rien à faire dans le tableau des moteurs',
      );
    } finally { scratch.close(); }
  });

  test('un total à vie ne se glisse pas dans un pipeline par cycle', () => {
    // 172 domaines connus depuis toujours, posés au milieu de cases qui
    // comptent le lot courant, se lisaient « 172 doublons ce cycle ».
    const view = buildProspecting(repos, config, '2026-08-26');
    const stage = view.stages.find((s) => s.id === 'DUPLICATE_CHECK')!;
    assert.equal(stage.count, null, 'aucune mesure par cycle : N/A, pas un total');
    assert.equal(typeof view.registryDomains, 'number', 'le total garde sa place, nommé');
  });

  test('deux orthographes du même modèle ne font pas une chaîne', () => {
    // `claude-haiku-4-5-20251001` et `claude-haiku-4-5` sont le même modèle :
    // le suffixe est une date de version. Comptés distincts, ils faisaient
    // apparaître neuf missions « multi-modèle » dont aucune ne l'était.
    const scratch = createRepositories(join(dir, 'family.db'), logger);
    try {
      const mission = scratch.missions.create({
        title: 'M', objective: 'o', context: {}, createdBy: 'test', tokenBudget: 10,
      });
      const call = (provider: string, model: string) =>
        scratch.llmCalls.record({
          missionId: mission.id, taskRef: 's', agentKey: 'a', purpose: 'p',
          provider, model, inputTokens: 1, outputTokens: 1,
          cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001,
          durationMs: 1, ok: true, error: null, toolCalls: 0,
          subject: null, contextChars: null, evidenceCount: null,
          createdAt: new Date().toISOString(),
        });
      call('anthropic', 'claude-haiku-4-5-20251001');
      call('anthropic', 'claude-haiku-4-5');
      assert.equal(buildMultiModelTrace(scratch).missions.length, 0);

      // Un modèle réellement différent, lui, fait bien une chaîne.
      call('anthropic', 'claude-sonnet-5');
      assert.equal(buildMultiModelTrace(scratch).missions.length, 1);
    } finally { scratch.close(); }
  });

  test('une chaîne simulée n’est pas une chaîne réelle', () => {
    // Un appel simulé n'a rien coûté et n'a interrogé personne. Le compter
    // ferait passer une répétition locale pour une collaboration entre modèles.
    const scratch = createRepositories(join(dir, 'sim.db'), logger);
    try {
      const mission = scratch.missions.create({
        title: 'M', objective: 'o', context: {}, createdBy: 'test', tokenBudget: 10,
      });
      for (const model of ['claude-sonnet-5 (simulation)', 'claude-opus-5 (simulation)']) {
        scratch.llmCalls.record({
          missionId: mission.id, taskRef: 's', agentKey: 'a', purpose: 'p',
          provider: 'simulation', model, inputTokens: 1, outputTokens: 1,
          cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0,
          durationMs: 1, ok: true, error: null, toolCalls: 0,
          subject: null, contextChars: null, evidenceCount: null,
          createdAt: new Date().toISOString(),
        });
      }
      assert.equal(buildMultiModelTrace(scratch).missions.length, 0);
    } finally { scratch.close(); }
  });
});
