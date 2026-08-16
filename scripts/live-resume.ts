/**
 * Reprend un pilote là où une garde l'a arrêté.
 *
 *   npm run live:resume            examine et affiche le plan de reprise
 *   npm run live:resume -- --go    reprend réellement
 *
 * LIVE-001 (M-1F5YW) a produit trois candidats allemands réels, sourcés et
 * horodatés, puis s'est arrêté net : l'enrichissement refusé par le plafond
 * d'étape, le reste annulé. Redémarrer la mission de zéro repaierait la
 * découverte de ces mêmes trois candidats — environ 0,03 $ pour réobtenir ce
 * qui est déjà en base, et une nouvelle sollicitation des moteurs pour rien.
 *
 * La reprise conserve donc tout ce qui a été acquis : entreprises, preuves,
 * provenance, et les étapes déjà réussies. Seules les étapes qui n'ont pas
 * abouti repartent.
 *
 * Le budget est le point délicat. Le registre budgétaire vit en mémoire : un
 * nouveau processus repart à zéro et ne sait rien des 0,0652 $ déjà dépensés.
 * La reprise resserre donc explicitement le plafond de la mission à ce qui
 * reste, pour que le total des deux exécutions tienne dans l'enveloppe validée.
 */
import { createSystem } from '../packages/server/src/bootstrap.ts';
import { loadConfig, formatDuration } from '../packages/core/src/index.ts';
import { evaluatePilot, formatPilotReport } from '../packages/runtime/src/pilot-verdict.ts';
import { missionEconomics } from '../packages/intelligence/src/economics.ts';
import { LIVE_PILOT_LIMITS } from '../packages/departments/src/live-pilot.ts';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  amber: '\x1b[33m',
  red: '\x1b[31m',
};

const GO = process.argv.includes('--go');

/** Les étapes qui doivent avoir abouti pour que le pilote ait un sens. */
const MANDATORY = ['discovery', 'enrichment', 'qualification', 'scoring', 'ranking', 'report'];

