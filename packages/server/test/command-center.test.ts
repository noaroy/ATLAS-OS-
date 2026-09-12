import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../core/src/logger.ts';
import { loadConfig } from '../../core/src/config.ts';
import { createRepositories, type Repositories } from '../../data/src/index.ts';
import type { AtlasConfig } from '../../core/src/config.ts';
import {
  buildWarRoom, buildProspecting, buildCompanies, buildCompanyDetail,
  buildApprovals, buildAgents, buildOrganization, buildAiFabric,
  buildCosts, buildInbox, buildSystemHealth, FUNNEL_ORDER,
} from '../src/http/command-center.ts';

/**
 * Le centre de commande.
 *
 * Ce qu'il protège tient en trois phrases, et chacune a été apprise en la
 * violant.
 *
 * Une valeur absente s'affiche N/A, jamais zéro : le tableau de bord a annoncé
 * « coût IA : N/A » pendant que près de sept dollars avaient réellement été
 * dépensés, parce qu'il ne lisait qu'un des deux registres.
 *
 * Aucun secret ne traverse l'API : ni clé, ni jeton, ni valeur d'environnement.
 * Un fournisseur se décrit par son état de connexion.
 *
 * Le registre global fait autorité : une entreprise contactée apparaît quoi
 * qu'il arrive, même sans conversation ouverte. Deux dossiers ont disparu de
 * l'écran pendant des jours faute de cette règle — jamais relancés, jamais
 * comptés, et signalés nulle part puisqu'ils n'apparaissaient pas.
 */

const logger = createLogger({ level: 'error', pretty: false });
let dir: string;
let repos: Repositories;
let config: AtlasConfig;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-cc-'));
  repos = createRepositories(join(dir, 'cc.db'), logger);
  config = loadConfig(process.cwd());
});

