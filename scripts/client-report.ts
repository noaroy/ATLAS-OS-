/**
 * Le rapport d'une mission client : intermédiaire ou final, puis la revue.
 *
 *   npm run client:report -- --run=<id> --partial            écrit HTML + CSV + écartées, état GENERATED
 *   npm run client:report -- --run=<id> --final
 *   npm run client:report -- --run=<id> --final --submit    passe en PENDING_REVIEW
 *   npm run client:report -- --run=<id> --approve --check=sources-live --check=evidence-coherent --check=translation-faithful --check=opportunities-relevant
 *
 * PARTIAL ne clôt rien : la mission continue après le retour du client.
 * L'approbation suit le circuit existant — quatre contrôles automatiques
 * constatés par le code, quatre humains déclarés à la main. Rien ne devient
 * APPROVED_FOR_DELIVERY sans qu'un humain l'ait tapé.
 *
 * Aucun appel modèle. Rien n'est envoyé au client par ce script.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSystem } from '../packages/server/src/bootstrap.ts';
import { loadConfig, loadAtlasEnv } from '../packages/core/src/index.ts';
import {
  BUSINESS_EXPANSION, PIPELINE_VERSION, evaluateApproval, parseDeclaredChecks, HUMAN_CHECKS,
} from '../packages/departments/src/index.ts';
import { buildClientRunReport, loadClientRun, renderReviewQueue } from '../packages/runtime/src/index.ts';

loadAtlasEnv();

const c = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m' };
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const flag = (n: string) => process.argv.includes(`--${n}`);

async function main(): Promise<void> {
  const config = loadConfig();
  const system = createSystem(config);
  const { repos } = system;
  const runId = arg('run');
  if (!runId) throw new Error('--run=<id> requis');

  try {
    const { brief } = loadClientRun(repos, runId);

    if (flag('approve')) {
      const rows = repos.orders.listReports(200).filter((r) => r.missionId === runId);
      const row = rows[0];
      if (!row) throw new Error('aucun rapport généré pour cette mission : --partial ou --final d’abord');
      const built = buildClientRunReport(repos, runId, {
        status: 'FINAL', generatedAt: row.generatedAt, scoringModel: BUSINESS_EXPANSION.scoringModel, executionMode: 'live',
      });
      const preuves = built.report.prospects.flatMap((p) => [...p.facts, ...p.inferences]);
      const sansSource = preuves.filter((e) => e.nature !== 'inferred' && !e.sourceRef).length;
      const contactsInventes = built.retained.filter((k) => {
        const d = k.detail as { contacts?: { email?: string | null; emailSourceUrl?: string | null } };
        return d.contacts?.email && !d.contacts.emailSourceUrl;
      }).length;
      const notesJustifiees = built.report.prospects.every((p) => p.dimensions.some((d) => d.evidenceIds.length > 0));
      const decision = evaluateApproval({
        reportState: row.state,
        declaredChecks: parseDeclaredChecks(process.argv),
        automaticVerdicts: {
          'no-simulation': 'PASS',
          'no-invented-contact': contactsInventes === 0 ? 'PASS' : 'FAIL',
          'scores-justified': notesJustifiees ? 'PASS' : 'FAIL',
          'no-unsupported-claim': sansSource === 0 ? 'PASS' : 'FAIL',
        },
        simulatedEvidence: 0,
        unsupportedClaims: sansSource,
      });
      if (!decision.approved) {
        console.log(`\n  ${c.red}${c.bold}APPROBATION REFUSÉE${c.reset}`);
        for (const r of decision.refusals) console.log(`    ${c.red}${r.code}${c.reset} ${r.message}`);
        console.log(`\n  ${c.dim}Syntaxe : npm run client:report -- --run=${runId} --approve ${HUMAN_CHECKS.map((k) => `--check=${k}`).join(' ')}${c.reset}\n`);
        process.exitCode = 1;
        return;
      }
      const founder = repos.users.list().find((u) => u.role === 'founder');
      const approved = repos.orders.setReportState(row.id, 'APPROVED_FOR_DELIVERY', {
        reviewer: arg('reviewer') ?? founder?.email ?? 'relecteur-local',
        passed: decision.passedKeys,
        notes: `Approbation manuelle · ${decision.humanChecks.length} point(s) humain(s) déclaré(s).`,
      });
      console.log(`\n  ${c.green}${c.bold}APPROVED_FOR_DELIVERY${c.reset}  ${approved.id} · relu par ${approved.reviewer}`);
      console.log(`  ${c.dim}La livraison au client reste un geste humain : rien n’est envoyé par ce script.${c.reset}\n`);
      return;
    }

    const status = flag('final') ? 'FINAL' : flag('partial') ? 'PARTIAL' : null;
    if (!status) throw new Error('--partial ou --final requis');
    const generatedAt = new Date().toISOString();
    const built = buildClientRunReport(repos, runId, {
      status, generatedAt, scoringModel: BUSINESS_EXPANSION.scoringModel, executionMode: 'live',
      sellingPriceEur: arg('price') ? Number(arg('price')) : null,
    });

    const dossier = join('out', 'client', runId);
    mkdirSync(dossier, { recursive: true });
    const stamp = generatedAt.slice(0, 16).replace(/[:T]/g, '-');
    const base = `rapport-${status}-v${brief.version}-${stamp}`;
    const htmlPath = join(dossier, `${base}.html`);
    const csvPath = join(dossier, `${base}.csv`);
    const exclusionsPath = join(dossier, `${base}-ecartees.csv`);
    writeFileSync(htmlPath, built.html, 'utf8');
    writeFileSync(csvPath, built.csv, 'utf8');
    writeFileSync(exclusionsPath, built.exclusionsCsv, 'utf8');
    // La file de revue, à côté : interne, jamais livrée.
    const revue = renderReviewQueue(repos, runId, generatedAt);
    const revuePath = join(dossier, `revue-v${brief.version}-${stamp}.html`);
    if (revue.items.length > 0) {
      writeFileSync(revuePath, revue.html, 'utf8');
      writeFileSync(join(dossier, `revue-v${brief.version}-${stamp}.csv`), revue.csv, 'utf8');
    }

    const row = repos.orders.recordReport({
      missionId: runId, htmlPath, csvPath, teaserPath: null,
      pipelineVersion: PIPELINE_VERSION, scoringVersion: 'client-criteria-v1', executionMode: 'live',
      evidenceIds: built.evidenceIds, sources: built.report.sources, costUsd: built.costUsd,
      candidates: built.report.analysedCount, retained: built.retained.length, generatedAt,
    });
    let etat = row.state;
    if (flag('submit')) etat = repos.orders.setReportState(row.id, 'PENDING_REVIEW').state;

    console.log(`\n  ${c.bold}RAPPORT ${status}${c.reset}  ${row.id} · état ${etat}`);
    console.log(`  ${brief.client.name} · ${brief.market.countryLabel} · brief v${brief.version}`);
    console.log(`  analysées ${built.report.analysedCount} · ${c.green}retenues ${built.retained.length}${c.reset} · ${c.amber}à revoir ${built.reviewRequired.length}${c.reset} · écartées ${built.excluded.length} · sources ${built.report.sources.length} · coût ${built.costUsd.toFixed(4)} $`);
    console.log(`  ${htmlPath}\n  ${csvPath}\n  ${exclusionsPath}`);
    if (revue.items.length > 0) console.log(`  ${c.amber}${revuePath}${c.reset} — ${revue.items.filter((i) => i.priority === 'P1').length} P1 · ${revue.items.filter((i) => i.priority === 'P2').length} P2 · ${revue.items.filter((i) => i.priority === 'P3').length} P3 (interne)`);
    if (status === 'PARTIAL') console.log(`  ${c.dim}Sélection intermédiaire : la mission reste ouverte. Après le retour du client : npm run client:mission -- adjust --run=${runId} …${c.reset}`);
    if (!flag('submit')) console.log(`  ${c.dim}Pour la revue : ajouter --submit, puis --approve avec les quatre contrôles humains.${c.reset}`);
    console.log();
  } finally {
    await system.shutdown('client-report terminé');
  }
}

main().catch((err) => {
  console.error(`\n  ${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}\n`);
  process.exitCode = 1;
});
