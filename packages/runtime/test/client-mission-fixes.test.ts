import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';
import { BUSINESS_EXPANSION, relevancePrecheck, selectBlocksForModel, buildBlockCatalogue, rankContactChannels, swedishPostalAddresses, type ResolvedContact } from '@atlas/departments';
import { isNeverCandidate } from '@atlas/intelligence';
import {
  createClientRun, runClientBatch, adjustClientRun, buildClientRunReport, proposeBriefAdjustment, spendSoFar,
  type ClientMissionDeps, type FetchedPages,
} from '../src/index.ts';
import { brief, searchFixture, llmFixture } from './fixtures/sweden-mission.ts';

/**
 * Vingt-cinq défauts trouvés à la relecture du pipeline optimisé, chacun
 * fixé par un cas qui échouait avant la correction. Le titre de chaque test
 * dit le défaut ; le corps dit ce qui est garanti désormais.
 */
const logger = createLogger({ level: 'error', pretty: false });
let repos: Repositories;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-client-fixes-'));
  repos = createRepositories(join(dir, 'client.db'), logger);
  repos.departments.ensure(BUSINESS_EXPANSION);
});
afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const SITE = {
  '/': `<html><head><title>Nordpack AB | Start</title></head><body>
    <nav><a href="/produkter/">Produkter</a><a href="/kontakta-oss/">Kontakta oss</a></nav>
    <p>Nordpack AB är distributör av förpackningsmaskiner och kontrollutrustning för kosmetik och läkemedel i Sverige.</p></body></html>`,
  '/produkter/': `<html><body><p>Våra förpackningsmaskiner: flowpack, påsmaskiner och kontrollutrustning för läkemedel. Vi installerar och servar alla maskiner vi levererar.</p></body></html>`,
  '/kontakta-oss/': `<html><body><p>Nordpack AB · Industrigatan 5, 142 50 Skogås · <a href="mailto:info@nordpack.se">info@nordpack.se</a> · +46 8 123 45 67 · Org.nr 556123-4567</p></body></html>`,
};

type Sites = Record<string, Record<string, string | { status: 'TIMEOUT' | 'HTTP_5XX' | 'HTTP_4XX' } | { redirect: string }>>;

function fetcher(sites: Sites, journal: string[] = []) {
  return async (urls: readonly string[], maxPages: number): Promise<FetchedPages> => {
    const pages: FetchedPages['pages'] = [];
    const failures: FetchedPages['failures'] = [];
    let attempts = 0;
    for (const url of urls) {
      if (pages.length >= maxPages) break;
      const u = new URL(url);
      journal.push(url);
      attempts += 1;
      const site = sites[u.hostname.replace(/^www\./, '')];
      const entree = site?.[u.pathname] ?? site?.[`${u.pathname}/`] ?? site?.[u.pathname.replace(/\/$/, '')];
      if (typeof entree === 'string') pages.push({ url, html: entree });
      else if (entree && 'redirect' in entree) pages.push({ url: entree.redirect, html: site![new URL(entree.redirect).pathname] as string });
      else if (entree && 'status' in entree) failures.push({ url, kind: entree.status, reason: entree.status });
      else failures.push({ url, kind: 'HTTP_4XX', reason: 'HTTP 404' });
    }
    return { pages, attempts, failures };
  };
}

function deps(over: Partial<ClientMissionDeps> = {}): ClientMissionDeps & { llmCalls: () => number } {
  const llm = llmFixture();
  return {
    repos, search: searchFixture([]), fetchPages: fetcher({ 'nordpack.se': SITE }), llm, model: 'fixture', logger,
    now: () => new Date().toISOString(), estimatedCostPerCandidateUsd: 0.01, llmCalls: () => llm.calls, ...over,
  };
}
const options = (runId: string, extra: Record<string, unknown> = {}) => ({
  runId, batchSize: 20, runBudgetUsd: 5, batchBudgetUsd: 5, dailyBudgetUsd: 0, createdBy: 'test', cache: false, ...extra,
});