after(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Une entreprise contactée, avec ou sans conversation. */
const contacter = (domain: string, name: string, withConversation = true) => {
  const { prospect } = repos.sales.discover({
    batchId: 'TEST-001', companyName: name, domain, discoveredAt: '2026-08-01T00:00:00.000Z',
  });
  repos.sales.recordOutreach({
    domain, kind: 'CONTACTED', recordedBy: 'test', channel: 'EMAIL',
    recordedAt: '2026-08-01T00:00:00.000Z',
  });
  if (withConversation) {
    repos.conversations.open({
      domain, companyName: name, source: 'test', firstContactAt: '2026-08-01T00:00:00.000Z',
    });
  }
  return prospect;
};

describe('le registre fait autorité', () => {
  test('une entreprise sans conversation figure quand même à l’entonnoir', () => {
    contacter('avec.invalid', 'Avec conversation', true);
    contacter('sans.invalid', 'Sans conversation', false);

    const war = buildWarRoom(repos, config, '2026-08-26');
    assert.equal(war.ledgerTotal, 2);
    assert.equal(war.funnelTotal, 2, 'aucun dossier ne disparaît');
    assert.equal(war.consistent, true);
  });

  test('l’incohérence se voit au lieu de se corriger en silence', () => {
    // La propriété qui compte : le total est publié et comparé. Un écran qui
    // ajusterait son total pour qu'il retombe juste cacherait la panne.
    const war = buildWarRoom(repos, config, '2026-08-26');
    assert.equal(
      war.funnel.reduce((sum, row) => sum + row.count, 0),
      war.ledgerTotal,
    );
    assert.ok(typeof war.consistent === 'boolean');
  });

  test('l’entonnoir couvre tous les états connus, et accueille l’inattendu', () => {
    const war = buildWarRoom(repos, config, '2026-08-26');
    for (const state of FUNNEL_ORDER) {
      assert.ok(war.funnel.some((r) => r.state === state), `${state} doit avoir sa ligne`);
    }
  });

  test('les entreprises listées sont celles du registre', () => {
    const list = buildCompanies(repos, config, '2026-08-26').companies;
    assert.equal(list.length, 2);
    assert.ok(list.some((c) => c.domain === 'sans.invalid' && !c.hasConversation));
  });

  test('une entreprise inconnue rend null plutôt qu’un dossier vide', () => {
    assert.equal(buildCompanyDetail(repos, 'jamais-vue.invalid'), null);
    assert.ok(buildCompanyDetail(repos, 'avec.invalid'));
  });
});

describe('une mesure absente n’est pas une mesure nulle', () => {
  test('le taux de réponse est null quand rien n’a été contacté', () => {
    const vide = createRepositories(join(dir, 'vide.db'), logger);
    try {
      const war = buildWarRoom(vide, config, '2026-08-26');
      assert.equal(war.metrics.replyRate, null, 'null, pas 0 %');
      assert.equal(war.metrics.contacted, 0);
    } finally { vide.close(); }
  });

  test('les aperçus gratuits restent null : rien en base ne les compte', () => {
    const war = buildWarRoom(repos, config, '2026-08-26');
    assert.equal(war.metrics.freePreviews, null);
  });

  test('un coût sans appel est null, jamais zéro', () => {
    const vide = createRepositories(join(dir, 'vide2.db'), logger);
    try {
      const costs = buildCosts(vide, config);
      assert.equal(costs.windows.total.costUsd, null);
      assert.equal(costs.windows.today.costUsd, null);
      assert.equal(costs.windows.total.calls, 0);
    } finally { vide.close(); }
  });

  test('un appel au tarif inconnu est compté à part', () => {
    const scratch = createRepositories(join(dir, 'inconnu.db'), logger);
    try {
      const task = scratch.tasks.create({
        taskType: 'X', department: 'ENGINEERING', workerType: 'OPENAI', payload: {},
      }).task;
      scratch.tasks.recordAiCall({
        taskId: task.taskId, provider: 'OPENAI', model: 'modele-sans-tarif',
        inputTokens: 100, outputTokens: 50,
        costUsd: null, costBasis: 'UNKNOWN_PRICE', outcome: 'SUCCESS',
      });
      const costs = buildCosts(scratch, config);
      assert.equal(costs.unknownPriceCalls, 1);
      // Le garde-fou lit ce compteur : le masquer le désarmerait.
      assert.equal(costs.budgets.unknownCostPolicy, 'BLOCK');
    } finally { scratch.close(); }
  });

  test('les étapes du pipeline rendent null plutôt qu’un zéro rassurant', () => {
    const vide = createRepositories(join(dir, 'vide3.db'), logger);
    try {
      const loop = buildProspecting(vide, config, '2026-08-26');
      assert.equal(loop.lastCycle, null);
      assert.ok(loop.stages.some((s) => s.count === null));
    } finally { vide.close(); }
  });
});

describe('aucun secret ne traverse l’API', () => {
  const INTERDITS = [
    'sk-ant-', 'sk-proj-', 'GOCSPX-', 'refresh_token', 'client_secret',
    'ANTHROPIC_API_KEY', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN',
  ];

  test('la fabrique IA décrit un état, jamais un identifiant', () => {
    const rendu = JSON.stringify(buildAiFabric(repos, config));
    for (const motif of INTERDITS) {
      assert.equal(rendu.includes(motif), false, `« ${motif} » ne doit pas sortir`);
    }
    // Et si une vraie clé est présente dans l'environnement, sa valeur non plus.
    const cle = process.env.ANTHROPIC_API_KEY?.trim();
    if (cle && cle.length > 8) {
      assert.equal(rendu.includes(cle), false, 'la valeur de la clé ne doit jamais sortir');
    }
  });

  test('la santé du système ne cite aucune valeur d’environnement', async () => {
    const rendu = JSON.stringify(await buildSystemHealth(repos, config, logger));
    for (const motif of INTERDITS) {
      assert.equal(rendu.includes(motif), false, `« ${motif} » ne doit pas sortir`);
    }
  });

  test('le frontend ne lit jamais .env', () => {
    // Une garde structurelle : le code de l'interface ne doit contenir aucune
    // lecture d'environnement serveur. Le vérifier sur la source évite qu'un
    // ajout distrait rouvre la porte.
    const source = readFileSync(
      new URL('../../../apps/console/src/lib/api.ts', import.meta.url), 'utf8',
    );
    assert.equal(source.includes('process.env'), false);
    assert.equal(source.includes('.env'), false);
  });
});

describe('les gardes restent lisibles depuis l’écran', () => {
  test('l’approbation humaine est annoncée comme exigée', () => {
    const approvals = buildApprovals(repos);
    assert.equal(approvals.humanApprovalRequired, true);
    // L'écran expose ce qui attend ; il ne propose aucune approbation directe.
    assert.ok(Array.isArray(approvals.pending));
  });

  test('la boucle publie ses gardes, y compris le seuil et le plafond', () => {
    const loop = buildProspecting(repos, config, '2026-08-26');
    assert.equal(typeof loop.guards.humanApprovalRequired, 'boolean');
    assert.ok(loop.guards.minConversionScore > 0);
    assert.ok(loop.guards.maxNewOutreachPerDay > 0);
  });

  test('le quota du jour ne descend jamais sous zéro', () => {
    const war = buildWarRoom(repos, config, '2026-08-26');
    assert.ok(war.metrics.dailyRemaining >= 0);
    assert.ok(war.metrics.dailyRemaining <= war.metrics.dailyCap);
  });
});

describe('les agents et l’organisation', () => {
  test('chaque poste porte un état lisible', () => {
    const view = buildAgents(repos, config, '2026-08-26');
    assert.ok(view.workers.length > 0);
    for (const w of view.workers) {
      assert.ok(['RUNNING', 'IDLE', 'BLOCKED', 'UNAVAILABLE'].includes(w.status), w.status);
    }
    // Claude Code est le seul qui puisse être absent : c'est un binaire.
    const cc = view.workers.find((w) => w.name === 'Claude Code');
    assert.ok(cc);
  });

  test('la hiérarchie vient de la base, pas d’une liste écrite en dur', () => {
    const org = buildOrganization(repos);
    assert.ok(Array.isArray(org.departments));
    for (const d of org.departments) {
      assert.ok(Array.isArray(d.teams), 'les équipes se déduisent du playbook');
      assert.ok(Array.isArray(d.agents));
    }
  });
});

describe('la boîte de réception ne montre que le commercial', () => {
  test('les corrections d’audit ne comptent pas comme des messages', () => {
    const cv = repos.conversations.byDomain('avec.invalid')!;
    repos.conversations.recordInboundEvent({
      conversationId: cv.id, kind: 'CORRECTION', classification: 'CONTACTED',
      confidence: 1, source: 'audit', humanReviewed: true, declaredStatus: 'CONTACTED',
    });
    const inbox = buildInbox(repos);
    // Une correction porte un état, pas un contenu : la compter inventerait un
    // message que personne n'a écrit.
    assert.equal(inbox.total, 0);
  });

  test('les non-rattachés restent hors de la vue principale', () => {
    const inbox = buildInbox(repos);
    assert.equal(inbox.unmatched, null, 'null, pas 0 : aucun compteur ne les mesure');
  });
});
