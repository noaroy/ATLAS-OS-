import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtlasError, createLogger, type AtlasConfig } from '@atlas/core';
import {
  InferenceFabric,
  InferenceProviderRegistry,
  InferenceRouter,
  buildInferenceRegistry,
  reloadPricingConfig,
  ANTHROPIC_CAPABILITIES,
  OPENAI_COMPATIBLE_CAPABILITIES,
  SIMULATION_CAPABILITIES,
  assessInferenceSuitability,
  classifyFailure,
  shouldFailover,
  type InferenceCapabilities,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from '@atlas/llm';

/**
 * L'Inference Fabric, sans toucher au réseau.
 *
 * Aucun test de ce fichier n'ouvre de connexion et aucun ne dépense un centime.
 * Les fournisseurs sont scriptés, l'horloge est injectée : un refroidissement
 * d'une heure se traverse en une ligne.
 *
 * Le scénario qui a motivé ce module se lit dans le premier bloc de bascule :
 * VAL-001 est morte à sa première étape parce que le compte Anthropic était
 * vide, et qu'il n'existait aucun autre fournisseur.
 */

const HAIKU = 'claude-haiku-4-5-20251001';

function requestFor(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: HAIKU,
    system: 'test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'bonjour' }] }],
    maxTokens: 1000,
    meta: { missionId: 'msn_x', taskRef: 'discovery', agentKey: null, purpose: 'test' },
    ...overrides,
  } as LlmRequest;
}

const okResponse = (model = HAIKU): LlmResponse =>
  ({
    content: [{ type: 'text', text: 'ok' }],
    stopReason: 'end_turn',
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    model,
    refusal: null,
  }) as LlmResponse;

/** Un fournisseur dont le test décide chaque réponse. */
function fakeProvider(
  kind: LlmProvider['kind'],
  behaviour: 'ok' | Error | (() => never),
): LlmProvider & { calls: number } {
  const provider = {
    kind,
    calls: 0,
    async complete(): Promise<LlmResponse> {
      provider.calls += 1;
      if (behaviour === 'ok') return okResponse();
      if (typeof behaviour === 'function') behaviour();
      throw behaviour;
    },
  };
  return provider;
}

function registryWith(
  entries: Array<{
    id: string;
    kind?: LlmProvider['kind'];
    behaviour?: 'ok' | Error;
    available?: boolean;
    priority?: number;
    costModel?: 'metered' | 'local' | 'free';
    capabilities?: InferenceCapabilities;
  }>,
): { registry: InferenceProviderRegistry; providers: Map<string, { calls: number }> } {
  const registry = new InferenceProviderRegistry();
  const providers = new Map<string, { calls: number }>();

  for (const [i, e] of entries.entries()) {
    const provider = fakeProvider(e.kind ?? 'anthropic', e.behaviour ?? 'ok');
    providers.set(e.id, provider);
    registry.register({
      id: e.id,
      label: e.id,
      provider,
      priority: e.priority ?? i * 10,
      costModel: e.costModel ?? 'metered',
      capabilities: e.capabilities ?? ANTHROPIC_CAPABILITIES,
      available: () =>
        e.available === false
          ? { available: false, reason: `${e.id} non configuré` }
          : { available: true, reason: 'prêt' },
    });
  }
  return { registry, providers };
}

const liveFabric = (registry: InferenceProviderRegistry, overrides = {}): InferenceFabric =>
  new InferenceFabric({ registry, policy: { mode: 'live', ...overrides } });

// ─── Classement des échecs ──────────────────────────────────────────────────

describe('classement des échecs d’inférence', () => {
  test('un crédit épuisé est reconnu, quel que soit le code HTTP', () => {
    // Le cas de VAL-001 : un solde vide arrive en HTTP 400, indiscernable
    // d'une requête invalide sans lire le message.
    const failure = classifyFailure(
      new Error('Anthropic API error: 400 {"message":"Your credit balance is too low"}'),
    );
    assert.equal(failure.kind, 'credit');
  });

  test('les causes se distinguent', () => {
    assert.equal(classifyFailure(new Error('429 rate limit exceeded')).kind, 'quota');
    assert.equal(classifyFailure(new Error('401 authentication failed')).kind, 'auth');
    assert.equal(classifyFailure(new Error('503 overloaded')).kind, 'server');
    assert.equal(classifyFailure(new Error('request timed out')).kind, 'timeout');
    assert.equal(classifyFailure(new Error('fetch failed ECONNREFUSED')).kind, 'network');
    assert.equal(classifyFailure(new Error('400 invalid_request: schema')).kind, 'request');
  });

  test('une requête malformée ne déclenche pas de bascule', () => {
    // Elle le restera partout : la relancer ailleurs paierait deux fois la même
    // erreur. C'est la même règle que le résultat vide côté recherche.
    assert.equal(shouldFailover('request'), false);
    assert.equal(shouldFailover('credit'), true);
    assert.equal(shouldFailover('quota'), true);
    assert.equal(shouldFailover('server'), true);
    assert.equal(shouldFailover('timeout'), true);
    assert.equal(shouldFailover('network'), true);
  });
});

