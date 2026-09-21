/**
 * Un fournisseur de modèle, vu comme une unité d'exécution bornée.
 *
 * La distinction qui tient tout ce fichier : **le fournisseur n'est pas le
 * rôle**. `ANTHROPIC` n'est pas « l'ingénieur » et `OPENAI` n'est pas « le
 * relecteur » — ce sont deux façons d'appeler un modèle, et le rôle est décidé
 * ailleurs, par le routeur. Les confondre reviendrait à ce que changer de
 * fournisseur pour une tâche demande de réécrire le worker qui la traite.
 *
 * Trois responsabilités, pas une :
 *
 * 1. `execute` — l'appel lui-même, borné par un délai.
 * 2. `parseUsage` — ce qui a été consommé, et ce qu'on peut en dire du prix.
 *    Les jetons peuvent être connus alors que le tarif ne l'est pas ; les deux
 *    ne se déduisent pas l'un de l'autre et ne se rangent pas dans le même
 *    champ.
 * 3. `classifyError` — traduire un échec en décision. C'est le point le plus
 *    délicat : un `429` et un `401` se ressemblent dans un journal et
 *    demandent des réactions opposées — attendre pour l'un, réveiller quelqu'un
 *    pour l'autre.
 */

export type AiProviderName = 'OPENAI' | 'ANTHROPIC';

/** Ce qu'un worker sait faire, indépendamment de qui l'exécute. */
export type AiCapability =
  | 'REASONING'
  | 'REVIEW'
  | 'COMMERCIAL_ANALYSIS'
  | 'AMBIGUITY_RESOLUTION'
  | 'PLANNING'
  | 'STRUCTURED_EXTRACTION'
  | 'ENGINEERING'
  | 'DEBUGGING'
  | 'REPO_ANALYSIS'
  | 'TESTING'
  | 'BUILD_VALIDATION'
  | 'CODE_REVIEW'
  | 'REFACTOR';

export interface AiRequest {
  system: string;
  prompt: string;
  /** Le schéma attendu en sortie, quand la réponse doit être structurée. */
  responseSchema?: Record<string, unknown>;
  maxOutputTokens: number;
  timeoutMs: number;
  capability: AiCapability;
  /**
   * Une clé stable pour cet appel précis.
   *
   * Les deux fournisseurs acceptent une en-tête d'idempotence. Elle ne remplace
   * pas la réservation locale — un appel de modèle coûte au moment où il part,
   * pas au moment où on le consigne — mais elle évite qu'un retour réseau raté
   * suivi d'un retry soit facturé deux fois.
   */
  idempotencyKey?: string;
  /**
   * L'effort de raisonnement demandé, pour les modèles qui en consomment une
   * part cachée du budget de sortie (GPT-5, séries o). Absent par défaut :
   * aucun appel existant ne change de comportement tant qu'il ne le fixe pas
   * explicitement. Un fournisseur qui n'a pas cette notion l'ignore.
   */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** `null` quand le tarif du modèle n'est pas connu du code. */
  costUsd: number | null;
  /** D'où vient le coût — ou pourquoi il manque. */
  costBasis: 'KNOWN' | 'UNKNOWN_PRICE' | 'SIMULATED';
}

export interface AiResponse {
  text: string;
  /** Le JSON extrait, quand un schéma était demandé et que la sortie en porte. */
  structured: Record<string, unknown> | null;
  usage: AiUsage;
  model: string;
  provider: AiProviderName;
  durationMs: number;
  /**
   * Vrai quand le fournisseur a coupé la réponse avant sa fin naturelle —
   * `finish_reason: "length"` côté OpenAI, `stop_reason: "max_tokens"` côté
   * Anthropic. Une sortie tronquée sans JSON exploitable n'est pas la même
   * panne qu'un modèle qui a simplement mal répondu : la première se corrige
   * en donnant plus de budget ou moins de raisonnement, la seconde non.
   */
  truncated: boolean;
}

/**
 * La nature d'un échec, traduite en ce qu'il faut en faire.
 *
 * Chaque valeur correspond à une réaction distincte du daemon, et c'est la
 * seule raison pour laquelle elles sont distinguées.
 */
export type AiErrorKind =
  /** Limitation passagère : la tâche attend, elle ne perd pas de tentative. */
  | 'RATE_LIMITED'
  /** Quota consommé : plus long, même traitement. */
  | 'QUOTA_EXHAUSTED'
  /** Clé refusée. Aucune attente ne répare cela — il faut quelqu'un. */
  | 'AUTH_ERROR'
  /** Le fournisseur répond mal : on retentera. */
  | 'SERVER_ERROR'
  /** Le délai a été dépassé. */
  | 'TIMEOUT'
  /** La demande est mauvaise : réessayer à l'identique ne servirait à rien. */
  | 'BAD_REQUEST'
  | 'UNKNOWN';

