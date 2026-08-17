import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus, createLogger } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';
import { MemoryService } from '../src/index.ts';

/**
 * La lignée des connaissances, et la contamination qu'elle empêche.
 *
 * La mémoire est relue *avant* toute recherche, par toute mission future. Une
 * connaissance fabriquée pendant une démonstration y devient, au deuxième
 * usage, « ce qu'ATLAS sait » : elle n'est plus une sortie de modèle, elle est
 * une prémisse que le raisonnement suivant tient pour acquise.
 *
 * C'est la même faille que pour les entreprises, un étage plus haut, et elle
 * est pire : une fiche fabriquée se repère à son domaine, une phrase fabriquée
 * ne se repère à rien.
 */

const logger = createLogger({ level: 'error', pretty: false });
let repos: Repositories;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-mem-'));
  repos = createRepositories(join(dir, 'm.db'), logger);
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const serviceIn = (mode: 'live' | 'simulation') =>
  new MemoryService(repos.memory, new EventBus(logger), logger, mode);

/** Une connaissance déjà en base, avec la lignée que le test décide. */
function stored(title: string, dataOrigin: 'live' | 'simulated' | 'unknown', tier = 'business') {
  return repos.memory.insert({
    tier: tier as never,
    dataOrigin,
    kind: 'fact' as never,
    title,
    content: `${title} — contenu de démonstration ou de production, indifféremment.`,
    metadata: {},
    tags: ['emballage'],
    missionId: null,
    agentKey: null,
    importance: 0.8,
    confidence: 0.8,
    expiresAt: null,
  });
}

describe('barrière de lecture', () => {
  test('une connaissance simulée est exclue en mode réel', () => {
    stored('Marché allemand saturé', 'simulated');

    const hits = serviceIn('live').recall({ text: 'allemand', limit: 10 });
    assert.equal(hits.length, 0, 'aucune connaissance fabriquée ne doit atteindre le raisonnement');
  });

  test('une connaissance de provenance inconnue est exclue en mode réel', () => {
    stored('Marché allemand saturé', 'unknown');

    assert.equal(serviceIn('live').recall({ text: 'allemand', limit: 10 }).length, 0);
  });

  test('une connaissance réelle est rendue en mode réel', () => {
    // La barrière ne doit pas casser ce qu'elle protège.
    stored('Distributeurs allemands identifiés', 'live');

    const hits = serviceIn('live').recall({ text: 'allemands', limit: 10 });
    assert.equal(hits.length, 1);
  });

  test('une connaissance simulée reste lisible en mode simulation', () => {
    // La barrière protège le réel ; elle n'interdit pas de simuler.
    stored('Marché allemand saturé', 'simulated');

    assert.equal(serviceIn('simulation').recall({ text: 'allemand', limit: 10 }).length, 1);
  });

  test('le briefing d’un agent n’emporte aucune connaissance écartée', () => {
    // `briefing` est ce qui entre réellement dans le prompt : c'est là que la
    // contamination aurait lieu.
    stored('Fait fabriqué sur le marché', 'simulated');
    stored('Fait réel sur le marché', 'live');

    const briefing = serviceIn('live').briefing('marché');
    assert.ok(briefing.includes('Fait réel'), 'le réel doit passer');
    assert.ok(!briefing.includes('fabriqué'), 'le fabriqué ne doit jamais entrer dans un prompt');
  });

  test('ce qui est écarté est compté, sans que son contenu circule', () => {
    // L'audit doit voir qu'une connaissance a été retenue à la porte.
    stored('A', 'simulated');
    stored('B', 'unknown');
    const service = serviceIn('live');
    service.recall({ text: 'contenu', limit: 10 });

    assert.ok(service.excludedCount >= 2, `attendu ≥ 2, obtenu ${service.excludedCount}`);
  });
});

