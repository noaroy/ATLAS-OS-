/**
 * Banc de débit de la fabrique de revenu (boucle A).
 *
 *   npx tsx scripts/revenue-factory-bench.ts [--companies=120] [--latency=0,500,2000]
 *
 * Mesure, sur une base jetable, le temps réel d'exécution de la fabrique pour
 * un lot synthétique varié (sites complets, formulaire seul, sans faits, en
 * panne, webmail, une seule recommandation, doublons). La lecture des pages
 * est un banc figé avec une latence injectée par appel : c'est la seule part
 * que ce banc ne mesure pas sur le vrai web, et il le dit.
 *
 * Aucun réseau, aucun modèle, aucun envoi. La projection sur 24 h combine le
 * temps mesuré par entreprise et la cadence réelle du planificateur (un tour
 * de `batchSize` entreprises toutes les 30 minutes).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../packages/core/src/logger.ts';
import { loadAtlasEnv } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import { makeTestConfig } from '../packages/testing/src/index.ts';
import { runRevenueFactory, DEFAULT_FACTORY_LIMITS, FACTORY_DAILY_TARGET } from '../packages/runtime/src/revenue-factory.ts';
import { SALES_SCHEDULE } from '../packages/runtime/src/sales-engine.ts';
import { promoteExpansionBacklog } from '../packages/runtime/src/expansion/engine.ts';
import { site, fixtureFetch, discovered, partners, type SiteKind } from '../packages/runtime/test/helpers/factory-fixtures.ts';

// Convention du dépôt : tout script charge l'environnement. Le banc n'en lit
// rien — sa configuration est celle, isolée, des tests.
loadAtlasEnv();

const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const companies = Number(arg('companies', '120'));
const latencies = arg('latency', '0,500,2000').split(',').map(Number);

/** La composition du lot : ce qu'une découverte réelle verse, en proportions plausibles. */
function kindFor(i: number): { kind: SiteKind; partners: number } {
  const r = i % 20;
  if (r < 11) return { kind: 'FULL', partners: 2 + (i % 2) };   // 55 % : dossier complet
  if (r < 13) return { kind: 'FULL', partners: 1 };             // 10 % : une seule recommandation
  if (r < 15) return { kind: 'FORM_ONLY', partners: 2 };        // 10 % : formulaire seul
  if (r < 17) return { kind: 'NO_FACTS', partners: 2 };         // 10 % : aucun fait publié
  if (r < 18) return { kind: 'DOWN', partners: 2 };             //  5 % : site injoignable
  if (r < 19) return { kind: 'FREEMAIL', partners: 2 };         //  5 % : webmail
  return { kind: 'FULL', partners: 2 };                         //  5 % : doublon (www.)
}

