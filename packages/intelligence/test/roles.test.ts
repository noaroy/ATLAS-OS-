import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestSystem, type TestSystem } from '@atlas/testing';
import { BUSINESS_EXPANSION } from '@atlas/departments';
import { explainScore, scoreOpportunity, toCsv, toPrintableHtml } from '@atlas/intelligence';

/**
 * Plusieurs rôles pour une même entreprise.
 *
 * Une organisation peut réellement être à la fois distributeur et intégrateur.
 * Deux propriétés doivent tenir : elle reste **une** opportunité, et le système
 * sait dire *quelle relation* proposer — ce qui est la décision commerciale,
 * distincte du classement.
 */

let system: TestSystem | null = null;

afterEach(() => {
  system?.cleanup();
  system = null;
});

const MODEL = BUSINESS_EXPANSION.scoringModel;
const ROLES = ['distributor', 'integrator'];

/** Une mission de département cherchant deux rôles à la fois. */
function twoRoleMission(candidates: Array<{ name: string; website: string; roles?: string[] }>) {
  const sys = createTestSystem({ handler: async () => ({ kind: 'text', text: 'ok' }) });
  const mission = sys.repos.missions.create({
    title: 'Deux rôles',
    objective: 'Distributeurs ou intégrateurs en Allemagne.',
    createdBy: 'test',
    departmentKey: 'business-expansion',
  });
  const outcome = sys.intelligence.discover({
    missionId: mission.id,
    departmentKey: 'business-expansion',
    targetTypes: ROLES,
    agentKey: 'explorer',
    candidates,
  });
  return { sys, mission, outcome };
}

describe('une entreprise, plusieurs rôles', () => {
  test('deux rôles ne produisent pas deux opportunités', () => {
    const { sys, mission, outcome } = twoRoleMission([
      { name: 'Doppelrolle GmbH', website: 'https://doppelrolle.de', roles: ROLES },
    ]);
    system = sys;

    assert.equal(outcome.registered.length, 1);
    assert.equal(
      sys.repos.opportunities.funnelFor(mission.id).discovered,
      1,
      'dupliquer la fiche fausserait l’entonnoir et la shortlist',
    );

    const opportunity = sys.repos.opportunities.require(outcome.registered[0]!.opportunityId);
    assert.deepEqual(opportunity.targetTypes, ROLES);
  });

  test('un provider qui ne se prononce pas laisse tous les rôles ouverts', () => {
    const { sys, outcome } = twoRoleMission([{ name: 'Sans Rôle', website: 'https://sansrole.de' }]);
    system = sys;

    assert.deepEqual(
      sys.repos.opportunities.require(outcome.registered[0]!.opportunityId).targetTypes,
      ROLES,
      'la découverte ne tranche pas ce qu’elle ne sait pas — la qualification le fera',
    );
  });

  test('la qualification restreint les rôles après vérification', () => {
    const { sys, outcome } = twoRoleMission([
      { name: 'Nur Vertrieb', website: 'https://nurvertrieb.de', roles: ROLES },
    ]);
    system = sys;
    const opportunityId = outcome.registered[0]!.opportunityId;

    sys.intelligence.qualify({
      opportunityId,
      agentKey: 'ambassador',
      verdict: 'uncertain',
      checks: [
        { criterion: 'Intégration de lignes', passed: false, detail: 'Aucune référence.', evidenceIds: [] },
      ],
      rationale: "Distribue, mais n'intègre pas.",
      confidence: 0.7,
      targetTypes: ['distributor'],
    });

    assert.deepEqual(sys.repos.opportunities.require(opportunityId).targetTypes, ['distributor']);
  });

  test('un rôle en double est enregistré une seule fois', () => {
    const { sys, outcome } = twoRoleMission([
      {
        name: 'Répétition GmbH',
        website: 'https://repetition.de',
        roles: ['distributor', 'distributor', 'integrator'],
      },
    ]);
    system = sys;

    const opportunityId = outcome.registered[0]!.opportunityId;
    sys.repos.opportunities.setTargetTypes(opportunityId, ['distributor', 'distributor']);
    assert.deepEqual(sys.repos.opportunities.require(opportunityId).targetTypes, ['distributor']);
  });
});