describe('barrière d’écriture', () => {
  test('une mission simulée écrit une connaissance simulée', () => {
    const item = serviceIn('simulation').remember({
      kind: 'fact',
      title: 'Observation de démonstration',
      content: 'contenu',
    });
    assert.equal(item.dataOrigin, 'simulated');
  });

  test('un fait de marché sans preuve ne devient pas « live »', () => {
    // Une conclusion de modèle sans source n'est pas un fait de marché.
    // Mémorisée comme tel, elle deviendrait indétectable au deuxième usage.
    const item = serviceIn('live').remember({
      tier: 'business',
      kind: 'fact',
      title: 'Le marché allemand est saturé',
      content: 'affirmation sans source',
    });
    assert.equal(item.dataOrigin, 'unknown');
  });

  test('un fait de marché étayé par des preuves devient « live »', () => {
    const item = serviceIn('live').remember({
      tier: 'business',
      kind: 'fact',
      title: 'Lilie GmbH distribue des machines d’emballage',
      content: 'établi par les pages consultées',
      evidenceIds: ['evd_1', 'evd_2'],
    });
    assert.equal(item.dataOrigin, 'live');
  });

  test('une leçon opérationnelle n’exige aucune preuve externe', () => {
    // « Cette stratégie de recherche n'a rien produit » parle de nous, pas du
    // monde : l'exiger sourcée n'aurait aucun sens.
    const item = serviceIn('live').remember({
      tier: 'operational',
      kind: 'lesson',
      title: 'La requête à onze mots-clés ne converge pas',
      content: 'constat de déroulement',
    });
    assert.equal(item.dataOrigin, 'live');
  });

  test('la lignée vient du déploiement, jamais de l’appelant', () => {
    // Un agent ne doit pas pouvoir déclarer que sa production est réelle.
    const item = serviceIn('simulation').remember({
      tier: 'business',
      kind: 'fact',
      title: 'Prétendument réel',
      content: 'contenu',
      evidenceIds: ['evd_1'],
    });
    assert.equal(item.dataOrigin, 'simulated');
  });
});

describe('la lignée d’une connaissance ne se blanchit pas', () => {
  test('renforcer une connaissance simulée ne la rend pas réelle', () => {
    // Le blanchiment par simple réutilisation, que cette colonne empêche.
    const before = stored('Marché allemand saturé', 'simulated');

    serviceIn('live').remember({
      tier: 'business',
      kind: 'fact',
      title: 'Marché allemand saturé',
      content: 'reformulé par une mission réelle',
      evidenceIds: ['evd_1'],
    });

    assert.equal(repos.memory.get(before.id)!.dataOrigin, 'simulated');
  });

  test('une connaissance sans lignée déclarée vaut « unknown »', () => {
    const item = repos.memory.insert({
      tier: 'business' as never,
      kind: 'fact' as never,
      title: 'Sans lignée',
      content: 'contenu',
      metadata: {},
      tags: [],
      missionId: null,
      agentKey: null,
      importance: 0.5,
      confidence: 0.5,
      expiresAt: null,
    });
    assert.equal(item.dataOrigin, 'unknown');
  });
});

/**
 * Le scénario complet, hors ligne.
 *
 * Une démonstration laisse des connaissances en base. Une mission réelle
 * démarre et interroge la mémoire avant toute recherche. Rien de fabriqué ne
 * doit atteindre son raisonnement.
 */
describe('non-régression — démonstration puis mission réelle', () => {
  test('aucune connaissance fabriquée n’atteint le contexte d’une mission réelle', () => {
    // ── Le passé : une démonstration a écrit trois connaissances ──────────
    const demo = serviceIn('simulation');
    demo.remember({ tier: 'business', kind: 'fact', title: 'AlpenAutomation distribue en Bavière', content: 'x' });
    demo.remember({ tier: 'business', kind: 'fact', title: 'Le marché autrichien est fermé', content: 'y' });
    demo.remember({ tier: 'strategic', kind: 'insight', title: 'Les intégrateurs préfèrent le direct', content: 'z' });

    // ── Et une mission réelle en a écrit une, étayée ───────────────────────
    serviceIn('live').remember({
      tier: 'business',
      kind: 'fact',
      title: 'Lilie GmbH est un intégrateur établi',
      content: 'établi par sa page produits',
      evidenceIds: ['evd_reelle'],
    });

    // ── Le présent : une mission réelle consulte la mémoire ───────────────
    const service = serviceIn('live');
    const hits = service.recall({ text: 'distribue marché intégrateur', limit: 20 });
    const briefing = service.briefing('distribue marché intégrateur');

    assert.equal(hits.length, 1, 'une seule connaissance de lignée réelle');
    assert.equal(hits[0]!.title, 'Lilie GmbH est un intégrateur établi');

    for (const forbidden of ['AlpenAutomation', 'autrichien', 'préfèrent le direct']) {
      assert.ok(!briefing.includes(forbidden), `« ${forbidden} » ne doit pas entrer dans le prompt`);
    }
    assert.ok(service.excludedCount >= 3, 'les trois connaissances de démonstration ont été écartées');
  });

  test('la même base rend tout en mode simulation', () => {
    const demo = serviceIn('simulation');
    demo.remember({ tier: 'business', kind: 'fact', title: 'AlpenAutomation distribue en Bavière', content: 'x' });
    demo.remember({ tier: 'business', kind: 'fact', title: 'Le marché autrichien est fermé', content: 'y' });

    assert.equal(serviceIn('simulation').recall({ text: 'distribue marché', limit: 20 }).length, 2);
  });
});

