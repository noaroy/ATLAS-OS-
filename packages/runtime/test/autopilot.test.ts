import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLogger } from '../../core/src/logger.ts';
import type { AtlasConfig } from '../../core/src/index.ts';
import { createRepositories, type Repositories } from '../../data/src/index.ts';
import { makeTestConfig } from '../../testing/src/index.ts';
import { GmailOutboundProvider, GMAIL_SEND_SCOPE } from '../../intelligence/src/index.ts';
import { evaluateManualSendLot } from '../../departments/src/index.ts';
import {
  runAutopilotCycle, observeAtlas, summariseAutopilot, priorityScore, worthDoing, decideAutonomy, fingerprintOf,
  allocationShares, allocationAdjustment, setAutopilotPause, scheduleAutopilotCycle, createAutopilotHandlers,
  DEFAULT_OPPORTUNITY_SOURCES, SAFE_AUTONOMOUS_TASK_TYPES, HUMAN_GATES, ALLOCATION_TARGET, MAX_ACTION_DEPTH, AUTOPILOT_TASK_TYPE,
  type AutopilotProposal, type OpportunitySource, type AutopilotObservation,
} from '../src/autopilot.ts';

/**
 * L'Autopilot : la boucle de contrôle, éprouvée sur une base réelle.
 *
 * Chaque test joue un ou plusieurs cycles sur un dépôt temporaire — jamais un
 * modèle, jamais un envoi. Les fournisseurs sont décrits à l'observation
 * (prêts ou non), les tâches confiées restent dans la file ou sont terminées
 * à la main comme le daemon le ferait. MESSAGES SENT : 0, par construction —
 * et vérifié à la fin de chaque cycle.
 */

const logger = createLogger({ level: 'error', pretty: false });
const EPOCH = '1970-01-01T00:00:00.000Z';
const NOW = new Date('2026-09-20T10:00:00.000Z');
let dir: string;
let repos: Repositories;
let config: AtlasConfig;

type Providers = AutopilotObservation['providers'];
const READY: Providers = {
  DETERMINISTIC: { ready: true, detail: 'test' }, OPENAI: { ready: true, detail: 'test' }, CLAUDE: { ready: true, detail: 'test' },
  CLAUDE_CODE: { ready: true, detail: 'test' }, DETERMINISTIC_EXTERNAL: { ready: true, detail: 'test' }, SEARCH: { ready: true, detail: 'test' },
};
const OFFLINE: Providers = {
  DETERMINISTIC: { ready: true, detail: 'test' }, OPENAI: { ready: false, detail: 'OPENAI : clé absente' }, CLAUDE: { ready: false, detail: 'ANTHROPIC : clé absente' },
  CLAUDE_CODE: { ready: false, detail: 'Claude Code : absent' }, DETERMINISTIC_EXTERNAL: { ready: false, detail: 'atlas-engineer arrêté' }, SEARCH: { ready: false, detail: 'aucun moteur' },
};

const cycle = (options: { now?: Date; sources?: OpportunitySource[]; providers?: Providers; config?: AtlasConfig; maxDispatch?: number } = {}) =>
  runAutopilotCycle(repos, options.config ?? config, logger, {
    now: options.now ?? NOW, trigger: 'test', sources: options.sources,
    observe: { providers: options.providers ?? OFFLINE, probeClaudeCode: false, cwd: dir },
    maxDispatch: options.maxDispatch,
  });

/** Une proposition minimale, sûre par défaut ; chaque test surcharge ce qui compte. */
const proposal = (over: Partial<AutopilotProposal>): AutopilotProposal => ({
  objective: 'mesurer la boucle', category: 'OPTIMIZATION', expectedBusinessValue: 'MEDIUM', expectedCostUsd: 0,
  expectedFounderTimeMinutes: 0, confidence: 0.8, urgency: 'NORMAL', evidence: ['test'], risk: 'NONE', reversibility: 'REVERSIBLE',
  recommendedAgent: 'DETERMINISTIC', requiresHumanApproval: false, reason: 'test',
  execution: { kind: 'INTERNAL_TASK', taskType: 'SALES_ANALYTICS', department: 'sales' }, ...over,
});
const sourceOf = (...proposals: AutopilotProposal[]): OpportunitySource => ({ name: 'test', propose: () => proposals });

/** Un prospect contacté avec une réponse chaude : la matière la plus proche du revenu. */
function seedHotLead(domain = 'acme-industrie.fr') {
  repos.sales.discover({ batchId: 'B1', companyName: 'Acme Industrie', domain, discoveredAt: NOW.toISOString() });
  repos.sales.recordOutreach({ domain, kind: 'CONTACTED', recordedBy: 'test', channel: 'EMAIL', recordedAt: new Date(NOW.getTime() - 86_400_000).toISOString() });
  const { conversation } = repos.conversations.open({ domain, companyName: 'Acme Industrie', channel: 'email', destination: `contact@${domain}` });
  repos.conversations.recordInboundEvent({
    conversationId: conversation.id, kind: 'EMAIL_REPLY', classification: 'REPLIED', confidence: 0.9, occurredAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
    source: 'gmail (THREAD)', rawSubject: 'Re: votre message', sender: 'Jean <jean@acme-industrie.fr>',
    bodyExcerpt: 'Bonjour, oui cela nous intéresse, proposez-moi un créneau la semaine prochaine.', humanReviewed: false, declaredStatus: null,
  });
}

/**
 * Le daemon, en deux lignes : prendre la tâche, la terminer. `claim` rend la
 * plus ancienne prenable ; celles qui passent avant sont terminées aussi,
 * comme le daemon le ferait.
 */