// ─── Adéquation ─────────────────────────────────────────────────────────────

describe('adéquation d’un fournisseur', () => {
  test('un schéma JSON demandé à qui n’en produit pas est structurellement refusé', () => {
    const verdict = assessInferenceSuitability(OPENAI_COMPATIBLE_CAPABILITIES, {
      model: 'llama-3',
      jsonSchema: { type: 'object' } as never,
      maxTokens: 1000,
    });
    assert.equal(verdict.verdict, 'unsuitable');
    assert.match(verdict.gaps.join(' '), /structurée/);
  });

  test('des outils demandés à qui ne les accepte pas sont refusés', () => {
    const verdict = assessInferenceSuitability(OPENAI_COMPATIBLE_CAPABILITIES, {
      model: 'llama-3',
      tools: [{ name: 'x' }] as never,
      maxTokens: 1000,
    });
    assert.equal(verdict.verdict, 'unsuitable');
  });

  test('un contexte trop grand est structurel, une sortie trop longue ne l’est pas', () => {
    // Une réponse plus courte reste une réponse ; une entrée qui ne tient pas
    // ne tient pas.
    const tooMuchInput = assessInferenceSuitability(OPENAI_COMPATIBLE_CAPABILITIES, {
      model: 'llama-3',
      maxTokens: 100,
      estimatedInputTokens: 500_000,
    });
    assert.equal(tooMuchInput.verdict, 'unsuitable');

    const tooMuchOutput = assessInferenceSuitability(OPENAI_COMPATIBLE_CAPABILITIES, {
      model: 'llama-3',
      maxTokens: 60_000,
      estimatedInputTokens: 100,
    });
    assert.equal(tooMuchOutput.verdict, 'degraded');
  });

  test('un fournisseur pleinement capable est adapté', () => {
    const verdict = assessInferenceSuitability(ANTHROPIC_CAPABILITIES, {
      model: HAIKU,
      jsonSchema: { type: 'object' } as never,
      tools: [{ name: 'x' }] as never,
      maxTokens: 8000,
      estimatedInputTokens: 20_000,
    });
    assert.equal(verdict.verdict, 'suitable');
  });
});

// ─── Routage ────────────────────────────────────────────────────────────────

