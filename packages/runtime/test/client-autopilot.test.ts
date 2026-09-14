import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';
import { BUSINESS_EXPANSION, parseClientBrief, type ClientBrief } from '@atlas/departments';
import type { SearchProvider, SearchRequest, SearchResponse } from '@atlas/intelligence';
import {
  runAutopilot, loadClientRun, readAutopilot, countsFor, nextAction, assessBatchQuality, adaptBatchSize, canTransition,
  missionMetrics, decisionJournal, estimateMission, DEFAULT_LIMITS, MISSION_STATES, MISSION_TRANSITIONS,
  type AutopilotDeps, type AutopilotOptions, type FetchedPages, type PreflightVerdict, type MissionState, type BatchSummary,
} from '../src/index.ts';
import { BRIEF_JSON, llmFixture } from './fixtures/sweden-mission.ts';

/**
 * Une mission conduite par le pilote, de bout en bout, sans réseau ni modèle :
 * brief → plan → mission → trois lots dont un moteur en panne et une reprise →
 * revue → PARTIAL → retour client → proposition → brief v2 → reprise →
 * saturation → FINAL → clôture. Puis chaque garde-fou, un par un.
 */
const logger = createLogger({ level: 'error', pretty: false });
let repos: Repositories;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-autopilot-'));
  repos = createRepositories(join(dir, 'auto.db'), logger);
  repos.departments.ensure(BUSINESS_EXPANSION);
});
afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

// ─── Un petit marché suédois, généré ─────────────────────────────────────────

const bonSite = (nom: string, domaine: string, orgnr: string) => ({
  '/': `<html><head><title>${nom} | Start</title></head><body>
    <nav><a href="/produkter/">Produkter</a><a href="/kontakta-oss/">Kontakta oss</a></nav>
    <p>${nom} är distributör av förpackningsmaskiner och kontrollutrustning för kosmetik och läkemedel i Sverige.</p></body></html>`,
  '/produkter/': `<html><body><p>Våra förpackningsmaskiner: flowpack och kontrollutrustning för läkemedel. Vi installerar och servar alla maskiner vi levererar.</p></body></html>`,
  '/kontakta-oss/': `<html><body><p>${nom} · Industrigatan 5, 142 50 Skogås · <a href="mailto:info@${domaine}">info@${domaine}</a> · +46 8 123 45 67 · Org.nr ${orgnr}</p></body></html>`,
});
const generaliste = (nom: string, domaine: string) => ({
  '/': `<html><head><title>${nom}</title></head><body><nav><a href="/kontakt/">Kontakt</a></nav>
    <p>${nom} är en grossist med ett brett sortiment: pumpar, verktyg, kontorsmöbler, förpackningsmaskiner, städutrustning, belysning och trädgård. Allt inom industri.</p></body></html>`,
  '/kontakt/': `<html><body><p>${nom} · Box 3, 211 20 Malmö · <a href="mailto:info@${domaine}">info@${domaine}</a> · Org.nr 556555-1234</p></body></html>`,
});
const allemand = {
  '/': `<html><head><title>Packmaschinen GmbH</title></head><body><p>Packmaschinen GmbH vertreibt Verpackungsmaschinen und förpackningsmaskiner in Deutschland.</p><p>Impressum: USt-IdNr. DE123456789</p></body></html>`,
};
const concurrent = (nom: string, domaine: string) => ({
  '/': `<html><head><title>${nom}</title></head><body><p>${nom} är återförsäljare för Ishida förpackningsmaskiner i Sverige.</p><p>Org.nr 556999-0001 · 111 22 Stockholm · <a href="mailto:info@${domaine}">info@${domaine}</a></p></body></html>`,
});

type Site = Record<string, string>;
interface Monde { sites: Record<string, Site>; lent: Set<string>; pannesRestantes: Map<string, number>; requests: string[] }

function monde(): Monde {
  const sites: Record<string, Site> = {};
  for (let i = 1; i <= 8; i += 1) sites[`bon${i}.se`] = bonSite(`Bon ${i} AB`, `bon${i}.se`, `55612${i}-456${i}`);
  sites['general1.se'] = generaliste('Generalbolaget', 'general1.se');
  sites['packmaschinen.de'] = allemand;
  sites['ishidashop.se'] = concurrent('Ishidashop', 'ishidashop.se');
  sites['lent.se'] = bonSite('Lent AB', 'lent.se', '556777-8888');
  return { sites, lent: new Set(['lent.se']), pannesRestantes: new Map([['lent.se', 1]]), requests: [] };
}

