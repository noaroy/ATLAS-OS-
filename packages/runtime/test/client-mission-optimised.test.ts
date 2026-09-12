import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';
import { BUSINESS_EXPANSION } from '@atlas/departments';
import {
  createClientRun, runClientBatch, buildReviewQueue, renderReviewQueue, proposeBriefAdjustment, budgetStop,
  type ClientMissionDeps, type FetchedPages,
} from '../src/index.ts';
import { brief, searchFixture, llmFixture, SITES, TOUS } from './fixtures/sweden-mission.ts';

/**
 * Ce que l'optimisation a promis, garanti par un test : lire moins, lire
 * en parallèle, ne pas attendre un site mort, ne pas repayer ce qui est su,
 * n'appeler le modèle que quand il reste quelque chose à juger, et trier ce
 * qui sort de sorte qu'un humain ne relise que ce qui le mérite.
 */
const logger = createLogger({ level: 'error', pretty: false });
let repos: Repositories;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-client-opt-'));
  repos = createRepositories(join(dir, 'client.db'), logger);
  repos.departments.ensure(BUSINESS_EXPANSION);
});
afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Un site avec des liens : l'accueil désigne ses pages, comme un vrai. */
const SITE_LIE = {
  '/': `<html><head><title>Nordpack AB | Start</title></head><body>
    <nav><a href="/produkter/">Produkter</a><a href="/kontakta-oss/">Kontakta oss</a><a href="/om-oss/">Om oss</a><a href="/service/">Service</a><a href="/nyheter/">Nyheter</a></nav>
    <p>Nordpack AB är distributör av förpackningsmaskiner och kontrollutrustning för kosmetik och läkemedel i Sverige.</p></body></html>`,
  '/produkter/': `<html><body><p>Våra förpackningsmaskiner: flowpack, påsmaskiner och kontrollutrustning för läkemedel. Vi installerar och servar alla maskiner vi levererar.</p></body></html>`,
  '/kontakta-oss/': `<html><body><p>Nordpack AB · Industrigatan 5, 142 50 Skogås · <a href="mailto:info@nordpack.se">info@nordpack.se</a> · +46 8 123 45 67 · Org.nr 556123-4567</p></body></html>`,
  '/om-oss/': `<html><body><p>Nordpack grundades 1985 i Skogås.</p></body></html>`,
  '/service/': `<html><body><p>Service och underhåll av förpackningsmaskiner.</p></body></html>`,
};

interface Journal { requests: string[]; concurrent: number; maxConcurrent: number }

/** Un lecteur de pages instrumenté : il note chaque adresse demandée et le parallélisme atteint. */
function fetchJournal(journal: Journal, options: { slow?: Set<string>; sites?: Record<string, Record<string, string>>; delayMs?: number } = {}) {
  const sites = options.sites ?? { 'nordpack.se': SITE_LIE };
  return async (urls: readonly string[], maxPages: number, opts?: { timeoutMs?: number }): Promise<FetchedPages> => {
    const pages: FetchedPages['pages'] = [];
    const failures: FetchedPages['failures'] = [];
    let attempts = 0;
    for (const url of urls) {
      if (pages.length >= maxPages) break;
      const u = new URL(url);
      journal.requests.push(url);
      attempts += 1;
      journal.concurrent += 1;
      journal.maxConcurrent = Math.max(journal.maxConcurrent, journal.concurrent);
      await new Promise((r) => setTimeout(r, options.delayMs ?? 5));
      journal.concurrent -= 1;
      if (options.slow?.has(u.hostname)) {
        // Un site lent : il ne répond pas dans le délai, quel qu'il soit.
        failures.push({ url, kind: 'TIMEOUT', reason: `exceeded ${opts?.timeoutMs ?? 0}ms` });
        continue;
      }
      const site = (sites as Record<string, Record<string, string>>)[u.hostname] ?? (SITES[u.hostname] ? { '/': SITES[u.hostname]! } : null);
      const html = site?.[u.pathname] ?? site?.[`${u.pathname}/`];
      if (html) pages.push({ url, html });
      else failures.push({ url, kind: 'HTTP_4XX', reason: 'HTTP 404' });
    }
    return { pages, attempts, failures };
  };
}