describe('la recherche', () => {
  test('#1 un moteur mort compte pour l’arrêt : trois requêtes vides et le lot cesse de chercher', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const muet = searchFixture([], 'empty');
    const s = await runClientBatch(deps({ search: muet }), options(runId, { maxQueries: 8 }));
    assert.equal(muet.calls, 3, `${muet.calls} requêtes : trois vides suffisent`);
    assert.match(s.metrics?.search.stoppedBecause ?? '', /sans nouveau candidat/);
  });

  test('#22 un hôte de la liste noire se reconnaît à sa frontière, pas en sous-chaîne', () => {
    assert.equal(isNeverCandidate('x.com'), true);
    assert.equal(isNeverCandidate('www.x.com'), true);
    assert.equal(isNeverCandidate('nordix.com'), false, '« nordix.com » n’est pas « x.com »');
    assert.equal(isNeverCandidate('matrix.com'), false);
    assert.equal(isNeverCandidate('greco.se'), false, '« greco.se » n’est pas « reco.se »');
    assert.equal(isNeverCandidate('amazon.se'), true, 'préfixe de label « amazon. »');
    assert.equal(isNeverCandidate('shop.amazon.co.uk'), true);
    assert.equal(isNeverCandidate('amazonas-pack.se'), false);
    assert.equal(isNeverCandidate('press.mynewsdesk.com'), true, 'sous-domaine d’un hôte listé');
  });
});

