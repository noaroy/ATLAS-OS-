/**
 * LIVE PILOT 001 — la première mission réelle, sous contrôle.
 *
 *   npm run live:pilot            contrôle avant décollage seulement
 *   npm run live:pilot -- --go    contrôle puis exécution réelle
 *
 * Sans `--go`, rien ne part : le script affiche le contrôle et s'arrête. C'est
 * délibéré. Cinq missions réelles ont déjà échoué pour 10,94 $, toutes pour des
 * raisons connaissables à l'avance, et à chaque fois le blocage a été découvert
 * après avoir payé.
 *
 * Avec `--go`, la mission part *uniquement* si chaque contrôle bloquant passe :
 * mode déclaré, clé présente, modèle autorisé, plafond défini, délais ordonnés,
 * base disponible, et moteur de recherche réellement interrogé — pas seulement
 * configuré.
 */
import { createSystem } from '../packages/server/src/bootstrap.ts';
import { loadConfig, formatDuration } from '../packages/core/src/index.ts';
import { preflight, formatPreflight } from '../packages/runtime/src/preflight.ts';
import { evaluatePilot, formatPilotReport } from '../packages/runtime/src/pilot-verdict.ts';
import { createSearchFabric } from '../packages/intelligence/src/search/fabric/factory.ts';
import { missionEconomics } from '../packages/intelligence/src/economics.ts';
import { LIVE_PILOT_MISSION, LIVE_PILOT_LIMITS, LIVE_PILOT_NEED } from '../packages/departments/src/live-pilot.ts';

const c = {
  reset: '[0m',
  dim: '[2m',
  bold: '[1m',
  green: '[32m',
  amber: '[33m',
  red: '[31m',
  cyan: '[36m',
};

const GO = process.argv.includes('--go');