async function main(): Promise<void> {
  const config = loadConfig();
  const system = createSystem(config);
  const { repos } = system;

  console.log(`\n${c.bold}  Reprise de LIVE PILOT 001${c.reset}\n`);

  // ── Trouver la mission la plus avancée ──────────────────────────────────
  // Celle qui porte de vrais candidats et qu'une garde a interrompue. On ne
  // reprend jamais une mission vide : il n'y aurait rien à reprendre, et
  // relancer reviendrait à démarrer un pilote sous un autre nom.
  const candidates = repos.missions
    .list({ limit: 40, offset: 0 })
    .items.filter((m) => (m.context as { pilot?: string })?.pilot === 'LIVE-001')
    .map((m) => ({
      mission: m,
      opportunities: repos.opportunities.forMission(m.id).length,
      evidence: repos.companies.evidenceForMission(m.id),
      tasks: repos.missions.tasksFor(m.id),
    }))
    .filter((entry) => entry.opportunities > 0)
    .sort((a, b) => b.opportunities - a.opportunities);

  const target = candidates[0];
  if (!target) {
    console.error(`  ${c.red}Aucune mission pilote ne porte de candidat réel.${c.reset}`);
    console.error(`  ${c.dim}Il n'y a rien à reprendre : lancez npm run live:pilot -- --go.${c.reset}\n`);
    await system.shutdown('rien à reprendre');
    process.exitCode = 1;
    return;
  }

  const { mission, evidence, tasks } = target;

  // ── Vérifier que ce qui est acquis mérite d'être repris ─────────────────
  // Reprendre sur des preuves simulées ou non sourcées bâtirait la suite du
  // pipeline sur du sable, et le rapport final hériterait du défaut sans
  // qu'on puisse le voir.
  const simulated = evidence.filter((e) => e.simulated);
  const sourced = evidence.filter((e) => Boolean(e.sourceRef));

  console.log(`  Mission ${c.bold}${mission.code}${c.reset} · ${mission.status}`);
  console.log(`  ${target.opportunities} candidat(s) · ${sourced.length}/${evidence.length} preuve(s) sourcée(s)\n`);

  for (const opp of repos.opportunities.forMission(mission.id)) {
    const company = repos.companies.get(opp.companyId);
    const source = repos.companies.evidenceForOpportunity(opp.id).find((e) => e.sourceRef);
    console.log(`    ${c.dim}·${c.reset} ${company?.name ?? opp.companyId} ${c.dim}[${opp.stage}]${c.reset}`);
    console.log(`      ${c.dim}${source?.sourceKey ?? 'sans moteur'} · ${source?.sourceRef ?? 'sans source'}${c.reset}`);
  }
  console.log();

  if (simulated.length > 0) {
    console.error(`  ${c.red}${simulated.length} preuve(s) simulée(s) : reprise refusée.${c.reset}`);
    console.error(`  ${c.dim}Reprendre bâtirait la suite du pipeline sur des données fabriquées.${c.reset}\n`);
    await system.shutdown('preuves simulées');
    process.exitCode = 1;
    return;
  }

  // ── Ce qui reste à faire ────────────────────────────────────────────────
  const incomplete = MANDATORY.filter(
    (ref) => tasks.find((t) => t.ref === ref)?.status !== 'succeeded',
  );

  if (incomplete.length === 0) {
    console.log(`  ${c.green}Le pipeline est déjà complet.${c.reset} Rien à reprendre.\n`);
    await system.shutdown('déjà complet');
    return;
  }

  console.log(`  ${c.bold}Étapes à reprendre${c.reset}`);
  for (const ref of incomplete) {
    const task = tasks.find((t) => t.ref === ref);
    console.log(`    ${ref.padEnd(14)} ${c.dim}${task?.status ?? 'absente'}${c.reset}`);
  }
  console.log();

  // ── Le budget restant ───────────────────────────────────────────────────
  const already = missionEconomics({
    repos,
    missionId: mission.id,
    model: LIVE_PILOT_LIMITS.model,
    simulated: false,
  });
  const spent = already.estimatedCostUsd ?? 0;
  const remaining = Math.max(0, LIVE_PILOT_LIMITS.maxCostUsd - spent);

  console.log(`  ${c.bold}Budget${c.reset}`);
  console.log(`    déjà dépensé   ${spent.toFixed(4)} $`);
  console.log(`    plafond pilote ${LIVE_PILOT_LIMITS.maxCostUsd.toFixed(2)} $`);
  console.log(`    reste          ${c.bold}${remaining.toFixed(4)} $${c.reset}\n`);

  if (remaining <= 0.01) {
    console.error(`  ${c.red}Budget épuisé : il ne reste pas de quoi reprendre.${c.reset}\n`);
    await system.shutdown('budget épuisé');
    process.exitCode = 1;
    return;
  }

  if (!GO) {
    console.log(`  ${c.amber}Examen seul.${c.reset} Relancez avec --go pour reprendre réellement.`);
    console.log(`  ${c.dim}Aucune découverte ne sera relancée : les candidats existants sont réutilisés.${c.reset}\n`);
    await system.shutdown('examen seul');
    return;
  }

  if (config.llm.mode !== 'live') {
    console.error(`  ${c.red}Refus : le mode est « ${config.llm.mode} », pas « live ».${c.reset}\n`);
    await system.shutdown('mode incorrect');
    process.exitCode = 1;
    return;
  }

  // ── Préparer la reprise ─────────────────────────────────────────────────
  //
  // Le plafond en dollars devient la vraie borne. Le plafond en jetons reste,
  // en filet : à 120 000 jetons il valait environ 0,12 $ au tarif observé —
  // trois fois plus strict que l'enveloppe validée, et c'est lui qui décidait
  // en réalité de tout. Un filet doit être plus large que le mur qu'il double,
  // sinon c'est le filet qui est le mur, sans que personne l'ait décidé.
  const observedCostPerToken = already.measured
    ? spent / Math.max(1, already.measured.inputTokens + already.measured.outputTokens)
    : 0;
  const tokensForRemaining =
    observedCostPerToken > 0 ? Math.floor(remaining / observedCostPerToken) : LIVE_PILOT_LIMITS.maxTokens;

  repos.missions.setContext(mission.id, {
    ...mission.context,
    budgetUsd: Number(remaining.toFixed(4)),
    resumedFrom: incomplete[0],
    previousSpendUsd: Number(spent.toFixed(4)),
  });

  // Les étapes non abouties repartent en file. Celles qui ont réussi ne sont
  // pas touchées : leur travail est acquis et le repayer n'apprendrait rien.
  const requeued = repos.missions.resetTasksForResume(mission.id, incomplete);
  console.log(`  ${requeued} étape(s) remise(s) en file.\n`);

  // `retry` n'accepte qu'une mission en échec — ce qui est désormais le statut
  // correct d'une mission interrompue. Une mission plus ancienne, écrite avant
  // cette correction, porte encore « completed » : on la remet d'abord dans
  // l'état qui correspond à ce qu'elle a réellement fait.
  if (mission.status !== 'failed') {
    repos.missions.transition(mission.id, 'failed', {
      error: 'reprise demandée — le pipeline ne s’était pas terminé',
    });
  }

  repos.missions.setTokenBudget(mission.id, Math.max(LIVE_PILOT_LIMITS.maxTokens, tokensForRemaining));

  console.log(`  ${c.bold}${c.red}LIVE — REPRISE — BUDGET ${remaining.toFixed(4)} $${c.reset}`);
  console.log(`  ${c.dim}modèle ${LIVE_PILOT_LIMITS.model} · aucune redécouverte${c.reset}\n`);

  const started = Date.now();
  system.hermes.retry(mission.id);

  console.log(`  ${c.dim}temps  │ étape${c.reset}`);
  console.log(`  ${c.dim}───────┼──────────────────────────────────────────────${c.reset}`);

  const seen = new Set<string>();
  const at = (): string => `${((Date.now() - started) / 1000).toFixed(0).padStart(5)}s`;

  for (let tick = 0; tick < 400; tick++) {
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
        if (task.error) console.log(`         │   ${c.dim}${task.error.slice(0, 100)}${c.reset}`);
      }
    }

    const now = missionEconomics({
      repos,
      missionId: mission.id,
      model: LIVE_PILOT_LIMITS.model,
      simulated: false,
    });
    if ((now.estimatedCostUsd ?? 0) > LIVE_PILOT_LIMITS.maxCostUsd * 1.05) {
      console.log(`\n  ${c.red}Plafond global dépassé — annulation.${c.reset}`);
      system.hermes.cancel(mission.id, 'Plafond de dépense atteint');
      break;
    }

    if (['completed', 'validated', 'failed'].includes(current.status)) break;
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log(`  ${c.dim}───────┴──────────────────────────────────────────────${c.reset}\n`);

  // ── Verdict ─────────────────────────────────────────────────────────────
  const final = repos.missions.require(mission.id);
  const economics = missionEconomics({
    repos,
    missionId: mission.id,
    model: LIVE_PILOT_LIMITS.model,
    simulated: false,
  });
  const totalCost = economics.estimatedCostUsd ?? 0;

  const pilot = evaluatePilot({
    repos,
    missionId: mission.id,
    maxCostUsd: LIVE_PILOT_LIMITS.maxCostUsd,
    spentUsd: totalCost,
  });

  console.log(`  ${c.bold}LIVE PILOT 001 — REPRISE — VALUE REPORT${c.reset}\n`);
  console.log(`    statut mission   ${final.status}`);
  console.log(`    durée reprise    ${formatDuration(Date.now() - started)}`);
  console.log(`    coût total       ${totalCost.toFixed(4)} $ ${c.dim}(dont ${spent.toFixed(4)} $ avant reprise)${c.reset}`);
  console.log(`    plafond          ${LIVE_PILOT_LIMITS.maxCostUsd.toFixed(2)} $\n`);
  console.log(formatPilotReport(pilot));
  console.log();

  await system.shutdown('reprise terminée');
  process.exitCode = pilot.verdict === 'PASS' ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
