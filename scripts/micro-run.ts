/**
 * MICRO-RUN LIVE — la première exécution réelle du pipeline déterministe.
 *
 *   npm run micro           contrôle seul, aucune dépense
 *   npm run micro -- --go   exécution réelle
 *
 * Deux candidats au plus, pris parmi ceux déjà en base. Aucune découverte : le
 * travail de recherche a été payé par REVENUE-001, et le refaire mesurerait le
 * mauvais bout du pipeline. Ce qu'on veut savoir ici tient en une question :
 * les quatre étapes produisent-elles réellement leurs artefacts, ou le
 * contrat les arrête-t-il ?
 *
 * Le contrat décide, pas le modèle. Une postcondition fausse arrête la
 * séquence, et l'étape est rapportée comme échouée — c'est exactement ce que
 * SALVAGE-001 n'a pas su faire.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSystem } from '../packages/server/src/bootstrap.ts';
import { loadConfig, formatDuration } from '../packages/core/src/index.ts';
import { preflight, formatPreflight } from '../packages/runtime/src/preflight.ts';
import { DeterministicPipeline, validateStagePostcondition } from '../packages/runtime/src/index.ts';
import { normaliseCountry } from '../packages/intelligence/src/opportunities.ts';
import { buildPack, packToHtml, packToCsv } from '../packages/departments/src/index.ts';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  amber: '\x1b[33m',
  red: '\x1b[31m',
};

const GO = process.argv.includes('--go');
const outDir = process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? 'out';

/** Le plafond. Dur, et vérifié à trois endroits : registre, boucle, rapport. */
const MAX_COST_USD = 0.08;
/** Deux candidats : assez pour éprouver une boucle, assez peu pour ne rien gaspiller. */
const MAX_CANDIDATES = 2;
const MODEL = 'claude-haiku-4-5-20251001';
const ICP_COUNTRIES = ['Germany'];