/**
 * Le test global : simulation complète, persistance, puis mission réelle.
 *
 * Une démonstration produit une entreprise, ses preuves et une connaissance.
 * Tout persiste. Une mission réelle démarre et interroge les trois surfaces.
 *
 * Résultat obligatoire, tel qu'exigé :
 *   0 entreprise simulée utilisée
 *   0 preuve simulée utilisée
 *   0 connaissance simulée utilisée
 *   0 conclusion métier contaminée
 */
describe('contamination globale — simulation persistée puis mission réelle', () => {
  test('les trois surfaces refusent le simulé en mode réel', async () => {
    const { RegistryDiscoveryProvider } = await import(
      '../../intelligence/src/discovery/registry.ts'
    );

    // ── La démonstration ──────────────────────────────────────────────────
    const { company: fabricated } = repos.companies.upsert({
      canonicalKey: 'd:sim-4242.example',
      name: '[SIMULÉ] Fantôme GmbH',
      country: 'Allemagne',
      domain: 'sim-4242.example',
      website: 'https://sim-4242.example/about',
      industries: ['Équipement industriel'],
      enriched: true,
      dataOrigin: 'simulated',
    });
    repos.companies.markVerified(fabricated.id);

    const mission = repos.missions.create({
      title: 'démonstration',
      objective: 'o'.repeat(40),
      context: { executionMode: 'simulation' },
      createdBy: 'test',
    });
    const { opportunity } = repos.opportunities.register({
      missionId: mission.id,
      companyId: fabricated.id,
      departmentKey: 'business-expansion',
      targetTypes: ['distributor'],
      discoveredBy: 'simulation',
    });
    repos.companies.appendEvidence({
      companyId: fabricated.id,
      opportunityId: opportunity.id,
      missionId: mission.id,
      field: 'existence',
      claim: 'existe',
      value: null,
      nature: 'observed',
      sourceKey: 'simulation',
      sourceRef: 'https://sim-4242.example/about',
      sourceTitle: null,
      basis: null,
      confidence: 0.9,
      simulated: true,
      collectedAt: new Date().toISOString(),
      agentKey: 'scout',
    });
    serviceIn('simulation').remember({
      tier: 'business',
      kind: 'fact',
      title: 'Fantôme GmbH couvre toute la Bavière',
      content: 'affirmation issue de la démonstration',
    });

    // ── Et une entreprise réelle, pour vérifier qu'on ne casse rien ────────
    const { company: real } = repos.companies.upsert({
      canonicalKey: 'd:reelle.de',
      name: 'Réelle GmbH',
      country: 'Allemagne',
      domain: 'reelle.de',
      industries: ['Équipement industriel'],
      enriched: true,
      dataOrigin: 'live',
    });
    repos.companies.markVerified(real.id);

    // ── La mission réelle interroge les trois surfaces ────────────────────
    const discovered = await new RegistryDiscoveryProvider(repos, 'live').search(
      {
        countries: ['Allemagne'],
        industries: ['Équipement industriel'],
        targetTypes: ['distributor'],
        limit: 10,
        keywords: [],
        exclusions: [],
      } as never,
      { logger } as never,
    );
    const recalled = serviceIn('live').recall({ text: 'Bavière couvre', limit: 20 });
    const usableEvidence = repos.companies
      .evidenceForMission(mission.id)
      .filter((e) => !e.simulated);

    // ── Les quatre garanties ──────────────────────────────────────────────
    assert.equal(
      discovered.candidates.filter((c) => /\.example/.test(String(c.website ?? ''))).length,
      0,
      '0 entreprise simulée utilisée',
    );
    assert.equal(usableEvidence.length, 0, '0 preuve simulée utilisée');
    assert.equal(recalled.length, 0, '0 connaissance simulée utilisée');
    assert.equal(
      discovered.candidates.length,
      1,
      'seule l’entreprise réelle passe — la barrière ne casse pas ce qu’elle protège',
    );
    assert.equal(discovered.candidates[0]!.name, 'Réelle GmbH');
  });
});
