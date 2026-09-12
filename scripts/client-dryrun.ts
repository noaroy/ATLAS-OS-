/**
 * Le pipeline client, de bout en bout, sans réseau et sans modèle.
 *
 *   npm run client:dryrun
 *
 * Base temporaire, moteur et pages en fixtures, modèle scripté : rien de
 * payant, rien de contacté. Le script joue deux lots, une interruption, une
 * reprise, un ajustement de brief, puis écrit le rapport PARTIAL et le
 * rapport FINAL dans out/client-dryrun/ — les fichiers mêmes qu'un client
 * recevrait, à ouvrir avant de lancer quoi que ce soit de réel.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, loadAtlasEnv } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import { BUSINESS_EXPANSION } from '../packages/departments/src/index.ts';
import {
  createClientRun, adjustClientRun, runClientBatch, buildClientRunReport,
} from '../packages/runtime/src/index.ts';
import { brief, searchFixture, fetchFixture, llmFixture, TOUS } from '../packages/runtime/test/fixtures/sweden-mission.ts';

// Rien n'est lu dans l'environnement ici, mais la règle du dépôt vaut pour tous.
loadAtlasEnv();

const c = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', amber: '\x1b[33m' };
const logger = createLogger({ level: 'error', pretty: false });
const dir = mkdtempSync(join(tmpdir(), 'atlas-dryrun-'));
const repos = createRepositories(join(dir, 'dryrun.db'), logger);
const out = join('out', 'client-dryrun');
mkdirSync(out, { recursive: true });

async function main(): Promise<void> {
  repos.departments.ensure(BUSINESS_EXPANSION);
  const llm = llmFixture();
  const runId = createClientRun(repos, brief(), 'dryrun');
  const options = { runId, batchSize: 20, runBudgetUsd: 5, batchBudgetUsd: 5, dailyBudgetUsd: 0, createdBy: 'dryrun' };
  console.log(`\n${c.bold}  DRY RUN — mission ${runId}${c.reset}  ${c.dim}fixtures, aucun réseau, aucun modèle${c.reset}\n`);

  // Lot 1 : trois sites, dont une panne réseau sur generalbolaget.
  const l1 = await runClientBatch({
    repos, search: searchFixture(TOUS.slice(0, 3)), fetchPages: fetchFixture(new Set(['generalbolaget.se'])), llm, model: 'fixture', logger,
  }, options);
  console.log(`  lot 1  requêtes ${l1.queriesRun} · nouveaux ${l1.discovered} · retenus ${l1.retained} · écartés ${l1.excluded} · échecs ${l1.failed} (panne simulée)`);

  // Reprise : la panne est levée, seul l'échec est retraité.
  const l2 = await runClientBatch({ repos, search: searchFixture([]), fetchPages: fetchFixture(), llm, model: 'fixture', logger },
    { ...options, resumeOnly: true });
  console.log(`  reprise traités ${l2.processed} · retenus ${l2.retained} · écartés ${l2.excluded}`);

  // Rapport intermédiaire.
  const partial = buildClientRunReport(repos, runId, {
    status: 'PARTIAL', generatedAt: new Date().toISOString(), scoringModel: BUSINESS_EXPANSION.scoringModel, executionMode: 'simulation',
  });
  writeFileSync(join(out, 'rapport-PARTIAL.html'), partial.html, 'utf8');
  writeFileSync(join(out, 'rapport-PARTIAL.csv'), partial.csv, 'utf8');
  writeFileSync(join(out, 'rapport-PARTIAL-ecartees.csv'), partial.exclusionsCsv, 'utf8');
  console.log(`  PARTIAL  retenues ${partial.retained.length} · à revoir ${partial.reviewRequired.length} · écartées ${partial.excluded.length}`);

  // Le client répond : exclure tystbolag, conserver nordpack, ajouter une marque.
  const v2 = adjustClientRun(repos, runId, { keepDomains: ['nordpack.se'], excludeDomains: ['tystbolag.se'], addCompetitors: ['Bizerba'] });
  console.log(`  brief v${v2.version}  concurrents ${v2.competitorExclusions.join(', ')} · exclus ${v2.excludedDomains.join(', ')}`);

  // Lot 2 sur le brief v2 : les trois autres sites.
  const l3 = await runClientBatch({ repos, search: searchFixture(TOUS.slice(3)), fetchPages: fetchFixture(), llm, model: 'fixture', logger }, options);
  console.log(`  lot 2  nouveaux ${l3.discovered} · annuaires ${l3.filteredOut} · retenus ${l3.retained} · écartés ${l3.excluded}`);

  // Un troisième lot : plus rien à découvrir ni à traiter, et aucun appel.
  const avant = llm.calls;
  const l4 = await runClientBatch({ repos, search: searchFixture(TOUS), fetchPages: fetchFixture(), llm, model: 'fixture', logger }, options);
  console.log(`  lot 3  nouveaux ${l4.discovered} · traités ${l4.processed} · appels modèle supplémentaires ${llm.calls - avant}`);

  const final = buildClientRunReport(repos, runId, {
    status: 'FINAL', generatedAt: new Date().toISOString(), scoringModel: BUSINESS_EXPANSION.scoringModel, executionMode: 'simulation',
  });
  writeFileSync(join(out, 'rapport-FINAL.html'), final.html, 'utf8');
  writeFileSync(join(out, 'rapport-FINAL.csv'), final.csv, 'utf8');
  writeFileSync(join(out, 'rapport-FINAL-ecartees.csv'), final.exclusionsCsv, 'utf8');
  console.log(`  FINAL    retenues ${final.retained.length} · à revoir ${final.reviewRequired.length} · écartées ${final.excluded.length}`);

  const counts = repos.clientCandidates.counts(runId);
  console.log(`\n  états : ${Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
  console.log(`  appels modèle (fixture) : ${llm.calls}`);
  console.log(`\n  ${c.green}fichiers :${c.reset} ${out}/rapport-PARTIAL.html · rapport-FINAL.html · *.csv · *-ecartees.csv\n`);
}

main().finally(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});