describe('la mémoire des pages', () => {
  test('#2 après un échec sur la première adresse, la page rendue est rangée sous SA propre adresse — pas sous celle qui a échoué', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    // L'accueil « https://x.se/ » ne répond pas ; l'adresse trouvée par le moteur, elle, répond.
    const sites: Sites = { 'x.se': { '/': { status: 'HTTP_5XX' }, '/om-oss/': SITE['/'], '/kontakta-oss/': SITE['/kontakta-oss/'], '/produkter/': SITE['/produkter/'] } };
    repos.clientCandidates.discover({ runId, domain: 'x.se', url: 'https://x.se/om-oss/', batch: 1, briefVersion: 1 });
    await runClientBatch(deps({ fetchPages: fetcher(sites) }), options(runId, { resumeOnly: true, cache: true }));
    assert.equal(repos.clientCache.getPage('https://x.se/'), null, 'l’accueil en panne n’est pas en mémoire — et surtout pas avec la page d’une autre adresse');
    const omOss = repos.clientCache.getPage('https://x.se/om-oss/');
    assert.ok(omOss?.ok && omOss.html?.includes('Nordpack AB'), 'la page est rangée sous l’adresse qui l’a rendue');
  });

  test('#3 une panne serveur ou un délai ne sont pas mémorisés ; un 404 l’est', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const sites: Sites = { 'nordpack.se': { ...SITE, '/kontakta-oss/': { status: 'HTTP_5XX' }, '/produkter/': { status: 'HTTP_4XX' } } };
    await runClientBatch(deps({ fetchPages: fetcher(sites) }), options(runId, { seedDomains: ['nordpack.se'], resumeOnly: true, cache: true }));
    assert.equal(repos.clientCache.getPage('https://nordpack.se/kontakta-oss/'), null, 'HTTP 5xx : on retentera');
    assert.equal(repos.clientCache.getPage('https://nordpack.se/produkter/')?.ok, false, 'HTTP 404 : mémorisé comme absent');
  });

  test('#4 les mesures distinguent pages lues, pages réseau et entrées en mémoire', async () => {
    const run1 = createClientRun(repos, brief(), 'test');
    await runClientBatch(deps(), options(run1, { seedDomains: ['nordpack.se'], resumeOnly: true, cache: true }));
    const run2 = createClientRun(repos, brief(), 'test');
    const s = await runClientBatch(deps(), options(run2, { seedDomains: ['nordpack.se'], resumeOnly: true, cache: true }));
    assert.equal(s.metrics?.process.pagesFetched, 0, 'rien par le réseau');
    assert.equal(s.metrics?.process.pagesAttempted, 0);
    assert.ok((s.metrics?.process.pagesRead ?? 0) >= 3, 'mais les pages ont bien été lues, depuis la mémoire');
    assert.ok((s.metrics?.process.cacheHits ?? 0) >= 3);
  });

  test('#12 les entrées périmées sont purgées au début d’un lot', async () => {
    repos.clientCache.putPage({ url: 'https://vieux.se/', domain: 'vieux.se', ok: true, html: '<p>x</p>' });
    repos.clientCache.putQualification({ key: 'k', domain: 'vieux.se', briefHash: 'b', contentHash: 'c', model: 'm', output: { criteria: [] } });
    // On vieillit artificiellement les deux entrées.
    const ancienne = new Date(Date.now() - 40 * 86_400_000).toISOString();
    (repos.clientCache as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db.prepare('UPDATE page_cache SET fetched_at = ?').run(ancienne);
    (repos.clientCache as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db.prepare('UPDATE qualification_cache SET created_at = ?').run(ancienne);
    // Et un échec transitoire d'hier, mémorisé avant la correction #3 : il part aussi.
    repos.clientCache.putPage({ url: 'https://panne.se/', domain: 'panne.se', ok: false, kind: 'HTTP_5XX' });
    assert.equal(repos.clientCache.counts().pages, 2);
    const runId = createClientRun(repos, brief(), 'test');
    await runClientBatch(deps(), options(runId, { resumeOnly: true, cache: true }));
    assert.deepEqual(repos.clientCache.counts(), { pages: 0, qualifications: 0 });
  });

  test('#19 la clé de qualification porte les faits en tête : un pays devenu connu repose la question', async () => {
    // Même passages, mais la première lecture n'a pas la page de contact (pays inconnu), la seconde l'a.
    // La page de contact tombe en panne serveur à la première lecture (jamais mémorisée), répond à la seconde.
    const sansContact: Sites = { 'nordpack.se': { '/': SITE['/'], '/produkter/': SITE['/produkter/'], '/kontakta-oss/': { status: 'HTTP_5XX' } } };
    const run1 = createClientRun(repos, brief(), 'test');
    const d1 = deps({ fetchPages: fetcher(sansContact) });
    await runClientBatch(d1, options(run1, { seedDomains: ['nordpack.se'], resumeOnly: true, cache: true }));
    assert.equal(d1.llmCalls(), 1);
    const run2 = createClientRun(repos, brief(), 'test');
    const d2 = deps({ fetchPages: fetcher({ 'nordpack.se': SITE }) });
    const s2 = await runClientBatch(d2, options(run2, { seedDomains: ['nordpack.se'], resumeOnly: true, cache: true }));
    assert.equal(s2.metrics?.process.llmCached, 0, 'les faits diffèrent (pays, adresse) : la question n’est pas la même');
    assert.equal(d2.llmCalls(), 1);
  });

  test('#7 une réponse de modèle illisible est un échec reprenable, jamais une entrée de mémoire', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const muet = { complete: async () => ({ content: [{ type: 'text', text: 'Désolé, je ne peux pas.' }], stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 5 }, model: 'fixture', refusal: null }) };
    const s = await runClientBatch(deps({ llm: muet as unknown as ClientMissionDeps['llm'] }), options(runId, { seedDomains: ['nordpack.se'], resumeOnly: true, cache: true }));
    assert.equal(s.failed, 1);
    const c = repos.clientCandidates.byDomain(runId, 'nordpack.se')!;
    assert.equal(c.stage, 'FAILED_RETRYABLE');
    assert.match(c.lastError ?? '', /illisible/);
    assert.equal(repos.clientCache.counts().qualifications, 0, 'rien de faux en mémoire');
  });
});

