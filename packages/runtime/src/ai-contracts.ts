import { createHash } from 'node:crypto';

/**
 * Ce qu'un modèle doit rendre, et comment on vérifie qu'il l'a rendu.
 *
 * Un texte libre ne se vérifie pas. Il se relit, on croit le comprendre, et la
 * suite du système en tire des décisions à partir d'une interprétation. Le
 * schéma existe pour que l'étape suivante travaille sur des champs nommés
 * plutôt que sur une impression.
 *
 * La validation refuse plutôt qu'elle ne répare. Compléter une sortie
 * incomplète avec des valeurs par défaut donnerait un objet valide décrivant
 * quelque chose que le modèle n'a jamais dit — exactement le genre de faux qui
 * traverse ensuite tout le système sans que personne le remarque.
 */

export interface AiTaskResult {
  status: 'PASS' | 'PASS_WITH_NOTES' | 'CHANGES_REQUIRED' | 'NEEDS_HUMAN' | 'DONE' | 'FAILED';
  summary: string;
  /** 0..1 — ce que le modèle dit valoir sa propre réponse. */
  confidence: number;
  findings: Array<{ severity: string; detail: string; reference?: string }>;
  recommendations: string[];
  /** Des tâches proposées — jamais créées par le worker lui-même. */
  next_tasks: Array<{ task_type: string; objective: string; department?: string; rationale?: string }>;
  artifacts: Array<{ kind: string; ref: string }>;
  usage?: Record<string, unknown>;
  provider_metadata?: Record<string, unknown>;
}

export interface SchemaCheck {
  valid: boolean;
  value: AiTaskResult | null;
  violations: string[];
}

const STATUSES = ['PASS', 'PASS_WITH_NOTES', 'CHANGES_REQUIRED', 'NEEDS_HUMAN', 'DONE', 'FAILED'];

/**
 * Valider une sortie de modèle.
 *
 * Les champs facultatifs qui manquent sont remplacés par des collections vides
 * — une absence de recommandation est une information, pas un défaut. Les
 * champs qui portent la décision, eux, sont exigés : sans `status` ni `summary`,
 * il n'y a rien à décider.
 */
export function validateAiResult(raw: unknown): SchemaCheck {
  const violations: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, value: null, violations: ['la sortie n’est pas un objet JSON'] };
  }
  const o = raw as Record<string, unknown>;

  const status = typeof o.status === 'string' ? o.status.toUpperCase() : null;
  if (!status) violations.push('`status` manquant');
  else if (!STATUSES.includes(status)) {
    violations.push(`\`status\` inconnu : ${status} (attendu ${STATUSES.join(', ')})`);
  }

  const summary = typeof o.summary === 'string' ? o.summary.trim() : '';
  if (!summary) violations.push('`summary` manquant ou vide');

  // La confiance est bornée, pas corrigée : un modèle qui rend 1.4 n'a pas
  // compris la question, et masquer cela en écrivant 1 effacerait le signal.
  const confidence = typeof o.confidence === 'number' ? o.confidence : null;
  if (confidence === null) violations.push('`confidence` manquante');
  else if (confidence < 0 || confidence > 1) {
    violations.push(`\`confidence\` hors bornes : ${confidence}`);
  }

  const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

  const findings = asArray(o.findings)
    .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === 'object')
    .map((f) => ({
      severity: String(f.severity ?? 'INFO'),
      detail: String(f.detail ?? ''),
      reference: f.reference == null ? undefined : String(f.reference),
    }))
    .filter((f) => f.detail.trim().length > 0);

  const nextTasks = asArray(o.next_tasks)
    .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === 'object')
    .map((t) => ({
      task_type: String(t.task_type ?? '').trim(),
      objective: String(t.objective ?? '').trim(),
      department: t.department == null ? undefined : String(t.department),
      rationale: t.rationale == null ? undefined : String(t.rationale),
    }))
    .filter((t) => t.task_type.length > 0 && t.objective.length > 0);

  if (violations.length > 0) return { valid: false, value: null, violations };

  return {
    valid: true,
    violations: [],
    value: {
      status: status as AiTaskResult['status'],
      summary,
      confidence: confidence!,
      findings,
      recommendations: asArray(o.recommendations).map(String).filter((r) => r.trim()),
      next_tasks: nextTasks,
      artifacts: asArray(o.artifacts)
        .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === 'object')
        .map((a) => ({ kind: String(a.kind ?? 'file'), ref: String(a.ref ?? '') }))
        .filter((a) => a.ref.trim()),
      usage: (o.usage as Record<string, unknown>) ?? undefined,
      provider_metadata: (o.provider_metadata as Record<string, unknown>) ?? undefined,
    },
  };
}

