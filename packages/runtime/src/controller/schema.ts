import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import type { AtlasConfig } from '@atlas/core';
import { checkCommand, redactSecrets } from '../ai-contracts.ts';
import { isDeniedPath } from '../repo-guard.ts';
import {
  CONTROLLER_TASK_SCHEMA, CONTROLLER_RESULT_SCHEMA, CONTROLLER_ACCEPTED_TASK_TYPE, ENVELOPE_BOUNDS,
  type ControllerTaskEnvelope, type ControllerLimitsRequest, type EffectiveLimits, type EnvelopeVerdict,
  type EnvelopeRejectionCode, type ControllerResult, type ControllerState,
} from './types.ts';

/**
 * L'enveloppe `atlas.controller-task.v1` : la trouver, la valider, l'empreindre.
 *
 * Pur — ni base, ni réseau — pour que chaque refus se vérifie sur un cas figé.
 * La validation refuse plutôt qu'elle ne répare : un chemin douteux n'est pas
 * « nettoyé », une commande inconnue n'est pas « rapprochée » de la liste
 * blanche, un plafond trop haut est ramené au plafond du déploiement et le
 * résultat le dit.
 */

const reject = (
  code: EnvelopeRejectionCode, reasons: string[], correlationId: string | null = null,
): EnvelopeVerdict => ({ ok: false, code, reasons, correlationId });

/**
 * Extraire l'enveloppe du corps d'une issue.
 *
 * Deux formes, et seulement deux : le corps entier est l'objet JSON, ou il
 * contient exactement un bloc ```json qui porte le nom du schéma. Le texte
 * autour est ignoré — il n'entre ni dans la tâche ni dans la mission. Deux
 * blocs candidats sont un refus : choisir l'un des deux serait deviner.
 */
export function extractEnvelope(body: string): { ok: true; raw: unknown } | { ok: false; code: EnvelopeRejectionCode; reason: string } {
  const trimmed = body.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      return { ok: true, raw: JSON.parse(trimmed) as unknown };
    } catch {
      return { ok: false, code: 'INVALID_JSON', reason: 'le corps ressemble à un objet JSON mais ne se lit pas' };
    }
  }
  const blocks = [...body.matchAll(/```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/gi)]
    .map((m) => m[1] ?? '')
    .filter((block) => block.includes('atlas.controller-task'));
  if (blocks.length === 0) {
    return { ok: false, code: 'NO_ENVELOPE', reason: `aucune enveloppe ${CONTROLLER_TASK_SCHEMA} (bloc \`\`\`json) dans l’issue` };
  }
  if (blocks.length > 1) {
    return { ok: false, code: 'AMBIGUOUS_ENVELOPE', reason: `${blocks.length} enveloppes candidates : une seule est acceptée` };
  }
  try {
    return { ok: true, raw: JSON.parse(blocks[0]!) as unknown };
  } catch {
    return { ok: false, code: 'INVALID_JSON', reason: 'le bloc ```json ne se lit pas' };
  }
}

/** Les dossiers interdits où qu'ils soient. */
const PROTECTED_ANYWHERE = new Set(['.git', '.github', 'node_modules', 'dist', 'secrets', '.ssh', '.gnupg', '.aws']);
/** Les dossiers interdits à la racine du dépôt (packages/data reste permis). */
const PROTECTED_AT_ROOT = new Set(['data', 'deployment']);
/** Ce qui ressemble à une clé, quel que soit le dossier. */
const KEY_MATERIAL = [
  /\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|gpg|asc|ppk|kdbx)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /secret/i,
  /\.token\.json$/i,
];

export type PathCheck =
  | { ok: true; path: string }
  | { ok: false; code: 'INVALID_PATH' | 'PROTECTED_PATH'; reason: string };

