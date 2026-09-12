/**
 * Une mission client, par lots, reprenable.
 *
 *   npm run client:mission -- start  --brief=briefs/acrn-sweden.json
 *   npm run client:mission -- batch  --run=<id> [--size=20] [--budget=1.00] [--batch-budget=0.40] [--queries=8] [--exclude=a.se,b.se] --go
 *   npm run client:mission -- batch  --run=<id> --resume --go
 *   npm run client:mission -- batch  --run=<id> --domains=a.se,b.se --go       qualifie des sociétés nommées, sans recherche
 *   npm run client:mission -- batch  --run=<id> [--concurrency=4] [--no-cache] --go
 *   npm run client:mission -- status --run=<id>
 *   npm run client:mission -- adjust --run=<id> [--keep=a.se,b.se] [--exclude=c.se] [--competitors=Marque1,Marque2] [--keywords=mot1,mot2] [--notes="…"]
 *   npm run client:mission -- cost   --run=<id>
 *   npm run client:mission -- review --run=<id>                 la file de revue, P1 d'abord, avec les commandes
 *   npm run client:mission -- metrics --run=<id>                les mesures de chaque lot, comparables
 *   npm run client:mission -- propose --run=<id> --feedback="trop généraliste ; pas la marque X"
 *                                                               un brief v2 proposé, jamais appliqué seul
 *
 * Sans --go, un lot est un contrôle : il dit ce qu'il ferait et ce que ça
 * coûterait, et ne dépense rien. Avec --go, chaque candidat est écrit dès
 * qu'il est traité ; une interruption laisse la mission reprenable par
 * --resume, sans rien retraiter ni repayer.
 *
 * Rien n'est envoyé, rien n'est soumis. Ce script produit des fiches.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createSystem } from '../packages/server/src/bootstrap.ts';
import { loadConfig, loadAtlasEnv } from '../packages/core/src/index.ts';
import { createSearchFabric } from '../packages/intelligence/src/search/fabric/factory.ts';
import { fetchRawPages } from '../packages/intelligence/src/contact-fetch.ts';
import { parseClientBrief, normaliseDomain } from '../packages/departments/src/index.ts';
import {
  createClientRun, loadClientRun, adjustClientRun, runClientBatch, spendSoFar, startOfUtcDay,
  CLIENT_BATCH_DEFAULTS, clientBudgetLimits, buildReviewQueue, proposeBriefAdjustment,
} from '../packages/runtime/src/index.ts';

loadAtlasEnv();

const c = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m' };
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const flag = (n: string) => process.argv.includes(`--${n}`);
const liste = (n: string) => (arg(n) ?? '').split(',').map((x) => x.trim()).filter(Boolean);
/** Un entier d'argument, borné — jamais NaN : `--concurrency=abc` donnait zéro travailleur et un lot muet. */
const entier = (n: string, defaut: number, min: number, max: number): number => {
  const brut = arg(n);
  if (brut === undefined || brut === '') return defaut;
  const v = Number(brut);
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`--${n}=${brut} : un entier entre ${min} et ${max}`);
  return v;
};
const commande = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'status';
const MODEL = 'claude-haiku-4-5-20251001';