function fetcher(m: Monde) {
  return async (urls: readonly string[], maxPages: number): Promise<FetchedPages> => {
    const pages: FetchedPages['pages'] = [];
    const failures: FetchedPages['failures'] = [];
    let attempts = 0;
    for (const url of urls) {
      if (pages.length >= maxPages) break;
      const u = new URL(url);
      m.requests.push(url);
      attempts += 1;
      const host = u.hostname.replace(/^www\./, '');
      const reste = m.pannesRestantes.get(host) ?? 0;
      if (reste > 0) { m.pannesRestantes.set(host, reste - 1); failures.push({ url, kind: 'TIMEOUT', reason: 'lent' }); continue; }
      const html = m.sites[host]?.[u.pathname] ?? m.sites[host]?.[`${u.pathname}/`];
      if (html) pages.push({ url, html });
      else failures.push({ url, kind: 'HTTP_4XX', reason: 'HTTP 404' });
    }
    return { pages, attempts, failures };
  };
}

/** Un moteur scripté : une page de résultats par appel, la dernière répétée ensuite (le marché s'épuise). */
function moteur(pages: string[][], outcome: SearchResponse['outcome'] = 'ok'): SearchProvider & { calls: number } {
  const p = {
    key: 'searxng', label: 'fixture', calls: 0,
    availability: () => ({ available: true, reason: 'fixture' }),
    async search(request: SearchRequest): Promise<SearchResponse> {
      const page = pages[Math.min(p.calls, pages.length - 1)] ?? [];
      p.calls += 1;
      return {
        results: outcome === 'ok' ? page.map((d, i) => ({ title: d, url: `https://${d}/`, snippet: '', provider: 'fixture', rank: i + 1, query: request.query, retrievedAt: '2026-09-12T00:00:00.000Z' })) : [],
        outcome, detail: outcome, costUsd: 0, durationMs: 1,
      };
    },
  };
  return p;
}

const GO: PreflightVerdict = { verdict: 'GO', lines: [], blocked: [], degraded: [], readiness: 'SEARCH_READY', probes: [], budget: { mission: { usd: 5, source: '--budget' }, batch: { usd: 5, source: '--batch-budget' }, daily: { usd: 0, source: 'ATLAS_AI_DAILY_BUDGET_USD', configured: false } }, sampleQueries: [] };
const NOGO: PreflightVerdict = { ...GO, verdict: 'NO-GO', blocked: ['recherche'], readiness: 'SEARCH_BLOCKED' };

interface Banc { deps: AutopilotDeps & { llmCalls: () => number }; fichiers: Map<string, string>; notifications: string[]; sleeps: number[]; locks: string[] }

function banc(m: Monde, search: SearchProvider, over: Partial<AutopilotDeps> = {}): Banc {
  const scripte = llmFixture();
  // Comme le fournisseur budgété : chaque appel est inscrit au registre avec son coût.
  const llm = {
    get calls() { return scripte.calls; },
    complete: async (r: Parameters<typeof scripte.complete>[0]) => {
      const out = await scripte.complete(r);
      repos.llmCalls.record({
        missionId: r.meta?.missionId ?? null, taskRef: r.meta?.taskRef ?? null, agentKey: 'analyst', purpose: 'client-qualification', provider: 'fixture', model: 'fixture',
        inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01, durationMs: 1, ok: true, error: null, toolCalls: 0,
        subject: r.meta?.subject ?? null, contextChars: 0, evidenceCount: 0, createdAt: new Date().toISOString(),
      });
      return out;
    },
  };
  const fichiers = new Map<string, string>();
  const notifications: string[] = [];
  const sleeps: number[] = [];
  const locks: string[] = [];
  const deps: AutopilotDeps & { llmCalls: () => number } = {
    repos, search, fetchPages: fetcher(m), llm, model: 'fixture', logger, estimatedCostPerCandidateUsd: 0.01,
    now: () => new Date().toISOString(),
    preflight: async () => GO,
    infra: async () => ({ readiness: 'SEARCH_READY', detail: 'fixture' }),
    writeFile: (p, content) => { fichiers.set(p, content); return `out/${p}`; },
    sleep: async (ms) => { sleeps.push(ms); },
    notify: (state, message) => { notifications.push(`${state}: ${message}`); },
    lock: (runId) => { locks.push(runId); return () => {}; },
    scoringModel: BUSINESS_EXPANSION.scoringModel, executionMode: 'live',
    llmCalls: () => llm.calls,
    ...over,
  };
  return { deps, fichiers, notifications, sleeps, locks };
}