export interface AiErrorVerdict {
  kind: AiErrorKind;
  /** Retenter à l'identique a-t-il une chance d'aboutir ? */
  retryable: boolean;
  /** L'échéance annoncée par le fournisseur, telle quelle. */
  retryAfterHeader: string | null;
  rateLimitResetHeader: string | null;
  message: string;
}

export interface AiProviderStatus {
  configured: boolean;
  code: string;
  /** Ce qui manque, nommé. Jamais la valeur d'un secret. */
  detail: string;
}

export interface AiProvider {
  readonly provider: AiProviderName;
  readonly model: string;
  status(): AiProviderStatus;
  execute(request: AiRequest): Promise<AiResponse>;
  classifyError(error: unknown): AiErrorVerdict;
}

/**
 * Les marqueurs qui distinguent une limitation d'un refus d'authentification.
 *
 * Cherchés dans le texte parce que les deux fournisseurs n'utilisent pas les
 * mêmes codes ni les mêmes formulations, et qu'un statut HTTP seul ne suffit
 * pas toujours — certaines limitations arrivent en `400` avec un message.
 */
const QUOTA_MARKERS = [
  'quota', 'insufficient_quota', 'usage limit', 'usage cap', 'credit balance',
  'billing hard limit', 'exceeded your current quota',
];
const RATE_MARKERS = [
  'rate limit', 'rate_limit', 'too many requests', 'overloaded',
  'capacity', 'try again later',
];
const AUTH_MARKERS = [
  'invalid api key', 'invalid_api_key', 'incorrect api key', 'unauthorized',
  'authentication', 'permission_denied', 'revoked',
];

/**
 * La classification partagée par les deux fournisseurs.
 *
 * Écrite une fois : deux implémentations divergeraient, et la divergence se
 * verrait le jour où l'un des deux traiterait un `429` comme un échec définitif.
 */
export function classifyAiError(input: {
  status?: number | null;
  message: string;
  headers?: Record<string, string> | null;
}): AiErrorVerdict {
  const text = input.message.toLowerCase();
  const headers = input.headers ?? {};
  const retryAfter = headers['retry-after'] ?? null;
  const reset =
    headers['x-ratelimit-reset-requests']
    ?? headers['x-ratelimit-reset-tokens']
    ?? headers['anthropic-ratelimit-requests-reset']
    ?? headers['ratelimit-reset']
    ?? null;

  const base = { retryAfterHeader: retryAfter, rateLimitResetHeader: reset, message: input.message };

  // L'authentification d'abord : un 401 accompagné du mot « limit » dans un
  // message générique ne doit pas être pris pour une limitation, sinon la
  // tâche attend indéfiniment une clé qui ne reviendra pas seule.
  if (input.status === 401 || input.status === 403 || AUTH_MARKERS.some((m) => text.includes(m))) {
    return { ...base, kind: 'AUTH_ERROR', retryable: false };
  }
  if (QUOTA_MARKERS.some((m) => text.includes(m))) {
    return { ...base, kind: 'QUOTA_EXHAUSTED', retryable: true };
  }
  if (input.status === 429 || RATE_MARKERS.some((m) => text.includes(m))) {
    return { ...base, kind: 'RATE_LIMITED', retryable: true };
  }
  if (text.includes('timeout') || text.includes('aborted') || input.status === 408) {
    return { ...base, kind: 'TIMEOUT', retryable: true };
  }
  if (input.status != null && input.status >= 500) {
    return { ...base, kind: 'SERVER_ERROR', retryable: true };
  }
  if (input.status != null && input.status >= 400) {
    return { ...base, kind: 'BAD_REQUEST', retryable: false };
  }
  return { ...base, kind: 'UNKNOWN', retryable: false };
}

/**
 * Extrait le JSON d'une réponse, quel que soit l'emballage.
 *
 * Les modèles encadrent volontiers leur JSON de texte ou de balises de bloc.
 * Rendre `null` plutôt que de deviner : une sortie qu'on n'a pas su lire doit
 * faire échouer la validation de schéma, pas produire un objet approximatif
 * qui traverserait le reste du système sans qu'on s'en aperçoive.
 */
export function extractJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidates = [fenced?.[1], trimmed].filter((v): v is string => Boolean(v));

  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // On essaie le candidat suivant.
    }
  }
  return null;
}