/**
 * Un chemin de `allowed_paths` est-il acceptable ?
 *
 * Relatif, littéral, sans détour : pas de `/` initial ni de lecteur, pas de
 * `.` ni de `..`, pas de joker (`*`, `**`, `?`, `[…]`, `{…}`), pas de `~` ni de
 * `$`. Puis la liste des zones protégées — secrets, dépôt git, workflows,
 * dépendances, sorties de build, données et déploiement — complétée par la
 * liste noire que le worktree applique déjà (`isDeniedPath`). Une barre
 * oblique finale est tolérée et retirée.
 */
export function checkControllerPath(input: unknown): PathCheck {
  if (typeof input !== 'string') return { ok: false, code: 'INVALID_PATH', reason: 'un chemin doit être une chaîne' };
  const raw = input.trim();
  const bad = (reason: string): PathCheck => ({ ok: false, code: 'INVALID_PATH', reason: `« ${raw.slice(0, 80)} » : ${reason}` });
  const protectedPath = (reason: string): PathCheck => ({ ok: false, code: 'PROTECTED_PATH', reason: `« ${raw.slice(0, 80)} » : ${reason}` });

  if (!raw) return bad('chemin vide');
  if (raw.length > ENVELOPE_BOUNDS.maxPathLength) return bad(`plus de ${ENVELOPE_BOUNDS.maxPathLength} caractères`);
  if (/[\x00-\x1f\x7f]/.test(raw)) return bad('caractère de contrôle');
  if (raw.includes('\\')) return bad('barre oblique inverse');
  if (/^\//.test(raw) || /^[a-z]:/i.test(raw)) return bad('chemin absolu');
  if (/[*?[\]{}]/.test(raw)) return bad('joker interdit : un chemin est littéral');
  if (raw.startsWith('~') || raw.includes('$')) return bad('expansion de shell interdite');

  const path = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '') return bad('segment vide');
    if (segment === '.' || segment === '..') return bad(`segment « ${segment} » interdit`);
  }

  // Comparés sans casse et sans points ni espaces finaux : `.ENV` et `.env. `
  // désignent le même fichier sur certains systèmes.
  const names = segments.map((s) => s.toLowerCase().replace(/[\s.]+$/, ''));
  for (const [index, name] of names.entries()) {
    if (PROTECTED_ANYWHERE.has(name)) return protectedPath(`« ${segments[index]} » est protégé`);
    if (name.startsWith('.env')) return protectedPath('les fichiers .env sont protégés');
    if (index === 0 && PROTECTED_AT_ROOT.has(name)) return protectedPath(`« ${segments[0]}/ » est protégé à la racine`);
    if (KEY_MATERIAL.some((pattern) => pattern.test(segments[index]!))) return protectedPath('ressemble à une clé ou à un secret');
  }
  const denied = isDeniedPath(path);
  if (denied.denied) return protectedPath(denied.reason);
  return { ok: true, path };
}

/** Les plafonds du déploiement, dans l'unité de l'enveloppe. */
export function systemLimits(config: AtlasConfig): Required<ControllerLimitsRequest> {
  return {
    max_files_changed: config.engineering.maxFilesChanged,
    max_diff_lines: config.engineering.maxDiffLines,
    timeout_minutes: Math.max(1, Math.floor(config.engineering.claudeCodeTimeoutMs / 60_000)),
  };
}

/**
 * Les bornes effectives : le minimum de ce qui est demandé et du plafond.
 *
 * Une borne absente prend le plafond. Une borne plus haute que le plafond y
 * est ramenée, et nommée dans `clamped` : le demandeur doit savoir qu'il n'a
 * pas obtenu ce qu'il demandait.
 */
export function clampLimits(requested: ControllerLimitsRequest, config: AtlasConfig): EffectiveLimits {
  const system = systemLimits(config);
  const clamped: EffectiveLimits['clamped'] = [];
  const pick = (key: keyof ControllerLimitsRequest): number => {
    const value = requested[key];
    if (value === undefined) return system[key];
    if (value > system[key]) {
      clamped.push(key);
      return system[key];
    }
    return value;
  };
  return {
    requested,
    system,
    effective: {
      max_files_changed: pick('max_files_changed'),
      max_diff_lines: pick('max_diff_lines'),
      timeout_minutes: pick('timeout_minutes'),
    },
    clamped,
  };
}

