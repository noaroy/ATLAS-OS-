import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger, canActAlone, shouldInterrupt, AUTONOMY_LEVELS } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';
import { collectNeedsYou, todaySnapshot, pipelineSnapshot } from '../src/index.ts';

/**
 * L'écran qu'on ouvre le matin, et ce qu'il a le droit d'afficher.
 *
 * Deux propriétés le rendent utile, et elles se perdent facilement. La première
 * est qu'il ne doit rien inventer : un zéro affiché à la place d'un « je ne sais
 * pas » fait passer une absence de mesure pour une mesure. La seconde est que
 * chaque élément de la file humaine doit porter une commande — un tableau qui
 * signale un problème sans dire quoi taper fait perdre le temps qu'il prétend
 * faire gagner.
 */

const logger = createLogger({ level: 'error', pretty: false });
let repos: Repositories;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-ui-'));
  repos = createRepositories(join(dir, 'ui.db'), logger);
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('la file humaine', () => {
  test('une base vide ne réclame rien', () => {
    assert.deepEqual(collectNeedsYou({ repos }), []);
  });

  test('un brouillon en attente apparaît avec sa commande', () => {
    repos.salesLoop.saveDraft({
      domain: 'exemple.fr', companyName: 'Exemple', recipient: 'contact@exemple.fr',
      subject: 's', body: 'b', purpose: 'FIRST_TOUCH',
      sources: [{ quote: 'q', sourceUrl: 'https://exemple.fr/' }], createdBy: 'test',
    });
    const items = collectNeedsYou({ repos });
    const outreach = items.find((i) => i.kind === 'OUTREACH');
    assert.ok(outreach, 'le brouillon doit remonter');
    assert.match(outreach!.action, /sales:loop/);
  });

  test('un changement de code prêt réclame une relecture', () => {
    const task = repos.tasks.create({
      taskType: 'ENGINEERING_CHANGE', department: 'ENGINEERING',
      workerType: 'CLAUDE', payload: {},
    }).task;
    repos.tasks.openWorkspace({
      workspaceId: 'ws_1', taskId: task.taskId, baseCommit: 'abc123', path: '/tmp/ws',
    });
    repos.tasks.setWorkspaceState({
      workspaceId: 'ws_1', state: 'READY_FOR_REVIEW', filesChanged: 2, diffLines: 30,
    });

    const item = collectNeedsYou({ repos }).find((i) => i.kind === 'ENGINEERING');
    assert.ok(item);
    assert.match(item!.action, /atlas:apply -- show/);
    assert.match(item!.why, /accord/);
  });

  test('chaque élément porte les quatre champs, sans jargon', () => {
    repos.salesLoop.saveDraft({
      domain: 'exemple.fr', companyName: 'Exemple', recipient: 'c@exemple.fr',
      subject: 's', body: 'b', purpose: 'FIRST_TOUCH', sources: [], createdBy: 't',
    });
    for (const item of collectNeedsYou({ repos })) {
      assert.ok(item.what.length > 5, 'ce qui s’est passé');
      assert.ok(item.why.length > 5, 'pourquoi cela compte');
      assert.ok(item.recommendation.length > 5, 'la recommandation');
      assert.ok(item.action.length > 5, 'la commande');
      // Le vocabulaire interne n'a rien à faire sur cet écran.
      for (const jargon of ['lease', 'idempotency', 'migration', 'SELECT ', 'porcelain']) {
        assert.ok(!item.what.includes(jargon), `« ${jargon} » ne doit pas apparaître`);
        assert.ok(!item.why.includes(jargon), `« ${jargon} » ne doit pas apparaître`);
      }
    }
  });

  test('les réponses clientes passent avant le reste', () => {
    const conversation = repos.conversations.open({
      domain: 'client.fr', companyName: 'Client',
    }).conversation;
    repos.conversations.recordInboundEvent({
      conversationId: conversation.id, kind: 'EMAIL_REPLY', classification: 'REPLIED',
      confidence: 0.9, source: 'test', bodyExcerpt: 'bonjour', signals: [],
      returnDate: null, humanReviewed: false,
    });
    repos.salesLoop.saveDraft({
      domain: 'exemple.fr', companyName: 'Exemple', recipient: 'c@exemple.fr',
      subject: 's', body: 'b', purpose: 'FIRST_TOUCH', sources: [], createdBy: 't',
    });

    const items = collectNeedsYou({ repos });
    assert.equal(items[0]?.kind, 'CLIENT_REPLY', 'un client qui attend passe en premier');
  });

  test('un blocage système remonte avec sa commande', () => {
    const items = collectNeedsYou({
      repos,
      systemBlockers: [{
        what: 'la boîte Gmail n’est pas connectée',
        why: 'les réponses ne remontent pas seules',
        action: 'npm run gmail:authorize',
      }],
    });
    const system = items.find((i) => i.kind === 'SYSTEM');
    assert.ok(system);
    assert.equal(system!.action, 'npm run gmail:authorize');
  });
});

