/**
 * Le superviseur GPT, à la main.
 *
 *   npm run supervisor -- status                  l'état : ouvert ou fermé (et pourquoi), objectifs, revues, tâches
 *   npm run supervisor -- start --file=<json>     lancer un objectif autonome (tâche racine ENGINEERING_CHANGE)
 *   npm run supervisor -- start --key=k --objective="…" --paths=a,b [--tests="npm run typecheck"] [--criteria="x|y"]
 *   npm run supervisor -- poll                    un tour de revue maintenant (mêmes gardes que le tour cadencé)
 *
 * `start` ne lance pas Claude Code : il pose la tâche racine, que le runner
 * d'ingénierie prendra. Le reste — revue GPT, suite, fin — est fait par le
 * daemon du serveur, sans personne. Aucune clé n'est affichée ; aucun apply,
 * commit sur main, push ni déploiement.
 *
 * Fichier `start` : { "key", "objective", "allowed_paths", "test_commands"?,
 * "acceptance_criteria"?, "constraints"?, "limits"?, "repo_target"? }.
 */
import { readFileSync } from 'node:fs';
import { createLogger, loadConfig } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import {
  createAiProviders, runSupervisorPoll, startObjective, supervisorStatus, SUPERVISOR_POLL_TASK_TYPE,
} from '../packages/runtime/src/index.ts';

