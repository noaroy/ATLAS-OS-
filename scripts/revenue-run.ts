/**
 * Exécute REVENUE-001 et produit le livrable client.
 *
 *   npm run revenue           contrôle seul, aucune dépense
 *   npm run revenue -- --go   exécution réelle
 *
 * Ce script diffère de `validation-run` sur un point qui change tout : il ne
 * mesure pas ATLAS, il fabrique ce qui sera vendu. La mission s'arrête donc
 * quand le livrable est bon — cinq prospects au-dessus de la barre — et le
 * reste du budget n'est pas dépensé.
 *
 * Le plafond est surveillé de l'extérieur autant que de l'intérieur. Le
 * registre budgétaire refuse déjà tout appel qui ne tient pas dans ce qui
 * reste ; cette boucle coupe en plus au premier dépassement constaté, parce
 * qu'une garde qui ne se vérifie qu'à un seul endroit n'est pas une garde.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createSystem } from '../packages/server/src/bootstrap.ts';
import { loadConfig, formatDuration } from '../packages/core/src/index.ts';
import { preflight, formatPreflight } from '../packages/runtime/src/preflight.ts';
import { createSearchFabric } from '../packages/intelligence/src/search/fabric/factory.ts';
import { missionEconomics } from '../packages/intelligence/src/economics.ts';
import {
  REVENUE_001,
  meetsQualityBar,
  whyBelowBar,
  shouldStopEarly,
  buildPack,
  packToHtml,
  packToCsv,
  type ProspectQuality,
} from '../packages/departments/src/index.ts';

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
const preset = REVENUE_001;

async function main(): Promise<void> {
  const config = loadConfig();
  const system = createSystem(config);
  const { repos } = system;

  console.log(`\n${c.bold}  ${preset.id} — ${preset.title}${c.reset}`);
  console.log(`  ${c.dim}${preset.promise}${c.reset}\n`);
  console.log(
    `  ${c.bold}Plafond ${preset.limits.maxCostUsd.toFixed(2)} $${c.reset} · ${preset.limits.model} · ` +
      `barre : score ≥ ${preset.qualityBar.minScore}, ` +
      `≥ ${preset.qualityBar.minFirsthandEvidence} preuves de première main, qualifié\n`,
  );

  // ── Contrôle avant décollage ────────────────────────────────────────────
  const fabric = createSearchFabric(config.search, { need: preset.need });
  const report = await preflight({
    config,
    repos,
    search: fabric,
    inferenceFabric: system.inferenceFabric,
    logger: system.logger,
    missionBudgetUsd: preset.limits.maxCostUsd,
    need: preset.need,
  });

  console.log(formatPreflight(report).replace(/^/gm, '  '));
  console.log();

  if (report.fabric) {
    console.log(`  ${c.bold}Search Fabric — avant${c.reset}`);
    for (const p of report.fabric.providers) {
      const excluded = report.fabric.excluded.find((e) => e.id === p.id);
      const rank = report.fabric.order.indexOf(p.id);
      const mark = rank === 0 ? `${c.green}▶${c.reset}` : excluded ? `${c.dim}·${c.reset}` : ' ';
      console.log(
        `   ${mark} ${p.id.padEnd(12)} santé=${String(p.health).padEnd(9)} circuit=${String(p.circuit.state).padEnd(10)}` +
          (excluded ? ` ${c.dim}écarté — ${excluded.reason.slice(0, 70)}${c.reset}` : ''),
      );
    }
    console.log();
  }

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
  const mission = await system.hermes.submit({
    title: `${preset.id} — ${preset.title}`,
    objective: preset.objective,
    context: {
      ...preset.context,
      maxOutputTokensPerCall: preset.limits.maxOutputTokensPerCall,
    },
    departmentKey: preset.departmentKey,
    tags: preset.tags,
    tokenBudget: preset.limits.maxTokens,
    createdBy: 'revenue',
    autoStart: true,
  });

  console.log(`  Mission ${c.bold}${mission.code}${c.reset} lancée\n`);
  console.log(`  ${c.dim}temps  │ étape${c.reset}`);
  console.log(`  ${c.dim}───────┼──────────────────────────────────────────────${c.reset}`);

  const seen = new Set<string>();
  const at = (): string => `${((Date.now() - started) / 1000).toFixed(0).padStart(5)}s`;

  /** L'état de qualité des candidats, lu en base — jamais estimé. */
  const readQuality = (): ProspectQuality[] =>
    repos.opportunities.forMission(mission.id).map((o) => ({
      opportunityId: o.id,
      score: o.score,
      firsthandEvidence: repos.companies
        .evidenceForOpportunity(o.id)
        .filter((e) => e.nature !== 'inferred' && Boolean(e.sourceRef)).length,
      qualified: o.qualification?.verdict === 'qualified',
    }));

  let stopNote = '';

  for (let tick = 0; tick < 500; tick++) {
    const current = repos.missions.get(mission.id);
    if (!current) break;

    for (const task of repos.missions.tasksFor(mission.id)) {
      const key = `${task.ref}:${task.status}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const mark =
        task.status === 'succeeded'
          ? `${c.green}✓${c.reset}`
          : task.status === 'failed'
            ? `${c.red}✗${c.reset}`
            : task.status === 'skipped' || task.status === 'cancelled'
              ? `${c.amber}—${c.reset}`
              : '▶';
      if (['running', 'succeeded', 'failed', 'skipped', 'cancelled'].includes(task.status)) {
        console.log(`  ${c.dim}${at()}${c.reset} │ ${mark} ${task.ref.padEnd(14)} ${task.agentKey}`);
        if (task.error) console.log(`         │   ${c.dim}${task.error.slice(0, 110)}${c.reset}`);
      }
    }

    const spend = missionEconomics({
      repos,
      missionId: mission.id,
      model: preset.limits.model,
      simulated: false,
    });
    const cost = spend.estimatedCostUsd ?? 0;

    // Le plafond est DUR : aucune marge de tolérance. Le registre refuse déjà
    // en amont tout appel qui ne tiendrait pas ; cette coupure est le second
    // verrou, et il se déclenche au premier dollar de trop, pas à 2 % près.
    if (cost > preset.limits.maxCostUsd) {
      stopNote = `plafond atteint à ${cost.toFixed(4)} $`;
      console.log(`\n  ${c.red}Plafond de ${preset.limits.maxCostUsd.toFixed(2)} $ atteint — arrêt.${c.reset}`);
      system.hermes.cancel(mission.id, 'Plafond de dépense atteint');
      break;
    }

    // La règle d'arrêt anticipé : on ne paie pas pour dépasser le pack.
    const quality = readQuality();
    const decision = shouldStopEarly(quality, preset, 0);
    if (decision.stop && decision.reason === 'target-reached') {
      stopNote = decision.explanation;
      console.log(`\n  ${c.green}${decision.explanation}${c.reset}`);
      console.log(`  ${c.dim}Budget restant non dépensé : ${(preset.limits.maxCostUsd - cost).toFixed(4)} $${c.reset}`);
      system.hermes.cancel(mission.id, 'Pack complet — arrêt anticipé');
      break;
    }

    if (['completed', 'validated', 'failed'].includes(current.status)) break;
    if (Date.now() - started > preset.limits.maxMissionDurationMs) {
      stopNote = 'durée maximale atteinte';
      console.log(`\n  ${c.amber}Durée maximale atteinte — arrêt.${c.reset}`);
      system.hermes.cancel(mission.id, 'Durée maximale atteinte');
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log(`  ${c.dim}───────┴──────────────────────────────────────────────${c.reset}\n`);

  // ── Mesure ──────────────────────────────────────────────────────────────
  const final = repos.missions.require(mission.id);
  const economics = missionEconomics({
    repos,
    missionId: mission.id,
    model: preset.limits.model,
    simulated: false,
  });
  const cost = economics.estimatedCostUsd ?? 0;
  const llm = repos.llmCalls.forMission(mission.id);
  const tools = repos.toolCalls.forMission(mission.id);
  const opportunities = repos.opportunities.forMission(mission.id);
  const evidence = repos.companies.evidenceForMission(mission.id);

  const quality = readQuality();
  const sellable = opportunities.filter((o) => {
    const q = quality.find((x) => x.opportunityId === o.id);
    return q ? meetsQualityBar(q, preset.qualityBar) : false;
  });

  console.log(`  ${c.bold}REVENUE-001 — MESURE${c.reset}\n`);
  console.log(`    statut            ${final.status}${stopNote ? ` ${c.dim}(${stopNote})${c.reset}` : ''}`);
  console.log(`    durée             ${formatDuration(Date.now() - started)}`);
  console.log(
    `    coût              ${c.bold}${cost.toFixed(4)} $${c.reset} ${c.dim}/ ${preset.limits.maxCostUsd.toFixed(2)} $${c.reset}` +
      (cost > preset.limits.maxCostUsd ? ` ${c.red}DÉPASSEMENT${c.reset}` : ` ${c.green}✓${c.reset}`),
  );
  console.log(`    appels LLM        ${llm.length}`);
  console.log(
    `    jetons            ${(economics.measured?.inputTokens ?? 0).toLocaleString('fr-FR')} entrée · ` +
      `${(economics.measured?.outputTokens ?? 0).toLocaleString('fr-FR')} sortie`,
  );
  console.log();

  // ── Le tri : qui est vendable, et pourquoi les autres ne le sont pas ────
  console.log(`  ${c.bold}Prospects${c.reset}`);
  for (const o of opportunities) {
    const company = repos.companies.get(o.companyId);
    const q = quality.find((x) => x.opportunityId === o.id)!;
    const ok = meetsQualityBar(q, preset.qualityBar);
    const why = ok ? '' : ` ${c.dim}— ${whyBelowBar(q, preset.qualityBar).join(', ')}${c.reset}`;
    console.log(
      `    ${ok ? `${c.green}✓${c.reset}` : `${c.dim}·${c.reset}`} ${(company?.name ?? o.companyId).slice(0, 42).padEnd(44)}` +
        `score ${String(o.score ?? '—').padStart(3)} · ${q.firsthandEvidence} preuve(s) · ` +
        `${company?.dataOrigin ?? '?'}${why}`,
    );
  }
  console.log();

  // ── Contamination : la question qui décide si on peut vendre ───────────
  const origins = { live: 0, simulated: 0, unknown: 0 };
  for (const o of opportunities) {
    const company = repos.companies.get(o.companyId);
    const key = (company?.dataOrigin ?? 'unknown') as keyof typeof origins;
    origins[key] = (origins[key] ?? 0) + 1;
  }
  const simulatedEvidence = evidence.filter((e) => e.simulated).length;
  console.log(`  ${c.bold}Lignée${c.reset}`);
  console.log(
    `    entreprises       ${origins.live} live · ${origins.simulated} simulated · ${origins.unknown} unknown`,
  );
  console.log(`    preuves simulées  ${simulatedEvidence}`);
  console.log(
    `    preuves sourcées  ${evidence.filter((e) => Boolean(e.sourceRef)).length} / ${evidence.length}`,
  );
  console.log();

  // ── Export ──────────────────────────────────────────────────────────────
  // Seuls les prospects vendables entrent dans le pack. Livrer un candidat
  // sous la barre reviendrait à facturer une ligne qu'on sait faible.
  const entries = sellable
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || (b.score ?? 0) - (a.score ?? 0))
    .map((o) => ({
      opportunity: o,
      company: repos.companies.require(o.companyId),
      evidence: repos.companies.evidenceForOpportunity(o.id),
      contacts: repos.companies.contactsFor(o.companyId),
    }));

  const pack = buildPack({
    title: preset.title,
    brief: preset.objective,
    generatedAt: new Date().toISOString(),
    entries,
  });

  mkdirSync(outDir, { recursive: true });
  const stem = `pack-expansion-b2b-allemagne-${mission.code}`;
  const htmlPath = join(outDir, `${stem}.html`);
  const csvPath = join(outDir, `${stem}.csv`);
  writeFileSync(htmlPath, packToHtml(pack), 'utf8');
  writeFileSync(csvPath, packToCsv(pack), 'utf8');

  const named = pack.prospects.filter((p) => p.contact?.name).length;
  const pageOnly = pack.prospects.filter((p) => !p.contact?.name && p.contact?.contactPage).length;

  console.log(`  ${c.bold}Livrable${c.reset}`);
  console.log(`    HTML              ${htmlPath}`);
  console.log(`    CSV               ${csvPath}`);
  console.log(`    prospects         ${pack.prospects.length}`);
  console.log(`    contact nominatif ${named}`);
  console.log(`    page de contact   ${pageOnly}`);
  console.log(`    limites signalées ${pack.limitations.length}`);
  console.log();

  // ── Verdict ─────────────────────────────────────────────────────────────
  const clean =
    origins.simulated === 0 && origins.unknown === 0 && simulatedEvidence === 0;
  const withinBudget = cost <= preset.limits.maxCostUsd;
  const enough = sellable.length >= preset.targetProspects;
  const ready = clean && withinBudget && enough;

  console.log(`  ${c.bold}READY TO SELL : ${ready ? `${c.green}YES` : `${c.red}NO`}${c.reset}`);
  console.log(
    `    ${enough ? '✓' : '✗'} ${sellable.length} / ${preset.targetProspects} prospects vendables`,
  );
  console.log(`    ${clean ? '✓' : '✗'} aucune lignée simulée ou inconnue`);
  console.log(
    `    ${withinBudget ? '✓' : '✗'} plafond respecté (${cost.toFixed(4)} $ / ${preset.limits.maxCostUsd.toFixed(2)} $)`,
  );
  console.log();

  await system.shutdown('revenue terminée');
  process.exitCode = ready ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
