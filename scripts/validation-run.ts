/**
 * Exécute une mission de validation, et mesure tout ce qu'elle fait.
 *
 *   npm run val -- VAL-001-DISCOVERY            contrôle seul, aucune dépense
 *   npm run val -- VAL-001-DISCOVERY --go       exécution réelle
 *
 * La mesure est le produit de ce script, pas l'exécution. Une mission qui
 * tourne sans qu'on sache combien d'appels chaque étape a passés ne valide
 * rien — c'est exactement pourquoi il a fallu trois reprises pour comprendre ce
 * que faisait LIVE PILOT 001.
 *
 * Tout ce qui est rapporté ici est lu en base après coup, jamais estimé.
 */
import { createSystem } from '../packages/server/src/bootstrap.ts';
import { loadConfig, formatDuration } from '../packages/core/src/index.ts';
import { preflight, formatPreflight } from '../packages/runtime/src/preflight.ts';
import { evaluatePilot, formatPilotReport } from '../packages/runtime/src/pilot-verdict.ts';
import { createSearchFabric } from '../packages/intelligence/src/search/fabric/factory.ts';
import { missionEconomics } from '../packages/intelligence/src/economics.ts';
import { presetById, VALIDATION_PRESETS } from '../packages/departments/src/validation-presets.ts';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  amber: '\x1b[33m',
  red: '\x1b[31m',
};

const GO = process.argv.includes('--go');
const presetId = process.argv[2];