function deps(journal: Journal, over: Partial<ClientMissionDeps> = {}, fetchOptions: Parameters<typeof fetchJournal>[1] = {}): ClientMissionDeps & { llmCalls: () => number } {
  const llm = llmFixture();
  return {
    repos, search: searchFixture([]), fetchPages: fetchJournal(journal, fetchOptions), llm, model: 'fixture', logger,
    now: () => new Date().toISOString(), estimatedCostPerCandidateUsd: 0.01,
    llmCalls: () => llm.calls, ...over,
  };
}
const journalVide = (): Journal => ({ requests: [], concurrent: 0, maxConcurrent: 0 });
const options = (runId: string, extra: Record<string, unknown> = {}) => ({
  runId, batchSize: 20, runBudgetUsd: 5, batchBudgetUsd: 5, dailyBudgetUsd: 0, createdBy: 'test', ...extra,
});

describe('lire moins : les pages que le site désigne, jamais vingt-cinq chemins devinés', () => {
  test('l’accueil, puis contact et produits par leurs liens ; les actualités ne sont pas lues', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const j = journalVide();
    const d = deps(j);
    const s = await runClientBatch(d, options(runId, { seedDomains: ['nordpack.se'], resumeOnly: true, cache: false }));
    assert.equal(s.processed, 1);
    const chemins = j.requests.map((u) => new URL(u).pathname);
    assert.ok(chemins.includes('/'), 'accueil');
    assert.ok(chemins.includes('/kontakta-oss/'), 'la page de contact désignée par le site');
    assert.ok(chemins.includes('/produkter/'), 'la page produits désignée par le site');
    assert.ok(!chemins.includes('/nyheter/'), 'les actualités ne disent rien de la société');
    assert.ok(!chemins.some((c) => /nous-contacter|mentions-legales|impressum/.test(c)), 'aucun chemin français ou allemand deviné');
    assert.ok(j.requests.length <= 5, `au plus cinq requêtes, ${j.requests.length} faites`);
    assert.equal(s.metrics?.process.pagesAttempted, j.requests.length);
    assert.ok((s.metrics?.process.pagesFetched ?? 0) >= 3);
  });

  test('le pays vient de l’adresse suédoise lue sur la page de contact, et la société est approuvée seule', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    await runClientBatch(deps(journalVide()), options(runId, { seedDomains: ['nordpack.se'], resumeOnly: true, cache: false }));
    const c = repos.clientCandidates.byDomain(runId, 'nordpack.se')!;
    const detail = c.detail as { country: { country: string; basis: string }; triage: { status: string }; contacts: { value: string; confidence: string } };
    assert.equal(c.stage, 'RETAINED');
    assert.equal(detail.country.country, 'Suède');
    assert.equal(detail.triage.status, 'AUTO_APPROVED');
    assert.equal(detail.contacts.value, 'info@nordpack.se');
  });

  test('un site hors sujet est écarté sans appel modèle, avec les termes cherchés dans la raison', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const sites = { 'frisor.se': { '/': '<html><head><title>Frisör i Lund</title></head><body><p>Välkommen till vår frisörsalong i Lund. Boka tid online. Vi klipper barn och vuxna.</p><a href="/priser/">Priser</a></body></html>', '/priser/': '<p>Klippning 400 kr. Färgning 900 kr.</p>' } };
    const d = deps(journalVide(), {}, { sites });
    const s = await runClientBatch(d, options(runId, { seedDomains: ['frisor.se'], resumeOnly: true, cache: false }));
    assert.equal(s.excluded, 1);
    assert.equal(d.llmCalls(), 0);
    const c = repos.clientCandidates.byDomain(runId, 'frisor.se')!;
    assert.equal(c.category, 'LOW_RELEVANCE');
    assert.match(c.reason ?? '', /aucun terme du brief/);
    assert.match(c.reason ?? '', /förpackningsmaskiner/);
    assert.equal(s.metrics?.filter.relevanceExcluded, 1);
  });
});

describe('le pays : une preuve écarte seule, une présomption va en revue', () => {
  test('un USt-IdNr allemand écarte ; un simple +49 avec une mention « Deutschland » met en revue P3, sans appel modèle', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const sites = {
      'prouve.de': { '/': '<html><head><title>Packmaschinen GmbH</title></head><body><p>Wir vertreiben Verpackungsmaschinen und förpackningsmaskiner.</p><p>Impressum: USt-IdNr. DE123456789</p></body></html>' },
      'presume.com': { '/': '<html><head><title>Global Pack</title></head><body><p>Global Pack liefert förpackningsmaskiner weltweit.</p><a href="/contact">Contact</a></body></html>', '/contact': '<html><body><p>Kontakt: Tel +49 221 123456. Wir liefern nach ganz Deutschland.</p></body></html>' },
    };
    const d = deps(journalVide(), {}, { sites });
    const s = await runClientBatch(d, options(runId, { seedDomains: Object.keys(sites), resumeOnly: true, cache: false }));
    assert.equal(d.llmCalls(), 0, 'aucun des deux ne coûte un appel');
    const prouve = repos.clientCandidates.byDomain(runId, 'prouve.de')!;
    assert.equal(prouve.stage, 'EXCLUDED');
    assert.match(prouve.reason ?? '', /prouvé par identifiant national : Allemagne/);
    const presume = repos.clientCandidates.byDomain(runId, 'presume.com')!;
    assert.equal(presume.stage, 'REVIEW_REQUIRED');
    assert.match(presume.reason ?? '', /concordance/);
    assert.equal((presume.detail as { triage: { priority: string } }).triage.priority, 'P3');
    assert.equal(s.metrics?.filter.countryExcluded, 1, 'la présomption est une revue, pas une exclusion');
  });
});

