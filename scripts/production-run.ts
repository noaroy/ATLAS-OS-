/**
 * ATLAS COMMERCIAL PRODUCTION — la chaîne complète, du candidat au livrable.
 *
 *   npm run production                        contrôle seul, aucune dépense
 *   npm run production -- --go                exécution réelle
 *   npm run production -- --go --budget=0.08  plafond explicite
 *
 * Reprend le pipeline validé et y ajoute ce qui manque pour vendre : un
 * rapport français lisible sans connaître ATLAS, un extrait gratuit, la
 * traçabilité, l'économie, et un état qui ne peut pas atteindre la livraison
 * sans revue humaine.
 *
 * Rien de l'architecture du pipeline n'est modifié ici. Ce script l'utilise.
 */
import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createSystem } from '../packages/server/src/bootstrap.ts';
import { loadConfig, formatDuration } from '../packages/core/src/index.ts';
import { preflight, formatPreflight } from '../packages/runtime/src/preflight.ts';
import { DeterministicPipeline, validateStagePostcondition } from '../packages/runtime/src/index.ts';
import { normaliseCountry } from '../packages/intelligence/src/opportunities.ts';
import {
  buildClientReport,
  reportToHtml,
  reportToCsv,
  teaserToHtml,
  reportEconomics,
  PIPELINE_VERSION,
  type ReportEntry,
  type ReportProvenance,
} from '../packages/departments/src/index.ts';

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m',
};

const GO = process.argv.includes('--go');
const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const MAX_COST_USD = Number(arg('budget') ?? 0.08);
const MAX_CANDIDATES = Number(arg('candidates') ?? 5);
const SELLING_PRICE_EUR = Number(arg('price') ?? 49);
const outDir = arg('out') ?? 'out';
const CLIENT = arg('client') ?? 'Prospect — offre de lancement';
const MODEL = 'claude-haiku-4-5-20251001';
const ICP_COUNTRIES = ['Germany'];