function completeTask(taskId: string, result: Record<string, unknown> = { ran: true }) {
  for (let essai = 0; essai < 20; essai += 1) {
    const claimed = repos.tasks.claim({ owner: 'daemon-test', leaseMs: 60_000, workerTypes: ['DETERMINISTIC', 'OPENAI', 'CLAUDE', 'CLAUDE_CODE'] });
    assert.ok(claimed.task, `la tâche ${taskId} est prenable`);
    repos.tasks.complete(claimed.task.taskId, claimed.task.taskId === taskId ? result : { ran: true }, 'daemon-test', null);
    if (claimed.task.taskId === taskId) return;
  }
  assert.fail(`la tâche ${taskId} n'a pas été prise`);
}

const assertNothingSent = () => {
  assert.equal(repos.salesLoop.sentSince(EPOCH), 0, 'MESSAGES SENT: 0');
  assert.ok(!repos.tasks.list({ limit: 500 }).some((t) => t.taskType === 'SALES_SEND'), 'l’Autopilot ne pose jamais un envoi');
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-autopilot-'));
  repos = createRepositories(join(dir, 'atlas.db'), logger);
  config = makeTestConfig(dir);
  // Une boîte « configurée » pour la lecture : seul `status()` est lu — aucun
  // jeton n'est échangé, aucun réseau. Sans elle, le feu Gmail serait OFF et
  // la lecture de boîte ne serait jamais proposée.
  process.env.GMAIL_USER = 'commercial@atlas.example';
  process.env.GMAIL_CLIENT_ID = 'test';
  process.env.GMAIL_CLIENT_SECRET = 'test';
  process.env.GMAIL_REFRESH_TOKEN = 'test';
});