describe('la lecture', () => {
  test('#5 une seule page lisible sans aucun terme du brief va en revue P3 — pas en exclusion', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const sites: Sites = { 'muet.se': { '/': '<html><head><title>Muet AB</title></head><body><p>Välkommen. Sidan laddas med script, inget mer att läsa här alls.</p></body></html>' } };
    const d = deps({ fetchPages: fetcher(sites) });
    const s = await runClientBatch(d, options(runId, { seedDomains: ['muet.se'], resumeOnly: true }));
    const c = repos.clientCandidates.byDomain(runId, 'muet.se')!;
    assert.equal(c.stage, 'REVIEW_REQUIRED');
    assert.equal((c.detail as { triage: { priority: string } }).triage.priority, 'P3');
    assert.match(c.reason ?? '', /seule page lisible/);
    assert.equal(d.llmCalls(), 0);
    assert.equal(s.metrics?.filter.relevanceExcluded, 0, 'ce n’est pas une exclusion');
  });

  test('#24 l’adresse trouvée en www. et l’accueil sans www. ne font qu’une requête', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const journal: string[] = [];
    repos.clientCandidates.discover({ runId, domain: 'nordpack.se', url: 'https://www.nordpack.se/', batch: 1, briefVersion: 1 });
    await runClientBatch(deps({ fetchPages: fetcher({ 'nordpack.se': SITE }, journal) }), options(runId, { resumeOnly: true }));
    const accueils = journal.filter((u) => /^https:\/\/(www\.)?nordpack\.se\/?$/.test(u));
    assert.equal(accueils.length, 1, `accueil demandé ${accueils.length} fois : ${accueils.join(', ')}`);
  });

  test('#23 à la reprise, les pages secondaires ont un délai plus long elles aussi', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const delais = new Map<string, number[]>();
    const base = fetcher({ 'nordpack.se': SITE });
    const d = deps({ fetchPages: (urls, max, opts) => { for (const u of urls) delais.set(u, [...(delais.get(u) ?? []), opts?.timeoutMs ?? 0]); return base(urls, max); } });
    const c = repos.clientCandidates.discover({ runId, domain: 'nordpack.se', url: 'https://nordpack.se/', batch: 1, briefVersion: 1 }).candidate;
    repos.clientCandidates.markFailed(c.id, 'site lent'); // une première tentative a échoué
    await runClientBatch(d, options(runId, { resumeOnly: true }));
    assert.equal(delais.get('https://nordpack.se/')?.[0], 20_000);
    assert.equal(delais.get('https://nordpack.se/produkter/')?.[0], 12_000, 'les pages du plan aussi');
  });

  test('#10 « leverantör » et « leverantor » sont un seul terme ; un terme après une barre se lit', () => {
    const r = relevancePrecheck([{ url: 'https://x.se/', html: '<p>Leverantör av påsmaskiner/förpackningsmaskiner till industrin.</p>' }], brief());
    assert.equal(r.roleHits.filter((t) => t.startsWith('leverant')).length, 1);
    assert.ok(r.productHits.includes('förpackningsmaskiner'), 'lu après « / »');
  });

  test('#11 « carton sealing machines » n’est pas un panier : le passage est montré au modèle', () => {
    const cat = buildBlockCatalogue([{ url: 'https://x.se/', html: '<p>Carton sealing machines and förpackningsmaskiner for the food industry, since 1990.</p><p>Din varukorg är tom. Gå till kassan.</p>' }]);
    const s = selectBlocksForModel(cat, brief(), { maxBlocks: 10 });
    assert.match(s.text, /Carton sealing/);
    assert.doesNotMatch(s.text, /varukorg/);
  });

  test('#20 « Roma » et « Ed » ne sont plus des localités suédoises ; « Skogås » l’est toujours', () => {
    assert.equal(swedishPostalAddresses('Via Nazionale 12, 001 84 Roma').length, 0);
    assert.equal(swedishPostalAddresses('Box 1, 668 30 Ed').length, 0);
    assert.equal(swedishPostalAddresses('Box 12, 142 50 Skogås').length, 1);
  });
});

