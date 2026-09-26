/**
 * Le pont contrôleur, à la main.
 *
 *   npm run controller -- status                   l'état : ouvert ou fermé (et pourquoi), dernier sondage, issues reçues
 *   npm run controller -- validate --file=<json>   valider une enveloppe atlas.controller-task.v1, sans GitHub ni base
 *   npm run controller -- poll                     un tour de sondage maintenant (mêmes gardes que le tour cadencé)
 *
 * Le jeton n'est jamais affiché : seule sa source (ATLAS_CONTROLLER_GITHUB_TOKEN
 * ou GITHUB_TOKEN) l'est. Aucun message commercial ne part, jamais ; aucun
 * apply, commit sur main, push ni déploiement.
 */
import { readFileSync } from 'node:fs';
import { createLogger, loadConfig } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import {
  controllerStatus, parseControllerIssue, runControllerPoll, CONTROLLER_POLL_TASK_TYPE,
} from '../packages/runtime/src/index.ts';

const c = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', amber: '\x1b[33m', cyan: '\x1b[36m' };
const flag = (name: string): string | null => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const command = positional[0] ?? 'status';

const config = loadConfig(process.cwd());

if (command === 'validate') {
  const file = flag('file');
  if (!file) {
    console.error('usage : npm run controller -- validate --file=<enveloppe.json | issue.md>');
    process.exit(2);
  }
  const verdict = parseControllerIssue(readFileSync(file, 'utf8'), {
    repo: config.controller.repo || 'owner/repo', issue: Number(flag('issue') ?? 0), config,
  });
  if (verdict.ok) {
    console.log(`\n  ${c.green}${c.bold}VALIDE${c.reset}  fingerprint ${verdict.fingerprint}`);
    console.log(`  chemins : ${verdict.envelope.allowed_paths.join(', ')}`);
    console.log(`  commandes : ${verdict.envelope.test_commands.join(', ') || '(aucune)'}`);
    console.log(`  bornes effectives : ${JSON.stringify(verdict.limits.effective)}${verdict.limits.clamped.length ? ` ${c.amber}(ramenées : ${verdict.limits.clamped.join(', ')})${c.reset}` : ''}\n`);
    process.exit(0);
  }
  console.log(`\n  ${c.red}${c.bold}REFUSÉE${c.reset}  ${verdict.code}`);
  for (const reason of verdict.reasons) console.log(`  - ${reason}`);
  console.log('');
  process.exit(1);
}

const logger = createLogger({ level: (flag('log') as 'debug' | 'info' | 'warn' | 'error') ?? 'error', pretty: true });
const repos = createRepositories(config.paths.databaseFile, logger);

try {
  if (command === 'poll') {
    const report = await runControllerPoll({ repos, config, logger, actor: `controller-cli#${process.pid}` });
    console.log(`\n  ${c.bold}${c.cyan}CONTROLLER POLL${c.reset}  ${report.ran ? 'exécuté' : `${c.amber}non exécuté${c.reset}`}`);
    for (const reason of report.skipped) console.log(`  ${c.dim}- ${reason}${c.reset}`);
    console.log(`  issues vues : ${report.issuesSeen} · ignorées : ${report.issuesIgnored} · refusées : ${report.rejected.length}`);
    console.log(`  tâches créées : ${report.tasksCreated.length} · déjà existantes : ${report.tasksExisting.length}`);
    console.log(`  commentaires : ${report.commentsPosted} · étiquettes : ${report.labelsChanged}`);
    for (const held of report.held) console.log(`  ${c.amber}- retenu (engagé sans marqueur signé, décision humaine) : ${held}${c.reset}`);
    for (const error of report.errors) console.log(`  ${c.red}- ${error}${c.reset}`);
    console.log(`\n  MESSAGES SENT: ${report.messagesSent} · apply/push/deploy : aucun\n`);
    process.exitCode = report.errors.length > 0 && !report.ran ? 1 : 0;
  } else if (command === 'status') {
    const status = controllerStatus(repos, config);
    const r = status.readiness;
    console.log(`\n  ${c.bold}${c.cyan}CONTROLLER BRIDGE V1${c.reset}  ${r.ready ? `${c.green}OUVERT${c.reset}` : `${c.amber}FERMÉ${c.reset}`}`);
    console.log(`  activé : ${r.enabled} · dépôt : ${r.repo || '(vide)'}${r.repo && !r.repoValid ? ` ${c.red}(invalide)${c.reset}` : ''} · auteurs : ${r.authors} · étiquette : ${r.label}`);
    console.log(`  jeton : ${r.tokenSource ? `présent (${r.tokenSource})` : 'absent'} · sondage toutes les ${config.controller.pollMinutes} min · ${config.controller.maxIssuesPerPoll} issue(s) par tour`);
    for (const reason of r.reasons) console.log(`  ${c.dim}- ${reason}${c.reset}`);
    console.log(`\n  dernier ${CONTROLLER_POLL_TASK_TYPE} : ${status.lastPoll ? `${status.lastPoll.status} ${status.lastPoll.finishedAt ?? ''}${status.lastPoll.errorCode ? ` (${status.lastPoll.errorCode})` : ''}` : 'aucun'}`);
    console.log(`\n  ${c.bold}Issues reçues${c.reset} (${status.intakes.length})`);
    for (const i of status.intakes) {
      console.log(`  ${String(i.state ?? '?').padEnd(17)} ${String(i.target ?? '').padEnd(32)} ${c.dim}${i.taskId ?? ''} · ${i.taskStatus ?? ''} · ${i.claimedAt.slice(0, 16)}${c.reset}`);
    }
    if (status.intakes.length === 0) console.log(`  ${c.dim}aucune${c.reset}`);
    console.log('');
  } else {
    console.error(`commande inconnue : ${command} (status | validate | poll)`);
    process.exitCode = 2;
  }
} finally {
  repos.close();
}
