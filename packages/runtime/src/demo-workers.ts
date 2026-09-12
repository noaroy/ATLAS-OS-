import type { TaskRow } from '@atlas/data';
import type { WorkerContext, WorkerOutcome } from './workers.ts';

/**
 * Des travaux réels, mais sans conséquence.
 *
 * Ils existent pour que la boucle puisse être observée de bout en bout — prise,
 * bail, battement, issue, reprise — sans qu'aucun message parte ni qu'aucun
 * modèle soit appelé. Ce ne sont pas des bouchons de test : le daemon les
 * exécute exactement comme il exécutera les vrais.
 *
 * `DEMO_QUOTA` mérite un mot. Il ne lève pas d'exception : il rend une issue
 * `PAUSED_QUOTA`, ce qui est la façon dont un vrai worker devra signaler une
 * limitation. La différence compte — une exception brûlerait une tentative sur
 * un incident qui n'est pas la faute de la tâche.
 */

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const DEMO_TASK_TYPES = {
  SLEEP: 'DEMO_SLEEP',
  QUOTA: 'DEMO_QUOTA',
  FAIL: 'DEMO_FAIL',
  LONG: 'DEMO_LONG',
} as const;

/** Un travail court qui aboutit. */
async function demoSleep(task: TaskRow): Promise<WorkerOutcome> {
  const durationMs = Number(task.payload.durationMs ?? 100);
  await wait(durationMs);
  return {
    kind: 'DONE',
    result: { durationMs, label: String(task.payload.label ?? task.taskType) },
  };
}

/**
 * Un fournisseur qui refuse.
 *
 * Le fournisseur est lu depuis la charge utile — la démonstration en nomme un
 * qui n'est jamais appelé. Aucune requête ne part.
 */
async function demoQuota(task: TaskRow): Promise<WorkerOutcome> {
  const provider = String(task.payload.provider ?? 'ANTHROPIC');
  return {
    kind: 'PAUSED_QUOTA',
    provider,
    errorCode: 'QUOTA_EXHAUSTED',
    errorMessage: `quota ${provider} épuisé (simulation, aucun appel émis)`,
    // Une échéance annoncée par le fournisseur, quand la démonstration en donne
    // une : c'est le chemin le plus fiable, celui qu'on veut voir emprunté.
    retryAfterHeader: task.payload.retryAfterSeconds
      ? String(task.payload.retryAfterSeconds)
      : null,
  };
}

/** Un échec franc, pour observer la reprise puis l'abandon. */
async function demoFail(task: TaskRow): Promise<WorkerOutcome> {
  return {
    kind: 'FAILED',
    errorCode: String(task.payload.errorCode ?? 'DEMO_FAILURE'),
    errorMessage: String(task.payload.errorMessage ?? 'échec délibéré de démonstration'),
  };
}

/**
 * Un travail long, qui bat pour garder son bail.
 *
 * Il s'interrompt si l'arrêt est demandé : c'est ce qui permet à un daemon de
 * s'arrêter proprement sans attendre la fin d'un travail de plusieurs minutes.
 */
async function demoLong(task: TaskRow, context: WorkerContext): Promise<WorkerOutcome> {
  const totalMs = Number(task.payload.durationMs ?? 5_000);
  const step = 200;
  let elapsed = 0;
  while (elapsed < totalMs) {
    if (context.shuttingDown()) {
      return {
        kind: 'FAILED',
        errorCode: 'SHUTDOWN',
        errorMessage: `interrompu après ${elapsed} ms : arrêt demandé`,
      };
    }
    await wait(step);
    elapsed += step;
    // Sans ce battement, le bail expire et un autre worker reprendrait la
    // tâche alors que celui-ci travaille encore.
    context.heartbeat();
  }
  return { kind: 'DONE', result: { durationMs: elapsed } };
}

export const DEMO_HANDLERS: Record<
  string,
  (task: TaskRow, context: WorkerContext) => Promise<WorkerOutcome>
> = {
  [DEMO_TASK_TYPES.SLEEP]: demoSleep,
  [DEMO_TASK_TYPES.QUOTA]: demoQuota,
  [DEMO_TASK_TYPES.FAIL]: demoFail,
  [DEMO_TASK_TYPES.LONG]: demoLong,
};

/**
 * La frontière avec le commercial.
 *
 * Ces types sont déclarés, pas branchés. Les déclarer maintenant fixe le
 * vocabulaire — une tâche `SALES_DISCOVERY` existe et sera reconnue — sans
 * toucher au comportement commercial actuel, qui continue de passer par ses
 * propres commandes et son approbation humaine.
 */
export const SALES_TASK_TYPES = [
  'SALES_DISCOVERY',
  'SALES_QUALIFICATION',
  'SALES_OUTREACH',
  'SALES_REPLY_CHECK',
] as const;
