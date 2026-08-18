/**
 * Prépare la revue humaine du dernier rapport, et régénère le document avec
 * les traductions françaises.
 *
 *   npm run review                  prépare, n'approuve rien
 *   npm run review -- --submit      passe en PENDING_REVIEW
 *
 * **Rien n'est auto-approuvé.** Ce script constate ce qu'une machine peut
 * constater — une preuve simulée se compte, une source absente se voit — et
 * laisse à un humain tout ce qui demande de lire. Chaque point sort en PASS,
 * FAIL ou NEEDS REVIEW, et « NEEDS REVIEW » n'est pas un demi-PASS : c'est un
 * point qu'aucune vérification automatique ne peut trancher.
 *
 * Aucun appel au modèle. Tout vient de la base et du fichier produit.
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createSystem } from '../packages/server/src/bootstrap.ts';
import { loadConfig } from '../packages/core/src/index.ts';
import {
  buildClientReport,
  reportToHtml,
  reportToCsv,
  teaserToHtml,
  translationMap,
  checkTranslationMap,
  rationaleTranslationMap,
  UNVERIFIED_POINTS,
  reportEconomics,
  orderEconomics,
  canDeliver,
  REVIEW_CHECKLIST,
  PIPELINE_VERSION,
  evaluateApproval,
  parseDeclaredChecks,
  HUMAN_CHECKS,
  type ReportEntry,
} from '../packages/departments/src/index.ts';

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m',
};

const SUBMIT = process.argv.includes('--submit');
const APPROVE = process.argv.includes('--approve');
const REVIEWER = process.argv.find((a) => a.startsWith('--reviewer='))?.slice(11);
const PRICE_EUR = Number(process.argv.find((a) => a.startsWith('--price='))?.slice(8) ?? 49);

type Judgement = 'PASS' | 'FAIL' | 'NEEDS REVIEW';

async function main(): Promise<void> {
  const config = loadConfig();
  const system = createSystem(config);
  const { repos } = system;

  const row = repos.orders.listReports(1)[0];
  if (!row) {
    console.error(`\n  ${c.red}Aucun rapport archivé.${c.reset}\n`);
    await system.shutdown('aucun rapport');
    process.exitCode = 1;
    return;
  }

  const mission = repos.missions.require(row.missionId);
  const department = repos.departments.require(mission.departmentKey ?? 'business-expansion');
  const ranked = repos.opportunities
    .forMission(row.missionId)
    .filter((o) => o.rank !== null)
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));

  const translations = translationMap();
  const checkTranslations = checkTranslationMap();
  const rationaleTranslations = rationaleTranslationMap();
  const entries: ReportEntry[] = ranked.map((o) => ({
    opportunity: o,
    company: repos.companies.require(o.companyId),
    evidence: repos.companies.evidenceForOpportunity(o.id),
    contacts: repos.companies.contactsFor(o.companyId),
    translations,
    checkTranslations,
    rationaleTranslations,
  }));

  const economics = reportEconomics(
    {
      llmCostUsd: row.costUsd ?? 0,
      searchCostUsd: 0,
      candidates: row.candidates,
      usefulOpportunities: row.retained,
    },
    { sellingPriceEur: PRICE_EUR },
  );

  const report = buildClientReport({
    clientName: 'Prospect — offre de lancement',
    missionTitle: 'Distributeurs allemands — emballage industriel',
    market: 'Allemagne · machines et lignes d’emballage',
    objective:
      "Distributeurs ou intégrateurs allemands capables de représenter une offre B2B " +
      "industrielle d'emballage auprès d'industriels français.",
    generatedAt: row.generatedAt,
    analysedCount: row.candidates,
    entries,
    scoringModel: department.scoringModel,
    unverifiedPoints: UNVERIFIED_POINTS,
    provenance: {
      missionId: mission.code,
      generatedAt: row.generatedAt,
      pipelineVersion: PIPELINE_VERSION,
      scoringVersion: row.scoringVersion,
      executionMode: row.executionMode as 'live' | 'simulation',
      evidenceIds: row.evidenceIds,
      sources: row.sources,
      costUsd: row.costUsd ?? 0,
      reviewer: row.reviewer,
      approvedAt: row.approvedAt,
      state: row.state,
    },
    economics,
  });

  // ── Régénération avec les traductions ───────────────────────────────────
  if (row.htmlPath) writeFileSync(row.htmlPath, reportToHtml(report), 'utf8');
  if (row.csvPath) writeFileSync(row.csvPath, reportToCsv(report), 'utf8');
  if (row.teaserPath) {
    writeFileSync(row.teaserPath, teaserToHtml(report, { priceEur: PRICE_EUR, deliveryHours: 24 }), 'utf8');
  }

  const allEvidence = entries.flatMap((e) => e.evidence);
  const translated = allEvidence.filter((e) => translations[e.id]).length;

  console.log(`\n${c.bold}  REVUE HUMAINE — ${row.id}${c.reset}`);
  console.log(`  ${c.dim}mission ${mission.code} · état ${row.state} · ${row.retained}/${row.candidates} retenus${c.reset}\n`);
  console.log(`  ${c.bold}Traductions${c.reset}`);
  console.log(`    ${translated}/${allEvidence.length} preuves traduites, originaux conservés\n`);

  // ── Les huit points ─────────────────────────────────────────────────────
  //
  // Ce qu'une machine peut constater, elle le constate. Le reste sort en
  // NEEDS REVIEW plutôt qu'en PASS optimiste : un point non vérifié coché
  // vert vaut moins que pas de liste du tout.
  const simulated = allEvidence.filter((e) => e.simulated).length;
  const unsupported = allEvidence.filter((e) => e.nature !== 'inferred' && !e.sourceRef).length;
  const inferredWithoutBasis = allEvidence.filter((e) => e.nature === 'inferred' && !e.basis).length;
  const companies = entries.map((e) => e.company);
  const badLineage = companies.filter((k) => k.dataOrigin !== 'live' || k.identityStatus !== 'ok');
  const invented = entries.flatMap((e) =>
    e.contacts.filter((k) => k.email && !k.evidenceId && /^[a-z]\.[a-z]+@/i.test(k.email)),
  );
  const scoresJustified = ranked.every(
    (o) => (o.scoreDetail?.components ?? []).some((k) => (k.evidenceIds?.length ?? 0) > 0),
  );
  const htmlExists = Boolean(row.htmlPath && existsSync(row.htmlPath));
  const htmlHasOriginals =
    htmlExists && allEvidence.every((e) => readFileSync(row.htmlPath!, 'utf8').includes(escapeHtml(e.claim.slice(0, 40))));

  const findings: Record<string, { judgement: Judgement; detail: string }> = {
    'sources-live': {
      judgement: 'NEEDS REVIEW',
      detail:
        `${report.sources.length} URL distincte(s) citée(s). Aucune n'a été ouverte : ` +
        `vérifier qu'elles répondent et montrent ce qui est affirmé.`,
    },
    'evidence-coherent': {
      judgement: 'NEEDS REVIEW',
      detail:
        `${allEvidence.length} preuves derrière ${entries.length} synthèses. ` +
        `Comparer chaque « pourquoi cette entreprise » aux preuves qui le portent.`,
    },
    'no-simulation': {
      judgement: simulated === 0 && badLineage.length === 0 ? 'PASS' : 'FAIL',
      detail:
        simulated === 0 && badLineage.length === 0
          ? `0 preuve simulée · ${companies.length} fiche(s) de lignée réelle et d'identité saine.`
          : `${simulated} preuve(s) simulée(s), ${badLineage.length} fiche(s) douteuse(s).`,
    },
    'no-invented-contact': {
      judgement: invented.length === 0 ? 'PASS' : 'FAIL',
      detail:
        invented.length === 0
          ? `Aucune adresse au format reconstruit. ` +
            `${entries.flatMap((e) => e.contacts).length} contact(s), tous relevés sur une source.`
          : `${invented.length} adresse(s) au format « p.nom@ » sans preuve rattachée.`,
    },
    'scores-justified': {
      judgement: scoresJustified ? 'PASS' : 'FAIL',
      detail: scoresJustified
        ? 'Chaque note porte une décomposition dont au moins une dimension cite des preuves.'
        : 'Au moins une note ne cite aucune preuve.',
    },
    'translation-faithful': {
      judgement: translated === 0 ? 'FAIL' : 'NEEDS REVIEW',
      detail:
        `${translated}/${allEvidence.length} traduites, originaux conservés dans le document. ` +
        `Relire chaque paire : une nuance perdue change ce qu'on affirme.`,
    },
    'opportunities-relevant': {
      judgement: 'NEEDS REVIEW',
      detail:
        `${entries.map((e) => e.company.name).join(', ')}. ` +
        `Juger si elles correspondent au besoin réel du client, pas seulement au score.`,
    },
    'no-unsupported-claim': {
      judgement: unsupported === 0 && inferredWithoutBasis === 0 ? 'PASS' : 'FAIL',
      detail:
        unsupported === 0 && inferredWithoutBasis === 0
          ? 'Toute affirmation de fait porte une source ; toute déduction porte sa base.'
          : `${unsupported} fait(s) sans source, ${inferredWithoutBasis} déduction(s) sans base.`,
    },
  };

  console.log(`  ${c.bold}Les huit points${c.reset}\n`);
  for (const item of REVIEW_CHECKLIST) {
    const f = findings[item.key]!;
    const colour = f.judgement === 'PASS' ? c.green : f.judgement === 'FAIL' ? c.red : c.amber;
    console.log(`  ${colour}${f.judgement.padEnd(13)}${c.reset}${item.question}`);
    console.log(`                ${c.dim}${f.detail}${c.reset}`);
    console.log(`                ${c.dim}Pourquoi : ${item.why}${c.reset}\n`);
  }

  const automatic = Object.values(findings);
  const failed = automatic.filter((f) => f.judgement === 'FAIL').length;
  const pending = automatic.filter((f) => f.judgement === 'NEEDS REVIEW').length;

  console.log(`  ${c.bold}Bilan${c.reset}`);
  console.log(`    ${automatic.filter((f) => f.judgement === 'PASS').length} constatés automatiquement`);
  console.log(`    ${pending} demandent une lecture humaine`);
  console.log(`    ${failed} en échec\n`);

  // ── Garde de livraison ──────────────────────────────────────────────────
  const delivery = canDeliver({
    paymentStatus: 'NONE',
    reviewStatus: row.state,
    simulatedEvidence: simulated,
    unsupportedClaims: unsupported,
  });
  console.log(`  ${c.bold}Garde de livraison${c.reset}`);
  console.log(`    ${delivery.allowed ? `${c.green}ouverte${c.reset}` : `${c.red}fermée${c.reset}`}`);
  for (const b of delivery.blockers) console.log(`      ${c.dim}· ${b}${c.reset}`);
  console.log();

  const money = orderEconomics({ sellingPriceEur: PRICE_EUR, productionCostUsd: row.costUsd ?? 0 });
  console.log(`  ${c.bold}Économie${c.reset}`);
  console.log(`    prix de vente      ${money.sellingPriceEur.toFixed(2)} €`);
  console.log(`    coût de production ${money.productionCostUsd.toFixed(4)} $ (${money.productionCostEur.toFixed(4)} €)`);
  console.log(`    marge brute        ${money.grossMarginEur.toFixed(4)} €`);
  console.log(`    marge              ${money.grossMarginPercent} %\n`);

  // ── Approbation humaine ─────────────────────────────────────────────────
  //
  // Réclamée point par point sur la ligne de commande. Le système ne coche
  // jamais un point humain : il n'existe aucun chemin, ici, qui transforme un
  // « NEEDS REVIEW » en « PASS » sans que quelqu'un l'ait tapé.
  if (APPROVE) {
    const decision = evaluateApproval({
      reportState: row.state,
      declaredChecks: parseDeclaredChecks(process.argv),
      automaticVerdicts: Object.fromEntries(
        Object.entries(findings)
          .filter(([, f]) => f.judgement !== 'NEEDS REVIEW')
          .map(([key, f]) => [key, f.judgement as 'PASS' | 'FAIL']),
      ),
      simulatedEvidence: simulated,
      unsupportedClaims: unsupported + inferredWithoutBasis,
    });

    if (!decision.approved) {
      console.log(`  ${c.bold}${c.red}APPROBATION REFUSÉE${c.reset}
`);
      for (const refusal of decision.refusals) {
        console.log(`    ${c.red}${refusal.code}${c.reset}`);
        console.log(`      ${refusal.message}`);
      }
      console.log(
        `
  ${c.dim}Syntaxe attendue :
` +
          `    npm run review -- --approve ${HUMAN_CHECKS.map((k) => `--check=${k}`).join(' ')}${c.reset}
`,
      );
      await system.shutdown('approbation refusée');
      process.exitCode = 1;
      return;
    }

    // Le relecteur : l'identité locale quand elle existe, sinon ce qui a été
    // déclaré. Jamais « atlas » — une approbation engage quelqu'un.
    const founder = repos.users.list().find((u) => u.role === 'founder');
    const reviewer = REVIEWER ?? founder?.email ?? founder?.name ?? 'relecteur-local';

    const approved = repos.orders.setReportState(row.id, 'APPROVED_FOR_DELIVERY', {
      reviewer,
      passed: decision.passedKeys,
      notes: `Approbation manuelle · ${decision.humanChecks.length} point(s) humain(s) déclaré(s).`,
    });

    const guard = canDeliver({
      paymentStatus: 'NONE',
      reviewStatus: approved.state,
      simulatedEvidence: simulated,
      unsupportedClaims: unsupported,
    });

    console.log(`  ${c.bold}${c.green}HUMAN REVIEW APPROVED${c.reset}
`);
    console.log(`    report:            ${approved.id}`);
    console.log(`    mission:           ${mission.code}`);
    console.log(`    reviewer:          ${approved.reviewer}`);
    console.log(`    approvedAt:        ${approved.approvedAt}`);
    console.log(`    human checks:      ${decision.humanChecks.join(', ')}`);
    console.log(
      `    automatic checks:  ${decision.automaticChecks.map((k) => `${k.key}=${k.verdict}`).join(', ')}`,
    );
    console.log();
    console.log(
      `    delivery guard:    ${guard.allowed ? `${c.green}OPEN${c.reset}` : `${c.red}CLOSED${c.reset}`}`,
    );
    for (const b of guard.blockers) console.log(`      ${c.dim}· ${b}${c.reset}`);
    console.log();

    await system.shutdown('rapport approuvé');
    return;
  }

  if (SUBMIT && row.state === 'GENERATED') {
    const submitted = repos.orders.setReportState(row.id, 'PENDING_REVIEW');
    console.log(`  ${c.amber}Soumis à la revue : état ${submitted.state}.${c.reset}`);
    console.log(`  ${c.dim}L'approbation demande les huit points cochés par un humain.${c.reset}\n`);
  } else {
    console.log(`  ${c.dim}Rien n'a été approuvé. Ce script ne coche aucun point à votre place.${c.reset}\n`);
  }

  await system.shutdown('revue préparée');
}

const escapeHtml = (t: string): string =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