/**
 * Les mots qui ne portent pas l'intention.
 *
 * Sans eux, « corriger le test du resolveur » et « le resolveur : corriger son
 * test » produisent deux empreintes differentes a cause du seul mot « son » —
 * et le renvoi de balle passe. Ce sont precisement ces mots-la qui varient
 * entre deux reformulations de la meme demande.
 */
const STOPWORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou', 'son', 'sa',
  'ses', 'ce', 'cet', 'cette', 'nos', 'notre', 'leur', 'leurs', 'que', 'qui',
  'pour', 'dans', 'avec', 'sur', 'par', 'aux', 'est', 'sont', 'the', 'and',
  'for', 'with', 'its', 'their', 'this', 'that', 'from', 'into',
]);

/**
 * L'empreinte d'une intention.
 *
 * Normalisee pour que deux formulations de la meme demande se rencontrent :
 * accents retires, ponctuation effacee, mots vides ecartes, mots restants
 * tries. Le tri est le point important — « corriger le test du resolveur » et
 * « le resolveur : corriger son test » sont la meme demande, et sans tri elles
 * produiraient deux empreintes, donc deux taches, donc une chaine qui tourne.
 *
 * La cible entre dans l'empreinte : la meme correction sur deux fichiers
 * differents reste deux travaux distincts.
 */
export function taskFingerprint(input: {
  taskType: string;
  objective: string;
  target?: string | null;
}): string {
  const normalised = input.objective
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word))
    .sort()
    .join(' ');
  const material = `${input.taskType}|${targetOf(input.target)}|${normalised}`;
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/**
 * La cible, normalisee au meme endroit pour tout le monde.
 *
 * Deux appelants qui la derivent chacun de leur cote produisent deux empreintes
 * pour une meme demande — et la garde anti-doublon cesse de garder quoi que ce
 * soit. C'est arrive : la verification prealable et la creation ne calculaient
 * pas la meme chose.
 */
export function targetOf(target: string | null | undefined): string {
  return (target ?? '').trim().toLowerCase();
}

/**
 * Les commandes qu'un agent d'ingénierie a le droit de lancer.
 *
 * Une liste blanche, jamais une liste noire : on ne peut pas énumérer tout ce
 * qui est dangereux, on peut énumérer ce qui est nécessaire. Toute commande
 * absente est refusée, y compris inoffensive — c'est le prix d'une garde qui
 * ne se contourne pas par une formulation nouvelle.
 */
export const ENGINEERING_COMMAND_ALLOWLIST: readonly string[] = [
  'npm test',
  'npm run typecheck',
  'npm run build',
  'git diff',
  'git status',
  'git diff --stat',
];

export interface CommandVerdict {
  allowed: boolean;
  reason: string;
}

/**
 * Cette commande est-elle autorisée ?
 *
 * La comparaison porte sur la commande entière, normalisée sur les espaces —
 * pas sur son préfixe. Autoriser par préfixe laisserait passer
 * `npm test && rm -rf /`, ce qui est précisément la forme que prend un
 * contournement.
 */
export function checkCommand(command: string): CommandVerdict {
  const normalised = command.trim().replace(/\s+/g, ' ');

  // Les enchaînements sont refusés d'emblée : une commande autorisée suivie
  // d'une autre n'est plus la commande autorisée.
  const chaining = ['&&', '||', ';', '|', '>', '<', '`', '$('];
  const found = chaining.find((token) => normalised.includes(token));
  if (found) {
    return { allowed: false, reason: `enchaînement interdit : « ${found} »` };
  }
  if (ENGINEERING_COMMAND_ALLOWLIST.includes(normalised)) {
    return { allowed: true, reason: 'commande autorisée' };
  }
  return {
    allowed: false,
    reason:
      `« ${normalised} » n'est pas dans la liste blanche. ` +
      `Autorisées : ${ENGINEERING_COMMAND_ALLOWLIST.join(', ')}.`,
  };
}

/** Les motifs qui ne doivent jamais sortir dans un journal ni dans un résultat. */
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /Bearer\s+[A-Za-z0-9._-]{20,}/gi,
  /(?:api[_-]?key|secret|password|token)["'\s:=]+[A-Za-z0-9._-]{12,}/gi,
];

/**
 * Effacer ce qui ressemble à un secret.
 *
 * Appliqué à toute sortie de commande avant qu'elle entre dans un résultat de
 * tâche : une trace d'erreur affiche volontiers l'environnement, et un résultat
 * de tâche est conservé en base puis relu par un modèle.
 */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (acc, pattern) => acc.replace(pattern, '[secret masqué]'),
    text,
  );
}
