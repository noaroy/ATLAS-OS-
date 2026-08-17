import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger, EventBus } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';
import { MemoryService } from '@atlas/memory';
import { OpportunityService, icpRejection, normaliseCountry } from '../src/opportunities.ts';

/**
 * Le profil recherché est une contrainte, pas une préférence.
 *
 * REVENUE-001 a retenu DIVUS GmbH, à Eppan (Südtirol, **Italie**), pour une
 * mission dont l'objectif disait « allemands ». L'agent l'avait vu, et l'a
 * écrit dans la preuve : « basée en Italie (Südtirol), pas en Allemagne.
 * Retenue malgré tout car elle opère en Europe ».
 *
 * Le comportement est honnête, la décision est fausse — et surtout, elle
 * n'était pas la sienne à prendre. Une contrainte formulée en prose dans un
 * objectif est une préférence : le modèle la pèse contre d'autres
 * considérations et peut conclure qu'elle cède. Une contrainte structurée ne
 * se pèse pas, elle s'applique.
 */

describe('la normalisation des pays', () => {
  test('les graphies d’un même pays se rejoignent', () => {
    // Les sources écrivent « Germany », « Deutschland », « DE », « Allemagne ».
    // Une comparaison littérale rejetterait des candidats corrects — le filtre
    // serait alors plus nuisible que le défaut qu'il corrige.
    for (const written of ['Germany', 'Deutschland', 'DE', 'Allemagne', 'deu']) {
      assert.equal(normaliseCountry(written), 'de', `« ${written} » doit valoir « de »`);
    }
  });

  test('l’Italie ne devient pas l’Allemagne', () => {
    for (const written of ['Italy', 'Italia', 'Italie', 'IT']) {
      assert.equal(normaliseCountry(written), 'it');
    }
  });

  test('un pays absent reste absent', () => {
    assert.equal(normaliseCountry(null), null);
    assert.equal(normaliseCountry('  '), null);
  });
});

describe('le rejet déterministe hors profil', () => {
  const de = { countries: ['Germany'] };

  test('le cas exact de REVENUE-001', () => {
    const reason = icpRejection({ name: 'DIVUS GmbH', country: 'Italy' }, de);
    assert.ok(reason, 'un candidat italien doit être rejeté d’une mission allemande');
    assert.match(reason, /ne se négocie pas/);
  });

  test('un candidat dans le profil passe', () => {
    assert.equal(icpRejection({ name: 'Lilie GmbH', country: 'Deutschland' }, de), null);
  });

  test('un pays inconnu passe : l’absence n’est pas une contradiction', () => {
    // Rejeter sur une information manquante écarterait des candidats corrects
    // mal documentés. La qualification est l'étape faite pour trancher cela.
    assert.equal(icpRejection({ name: 'Sans pays GmbH', country: null }, de), null);
  });

  test('sans contrainte déclarée, rien n’est rejeté', () => {
    assert.equal(icpRejection({ name: 'DIVUS GmbH', country: 'Italy' }, undefined), null);
    assert.equal(icpRejection({ name: 'DIVUS GmbH', country: 'Italy' }, { countries: [] }), null);
  });
});

// ── Le filtre dans le pipeline, avant toute écriture ───────────────────────

const logger = createLogger({ level: 'error', pretty: false });
let repos: Repositories;
let service: OpportunityService;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-icp-'));
  repos = createRepositories(join(dir, 'c.db'), logger);
  // Une base nue n'a pas de départements, et `opportunities.department_key`
  // les référence. Le minimum syndical suffit : ces tests portent sur le
  // filtre, pas sur la définition du département.
  repos.departments.upsert({
    key: 'business-expansion',
    name: 'Expansion',
    tagline: '',
    mission: 'Trouver des partenaires.',
    building: 'expansion',
    targetTypes: [],
    briefSchema: {},
    playbook: [],
    scoringModel: { dimensions: [], version: 'test' },
    teams: [],
    kpis: [],
    triggers: [],
    enabled: true,
  } as never);

  const events = new EventBus(logger);
  service = new OpportunityService({
    repos,
    memory: new MemoryService(repos.memory, events, logger, 'live'),
    events,
    logger,
    simulated: false,
  });
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const mission = () =>
  repos.missions.create({
    title: 'Prospection',
    objective: 'Trouver des distributeurs allemands de machines d’emballage.',
    context: {},
    createdBy: 'test',
    departmentKey: 'business-expansion',
  });