const text = (max: number) => z.string().trim().min(1).max(max);
const positiveInt = z.number().int().min(1).max(1_000_000);
const limitsShape = z.object({
  max_files_changed: positiveInt.optional(),
  max_diff_lines: positiveInt.optional(),
  timeout_minutes: positiveInt.optional(),
}).strict();

const envelopeShape = z.object({
  schema: z.literal(CONTROLLER_TASK_SCHEMA),
  task_type: z.literal(CONTROLLER_ACCEPTED_TASK_TYPE),
  correlation_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/, 'correlation_id : 1 à 80 caractères [A-Za-z0-9._:-]'),
  objective: z.string().trim().min(ENVELOPE_BOUNDS.minObjectiveChars).max(ENVELOPE_BOUNDS.maxObjectiveChars),
  allowed_paths: z.array(z.string()).min(1, 'allowed_paths est requis').max(ENVELOPE_BOUNDS.maxAllowedPaths, `allowed_paths : ${ENVELOPE_BOUNDS.maxAllowedPaths} au plus`),
  test_commands: z.array(z.string()).max(ENVELOPE_BOUNDS.maxTestCommands, `test_commands : ${ENVELOPE_BOUNDS.maxTestCommands} au plus`).default([]),
  acceptance_criteria: z.array(text(ENVELOPE_BOUNDS.maxListItemChars)).max(ENVELOPE_BOUNDS.maxListItems).default([]),
  constraints: z.array(text(ENVELOPE_BOUNDS.maxListItemChars)).max(ENVELOPE_BOUNDS.maxListItems).default([]),
  limits: limitsShape.default({}),
  autonomous: z.boolean().default(false),
  apply: z.literal(false),
  push: z.literal(false),
  deploy: z.literal(false),
}).strict();

/**
 * L'empreinte d'une demande.
 *
 * Dépôt, issue, corrélation, objectif, chemins (triés : un ensemble) et
 * commandes (dans l'ordre : une séquence). Déterministe : la même issue relue
 * après un redémarrage donne la même empreinte, donc la même clé
 * d'idempotence, donc la même tâche.
 */