async function main(): Promise<void> {
  const config = loadConfig();

  console.log(`\n${c.bold}  ${LIVE_PILOT_MISSION.code} — ${LIVE_PILOT_MISSION.title}${c.reset}\n`);

  const system = createSystem(config);

  // ── Contrôle avant décollage ────────────────────────────────────────────
  // Le contrôle doit porter sur le moteur qu'ATLAS utilisera réellement.
  // Vérifier DuckDuckGo pendant que le pipeline interroge Marginalia ne
  // prouverait rien — et refuserait le décollage pour un moteur qui ne sert pas.
  // Un parc, plus un moteur. Le point de défaillance unique disparaît : la
  // reprise n'est bloquée que si *tous* les moteurs adaptés sont indisponibles.
  const search = createSearchFabric(config.search, { need: LIVE_PILOT_NEED });

  const report = await preflight({
    config,
    repos: system.repos,
    search,
    logger: system.logger,
    missionBudgetUsd: LIVE_PILOT_LIMITS.maxCostUsd,
    need: LIVE_PILOT_NEED,
  });

  console.log(formatPreflight(report).replace(/^/gm, '  '));
  console.log();

  if (!report.cleared) {
    console.error(`  ${c.red}Aucune dépense engagée.${c.reset}\n`);
    await system.shutdown('preflight refusé');
    process.exitCode = 1;
    return;
  }

  if (!GO) {
    console.log(`  ${c.amber}Contrôle seul.${c.reset} Relancez avec --go pour exécuter réellement.`);
    console.log(`  ${c.dim}Budget qui serait engagé : ${LIVE_PILOT_LIMITS.maxCostUsd.toFixed(2)} $ maximum.${c.reset}\n`);
    await system.shutdown('contrôle seul');
    return;
  }

  if (config.llm.mode !== 'live') {
    console.error(`  ${c.red}Refus : le mode est « ${config.llm.mode} », pas « live ».${c.reset}\n`);
    await system.shutdown('mode incorrect');
    process.exitCode = 1;
    return;
  }

  // ── Exécution ───────────────────────────────────────────────────────────
  console.log(`  ${c.bold}${c.red}LIVE — APPELS EXTERNES AUTORISÉS — BUDGET MAX ${LIVE_PILOT_LIMITS.maxCostUsd.toFixed(2)} $${c.reset}`);
  console.log(`  ${c.dim}modèle ${LIVE_PILOT_LIMITS.model} · ${LIVE_PILOT_LIMITS.maxSearchQueries} requêtes · ` +
    `${LIVE_PILOT_LIMITS.maxAnalyzedCandidates} analyses profondes${c.reset}\n`);

  const started = Date.now();
  const mission = await system.hermes.submit({
    ...LIVE_PILOT_MISSION,
    createdBy: 'live-pilot',
    autoStart: true,
  });

  console.log(`  Mission ${c.bold}${mission.code}${c.reset} lancée\n`);
  console.log(`  ${c.dim}temps  │ étape${c.reset}`);
  console.log(`  ${c.dim}───────┼──────────────────────────────────────────────────${c.reset}`);

  const seen = new Set<string>();
  const at = (): string => `${((Date.now() - started) / 1000).toFixed(0).padStart(5)}s`;
  let finished = false;

  for (let tick = 0; tick < 400; tick++) {
    const current = system.repos.missions.get(mission.id);
    if (!current) break;

    for (const task of system.repos.missions.tasksFor(mission.id)) {
      const key = `${task.ref}:${task.status}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const mark =
        task.status === 'succeeded'
          ? `${c.green}✓${c.reset}`
          : task.status === 'failed'
            ? `${c.red}✗${c.reset}`
            : task.status === 'skipped'
              ? `${c.amber}—${c.reset}`
              : '▶';
      if (['running', 'succeeded', 'failed', 'skipped'].includes(task.status)) {
        console.log(`  ${c.dim}${at()}${c.reset} │ ${mark} ${task.ref.padEnd(14)} ${task.agentKey}`);
        if (task.error) console.log(`         │   ${c.dim}${task.error.slice(0, 90)}${c.reset}`);
      }
    }

    // Le plafond, surveillé de l'extérieur autant que de l'intérieur.
    const spend = missionEconomics({
      repos: system.repos,
      missionId: mission.id,
      model: LIVE_PILOT_LIMITS.model,
      simulated: false,
    });
    if ((spend.estimatedCostUsd ?? 0) > LIVE_PILOT_LIMITS.maxCostUsd * 1.05) {
      console.log(`\n  ${c.red}Plafond dépassé — annulation.${c.reset}`);
      system.hermes.cancel(mission.id, 'Plafond de dépense atteint');
      break;
    }

    if (['completed', 'validated', 'failed'].includes(current.status)) {
      finished = true;
      break;
    }
    if (Date.now() - started > LIVE_PILOT_LIMITS.maxMissionDurationMs) {
      console.log(`\n  ${c.amber}Durée maximale atteinte — annulation.${c.reset}`);
      system.hermes.cancel(mission.id, 'Durée maximale atteinte');
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log(`  ${c.dim}───────┴──────────────────────────────────────────────────${c.reset}\n`);

  // ── Rapport de valeur ───────────────────────────────────────────────────
  const final = system.repos.missions.require(mission.id);
  const economics = missionEconomics({
    repos: system.repos,
    missionId: mission.id,
    model: LIVE_PILOT_LIMITS.model,
    simulated: false,
  });
  const opportunities = system.repos.opportunities.forMission(mission.id);
  const evidence = system.repos.companies.evidenceForMission(mission.id);
  const durationMs = Date.now() - started;

  const cost = economics.estimatedCostUsd ?? 0;
  const per = (n: number): string => (n > 0 ? `${(cost / n).toFixed(4)} $` : '—');

  console.log(`  ${c.bold}LIVE PILOT 001 — VALUE REPORT${c.reset}\n`);
  console.log(`    statut mission        ${final.status}${finished ? '' : ' (interrompue)'}`);
  console.log(`    durée                 ${formatDuration(durationMs)}`);
  console.log(`    étapes réussies       ${system.repos.missions.tasksFor(mission.id).filter((t) => t.status === 'succeeded').length} / ${system.repos.missions.tasksFor(mission.id).length}`);
  console.log();
  // La nature d'une preuve est ce qui sépare un fait d'une conclusion. Le
  // rapport les compte séparément : une shortlist bâtie sur des inférences
  // n'est pas une shortlist bâtie sur des observations.
  const byNature = {
    observed: evidence.filter((e) => e.nature === 'observed').length,
    reported: evidence.filter((e) => e.nature === 'reported').length,
    inferred: evidence.filter((e) => e.nature === 'inferred').length,
  };
  const sourced = evidence.filter((e) => Boolean(e.sourceRef)).length;
  const simulatedEvidence = evidence.filter((e) => e.simulated).length;

  console.log(`    candidats             ${opportunities.length}`);
  console.log(`    preuves               ${evidence.length}`);
  console.log(`      observed            ${byNature.observed}`);
  console.log(`      reported            ${byNature.reported}`);
  console.log(`      inferred            ${byNature.inferred}`);
  console.log(`    preuves sourcées      ${sourced} / ${evidence.length}`);
  console.log(`    preuves simulées      ${simulatedEvidence}${simulatedEvidence > 0 ? `  ${c.red}(anomalie en mode réel)${c.reset}` : ''}`);
  console.log(`    opportunités retenues ${opportunities.filter((o) => o.stage === 'shortlisted').length}`);
  console.log();
  console.log(`    appels LLM            ${economics.measured?.llmCalls ?? 0}`);
  console.log(`    jetons entrée         ${(economics.measured?.inputTokens ?? 0).toLocaleString('fr-FR')}`);
  console.log(`    jetons sortie         ${(economics.measured?.outputTokens ?? 0).toLocaleString('fr-FR')}`);
  console.log(`    appels externes       ${economics.externalCalls}`);
  console.log();
  console.log(`    ${c.bold}coût réel             ${cost.toFixed(4)} $${c.reset}  ${c.dim}(plafond ${LIVE_PILOT_LIMITS.maxCostUsd.toFixed(2)} $)${c.reset}`);
  console.log(`    coût par candidat     ${per(opportunities.length)}`);
  console.log(`    coût par preuve       ${per(evidence.length)}`);
  console.log();

  // ── Le verdict, critère par critère ─────────────────────────────────────
  //
  // L'ancien calcul regardait trois choses — des candidats, des preuves
  // sourcées, un budget tenu — et rendait PASS dès qu'elles étaient réunies.
  // M-1F5YW a donc affiché PASS avec une seule étape réussie sur six.
  // Découvrir n'est pas conclure : le verdict interroge maintenant la chaîne
  // entière, et l'affiche ligne à ligne pour qu'il se vérifie sans code.
  const pilot = evaluatePilot({
    repos: system.repos,
    missionId: mission.id,
    maxCostUsd: LIVE_PILOT_LIMITS.maxCostUsd,
    spentUsd: cost,
  });

  console.log(`  ${c.bold}CRITÈRES END-TO-END${c.reset}`);
  console.log(formatPilotReport(pilot).split('\n  VERDICT')[0]);

  const colour =
    pilot.verdict === 'PASS'
      ? c.green
      : pilot.verdict === 'PARTIAL'
        ? c.amber
        : c.red;
  console.log(`    ${c.bold}VERDICT : ${colour}${pilot.verdict}${c.reset}`);
  console.log(`    ${c.dim}${pilot.rationale}${c.reset}`);

  if (pilot.incompleteSteps.length > 0) {
    console.log();
    console.log(`    ${c.dim}Étapes non abouties :${c.reset}`);
    for (const step of pilot.incompleteSteps) {
      console.log(`    ${c.dim}  ${step.ref.padEnd(14)} ${step.status}${c.reset}`);
      if (step.reason) console.log(`    ${c.dim}    → ${step.reason.slice(0, 160)}${c.reset}`);
    }
  }
  console.log();

  await system.shutdown('pilote terminé');
  process.exitCode = pilot.verdict === 'PASS' ? 0 : 1;
}

void main().catch((err: unknown) => {
  console.error(`\n  ${c.red}Échec : ${err instanceof Error ? (err.stack ?? err.message) : String(err)}${c.reset}\n`);
  process.exitCode = 1;
});