describe('en parallèle, sans bombarder : quatre candidats de front, deux pages par site', () => {
  test('le parallélisme atteint est celui demandé, et jamais plus de deux requêtes sur un même site', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const sites: Record<string, Record<string, string>> = {};
    for (let i = 0; i < 8; i += 1) sites[`s${i}.se`] = SITE_LIE;
    const j = journalVide();
    const d = deps(j, {}, { sites, delayMs: 20 });
    const s = await runClientBatch(d, options(runId, { seedDomains: Object.keys(sites), resumeOnly: true, cache: false, concurrency: 4 }));
    assert.equal(s.processed, 8);
    assert.ok(j.maxConcurrent >= 3, `parallélisme atteint ${j.maxConcurrent}`);
    assert.ok(j.maxConcurrent <= 8, 'quatre candidats × deux pages au plus');
    assert.equal(s.metrics?.timing.concurrency, 4);
    // Chaque candidat a bien été écrit, aucun n'a écrasé l'autre.
    assert.equal(repos.clientCandidates.forRun(runId).filter((c) => c.stage === 'RETAINED' || c.stage === 'REVIEW_REQUIRED').length, 8);
  });

  test('concurrency=1 reste strictement séquentiel', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const sites: Record<string, Record<string, string>> = { 'a.se': { '/': SITES['nordpack.se']! }, 'b.se': { '/': SITES['nordpack.se']! } };
    const j = journalVide();
    await runClientBatch(deps(j, {}, { sites, delayMs: 10 }), options(runId, { seedDomains: ['a.se', 'b.se'], resumeOnly: true, cache: false, concurrency: 1 }));
    assert.equal(j.maxConcurrent, 1);
  });
});

describe('un site lent ne bloque pas le lot', () => {
  test('délai court à la première lecture, échec reprenable, les autres candidats passent ; à la reprise le délai est long', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const j = journalVide();
    const lent = new Set(['lent.se']);
    const d = deps(j, {}, { slow: lent, sites: { 'lent.se': SITE_LIE, 'nordpack.se': SITE_LIE } });
    const delais: number[] = [];
    const original = d.fetchPages;
    d.fetchPages = (urls, max, opts) => { if (urls.some((u) => u.includes('lent.se'))) delais.push(opts?.timeoutMs ?? 0); return original(urls, max, opts); };
    const s = await runClientBatch(d, options(runId, { seedDomains: ['lent.se', 'nordpack.se'], resumeOnly: true, cache: false }));
    assert.equal(s.failed, 1);
    assert.equal(s.retained, 1, 'l’autre candidat est passé');
    const c = repos.clientCandidates.byDomain(runId, 'lent.se')!;
    assert.equal(c.stage, 'FAILED_RETRYABLE');
    assert.match(c.lastError ?? '', /site lent/);
    assert.equal(delais[0], 10_000, 'dix secondes la première fois');
    assert.ok(j.requests.filter((u) => u.includes('lent.se')).length <= 2, 'on n’insiste pas sur un site qui ne répond pas');
    // La reprise : délai long, et toujours un échec reprenable — jamais un blocage.
    await runClientBatch(d, options(runId, { resumeOnly: true, cache: false }));
    assert.equal(delais[delais.length - 1], 20_000, 'vingt secondes à la reprise');
    assert.equal(repos.clientCandidates.byDomain(runId, 'lent.se')!.stage, 'FAILED_RETRYABLE');
    assert.equal(s.metrics?.process.fetchTimeouts, 1);
  });
});