describe('routage de l’inférence', () => {
  test('la simulation n’est jamais routée en mode réel', () => {
    // Le test le plus important du fichier. Elle répond toujours, coûte zéro et
    // invente : un repli silencieux vers elle transformerait une panne en
    // fabrication de données métier, indiscernables de vraies dans le rapport.
    const { registry } = registryWith([
      { id: 'anthropic', behaviour: new Error('credit balance too low') },
      { id: 'simulation', kind: 'simulation', capabilities: SIMULATION_CAPABILITIES },
    ]);
    registry.setCredit('anthropic', 'exhausted');

    const plan = new InferenceRouter(registry, {
      mode: 'live',
      allowCostlierFailover: false,
      costTolerance: 1,
    }).plan(requestFor());

    assert.equal(plan.blocked, true, 'aucun secours ne doit exister vers la simulation');
    assert.ok(
      plan.considered.some((c) => c.record.id === 'simulation' && /simulation exclue/.test(c.excluded ?? '')),
      'la simulation doit être écartée nommément',
    );
  });

  test('la simulation redevient routable en mode simulation assumé', () => {
    const { registry } = registryWith([
      { id: 'simulation', kind: 'simulation', capabilities: SIMULATION_CAPABILITIES },
    ]);
    const plan = new InferenceRouter(registry, {
      mode: 'simulation',
      allowCostlierFailover: false,
      costTolerance: 1,
    }).plan(requestFor());

    assert.equal(plan.blocked, false);
  });

  test('un compte épuisé est écarté, et distingué d’une panne', () => {
    const { registry } = registryWith([{ id: 'anthropic' }, { id: 'secours' }]);
    registry.setCredit('anthropic', 'exhausted');

    const plan = new InferenceRouter(registry, {
      mode: 'live',
      allowCostlierFailover: false,
      costTolerance: 1,
    }).plan(requestFor());

    const anthropic = plan.considered.find((c) => c.record.id === 'anthropic')!;
    assert.match(anthropic.excluded ?? '', /compte épuisé/);
    assert.equal(plan.order[0]?.record.id, 'secours');
  });

  test('un fournisseur local passe devant un fournisseur facturé', () => {
    const { registry } = registryWith([
      { id: 'anthropic', costModel: 'metered', priority: 1 },
      { id: 'local', costModel: 'local', priority: 99 },
    ]);
    const plan = new InferenceRouter(registry, {
      mode: 'live',
      allowCostlierFailover: false,
      costTolerance: 1,
    }).plan(requestFor());

    assert.equal(plan.order[0]?.record.id, 'local');
  });

  test('le blocage nomme ses causes séparément', () => {
    // Recharger un compte, poser une clé et attendre un refroidissement sont
    // trois gestes différents. « Aucun fournisseur disponible » ne dit lequel.
    const { registry } = registryWith([
      { id: 'anthropic' },
      { id: 'secours', available: false },
    ]);
    registry.setCredit('anthropic', 'exhausted');

    const plan = new InferenceRouter(registry, {
      mode: 'live',
      allowCostlierFailover: false,
      costTolerance: 1,
    }).plan(requestFor());

    assert.equal(plan.blocked, true);
    assert.match(plan.blockedReason ?? '', /compte épuisé/);
    assert.match(plan.blockedReason ?? '', /non configuré/);
  });
});

// ─── Bascule ────────────────────────────────────────────────────────────────

describe('bascule d’inférence', () => {
  test('le fournisseur principal répond, aucun autre n’est appelé', async () => {
    const { registry, providers } = registryWith([{ id: 'anthropic' }, { id: 'secours' }]);
    const response = await liveFabric(registry).complete(requestFor());

    assert.ok(response.content.length > 0);
    assert.equal(providers.get('anthropic')!.calls, 1);
    assert.equal(providers.get('secours')!.calls, 0);
  });

  test('crédit épuisé → le secours prend la relève', async () => {
    // Le scénario de VAL-001, avec un secours cette fois.
    const { registry, providers } = registryWith([
      { id: 'anthropic', behaviour: new Error('400 Your credit balance is too low') },
      { id: 'secours' },
    ]);
    const fabric = liveFabric(registry);

    const response = await fabric.complete(requestFor());

    assert.ok(response.content.length > 0);
    assert.equal(providers.get('secours')!.calls, 1);
    assert.equal(fabric.lastTrace().selected, 'secours');
    assert.equal(fabric.lastTrace().attempts[0]?.failureKind, 'credit');
  });

  test('un compte épuisé est retiré du service pour les appels suivants', async () => {
    // C'est ce qui distingue une bascule d'un réessai : le second appel ne
    // retourne pas frapper à une porte dont on sait qu'elle est fermée.
    const { registry, providers } = registryWith([
      { id: 'anthropic', behaviour: new Error('credit balance too low') },
      { id: 'secours' },
    ]);
    const fabric = liveFabric(registry);

    await fabric.complete(requestFor());
    await fabric.complete(requestFor());

    assert.equal(providers.get('anthropic')!.calls, 1, 'un seul appel vers le compte épuisé');
    assert.equal(providers.get('secours')!.calls, 2);
  });

  test('une requête malformée ne bascule pas', async () => {
    const { registry, providers } = registryWith([
      { id: 'anthropic', behaviour: new Error('400 invalid_request: schema not supported') },
      { id: 'secours' },
    ]);

    await assert.rejects(() => liveFabric(registry).complete(requestFor()));
    assert.equal(providers.get('secours')!.calls, 0, 'la même erreur se reproduirait ailleurs');
  });

  test('tous les fournisseurs épuisés lève un refus explicite', async () => {
    const { registry } = registryWith([
      { id: 'anthropic', behaviour: new Error('503 overloaded') },
      { id: 'secours', behaviour: new Error('timeout') },
    ]);
    const fabric = liveFabric(registry);

    await assert.rejects(
      () => fabric.complete(requestFor()),
      (err: unknown) =>
        err instanceof AtlasError && err.code === 'PROVIDER_ERROR' && err.retryable === false,
    );
    assert.equal(fabric.lastTrace().attempts.length, 2);
  });

  test('un parc vide refuse sans appeler personne', async () => {
    const { registry } = registryWith([{ id: 'anthropic', available: false }]);
    await assert.rejects(() => liveFabric(registry).complete(requestFor()), /indisponible/);
  });

  test('le nombre de tentatives est borné', async () => {
    const { registry } = registryWith([
      { id: 'a', behaviour: new Error('503') },
      { id: 'b', behaviour: new Error('503') },
      { id: 'c', behaviour: new Error('503') },
    ]);
    const fabric = new InferenceFabric({ registry, policy: { mode: 'live' }, maxAttempts: 2 });

    await assert.rejects(() => fabric.complete(requestFor()));
    assert.equal(fabric.lastTrace().attempts.length, 2);
  });
});