async function main(): Promise<void> {
  const config = loadConfig();
  const system = createSystem(config);
  const { repos } = system;

  try {
    if (commande === 'start') {
      const chemin = arg('brief');
      if (!chemin || !existsSync(chemin)) throw new Error('--brief=<fichier.json> requis');
      const v = parseClientBrief(JSON.parse(readFileSync(chemin, 'utf8')));
      if (!v.ok) throw new Error(`brief invalide :\n  ${v.errors.join('\n  ')}`);
      const brief = v.brief!;
      repos.departments.ensure((await import('../packages/departments/src/index.ts')).BUSINESS_EXPANSION);
      const runId = createClientRun(repos, brief, process.env.ATLAS_FOUNDER_EMAIL ?? 'founder');
      console.log(`\n  ${c.bold}MISSION CLIENT CRÉÉE${c.reset}  ${runId}`);
      console.log(`  ${brief.client.name} · ${brief.market.countryLabel} · ${brief.targetRoles.join(', ')}${brief.client.internalTest ? ` · ${c.amber}INTERNAL_TEST${c.reset}` : ''}`);
      console.log(`  critères : ${brief.requiredCriteria.length} requis, ${brief.preferredCriteria.length} souhaités, ${brief.exclusionCriteria.length} d’exclusion · concurrents : ${brief.competitorExclusions.length}`);
      console.log(`\n  Ensuite : npm run client:mission -- batch --run=${runId} --go\n`);
      return;
    }

    const runId = arg('run');
    if (!runId) throw new Error('--run=<id> requis');

    if (commande === 'status' || commande === 'cost') {
      const { context, brief } = loadClientRun(repos, runId);
      const counts = repos.clientCandidates.counts(runId);
      const spend = spendSoFar(repos, { runId, batchStartedAt: '1970-01-01T00:00:00.000Z' }, new Date().toISOString());
      console.log(`\n  ${c.bold}MISSION ${runId}${c.reset}  ${brief.client.name} · ${brief.market.countryLabel} · brief v${brief.version}${brief.client.internalTest ? ` · ${c.amber}INTERNAL_TEST${c.reset}` : ''}`);
      console.log(`  lots : ${context.batches.length}`);
      for (const b of context.batches) {
        console.log(`    ${c.dim}#${b.batch} v${b.briefVersion} · ${b.queriesRun} requête(s), ${b.rawResults} résultat(s) bruts, ${b.discovered} nouveaux, ${b.filteredOut} annuaires · traités ${b.processed} : ${b.retained} retenus, ${b.reviewRequired} à revoir, ${b.excluded} écartés, ${b.failed} en échec · ${b.costUsd.toFixed(4)} $${b.stoppedBecause ? ` · arrêt : ${b.stoppedBecause}` : ''}${c.reset}`);
      }
      console.log(`  candidats :`);
      for (const [stage, n] of Object.entries(counts)) if (n > 0) console.log(`    ${stage.padEnd(18)} ${n}`);
      console.log(`  coût modèle : ${spend.run.toFixed(4)} $ (mission) · ${spend.day.toFixed(4)} $ (aujourd’hui, toutes missions)`);
      if (commande === 'status') {
        const prets = repos.clientCandidates.forRun(runId).filter((x) => x.stage === 'RETAINED' || x.stage === 'REVIEW_REQUIRED');
        for (const x of prets) {
          const d = x.detail as { score?: { total: number; confidence: number }; toConfirm?: string[]; contacts?: { email?: string | null; formUrl?: string | null } };
          console.log(`    ${x.stage === 'RETAINED' ? c.green : c.amber}${x.stage.padEnd(16)}${c.reset} ${(x.name ?? x.domain).slice(0, 34).padEnd(36)} ${String(d.score?.total ?? '—').padStart(3)}/100 ${c.dim}${d.contacts?.email ?? d.contacts?.formUrl ?? 'sans canal'}${d.toConfirm?.length ? ` · à confirmer : ${d.toConfirm.join(', ')}` : ''}${c.reset}`);
        }
      }
      console.log();
      return;
    }

    if (commande === 'review') {
      const items = buildReviewQueue(repos, runId);
      const { brief } = loadClientRun(repos, runId);
      console.log(`\n  ${c.bold}FILE DE REVUE${c.reset}  ${brief.client.name} · ${items.length} société(s) · P1 ${items.filter((i) => i.priority === 'P1').length} · P2 ${items.filter((i) => i.priority === 'P2').length} · P3 ${items.filter((i) => i.priority === 'P3').length}`);
      for (const i of items) {
        const couleur = i.priority === 'P1' ? c.green : i.priority === 'P2' ? c.amber : c.red;
        console.log(`\n  ${couleur}${i.priority}${c.reset} ${c.bold}${i.company}${c.reset} · ${i.url} · ${i.score}/100${i.country ? ` · ${i.country}` : ' · pays non prouvé'}${i.generalistRisk !== null ? ` · généraliste ${i.generalistRisk}/100` : ''}`);
        for (const r of i.reasons) console.log(`     ${c.dim}⚠ ${r}${c.reset}`);
        for (const e of i.evidence.slice(0, 3)) console.log(`     ${c.dim}« ${e.quote.slice(0, 120)} » — ${e.label}${c.reset}`);
        console.log(`     contact : ${i.contact}`);
        console.log(`     → ${i.recommendationLabel} · RETAIN : ${i.commands.retain.replace('npm run client:mission -- ', '')} · EXCLUDE : ${i.commands.exclude.replace('npm run client:mission -- ', '')}`);
      }
      console.log();
      return;
    }

    if (commande === 'metrics') {
      const { context, brief } = loadClientRun(repos, runId);
      console.log(`\n  ${c.bold}MESURES${c.reset}  ${brief.client.name} · ${context.batches.length} lot(s)`);
      const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
      for (const b of context.batches) {
        const m = b.metrics;
        console.log(`\n  lot #${b.batch} · brief v${b.briefVersion} · ${b.startedAt.slice(0, 16)}`);
        if (!m) { console.log(`    ${c.dim}(lot écrit avant l’instrumentation : traités ${b.processed}, retenus ${b.retained}, à revoir ${b.reviewRequired}, écartés ${b.excluded}, ${b.costUsd.toFixed(4)} $)${c.reset}`); continue; }
        console.log(`    SEARCH      requêtes ${m.search.queries} · résultats bruts ${m.search.rawResults} · domaines uniques ${m.search.uniqueDomains} · rendement ${m.search.yields.join('/') || '—'} · ${m.search.stoppedBecause ?? ''}`);
        console.log(`    FILTER      annuaires ${m.filter.directoryExcluded} · sans texte ${m.filter.noTextExcluded} · hors sujet ${m.filter.relevanceExcluded} · pays ${m.filter.countryExcluded} · concurrents ${m.filter.competitorExcluded}`);
        console.log(`    PROCESS     candidats ${m.process.candidates} · pages lues ${m.process.pagesRead} (${(m.process.pagesRead / Math.max(1, m.process.candidates)).toFixed(1)}/candidat ; ${m.process.pagesFetched} réseau / ${m.process.pagesAttempted} tentées, ${m.process.cacheHits} en mémoire) · appels ${m.process.llmCalls} (+${m.process.llmCached} en mémoire) · jetons ${m.process.inputTokens}→${m.process.outputTokens} · ${m.process.costUsd.toFixed(4)} $`);
        console.log(`    QUALITY     retenus ${m.quality.retained} · à revoir ${m.quality.reviewRequired} · écartés ${m.quality.excluded} · échecs ${m.quality.failed} · approuvés seuls ${m.quality.autoApproved} · écartés seuls ${m.quality.autoExcluded} · à confirmer ${m.quality.toConfirmTotal} point(s)`);
        console.log(`    PERFORMANCE lot ${s(m.timing.batchMs)} · ${m.timing.concurrency} de front · ${s(m.timing.avgCandidateMs)}/candidat · fetch ${s(m.timing.fetch)} · modèle ${s(m.timing.llm)} · revue humaine estimée ${Math.round(m.quality.reviewRequired * 1.5 + m.quality.retained * 0.5)} min`);
      }
      console.log();
      return;
    }

    if (commande === 'propose') {
      const { brief } = loadClientRun(repos, runId);
      const feedback = arg('feedback') ?? '';
      if (!feedback) throw new Error('--feedback="…" requis : le retour du client, tel quel');
      const proposition = proposeBriefAdjustment(brief, feedback);
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const dossier = join('out', 'client', runId);
      mkdirSync(dossier, { recursive: true });
      const chemin = join(dossier, `brief-v${brief.version + 1}-proposition.json`);
      writeFileSync(chemin, JSON.stringify(proposition, null, 2), 'utf8');
      console.log(`\n  ${c.bold}PROPOSITION DE BRIEF v${brief.version + 1}${c.reset} — rien n’est appliqué`);
      for (const r of proposition.rules) console.log(`  ${r.applied ? c.green + '✓' : c.amber + '?'}${c.reset} ${r.feedback} → ${r.change}`);
      if (proposition.unmapped.length) console.log(`  ${c.dim}non traduit : ${proposition.unmapped.join(' ; ')}${c.reset}`);
      console.log(`  ${chemin}`);
      console.log(`  Pour appliquer : ${proposition.command}\n`);
      return;
    }

    if (commande === 'adjust') {
      const brief = adjustClientRun(repos, runId, {
        keepDomains: liste('keep'), excludeDomains: liste('exclude'), addCompetitors: liste('competitors'),
        addKeywords: liste('keywords'), ...(arg('notes') !== undefined ? { notes: arg('notes') } : {}),
        ...(arg('prefer-specialist') !== undefined ? { preferSpecialist: arg('prefer-specialist') !== 'false' } : {}),
      });
      console.log(`\n  ${c.bold}BRIEF v${brief.version}${c.reset} enregistré · ${brief.keepDomains.length} conservé(s), ${brief.excludedDomains.length} exclu(s), ${brief.competitorExclusions.length} concurrent(s), ${brief.productKeywords.length} mot(s)-clé(s)`);
      console.log(`  Le travail des versions précédentes est intact. Relancer : npm run client:mission -- batch --run=${runId} --go\n`);
      return;
    }

    if (commande === 'batch') {
      const { brief, context } = loadClientRun(repos, runId);
      const size = entier('size', CLIENT_BATCH_DEFAULTS.batchSize, 1, 500);
      const queries = entier('queries', CLIENT_BATCH_DEFAULTS.maxQueries, 0, 64);
      const concurrency = entier('concurrency', 4, 1, 8);
      // Les plafonds viennent du même endroit que ceux que le preflight affiche.
      const plafonds = clientBudgetLimits(config.ai, { budget: arg('budget'), batchBudget: arg('batch-budget') });
      const runBudget = plafonds.mission.usd;
      const batchBudget = plafonds.batch.usd;
      const daily = plafonds.daily.usd;
      const resume = flag('resume');
      const exclude = liste('exclude').map(normaliseDomain);
      const seedDomains = liste('domains');

      if (config.search.fallbackEnabled) throw new Error('ATLAS_SEARCH_FALLBACK_ENABLED est actif : refus. Un modèle ne remplace pas un moteur.');
      if (config.llm.mode !== 'live') throw new Error(`mode « ${config.llm.mode} » : une mission client exige le mode live`);

      const fabric = createSearchFabric(config.search, { need: { countries: ['SE'], languages: ['sv'], commercial: true } });
      if (!fabric) throw new Error('aucun moteur configuré');

      const attente = repos.clientCandidates.pending(runId, size).length;
      const estimation = Math.min(size, resume ? attente : size) * 0.012;
      console.log(`\n  ${c.bold}LOT #${context.batches.length + 1}${c.reset}  ${brief.client.name} · brief v${brief.version} · taille ${size} · ${resume ? 'reprise seule' : `${queries} requête(s) max`}`);
      console.log(`  plafonds : mission ${runBudget} $ · lot ${batchBudget} $ · jour ${daily > 0 ? `${daily} $` : 'non configuré'} · estimation prudente ${estimation.toFixed(3)} $ (0,012 $/candidat)`);
      console.log(`  en attente avant ce lot : ${attente}`);
      if (!flag('go')) {
        console.log(`\n  ${c.amber}Contrôle seul.${c.reset} Ajoutez --go pour exécuter.\n`);
        return;
      }

      system.ledger.open(runId, { ...config.budget, maxMissionCostUsd: runBudget, maxOutputTokensPerCall: 2000 });
      const started = Date.now();
      const summary = await runClientBatch({
        repos,
        search: fabric,
        fetchPages: async (urls, maxPages, opts) => {
          const out = await fetchRawPages(urls, { logger: system.logger, timeoutMs: opts?.timeoutMs ?? 20_000, maxPages });
          return { pages: out.pages.map((p) => ({ url: p.url, html: p.html })), attempts: out.attempts, failures: out.failures.map((f) => ({ url: f.url, kind: f.kind, reason: f.reason })) };
        },
        llm: system.provider,
        model: MODEL,
        logger: system.logger,
      }, {
        runId, batchSize: size, maxQueries: queries, runBudgetUsd: runBudget, batchBudgetUsd: batchBudget,
        dailyBudgetUsd: daily, resumeOnly: resume || seedDomains.length > 0, exclude, seedDomains, createdBy: 'client-mission',
        concurrency, cache: !flag('no-cache'),
      });

      console.log(`\n  ${c.bold}LOT #${summary.batch} TERMINÉ${c.reset} en ${((Date.now() - started) / 1000).toFixed(0)} s`);
      console.log(`  requêtes ${summary.queriesRun} · résultats bruts ${summary.rawResults} · nouveaux ${summary.discovered} · annuaires écartés ${summary.filteredOut}`);
      console.log(`  traités ${summary.processed} : ${c.green}${summary.retained} retenus${c.reset} · ${c.amber}${summary.reviewRequired} à revoir${c.reset} · ${summary.excluded} écartés · ${summary.failed} en échec`);
      console.log(`  coût du lot ${summary.costUsd.toFixed(4)} $${summary.stoppedBecause ? ` · ${c.red}arrêt : ${summary.stoppedBecause}${c.reset}` : ''}`);
      if (summary.metrics) {
        const m = summary.metrics;
        const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
        console.log(`  ${c.dim}mesures · recherche ${s(m.search.ms)} (${m.search.uniqueDomains} domaines uniques${m.search.stoppedBecause ? `, arrêt : ${m.search.stoppedBecause}` : ''}) · candidats ${m.process.candidates} (${m.timing.concurrency} de front) · pages lues ${m.process.pagesRead} (${m.process.pagesFetched} par le réseau sur ${m.process.pagesAttempted} tentées, ${m.process.cacheHits} en mémoire, ${m.process.pagesUseful} utiles, ${m.process.fetchTimeouts} timeouts) · appels ${m.process.llmCalls} (+${m.process.llmCached} en mémoire) · jetons ${m.process.inputTokens}→${m.process.outputTokens}${c.reset}`);
        console.log(`  ${c.dim}temps · fetch ${s(m.timing.fetch)} · parse ${s(m.timing.parse)} · pays ${s(m.timing.country)} · identité ${s(m.timing.identity)} · concurrents ${s(m.timing.competitors)} · modèle ${s(m.timing.llm)} · contacts ${s(m.timing.contacts)} · écriture ${s(m.timing.persist)} · moyenne ${s(m.timing.avgCandidateMs)}/candidat${c.reset}`);
        console.log(`  ${c.dim}filtre · annuaires ${m.filter.directoryExcluded} · sans texte ${m.filter.noTextExcluded} · hors sujet ${m.filter.relevanceExcluded} · pays ${m.filter.countryExcluded} · concurrents ${m.filter.competitorExcluded} · à confirmer ${m.quality.toConfirmTotal} point(s) sur ${m.quality.candidatesWithToConfirm} candidat(s)${c.reset}`);
        console.log(`  ${c.dim}tri · ${c.green}${m.quality.autoApproved} approuvés seuls${c.reset}${c.dim} · ${c.amber}${m.quality.humanReview} à revoir${c.reset}${c.dim} · ${m.quality.autoExcluded} écartés seuls${c.reset}`);
        if (m.timing.slowest.length) console.log(`  ${c.dim}plus lents · ${m.timing.slowest.map((x) => `${x.domain} ${s(x.ms)} (fetch ${s(x.fetch)}, modèle ${s(x.llm)})`).join(' · ')}${c.reset}`);
      }
      const restants = repos.clientCandidates.pending(runId, 500).length;
      console.log(`  en attente après ce lot : ${restants}${restants > 0 ? ` → npm run client:mission -- batch --run=${runId} --resume --go` : ''}`);
      console.log(`  ${c.dim}jour : ${spendSoFar(repos, { runId, batchStartedAt: startOfUtcDay(new Date().toISOString()) }, new Date().toISOString()).day.toFixed(4)} $ · MESSAGES SENT inchangé — ce script n’envoie rien${c.reset}\n`);
      return;
    }

    throw new Error(`commande inconnue : ${commande} (start | batch | status | adjust | cost | review | metrics | propose)`);
  } finally {
    await system.shutdown('client-mission terminé');
  }
}

main().catch((err) => {
  console.error(`\n  ${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}\n`);
  process.exitCode = 1;
});