describe('le canal et le budget', () => {
  const contact = (value: string, intent: ResolvedContact['intent'], suitability: ResolvedContact['suitability']): ResolvedContact =>
    ({ type: 'EMAIL', value, sourceUrl: 'https://x.se/kontakt', observed: true, confidence: 'HIGH', label: null, intent, suitability });

  test('#8 une boîte du domaine sans intention lisible n’est pas « hors domaine »', () => {
    const r = rankContactChannels({ emails: [contact('nordic@x.se', 'UNKNOWN', 'LOW')], phones: [], form: null, officialDomain: 'x.se', personName: null, personRole: null });
    assert.equal(r.sameDomain, true);
    assert.equal(r.confidence, 'LOW');
    assert.doesNotMatch(r.why, /hors du domaine/);
    const hors = rankContactChannels({ emails: [contact('sales@groupe.com', 'SALES', 'HIGH')], phones: [], form: null, officialDomain: 'x.se', personName: null, personRole: null });
    assert.equal(hors.sameDomain, false);
  });

  test('#9 / #25 le coût par candidat vient du registre de son étape, et le budget se somme en base sans plafond de lignes', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const enregistre = (taskRef: string, cost: number) => repos.llmCalls.record({
      missionId: runId, taskRef, agentKey: 'analyst', purpose: 'client-qualification', provider: 'anthropic', model: 'm',
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: cost, durationMs: 1, ok: true, error: null, toolCalls: 0, subject: null, contextChars: 0, evidenceCount: 0,
      createdAt: new Date().toISOString(),
    });
    enregistre('client-qualification:a.se', 0.01);
    enregistre('client-qualification:b.se', 0.02);
    enregistre('client-qualification:b.se', 0.03);
    assert.equal(repos.llmCalls.costSince(runId, '1970-01-01T00:00:00.000Z', 'client-qualification:b.se'), 0.05);
    assert.equal(repos.llmCalls.costSince(runId, '1970-01-01T00:00:00.000Z', 'client-qualification:a.se'), 0.01);
    const s = spendSoFar(repos, { runId, batchStartedAt: '1970-01-01T00:00:00.000Z' }, new Date().toISOString());
    assert.equal(s.run, 0.06);
    assert.equal(s.batch, 0.06);
  });
});