describe('la compatibilité par rôle', () => {
  test('le score explique chaque rôle retenu', () => {
    const { sys, outcome } = twoRoleMission([
      { name: 'Doppel AG', website: 'https://doppel.de', roles: ROLES },
    ]);
    system = sys;

    const { score } = sys.intelligence.score({
      opportunityId: outcome.registered[0]!.opportunityId,
      agentKey: 'analyst',
      model: MODEL,
      assessments: [{ dimension: 'sector-fit', value: 80, rationale: 'Bonne base installée.' }],
      roleFits: [
        { role: 'distributor', value: 85, rationale: 'Distribue déjà des lignes comparables.', confidence: 0.8 },
        { role: 'integrator', value: 40, rationale: "Peu de références d'intégration.", confidence: 0.5 },
      ],
    });

    assert.equal(score.roleFits.length, 2);
    const distributor = score.roleFits.find((f) => f.role === 'distributor')!;
    assert.equal(distributor.label, 'Distributeur', 'le libellé vient du catalogue du département');
    assert.equal(distributor.value, 85);
  });

  test('les rôles n’entrent pas dans le total', () => {
    const base = {
      model: MODEL,
      assessments: [{ dimension: 'sector-fit', value: 80, rationale: 'Bonne base.' }],
      evidence: [],
      sources: new Map(),
      scoredBy: 'analyst',
      scoredAt: new Date().toISOString(),
    };

    const withRoles = scoreOpportunity({
      ...base,
      roles: ROLES,
      targetTypes: BUSINESS_EXPANSION.targetTypes,
      roleFits: [
        { role: 'distributor', value: 95, rationale: 'Excellent.' },
        { role: 'integrator', value: 95, rationale: 'Excellent.' },
      ],
    });
    const withoutRoles = scoreOpportunity(base);

    // Sans quoi porter deux rôles vaudrait mécaniquement mieux qu'en tenir un
    // seul superbement, et le classement cesserait d'être comparable.
    assert.equal(withRoles.total, withoutRoles.total);
  });

  test('un rôle retenu mais jamais évalué est montré NON ÉVALUÉ, pas à zéro', () => {
    const score = scoreOpportunity({
      model: MODEL,
      assessments: [{ dimension: 'sector-fit', value: 70, rationale: 'a' }],
      evidence: [],
      sources: new Map(),
      scoredBy: 'analyst',
      scoredAt: new Date().toISOString(),
      roles: ROLES,
      targetTypes: BUSINESS_EXPANSION.targetTypes,
      roleFits: [{ role: 'distributor', value: 80, rationale: 'Évalué.' }],
    });

    // Ce test exigeait `0`. La revue humaine du premier rapport client a montré
    // pourquoi c'était faux : « Distributeur 0/100, Intégrateur 0/100 » se lit
    // comme deux mesures défavorables, et le classement en tirait un conseil —
    // « À approcher d'abord comme Distributeur » — fondé sur l'ordre du tableau
    // plutôt que sur une évaluation.
    //
    // L'intention d'origine tient : le rôle reste montré, il n'est pas tu. Seule
    // la valeur change, de `0` à `null`, parce qu'une absence de mesure n'est
    // pas une mauvaise note.
    const integrator = score.roleFits.find((f) => f.role === 'integrator')!;
    assert.equal(integrator.value, null);
    assert.equal(integrator.confidence, 0);
    assert.match(integrator.rationale, /pas été évalué/);

    // Et il figure bien dans la liste : ne pas l'évaluer ne le fait pas
    // disparaître du dossier.
    assert.ok(score.roleFits.some((f) => f.role === 'integrator'));
  });

  test('la justification nomme le rôle à privilégier', () => {
    const score = scoreOpportunity({
      model: MODEL,
      assessments: [{ dimension: 'sector-fit', value: 90, rationale: 'Forte adéquation.' }],
      evidence: [],
      sources: new Map(),
      scoredBy: 'analyst',
      scoredAt: new Date().toISOString(),
      roles: ROLES,
      targetTypes: BUSINESS_EXPANSION.targetTypes,
      roleFits: [
        { role: 'distributor', value: 88, rationale: 'Réseau commercial en place.' },
        { role: 'integrator', value: 35, rationale: "Pas d'équipe d'ingénierie." },
      ],
    });

    const text = explainScore(score, { companyName: 'Doppel AG' });
    assert.match(text, /Rôles pertinents/);
    assert.match(text, /Distributeur 88\/100/);
    assert.match(text, /approcher.{0,10}abord comme Distributeur/);
  });

  test('un seul rôle donne une phrase au singulier', () => {
    const score = scoreOpportunity({
      model: MODEL,
      assessments: [{ dimension: 'sector-fit', value: 70, rationale: 'a' }],
      evidence: [],
      sources: new Map(),
      scoredBy: 'analyst',
      scoredAt: new Date().toISOString(),
      roles: ['integrator'],
      targetTypes: BUSINESS_EXPANSION.targetTypes,
      roleFits: [{ role: 'integrator', value: 66, rationale: 'Intègre des lignes complètes.' }],
    });

    assert.match(explainScore(score, { companyName: 'X' }), /Rôle pertinent : Intégrateur/);
  });
});

