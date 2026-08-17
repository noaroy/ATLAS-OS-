import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger, EventBus } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';
import { MemoryService } from '@atlas/memory';
import { OpportunityService } from '@atlas/intelligence';
import type { LlmProvider, LlmRequest, LlmResponse } from '@atlas/llm';
import type { ScoringModel } from '@atlas/contracts';
import { DeterministicPipeline } from '../src/pipeline.ts';
import { validateStagePostcondition } from '../src/stage-contract.ts';

/**
 * La reproduction exacte de SALVAGE-001, et sa correction.
 *
 * Le défaut, mesuré : l'ambassadeur a rendu du texte sans jamais appeler
 * `qualify_opportunity`. Cinq candidats sont ressortis sans verdict, l'étape a
 * été comptée réussie parce que le modèle avait répondu, et le scoring a
 * démarré dessus — deux appels, deux échecs, puis des réessais qui ont porté
 * l'entrée de 4 447 à 13 119 jetons et brûlé le budget.
 *
 * Ce fichier rejoue la séquence hors ligne. Elle doit désormais s'arrêter à la
 * qualification, avec un diagnostic qui nomme les candidats sans verdict.
 */

const logger = createLogger({ level: 'error', pretty: false });
let repos: Repositories;
let intelligence: OpportunityService;
let dir: string;
let missionId: string;
let opportunityIds: string[];

const SCORING_MODEL: ScoringModel = {
  dimensions: [
    { key: 'fit', label: 'Adéquation au profil', weight: 0.6, description: 'Correspondance à la cible.' },
    { key: 'reach', label: 'Couverture géographique', weight: 0.4, description: 'Étendue du territoire couvert.' },
  ],
  shortlistThreshold: 50,
  narrative: 'Adéquation au profil, pondérée par la couverture.',
};

/** Un fournisseur scripté : on décide exactement ce que le modèle répond. */
class Scripted implements LlmProvider {
  readonly kind = 'simulation' as const;
  readonly requests: LlmRequest[] = [];
  constructor(private readonly reply: (request: LlmRequest, index: number) => string) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const index = this.requests.length;
    this.requests.push({ ...request, messages: structuredClone(request.messages) });
    return {
      model: request.model,
      content: [{ type: 'text', text: this.reply(request, index) }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
      refusal: null,
    };
  }
}