export function controllerFingerprint(input: {
  repo: string; issue: number; correlationId: string; objective: string;
  allowedPaths: readonly string[]; testCommands: readonly string[];
}): string {
  const material = JSON.stringify([
    CONTROLLER_TASK_SCHEMA,
    input.repo.trim().toLowerCase(),
    input.issue,
    input.correlationId,
    input.objective.trim(),
    [...input.allowedPaths].sort(),
    [...input.testCommands],
  ]);
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/**
 * Lire une issue : enveloppe trouvée, validée, bornée, empreinte.
 *
 * L'ordre des refus suit leur lisibilité : le mauvais schéma et le mauvais
 * type d'abord, puis le refus explicite d'apply/push/deploy — qui doit se lire
 * comme un refus, pas comme une faute de forme — puis la forme, les chemins,
 * les commandes.
 */
export function parseControllerIssue(
  body: string,
  context: { repo: string; issue: number; config: AtlasConfig },
): EnvelopeVerdict {
  if (body.length > ENVELOPE_BOUNDS.maxBodyChars) {
    return reject('INVALID_ENVELOPE', [`corps de plus de ${ENVELOPE_BOUNDS.maxBodyChars} caractères`]);
  }
  const extracted = extractEnvelope(body);
  if (!extracted.ok) return reject(extracted.code, [extracted.reason]);

  const raw = extracted.raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return reject('INVALID_ENVELOPE', ['l’enveloppe n’est pas un objet JSON']);
  }
  const o = raw as Record<string, unknown>;
  const correlationId = typeof o.correlation_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(o.correlation_id)
    ? o.correlation_id : null;

  if (o.schema !== CONTROLLER_TASK_SCHEMA) {
    return reject('WRONG_SCHEMA', [`schema attendu : ${CONTROLLER_TASK_SCHEMA}`], correlationId);
  }
  if (o.task_type !== CONTROLLER_ACCEPTED_TASK_TYPE) {
    return reject('WRONG_TASK_TYPE', [`seul ${CONTROLLER_ACCEPTED_TASK_TYPE} est accepté (reçu : ${String(o.task_type).slice(0, 40)})`], correlationId);
  }
  const forbidden = (['apply', 'push', 'deploy'] as const).filter((flag) => o[flag] === true);
  if (forbidden.length > 0) {
    return reject('APPLY_PUSH_DEPLOY_REFUSED', [
      `${forbidden.join(', ')} = true refusé : le pont s’arrête à READY_FOR_REVIEW. `
      + 'Aucun apply, commit sur main, push ni déploiement n’est jamais effectué par ce chemin.',
    ], correlationId);
  }

  if (o.limits && typeof o.limits === 'object' && !Array.isArray(o.limits)) {
    const limits = limitsShape.safeParse(o.limits);
    if (!limits.success) {
      return reject('INVALID_LIMITS', limits.error.issues.map((i) => `limits.${i.path.join('.')} : ${i.message}`), correlationId);
    }
  } else if (o.limits !== undefined) {
    return reject('INVALID_LIMITS', ['limits doit être un objet'], correlationId);
  }

  const parsed = envelopeShape.safeParse(raw);
  if (!parsed.success) {
    return reject('INVALID_ENVELOPE', parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`), correlationId);
  }
  const envelope = parsed.data;

  const paths: string[] = [];
  const pathProblems: Array<Extract<PathCheck, { ok: false }>> = [];
  for (const candidate of envelope.allowed_paths) {
    const verdict = checkControllerPath(candidate);
    if (verdict.ok) {
      if (!paths.includes(verdict.path)) paths.push(verdict.path);
    } else {
      pathProblems.push(verdict);
    }
  }
  if (pathProblems.length > 0) {
    const code = pathProblems.some((p) => p.code === 'PROTECTED_PATH') ? 'PROTECTED_PATH' : 'INVALID_PATH';
    return reject(code, pathProblems.map((p) => p.reason), correlationId);
  }

  // La liste blanche existante, et elle seule : aucune commande n'est
  // « presque » autorisée. `checkCommand` refuse aussi enchaînements,
  // redirections et substitutions.
  const commands: string[] = [];
  const commandProblems: string[] = [];
  for (const candidate of envelope.test_commands) {
    const verdict = checkCommand(candidate);
    const normalised = candidate.trim().replace(/\s+/g, ' ');
    if (!verdict.allowed) commandProblems.push(`« ${normalised.slice(0, 80)} » : ${verdict.reason}`);
    else if (!commands.includes(normalised)) commands.push(normalised);
  }
  if (commandProblems.length > 0) return reject('INVALID_COMMAND', commandProblems, correlationId);

  const result: ControllerTaskEnvelope = {
    schema: CONTROLLER_TASK_SCHEMA,
    task_type: CONTROLLER_ACCEPTED_TASK_TYPE,
    correlation_id: envelope.correlation_id,
    objective: envelope.objective,
    allowed_paths: paths,
    test_commands: commands,
    acceptance_criteria: envelope.acceptance_criteria,
    constraints: envelope.constraints,
    limits: envelope.limits,
    autonomous: envelope.autonomous,
    apply: false,
    push: false,
    deploy: false,
  };
  return {
    ok: true,
    envelope: result,
    limits: clampLimits(result.limits, context.config),
    fingerprint: controllerFingerprint({
      repo: context.repo, issue: context.issue, correlationId: result.correlation_id,
      objective: result.objective, allowedPaths: result.allowed_paths, testCommands: result.test_commands,
    }),
  };
}

/** Le squelette d'un résultat : les quatre « non » sont écrits, jamais déduits. */
export function buildControllerResult(input: {
  state: ControllerState;
  repo: string;
  issue: number;
  correlationId?: string | null;
  fingerprint?: string | null;
  taskId?: string | null;
  worker?: string | null;
  summary: string;
  errorCode?: string | null;
  reasons?: string[];
  limits?: EffectiveLimits['effective'] | null;
  clamped?: string[];
  diff?: ControllerResult['diff'];
}): ControllerResult {
  const cap = (values: readonly string[] | undefined, n: number) => (values ?? []).slice(0, n).map((v) => String(v).slice(0, 300));
  return {
    schema: CONTROLLER_RESULT_SCHEMA,
    state: input.state,
    repo: input.repo,
    issue: input.issue,
    correlation_id: input.correlationId ?? null,
    fingerprint: input.fingerprint ?? null,
    task_id: input.taskId ?? null,
    task_type: CONTROLLER_ACCEPTED_TASK_TYPE,
    worker: input.worker ?? null,
    summary: input.summary.slice(0, 1_000),
    error_code: input.errorCode ?? null,
    reasons: cap(input.reasons, 20),
    effective_limits: input.limits ?? null,
    clamped_limits: input.clamped ?? [],
    diff: input.diff
      ? {
        ...input.diff,
        files_changed: cap(input.diff.files_changed, 50),
        files_added: cap(input.diff.files_added, 50),
        files_deleted: cap(input.diff.files_deleted, 50),
      }
      : null,
    apply_performed: false,
    commit_to_main: false,
    push_performed: false,
    deploy_performed: false,
    messages_sent: 0,
  };
}

/**
 * Le marqueur d'un commentaire publié.
 *
 * Il sert à retrouver, après un arrêt entre la publication et sa consignation,
 * qu'un commentaire est déjà parti. Signé par HMAC sur le secret de session :
 * sans cela, n'importe quel commentateur pourrait recopier le marqueur et
 * faire taire un résultat.
 */
export function resultMarker(key: string, secret: string): string {
  const signature = createHmac('sha256', secret).update(key).digest('hex').slice(0, 24);
  const safeKey = key.replace(/-{2,}/g, '-').replace(/[^A-Za-z0-9:#/._-]/g, '_');
  return `<!-- atlas-controller-result ${safeKey} ${signature} -->`;
}

/**
 * Le commentaire publié : une ligne lisible, puis le résultat en JSON.
 *
 * Tout passe par `redactSecrets`, et par le `redact` du client GitHub, qui
 * efface littéralement le jeton en cours : les motifs couvrent les formes
 * connues, pas un jeton au format imprévu.
 */
export function renderResultComment(
  result: ControllerResult,
  marker: string,
  redact: (text: string) => string = (t) => t,
): string {
  const headline: Record<ControllerState, string> = {
    QUEUED: 'demande acceptée : une tâche ENGINEERING_CHANGE est en file',
    RUNNING: 'tâche en cours',
    READY_FOR_REVIEW: 'diff prêt pour revue humaine (READY_FOR_REVIEW)',
    BLOCKED: 'tâche bloquée : une décision humaine est attendue',
    FAILED: 'tâche en échec',
    REJECTED: 'demande refusée : aucune tâche créée',
  };
  const body = [
    `**ATLAS controller — ${result.state}** · ${headline[result.state]}`,
    '',
    'Rien n’a été appliqué, commité sur main, poussé ni déployé.',
    '',
    marker,
    '```json',
    JSON.stringify(result, null, 2),
    '```',
  ].join('\n');
  return redactSecrets(redact(body)).slice(0, 60_000);
}