afterEach(() => {
  for (const k of ['GMAIL_USER', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']) delete process.env[k];
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('1. un cycle observe l’état réel du dépôt', () => {
  test('les chiffres viennent des tables, le cycle est écrit avec ce qu’il a vu', async () => {
    seedHotLead();
    const report = await cycle();
    assert.equal(report.observation.sales.contacted, 1);
    assert.equal(report.observation.sales.hotLeadsOpen, 1);
    assert.equal(report.observation.outbound.enabled, false);
    assert.equal(report.observation.outbound.engineMode, 'INTERNAL_TEST');
    assert.equal(report.cycle.status, 'DONE');
    const persisted = repos.autopilot.cycle(report.cycle.id)!;
    assert.equal((persisted.observations as { sales: { hotLeadsOpen: number } }).sales.hotLeadsOpen, 1, 'l’observation est relisible après coup');
    assert.ok(persisted.decisions.length > 0);
    assert.ok(persisted.summary);
    assert.ok(report.considered.some((c) => c.category === 'REVENUE'));
    assertNothingSent();
  });
});

describe('2. la même occasion ne s’enfile pas deux fois', () => {
  test('deux cycles sur le même état : une seule action ouverte, le second décide DUPLICATE', async () => {
    seedHotLead();
    const premier = await cycle();
    const ouvertes = repos.autopilot.openActions().length;
    assert.ok(ouvertes >= 1);
    const second = await cycle({ now: new Date(NOW.getTime() + 60_000) });
    assert.equal(repos.autopilot.openActions().length, ouvertes, 'aucune copie');
    assert.ok(second.decisions.some((d) => d.decision === 'DUPLICATE'));
    assert.equal(second.created.length, 0);
    assert.equal(premier.created.length, ouvertes);
    // Et le dépôt lui-même refuse un doublon ouvert.
    const fp = fingerprintOf({ category: 'REVENUE', objective: 'x' });
    const a = repos.autopilot.propose({ cycleId: premier.cycle.id, fingerprint: fp, objective: 'x', category: 'REVENUE', allocation: 'EXPLOIT', score: 1, proposal: {}, recommendedAgent: 'HUMAN', requiresHumanApproval: true, reason: 'r' });
    const b = repos.autopilot.propose({ cycleId: premier.cycle.id, fingerprint: fp, objective: 'x', category: 'REVENUE', allocation: 'EXPLOIT', score: 1, proposal: {}, recommendedAgent: 'HUMAN', requiresHumanApproval: true, reason: 'r' });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(b.action.id, a.action.id);
  });
});

describe('3 + 4. la priorité : le revenu avant le cosmétique, l’urgent avant l’exploration', () => {
  test('une réponse chaude bloquée pèse plus qu’un nettoyage de code ; une relance client plus qu’une exploration', () => {
    const revenue = proposal({ objective: 'répondre à un prospect intéressé', category: 'REVENUE', expectedBusinessValue: 'DIRECT_REVENUE', urgency: 'CRITICAL', expectedFounderTimeMinutes: 10, recommendedAgent: 'HUMAN', requiresHumanApproval: true, execution: { kind: 'FOUNDER_DECISION', command: 'npm run sales:inbox' } });
    const cosmetic = proposal({ objective: 'renommer trois variables', category: 'RELIABILITY', expectedBusinessValue: 'LOW', urgency: 'LOW', expectedCostUsd: 0.1, recommendedAgent: 'CLAUDE_CODE', execution: { kind: 'INTERNAL_TASK', taskType: 'ENGINEERING_CHANGE', department: 'ENGINEERING' } });
    const blockedClient = proposal({ objective: 'répondre à un client qui attend', category: 'BLOCKED_WORK', expectedBusinessValue: 'HIGH', urgency: 'HIGH', recommendedAgent: 'HUMAN', requiresHumanApproval: true, execution: { kind: 'FOUNDER_DECISION', command: 'npm run sales:inbox' } });
    const exploration = proposal({ objective: 'explorer un segment voisin', category: 'EXPLORATION', expectedBusinessValue: 'MEDIUM', urgency: 'LOW', expectedCostUsd: 0.1, recommendedAgent: 'OPENAI', execution: { kind: 'INTERNAL_TASK', taskType: 'COMMERCIAL_ANALYSIS', department: 'sales' } });
    assert.ok(priorityScore(revenue) > priorityScore(cosmetic) + 50);
    assert.ok(priorityScore(blockedClient) > priorityScore(exploration) + 50);
    assert.ok(priorityScore(cosmetic) > priorityScore(exploration), 'même le cosmétique passe avant l’exploration pure');
  });

  test('dans un cycle, l’ordre considéré suit le score', async () => {
    const report = await cycle({ providers: READY, sources: [sourceOf(
      proposal({ objective: 'explorer', category: 'EXPLORATION', expectedBusinessValue: 'MEDIUM', urgency: 'LOW', expectedCostUsd: 0.1, recommendedAgent: 'OPENAI', execution: { kind: 'INTERNAL_TASK', taskType: 'COMMERCIAL_ANALYSIS', department: 'sales' } }),
      proposal({ objective: 'code cosmétique', category: 'RELIABILITY', expectedBusinessValue: 'LOW', urgency: 'LOW', expectedCostUsd: 0.1, recommendedAgent: 'CLAUDE_CODE', execution: { kind: 'INTERNAL_TASK', taskType: 'ENGINEERING_CHANGE', department: 'ENGINEERING' } }),
      proposal({ objective: 'répondre au prospect', category: 'REVENUE', expectedBusinessValue: 'DIRECT_REVENUE', urgency: 'CRITICAL', recommendedAgent: 'HUMAN', requiresHumanApproval: true, execution: { kind: 'FOUNDER_DECISION', command: 'npm run sales:inbox' } }),
    )] });
    assert.deepEqual(report.considered.map((c) => c.objective), ['répondre au prospect', 'code cosmétique', 'explorer']);
    assertNothingSent();
  });
});

describe('5. une tâche interne sûre se confie seule', () => {
  test('la boîte jamais lue → SALES_REPLY_CHECK posée dans la file existante, action QUEUED', async () => {
    seedHotLead();
    const report = await cycle();
    const sync = report.executed.find((e) => e.taskType === 'SALES_REPLY_CHECK');
    assert.ok(sync, JSON.stringify(report.executed));
    const task = repos.tasks.byId(sync!.taskId)!;
    assert.equal(task.workerType, 'DETERMINISTIC');
    assert.equal(task.status, 'QUEUED');
    assert.equal(task.payload.autopilot_action_id, sync!.actionId);
    assert.ok(task.idempotencyKey?.startsWith('autopilot:'));
    assert.equal(repos.autopilot.action(sync!.actionId)!.status, 'QUEUED');
    assert.equal(repos.autopilot.byTask(sync!.taskId)?.id, sync!.actionId);
    assertNothingSent();
  });
});

describe('6 – 9. les portes : ce qui exige une personne, toujours', () => {
  const gated = (gate: AutopilotProposal['gate'], objective: string) => proposal({
    objective, category: 'REVENUE', expectedBusinessValue: 'DIRECT_REVENUE', gate, requiresHumanApproval: false,
    execution: { kind: 'INTERNAL_TASK', taskType: 'SALES_ANALYTICS', department: 'sales' },
  });

  test('6. activer / envoyer une campagne externe → WAITING_HUMAN, aucune tâche', async () => {
    const report = await cycle({ providers: READY, sources: [sourceOf(gated('EXTERNAL_OUTBOUND', 'envoyer la première campagne'), gated('OUTBOUND_ACTIVATION', 'lever ATLAS_OUTBOUND_ENABLED'))] });
    assert.deepEqual(report.created.map((a) => a.status), ['WAITING_HUMAN', 'WAITING_HUMAN']);
    assert.equal(report.executed.length, 0);
    assert.equal(repos.tasks.list({ limit: 10 }).length, 0);
    assertNothingSent();
  });

  test('7. un paiement → WAITING_HUMAN', async () => {
    const report = await cycle({ providers: READY, sources: [sourceOf(gated('PAYMENT', 'payer un outil'))] });
    assert.equal(report.created[0]!.status, 'WAITING_HUMAN');
    assert.match(report.created[0]!.proposal.autonomy as string, /porte PAYMENT/);
    assert.equal(report.executed.length, 0);
  });

  test('8. un déploiement en production → WAITING_HUMAN — y compris le diff prêt de la source par défaut', async () => {
    const report = await cycle({ providers: READY, sources: [sourceOf(gated('PRODUCTION_DEPLOYMENT', 'déployer v4.6.0'))] });
    assert.equal(report.created[0]!.status, 'WAITING_HUMAN');
    assert.equal(report.executed.length, 0);
    assert.ok(DEFAULT_OPPORTUNITY_SOURCES.length > 0);
  });

  test('9. une action destructive n’est jamais exécutée seule — par la porte, et par la liste fermée des types sûrs', async () => {
    const report = await cycle({ providers: READY, sources: [sourceOf(
      gated('DESTRUCTIVE_DB', 'purger les conversations'),
      proposal({ objective: 'vider la table', category: 'RELIABILITY', requiresHumanApproval: false, execution: { kind: 'INTERNAL_TASK', taskType: 'DB_PURGE', department: 'ENGINEERING' } }),
      gated('SECURITY_POLICY', 'ouvrir le CORS'), gated('SECRET_CHANGE', 'changer un jeton'), gated('BUDGET_INCREASE', 'doubler le budget'), gated('BINDING_COMMITMENT', 'signer un devis'),
    )] });
    assert.ok(report.created.every((a) => a.status === 'WAITING_HUMAN'), JSON.stringify(report.created.map((a) => [a.objective, a.status])));
    assert.equal(report.executed.length, 0);
    assert.equal(repos.tasks.list({ limit: 10 }).length, 0);
    assert.ok(!SAFE_AUTONOMOUS_TASK_TYPES.includes('SALES_SEND'));
    assert.ok(!SAFE_AUTONOMOUS_TASK_TYPES.some((t) => t.startsWith('APPROVE_')));
    for (const gate of ['EXTERNAL_OUTBOUND', 'PAYMENT', 'PRODUCTION_DEPLOYMENT', 'DESTRUCTIVE_DB', 'SECURITY_POLICY', 'SECRET_CHANGE', 'BUDGET_INCREASE', 'BINDING_COMMITMENT']) assert.ok(HUMAN_GATES.includes(gate as never), gate);
  });
});

describe('10 + 11. fermé par défaut : fournisseur absent, budget épuisé', () => {
  test('10. le fournisseur du worker n’est pas prêt → BLOCKED, avec le motif, sans tâche', async () => {
    const report = await cycle({ providers: OFFLINE, sources: [sourceOf(
      proposal({ objective: 'revue d’architecture', category: 'RELIABILITY', expectedCostUsd: 0.1, recommendedAgent: 'OPENAI', execution: { kind: 'INTERNAL_TASK', taskType: 'ARCHITECTURE_REVIEW', department: 'ENGINEERING' } }),
    )] });
    assert.equal(report.created[0]!.status, 'BLOCKED');
    assert.match(report.created[0]!.rejectionReason ?? '', /fournisseur indisponible — OPENAI : clé absente/);
    assert.equal(report.executed.length, 0);
    assert.equal(repos.tasks.list({ limit: 10 }).length, 0);
    assert.equal(report.blocked.length, 1);
  });

  test('11. budget quotidien dépassé → aucune exécution ; plafond du cycle → reporté, pas exécuté', async () => {
    const cfg: AtlasConfig = { ...config, ai: { ...config.ai, dailyBudgetMode: 'CONFIGURED', dailyBudgetUsd: 1 } };
    repos.tasks.recordAiCall({ provider: 'OPENAI', model: 'gpt-5', inputTokens: 1000, outputTokens: 1000, costUsd: 1.2, costBasis: 'KNOWN', outcome: 'DONE' });
    const report = await cycle({ config: cfg, providers: READY, sources: [sourceOf(
      proposal({ objective: 'revue', category: 'RELIABILITY', expectedCostUsd: 0.1, recommendedAgent: 'OPENAI', execution: { kind: 'INTERNAL_TASK', taskType: 'ARCHITECTURE_REVIEW', department: 'ENGINEERING' } }),
    )] });
    assert.equal(report.observation.spend.todayUsd, 1.2);
    assert.equal(report.created[0]!.status, 'BLOCKED');
    assert.match(report.created[0]!.rejectionReason ?? '', /budget/);
    assert.equal(report.executed.length, 0);

    // Le plafond du cycle : la seconde action de modèle attend le prochain cycle.
    const cfg2: AtlasConfig = { ...config, autopilot: { ...config.autopilot, maxCycleCostUsd: 0.15 } };
    const report2 = await cycle({ config: cfg2, providers: READY, now: new Date(NOW.getTime() + 60_000), sources: [sourceOf(
      proposal({ objective: 'revue A', category: 'RELIABILITY', expectedCostUsd: 0.1, recommendedAgent: 'OPENAI', execution: { kind: 'INTERNAL_TASK', taskType: 'ARCHITECTURE_REVIEW', department: 'ENGINEERING' } }),
      proposal({ objective: 'revue B', category: 'RELIABILITY', expectedCostUsd: 0.1, recommendedAgent: 'OPENAI', execution: { kind: 'INTERNAL_TASK', taskType: 'CODE_REVIEW', department: 'ENGINEERING' } }),
    )] });
    assert.equal(report2.executed.length, 1);
    const deferred = report2.created.find((a) => a.objective === 'revue B')!;
    assert.equal(deferred.status, 'PROPOSED');
    assert.match(deferred.proposal.autonomy as string, /plafond du cycle/);
    assert.equal(report2.estimatedSpendUsd, 0.1);
  });
});

describe('18. le travail bloqué reprend seul, sans doublon — et ce qui attend une personne attend encore', () => {
  const review = () => proposal({ objective: 'revue d’architecture du module de relance', category: 'RELIABILITY', expectedCostUsd: 0.1, recommendedAgent: 'OPENAI', execution: { kind: 'INTERNAL_TASK', taskType: 'ARCHITECTURE_REVIEW', department: 'ENGINEERING' } });
  const withOpenAi = (ready: boolean, detail: string): Providers => ({ ...READY, OPENAI: { ready, detail, state: ready ? 'READY' : 'ABSENT' } });
  const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

  test('18.1 OPENAI absent → BLOCKED, sans tâche', async () => {
    const report = await cycle({ providers: withOpenAi(false, 'OPENAI : ATLAS_OPENAI_API_KEY absent'), sources: [sourceOf(review())] });
    assert.equal(report.created[0]!.status, 'BLOCKED');
    assert.match(report.created[0]!.rejectionReason ?? '', /OPENAI : ATLAS_OPENAI_API_KEY absent/);
    assert.equal(repos.tasks.list({ limit: 10 }).length, 0);
    assertNothingSent();
  });

  test('18.2 OPENAI revenu → la même action reprend (RESUMED), une tâche, aucun doublon', async () => {
    const blocked = await cycle({ providers: withOpenAi(false, 'OPENAI : clé absente'), sources: [sourceOf(review())] });
    const id = blocked.created[0]!.id;
    const resumed = await cycle({ now: later(31), providers: withOpenAi(true, 'OPENAI : a répondu'), sources: [sourceOf(review())] });
    const decision = resumed.decisions.find((d) => d.actionId === id);
    assert.equal(decision?.decision, 'RESUMED', JSON.stringify(resumed.decisions));
    assert.match(decision!.reason, /était BLOCKED — fournisseur indisponible — OPENAI : clé absente/);
    assert.equal(resumed.created.length, 0, 'aucune nouvelle action');
    const action = repos.autopilot.action(id)!;
    assert.equal(action.status, 'QUEUED');
    assert.ok(action.taskId);
    assert.equal(action.rejectionReason, null, 'le motif de blocage d’hier n’est plus écrit');
    assert.equal(repos.autopilot.actions({ limit: 50 }).length, 1, 'une seule action pour cette empreinte');
    assert.equal(resumed.executed.length, 1);
    assert.equal(resumed.executed[0]!.actionId, id);
    const tasks = repos.tasks.list({ limit: 10 });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.taskType, 'ARCHITECTURE_REVIEW');
    assert.equal(tasks[0]!.payload.autopilot_action_id, id);
    assert.equal(repos.autopilot.cycle(resumed.cycle.id)!.executed.length, 1, 'la reprise est consignée dans le cycle');
    // Un troisième cycle : l'action suit sa tâche, rien de plus n'est créé.
    const third = await cycle({ now: later(62), providers: withOpenAi(true, 'OPENAI : a répondu'), sources: [sourceOf(review())] });
    assert.equal(third.decisions.find((d) => d.actionId === id)?.decision, 'DUPLICATE');
    assert.equal(repos.tasks.list({ limit: 10 }).length, 1);
    assertNothingSent();
  });

  test('18.3 budget épuisé → BLOCKED ; budget rendu (lendemain) → reprend, la même action', async () => {
    const cfg: AtlasConfig = { ...config, ai: { ...config.ai, dailyBudgetMode: 'CONFIGURED', dailyBudgetUsd: 1 } };
    repos.tasks.recordAiCall({ provider: 'OPENAI', model: 'gpt-5', inputTokens: 1000, outputTokens: 1000, costUsd: 1.2, costBasis: 'KNOWN', outcome: 'DONE' });
    const blocked = await cycle({ config: cfg, providers: READY, sources: [sourceOf(review())] });
    const id = blocked.created[0]!.id;
    assert.equal(blocked.created[0]!.status, 'BLOCKED');
    assert.match(blocked.created[0]!.rejectionReason ?? '', /budget/);

    // Le même jour, rien ne change : STILL_BLOCKED, motif tenu à jour, toujours une seule action.
    const still = await cycle({ config: cfg, now: later(30), providers: READY, sources: [sourceOf(review())] });
    assert.equal(still.decisions.find((d) => d.actionId === id)?.decision, 'STILL_BLOCKED');
    assert.equal(repos.autopilot.action(id)!.status, 'BLOCKED');
    assert.equal(repos.autopilot.actions({ limit: 50 }).length, 1);

    // La dépense du jour est celle du vrai calendrier ; le lendemain simulé la voit à zéro.
    const tomorrow = new Date(Date.now() + 26 * 3_600_000);
    const resumed = await cycle({ config: cfg, now: tomorrow, providers: READY, sources: [sourceOf(review())] });
    assert.ok(!resumed.observation.spend.todayUsd, 'aucune dépense ce jour-là (null : rien à mesurer, jamais inventé)');
    assert.equal(resumed.decisions.find((d) => d.actionId === id)?.decision, 'RESUMED');
    assert.equal(repos.autopilot.action(id)!.status, 'QUEUED');
    assert.equal(repos.autopilot.actions({ limit: 50 }).length, 1);
    assert.equal(repos.tasks.list({ limit: 10 }).length, 1);
    assertNothingSent();
  });

  test('18.4 une porte humaine ne reprend jamais seule, quel que soit l’état des fournisseurs', async () => {
    const gated = () => proposal({ objective: 'déployer le diff prêt', category: 'RELIABILITY', expectedBusinessValue: 'HIGH', gate: 'PRODUCTION_DEPLOYMENT', execution: { kind: 'INTERNAL_TASK', taskType: 'ENGINEERING_CHANGE', department: 'ENGINEERING' }, recommendedAgent: 'CLAUDE_CODE' });
    const first = await cycle({ providers: OFFLINE, sources: [sourceOf(gated())] });
    const id = first.created[0]!.id;
    assert.equal(first.created[0]!.status, 'WAITING_HUMAN');
    for (const minutes of [31, 62, 24 * 60]) {
      const again = await cycle({ now: later(minutes), providers: READY, sources: [sourceOf(gated())] });
      assert.equal(again.decisions.find((d) => d.actionId === id)?.decision, 'DUPLICATE');
      assert.equal(repos.autopilot.action(id)!.status, 'WAITING_HUMAN');
    }
    assert.equal(repos.tasks.list({ limit: 10 }).length, 0, 'jamais une tâche sans la personne');
    assert.equal(repos.autopilot.actions({ limit: 50 }).length, 1);
    assertNothingSent();
  });

  test('18.5 fournisseur toujours absent → reste BLOCKED, motif rafraîchi, sans tâche, sans doublon — et Claude Code absent bloque l’ingénierie', async () => {
    const blocked = await cycle({ providers: withOpenAi(false, 'OPENAI : clé absente'), sources: [sourceOf(review())] });
    const id = blocked.created[0]!.id;
    const again = await cycle({ now: later(31), providers: withOpenAi(false, 'OPENAI : AUTH_ERROR — clé refusée'), sources: [sourceOf(review())] });
    const decision = again.decisions.find((d) => d.actionId === id);
    assert.equal(decision?.decision, 'STILL_BLOCKED');
    const action = repos.autopilot.action(id)!;
    assert.equal(action.status, 'BLOCKED');
    assert.match(action.rejectionReason ?? '', /AUTH_ERROR — clé refusée/, 'le motif est celui d’aujourd’hui');
    assert.equal(action.taskId, null);
    assert.equal(repos.tasks.list({ limit: 10 }).length, 0);
    assert.equal(repos.autopilot.actions({ limit: 50 }).length, 1);

    const engineering = proposal({ objective: 'corriger la relance', category: 'RELIABILITY', expectedCostUsd: 0.2, recommendedAgent: 'CLAUDE_CODE', execution: { kind: 'INTERNAL_TASK', taskType: 'ENGINEERING_CHANGE', department: 'ENGINEERING' } });
    const noRunner = await cycle({ now: later(62), providers: { ...READY, CLAUDE_CODE: { ready: false, detail: 'Claude Code : binaire absent', state: 'ABSENT' } }, sources: [sourceOf(engineering)] });
    assert.equal(noRunner.created[0]!.status, 'BLOCKED');
    assert.match(noRunner.created[0]!.rejectionReason ?? '', /binaire absent/);
    assert.equal(repos.tasks.list({ limit: 10 }).length, 0);
    assertNothingSent();
  });

  test('18.6 redémarrage entre le blocage et la reprise : la reprise tient, sur la même base', async () => {
    const blocked = await cycle({ providers: withOpenAi(false, 'OPENAI : clé absente'), sources: [sourceOf(review())] });
    const id = blocked.created[0]!.id;
    const file = join(dir, 'atlas.db');
    repos.close();
    repos = createRepositories(file, logger);
    assert.equal(repos.autopilot.action(id)!.status, 'BLOCKED', 'le blocage a survécu au redémarrage');
    const resumed = await cycle({ now: later(31), providers: withOpenAi(true, 'OPENAI : a répondu'), sources: [sourceOf(review())] });
    assert.equal(resumed.decisions.find((d) => d.actionId === id)?.decision, 'RESUMED');
    assert.equal(repos.autopilot.action(id)!.status, 'QUEUED');
    assert.equal(repos.autopilot.actions({ limit: 50 }).length, 1);
    assert.equal(repos.tasks.list({ limit: 10 }).length, 1);
    assertNothingSent();
  });
});

describe('12. reprise après redémarrage', () => {
  test('un cycle laissé ouvert est marqué INTERRUPTED, et l’action confiée est vérifiée depuis la file', async () => {
    seedHotLead();
    const premier = await cycle();
    const sync = premier.executed.find((e) => e.taskType === 'SALES_REPLY_CHECK')!;
    // Un cycle commence… et le processus meurt.
    const ouvert = repos.autopilot.startCycle({ trigger: 'test-crash' });
    completeTask(sync.taskId, { ran: false, skipped: 'aucune conversation ouverte' });
    const file = join(dir, 'atlas.db');
    repos.close();
    repos = createRepositories(file, logger);

    const suivant = await cycle({ now: new Date(NOW.getTime() + 120_000) });
    assert.equal(repos.autopilot.cycle(ouvert.id)!.status, 'INTERRUPTED');
    assert.ok(suivant.learned.some((l) => /INTERRUPTED/.test(l)));
    assert.equal(repos.autopilot.action(sync.actionId)!.status, 'DONE');
    assert.ok(suivant.verified.some((v) => v.actionId === sync.actionId && v.to === 'DONE'));
    assertNothingSent();
  });
});

describe('13. une action terminée pèse sur le cycle suivant', () => {
  test('la lecture de boîte terminée change l’état observé : elle n’est plus proposée ; la même action explicite attend six heures (DONE_RECENTLY)', async () => {
    seedHotLead();
    const premier = await cycle();
    const sync = premier.executed.find((e) => e.taskType === 'SALES_REPLY_CHECK')!;
    assert.equal(premier.observation.health.gmail, 'UNKNOWN');
    completeTask(sync.taskId, { ran: false, configured: true, skipped: 'aucune conversation ouverte : rien à rapprocher' });
    const second = await cycle({ now: new Date(NOW.getTime() + 600_000) });
    assert.equal(repos.autopilot.action(sync.actionId)!.status, 'DONE');
    assert.equal(second.observation.health.gmail, 'READY_IDLE', 'la tâche terminée a changé ce que le cycle observe');
    assert.ok(!second.considered.some((c) => /Gmail/.test(c.objective)), 'plus rien à proposer sur la boîte');
    assert.ok(second.learned.some((l) => /terminée\(s\) depuis le dernier cycle/.test(l)));

    // Une source qui insiste : la même action, terminée il y a dix minutes, n’est pas refaite avant six heures.
    const insiste = sourceOf(proposal({ objective: 'mesurer encore' }));
    const a = await cycle({ providers: READY, sources: [insiste], now: new Date(NOW.getTime() + 1_200_000) });
    assert.equal(a.executed.length, 1);
    completeTask(a.executed[0]!.taskId);
    const b = await cycle({ providers: READY, sources: [insiste], now: new Date(NOW.getTime() + 1_800_000) });
    assert.equal(b.decisions.find((d) => d.objective === 'mesurer encore')?.decision, 'DONE_RECENTLY', JSON.stringify(b.decisions));
    assert.equal(b.executed.length, 0);
    const c = await cycle({ providers: READY, sources: [insiste], now: new Date(NOW.getTime() + 8 * 3_600_000) });
    assert.equal(c.executed.length, 1, `six heures plus tard, la mesure se rejoue : ${JSON.stringify(c.decisions)}`);
    assertNothingSent();
  });
});

describe('14. la file ne s’auto-alimente pas à l’infini', () => {
  test('une source qui propose toujours une suite est coupée par la profondeur', async () => {
    const boucle: OpportunitySource = {
      name: 'boucle',
      propose: () => [proposal({ objective: 'mesurer encore' })],
      followUp: () => [proposal({ objective: 'mesurer encore' })],
    };
    let now = NOW;
    let total = 0;
    for (let i = 0; i < 6; i += 1) {
      const report = await cycle({ providers: READY, sources: [boucle], now });
      for (const e of report.executed) completeTask(e.taskId);
      total = repos.autopilot.actions({ limit: 100 }).filter((a) => a.objective === 'mesurer encore').length;
      now = new Date(now.getTime() + 7 * 3_600_000);
    }
    assert.ok(total <= MAX_ACTION_DEPTH + 1 + 2, `au plus quelques actions, jamais une par cycle : ${total}`);
    const profondeurs = repos.autopilot.actions({ limit: 100 }).map((a) => a.depth);
    assert.ok(Math.max(...profondeurs) <= MAX_ACTION_DEPTH);
    assertNothingSent();
  });
});

describe('15. 70 / 20 / 10 : une intention glissante, jamais du travail pour remplir', () => {
  test('les cibles existent, l’ajustement est nul sans échantillon, et aucune exploration n’est créée sans candidat', async () => {
    assert.deepEqual(ALLOCATION_TARGET, { EXPLOIT: 0.7, OPTIMIZE: 0.2, EXPLORE: 0.1 });
    assert.equal(allocationAdjustment('EXPLORE', { EXPLOIT: 1, OPTIMIZE: 0, EXPLORE: 0 }, 3), 0, 'moins de cinq actions : rien à corriger');
    assert.equal(allocationAdjustment('EXPLOIT', { EXPLOIT: 1, OPTIMIZE: 0, EXPLORE: 0 }, 10), -15, 'trop d’exploitation : légère pénalité');
    assert.equal(allocationAdjustment('EXPLORE', { EXPLOIT: 1, OPTIMIZE: 0, EXPLORE: 0 }, 10), 5, 'pas assez d’exploration : léger bonus');
    assert.deepEqual(allocationShares([{ allocation: 'EXPLOIT' }, { allocation: 'EXPLOIT' }, { allocation: 'EXPLORE' }, { allocation: 'OPTIMIZE' }]), { EXPLOIT: 0.5, OPTIMIZE: 0.25, EXPLORE: 0.25 });
    seedHotLead();
    const report = await cycle();
    assert.ok(report.created.every((a) => a.allocation !== 'EXPLORE'), 'sans preuve, aucune exploration');
    assert.ok(report.learned.some((l) => /cibles 70\/20\/10/.test(l)));
  });

  test('sans occasion réelle, rien n’est créé — et cela se dit', async () => {
    const report = await cycle({ sources: [] });
    assert.equal(report.created.length, 0);
    assert.ok(report.learned.some((l) => /rien n’a été créé pour remplir la file/.test(l)));
    assert.match(report.cycle.summary ?? '', /rien à faire de plus/);
  });
});

describe('16. aucune métrique inventée', () => {
  test('ce qui n’est pas mesurable est null et nommé', async () => {
    const o = await observeAtlas(repos, config, { now: NOW, providers: OFFLINE, probeClaudeCode: false, cwd: dir });
    assert.equal(o.spend.todayUsd, null);
    assert.equal(o.sales.pipelinePotential, null);
    assert.equal(o.engineering.repoClean, null, 'pas un dépôt git : on ne sait pas');
    assert.ok(o.absent.some((a) => /coût IA/.test(a)));
    assert.ok(o.absent.some((a) => /dépôt/.test(a)));
    assert.ok(o.absent.some((a) => /pipeline/.test(a)));
    const report = await cycle();
    assert.ok(report.learned.some((l) => /non mesurable, non inventé/.test(l)));
  });
});

describe('17 + 20. rien ne part, les gardes de production ne bougent pas', () => {
  test('après cycles, pause, reprise et décisions : 0 message, portes intactes', async () => {
    seedHotLead();
    await cycle({ providers: READY });
    setAutopilotPause(repos, true, 'test', 'vérification');
    const enPause = await cycle({ providers: READY, now: new Date(NOW.getTime() + 60_000) });
    assert.equal(enPause.paused, true);
    assert.equal(enPause.executed.length, 0, 'en pause : on observe, on ne confie rien');
    setAutopilotPause(repos, false, 'test', null);
    const summary = summariseAutopilot(repos, config, NOW);
    assert.ok(['ACTIVE', 'IDLE'].includes(summary.status));
    assert.ok(summary.waitingFounder.some((w) => /réponse\(s\) chaude\(s\)/.test(w.objective) && w.command === 'npm run sales:inbox'));
    assert.equal(summary.topObjective, summary.waitingFounder[0]?.objective ?? summary.topObjective);
    assertNothingSent();
    // Les portes existantes, telles quelles.
    assert.deepEqual(evaluateManualSendLot({ send: true, engineMode: 'INTERNAL_TEST', outboundEnabled: false, gmailUser: 'a@b.fr', recipients: ['a@b.fr'] }).blocks.map((b) => b.code), ['OUTBOUND_DISABLED']);
    const transport = new GmailOutboundProvider({ grantedScopes: [GMAIL_SEND_SCOPE], env: { GMAIL_CLIENT_ID: 'x', GMAIL_CLIENT_SECRET: 'x', GMAIL_REFRESH_TOKEN: 'x', GMAIL_USER: 'a@b.fr', ATLAS_OUTBOUND_ENABLED: 'false' } as NodeJS.ProcessEnv });
    assert.equal(transport.status().code, 'OUTBOUND_DISABLED');
    assert.equal(config.sales.outboundEnabled, false);
    assert.equal(config.sales.engineMode, 'INTERNAL_TEST');
  });

  test('le cadencement ne pose rien tant qu’il est désactivé ; activé, une clé de période, une tâche', () => {
    assert.deepEqual(scheduleAutopilotCycle(repos, config, NOW), { created: [], existing: [] });
    const cfg: AtlasConfig = { ...config, autopilot: { ...config.autopilot, enabled: true } };
    const a = scheduleAutopilotCycle(repos, cfg, NOW);
    const b = scheduleAutopilotCycle(repos, cfg, new Date(NOW.getTime() + 60_000));
    assert.equal(a.created.length, 1);
    assert.equal(b.existing.length, 1);
    assert.equal(repos.tasks.list({ limit: 10 }).filter((t) => t.taskType === AUTOPILOT_TASK_TYPE).length, 1);
    assert.ok(AUTOPILOT_TASK_TYPE in createAutopilotHandlers({ repos, config, logger }));
  });
});

describe('la règle d’économie', () => {
  test('aucune valeur → pas la peine ; faible valeur chère → pas la peine ; confiance nulle → pas la peine', async () => {
    assert.equal(worthDoing(proposal({ expectedBusinessValue: 'NONE' })).worth, false);
    assert.equal(worthDoing(proposal({ expectedBusinessValue: 'LOW', expectedCostUsd: 0.5 })).worth, false);
    assert.equal(worthDoing(proposal({ confidence: 0.1 })).worth, false);
    assert.equal(worthDoing(proposal({ expectedBusinessValue: 'LOW', expectedCostUsd: 0 })).worth, true);
    const o = await observeAtlas(repos, config, { now: NOW, providers: READY, probeClaudeCode: false, cwd: dir });
    assert.equal(decideAutonomy(proposal({ execution: { kind: 'INTERNAL_TASK', taskType: 'SALES_DISCOVERY', department: 'sales' } }), { observation: o, config, cycleSpentUsd: 0 }).verdict, 'BLOCKED', 'découverte sans modèle vivant : fermé');
  });
});

describe('les commandes que l’Autopilot affiche existent réellement', () => {
  // Relevé en production : « npm run sales:engine -- recommendations »
  // s'affichait pour chaque décision de recommandation, mais `sales:engine`
  // n'est déclaré nulle part dans package.json, et `sales-engine.ts` n'a pas
  // de verbe « recommendations » — la commande ne pouvait jamais s'exécuter.
  const ROOT = resolve(import.meta.dirname, '../../..');
  const source = readFileSync(join(ROOT, 'packages', 'runtime', 'src', 'autopilot.ts'), 'utf8');
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>;

  test('aucune commande affichée ne référence un script npm absent de package.json', () => {
    const commands = [...source.matchAll(/command:\s*'([^']*)'/g)].map((m) => m[1]!);
    assert.ok(commands.length > 0, 'la source doit contenir des commandes affichées');
    for (const command of commands) {
      // Chaque commande peut enchaîner plusieurs étapes (« … puis … ») ; chaque
      // étape « npm run X » doit désigner un script déclaré.
      for (const m of command.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) {
        assert.ok(m[1]! in scripts, `« npm run ${m[1]} » n'existe pas dans package.json (commande : ${command})`);
      }
    }
  });

  test('la décision de recommandation pointe vers sales:status puis sales:campaign -- decide', () => {
    const commands = [...source.matchAll(/command:\s*'([^']*)'/g)].map((m) => m[1]!);
    assert.ok(!commands.some((c) => c.includes('sales:engine')), '« sales:engine » n’a jamais existé comme script npm — un commentaire peut le nommer, une commande affichée jamais');
    assert.ok(commands.some((c) => c === 'npm run sales:status  puis  npm run sales:campaign -- decide <recId> test|approve|reject'));
  });

  test('la relecture des brouillons pointe vers approvals:audit, qui couvre les deux magasins', () => {
    // `draftsAwaitingApproval` compte `outreach_drafts` ET `sales_prospects`
    // (board.todo.approvals) ; `sales:loop -- drafts` ne lit que le premier —
    // relevé en conditions réelles : 3 en attente, 0 affichés par cette commande.
    const commands = [...source.matchAll(/command:\s*'([^']*)'/g)].map((m) => m[1]!);
    assert.ok(
      !commands.some((c) => c === 'npm run sales:loop -- drafts'),
      'cette commande ne couvre qu’un des deux magasins de brouillons — elle peut afficher 0 à tort',
    );
    assert.ok(commands.some((c) => c === 'npm run approvals:audit'));
  });
});