const pipelineWith = (provider: LlmProvider) =>
  new DeterministicPipeline({
    repos,
    intelligence,
    provider,
    logger,
    model: 'claude-haiku-4-5-20251001',
    maxOutputTokens: 2500,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-salvage-'));
  repos = createRepositories(join(dir, 's.db'), logger);
  repos.departments.upsert({
    key: 'business-expansion',
    name: 'Expansion',
    tagline: '',
    mission: 'Trouver des partenaires.',
    building: 'expansion',
    targetTypes: [],
    briefSchema: {},
    playbook: [],
    scoringModel: SCORING_MODEL,
    teams: [],
    kpis: [],
    triggers: [],
    enabled: true,
  } as never);

  const events = new EventBus(logger);
  intelligence = new OpportunityService({
    repos,
    memory: new MemoryService(repos.memory, events, logger, 'live'),
    events,
    logger,
    simulated: false,
  });

  const mission = repos.missions.create({
    title: 'SALVAGE',
    objective: 'Qualifier des distributeurs allemands déjà identifiés.',
    context: {},
    createdBy: 'test',
    departmentKey: 'business-expansion',
  });
  missionId = mission.id;

  // Les cinq candidats de SALVAGE-001, avec des preuves sourcées.
  opportunityIds = [];
  for (const [i, name] of [
    'Burghardt Verpackungsmaschinen',
    'Hagenauer+Denk KG',
    'Lilie GmbH',
    'SYS TEC electronic AG',
    'Beispiel Vertrieb GmbH',
  ].entries()) {
    const { company } = repos.companies.upsert({
      canonicalKey: `d:candidat-${i}.de`,
      name,
      domain: `candidat-${i}.de`,
      country: 'Germany',
      dataOrigin: 'live',
    });
    const { opportunity } = repos.opportunities.register({
      missionId,
      companyId: company.id,
      departmentKey: 'business-expansion',
      targetTypes: ['distributor'],
      discoveredBy: 'test',
    });
    for (const field of ['existence', 'sector']) {
      repos.companies.appendEvidence({
        companyId: company.id,
        opportunityId: opportunity.id,
        missionId,
        field,
        claim: `${name} — ${field} établi par une source consultable.`,
        value: null,
        nature: 'reported',
        sourceKey: 'src_test',
        sourceRef: `https://candidat-${i}.de/${field}`,
        sourceTitle: null,
        basis: null,
        confidence: 0.8,
        simulated: false,
        collectedAt: new Date().toISOString(),
        agentKey: 'explorer',
      });
    }
    opportunityIds.push(opportunity.id);
  }
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── Le défaut, tel qu'il s'est produit ─────────────────────────────────────

describe('SALVAGE-001 — l’agent ne rend que du texte', () => {
  test('la qualification échoue au lieu de passer', async () => {
    const provider = new Scripted(
      () =>
        "J'ai examiné les cinq candidats. Ils semblent tous pertinents pour le marché " +
        'allemand des machines d’emballage, et je recommande de les retenir.',
    );
    const outcome = await pipelineWith(provider).qualify({
      missionId,
      opportunityIds,
      agentKey: 'ambassador',
      objective: 'Distributeurs allemands.',
    });

    assert.equal(outcome.succeeded, false, 'du texte seul ne vaut pas une qualification');
    assert.equal(outcome.completed, 0);
    assert.equal(outcome.failed, 5);
  });

  test('le diagnostic nomme les candidats sans verdict', async () => {
    const provider = new Scripted(() => 'Tous les candidats semblent pertinents.');
    const outcome = await pipelineWith(provider).qualify({
      missionId,
      opportunityIds,
      agentKey: 'ambassador',
      objective: 'Distributeurs allemands.',
    });

    assert.match(outcome.postcondition.diagnostic, /STAGE_POSTCONDITION_FAILED/);
    assert.match(outcome.postcondition.diagnostic, /stage=qualification/);
    assert.match(outcome.postcondition.diagnostic, /expected=.*5 candidat/);
    assert.match(outcome.postcondition.diagnostic, /actual=0 verdict/);
    assert.match(outcome.postcondition.diagnostic, /Burghardt Verpackungsmaschinen : aucun verdict/);
  });

  test('le scoring ne démarre pas et n’appelle rien', async () => {
    // Le cœur du défaut : SALVAGE-001 a lancé le scoring sur des candidats sans
    // verdict, et a payé deux appels pour deux échecs.
    const provider = new Scripted(() => 'Texte libre, aucune structure.');
    const pipeline = pipelineWith(provider);

    const qualification = await pipeline.qualify({
      missionId,
      opportunityIds,
      agentKey: 'ambassador',
      objective: 'Distributeurs allemands.',
    });
    assert.equal(qualification.succeeded, false);

    // Le contrôleur ne doit pas enchaîner. On le vérifie sur la donnée : aucun
    // candidat qualifié, donc aucune unité à noter.
    const scoringProvider = new Scripted(() => '{"assessments":[]}');
    const scoring = await pipelineWith(scoringProvider).score({
      missionId,
      opportunityIds,
      agentKey: 'analyst',
      objective: 'Distributeurs allemands.',
      model: SCORING_MODEL,
    });

    assert.equal(scoringProvider.requests.length, 0, 'aucun appel de notation ne doit partir');
    assert.equal(scoring.succeeded, false);
    assert.match(scoring.postcondition.diagnostic, /au moins un candidat qualifié/);
  });

  test('une réparation est tentée une seule fois', async () => {
    // La réparation ne reçoit que l'entrée, la sortie invalide et le schéma —
    // jamais l'historique, dont l'accumulation avait fait exploser le contexte.
    const provider = new Scripted(() => 'toujours du texte');
    await pipelineWith(provider).qualify({
      missionId,
      opportunityIds: [opportunityIds[0]!],
      agentKey: 'ambassador',
      objective: 'Distributeurs allemands.',
    });

    assert.equal(provider.requests.length, 2, 'un essai, une réparation, pas davantage');
    const [first, repair] = provider.requests;
    assert.equal(repair!.messages.length, 1, 'la réparation ne rejoue pas la conversation');
    assert.match(
      repair!.messages[0]!.content.map((c) => (c.type === 'text' ? c.text : '')).join(''),
      /Sortie précédente, invalide/,
    );
    assert.ok(
      first!.messages.length === 1,
      'le premier essai porte l’unité de travail, et rien d’autre',
    );
  });
});

// ── Le scénario valide ─────────────────────────────────────────────────────

const goodVerdict = (verdict: string) =>
  JSON.stringify({
    verdict,
    rationale: 'Distributeur établi, gamme compatible, couverture régionale confirmée.',
    confidence: 0.8,
    checks: [
      {
        criterion: 'Existence établie',
        passed: true,
        detail: 'Site et mentions légales consultés.',
        evidenceIds: ['placeholder'],
      },
    ],
  });

const goodScore = JSON.stringify({
  assessments: [
    {
      dimension: 'fit',
      value: 80,
      rationale: 'Gamme directement compatible.',
      confidence: 0.8,
      evidenceIds: ['placeholder'],
    },
    {
      dimension: 'reach',
      value: 70,
      rationale: 'Couverture régionale confirmée.',
      confidence: 0.7,
      evidenceIds: ['placeholder'],
    },
  ],
});

/** Remplace le marqueur par un identifiant de preuve réel du candidat visé. */
const withRealEvidence = (json: string, opportunityId: string): string => {
  const evidence = repos.companies.evidenceForOpportunity(opportunityId);
  return json.replace(/"placeholder"/g, JSON.stringify(evidence[0]?.id ?? 'ev_absent'));
};

describe('SALVAGE-001 — le chemin qui aboutit', () => {
  test('la qualification produit un verdict sourcé par candidat', async () => {
    let index = 0;
    const provider = new Scripted(() =>
      withRealEvidence(goodVerdict('qualified'), opportunityIds[index++]!),
    );
    const outcome = await pipelineWith(provider).qualify({
      missionId,
      opportunityIds,
      agentKey: 'ambassador',
      objective: 'Distributeurs allemands.',
    });

    assert.equal(outcome.succeeded, true, outcome.postcondition.diagnostic);
    assert.equal(outcome.completed, 5);
    assert.equal(provider.requests.length, 5, 'un appel par candidat, aucune réparation');
  });

  test('le scoring ne démarre qu’après la qualification, et note chaque qualifié', async () => {
    let i = 0;
    await pipelineWith(
      new Scripted(() => withRealEvidence(goodVerdict('qualified'), opportunityIds[i++]!)),
    ).qualify({ missionId, opportunityIds, agentKey: 'ambassador', objective: 'DE.' });

    let j = 0;
    const scoringProvider = new Scripted(() =>
      withRealEvidence(goodScore, opportunityIds[j++]!),
    );
    const scoring = await pipelineWith(scoringProvider).score({
      missionId,
      opportunityIds,
      agentKey: 'analyst',
      objective: 'DE.',
      model: SCORING_MODEL,
    });

    assert.equal(scoring.succeeded, true, scoring.postcondition.diagnostic);
    assert.equal(scoringProvider.requests.length, 5);
    for (const id of opportunityIds) {
      assert.notEqual(repos.opportunities.require(id).score, null);
    }
  });

  test('un candidat écarté n’est pas noté, et cela n’est pas un échec', async () => {
    // Le contrat ne réclame un score que pour les candidats retenus. L'exiger
    // de tous ferait échouer une étape qui a correctement fait son travail.
    let i = 0;
    await pipelineWith(
      new Scripted(() =>
        withRealEvidence(goodVerdict(i === 0 ? 'rejected' : 'qualified'), opportunityIds[i++]!),
      ),
    ).qualify({ missionId, opportunityIds, agentKey: 'ambassador', objective: 'DE.' });

    let j = 1;
    const scoringProvider = new Scripted(() => withRealEvidence(goodScore, opportunityIds[j++]!));
    const scoring = await pipelineWith(scoringProvider).score({
      missionId,
      opportunityIds,
      agentKey: 'analyst',
      objective: 'DE.',
      model: SCORING_MODEL,
    });

    assert.equal(scoringProvider.requests.length, 4, 'le candidat écarté n’est pas noté');
    assert.equal(scoring.succeeded, true, scoring.postcondition.diagnostic);
    assert.equal(repos.opportunities.require(opportunityIds[0]!).score, null);
  });

  test('le classement ne démarre qu’après un scoring complet', async () => {
    let i = 0;
    await pipelineWith(
      new Scripted(() => withRealEvidence(goodVerdict('qualified'), opportunityIds[i++]!)),
    ).qualify({ missionId, opportunityIds, agentKey: 'ambassador', objective: 'DE.' });

    // Classer avant toute notation : la postcondition doit le refuser.
    const early = pipelineWith(new Scripted(() => '')).rank({
      missionId,
      opportunityIds,
      agentKey: 'analyst',
      model: SCORING_MODEL,
    });
    assert.equal(early.succeeded, false, 'rien de noté ne peut être classé');

    let j = 0;
    await pipelineWith(new Scripted(() => withRealEvidence(goodScore, opportunityIds[j++]!))).score({
      missionId,
      opportunityIds,
      agentKey: 'analyst',
      objective: 'DE.',
      model: SCORING_MODEL,
    });

    const ranking = pipelineWith(new Scripted(() => '')).rank({
      missionId,
      opportunityIds,
      agentKey: 'analyst',
      model: SCORING_MODEL,
    });
    assert.equal(ranking.succeeded, true, ranking.postcondition.diagnostic);
    for (const id of opportunityIds) {
      assert.notEqual(repos.opportunities.require(id).rank, null);
    }
  });

  test('un classement ne coûte aucun appel au modèle', () => {
    // Trier des nombres déjà calculés ne demande pas de raisonnement.
    const provider = new Scripted(() => '');
    pipelineWith(provider).rank({
      missionId,
      opportunityIds,
      agentKey: 'analyst',
      model: SCORING_MODEL,
    });
    assert.equal(provider.requests.length, 0);
  });
});

// ── L'export ───────────────────────────────────────────────────────────────

describe('l’export ne livre que ce qui est vendable', () => {
  test('sans fichier écrit, l’étape échoue', () => {
    const result = validateStagePostcondition('export', {
      repos,
      missionId,
      opportunityIds,
      artifacts: [],
    });
    assert.equal(result.passed, false);
    assert.match(result.diagnostic, /au moins un fichier/);
  });

  test('un fichier sans prospect vendable ne suffit pas', () => {
    const result = validateStagePostcondition('export', {
      repos,
      missionId,
      opportunityIds,
      artifacts: ['out/pack.html'],
    });
    assert.equal(result.passed, false);
    assert.match(result.diagnostic, /aucun prospect ne franchit la barre/);
  });

  test('une identité en conflit interdit la livraison', async () => {
    let i = 0;
    await pipelineWith(
      new Scripted(() => withRealEvidence(goodVerdict('qualified'), opportunityIds[i++]!)),
    ).qualify({ missionId, opportunityIds, agentKey: 'ambassador', objective: 'DE.' });
    let j = 0;
    await pipelineWith(new Scripted(() => withRealEvidence(goodScore, opportunityIds[j++]!))).score({
      missionId,
      opportunityIds,
      agentKey: 'analyst',
      objective: 'DE.',
      model: SCORING_MODEL,
    });
    pipelineWith(new Scripted(() => '')).rank({
      missionId,
      opportunityIds,
      agentKey: 'analyst',
      model: SCORING_MODEL,
    });

    const first = repos.opportunities.require(opportunityIds[0]!);
    repos.companies.setIdentityStatus(first.companyId, 'conflict');

    const result = validateStagePostcondition('export', {
      repos,
      missionId,
      opportunityIds,
      artifacts: ['out/pack.html'],
    });
    assert.equal(result.passed, false);
    assert.match(result.diagnostic, /identité « conflict »/);
  });
});
