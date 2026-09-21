/**
 * L'Autopilot, à la main.
 *
 *   npm run autopilot:once                 un cycle borné : observer → proposer → prioriser → confier → vérifier → apprendre
 *   npm run autopilot:status               l'état : dernier cycle, objectif du moment, en cours, pour vous
 *   npm run autopilot:queue                la file des actions, avec leur motif
 *   npm run autopilot:report               les derniers cycles, expliqués après coup
 *   npm run autopilot -- pause "motif"     suspendre : les cycles observent encore, ne confient plus rien
 *   npm run autopilot -- resume            reprendre
 *   npm run autopilot -- decide <id> done|reject [--reason=…]   résoudre une action qui vous attendait
 *
 * Rien ici n'envoie, ne paie, ne déploie. Le cycle pose des tâches dans la
 * file existante ; ce sont les workers qui les servent, sous leurs plafonds.
 * MESSAGES SENT : 0, par construction.
 */
import { createLogger, loadConfig, loadAtlasEnv } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import { runAutopilotCycle, summariseAutopilot, setAutopilotPause, readAutopilotPause } from '../packages/runtime/src/autopilot.ts';
import { softwareLoopStatus, type SoftwareLoopStatus } from '../packages/runtime/src/software-loop.ts';

loadAtlasEnv();

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', amber: '\x1b[33m', cyan: '\x1b[36m',
};
const flag = (name: string): string | null =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const command = positional[0] ?? 'status';

const config = loadConfig(process.cwd());
const logger = createLogger({ level: 'error', pretty: false });
const repos = createRepositories(config.paths.databaseFile, logger);
const usd = (n: number | null) => (n === null ? 'N/A' : `${n.toFixed(4)} $`);
const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') + ' UTC' : '—');

const tint: Record<string, string> = {
  DONE: c.green, QUEUED: c.cyan, RUNNING: c.cyan, VERIFYING: c.cyan, APPROVED: c.cyan,
  WAITING_HUMAN: c.amber, PROPOSED: c.dim, BLOCKED: c.red, REJECTED: c.dim,
};

/**
 * La boucle logicielle, pièce par pièce — et les deux constantes qui ne se
 * règlent pas : le déploiement automatique est DISABLED, la porte humaine
 * ENABLED. Un diff prêt s'arrête à READY_FOR_HUMAN_DEPLOYMENT.
 */
function printSoftwareLoop(loop: SoftwareLoopStatus): void {
  const mark = (ready: boolean, state: string) => `${ready ? c.green : state === 'CONFIGURED' || state === 'STALE' ? c.amber : c.red}${state.padEnd(24)}${c.reset}`;
  console.log(`\n  ${c.bold}SOFTWARE LOOP${c.reset}  ${loop.usable ? `${c.green}UTILISABLE` : `${c.amber}INCOMPLÈTE`}${c.reset}  ${c.dim}ingénierie ${loop.runner === 'external' ? 'externe (service atlas-engineer)' : 'intégrée (ce processus, dépôt courant)'}${c.reset}`);
  console.log(`  - OpenAI reviewer      ${mark(loop.openaiReviewer.ready, loop.openaiReviewer.state)} ${c.dim}${loop.openaiReviewer.detail}${c.reset}`);
  console.log(`  - Claude               ${mark(loop.claude.ready, loop.claude.state)} ${c.dim}${loop.claude.detail}${c.reset}`);
  console.log(`  - Claude Code runner   ${mark(loop.claudeCodeRunner.ready, loop.claudeCodeRunner.state)} ${c.dim}${loop.claudeCodeRunner.detail}${c.reset}`);
  console.log(`  - Repository workspace ${mark(loop.repositoryWorkspace.ready, loop.repositoryWorkspace.state)} ${c.dim}${loop.repositoryWorkspace.detail}${c.reset}`);
  console.log(`  - Auto deploy          ${c.green}${loop.autoDeploy.padEnd(24)}${c.reset} ${c.dim}rien ne quitte un worktree sans une personne${c.reset}`);
  console.log(`  - Human deploy gate    ${c.green}${loop.humanDeployGate.padEnd(24)}${c.reset} ${c.dim}READY_FOR_HUMAN_DEPLOYMENT → npm run atlas:apply${c.reset}`);
  for (const b of loop.blockers) console.log(`  ${c.dim}· manque : ${b}${c.reset}`);
}

try {
  if (command === 'once') {
    const report = await runAutopilotCycle(repos, config, logger, { trigger: 'cli', observe: { cwd: process.cwd() } });
    const o = report.observation;
    console.log(`\n  ${c.bold}${c.cyan}ATLAS AUTOPILOT${c.reset}  ${c.dim}cycle ${report.cycle.id} · ${when(report.cycle.finishedAt)}${report.paused ? ` · ${c.amber}EN PAUSE` : ''}${c.reset}\n`);
    console.log(`  ${c.bold}Observed:${c.reset}`);
    console.log(`  - envoi : ${o.outbound.enabled ? 'ACTIVÉ' : 'coupé'} · mode ${o.outbound.engineMode}${o.outbound.paused ? ' · pause générale' : ''}`);
    console.log(`  - 30 jours : ${o.sales.discovered} découverts · ${o.sales.qualified} qualifiés · ${o.sales.contacted} contactés · ${o.sales.replies} réponses (${o.sales.positiveReplies} positives) · ${o.sales.meetings} rendez-vous · ${o.sales.clientsSigned} client(s)`);
    console.log(`  - à traiter : ${o.sales.hotLeadsOpen} réponse(s) chaude(s) · ${o.sales.followUpsDue} relance(s) due(s) · ${o.sales.draftsAwaitingApproval} brouillon(s) à approuver · ${o.sales.recommendationsProposed} recommandation(s)`);
    console.log(`  - file : ${Object.entries(o.queue.byStatus).map(([k, v]) => `${v} ${k}`).join(', ') || 'vide'} · ${o.queue.failedRecent} échec(s) en 24 h · ${o.queue.waitingHuman} en attente d'une personne`);
    console.log(`  - ingénierie : ${o.engineering.readyForReview} diff(s) à relire · ${o.engineering.approvedToApply} à appliquer · dépôt ${o.engineering.repoClean === null ? 'N/A' : o.engineering.repoClean ? 'propre' : 'modifié'}`);
    console.log(`  - fournisseurs : ${Object.entries(o.providers).map(([k, v]) => `${k} ${v.ready ? '✓' : '✗'}`).join(' · ')}`);
    console.log(`  - dépense IA du jour : ${usd(o.spend.todayUsd)}${o.spend.unknownCalls ? ` (+${o.spend.unknownCalls} appel(s) au tarif inconnu)` : ''} · plafond ${o.spend.dailyLimitUsd === null ? o.spend.mode : `${o.spend.dailyLimitUsd.toFixed(2)} $`} · commercial ${o.spend.salesSpentTodayUsd.toFixed(2)} / ${o.spend.salesDailyBudgetUsd.toFixed(2)} $`);
    console.log(`  - santé : Gmail ${o.health.gmail} · daemon ${o.health.daemon} · LLM ${o.health.llm} · recherche ${o.health.search}`);
    if (o.absent.length) console.log(`  - ${c.dim}non mesurable : ${o.absent.join(' ; ')}${c.reset}`);
    if (o.softwareLoop) printSoftwareLoop(o.softwareLoop);

    console.log(`\n  ${c.bold}Top opportunities:${c.reset}`);
    report.considered.slice(0, 5).forEach((x, i) => console.log(`  ${i + 1}. [${x.category} · ${x.allocation} · ${x.score}] ${x.objective}`));
    if (report.considered.length === 0) console.log(`  ${c.dim}aucune : l'état réel ne révèle rien à faire de plus${c.reset}`);

    console.log(`\n  ${c.bold}Actions created:${c.reset}`);
    for (const a of report.created) console.log(`  - ${tint[a.status] ?? ''}${a.status}${c.reset} ${a.objective} ${c.dim}— ${a.reason}${c.reset}`);
    for (const d of report.decisions.filter((x) => x.decision !== 'CREATED')) console.log(`  ${c.dim}· ${d.decision} — ${d.objective} : ${d.reason}${c.reset}`);
    if (report.created.length === 0) console.log(`  ${c.dim}aucune${c.reset}`);

    console.log(`\n  ${c.bold}Executed autonomously:${c.reset}`);
    for (const e of report.executed) console.log(`  - ${e.taskType} → ${e.agent} ${c.dim}(tâche ${e.taskId}, ~${e.estimatedCostUsd.toFixed(2)} $)${c.reset} : ${e.objective}`);
    for (const v of report.verified) console.log(`  ${c.dim}· vérifié : ${v.objective} ${v.from} → ${v.to} (${v.reason})${c.reset}`);
    if (report.executed.length === 0) console.log(`  ${c.dim}rien confié dans ce cycle${c.reset}`);

    console.log(`\n  ${c.bold}Needs founder:${c.reset}`);
    for (const a of report.needsFounder) {
      const execution = a.proposal.execution as { kind: string; command?: string } | undefined;
      console.log(`  - ${a.objective} ${c.dim}— ${a.reason}${execution?.command ? ` → ${execution.command}` : ''}${c.reset}`);
    }
    if (report.needsFounder.length === 0) console.log(`  ${c.dim}rien : ATLAS continue seul${c.reset}`);
    if (report.blocked.length) {
      console.log(`\n  ${c.bold}Blocked:${c.reset}`);
      for (const a of report.blocked) console.log(`  - ${a.objective} ${c.dim}— ${a.rejectionReason ?? a.reason}${c.reset}`);
    }

    console.log(`\n  ${c.bold}Learned:${c.reset}`);
    for (const l of report.learned) console.log(`  - ${l}`);
    console.log(`\n  ${c.bold}Estimated spend:${c.reset}\n  $${report.estimatedSpendUsd.toFixed(4)} ${c.dim}(tâches confiées ; la dépense réelle est consignée par les workers)${c.reset}`);
    console.log(`\n  ${c.dim}No external messages sent. MESSAGES SENT: 0${c.reset}\n`);
  } else if (command === 'status') {
    const s = summariseAutopilot(repos, config);
    const statusTint = s.status === 'ACTIVE' ? c.green : s.status === 'PAUSED' ? c.amber : c.dim;
    console.log(`\n  ${c.bold}${c.cyan}ATLAS AUTOPILOT${c.reset}  ${statusTint}${s.status}${c.reset}  ${c.dim}cadencé ${s.enabled ? `toutes les ${config.autopilot.cycleMinutes} min` : 'non (ATLAS_AUTOPILOT_ENABLED=false) — npm run autopilot:once'}${c.reset}`);
    if (s.paused.paused) console.log(`  ${c.amber}en pause${c.reset} — ${s.paused.reason ?? 'sans motif'} (${s.paused.by ?? '?'}, ${when(s.paused.at)})`);
    console.log(`  dernier cycle : ${when(s.lastCycleAt)}${s.lastCycleSummary ? ` — ${s.lastCycleSummary}` : ''}`);
    console.log(`  objectif du moment : ${s.topObjective ?? '—'}${s.topReason ? `\n  ${c.dim}${s.topReason}${c.reset}` : ''}`);
    console.log(`\n  en cours (${s.inProgress.length})`);
    for (const a of s.inProgress) console.log(`    ${c.cyan}${a.status.padEnd(9)}${c.reset} ${a.objective} ${c.dim}→ ${a.agent}${c.reset}`);
    console.log(`  terminé récemment (${s.completedRecently.length})`);
    for (const a of s.completedRecently) console.log(`    ${c.green}DONE     ${c.reset} ${a.objective} ${c.dim}${when(a.resolvedAt)}${c.reset}`);
    console.log(`  pour vous (${s.waitingFounder.length})`);
    for (const a of s.waitingFounder) console.log(`    ${c.amber}À DÉCIDER${c.reset} ${a.objective} ${c.dim}— ${a.reason}${a.command ? ` → ${a.command}` : ''}${c.reset}`);
    if (s.blocked.length) { console.log(`  bloqué (${s.blocked.length})`); for (const a of s.blocked) console.log(`    ${c.red}BLOCKED  ${c.reset} ${a.objective} ${c.dim}— ${a.reason}${c.reset}`); }
    // La boucle logicielle : aucune sonde payante ; celle des fournisseurs est
    // gratuite et rejouée au plus toutes les six heures (--verify=false : jamais).
    printSoftwareLoop(await softwareLoopStatus(repos, config, { cwd: process.cwd(), verifyProviders: flag('verify') !== 'false' }));
    console.log(`\n  dépense IA estimée (actions ouvertes) : $${s.estimatedSpendUsd.toFixed(4)} · réelle connue : ${usd(s.actualSpendUsd)}`);
    console.log(`  ${c.dim}MESSAGES SENT: 0 — l'Autopilot n'envoie rien.${c.reset}\n`);
  } else if (command === 'queue') {
    const status = flag('status');
    const actions = repos.autopilot.actions({ limit: Number(flag('limit') ?? 50), ...(status ? { status: status as never } : {}) });
    console.log(`\n  ${c.bold}FILE AUTOPILOT${c.reset}  ${c.dim}${actions.length} action(s)${status ? ` · ${status}` : ''} · ${Object.entries(repos.autopilot.countByStatus()).map(([k, v]) => `${v} ${k}`).join(', ')}${c.reset}\n`);
    for (const a of actions) {
      console.log(`  ${tint[a.status] ?? ''}${a.status.padEnd(13)}${c.reset} ${String(a.score).padStart(6)}  ${a.category.padEnd(12)} ${a.objective}`);
      console.log(`  ${c.dim}${''.padEnd(21)}${a.id} · ${a.allocation} · ${a.recommendedAgent}${a.taskId ? ` · tâche ${a.taskId}` : ''} · ~${a.estimatedCostUsd.toFixed(2)} $${a.actualCostUsd !== null ? ` (réel ${a.actualCostUsd.toFixed(4)} $)` : ''}${c.reset}`);
      console.log(`  ${c.dim}${''.padEnd(21)}${a.rejectionReason ?? a.reason}${c.reset}`);
    }
    if (actions.length === 0) console.log(`  ${c.dim}vide${c.reset}`);
    console.log();
  } else if (command === 'report') {
    const cycles = repos.autopilot.cycles(Number(flag('limit') ?? 5));
    console.log(`\n  ${c.bold}RAPPORT AUTOPILOT${c.reset}  ${c.dim}${cycles.length} cycle(s)${c.reset}\n`);
    for (const cy of cycles) {
      console.log(`  ${c.bold}${cy.id}${c.reset}  ${when(cy.startedAt)} → ${when(cy.finishedAt)}  ${cy.status === 'DONE' ? c.green : c.red}${cy.status}${c.reset}  ${c.dim}${cy.trigger} · ~${cy.estimatedCostUsd.toFixed(4)} $${c.reset}`);
      if (cy.summary) console.log(`    ${cy.summary}`);
      if (cy.error) console.log(`    ${c.red}${cy.error}${c.reset}`);
      const considered = cy.opportunities as Array<{ objective: string; score: number; category: string }>;
      for (const o of considered.slice(0, 5)) console.log(`    ${c.dim}· considéré [${o.category} · ${o.score}] ${o.objective}${c.reset}`);
      const decisions = cy.decisions as Array<{ objective: string; decision: string; reason: string }>;
      for (const d of decisions) console.log(`    ${c.dim}· ${d.decision.padEnd(13)} ${d.objective} — ${d.reason}${c.reset}`);
      const executed = cy.executed as Array<{ taskType: string; taskId: string; objective: string }>;
      for (const e of executed) console.log(`    ${c.cyan}· confié ${e.taskType} (${e.taskId}) — ${e.objective}${c.reset}`);
      console.log();
    }
    if (cycles.length === 0) console.log(`  ${c.dim}aucun cycle encore : npm run autopilot:once${c.reset}\n`);
  } else if (command === 'pause' || command === 'resume') {
    const by = flag('by') ?? process.env.USER ?? process.env.USERNAME ?? 'fondateur';
    const state = setAutopilotPause(repos, command === 'pause', by, command === 'pause' ? (positional[1] ?? flag('reason') ?? 'pause manuelle') : null);
    console.log(`\n  Autopilot ${state.paused ? `${c.amber}EN PAUSE${c.reset} — ${state.reason}` : `${c.green}REPRIS${c.reset}`} (${state.by}, ${when(state.at)})\n`);
  } else if (command === 'decide') {
    const [, actionId, verdict] = positional;
    const action = actionId ? repos.autopilot.action(actionId) : null;
    if (!action) { console.error('  decide <id> done|reject — action introuvable'); process.exitCode = 2; }
    else if (verdict !== 'done' && verdict !== 'reject') { console.error('  decide <id> done|reject'); process.exitCode = 2; }
    else {
      const by = flag('by') ?? process.env.USER ?? process.env.USERNAME ?? 'fondateur';
      const reason = flag('reason') ?? `décidé par ${by}`;
      const updated = repos.autopilot.transition(action.id, verdict === 'done' ? 'DONE' : 'REJECTED', { rejectionReason: verdict === 'reject' ? reason : null, result: { decidedBy: by, reason } });
      console.log(`\n  ${updated.status === 'DONE' ? c.green : c.dim}${updated.status}${c.reset} ${updated.objective} ${c.dim}— ${reason}${c.reset}\n`);
    }
  } else {
    console.error(`  commande inconnue : ${command} (once · status · queue · report · pause · resume · decide)`);
    process.exitCode = 2;
  }
} finally {
  const pause = readAutopilotPause(repos);
  if (command === 'once' && pause.paused) console.log(`  ${c.amber}rappel : l'Autopilot est en pause — npm run autopilot -- resume${c.reset}\n`);
  repos.close();
}