async function main(): Promise<void> {
  const preset = presetId ? presetById(presetId) : undefined;
  if (!preset) {
    console.error(`\n  Preset inconnu : « ${presetId ?? '(aucun)'} »\n`);
    for (const p of VALIDATION_PRESETS) {
      console.error(`    ${p.id.padEnd(24)} ${p.limits.maxCostUsd.toFixed(2)} $  ${p.title}`);
    }
    console.error();
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const system = createSystem(config);
  const { repos } = system;

  console.log(`\n${c.bold}  ${preset.id} — ${preset.title}${c.reset}`);
  console.log(`  ${c.dim}${preset.validates}${c.reset}\n`);
  console.log(`  ${c.bold}Plafond ${preset.limits.maxCostUsd.toFixed(2)} $${c.reset} · ${preset.limits.model}\n`);

  // ── Contrôle avant décollage ────────────────────────────────────────────
  const fabric = createSearchFabric(config.search, { need: preset.need ?? undefined });
  const report = await preflight({
    config,
    repos,
    search: fabric,
    // Le parc d'inférence change la question posée : non plus « Anthropic
    // répond-il ? » mais « en reste-t-il un capable de servir ? ». Sans lui, le
    // contrôle bloquerait sur le premier fournisseur en panne alors qu'un
    // secours existe peut-être.
    inferenceFabric: system.inferenceFabric,
    logger: system.logger,
    missionBudgetUsd: preset.limits.maxCostUsd,
    ...(preset.need ? { need: preset.need } : {}),
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
    context: preset.context,
    departmentKey: preset.departmentKey,
    tags: preset.tags,
    tokenBudget: preset.limits.maxTokens,
    createdBy: 'validation',
    autoStart: true,
  });

  console.log(`  Mission ${c.bold}${mission.code}${c.reset} lancée\n`);
  console.log(`  ${c.dim}temps  │ étape${c.reset}`);
  console.log(`  ${c.dim}───────┼──────────────────────────────────────────────${c.reset}`);

  const seen = new Set<string>();
  const at = (): string => `${((Date.now() - started) / 1000).toFixed(0).padStart(5)}s`;

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

    // Le plafond, surveillé de l'extérieur autant que de l'intérieur. La marge
    // de 2 % couvre l'écart entre le coût estimé au moment d'autoriser et le
    // coût réel facturé ; au-delà, on coupe.
    const spend = missionEconomics({ repos, missionId: mission.id, model: preset.limits.model, simulated: false });
    if ((spend.estimatedCostUsd ?? 0) > preset.limits.maxCostUsd * 1.02) {
      console.log(`\n  ${c.red}Plafond dépassé — annulation.${c.reset}`);
      system.hermes.cancel(mission.id, 'Plafond de dépense atteint');
      break;
    }

    if (['completed', 'validated', 'failed'].includes(current.status)) break;
    if (Date.now() - started > preset.limits.maxMissionDurationMs) {
      console.log(`\n  ${c.amber}Durée maximale atteinte — annulation.${c.reset}`);
      system.hermes.cancel(mission.id, 'Durée maximale atteinte');
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log(`  ${c.dim}───────┴──────────────────────────────────────────────${c.reset}\n`);

  // ── Mesure ──────────────────────────────────────────────────────────────
  const final = repos.missions.require(mission.id);
  const economics = missionEconomics({ repos, missionId: mission.id, model: preset.limits.model, simulated: false });
  const cost = economics.estimatedCostUsd ?? 0;
  const llm = repos.llmCalls.forMission(mission.id);
  const tools = repos.toolCalls.forMission(mission.id);
  const opportunities = repos.opportunities.forMission(mission.id);
  const evidence = repos.companies.evidenceForMission(mission.id);
  const decisions = repos.decisions.forMission(mission.id);
  const unsupported = repos.decisions.unsupportedClaims(mission.id);

  const byStep = new Map<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }>();
  for (const call of llm) {
    const key = call.taskRef ?? '(hors étape)';
    const entry = byStep.get(key) ?? { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    entry.calls += 1;
    entry.inputTokens += call.inputTokens;
    entry.outputTokens += call.outputTokens;
    entry.costUsd += call.costUsd ?? 0;
    byStep.set(key, entry);
  }

  const candidates = opportunities.length;
  const qualified = repos.opportunities.countQualified(mission.id);
  const sourced = evidence.filter((e) => Boolean(e.sourceRef)).length;
  const simulated = evidence.filter((e) => e.simulated).length;
  const searchCalls = tools.filter((t) => t.tool.includes('search')).length;
  const pages = tools.filter((t) => t.tool === 'http_fetch' || t.tool === 'fetch_page').length;
  const per = (n: number): string => (n > 0 ? `${(cost / n).toFixed(4)} $` : '—');

  console.log(`  ${c.bold}${preset.id} — MESURE${c.reset}\n`);
  console.log(`    statut            ${final.status}`);
  console.log(`    durée             ${formatDuration(Date.now() - started)}`);
  console.log(`    coût              ${c.bold}${cost.toFixed(4)} $${c.reset} ${c.dim}(plafond ${preset.limits.maxCostUsd.toFixed(2)} $)${c.reset}`);
  console.log();

  // ── Le chiffre qui décide : les appels par étape ────────────────────────
  // Onze appels d'enrichissement pour trois candidats, c'est ce qui a rendu
  // LIVE PILOT 001 trop cher. La colonne « /cand » est la mesure demandée.
  console.log(`  ${c.bold}Appels par étape${c.reset}`);
  console.log(`    ${'étape'.padEnd(16)} appels  entrée   sortie    coût     /cand`);
  for (const [step, e] of [...byStep.entries()].sort()) {
    const perCand = candidates > 0 ? (e.calls / candidates).toFixed(1) : '—';
    console.log(
      `    ${step.padEnd(16)} ${String(e.calls).padStart(6)}  ${String(e.inputTokens).padStart(6)}  ` +
        `${String(e.outputTokens).padStart(6)}  ${e.costUsd.toFixed(4)}$  ${perCand.padStart(6)}`,
    );
  }
  console.log();

  console.log(`  ${c.bold}Résultats${c.reset}`);
  console.log(`    candidats         ${candidates}`);
  console.log(`    qualifiés         ${qualified}`);
  console.log(`    preuves           ${evidence.length} ${c.dim}(${sourced} sourcées, ${simulated} simulées)${c.reset}`);
  console.log(
    `      observed        ${evidence.filter((e) => e.nature === 'observed').length}` +
      ` · reported ${evidence.filter((e) => e.nature === 'reported').length}` +
      ` · inferred ${evidence.filter((e) => e.nature === 'inferred').length}`,
  );
  console.log(`    opportunités      ${opportunities.filter((o) => o.stage !== 'discovered').length} proposée(s)`);
  console.log();

  console.log(`  ${c.bold}Économie${c.reset}`);
  console.log(`    appels LLM        ${llm.length}`);
  console.log(`    recherches        ${searchCalls}`);
  console.log(`    pages lues        ${pages}`);
  console.log(`    jetons            ${economics.measured?.inputTokens ?? 0} entrée · ${economics.measured?.outputTokens ?? 0} sortie`);
  console.log(`    par candidat      ${per(candidates)}`);
  console.log(`    par qualifié      ${per(qualified)}`);
  console.log(`    par preuve        ${per(evidence.length)}`);
  console.log(`    par opportunité   ${per(opportunities.filter((o) => o.stage !== 'discovered').length)}`);
  console.log();

  console.log(`  ${c.bold}Fiabilité${c.reset}`);
  const retries = repos.missions.tasksFor(mission.id).reduce((n, t) => n + Math.max(0, t.attempts - 1), 0);
  const cancelledSteps = repos.missions.tasksFor(mission.id).filter((t) => t.status === 'cancelled');
  console.log(`    réessais          ${retries}`);
  console.log(`    étapes annulées   ${cancelledSteps.length}${cancelledSteps.length ? ` (${cancelledSteps.map((t) => t.ref).join(', ')})` : ''}`);
  console.log(`    outils en échec   ${tools.filter((t) => !t.ok).length} / ${tools.length}`);
  console.log(`    décisions Hermès  ${decisions.length} ${c.dim}(${unsupported.length} sans preuve)${c.reset}`);
  console.log();

  // ── Search Fabric, après ────────────────────────────────────────────────
  if (system.searchFabric) {
    const trace = system.searchFabric.lastTrace();
    console.log(`  ${c.bold}Search Fabric — après${c.reset}`);
    for (const s of system.searchFabric.statuses()) {
      console.log(
        `    ${s.id.padEnd(12)} santé=${String(s.health).padEnd(9)} circuit=${String(s.circuit.state).padEnd(10)}` +
          ` appels=${s.metrics.calls}` +
          (s.score ? ` réussite=${(s.score.successRate * 100).toFixed(0)}% latence=${s.score.averageLatencyMs}ms` : '') +
          (s.circuit.cooldownRemainingMs > 0 ? ` ${c.amber}cooldown ${Math.ceil(s.circuit.cooldownRemainingMs / 60_000)}min${c.reset}` : ''),
      );
      if (s.circuit.lastFailureReason) {
        console.log(`      ${c.dim}dernier échec : ${s.circuit.lastFailureReason.slice(0, 90)}${c.reset}`);
      }
    }
    if (trace.attempts.length > 0) {
      console.log(`    ${c.dim}dernier appel : ${trace.attempts.map((a) => `${a.providerId}→${a.outcome}`).join(' · ')}${c.reset}`);
    }
    console.log();
  }

  // ── Verdict ─────────────────────────────────────────────────────────────
  const pilot = evaluatePilot({
    repos,
    missionId: mission.id,
    maxCostUsd: preset.limits.maxCostUsd,
    spentUsd: cost,
  });
  console.log(formatPilotReport(pilot));
  console.log();

  await system.shutdown('validation terminée');
  process.exitCode = pilot.verdict === 'PASS' ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