// ─── Politique de coût ──────────────────────────────────────────────────────

describe('jamais vers plus cher sans autorisation', () => {
  /**
   * Un secours qui substitue un modèle plus cher.
   *
   * La première version de ces tests ne prouvait rien : le routeur comparait le
   * modèle demandé à lui-même, l'égalité était systématique, et la règle ne
   * s'appliquait jamais. Le fournisseur doit déclarer ce qu'il servirait
   * réellement pour que la comparaison ait un sens.
   */
  const withSubstitute = (substituteModel: string): InferenceProviderRegistry => {
    const registry = new InferenceProviderRegistry();
    registry.register({
      id: 'anthropic',
      label: 'anthropic',
      provider: fakeProvider('anthropic', new Error('503 overloaded')),
      priority: 1,
      costModel: 'metered',
      capabilities: ANTHROPIC_CAPABILITIES,
      available: () => ({ available: true, reason: 'prêt' }),
    });
    registry.register({
      id: 'secours-cher',
      label: 'secours-cher',
      provider: fakeProvider('anthropic', 'ok'),
      priority: 2,
      costModel: 'metered',
      capabilities: ANTHROPIC_CAPABILITIES,
      substituteModel,
      available: () => ({ available: true, reason: 'prêt' }),
    });
    return registry;
  };

  test('un secours qui servirait un modèle plus cher est écarté', () => {
    // Haiku demandé, Opus servi : dix-huit fois le tarif. Une bascule se
    // produit quand quelque chose ne va pas — le pire moment pour décider seul
    // d'augmenter la facture.
    const plan = new InferenceRouter(withSubstitute('claude-opus-5'), {
      mode: 'live',
      allowCostlierFailover: false,
      costTolerance: 1,
    }).plan(requestFor({ model: HAIKU }));

    const secours = plan.considered.find((c) => c.record.id === 'secours-cher')!;
    assert.match(secours.excluded ?? '', /plus cher/);
    assert.ok(
      !plan.order.some((c) => c.record.id === 'secours-cher'),
      'le secours plus cher ne doit pas figurer dans la file',
    );
  });

  test('un secours au même tarif ou moins cher passe', () => {
    const plan = new InferenceRouter(withSubstitute(HAIKU), {
      mode: 'live',
      allowCostlierFailover: false,
      costTolerance: 1,
    }).plan(requestFor({ model: HAIKU }));

    assert.ok(plan.order.some((c) => c.record.id === 'secours-cher'), 'même tarif : rien à refuser');
  });

  test('l’autorisation explicite lève la restriction', () => {
    const plan = new InferenceRouter(withSubstitute('claude-opus-5'), {
      mode: 'live',
      allowCostlierFailover: true,
      costTolerance: 1,
    }).plan(requestFor({ model: HAIKU }));

    assert.ok(
      plan.order.some((c) => c.record.id === 'secours-cher'),
      'autorisée explicitement, la bascule coûteuse redevient possible',
    );
  });

  test('la tolérance absorbe un écart mineur sans ouvrir la porte', () => {
    // Une tolérance de 1,2 laisse passer 20 % d'écart, pas un facteur dix-huit.
    const permissive = new InferenceRouter(withSubstitute('claude-opus-5'), {
      mode: 'live',
      allowCostlierFailover: false,
      costTolerance: 1.2,
    }).plan(requestFor({ model: HAIKU }));

    assert.ok(
      !permissive.order.some((c) => c.record.id === 'secours-cher'),
      'une tolérance raisonnable ne doit pas autoriser Opus à la place de Haiku',
    );
  });
});

