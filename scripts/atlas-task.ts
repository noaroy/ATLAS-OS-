/**
 * Manipuler la file à la main.
 *
 * Ces commandes passent exactement par la même couche que le daemon — même
 * dépôt, même machine à états, mêmes refus. Une commande d'administration qui
 * écrirait directement en base finirait par produire des états que le daemon ne
 * sait pas lire, et la panne apparaîtrait des heures plus tard, sans lien
 * apparent avec la commande qui l'a causée.
 *
 *   atlas-task create --type=DEMO_SLEEP --department=BACKGROUND
 *   atlas-task list [--status=QUEUED]
 *   atlas-task show <taskId>
 *   atlas-task retry <taskId> --by=noaroy
 *   atlas-task cancel <taskId> --by=noaroy
 */
import { createLogger, nowIso, loadAtlasEnv, loadConfig } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';

// Avant toute lecture de process.env : sans cet appel, `.env.local` n'existe
// pas pour ce processus et la configuration parait absente sans qu'aucune
// erreur ne le dise.
loadAtlasEnv();

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};

const [action = 'list', ...rest] = process.argv.slice(2);
const flag = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const logger = createLogger({ level: 'error', pretty: false });
const config = loadConfig(process.cwd());
const repos = createRepositories(config.paths.databaseFile, logger);

const COLOUR: Record<string, string> = {
  QUEUED: c.cyan, RUNNING: c.green, DONE: c.dim, FAILED: c.red,
  PAUSED_QUOTA: c.amber, PAUSED_BUDGET: c.amber, WAITING_HUMAN: c.amber,
  WAITING_DEPENDENCY: c.dim, RETRY_SCHEDULED: c.amber, CANCELLED: c.dim,
};
const paint = (status: string) => `${COLOUR[status] ?? ''}${status.padEnd(19)}${c.reset}`;

try {
  if (action === 'create') {
    const type = flag('type');
    if (!type) {
      console.error('usage: atlas-task create --type=<TYPE> [--department=] [--worker=] [--payload=<json>]');
      process.exit(1);
    }
    let payload: Record<string, unknown> = {};
    const raw = flag('payload');
    if (raw) {
      try {
        payload = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        console.error('--payload doit être du JSON valide');
        process.exit(1);
      }
    }
    const outcome = repos.tasks.create({
      taskType: type,
      department: flag('department') ?? 'BACKGROUND',
      workerType: flag('worker') ?? 'DETERMINISTIC',
      priority: Number(flag('priority') ?? 0),
      payload,
      availableAt: flag('at') ?? undefined,
      maxAttempts: Number(flag('max-attempts') ?? 3),
      idempotencyKey: flag('key'),
      correlationId: flag('correlation'),
      dependsOn: flag('depends-on')?.split(',').filter(Boolean),
    });
    console.log(
      outcome.created
        ? `${outcome.task.taskId}  ${outcome.task.status}  ${outcome.task.taskType}`
        : `${outcome.task.taskId}  déjà présente (même clé d'idempotence)`,
    );
  } else if (action === 'list') {
    const tasks = repos.tasks.list({
      status: flag('status') ?? undefined,
      limit: Number(flag('limit') ?? 30),
    });
    console.log(`\n  ${c.bold}FILE${c.reset} — ${tasks.length} tâche(s)\n`);
    console.log(
      `  ${c.dim}${'ID'.padEnd(32)}${'ÉTAT'.padEnd(19)}${'TYPE'.padEnd(18)}` +
        `${'DÉPT'.padEnd(16)}${'ESS.'.padEnd(6)}DISPONIBLE${c.reset}`,
    );
    for (const task of tasks) {
      console.log(
        `  ${task.taskId.padEnd(32)}${paint(task.status)}${task.taskType.slice(0, 17).padEnd(18)}` +
          `${task.department.slice(0, 15).padEnd(16)}` +
          `${`${task.attemptCount}/${task.maxAttempts}`.padEnd(6)}` +
          `${task.availableAt.slice(0, 19).replace('T', ' ')}`,
      );
    }
    console.log();
  } else if (action === 'show') {
    const task = repos.tasks.byId(rest[0] ?? '');
    if (!task) {
      console.error(`tâche inconnue : ${rest[0]}`);
      process.exit(1);
    }
    console.log(`\n  ${c.bold}${task.taskId}${c.reset}  ${paint(task.status)}`);
    console.log(`  type        ${task.taskType}`);
    console.log(`  département ${task.department}  ·  worker ${task.workerType}`);
    console.log(`  tentatives  ${task.attemptCount}/${task.maxAttempts}`);
    console.log(`  disponible  ${task.availableAt}`);
    if (task.leaseUntil) console.log(`  bail        ${task.leaseOwner} jusqu'au ${task.leaseUntil}`);
    if (task.errorCode) console.log(`  erreur      ${task.errorCode} — ${task.errorMessage}`);
    if (task.result) console.log(`  résultat    ${JSON.stringify(task.result)}`);
    console.log(`\n  ${c.dim}HISTORIQUE${c.reset}`);
    for (const step of repos.tasks.historyFor(task.taskId)) {
      console.log(
        `    ${step.occurredAt.slice(0, 19).replace('T', ' ')}  ` +
          `${(step.from ?? '—').padEnd(19)}→ ${step.to.padEnd(19)}${c.dim}${step.reason ?? ''}${c.reset}`,
      );
    }
    console.log();
  } else if (action === 'retry' || action === 'cancel') {
    const taskId = rest[0];
    const by = flag('by');
    if (!taskId || !by) {
      console.error(`usage: atlas-task ${action} <taskId> --by=<nom>`);
      process.exit(1);
    }
    // Même machine à états que le daemon : un refus ici est le même refus.
    const outcome = repos.tasks.transition({
      taskId,
      to: action === 'retry' ? 'QUEUED' : 'CANCELLED',
      actor: by,
      reason: flag('reason') ?? `${action} demandé à la main`,
      patch:
        action === 'retry'
          ? { available_at: nowIso(), error_code: null, error_message: null }
          : { finished_at: nowIso(), lease_owner: null, lease_until: null },
    });
    if (!outcome.applied) {
      console.error(outcome.reason);
      process.exit(1);
    }
    console.log(`${taskId} → ${action === 'retry' ? 'QUEUED' : 'CANCELLED'} (par ${by})`);
  } else {
    console.error(`action inconnue : « ${action} ». Attendu : create | list | show | retry | cancel`);
    process.exit(1);
  }
} finally {
  repos.close();
}