describe('la revue et le rapport', () => {
  test('#15 « adjust --keep » retient la société : la commande RETAIN de la file fait ce qu’elle dit', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const sansPays: Sites = { 'okand.se': { '/': `<html><head><title>Okänd AB</title></head><body><p>Okänd AB är distributör av förpackningsmaskiner och kontrollutrustning för kosmetik och läkemedel. Vi installerar och servar alla maskiner.</p><p><a href="mailto:info@okand.se">info@okand.se</a></p></body></html>` } };
    await runClientBatch(deps({ fetchPages: fetcher(sansPays) }), options(runId, { seedDomains: ['okand.se'], resumeOnly: true }));
    assert.equal(repos.clientCandidates.byDomain(runId, 'okand.se')!.stage, 'REVIEW_REQUIRED');
    adjustClientRun(repos, runId, { keepDomains: ['okand.se'] });
    const c = repos.clientCandidates.byDomain(runId, 'okand.se')!;
    assert.equal(c.stage, 'RETAINED');
    assert.equal(c.reason, 'conservée par le client');
    const triage = (c.detail as { triage: { status: string; previous: { status: string } | null } }).triage;
    assert.equal(triage.status, 'HUMAN_APPROVED');
    assert.equal(triage.previous?.status, 'HUMAN_REVIEW', 'ce que le tri avait relevé reste lisible');
    assert.equal(repos.opportunities.get(c.opportunityId!)?.stage, 'scored');
  });

  test('#16 « adjust --exclude » rejette aussi l’opportunité, et gagne sur un --keep du même ajustement', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    await runClientBatch(deps(), options(runId, { seedDomains: ['nordpack.se'], resumeOnly: true }));
    const avant = repos.clientCandidates.byDomain(runId, 'nordpack.se')!;
    assert.equal(avant.stage, 'RETAINED');
    adjustClientRun(repos, runId, { keepDomains: ['nordpack.se'], excludeDomains: ['nordpack.se'] });
    const c = repos.clientCandidates.byDomain(runId, 'nordpack.se')!;
    assert.equal(c.stage, 'EXCLUDED');
    assert.equal(c.category, 'CLIENT_EXCLUDED');
    assert.equal(repos.opportunities.get(c.opportunityId!)?.stage, 'rejected');
  });

  test('#6 / #18 le rapport compte à part les revues sans dossier et n’appelle pas « analysés » les sites injoignables', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const sites: Sites = {
      'nordpack.se': SITE,
      'presume.com': { '/': '<html><head><title>Global Pack</title></head><body><p>Global Pack liefert förpackningsmaskiner weltweit.</p><a href="/contact">Contact</a></body></html>', '/contact': '<html><body><p>Kontakt: Tel +49 221 123456. Wir liefern nach ganz Deutschland.</p></body></html>' },
      'mort.se': { '/': { status: 'TIMEOUT' } },
    };
    await runClientBatch(deps({ fetchPages: fetcher(sites) }), options(runId, { seedDomains: Object.keys(sites), resumeOnly: true }));
    const r = buildClientRunReport(repos, runId, { status: 'PARTIAL', generatedAt: new Date().toISOString(), scoringModel: BUSINESS_EXPANSION.scoringModel, executionMode: 'live' });
    assert.equal(r.retained.length, 1);
    assert.equal(r.reviewRequired.length, 0);
    // Depuis v4.1 : la concordance de pays sans présence locale écarte ; elle
    // n'est plus une « vérification humaine avant lecture ».
    assert.deepEqual(r.pendingHumanCheck.map((c) => c.domain), []);
    assert.equal(repos.clientCandidates.byDomain(runId, 'presume.com')!.stage, 'EXCLUDED');
    assert.deepEqual(r.unreachable.map((c) => c.domain), ['mort.se']);
    assert.equal(r.report.analysedCount, 2, 'nordpack et presume ; mort.se n’a pas été lu');
    assert.ok(r.report.limitations.some((l) => /injoignable/.test(l) && /mort\.se/.test(l)));
  });

  test('#17 (v4.1) une concordance de pays sans présence locale est une exclusion pays, pas une revue', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const sites: Sites = { 'presume.com': { '/': '<html><body><p>Global Pack liefert förpackningsmaskiner weltweit.</p><a href="/contact">Contact</a></body></html>', '/contact': '<html><body><p>Kontakt: Tel +49 221 123456. Wir liefern nach ganz Deutschland.</p></body></html>' } };
    const s = await runClientBatch(deps({ fetchPages: fetcher(sites) }), options(runId, { seedDomains: ['presume.com'], resumeOnly: true }));
    assert.equal(s.metrics?.filter.countryExcluded, 1);
    assert.equal(s.metrics?.quality.humanReview, 0);
    assert.equal(s.metrics?.quality.autoExcluded, 1);
  });

  test('#14 « pas de généralistes » ne devient pas une marque concurrente ; « pas la marque Bizerba » oui', () => {
    const p = proposeBriefAdjustment(brief(), 'pas de généralistes ; pas la marque Bizerba ; exclure Mettler ; pas de grossistes');
    assert.deepEqual(p.adjustment.addCompetitors, ['Bizerba', 'Mettler']);
    assert.equal(p.adjustment.preferSpecialist, true, '« généralistes » est lu comme une préférence, pas comme une marque');
    assert.ok(p.unmapped.includes('pas de grossistes'), 'un nom commun n’est pas une marque : rendu tel quel');
  });

  test('#21 un mot-outil du libellé ne relève pas le poids d’un critère', () => {
    const b = { ...brief(), preferredCriteria: [{ key: 'delai', label: 'Livre dans la semaine pour les pièces', weight: 1 }] };
    const p = proposeBriefAdjustment(b, 'Nous préférons ceux qui répondent dans la journée');
    assert.equal(p.adjustment.reweight.length, 0, '« dans » ne désigne aucun critère');
    const q = proposeBriefAdjustment(b, 'Nous préférons ceux qui livrent vite');
    assert.deepEqual(q.adjustment.reweight.map((r) => r.key), ['delai']);
  });
});