async function main(): Promise<void> {
  const config = loadConfig();
  const system = createSystem(config);
  const { repos } = system;

  console.log(`\n${c.bold}  ATLAS COMMERCIAL PRODUCTION${c.reset}`);
  console.log(`  ${c.dim}qualification → scoring → ranking → export → rapport client${c.reset}\n`);
  console.log(
    `  ${c.bold}Plafond ${MAX_COST_USD.toFixed(2)} $${c.reset} · ${MODEL} · ` +
      `${MAX_CANDIDATES} candidat(s) max · prix ${SELLING_PRICE_EUR} €\n`,
  );

  // ── Les candidats déjà en base ──────────────────────────────────────────
  const missions = repos.missions.list({ limit: 100, offset: 0 }).items;
  let sourceMissionId = '';
  for (const mission of missions) {
    const usable = repos.opportunities.forMission(mission.id).filter((o) => {
      const company = repos.companies.get(o.companyId);
      return company?.dataOrigin === 'live' && company.identityStatus === 'ok';
    });
    if (usable.length > 0) {
      sourceMissionId = mission.id;
      break;
    }
  }
  if (!sourceMissionId) {
    console.error(`  ${c.red}Aucune mission ne porte de candidat réel exploitable.${c.reset}\n`);
    await system.shutdown('aucun candidat');
    process.exitCode = 1;
    return;
  }

  const pool = repos.opportunities
    .forMission(sourceMissionId)
    .map((o) => {
      const company = repos.companies.require(o.companyId);
      const evidence = repos.companies.evidenceForOpportunity(o.id);
      return {
        opportunity: o,
        company,
        firsthand: evidence.filter((e) => e.nature !== 'inferred' && Boolean(e.sourceRef)).length,
        simulated: evidence.filter((e) => e.simulated).length,
      };
    })
    .filter((e) => {
      if (e.company.dataOrigin !== 'live' || e.company.identityStatus !== 'ok') return false;
      if (e.simulated > 0) return false;
      const country = normaliseCountry(e.company.country);
      return !country || ICP_COUNTRIES.map(normaliseCountry).includes(country);
    })
    .sort((a, b) => b.firsthand - a.firsthand)
    .slice(0, MAX_CANDIDATES);

  console.log(`  ${c.bold}Candidats retenus${c.reset} (${pool.length})`);
  for (const e of pool) {
    console.log(
      `    ${c.green}✓${c.reset} ${e.company.name.slice(0, 36).padEnd(38)}` +
        `${String(e.firsthand).padStart(3)} preuve(s) de 1re main · ${e.company.country}`,
    );
  }
  console.log();

  if (pool.length === 0) {
    console.error(`  ${c.red}Aucun candidat exploitable. Aucune dépense engagée.${c.reset}\n`);
    await system.shutdown('aucun candidat');
    process.exitCode = 1;
    return;
  }

  const report = await preflight({
    config, repos,
    search: system.searchFabric,
    inferenceFabric: system.inferenceFabric,
    logger: system.logger,
    missionBudgetUsd: MAX_COST_USD,
  });
  console.log(formatPreflight(report).replace(/^/gm, '  '));
  console.log();

  if (!report.cleared) {
    console.error(`  ${c.red}BLOCKED${c.reset} — aucune dépense engagée.\n`);
    await system.shutdown('preflight refusé');
    process.exitCode = 1;
    return;
  }
  if (!GO) {
    console.log(`  ${c.amber}Contrôle seul.${c.reset} Relancez avec --go pour exécuter.\n`);
    await system.shutdown('contrôle seul');
    return;
  }
  if (config.llm.mode !== 'live') {
    console.error(`  ${c.red}Refus : mode « ${config.llm.mode} », pas « live ».${c.reset}\n`);
    await system.shutdown('mode incorrect');
    process.exitCode = 1;
    return;
  }

  // ── Exécution ───────────────────────────────────────────────────────────
  const started = Date.now();
  const startedAt = new Date().toISOString();
  const missionId = sourceMissionId;
  const opportunityIds = pool.map((e) => e.opportunity.id);
  const mission = repos.missions.require(missionId);
  const department = repos.departments.require(mission.departmentKey ?? 'business-expansion');

  system.ledger.open(missionId, {
    ...config.budget, maxMissionCostUsd: MAX_COST_USD, maxOutputTokensPerCall: 2500,
  });

  const pipeline = new DeterministicPipeline({
    repos,
    intelligence: system.intelligence,
    provider: system.provider,
    logger: system.logger,
    model: MODEL,
    maxOutputTokens: 2500,
  });

  const objective =
    "Distributeurs ou intégrateurs allemands capables de représenter une offre B2B " +
    "industrielle d'emballage auprès d'industriels français.";

  const stages: Array<{ name: string; passed: boolean; detail: string; reused?: boolean }> = [];
  const at = (): string => `${((Date.now() - started) / 1000).toFixed(0).padStart(5)}s`;
  console.log(`  ${c.dim}temps  │ étape${c.reset}`);
  console.log(`  ${c.dim}───────┼──────────────────────────────────────────────${c.reset}`);

  let halted = '';
  const note = (name: string, passed: boolean, detail: string, reused = false) => {
    stages.push({ name, passed, detail, reused });
    const mark = reused ? `${c.green}↺${c.reset}` : passed ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
    console.log(`  ${c.dim}${at()}${c.reset} │ ${mark} ${name.padEnd(14)}${detail}`);
    if (!passed) halted = name;
    return passed;
  };

  try {
    const existing = validateStagePostcondition('qualification', { repos, missionId, opportunityIds });
    if (existing.passed) {
      note('qualification', true, `réutilisée : ${existing.check.actual}, 0 appel`, true);
    } else {
      const outcome = await pipeline.qualify({
        missionId, opportunityIds, agentKey: 'ambassador', objective,
        requiredFields: ['existence'],
      });
      note('qualification', outcome.succeeded, `${outcome.completed} fait(s), ${outcome.failed} échec(s)`);
      if (!outcome.succeeded) console.log(outcome.postcondition.diagnostic.replace(/^/gm, '         │   '));
    }

    if (!halted) {
      const outcome = await pipeline.score({
        missionId, opportunityIds, agentKey: 'analyst', objective, model: department.scoringModel,
      });
      note('scoring', outcome.succeeded, `${outcome.completed} noté(s), ${outcome.failed} échec(s)`);
      if (!outcome.succeeded) console.log(outcome.postcondition.diagnostic.replace(/^/gm, '         │   '));
    }

    if (!halted) {
      const outcome = pipeline.rank({
        missionId, opportunityIds, agentKey: 'analyst', model: department.scoringModel,
      });
      note('ranking', outcome.succeeded, outcome.postcondition.check.actual);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    note('interruption', false, message.slice(0, 80));
  }

  // ── Le livrable ─────────────────────────────────────────────────────────
  let paths = { html: '', csv: '', teaser: '' };
  let exportPassed = false;
  let retained = 0;

  if (!halted) {
    const entries: ReportEntry[] = opportunityIds
      .map((id) => repos.opportunities.require(id))
      .filter((o) => o.rank !== null)
      .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
      .map((o) => ({
        opportunity: o,
        company: repos.companies.require(o.companyId),
        evidence: repos.companies.evidenceForOpportunity(o.id),
        contacts: repos.companies.contactsFor(o.companyId),
      }));
    retained = entries.length;

    const calls = repos.llmCalls.forMission(missionId).filter((k) => k.createdAt >= startedAt);
    const costUsd = calls.reduce((a, k) => a + (k.costUsd ?? 0), 0);
    const evidenceIds = entries.flatMap((e) => e.evidence.map((v) => v.id));
    const sources = [...new Set(entries.flatMap((e) => e.evidence.map((v) => v.sourceRef).filter(Boolean)))] as string[];

    const provenance: ReportProvenance = {
      missionId: mission.code,
      generatedAt: new Date().toISOString(),
      pipelineVersion: PIPELINE_VERSION,
      scoringVersion: department.scoringModel.dimensions.length > 0 ? 'v1' : 'inconnue',
      executionMode: 'live',
      evidenceIds,
      sources,
      costUsd,
      reviewer: null,
      approvedAt: null,
      state: 'GENERATED',
    };

    const economics = reportEconomics(
      {
        llmCostUsd: costUsd,
        // SearXNG tourne en local et les outils serveur sont facturés dans les
        // appels : la recherche n'a pas de coût propre aujourd'hui.
        searchCostUsd: 0,
        candidates: opportunityIds.length,
        usefulOpportunities: retained,
      },
      { sellingPriceEur: SELLING_PRICE_EUR },
    );

    const clientReport = buildClientReport({
      clientName: CLIENT,
      missionTitle: 'Distributeurs allemands — emballage industriel',
      market: 'Allemagne · machines et lignes d’emballage',
      objective,
      generatedAt: new Date().toISOString(),
      analysedCount: opportunityIds.length,
      entries,
      scoringModel: department.scoringModel,
      provenance,
      economics,
    });

    mkdirSync(outDir, { recursive: true });
    const stem = `rapport-client-${mission.code}`;
    paths = {
      html: join(outDir, `${stem}.html`),
      csv: join(outDir, `${stem}.csv`),
      teaser: join(outDir, `teaser-${mission.code}.html`),
    };
    writeFileSync(paths.html, reportToHtml(clientReport), 'utf8');
    writeFileSync(paths.csv, reportToCsv(clientReport), 'utf8');
    writeFileSync(paths.teaser, teaserToHtml(clientReport, { priceEur: SELLING_PRICE_EUR, deliveryHours: 24 }), 'utf8');

    const artifacts = [paths.html, paths.csv].filter((p) => existsSync(p));
    const postcondition = validateStagePostcondition('export', {
      repos, missionId, opportunityIds, artifacts,
    });
    exportPassed = postcondition.passed;
    note('export', postcondition.passed, `${retained} prospect(s), ${artifacts.length} fichier(s)`);
    if (!postcondition.passed) console.log(postcondition.diagnostic.replace(/^/gm, '         │   '));

    // Le rapport entre dans le circuit — en GENERATED, jamais plus loin.
    if (postcondition.passed) {
      const row = repos.orders.recordReport({
        missionId,
        htmlPath: paths.html,
        csvPath: paths.csv,
        teaserPath: paths.teaser,
        pipelineVersion: PIPELINE_VERSION,
        scoringVersion: 'v1',
        executionMode: 'live',
        evidenceIds,
        sources,
        costUsd,
        candidates: opportunityIds.length,
        retained,
      });
      console.log(`  ${c.dim}${at()}${c.reset} │ ${c.green}✓${c.reset} ${'archivage'.padEnd(14)}${row.id} · état ${row.state}`);
    }

    console.log(`  ${c.dim}───────┴──────────────────────────────────────────────${c.reset}\n`);

    // ── Rapport ─────────────────────────────────────────────────────────────
    const inputTokens = calls.reduce((a, k) => a + k.inputTokens, 0);
    const outputTokens = calls.reduce((a, k) => a + k.outputTokens, 0);
    const evidenceUsed = entries.flatMap((e) => e.evidence);
    const simulated = evidenceUsed.filter((e) => e.simulated).length;
    const size = (p: string) => (existsSync(p) ? `${statSync(p).size} o` : 'absent');

    console.log(`  ${c.bold}PRODUCTION — MESURE${c.reset}\n`);
    console.log(`    durée              ${formatDuration(Date.now() - started)}`);
    console.log(`    candidats          ${opportunityIds.length} analysés · ${retained} retenus`);
    console.log(`    appels LLM         ${calls.length}`);
    console.log(`    jetons             ${inputTokens.toLocaleString('fr-FR')} entrée · ${outputTokens.toLocaleString('fr-FR')} sortie`);
    console.log(
      `    coût               ${c.bold}${costUsd.toFixed(4)} $${c.reset} / ${MAX_COST_USD.toFixed(2)} $ ` +
        (costUsd <= MAX_COST_USD ? `${c.green}✓${c.reset}` : `${c.red}DÉPASSEMENT${c.reset}`),
    );
    console.log(`    coût / candidat    ${economics.costPerCandidateUsd?.toFixed(4) ?? '—'} $`);
    console.log(`    coût / opportunité ${economics.costPerUsefulOpportunityUsd?.toFixed(4) ?? '—'} $`);
    console.log(`    marge brute        ${economics.grossMarginEur?.toFixed(2) ?? '—'} € (${economics.grossMarginPercent ?? '—'} %)`);
    console.log(`    preuves            ${evidenceUsed.length} (${evidenceUsed.filter((e) => e.sourceRef).length} sourcées)`);
    console.log(`    preuves simulées   ${simulated === 0 ? `${c.green}0${c.reset}` : `${c.red}${simulated}${c.reset}`}`);
    console.log(`    sources distinctes ${sources.length}`);
    console.log();
    console.log(`  ${c.bold}Livrables${c.reset}`);
    console.log(`    rapport HTML       ${paths.html} (${size(paths.html)})`);
    console.log(`    rapport CSV        ${paths.csv} (${size(paths.csv)})`);
    console.log(`    extrait gratuit    ${paths.teaser} (${size(paths.teaser)})`);
    console.log();

    const allPassed = stages.every((s) => s.passed) && exportPassed;
    const verdict = allPassed && simulated === 0 && costUsd <= MAX_COST_USD && retained > 0 ? 'PASS' : 'PARTIAL';
    console.log(`  ${c.bold}POSTCONDITIONS: ${stages.filter((s) => s.passed).length}/${stages.length}${c.reset}`);
    console.log(`  ${c.bold}VERDICT: ${verdict === 'PASS' ? c.green : c.amber}${verdict}${c.reset}\n`);
    await system.shutdown('production terminée');
    process.exitCode = verdict === 'PASS' ? 0 : 1;
    return;
  }

  console.log(`  ${c.dim}───────┴──────────────────────────────────────────────${c.reset}\n`);
  console.log(`  ${c.red}Arrêt à « ${halted} » — aucun livrable produit.${c.reset}\n`);
  await system.shutdown('production interrompue');
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