// ─── Disjoncteur et métriques ───────────────────────────────────────────────

describe('disjoncteur et score d’inférence', () => {
  test('un fournisseur jamais appelé n’a pas de score', () => {
    const { registry } = registryWith([{ id: 'anthropic' }]);
    assert.equal(registry.scoreOf('anthropic'), null);
    assert.equal(registry.healthOf('anthropic'), 'unknown');
  });

  test('le score ne vient que d’appels réels', async () => {
    const { registry } = registryWith([{ id: 'anthropic' }]);
    await liveFabric(registry).complete(requestFor());

    const score = registry.scoreOf('anthropic')!;
    assert.equal(score.sampleSize, 1);
    assert.equal(score.successRate, 1);
    assert.equal(registry.healthOf('anthropic'), 'healthy');
  });

  test('un crédit épuisé ouvre le circuit immédiatement', async () => {
    const { registry } = registryWith([
      { id: 'anthropic', behaviour: new Error('credit balance too low') },
      { id: 'secours' },
    ]);
    await liveFabric(registry).complete(requestFor());

    const status = registry.statusOf('anthropic')!;
    assert.equal(status.credit, 'exhausted');
    assert.equal(status.circuit.state, 'open');
    assert.equal(status.health, 'unhealthy');
  });

  test('un appel réussi prouve que le compte est approvisionné', async () => {
    const { registry } = registryWith([{ id: 'anthropic' }]);
    registry.setCredit('anthropic', 'unknown');
    await liveFabric(registry).complete(requestFor());
    assert.equal(registry.statusOf('anthropic')!.credit, 'ok');
  });
});

// ─── Secours OpenAI ─────────────────────────────────────────────────────────