describe('la mémoire : ne pas relire, ne pas repayer', () => {
  test('une seconde mission sur le même site ne refait aucune requête ni aucun appel modèle', async () => {
    const run1 = createClientRun(repos, brief(), 'test');
    const j1 = journalVide();
    const d1 = deps(j1);
    await runClientBatch(d1, options(run1, { seedDomains: ['nordpack.se'], resumeOnly: true }));
    assert.equal(d1.llmCalls(), 1);
    assert.ok(j1.requests.length >= 3);

    const run2 = createClientRun(repos, brief(), 'test');
    const j2 = journalVide();
    const d2 = deps(j2);
    const s2 = await runClientBatch(d2, options(run2, { seedDomains: ['nordpack.se'], resumeOnly: true }));
    assert.equal(j2.requests.length, 0, 'toutes les pages viennent de la mémoire');
    assert.equal(d2.llmCalls(), 0, 'la qualification vient de la mémoire');
    assert.equal(s2.metrics?.process.llmCached, 1);
    assert.ok((s2.metrics?.process.cacheHits ?? 0) >= 3);
    assert.equal(repos.clientCandidates.byDomain(run2, 'nordpack.se')!.stage, 'RETAINED');
    const detail = repos.clientCandidates.byDomain(run2, 'nordpack.se')!.detail as { qualificationCache: string };
    assert.equal(detail.qualificationCache, 'HIT');
  });

  test('un brief différent repose la question au modèle, même sur les mêmes pages', async () => {
    const run1 = createClientRun(repos, brief(), 'test');
    await runClientBatch(deps(journalVide()), options(run1, { seedDomains: ['nordpack.se'], resumeOnly: true }));
    const autre = { ...brief(), productKeywords: ['etikettering'], requiredCriteria: [{ key: 'etiquettes', label: 'Vend des étiqueteuses', weight: 3 }] };
    const run2 = createClientRun(repos, autre, 'test');
    const d2 = deps(journalVide());
    const s2 = await runClientBatch(d2, options(run2, { seedDomains: ['nordpack.se'], resumeOnly: true }));
    assert.equal(s2.metrics?.process.llmCached, 0);
    assert.ok((s2.metrics?.process.cacheHits ?? 0) >= 1, 'les pages, elles, sont en mémoire');
  });

  test('--no-cache contourne tout, et une reprise après échec relit les pages depuis la mémoire', async () => {
    const run = createClientRun(repos, brief(), 'test');
    const j = journalVide();
    await runClientBatch(deps(j), options(run, { seedDomains: ['nordpack.se'], resumeOnly: true, cache: false }));
    const j2 = journalVide();
    await runClientBatch(deps(j2), options(createClientRun(repos, brief(), 'test'), { seedDomains: ['nordpack.se'], resumeOnly: true, cache: false }));
    assert.equal(j2.requests.length, j.requests.length, 'sans mémoire, tout est relu');
  });

  test('un délai dépassé n’est pas mémorisé : le site peut répondre demain', async () => {
    const run = createClientRun(repos, brief(), 'test');
    await runClientBatch(deps(journalVide(), {}, { slow: new Set(['lent.se']), sites: { 'lent.se': SITE_LIE } }), options(run, { seedDomains: ['lent.se'], resumeOnly: true }));
    assert.equal(repos.clientCache.getPage('https://lent.se/'), null);
  });
});

describe('le budget avec des appels en vol', () => {
  test('un appel parti compte comme dépensé avant d’être écrit', () => {
    const guard = { runId: 'r', batchStartedAt: '2026-01-01T00:00:00.000Z', runBudgetUsd: 0.025, batchBudgetUsd: 1, dailyBudgetUsd: 0, estimate: 0.01 };
    assert.equal(budgetStop(repos, { ...guard, inFlight: 0 }, new Date().toISOString()), null);
    assert.equal(budgetStop(repos, { ...guard, inFlight: 1 }, new Date().toISOString()), null);
    assert.match(budgetStop(repos, { ...guard, inFlight: 2 }, new Date().toISOString()) ?? '', /plafond de mission/);
  });

  test('avec quatre candidats de front, le plafond du lot arrête proprement et tout reste reprenable', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const sites: Record<string, Record<string, string>> = {};
    for (let i = 0; i < 6; i += 1) sites[`s${i}.se`] = SITE_LIE;
    const lent = llmFixture();
    const llm = { complete: async (r: Parameters<typeof lent.complete>[0]) => { await new Promise((x) => setTimeout(x, 40)); return lent.complete(r); } };
    const d = deps(journalVide(), { llm }, { sites });
    // Le registre des appels est vide (fixture) : c'est la réservation des appels en vol qui borne.
    const s = await runClientBatch(d, options(runId, { seedDomains: Object.keys(sites), resumeOnly: true, cache: false, concurrency: 4, batchBudgetUsd: 0.035 }));
    assert.ok(s.stoppedBecause, 'le lot dit pourquoi il s’est arrêté');
    assert.match(s.stoppedBecause ?? '', /plafond du lot/);
    assert.ok(s.processed < 6);
    assert.ok(repos.clientCandidates.pending(runId, 10).length > 0, 'les autres attendent');
    assert.equal(repos.clientCandidates.forRun(runId).filter((c) => c.stage === 'FAILED_RETRYABLE').length, 0, 'le plafond n’est pas une panne du candidat');
  });
});