async function main(): Promise<void> {
  const config = loadConfig();
  const system = createSystem(config);
  const { repos } = system;

  console.log(`\n${c.bold}  MICRO-RUN LIVE — pipeline déterministe${c.reset}`);
  console.log(
    `  ${c.dim}qualification → scoring → ranking → export, sur des candidats déjà en base.${c.reset}\n`,
  );
  console.log(`  ${c.bold}Plafond ${MAX_COST_USD.toFixed(2)} $${c.reset} · ${MODEL} · ${MAX_CANDIDATES} candidat(s) max\n`);

  // ── Les candidats : ceux qui existent, jamais de nouvelle recherche ──────
  //
  // Trié par nombre d'affirmations de première main sourcées. Ce n'est pas
  // « les meilleures entreprises » : ce sont celles sur lesquelles le pipeline
  // a le plus de matière à juger, donc celles qui éprouvent le mieux les
  // postconditions.
  const pool = repos.opportunities
    .forMission(await firstMissionWithCandidates(repos))
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
    .filter((entry) => {
      if (entry.company.dataOrigin !== 'live') return false;
      if (entry.company.identityStatus !== 'ok') return false;
      if (entry.simulated > 0) return false;
      const country = normaliseCountry(entry.company.country);
      return !country || ICP_COUNTRIES.map(normaliseCountry).includes(country);
    })
    .sort((a, b) => b.firsthand - a.firsthand)
    .slice(0, MAX_CANDIDATES);

  console.log(`  ${c.bold}Candidats retenus${c.reset}`);
  for (const entry of pool) {
    console.log(
      `    ${c.green}✓${c.reset} ${entry.company.name.slice(0, 36).padEnd(38)}` +
        `${String(entry.firsthand).padStart(3)} preuve(s) de 1re main · ${entry.company.country}`,
    );
  }
  console.log();

  if (pool.length === 0) {
    console.error(`  ${c.red}Aucun candidat réel exploitable. Aucune dépense engagée.${c.reset}\n`);
    await system.shutdown('aucun candidat');
    process.exitCode = 1;
    return;
  }

  // ── Contrôle avant décollage ────────────────────────────────────────────
  const report = await preflight({
    config,
    repos,
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
  const missionId = pool[0]!.opportunity.missionId;
  const opportunityIds = pool.map((e) => e.opportunity.id);
  const mission = repos.missions.require(missionId);
  const department = repos.departments.require(mission.departmentKey ?? 'business-expansion');

  system.ledger.open(missionId, {
    ...config.budget,
    maxMissionCostUsd: MAX_COST_USD,
    maxOutputTokensPerCall: 2500,
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

  const stages: Array<{
    name: string;
    completed: number;
    failed: number;
    repaired: number;
    passed: boolean;
    diagnostic: string;
  }> = [];

  console.log(`  ${c.dim}temps  │ étape${c.reset}`);
  console.log(`  ${c.dim}───────┼──────────────────────────────────────────────${c.reset}`);
  const at = (): string => `${((Date.now() - started) / 1000).toFixed(0).padStart(5)}s`;

  const record = (name: string, o: { completed: number; failed: number; repaired: number; succeeded: boolean; postcondition: { diagnostic: string } }) => {
    stages.push({
      name,
      completed: o.completed,
      failed: o.failed,
      repaired: o.repaired,
      passed: o.succeeded,
      diagnostic: o.postcondition.diagnostic,
    });
    console.log(
      `  ${c.dim}${at()}${c.reset} │ ${o.succeeded ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`} ` +
        `${name.padEnd(14)}${o.completed} fait(s), ${o.failed} échec(s), ${o.repaired} réparation(s)`,
    );
    if (!o.succeeded) {
      console.log(o.postcondition.diagnostic.replace(/^/gm, `         │   ${c.red}`) + c.reset);
    }
    return o.succeeded;
  };

  let halted = '';
  let exportedFiles: string[] = [];

  try {
    const qualification = await pipeline.qualify({
      missionId,
      opportunityIds,
      agentKey: 'ambassador',
      objective,
      requiredFields: ['existence'],
    });
    if (!record('qualification', qualification)) halted = 'qualification';

    if (!halted) {
      const scoring = await pipeline.score({
        missionId,
        opportunityIds,
        agentKey: 'analyst',
        objective,
        model: department.scoringModel,
      });
      if (!record('scoring', scoring)) halted = 'scoring';
    }

    if (!halted) {
      const ranking = pipeline.rank({
        missionId,
        opportunityIds,
        agentKey: 'analyst',
        model: department.scoringModel,
      });
      if (!record('ranking', ranking)) halted = 'ranking';
    }

    if (!halted) {
      // L'export : déterministe, aucun appel au modèle.
      const entries = opportunityIds
        .map((id) => repos.opportunities.require(id))
        .filter((o) => o.rank !== null)
        .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
        .map((o) => ({
          opportunity: o,
          company: repos.companies.require(o.companyId),
          evidence: repos.companies.evidenceForOpportunity(o.id),
          contacts: repos.companies.contactsFor(o.companyId),
        }));

      const pack = buildPack({
        title: 'Pack Prospection Allemagne',
        brief: objective,
        generatedAt: new Date().toISOString(),
        entries,
      });

      mkdirSync(outDir, { recursive: true });
      const stem = `micro-run-${mission.code}`;
      const html = join(outDir, `${stem}.html`);
      const csv = join(outDir, `${stem}.csv`);
      writeFileSync(html, packToHtml(pack), 'utf8');
      writeFileSync(csv, packToCsv(pack), 'utf8');
      exportedFiles = [html, csv].filter((f) => existsSync(f));

      const postcondition = validateStagePostcondition('export', {
        repos,
        missionId,
        opportunityIds,
        artifacts: exportedFiles,
      });
      record('export', {
        completed: pack.prospects.length,
        failed: 0,
        repaired: 0,
        succeeded: postcondition.passed,
        postcondition,
      });
      if (!postcondition.passed) halted = 'export';
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    halted = `interruption : ${message.slice(0, 120)}`;
    console.log(`  ${c.dim}${at()}${c.reset} │ ${c.red}✗${c.reset} ${message.slice(0, 90)}`);
  }

  console.log(`  ${c.dim}───────┴──────────────────────────────────────────────${c.reset}\n`);

  // ── Mesure ──────────────────────────────────────────────────────────────
  //
  // Filtrée sur l'horodatage : la mission porte déjà les appels de REVENUE-001,
  // et les additionner ferait passer une dépense ancienne pour celle-ci.
  const calls = repos.llmCalls.forMission(missionId).filter((k) => k.createdAt >= startedAt);
  const cost = calls.reduce((a, k) => a + (k.costUsd ?? 0), 0);
  const inputTokens = calls.reduce((a, k) => a + k.inputTokens, 0);
  const outputTokens = calls.reduce((a, k) => a + k.outputTokens, 0);
  const failedCalls = calls.filter((k) => !k.ok).length;

  const treated = opportunityIds.map((id) => repos.opportunities.require(id));
  const qualified = treated.filter((o) => o.qualification?.verdict === 'qualified');
  const scored = treated.filter((o) => o.score !== null);
  const ranked = treated.filter((o) => o.rank !== null);
  const evidenceUsed = opportunityIds.flatMap((id) => repos.companies.evidenceForOpportunity(id));
  const simulatedEvidence = evidenceUsed.filter((e) => e.simulated).length;

  const allPassed = stages.length === 4 && stages.every((s) => s.passed);
  const withinBudget = cost <= MAX_COST_USD;
  const verdict = allPassed && withinBudget && simulatedEvidence === 0 && qualified.length >= 1
    ? 'PASS'
    : stages.some((s) => s.passed)
      ? 'PARTIAL'
      : 'FAIL';

  console.log(`  ${c.bold}MICRO-RUN LIVE REPORT${c.reset}\n`);
  console.log(`  CANDIDATES:        ${treated.length} — ${treated.map((o) => repos.companies.require(o.companyId).name).join(', ')}`);
  console.log(
    `  QUALIFICATION:     ${stageLine('qualification')} · ${qualified.length} qualifié(s) sur ${treated.length}`,
  );
  console.log(`  SCORING:           ${stageLine('scoring')} · ${scored.map((o) => o.score).join(', ') || '—'}`);
  console.log(`  RANKING:           ${stageLine('ranking')} · ${ranked.length} classé(s)`);
  console.log(`  EXPORT:            ${stageLine('export')} · ${exportedFiles.join(', ') || 'aucun fichier'}`);
  console.log(`  LLM CALLS:         ${calls.length}${failedCalls ? ` (${failedCalls} en échec)` : ''}`);
  console.log(`  TOKENS:            ${inputTokens.toLocaleString('fr-FR')} entrée · ${outputTokens.toLocaleString('fr-FR')} sortie`);
  console.log(
    `  COST:              ${c.bold}${cost.toFixed(4)} $${c.reset} / ${MAX_COST_USD.toFixed(2)} $ ` +
      (withinBudget ? `${c.green}✓${c.reset}` : `${c.red}DÉPASSEMENT${c.reset}`),
  );
  console.log(
    `  POSTCONDITIONS:    ${stages.filter((s) => s.passed).length}/${stages.length} passées` +
      (halted ? ` ${c.dim}(arrêt à « ${halted} »)${c.reset}` : ''),
  );
  console.log(`  EVIDENCE USED:     ${evidenceUsed.length} (${evidenceUsed.filter((e) => e.sourceRef).length} sourcées)`);
  console.log(`  SIMULATED EVIDENCE:${simulatedEvidence === 0 ? ` ${c.green}0${c.reset}` : ` ${c.red}${simulatedEvidence}${c.reset}`}`);
  console.log(`  RETRIES:           ${stages.reduce((a, s) => a + s.repaired, 0)} réparation(s)`);
  console.log();
  console.log(
    `  ${c.bold}VERDICT: ${verdict === 'PASS' ? c.green : verdict === 'PARTIAL' ? c.amber : c.red}${verdict}${c.reset}`,
  );
  console.log();

  await system.shutdown('micro-run terminé');
  process.exitCode = verdict === 'PASS' ? 0 : 1;

  function stageLine(name: string): string {
    const stage = stages.find((s) => s.name === name);
    if (!stage) return `${c.dim}non atteinte${c.reset}`;
    return stage.passed ? `${c.green}OK${c.reset}` : `${c.red}FAILED${c.reset}`;
  }
}

/** La mission réelle la plus récente qui porte des candidats exploitables. */
async function firstMissionWithCandidates(repos: ReturnType<typeof createSystem>['repos']): Promise<string> {
  const missions = repos.missions.list({ limit: 100, offset: 0 }).items;
  for (const mission of missions) {
    const candidates = repos.opportunities.forMission(mission.id);
    const usable = candidates.filter((o) => {
      const company = repos.companies.get(o.companyId);
      return company?.dataOrigin === 'live' && company.identityStatus === 'ok';
    });
    if (usable.length > 0) return mission.id;
  }
  throw new Error('Aucune mission ne porte de candidat réel exploitable.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