async function bench(latencyMs: number) {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-factory-bench-'));
  const logger = createLogger({ level: 'error', pretty: false });
  const repos = createRepositories(join(dir, 'bench.db'), logger);
  const config = makeTestConfig(dir);
  const sites = [];
  // L'offre arrive comme en production sur l'image serveur : un tour
  // d'expansion SALES terminé, dont les candidats qualifiés sont versés au
  // registre commercial par la découverte serveur ($0). Un sur deux ; l'autre
  // moitié vient d'un lot déjà versé (sales_prospects direct).
  const xRun = repos.expansion.startRun({ purpose: 'SALES', trigger: 'bench', seeds: [], strategies: ['partners'], limits: {} });
  for (let i = 0; i < companies; i++) {
    const { kind, partners: n } = kindFor(i);
    const domain = `pme-${i}.fr`;
    if (i % 2 === 0) {
      const { candidate } = repos.expansion.upsertCandidate({ runId: xRun.id, entityKey: domain, companyName: `PME Industrielle ${i}`, canonicalDomain: domain, website: `https://${domain}`, country: 'FR', depth: 1, seedKey: 'graine.fr' });
      repos.expansion.setCandidateVerdict(candidate.id, { stage: 'QUALIFIED', icpStatus: 'FIT', score: 70, scoreDetail: {} });
      repos.expansion.addRelationship({ runId: xRun.id, sourceKey: 'graine.fr', sourceName: 'Graine', sourceKind: 'COMPANY', targetKey: domain, targetName: `PME Industrielle ${i}`,
        relationshipType: 'COMPLEMENTARY_VENDOR', confidence: 0.8, status: 'VERIFIED', evidenceUrl: 'https://graine.fr/partenaires', evidenceSummary: 'partenaire publié', sourceMethod: 'bench', sourceTrust: 'OFFICIAL', country: 'FR', sourceDate: null });
    } else {
      discovered(repos, domain, `PME Industrielle ${i}`, new Date(Date.UTC(2026, 8, 26, 8, 0, i)).toISOString());
    }
    if (i % 20 === 19) discovered(repos, `www.${domain}`, `PME Industrielle ${i} SAS`, new Date(Date.UTC(2026, 8, 26, 9, 0, i)).toISOString());
    partners(repos, domain, Array.from({ length: n }, (_, k) => ({ domain: `client-${i}-${k}.fr`, name: `Client ${i}-${k}` })));
    sites.push(site(domain, `PME Industrielle ${i}`, kind));
  }
  const counter = { pages: 0, calls: 0 };
  const fetchPages = fixtureFetch(sites, { latencyMs, counter });

  repos.expansion.finishRun(xRun.id, { status: 'DONE', stats: {}, summary: null });
  const promotedBySalesDiscovery = promoteExpansionBacklog(repos, { limit: companies }).promoted.length;
  const promotedAgain = promoteExpansionBacklog(repos, { limit: companies }).promoted.length;

  const rssBefore = process.memoryUsage().rss;
  const started = Date.now();
  let runs = 0;
  let processed = 0;
  let interrupted = false;
  const runMs: number[] = [];
  // Des tours de production, enchaînés sans attendre la cadence de 30 minutes.
  for (;;) {
    const t = Date.now();
    const r = await runRevenueFactory({ repos, config, logger, fetchPages, now: () => new Date('2026-09-26T10:00:00.000Z') });
    runMs.push(Date.now() - t);
    runs += 1;
    processed += r.processed;
    if (r.processed === 0 || runs > 1000) break;
    // Une interruption : un tour ouvert puis abandonné (arrêt brutal). Le tour
    // suivant doit le clore et reprendre la file, sans rien traiter deux fois.
    if (runs === 1 && !interrupted) {
      repos.revenueFactory.startRun('bench:crash', '2026-09-26T09:00:00.000Z');
      interrupted = true;
    }
  }
  const rssAfter = process.memoryUsage().rss;
  const verdicts = repos.revenueFactory.verdicts({ limit: 100_000 });
  const blockerHistogram: Record<string, number> = {};
  for (const v of verdicts) for (const b of v.blockers) blockerHistogram[b.replace(/_\d+(\/\d+)?$|\d+\/\d+$/, '')] = (blockerHistogram[b.replace(/_\d+(\/\d+)?$|\d+\/\d+$/, '')] ?? 0) + 1;
  const uniqueInput = new Set(repos.sales.discoveredSince(null).map((p) => p.domain!.replace(/^www\./, ''))).size;
  const abandonedLeftOpen = repos.revenueFactory.runs(1000).filter((x) => x.status === 'RUNNING').length;
  const messagesSent = repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z');
  const aiCostUsd = repos.llmCalls.usageSince('1970-01-01T00:00:00.000Z').knownCostUsd;
  const elapsedMs = Date.now() - started;
  const stats = repos.revenueFactory.windowStats('1970-01-01T00:00:00.000Z');
  const errors = repos.revenueFactory.runs(1000).filter((x) => x.status === 'FAILED').length;
  const perCompanyMs = elapsedMs / Math.max(1, stats.processed);
  const busyRuns = runMs.filter((_, i) => i < runs - 1);
  const avgRunMs = busyRuns.reduce((a, b) => a + b, 0) / Math.max(1, busyRuns.length);
  const cadenceCapacity = (1440 / SALES_SCHEDULE.FACTORY) * DEFAULT_FACTORY_LIMITS.batchSize;
  const computeCapacity = Math.floor(86_400_000 / perCompanyMs);
  repos.close();
  rmSync(dir, { recursive: true, force: true });
  return {
    latencyMsPerFetchCall: latencyMs,
    companiesInput: companies,
    uniqueCompaniesProcessed: stats.processed,
    runs: runs - 1,
    elapsedMs,
    avgRunMs: Math.round(avgRunMs),
    runFitsWallClock: avgRunMs < DEFAULT_FACTORY_LIMITS.wallClockMs,
    companiesPerHourMeasured: Math.round((stats.processed / elapsedMs) * 3_600_000),
    projectedPerDay: Math.min(cadenceCapacity, computeCapacity),
    projectedBy: cadenceCapacity <= computeCapacity ? `cadence (${1440 / SALES_SCHEDULE.FACTORY} tours × ${DEFAULT_FACTORY_LIMITS.batchSize})` : 'temps mesuré',
    byClass: stats.byClass,
    sendEligible: stats.sendEligible,
    sendEligibleRate: +(stats.sendEligible / stats.processed).toFixed(3),
    contactVerificationRate: +(stats.contactsVerified / stats.processed).toFixed(3),
    recommendationSuccessRate: +(stats.withRecommendations / stats.processed).toFixed(3),
    errorRate: +(errors / Math.max(1, runs)).toFixed(3),
    fetchCalls: counter.calls,
    pagesRead: counter.pages,
    costUsdTotal: stats.costUsd,
    costPerCompanyUsd: +(stats.costUsd / Math.max(1, stats.processed)).toFixed(4),
    meetsTarget: Math.min(cadenceCapacity, computeCapacity) >= FACTORY_DAILY_TARGET,
    promotedBySalesDiscovery,
    promotedAgain,
    duplicatesProcessed: verdicts.length - new Set(verdicts.map((v) => v.domain)).size,
    uniqueCompaniesInRegistry: uniqueInput,
    interruptedRunClosed: interrupted && abandonedLeftOpen === 0,
    rssGrowthMb: +((rssAfter - rssBefore) / 1_048_576).toFixed(1),
    blockerHistogram: Object.fromEntries(Object.entries(blockerHistogram).sort((a, b) => b[1] - a[1])),
    aiCostUsd,
    messagesSent,
  };
}

const results = [];
for (const l of latencies) results.push(await bench(l));
console.log(JSON.stringify(results, null, 2));