describe('la recherche s’arrête quand elle ne rapporte plus', () => {
  test('trois requêtes de suite sans nouveau candidat : arrêt, raison écrite', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const memes = searchFixture([TOUS[0]!, TOUS[1]!]);
    const s = await runClientBatch(deps(journalVide(), { search: memes }), options(runId, { maxQueries: 8, cache: false }));
    assert.equal(memes.calls, 4, `${memes.calls} requêtes : 1 utile + 3 sans rendement, pas 8`);
    assert.match(s.metrics?.search.stoppedBecause ?? '', /sans nouveau candidat/);
    assert.deepEqual(s.metrics?.search.yields.slice(0, 1), [2]);
  });

  test('lot plein : la recherche s’arrête avant d’épuiser le plan', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const moteur = searchFixture(TOUS);
    const s = await runClientBatch(deps(journalVide(), { search: moteur }), options(runId, { batchSize: 2, maxQueries: 8, cache: false }));
    assert.equal(s.discovered, 2);
    assert.equal(s.metrics?.search.stoppedBecause, 'lot plein');
  });
});

describe('la file de revue et le retour client', () => {
  test('la file ne contient que les candidats à revoir, P1 en tête, avec raison, preuves, contact et commandes', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    // Un site sans adresse ni org.nr : tout établi, pays non prouvé → P1.
    const sansPays = { '/': `<html><head><title>Okänd AB</title></head><body><p>Okänd AB är distributör av förpackningsmaskiner och kontrollutrustning för kosmetik och läkemedel. Vi installerar och servar alla maskiner.</p><p><a href="mailto:info@okand.se">info@okand.se</a></p></body></html>` };
    await runClientBatch(deps(journalVide(), {}, { sites: { 'okand.se': sansPays, 'nordpack.se': SITE_LIE } }), options(runId, { seedDomains: ['okand.se', 'nordpack.se'], resumeOnly: true, cache: false }));
    const file = buildReviewQueue(repos, runId);
    assert.equal(file.length, 1);
    const [item] = file;
    assert.equal(item!.domain, 'okand.se');
    assert.equal(item!.priority, 'P1');
    assert.ok(item!.reasons.some((r) => /pays/.test(r)));
    assert.ok(item!.evidence.length >= 1 && item!.evidence.length <= 5);
    assert.match(item!.contact, /info@okand.se/);
    assert.match(item!.commands.retain, /adjust --run=.* --keep=okand.se/);
    assert.match(item!.commands.exclude, /--exclude=okand.se/);
    const rendu = renderReviewQueue(repos, runId, '2026-09-12T10:00:00.000Z');
    assert.match(rendu.html, /File de revue/);
    assert.match(rendu.html, /okand.se/);
    assert.match(rendu.csv, /^priorite,entreprise/);
  });

  test('le retour client devient une proposition de brief v2 — écrite, jamais appliquée', () => {
    const b = brief();
    const p = proposeBriefAdjustment(b, 'Trop généralistes. Nous préférons ceux qui assurent le service et l’installation ; pas la marque Bizerba ; garder nordpack.se');
    assert.equal(p.toVersion, b.version + 1);
    assert.equal(p.adjustment.preferSpecialist, true);
    assert.deepEqual(p.adjustment.addCompetitors, ['Bizerba']);
    assert.deepEqual(p.adjustment.keepDomains, ['nordpack.se']);
    assert.ok(p.adjustment.reweight.some((r) => r.key === 'service' && r.to > r.from));
    assert.match(p.command, /--competitors="Bizerba"/);
    assert.match(p.command, /--keep=nordpack.se/);
    assert.match(p.command, /--prefer-specialist=true/);
    // Rien n'a bougé dans la mission.
    assert.equal(b.competitorExclusions.includes('Bizerba'), false);
  });

  test('une phrase qu’aucune règle ne lit est rendue telle quelle, pas devinée', () => {
    const p = proposeBriefAdjustment(brief(), 'Le rapport était très clair merci');
    assert.deepEqual(p.unmapped, ['Le rapport était très clair merci']);
    assert.equal(p.rules.length, 0);
  });
});