describe('les chiffres ne s’inventent pas', () => {
  test('sans appel de modèle, le coût est N/A et non zéro', () => {
    const snapshot = todaySnapshot(repos);
    assert.equal(snapshot.aiCostUsd, null, 'null se lit N/A ; zéro se lirait « gratuit »');
  });

  test('un appel au tarif inconnu est compté à part', () => {
    const task = repos.tasks.create({
      taskType: 'X', department: 'BACKGROUND', workerType: 'OPENAI', payload: {},
    }).task;
    repos.tasks.recordAiCall({
      taskId: task.taskId, provider: 'OPENAI', model: 'modele-inconnu',
      inputTokens: 100, outputTokens: 50, costUsd: null, costBasis: 'UNKNOWN_PRICE',
      outcome: 'OK',
    });
    const snapshot = todaySnapshot(repos);
    assert.equal(snapshot.aiCostUnknownCalls, 1);
    assert.equal(snapshot.aiCostUsd, 0, 'le connu vaut zéro, l’inconnu est signalé à côté');
  });

  test('les aperçus gratuits s’affichent N/A, pas zéro', () => {
    // Ils sont produits et transmis à la main : rien en base ne les compte.
    assert.ok(pipelineSnapshot(repos).preview < 0, 'négatif force l’affichage N/A');
  });

  test('l’entonnoir lit la base, il ne l’estime pas', () => {
    repos.sales.recordOutreach({
      domain: 'a.fr', kind: 'CONTACTED', recordedBy: 'test', channel: 'email',
    });
    repos.sales.recordOutreach({
      domain: 'b.fr', kind: 'DO_NOT_CONTACT', recordedBy: 'test',
    });
    const pipeline = pipelineSnapshot(repos);
    assert.equal(pipeline.contacted, 1, 'un domaine écarté n’est pas un domaine contacté');
  });
});

describe('les niveaux d’autonomie', () => {
  test('rien n’est autonome au niveau 0', () => {
    assert.equal(canActAlone(0, 'SALES_DISCOVERY').autonomous, false);
  });

  test('au niveau 1, ATLAS prépare mais n’envoie pas', () => {
    assert.equal(canActAlone(1, 'SALES_DISCOVERY').autonomous, true);
    assert.equal(canActAlone(1, 'SALES_OUTREACH').autonomous, false);
  });

  test('trois choses restent des décisions à tous les niveaux', () => {
    // Elles ont en commun d'être irréversibles pour quelqu'un d'autre que nous.
    for (const level of [0, 1, 2, 3] as const) {
      for (const action of ['PAYMENT', 'ENGINEERING_APPLY', 'CLIENT_REPLY']) {
        assert.equal(
          canActAlone(level, action).autonomous, false,
          `${action} ne doit jamais être autonome (niveau ${level})`,
        );
      }
    }
  });

  test('le niveau ne monte pas tout seul : aucune règle ne le change', () => {
    // La table est figée ; la seule façon de changer de niveau est de changer
    // la configuration, ce qui est une décision et non un effet de bord.
    assert.equal(AUTONOMY_LEVELS[1].level, 1);
    assert.equal(Object.keys(AUTONOMY_LEVELS).length, 4);
  });
});

describe('les notifications', () => {
  test('ce qui mérite d’interrompre', () => {
    for (const event of ['PROSPECT_INTERESTED', 'SALE', 'SYSTEM_DOWN', 'DECISION_REQUIRED']) {
      assert.equal(shouldInterrupt(event).notify, true, event);
    }
  });

  test('le reste appartient au tableau de bord', () => {
    for (const event of ['TASK_COMPLETED', 'AUTO_REPLY', 'PROSPECT_DISCOVERED', 'BOUNCE']) {
      assert.equal(shouldInterrupt(event).notify, false, event);
    }
  });
});