describe('les rôles dans les exports', () => {
  const detail = (targetTypes: string[], roleFits: Array<{ role: string; label: string; value: number }>) =>
    ({
      opportunity: {
        id: 'opp_1',
        missionId: 'msn_1',
        departmentKey: 'business-expansion',
        companyId: 'cmp_1',
        targetTypes,
        stage: 'approved',
        score: 71.4,
        scoreDetail: {
          total: 71.4,
          components: [],
          confidence: 0.72,
          roleFits: roleFits.map((f) => ({ ...f, rationale: 'Motif.', confidence: 0.8, evidenceIds: [] })),
          modelVersion: 'v1',
          scoredBy: 'analyst',
          scoredAt: new Date().toISOString(),
        },
        qualification: null,
        rank: 1,
        justification: 'Classé n°1.',
        reusedKnowledge: false,
        review: {
          decision: 'approved' as const,
          note: null,
          reviewedBy: 'fondateur@example.com',
          reviewedAt: new Date().toISOString(),
        },
        discoveredBy: 'explorer',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      company: {
        id: 'cmp_1',
        canonicalKey: 'd:doppel.de',
        name: 'Doppel AG',
        legalName: null,
        country: 'Allemagne',
        region: null,
        city: 'Hambourg',
        website: 'https://doppel.de',
        domain: 'doppel.de',
        industries: [],
        sizeBand: 'medium' as const,
        employeesEstimate: null,
        foundedYear: null,
        description: null,
        profile: {},
        enriched: true,
        firstSeenAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      evidence: [],
      contacts: [],
      relations: [],
    }) as never;

  const input = (targetTypes: string[], roleFits: Array<{ role: string; label: string; value: number }>) =>
    ({
      mission: {
        id: 'msn_1',
        code: 'M-TEST',
        title: 'Distributeurs et intégrateurs',
        objective: 'Trouver des partenaires en Allemagne.',
      },
      department: null,
      opportunities: [detail(targetTypes, roleFits)],
      economics: null,
      simulated: false,
      generatedAt: new Date().toISOString(),
    }) as never;

  test('le CSV porte les rôles et leur compatibilité', () => {
    const file = toCsv(
      input(ROLES, [
        { role: 'distributor', label: 'Distributeur', value: 85 },
        { role: 'integrator', label: 'Intégrateur', value: 40 },
      ]),
    );

    const [header, row] = file.content.replace('﻿', '').split('\r\n');
    assert.ok(header!.includes('Rôles pertinents'));
    assert.ok(header!.includes('Compatibilité par rôle'));
    assert.ok(row!.includes('distributor + integrator'));
    assert.ok(row!.includes('Distributeur 85/100'));
    assert.ok(row!.includes('Intégrateur 40/100'));
  });

  test('le rapport imprimable détaille chaque rôle', () => {
    const file = toPrintableHtml(
      input(ROLES, [
        { role: 'distributor', label: 'Distributeur', value: 85 },
        { role: 'integrator', label: 'Intégrateur', value: 40 },
      ]),
    );

    assert.match(file.content, /Rôles pertinents/);
    assert.match(file.content, /Distributeur/);
    assert.match(file.content, /Intégrateur/);
    // Le rôle le mieux noté vient en premier : c'est la relation à ouvrir.
    assert.ok(file.content.indexOf('Distributeur') < file.content.indexOf('Intégrateur'));
  });

  test('un candidat sans compatibilité évaluée reste lisible', () => {
    const file = toPrintableHtml(input(['distributor'], []));
    assert.match(file.content, /compatibilité non évaluée séparément/);
  });
});