describe('le filtre agit avant la dépense', () => {
  test('un candidat hors profil n’est jamais enregistré', () => {
    const m = mission();
    const outcome = service.discover({
      missionId: m.id,
      departmentKey: 'business-expansion',
      targetTypes: ['distributor'],
      agentKey: 'explorer',
      icp: { countries: ['Germany'] },
      candidates: [
        { name: 'Lilie GmbH', website: 'https://lilie.de', country: 'Germany' },
        { name: 'DIVUS GmbH', website: 'https://divus.eu', country: 'Italy' },
      ],
    });

    assert.equal(outcome.registered.length, 1);
    assert.equal(outcome.registered[0]!.name, 'Lilie GmbH');
    assert.equal(outcome.rejected.length, 1);
    assert.match(outcome.rejected[0]!.reason, /hors profil recherché/);

    // Rien d'écrit : un candidat rejeté après enrichissement aurait déjà coûté
    // ce qu'on voulait éviter.
    assert.equal(repos.companies.getByCanonicalKey('d:divus.eu'), null);
  });

  test('aucune formulation ne renverse le rejet', () => {
    // C'est le cœur de la correction : « retenue malgré tout car elle opère en
    // Europe » est un raisonnement, et le filtre n'en lit aucun.
    const m = mission();
    const outcome = service.discover({
      missionId: m.id,
      departmentKey: 'business-expansion',
      targetTypes: ['distributor'],
      agentKey: 'explorer',
      icp: { countries: ['Germany'] },
      candidates: [
        {
          name: 'DIVUS GmbH',
          website: 'https://divus.eu',
          country: 'Italy',
          rationale:
            'Basée en Italie (Südtirol), pas en Allemagne. Retenue malgré tout car elle ' +
            'opère en Europe germanophone et correspond parfaitement au profil.',
          confidence: 0.95,
        },
      ],
    });

    assert.equal(outcome.registered.length, 0);
    assert.equal(outcome.rejected.length, 1);
  });

  test('sans profil déclaré, le pipeline existant ne change pas', () => {
    const m = mission();
    const outcome = service.discover({
      missionId: m.id,
      departmentKey: 'business-expansion',
      targetTypes: ['distributor'],
      agentKey: 'explorer',
      candidates: [
        { name: 'Lilie GmbH', website: 'https://lilie.de', country: 'Germany' },
        { name: 'DIVUS GmbH', website: 'https://divus.eu', country: 'Italy' },
      ],
    });

    assert.equal(outcome.registered.length, 2);
    assert.equal(outcome.rejected.length, 0);
  });

  test('un rejet de profil n’est pas compté comme un doublon', () => {
    // Un doublon est la même entreprise vue deux fois ; un rejet de profil est
    // une entreprise qu'on ne veut pas. Les confondre masquerait la mesure.
    const m = mission();
    const outcome = service.discover({
      missionId: m.id,
      departmentKey: 'business-expansion',
      targetTypes: ['distributor'],
      agentKey: 'explorer',
      icp: { countries: ['Germany'] },
      candidates: [
        { name: 'Lilie GmbH', website: 'https://lilie.de', country: 'Germany' },
        { name: 'DIVUS GmbH', website: 'https://divus.eu', country: 'Italy' },
      ],
    });
    assert.equal(outcome.duplicates.length, 0);
  });
});