const brief = (over: Partial<ClientBrief> = {}): ClientBrief => {
  const v = parseClientBrief({ ...BRIEF_JSON, objective: { targetRetained: 10, targetRetainedMin: 4, maxCandidates: 40 }, ...over });
  assert.ok(v.ok, v.errors.join(' ; '));
  return v.brief!;
};
const options = (extra: Partial<AutopilotOptions> = {}): AutopilotOptions => ({
  level: 2, go: true, runBudgetUsd: 5, batchBudgetUsd: 5, dailyBudgetUsd: 0, cache: false,
  limits: { batchSizeDefault: 10, batchSizeMin: 10, batchSizeMax: 20, partialAtRetained: 5, reviewPauseCount: 10, lowYieldStreak: 3, retryBackoffMs: 100, maxQueriesPerBatch: 1 },
  ...extra,
});

// ─── La mission de bout en bout ──────────────────────────────────────────────

describe('une mission conduite par le pilote, de bout en bout', () => {
  test('brief → plan → mission → lots, panne, reprise → PARTIAL → retour → brief v2 → saturation → FINAL → clôture', async () => {
    const m = monde();
    const search = moteur([
      ['bon1.se', 'bon2.se', 'general1.se', 'europages.se'],
      ['bon3.se', 'lent.se', 'packmaschinen.de', 'bon4.se'],
      ['bon5.se', 'ishidashop.se'],
      ['bon1.se', 'bon2.se'],
    ]);
    const b = banc(m, search);
    const B = brief();

    // 1. Sans --go : le plan, l'estimation, aucune mission.
    const plan = await runAutopilot(b.deps, options({ brief: B, go: false }));
    assert.equal(plan.dryRun, true);
    assert.equal(plan.runId, null);
    assert.ok(plan.estimate && plan.estimate.expectedBatches === 4, 'estimation : 40 candidats en lots de 10');
    assert.equal(repos.missions.list({ limit: 10, offset: 0 }).total, 0, 'rien de créé');
    assert.equal(search.calls, 0, 'aucune recherche réelle');
    assert.equal(b.deps.llmCalls(), 0);

    // 2. --go : preflight, mission, lots enchaînés jusqu'au PARTIAL.
    const r1 = await runAutopilot(b.deps, options({ brief: B }));
    assert.ok(r1.created && r1.runId, 'mission créée');
    const runId = r1.runId!;
    assert.equal(r1.state, 'WAITING_CLIENT_FEEDBACK', r1.messages.join('\n'));
    assert.equal(r1.batchesRun, 3, 'deux lots de découverte et une reprise');
    const ap1 = readAutopilot(loadClientRun(repos, runId).context)!;
    const etats = ap1.history.map((h) => h.to);
    assert.deepEqual(etats.slice(0, 3), ['PREFLIGHT_REQUIRED', 'READY_TO_START', 'RUNNING_DISCOVERY']);
    assert.ok(etats.includes('RETRYING'), 'lent.se a été repris après sa panne');
    assert.ok(etats.includes('PARTIAL_READY'));
    assert.ok(b.sleeps.length === 1 && b.sleeps[0] === 100, 'un temps d’attente avant la reprise');
    const counts1 = countsFor(repos.clientCandidates.forRun(runId));
    assert.equal(counts1.retained, 5, 'bon1–4 et lent : cinq retenues');
    assert.equal(counts1.review, 1, 'le généraliste');
    assert.equal(counts1.pendingRetry, 0);
    assert.ok(ap1.partial?.htmlPath.includes('rapport-PARTIAL-v1'), 'le PARTIAL est écrit');
    assert.ok([...b.fichiers.keys()].some((k) => k.includes('/snapshots/') && k.endsWith('-partial.json')), 'instantané du PARTIAL');
    assert.ok(b.fichiers.has(`client/${runId}/decisions.jsonl`), 'journal des décisions');
    assert.ok(b.notifications.some((n) => n.startsWith('PARTIAL_READY')));
    assert.equal(r1.nextAction.action, 'WAIT_FOR_CLIENT');
    const evenements = repos.events.forMission(runId, 100);
    assert.ok(evenements.length >= 6, 'chaque transition est un événement');
    const appelsApresPartial = b.deps.llmCalls();
    const journal = decisionJournal(repos.clientCandidates.forRun(runId), runId);
    assert.ok(journal.some((l) => l.rule === 'country-evidence' && l.domain === 'packmaschinen.de'));
    assert.ok(journal.some((l) => l.rule === 'filter:never-a-candidate' && l.domain === 'europages.se'));
    assert.ok(journal.filter((l) => l.decision === 'RETAINED').every((l) => l.rule === 'client-triage:auto-approved' && l.evidence));

    // 3. Idempotence : la même commande ne crée rien, ne dépense rien.
    const r2 = await runAutopilot(b.deps, options({ brief: B }));
    assert.equal(r2.runId, runId, 'la mission existante est retrouvée par son brief');
    assert.equal(r2.created, false);
    assert.equal(r2.state, 'WAITING_CLIENT_FEEDBACK');
    assert.equal(b.deps.llmCalls(), appelsApresPartial, 'aucun appel');
    assert.equal(repos.missions.list({ limit: 10, offset: 0 }).total, 1);
    assert.equal(r2.batchesRun, 0);
    assert.equal([...b.fichiers.keys()].filter((k) => /rapport-PARTIAL/.test(k)).length, 3, 'le PARTIAL n’est pas réécrit');

    // 4. Le retour client : une proposition, pas un brief.
    const r3 = await runAutopilot(b.deps, options({ runId, go: false, feedback: 'Trop généralistes ; pas la marque Ishida' }));
    assert.equal(r3.state, 'BRIEF_UPDATE_REQUIRED');
    assert.equal(loadClientRun(repos, runId).brief.version, 1, 'le brief n’a pas changé');
    assert.equal(r3.nextAction.action, 'APPROVE_BRIEF');
    const ap3 = readAutopilot(loadClientRun(repos, runId).context)!;
    assert.deepEqual(ap3.proposal?.adjustment.addCompetitors, ['Ishida']);
    assert.equal(ap3.proposal?.adjustment.preferSpecialist, true);

    // 5. L'approbation humaine : brief v2, et la mission reprend.
    const r4 = await runAutopilot(b.deps, options({ runId, go: false, approveBrief: true }));
    assert.equal(r4.state, 'READY_TO_CONTINUE');
    const v2 = loadClientRun(repos, runId).brief;
    assert.equal(v2.version, 2);
    assert.ok(v2.competitorExclusions.includes('Ishida'));

    // 6. Reprise : le concurrent est écarté seul, puis le marché s'épuise → revue avant le final.
    const r5 = await runAutopilot(b.deps, options({ runId }));
    assert.equal(r5.state, 'HUMAN_REVIEW_REQUIRED', r5.messages.join('\n'));
    const cands = repos.clientCandidates.forRun(runId);
    assert.equal(cands.find((c) => c.domain === 'ishidashop.se')?.category, 'COMPETITOR');
    assert.equal(cands.find((c) => c.domain === 'bon1.se')?.stage, 'RETAINED', 'les retenues de la v1 restent');
    const ap5 = readAutopilot(loadClientRun(repos, runId).context)!;
    assert.equal(ap5.saturation.saturated, true, `${ap5.saturation.reason ?? ''} | ${r5.messages.join(' | ')} | ${ap5.history.slice(-8).map((h) => `${h.to}: ${h.reason}`).join(' | ')}`);
    assert.equal(r5.nextAction.action, 'REVIEW_CANDIDATES');

    // 7. La revue déclarée faite : le pilote conclut, sans redemander.
    const r6 = await runAutopilot(b.deps, options({ runId, reviewDone: true }));
    assert.equal(r6.state, 'FINAL_REVIEW_REQUIRED', r6.messages.join('\n'));
    assert.equal(r6.nextAction.action, 'GENERATE_FINAL');

    // 8. FINAL, puis clôture — jamais envoyé.
    const r7 = await runAutopilot(b.deps, options({ runId, go: false, final: true }));
    assert.equal(r7.state, 'FINAL_READY');
    assert.ok([...b.fichiers.keys()].some((k) => /rapport-FINAL-v2/.test(k)));
    assert.ok(b.notifications.some((n) => n.startsWith('FINAL_READY')));
    const r8 = await runAutopilot(b.deps, options({ runId, go: false, complete: true }));
    assert.equal(r8.state, 'COMPLETED');
    assert.equal(r8.nextAction.action, 'NOTHING');

    // 9. Les mesures de la mission, et les interventions humaines comptées.
    const { context } = loadClientRun(repos, runId);
    const metrics = missionMetrics(context, repos.clientCandidates.forRun(runId), 0);
    assert.equal(metrics.retained, 6, 'bon5 s’est ajoutée après la v2');
    assert.ok(metrics.batches >= 6);
    assert.ok(metrics.humanActions >= 3, `retour, approbation, revue, final, clôture : ${metrics.humanActions}`);
    assert.ok(metrics.qualityScore !== null && metrics.qualityScore > 0);
  });
});

