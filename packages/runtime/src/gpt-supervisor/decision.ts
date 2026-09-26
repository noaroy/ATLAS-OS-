import { z } from 'zod';
import { checkCommand } from '../ai-contracts.ts';
import { SUPERVISOR_DECISION_SCHEMA, type DecisionVerdict, type SupervisorDecision } from './types.ts';

/**
 * La décision de GPT : un objet JSON versionné, et rien d'autre.
 *
 * Pur — ni base, ni réseau — pour que chaque refus se vérifie sur un cas figé.
 * La lecture refuse plutôt qu'elle ne répare : du texte autour de l'objet, un
 * bloc de code, un champ inconnu, un identifiant qui ne correspond pas à la
 * tâche relue, une suite demandée avec COMPLETE — tout cela est MALFORMED, et
 * l'objectif s'arrête. Une décision devinée serait pire qu'une décision absente.
 */

export const DECISION_BOUNDS = {
  maxSummaryChars: 1_000,
  maxReasons: 10,
  maxReasonChars: 500,
  minObjectiveChars: 10,
  maxObjectiveChars: 4_000,
  maxAcceptance: 20,
  maxTestCommands: 6,
  maxTextChars: 20_000,
} as const;

const text = (max: number) => z.string().trim().min(1).max(max);

const nextTaskShape = z.object({
  objective: z.string().trim().min(DECISION_BOUNDS.minObjectiveChars).max(DECISION_BOUNDS.maxObjectiveChars),
  acceptance_criteria: z.array(text(DECISION_BOUNDS.maxReasonChars)).max(DECISION_BOUNDS.maxAcceptance),
  test_commands: z.array(z.string()).max(DECISION_BOUNDS.maxTestCommands),
}).strict();

const decisionShape = z.object({
  schema: z.literal(SUPERVISOR_DECISION_SCHEMA),
  objective_id: z.string().min(1).max(100),
  reviewed_task_id: z.string().min(1).max(100),
  decision: z.enum(['COMPLETE', 'NEXT_TASK', 'CORRECT', 'BLOCKED']),
  summary: text(DECISION_BOUNDS.maxSummaryChars),
  reasons: z.array(text(DECISION_BOUNDS.maxReasonChars)).max(DECISION_BOUNDS.maxReasons),
  next_task: nextTaskShape.nullable(),
  blocked_reason: z.string().trim().min(1).max(DECISION_BOUNDS.maxSummaryChars).nullable(),
}).strict();

const malformed = (...reasons: string[]): DecisionVerdict => ({ ok: false, code: 'MALFORMED_REVIEW', reasons });

/**
 * Lire la réponse de GPT.
 *
 * Le texte entier, une fois les espaces retirés, doit être l'objet : pas de
 * prose avant, pas de bloc ```json, pas de second objet après. `JSON.parse`
 * sur le tout — jamais une extraction « du premier objet trouvé », qui
 * accepterait n'importe quelle réponse contenant une accolade.
 */
export function parseSupervisorDecision(
  raw: string,
  expected: { objectiveId: string; taskId: string },
): DecisionVerdict {
  if (typeof raw !== 'string') return malformed('réponse absente');
  const trimmed = raw.trim();
  if (!trimmed) return malformed('réponse vide');
  if (trimmed.length > DECISION_BOUNDS.maxTextChars) return malformed(`réponse de plus de ${DECISION_BOUNDS.maxTextChars} caractères`);
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return malformed('la réponse doit être un unique objet JSON, sans texte autour');
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return malformed('JSON illisible');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return malformed('la réponse n’est pas un objet JSON');

  const parsed = decisionShape.safeParse(value);
  if (!parsed.success) {
    return malformed(...parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`));
  }
  const d = parsed.data;
  const problems: string[] = [];
  if (d.objective_id !== expected.objectiveId) problems.push(`objective_id ${d.objective_id} ≠ ${expected.objectiveId}`);
  if (d.reviewed_task_id !== expected.taskId) problems.push(`reviewed_task_id ${d.reviewed_task_id} ≠ ${expected.taskId}`);

  const wantsTask = d.decision === 'NEXT_TASK' || d.decision === 'CORRECT';
  if (wantsTask && !d.next_task) problems.push(`${d.decision} exige next_task`);
  if (!wantsTask && d.next_task) problems.push(`${d.decision} interdit next_task`);
  if (d.decision === 'BLOCKED' && !d.blocked_reason) problems.push('BLOCKED exige blocked_reason');
  if (d.decision !== 'BLOCKED' && d.blocked_reason) problems.push(`${d.decision} interdit blocked_reason`);

  const commands: string[] = [];
  for (const command of d.next_task?.test_commands ?? []) {
    const verdict = checkCommand(command);
    if (!verdict.allowed) problems.push(`commande refusée « ${command.slice(0, 60)} » : ${verdict.reason}`);
    const normalised = command.trim().replace(/\s+/g, ' ');
    if (!commands.includes(normalised)) commands.push(normalised);
  }
  if (problems.length > 0) return malformed(...problems);

  const decision: SupervisorDecision = {
    schema: SUPERVISOR_DECISION_SCHEMA,
    objective_id: d.objective_id,
    reviewed_task_id: d.reviewed_task_id,
    decision: d.decision,
    summary: d.summary,
    reasons: d.reasons,
    next_task: d.next_task
      ? { objective: d.next_task.objective, acceptance_criteria: d.next_task.acceptance_criteria, test_commands: commands }
      : null,
    blocked_reason: d.blocked_reason,
  };
  return { ok: true, decision };
}

/** Ce qu'on demande à GPT, écrit une fois : le format est la moitié de la garde. */
export function decisionInstructions(expected: { objectiveId: string; taskId: string }): string {
  return [
    'Réponds par UN SEUL objet JSON, sans aucun texte avant ou après, sans bloc de code, de cette forme exacte :',
    '{',
    `  "schema": "${SUPERVISOR_DECISION_SCHEMA}",`,
    `  "objective_id": "${expected.objectiveId}",`,
    `  "reviewed_task_id": "${expected.taskId}",`,
    '  "decision": "COMPLETE" | "NEXT_TASK" | "CORRECT" | "BLOCKED",',
    '  "summary": "une ou deux phrases",',
    '  "reasons": ["au plus 10 raisons courtes"],',
    '  "next_task": null | { "objective": "instruction précise et bornée pour l’ingénieur", "acceptance_criteria": ["..."], "test_commands": [] },',
    '  "blocked_reason": null | "raison précise"',
    '}',
    'Règles :',
    '- COMPLETE : l’objectif est entièrement atteint par le diff cumulé relu. next_task = null, blocked_reason = null.',
    '- NEXT_TASK : une étape supplémentaire, petite et vérifiable, reste nécessaire. next_task requis.',
    '- CORRECT : le diff relu est incorrect ou incomplet et doit être corrigé. next_task requis.',
    '- BLOCKED : continuer n’est pas sûr ou pas possible sans décision humaine. blocked_reason requis, next_task = null.',
    '- test_commands : uniquement parmi « npm test », « npm run typecheck », « npm run build », « git diff », « git status », « git diff --stat » ; [] pour garder celles de l’objectif.',
    '- Aucune suite ne peut demander un envoi, un paiement, un déploiement, un push, un commit sur main, ni toucher aux secrets : ce sont des décisions humaines, choisis BLOCKED.',
    '- Les chemins autorisés sont ceux de l’objectif ; une suite ne peut pas les élargir.',
  ].join('\n');
}