describe('secours OpenAI après un compte Anthropic épuisé', () => {
  /** Anthropic en tête ; le secours ne devient éligible qu'Anthropic tombé. */
  function gatedFleet(anthropic: 'ok' | Error) {
    const registry = new InferenceProviderRegistry();
    const primary = fakeProvider('anthropic', anthropic);
    const openai = {
      kind: 'anthropic' as const,
      calls: 0,
      async complete(): Promise<LlmResponse> {
        openai.calls += 1;
        return okResponse('gpt-5-2025-08-07');
      },
    };
    const simulation = fakeProvider('simulation', 'ok');
    registry.register({
      id: 'anthropic', label: 'anthropic', provider: primary, priority: 20, costModel: 'metered',
      capabilities: ANTHROPIC_CAPABILITIES, available: () => ({ available: true, reason: 'prêt' }),
    });
    registry.register({
      id: 'openai', label: 'openai', provider: openai, priority: 30, costModel: 'metered',
      capabilities: { ...ANTHROPIC_CAPABILITIES, toolUse: false, serverTools: false, models: ['*'] },
      available: () => {
        const a = registry.get('anthropic')!;
        const down = a.credit === 'exhausted' || (a.credit === 'quota-reached' && a.breaker.state === 'open');
        return down ? { available: true, reason: 'secours' } : { available: false, reason: 'secours seulement' };
      },
    });
    registry.register({
      id: 'simulation', label: 'simulation', provider: simulation, priority: 90, costModel: 'free',
      capabilities: SIMULATION_CAPABILITIES, available: () => ({ available: true, reason: 'toujours' }),
    });
    return { registry, primary, openai, simulation };
  }

  test('Anthropic sain reste le fournisseur principal', async () => {
    const { registry, primary, openai } = gatedFleet('ok');
    const fabric = liveFabric(registry);
    await fabric.complete(requestFor());
    assert.equal(primary.calls, 1);
    assert.equal(openai.calls, 0);
    assert.equal(fabric.lastTrace().selected, 'anthropic');
  });

  test('crédit épuisé : la même requête bascule sur OpenAI, jamais sur la simulation', async () => {
    const { registry, openai, simulation } = gatedFleet(new Error('400 Your credit balance is too low'));
    const fabric = liveFabric(registry);
    const response = await fabric.complete(requestFor());
    assert.equal(openai.calls, 1);
    assert.equal(simulation.calls, 0);
    assert.equal(fabric.lastTrace().selected, 'openai');
    assert.equal(response.model, 'gpt-5-2025-08-07', 'le modèle servi reste attribuable');
    assert.deepEqual(
      fabric.lastTrace().attempts.map((a) => [a.providerId, a.failureKind]),
      [['anthropic', 'credit'], ['openai', null]],
    );
  });

  test('quota atteint : secours tant que le disjoncteur est ouvert', async () => {
    const { registry, openai } = gatedFleet(new Error('429 rate limit exceeded'));
    await liveFabric(registry).complete(requestFor());
    assert.equal(registry.statusOf('anthropic')!.credit, 'quota-reached');
    assert.equal(openai.calls, 1);
  });

  test('une panne sans rapport avec le compte n’ouvre pas le secours', async () => {
    const { registry, openai, simulation } = gatedFleet(new Error('503 overloaded'));
    await assert.rejects(liveFabric(registry).complete(requestFor()));
    assert.equal(openai.calls, 0);
    assert.equal(simulation.calls, 0);
  });

  test('un coût au tarif inconnu n’est jamais compté zéro', async () => {
    const { registry } = registryWith([{ id: 'x' }]);
    const provider = registry.get('x')!.provider as { complete: LlmProvider['complete'] };
    provider.complete = async () => okResponse('modele-sans-tarif');
    await liveFabric(registry).complete(requestFor());
    const metrics = registry.statusOf('x')!.metrics;
    assert.equal(metrics.unpricedCalls, 1);
    assert.equal(metrics.totalCostUsd, 0, 'rien d’inventé dans le total');
  });

  describe('le parc du déploiement', () => {
    const config = {
      llm: { apiKey: 'sk-ant-test', mode: 'live' },
      ai: { openaiModel: 'gpt-5', openaiTimeoutMs: 5_000 },
    } as unknown as AtlasConfig;
    const logger = createLogger({ level: 'error', pretty: false });

    const withOpenAiKey = <T>(fn: () => T): T => {
      const previous = process.env.ATLAS_OPENAI_API_KEY;
      process.env.ATLAS_OPENAI_API_KEY = 'sk-test';
      try {
        return fn();
      } finally {
        if (previous === undefined) delete process.env.ATLAS_OPENAI_API_KEY;
        else process.env.ATLAS_OPENAI_API_KEY = previous;
      }
    };

    test('OpenAI tarifé : écarté tant qu’Anthropic répond, seul éligible une fois son compte vide', () => {
      const dir = mkdtempSync(join(tmpdir(), 'atlas-pricing-'));
      const file = join(dir, 'pricing.json');
      writeFileSync(file, JSON.stringify([{
        provider: 'openai', model: 'gpt-5', input_per_million: 1.25, output_per_million: 10,
        effective_from: '2025-08-07', source: 'test',
      }]));
      reloadPricingConfig(file);
      // Sonnet demandé : gpt-5 y est moins cher, la règle « jamais vers plus
      // cher » ne l'écarte donc pas.
      const sonnet = requestFor({ model: 'claude-sonnet-5' });
      try {
        const registry = withOpenAiKey(() => buildInferenceRegistry(config, logger));
        assert.equal(registry.statusOf('openai')!.available, false);
        assert.equal(new InferenceRouter(registry).plan(sonnet).order[0]!.record.id, 'anthropic');

        registry.recordFailure('anthropic', { kind: 'credit', detail: 'credit balance too low' }, 10);
        const plan = new InferenceRouter(registry).plan(sonnet);
        assert.deepEqual(plan.order.map((c) => c.record.id), ['openai'], 'ni Anthropic épuisé, ni la simulation');
      } finally {
        reloadPricingConfig('');
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('un modèle OpenAI sans tarif connu n’est jamais routé', () => {
      reloadPricingConfig('');
      const registry = withOpenAiKey(() => buildInferenceRegistry(config, logger));
      registry.recordFailure('anthropic', { kind: 'credit', detail: 'credit balance too low' }, 10);
      const status = registry.statusOf('openai')!;
      assert.equal(status.available, false);
      assert.match(status.availabilityReason, /tarif inconnu/);
    });
  });
});