// ─── Les garde-fous, un par un ───────────────────────────────────────────────

describe('les garde-fous du pilote', () => {
  test('la machine d’état est close : chaque transition permise est déclarée, et rien d’autre ne passe', () => {
    for (const s of MISSION_STATES) assert.ok(Array.isArray(MISSION_TRANSITIONS[s]));
    assert.equal(canTransition('COMPLETED', 'RUNNING_DISCOVERY'), false);
    assert.equal(canTransition('WAITING_CLIENT_FEEDBACK', 'RUNNING_DISCOVERY'), false, 'pas de dépense en attendant le client');
    assert.equal(canTransition('PARTIAL_READY', 'WAITING_CLIENT_FEEDBACK'), true);
    assert.equal(canTransition('DRAFT', 'COMPLETED'), false);
  });

  test('un NO-GO n’est jamais contourné : aucune mission créée, l’action est de réparer', async () => {
    const m = monde();
    const b = banc(m, moteur([['bon1.se']]), { preflight: async () => NOGO });
    const r = await runAutopilot(b.deps, options({ brief: brief() }));
    assert.equal(r.runId, null);
    assert.equal(r.state, 'PREFLIGHT_REQUIRED');
    assert.equal(r.nextAction.action, 'FIX_INFRA');
    assert.equal(b.deps.llmCalls(), 0);
    assert.equal(repos.missions.list({ limit: 10, offset: 0 }).total, 0);
  });

  test('pause infra : un lot qui ne trouve rien et des moteurs muets → PAUSED_INFRA, reprise après réparation', async () => {
    const m = monde();
    let bloque = true;
    const search = moteur([['bon1.se', 'bon2.se']], 'unavailable');
    const b = banc(m, search, { infra: async () => (bloque ? { readiness: 'SEARCH_BLOCKED', detail: 'tous muets' } : { readiness: 'SEARCH_READY', detail: 'ok' }) });
    const r = await runAutopilot(b.deps, options({ brief: brief() }));
    assert.equal(r.state, 'PAUSED_INFRA', r.messages.join('\n'));
    assert.equal(r.nextAction.action, 'FIX_INFRA');
    assert.ok(b.notifications.some((n) => n.startsWith('PAUSED_INFRA')));
    // Réparé : le moteur répond, la mission reprend où elle était.
    bloque = false;
    const search2 = moteur([['bon1.se', 'bon2.se'], ['bon1.se']]);
    const b2 = banc(m, search2, { infra: async () => ({ readiness: 'SEARCH_READY', detail: 'ok' }) });
    const r2 = await runAutopilot(b2.deps, options({ runId: r.runId! }));
    assert.notEqual(r2.state, 'PAUSED_INFRA');
    assert.equal(countsFor(repos.clientCandidates.forRun(r.runId!)).retained, 2);
  });

  test('pause budget : le plafond arrête proprement, rien n’est perdu, et le budget ne peut pas être dépassé sans le geste --raise-budget', async () => {
    const m = monde();
    const b = banc(m, moteur([['bon1.se', 'bon2.se', 'bon3.se', 'bon4.se']]));
    // Le registre des appels est vide (fixture) : c'est la réservation par candidat en vol qui borne.
    const r = await runAutopilot(b.deps, options({ brief: brief(), runBudgetUsd: 0.015, batchBudgetUsd: 0.015, concurrency: 4 }));
    assert.equal(r.state, 'PAUSED_BUDGET', r.messages.join('\n'));
    assert.equal(r.nextAction.action, 'INCREASE_BUDGET_REQUIRED');
    const appels = b.deps.llmCalls();
    assert.ok(appels < 4, `${appels} appel(s) : le plafond a mordu`);
    assert.ok(countsFor(repos.clientCandidates.forRun(r.runId!)).pending > 0, 'les autres attendent');
    // Relancer sans relever le plafond : le pilote repart, bute, et s'arrête à nouveau sans dépenser.
    const r2 = await runAutopilot(b.deps, options({ runId: r.runId!, runBudgetUsd: 0.015, batchBudgetUsd: 0.015, concurrency: 4 }));
    assert.equal(r2.state, 'PAUSED_BUDGET');
    assert.equal(b.deps.llmCalls(), appels, 'aucun appel de plus');
    // Le geste humain : un plafond relevé, tracé dans l'historique.
    const r3 = await runAutopilot(b.deps, options({ runId: r.runId!, runBudgetUsd: 5, batchBudgetUsd: 5, raiseBudget: true }));
    assert.notEqual(r3.state, 'PAUSED_BUDGET');
    assert.ok(readAutopilot(loadClientRun(repos, r.runId!).context)!.history.some((h) => /plafond relevé/.test(h.reason)));
    assert.equal(countsFor(repos.clientCandidates.forRun(r.runId!)).retained, 4);
  });

  test('pause revue : trop de dossiers à revoir → HUMAN_REVIEW_REQUIRED, et le pilote ne redemande pas ce qui a été vu', async () => {
    const m = monde();
    for (let i = 2; i <= 4; i += 1) m.sites[`general${i}.se`] = generaliste(`Generalbolaget ${i}`, `general${i}.se`);
    const b = banc(m, moteur([['general1.se', 'general2.se', 'general3.se', 'general4.se', 'bon1.se']]));
    const r = await runAutopilot(b.deps, options({ brief: brief(), limits: { batchSizeDefault: 10, batchSizeMin: 10, reviewPauseRate: 0.4, reviewPauseCount: 10, partialAtRetained: 50, maxQueriesPerBatch: 1 } }));
    assert.equal(r.state, 'HUMAN_REVIEW_REQUIRED', r.messages.join('\n'));
    assert.equal(r.nextAction.action, 'REVIEW_CANDIDATES');
    assert.match(r.nextAction.command ?? '', /client:review/);
    const r2 = await runAutopilot(b.deps, options({ runId: r.runId!, reviewDone: true, limits: { batchSizeDefault: 10, batchSizeMin: 10, partialAtRetained: 50, maxQueriesPerBatch: 1 } }));
    assert.notEqual(r2.state, 'HUMAN_REVIEW_REQUIRED', 'la revue reconnue ne bloque plus');
  });

  test('double exécutant : refusé avec un message clair, sans rien toucher', async () => {
    const m = monde();
    const b = banc(m, moteur([['bon1.se']]), { lock: () => null });
    await assert.rejects(() => runAutopilot(b.deps, options({ brief: brief() })), /autre exécutant/);
  });

  test('coupe-circuit : l’arrêt demandé finit le candidat en cours, écrit, et la reprise ne retraite rien', async () => {
    const m = monde();
    let stop = false;
    const b = banc(m, moteur([['bon1.se', 'bon2.se', 'bon3.se', 'bon4.se']]), { shouldStop: () => stop });
    const llm = b.deps.llm;
    // L'arrêt tombe pendant le premier candidat.
    b.deps.llm = { complete: async (r) => { stop = true; return llm.complete(r); } };
    const r = await runAutopilot(b.deps, options({ brief: brief(), concurrency: 1 }));
    assert.equal(r.state, 'READY_TO_CONTINUE', r.messages.join('\n'));
    const c1 = countsFor(repos.clientCandidates.forRun(r.runId!));
    assert.equal(c1.processed, 1);
    assert.equal(c1.pending, 3, 'les autres attendent, intacts');
    stop = false;
    b.deps.llm = llm;
    const r2 = await runAutopilot(b.deps, options({ runId: r.runId!, concurrency: 1 }));
    assert.equal(countsFor(repos.clientCandidates.forRun(r.runId!)).processed, 4);
    assert.equal(b.deps.llmCalls(), 4, 'quatre appels en tout : rien n’a été repayé');
    assert.notEqual(r2.state, 'READY_TO_CONTINUE');
  });

  test('saturation : trois lots de suite sans rien de neuf → le pilote propose le final, jamais un chiffre artificiel', async () => {
    const m = monde();
    const b = banc(m, moteur([['bon1.se', 'bon2.se'], ['bon1.se']]));
    const r = await runAutopilot(b.deps, options({ brief: brief({ objective: { targetRetained: 50, targetRetainedMin: 1, maxCandidates: 200 } }), limits: { batchSizeDefault: 10, batchSizeMin: 10, partialAtRetained: 50, lowYieldStreak: 3, maxQueriesPerBatch: 1 } }));
    assert.equal(r.state, 'FINAL_REVIEW_REQUIRED', r.messages.join('\n'));
    assert.match(r.nextAction.reason, /saturé/);
    assert.equal(countsFor(repos.clientCandidates.forRun(r.runId!)).retained, 2, 'deux bonnes sociétés, pas cinquante');
  });

  test('objectif atteint : la mission s’arrête au nombre demandé, le final est proposé', async () => {
    const m = monde();
    const b = banc(m, moteur([['bon1.se', 'bon2.se', 'bon3.se'], ['bon4.se', 'bon5.se', 'bon6.se']]));
    const r = await runAutopilot(b.deps, options({ brief: brief({ objective: { targetRetained: 3, targetRetainedMin: 2, maxCandidates: 40 } }), limits: { batchSizeDefault: 10, batchSizeMin: 10, partialAtRetained: 50, maxQueriesPerBatch: 1 } }));
    assert.equal(r.state, 'FINAL_REVIEW_REQUIRED', r.messages.join('\n'));
    assert.equal(r.batchesRun, 1, 'un seul lot a suffi');
    assert.match(r.nextAction.reason, /objectif atteint — 3 retenue/);
  });

  test('le retour client ne change jamais le brief sans approbation ; une simulation ne conduit jamais une vraie mission ; un test interne ne se confond pas avec un client', async () => {
    const m = monde();
    const b = banc(m, moteur([['bon1.se']]));
    const interne = brief();
    const r = await runAutopilot(b.deps, options({ brief: interne, limits: { batchSizeDefault: 10, batchSizeMin: 10, partialAtRetained: 50, maxQueriesPerBatch: 1 } }));
    await runAutopilot(b.deps, options({ runId: r.runId!, go: false, feedback: 'plus de service' }));
    assert.equal(loadClientRun(repos, r.runId!).brief.version, 1);
    // Le même brief, mais présenté comme client réel : ce n'est pas la même mission.
    const reel = brief({ client: { ...interne.client, internalTest: false } });
    await assert.rejects(() => runAutopilot(b.deps, options({ runId: r.runId!, brief: reel })), /ne change pas de client|INTERNAL_TEST/);
    // Une vraie mission en simulation : refusée.
    const sim = banc(m, moteur([['bon1.se']]), { executionMode: 'simulation' });
    await assert.rejects(() => runAutopilot(sim.deps, options({ brief: reel })), /simulation/);
    // Un test interne en simulation : permis.
    const r2 = await runAutopilot(sim.deps, options({ brief: brief({ client: { ...interne.client, name: 'AUTRE_TEST' } }), limits: { batchSizeDefault: 10, batchSizeMin: 10, partialAtRetained: 50, maxQueriesPerBatch: 1 } }));
    assert.ok(r2.runId);
  });

  test('niveau 0 recommande sans lancer ; niveau 1 s’arrête après avoir nommé la prochaine action', async () => {
    const m = monde();
    const b = banc(m, moteur([['bon1.se']]));
    const r0 = await runAutopilot(b.deps, options({ brief: brief(), level: 0 }));
    assert.ok(r0.runId, 'la mission est créée (--go)');
    assert.equal(r0.batchesRun, 0);
    assert.equal(b.deps.llmCalls(), 0);
    assert.equal(r0.nextAction.human, true);
    const r1 = await runAutopilot(b.deps, options({ runId: r0.runId!, level: 1 }));
    assert.equal(r1.batchesRun, 0);
    assert.ok(r1.messages.some((x) => /ASSISTED/.test(x)));
  });

  test('la taille des lots s’adapte dans ses bornes : elle monte quand tout va bien, descend au moindre signe', () => {
    const lot = (over: Partial<BatchSummary> = {}): BatchSummary => ({ batch: 1, briefVersion: 1, startedAt: 'a', finishedAt: 'b', queriesRun: 1, rawResults: 10, discovered: 5, filteredOut: 0, processed: 5, retained: 3, reviewRequired: 0, excluded: 2, failed: 0, costUsd: 0, stoppedBecause: null, ...over });
    const bon = { batch: 1, score: 85, label: 'QUALITY_GOOD' as const, processed: 10, reviewRate: 0.1, errorRate: 0, falseCandidateRate: 0.1, components: {} };
    const mauvais = { ...bon, score: 30, label: 'QUALITY_BAD' as const, reviewRate: 0.5 };
    assert.equal(adaptBatchSize(20, bon, lot(), DEFAULT_LIMITS), 30);
    assert.equal(adaptBatchSize(40, bon, lot(), DEFAULT_LIMITS), 50, 'jamais au-delà du maximum');
    assert.equal(adaptBatchSize(20, mauvais, lot(), DEFAULT_LIMITS), 10);
    assert.equal(adaptBatchSize(10, mauvais, lot(), DEFAULT_LIMITS), 10, 'jamais sous le minimum');
    assert.equal(adaptBatchSize(20, null, lot(), DEFAULT_LIMITS), 20);
  });

  test('la note de lot lit les candidats : un lot de généralistes et de sites hors sujet est mauvais, un lot de retenues sourcées est bon', () => {
    const cand = (stage: string, category: string | null, detail: Record<string, unknown>) => ({ id: 'x', runId: 'r', domain: 'x.se', url: 'https://x.se/', name: 'X', batch: 1, briefVersion: 1, stage, category, reason: null, evidenceQuote: null, evidenceUrl: null, attempts: 0, lastError: null, companyId: null, opportunityId: null, costUsd: 0, detail, discoveredAt: 'a', updatedAt: 'b' }) as never;
    const lot = { batch: 1 } as BatchSummary;
    const bonDossier = { country: { country: 'Suède' }, criteria: [{ kind: 'required', verdict: 'ESTABLISHED', evidence: [1, 2] }], generalistRisk: { score: 5 }, contacts: { method: 'EMAIL' } };
    const bon = assessBatchQuality(lot, [cand('RETAINED', null, bonDossier), cand('RETAINED', null, bonDossier), cand('EXCLUDED', 'COMPETITOR', {})])!;
    assert.equal(bon.label, 'QUALITY_GOOD');
    const mauvais = assessBatchQuality(lot, [
      cand('REVIEW_REQUIRED', 'TOO_GENERAL', { criteria: [{ kind: 'required', verdict: 'TO_CONFIRM', evidence: [] }], generalistRisk: { score: 90 }, contacts: { method: 'NONE' } }),
      cand('REVIEW_REQUIRED', 'TOO_GENERAL', { criteria: [{ kind: 'required', verdict: 'TO_CONFIRM', evidence: [] }], generalistRisk: { score: 90 }, contacts: { method: 'NONE' } }),
      cand('EXCLUDED', 'LOW_RELEVANCE', {}), cand('EXCLUDED', 'DIRECTORY', {}), cand('FAILED_RETRYABLE', null, {}),
    ])!;
    assert.equal(mauvais.label, 'QUALITY_BAD');
    assert.equal(assessBatchQuality(lot, []), null, 'un lot vide ne se juge pas');
  });

  test('la prochaine action est unique et nommée pour chaque état humain', () => {
    const B = brief();
    const counts = { discovered: 10, processed: 8, retained: 3, excluded: 4, review: 1, pendingRetry: 0, failedFinal: 0, pending: 2 };
    const base = { level: 2 as const, since: 'a', history: [], briefKey: 'k', batchSize: 10, batchesRun: 1, humanInterventions: 0, quality: null, qualityHistory: [], yieldHistory: [], saturation: { streak: 0, saturated: false, reason: null }, partial: null, final: null, proposal: null, reviewAcknowledged: 0, stoppedBecause: null, lastError: null };
    const attendu: Array<[MissionState, string]> = [
      ['HUMAN_REVIEW_REQUIRED', 'REVIEW_CANDIDATES'], ['WAITING_CLIENT_FEEDBACK', 'WAIT_FOR_CLIENT'], ['BRIEF_UPDATE_REQUIRED', 'APPROVE_BRIEF'],
      ['FINAL_REVIEW_REQUIRED', 'GENERATE_FINAL'], ['FINAL_READY', 'APPROVE_FINAL'], ['PAUSED_BUDGET', 'INCREASE_BUDGET_REQUIRED'],
      ['PAUSED_INFRA', 'FIX_INFRA'], ['COMPLETED', 'NOTHING'], ['READY_TO_CONTINUE', 'RUN_NEXT_BATCH'],
    ];
    for (const [state, action] of attendu) {
      const n = nextAction({ ...base, state }, counts, B, 'msn_x', DEFAULT_LIMITS);
      assert.equal(n.action, action, state);
      if (state !== 'COMPLETED' && state !== 'READY_TO_CONTINUE') assert.ok(n.human && n.command?.includes('msn_x'), `${state} : une commande humaine nommée`);
    }
    assert.equal(nextAction(null, counts, B, null, DEFAULT_LIMITS).action, 'START_MISSION');
    assert.equal(estimateMission(B, DEFAULT_LIMITS, 3).hardBudgetUsd, 3);
  });
});
