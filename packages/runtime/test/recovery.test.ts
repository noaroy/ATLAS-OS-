import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';
import { recoverInterruptedMissions, formatRecovery } from '../src/recovery.ts';

/**
 * Ce qui se passe au redémarrage après un arrêt brutal.
 *
 * Le comportement à protéger n'est pas « la mission repart », c'est « la
 * mission ne repart pas ». Une reprise automatique dépense de l'argent que
 * personne ne surveille, et le scénario qui déclenche cette fonction est
 * exactement celui où l'exploitant n'était pas devant l'écran.
 */

let repos: Repositories;
let dir: string;
const logger = createLogger({ level: 'error', pretty: false });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-recovery-'));
  repos = createRepositories(join(dir, 'recovery.db'), logger);
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Une mission qu'un arrêt brutal a laissée en plein travail. */
function strandedMission(): string {
  const mission = repos.missions.create({
    title: 'Mission interrompue',
    objective: 'prospection',
    context: { executionMode: 'live', budgetUsd: 0.4 },
    createdBy: 'system',
  });
  repos.missions.transition(mission.id, 'planned');
  repos.missions.transition(mission.id, 'running');
  return mission.id;
}

describe('reprise après arrêt brutal', () => {
  test('une mission laissée en cours repasse en pause', () => {
    const id = strandedMission();

    const report = recoverInterruptedMissions(repos, logger);

    assert.equal(report.missions.length, 1);
    assert.equal(repos.missions.require(id).status, 'paused');
  });

  test("elle n'est pas marquée en échec", () => {
    // Une interruption n'est pas une panne. Les compter ensemble fausserait le
    // taux de réussite dont l'évolution se sert pour décider quoi corriger.
    const id = strandedMission();
    recoverInterruptedMissions(repos, logger);

    const mission = repos.missions.require(id);
    assert.notEqual(mission.status, 'failed');
    assert.equal(mission.error, null, "le champ d'erreur doit rester vide");
  });

  test('rien ne repart tout seul', () => {
    // Le test qui compte. Après reprise, aucune mission ne doit être dans un
    // état d'où le superviseur la ferait avancer.
    strandedMission();
    recoverInterruptedMissions(repos, logger);

    const active = repos.missions.listByStatus('running', 'assigned');
    assert.equal(active.length, 0, 'aucune mission ne doit rester active après reprise');
  });

  test("l'interruption est tracée dans le contexte, pas seulement dans un journal", () => {
    const id = strandedMission();
    recoverInterruptedMissions(repos, logger);

    const context = repos.missions.require(id).context;
    assert.equal(context.resumeRequiresHuman, true);
    assert.equal(context.interruptedFrom, 'running');
    assert.ok(typeof context.interruptedAt === 'string');
    // Le contexte d'origine survit : le plafond ne doit pas disparaître dans
    // l'opération, sinon la reprise se ferait sans budget déclaré.
    assert.equal(context.budgetUsd, 0.4);
  });

  test('une dépense inconnue reste inconnue', () => {
    // La mission n'a émis aucun appel : le rapport ne doit pas rendre 0,00 $
    // comme s'il l'avait mesuré.
    strandedMission();
    const report = recoverInterruptedMissions(repos, logger);

    assert.equal(report.missions[0]?.spentUsd, null);
  });

  test('un arrêt propre ne déclenche rien', () => {
    const mission = repos.missions.create({
      title: 'Mission terminée',
      objective: 'x',
      createdBy: 'system',
    });
    repos.missions.transition(mission.id, 'planned');
    repos.missions.transition(mission.id, 'running');
    repos.missions.transition(mission.id, 'completed');

    const report = recoverInterruptedMissions(repos, logger);

    assert.equal(report.missions.length, 0);
    assert.equal(report.needsAttention, false);
    assert.match(formatRecovery(report), /Aucune mission interrompue/);
  });

  test('une mission assignée est reprise elle aussi', () => {
    // `assigned` est le second état d'où rien ne repartira : les étapes sont
    // distribuées, aucune boucle ne les réclamera après un redémarrage.
    const mission = repos.missions.create({
      title: 'Mission assignée',
      objective: 'x',
      createdBy: 'system',
    });
    repos.missions.transition(mission.id, 'planned');
    repos.missions.transition(mission.id, 'assigned');

    const report = recoverInterruptedMissions(repos, logger);

    assert.equal(report.missions.length, 1);
    assert.equal(report.missions[0]?.wasStatus, 'assigned');
    assert.equal(repos.missions.require(mission.id).status, 'paused');
  });

  test('la reprise est idempotente', () => {
    // Deux redémarrages rapprochés ne doivent pas produire deux traitements ni
    // lever sur une transition devenue impossible.
    strandedMission();
    recoverInterruptedMissions(repos, logger);
    const second = recoverInterruptedMissions(repos, logger);

    assert.equal(second.missions.length, 0);
  });

  test('le rapport dit explicitement que la reprise est manuelle', () => {
    strandedMission();
    const text = formatRecovery(recoverInterruptedMissions(repos, logger));

    assert.match(text, /remises en pause/);
    assert.match(text, /reprendra seule|décision/);
  });
});
