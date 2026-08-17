import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../core/src/logger.ts';
import { createRepositories, type Repositories } from '../src/index.ts';

/**
 * Le journal des décisions d'Hermès.
 *
 * Ce qu'il protège : la frontière entre décider et affirmer. Hermès a le droit
 * de trancher sur la stratégie, l'ordre, l'allocation et l'arrêt ; il n'a pas le
 * droit d'affirmer qu'une entreprise existe. La distinction n'est pas une
 * convention d'écriture — elle est encodée dans les catégories de décision, et
 * `unsupportedClaims` la rend vérifiable après coup.
 */

const logger = createLogger({ level: 'error', pretty: false });
let dir: string;
let repos: Repositories;
let missionId: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-decisions-'));
  repos = createRepositories(join(dir, 'decisions.db'), logger);
  missionId = repos.missions.create({
    title: 'Test',
    objective: 'o'.repeat(30),
    createdBy: 'test',
  }).id;
});

after(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('journal des décisions', () => {
  test('une décision consigne ce qui a été décidé et pourquoi', () => {
    const decision = repos.decisions.record({
      missionId,
      taskRef: 'discovery',
      kind: 'stop-branch',
      decision: 'Étape enrichment non lancée.',
      rationale: "Aucun candidat n'a été découvert : il n'y a rien à documenter.",
      impact: 'Aucun appel de modèle engagé.',
    });

    assert.ok(decision.id.startsWith('dec'));
    assert.equal(decision.kind, 'stop-branch');
    assert.ok(decision.rationale.length > 0, 'une décision sans raison n’est pas auditable');
    assert.deepEqual(decision.evidenceIds, []);
    assert.ok(decision.createdAt);
  });

  test('les décisions se lisent dans l’ordre où elles ont été prises', () => {
    const fresh = repos.missions.create({ title: 'T2', objective: 'x'.repeat(30), createdBy: 'test' }).id;
    for (const kind of ['plan', 'allocation', 'stop-branch', 'conclude'] as const) {
      repos.decisions.record({ missionId: fresh, kind, decision: kind, rationale: 'r' });
    }

    const journal = repos.decisions.forMission(fresh);
    assert.deepEqual(
      journal.map((d) => d.kind),
      ['plan', 'allocation', 'stop-branch', 'conclude'],
    );
  });

  test('une conclusion sans preuve est signalée', () => {
    // La vérification qui compte : une décision qui porte sur le monde doit
    // citer ses sources. Une conclusion sans preuve n'est pas interdite — elle
    // est visible, ce qui suffit pour qu'on la regarde.
    const fresh = repos.missions.create({ title: 'T3', objective: 'y'.repeat(30), createdBy: 'test' }).id;
    repos.decisions.record({
      missionId: fresh,
      kind: 'conclude',
      decision: 'Trois partenaires recommandés.',
      rationale: 'Synthèse des étapes.',
    });

    const unsupported = repos.decisions.unsupportedClaims(fresh);
    assert.equal(unsupported.length, 1);
    assert.equal(unsupported[0]!.kind, 'conclude');
  });

  test('une conclusion étayée ne l’est pas', () => {
    const fresh = repos.missions.create({ title: 'T4', objective: 'z'.repeat(30), createdBy: 'test' }).id;
    repos.decisions.record({
      missionId: fresh,
      kind: 'conclude',
      decision: 'Trois partenaires recommandés.',
      rationale: '4 preuves sourcées soutiennent cette synthèse.',
      evidenceIds: ['ev_1', 'ev_2', 'ev_3', 'ev_4'],
    });

    assert.equal(repos.decisions.unsupportedClaims(fresh).length, 0);
    assert.equal(repos.decisions.forMission(fresh)[0]!.evidenceIds.length, 4);
  });

  test('une décision d’organisation n’a pas besoin de preuve', () => {
    // Choisir un ordre d'étapes ne s'appuie sur aucun fait du monde. Exiger une
    // preuve ici rendrait le contrôle inutilisable, donc ignoré.
    const fresh = repos.missions.create({ title: 'T5', objective: 'w'.repeat(30), createdBy: 'test' }).id;
    for (const kind of ['plan', 'allocation', 'continue', 'stop-branch', 'replan', 'budget'] as const) {
      repos.decisions.record({ missionId: fresh, kind, decision: kind, rationale: 'r' });
    }
    assert.equal(repos.decisions.unsupportedClaims(fresh).length, 0);
  });

  test('un journal corrompu se lit quand même', () => {
    // Une colonne illisible ne doit pas empêcher de consulter le reste : le
    // journal sert précisément quand quelque chose a mal tourné.
    const fresh = repos.missions.create({ title: 'T6', objective: 'v'.repeat(30), createdBy: 'test' }).id;
    const decision = repos.decisions.record({
      missionId: fresh,
      kind: 'conclude',
      decision: 'd',
      rationale: 'r',
      evidenceIds: ['ev_1'],
    });
    repos.db.prepare('UPDATE mission_decisions SET evidence_ids = ? WHERE id = ?').run('{pas du json', decision.id);

    const journal = repos.decisions.forMission(fresh);
    assert.equal(journal.length, 1);
    assert.deepEqual(journal[0]!.evidenceIds, []);
  });

  test('les décisions disparaissent avec leur mission', () => {
    const fresh = repos.missions.create({ title: 'T7', objective: 'u'.repeat(30), createdBy: 'test' }).id;
    repos.decisions.record({ missionId: fresh, kind: 'plan', decision: 'd', rationale: 'r' });
    repos.db.prepare('DELETE FROM missions WHERE id = ?').run(fresh);
    assert.equal(repos.decisions.forMission(fresh).length, 0);
  });
});
