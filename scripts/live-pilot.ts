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
import { DuckDuckGoSearchProvider } from '../packages/intelligence/src/search/duckduckgo.ts';
import { MarginaliaSearchProvider } from '../packages/intelligence/src/search/marginalia.ts';
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
  const search =
    config.search.provider === 'duckduckgo'
      ? new DuckDuckGoSearchProvider()
      : config.search.provider === 'marginalia'
        ? new MarginaliaSearchProvider()
        : null;

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

  // Le verdict, sans complaisance.
  const verdict =
    simulatedEvidence > 0
      ? 'FAIL'
      : opportunities.length > 0 && sourced > 0 && cost <= LIVE_PILOT_LIMITS.maxCostUsd
        ? opportunities.length >= 3 && sourced >= 3
          ? 'PASS'
          : 'PARTIAL'
        : 'FAIL';

  const colour = verdict === 'PASS' ? c.green : verdict === 'PARTIAL' ? c.amber : c.red;
  console.log(`    ${c.bold}VERDICT : ${colour}${verdict}${c.reset}`);
  console.log(
    `    ${c.dim}${
      verdict === 'FAIL'
        ? "Aucun candidat sourcé n'a été produit."
        : verdict === 'PARTIAL'
          ? 'Des résultats sourcés existent, en volume insuffisant pour conclure.'
          : 'Candidats réels, preuves sourcées, budget tenu.'
    }${c.reset}\n`,
  );

  await system.shutdown('pilote terminé');
  process.exitCode = verdict === 'FAIL' ? 1 : 0;
}

void main().catch((err: unknown) => {
  console.error(`\n  ${c.red}Échec : ${err instanceof Error ? (err.stack ?? err.message) : String(err)}${c.reset}\n`);
  process.exitCode = 1;
});