const c = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', amber: '\x1b[33m', cyan: '\x1b[36m' };
const flag = (name: string): string | null => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const list = (value: string | null, sep = ','): string[] => (value ?? '').split(sep).map((v) => v.trim()).filter(Boolean);
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const command = positional[0] ?? 'status';

const config = loadConfig(process.cwd());
const logger = createLogger({ level: (flag('log') as 'debug' | 'info' | 'warn' | 'error') ?? 'error', pretty: true });
const repos = createRepositories(config.paths.databaseFile, logger);

try {
  if (command === 'start') {
    const file = flag('file');
    const spec = file ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : {};
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
    const outcome = startObjective(repos, config, {
      key: String(spec.key ?? flag('key') ?? ''),
      objective: String(spec.objective ?? flag('objective') ?? ''),
      allowedPaths: file ? strings(spec.allowed_paths) : list(flag('paths')),
      testCommands: file ? strings(spec.test_commands) : list(flag('tests')),
      acceptanceCriteria: file ? strings(spec.acceptance_criteria) : list(flag('criteria'), '|'),
      constraints: file ? strings(spec.constraints) : list(flag('constraints'), '|'),
      limits: (spec.limits as Record<string, number> | undefined) ?? undefined,
      repoTarget: typeof spec.repo_target === 'string' ? spec.repo_target : flag('repo'),
      source: 'cli',
      createdBy: `supervisor-cli#${process.pid}`,
    });
    if (!outcome.ok) {
      console.log(`\n  ${c.red}${c.bold}REFUSÉ${c.reset}`);
      for (const reason of outcome.reasons) console.log(`  - ${reason}`);
      console.log('');
      process.exitCode = 1;
    } else {
      const o = outcome.objective;
      console.log(`\n  ${c.green}${c.bold}${outcome.created ? 'OBJECTIF LANCÉ' : 'OBJECTIF DÉJÀ LANCÉ'}${c.reset}  ${o.objectiveId}`);
      console.log(`  tâche racine : ${outcome.rootTask.taskId} (${outcome.rootTask.status}, ${outcome.rootTask.workerType})`);
      console.log(`  bornes : ${o.maxCycles} cycle(s) · ${o.maxCorrections} correction(s) · ${o.maxCostUsd} $ · échéance ${o.deadlineAt}`);
      console.log(`  superviseur : ${config.supervisor.enabled ? 'ouvert' : `${c.amber}fermé (ATLAS_SUPERVISOR_ENABLED=false) : la tâche tournera, rien ne la relira${c.reset}`}\n`);
    }
  } else if (command === 'poll') {
    const provider = createAiProviders({ config, logger, repos }).openai;
    const report = await runSupervisorPoll({ repos, config, logger, provider, actor: `supervisor-cli#${process.pid}` });
    console.log(`\n  ${c.bold}${c.cyan}SUPERVISOR POLL${c.reset}  ${report.ran ? 'exécuté' : `${c.amber}non exécuté${c.reset}`}`);
    for (const reason of report.skipped) console.log(`  ${c.dim}- ${reason}${c.reset}`);
    for (const r of report.reviewed) console.log(`  ${r.decision.padEnd(9)} ${r.code.padEnd(20)} ${r.taskId}${r.childTaskId ? ` → ${r.childTaskId}` : ''}`);
    for (const d of report.deferred) console.log(`  ${c.amber}- différée ${d.taskId} : ${d.reason}${c.reset}`);
    for (const o of report.timedOut) console.log(`  ${c.amber}- échéance dépassée : ${o}${c.reset}`);
    for (const error of report.errors) console.log(`  ${c.red}- ${error}${c.reset}`);
    console.log(`  appels GPT : ${report.gptCalls} · coût : ${report.costUsd.toFixed(4)} $`);
    console.log(`\n  MESSAGES SENT: ${report.messagesSent} · apply/push/deploy : aucun\n`);
    process.exitCode = report.errors.length > 0 && !report.ran ? 1 : 0;
  } else if (command === 'status') {
    const provider = createAiProviders({ config, logger, repos }).openai;
    const status = supervisorStatus(repos, config, { provider }, Number(flag('limit') ?? 10));
    const r = status.readiness!;
    console.log(`\n  ${c.bold}${c.cyan}GPT SUPERVISOR V1${c.reset}  ${r.ready ? `${c.green}OUVERT${c.reset}` : `${c.amber}FERMÉ${c.reset}`}`);
    console.log(`  relecteur : ${r.provider}/${r.model} · clé : ${r.providerConfigured ? 'présente' : 'absente'} · tour toutes les ${config.supervisor.pollMinutes} min`);
    console.log(`  bornes : ${config.supervisor.maxCycles} cycle(s) · ${config.supervisor.maxCorrections} correction(s) · ${config.supervisor.objectiveTimeoutMinutes} min · ${config.supervisor.maxObjectiveCostUsd} $ par objectif · revue ${config.supervisor.reviewTimeoutMs} ms`);
    for (const reason of r.reasons) console.log(`  ${c.dim}- ${reason}${c.reset}`);
    console.log(`\n  dernier ${SUPERVISOR_POLL_TASK_TYPE} : ${status.lastPoll ? `${status.lastPoll.status} ${status.lastPoll.finishedAt ?? ''}` : 'aucun'}`);
    console.log(`\n  ${c.bold}Objectifs${c.reset} (${status.objectives.length})`);
    for (const { objective: o, reviews, tasks } of status.objectives) {
      const colour = o.status === 'COMPLETE' ? c.green : o.status === 'BLOCKED' ? c.red : c.cyan;
      console.log(`\n  ${colour}${o.status.padEnd(8)}${c.reset} ${o.objectiveId}  cycle ${o.cycles}/${o.maxCycles} · ${o.source} · ${o.createdAt.slice(0, 16)}`);
      console.log(`  ${c.dim}${o.objective.slice(0, 140)}${c.reset}`);
      if (o.terminalCode) console.log(`  issue : ${o.terminalCode} — ${String(o.terminalReason ?? '').slice(0, 200)}`);
      if (o.lastNote) console.log(`  ${c.amber}note : ${o.lastNote.slice(0, 200)}${c.reset}`);
      for (const t of tasks) {
        const review = reviews.find((rv) => rv.taskId === t.taskId);
        console.log(`    cycle ${t.cycle ?? '?'}  ${t.taskId}  ${t.status}${t.resultStatus ? `/${t.resultStatus}` : ''}  ${c.dim}${t.diffHash ?? ''}${c.reset}`
          + (review ? `  → ${review.reviewer ?? ''} ${review.decision ?? review.state} (${review.code ?? ''})${review.childTaskId ? ` → ${review.childTaskId}` : ''}` : ''));
      }
    }
    if (status.objectives.length === 0) console.log(`  ${c.dim}aucun${c.reset}`);
    console.log('');
  } else {
    console.error(`commande inconnue : ${command} (status | start | poll)`);
    process.exitCode = 2;
  }
} finally {
  repos.close();
}
