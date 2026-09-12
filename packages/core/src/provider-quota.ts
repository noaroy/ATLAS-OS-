/**
 * Savoir quand un fournisseur redeviendra disponible — sans le deviner.
 *
 * La tentation, face à une limitation, est de supposer une heure de reset :
 * « minuit UTC », « dans une heure ». Ces suppositions sont fausses assez
 * souvent pour produire deux comportements également coûteux — retenter trop
 * tôt et se faire limiter davantage, ou attendre une nuit entière alors que le
 * quota était revenu en cinq minutes.
 *
 * L'ordre retenu est donc strictement décroissant en fiabilité, et chaque
 * échéance porte sa provenance. Une échéance calculée par backoff et une
 * échéance donnée par le fournisseur ne valent pas la même chose ; les
 * confondre dans un champ unique ferait perdre la seule information qui permet
 * de juger l'attente.
 */

export type ProviderState =
  | 'AVAILABLE'
  /** Limitation de débit : passagère, souvent chiffrée par le fournisseur. */
  | 'RATE_LIMITED'
  /** Quota consommé : plus long, rarement chiffré. */
  | 'QUOTA_EXHAUSTED'
  /** Notre propre plafond de dépense, pas celui du fournisseur. */
  | 'BUDGET_EXHAUSTED'
  /** Clé refusée. Aucun délai ne répare cela : il faut une personne. */
  | 'AUTH_ERROR'
  /** Répond, mal. */
  | 'DEGRADED'
  /** Jamais observé. Distinct de disponible — on ne sait pas. */
  | 'UNKNOWN';

/** D'où vient l'échéance de reprise. Sans cela, on ignore ce qu'elle vaut. */
export type RetrySource =
  | 'RETRY_AFTER'
  | 'RATE_LIMIT_HEADER'
  | 'PROVIDER_METADATA'
  | 'BACKOFF'
  | 'NONE';

export interface ProviderHealth {
  provider: string;
  state: ProviderState;
  reason: string | null;
  retryAt: string | null;
  retrySource: RetrySource;
  observedAt: string;
}

/**
 * Le palier d'attente, borné.
 *
 * Borné, parce qu'un backoff exponentiel non plafonné finit par attendre des
 * jours sur un incident de dix minutes. Le dernier palier se répète : au bout
 * d'une heure d'indisponibilité, retenter toutes les heures est raisonnable et
 * ne martèle personne.
 */
export const BACKOFF_LADDER_MS = [
  60_000,        // 1 min
  300_000,       // 5 min
  900_000,       // 15 min
  1_800_000,     // 30 min
  3_600_000,     // 60 min
] as const;

/**
 * Le délai avant la prochaine tentative, avec bruit.
 *
 * Le bruit n'est pas cosmétique : sans lui, dix tâches limitées à la même
 * seconde repartent à la même seconde, et reproduisent exactement la rafale qui
 * a déclenché la limitation. ±20 % suffisent à les étaler.
 */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const index = Math.min(Math.max(attempt, 1), BACKOFF_LADDER_MS.length) - 1;
  const base = BACKOFF_LADDER_MS[index]!;
  const jitter = base * 0.2 * (random() * 2 - 1);
  return Math.max(1_000, Math.round(base + jitter));
}

/**
 * Lit une en-tête `Retry-After`, dans ses deux formes légales.
 *
 * Rend `null` plutôt qu'une valeur par défaut quand l'en-tête est absent ou
 * illisible : c'est ce `null` qui fait descendre d'un cran dans l'ordre de
 * fiabilité, au lieu de faire passer une invention pour une donnée.
 */
/** Au-dela, un delai annonce n'est plus un delai : c'est un abandon deguise. */
const MAX_RETRY_AFTER_MS = 7 * 86_400_000;

export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds >= 0 && seconds * 1000 <= MAX_RETRY_AFTER_MS ? now + seconds * 1000 : null;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  // Le meme plafond que le chemin numerique. Sans lui, un en-tete date de
  // l'an 2999 -- malforme ou hostile -- garait une tache pour un millenaire,
  // alors qu'un `Retry-After: 99999999` etait refuse.
  const plafond = now + MAX_RETRY_AFTER_MS;
  if (date > plafond) return null;
  return date > now ? date : null;
}

/**
 * Lit une échéance de réinitialisation exposée en en-tête.
 *
 * Les fournisseurs n'ont pas de convention commune : secondes, millisecondes,
 * horodatage epoch, ou durée façon `2m30s`. On accepte ce qui est
 * interprétable sans ambiguïté et on refuse le reste.
 */
export function parseResetHeader(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();

  const duration = /^(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(trimmed);
  if (duration && (duration[1] || duration[2])) {
    const ms = Number(duration[1] ?? 0) * 60_000 + Number(duration[2] ?? 0) * 1000;
    return ms > 0 ? now + ms : null;
  }

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    // Un epoch en secondes est de l'ordre de 1e9 ; au-delà de 1e12 c'est des
    // millisecondes ; en deçà, c'est une durée relative.
    if (n > 1e12) return n > now ? n : null;
    if (n > 1e9) return n * 1000 > now ? n * 1000 : null;
    return n > 0 && n < 86_400 ? now + n * 1000 : null;
  }
  return null;
}

export interface RetryDecision {
  retryAt: string;
  source: RetrySource;
  reason: string;
}

/**
 * Quand retenter, et sur quelle base.
 *
 * L'ordre est celui de la fiabilité décroissante : ce que le fournisseur a dit,
 * puis ce qu'il a laissé entendre, puis ce que nous savons de lui, puis notre
 * propre prudence. On ne descend d'un cran que faute du précédent.
 */
export function decideRetryAt(input: {
  retryAfterHeader?: string | null;
  rateLimitResetHeader?: string | null;
  providerMetadataResetAt?: string | null;
  attempt: number;
  now?: number;
  random?: () => number;
}): RetryDecision {
  const now = input.now ?? Date.now();

  const fromRetryAfter = parseRetryAfter(input.retryAfterHeader, now);
  if (fromRetryAfter !== null) {
    return {
      retryAt: new Date(fromRetryAfter).toISOString(),
      source: 'RETRY_AFTER',
      reason: 'échéance donnée par le fournisseur',
    };
  }

  const fromReset = parseResetHeader(input.rateLimitResetHeader, now);
  if (fromReset !== null) {
    return {
      retryAt: new Date(fromReset).toISOString(),
      source: 'RATE_LIMIT_HEADER',
      reason: 'échéance lue dans les en-têtes de limitation',
    };
  }

  if (input.providerMetadataResetAt) {
    const parsed = Date.parse(input.providerMetadataResetAt);
    if (!Number.isNaN(parsed) && parsed > now) {
      return {
        retryAt: new Date(parsed).toISOString(),
        source: 'PROVIDER_METADATA',
        reason: 'échéance connue pour ce fournisseur',
      };
    }
  }

  const delay = backoffDelayMs(input.attempt, input.random);
  return {
    retryAt: new Date(now + delay).toISOString(),
    source: 'BACKOFF',
    reason: `aucune échéance annoncée : attente bornée de ${Math.round(delay / 1000)} s`,
  };
}

/**
 * Un fournisseur peut-il être appelé maintenant ?
 *
 * `UNKNOWN` autorise l'appel : ne jamais avoir observé un fournisseur n'est pas
 * une raison de ne pas l'essayer, et le premier appel est précisément ce qui
 * produira l'observation. `AUTH_ERROR` refuse sans échéance — aucune durée
 * d'attente ne répare une clé invalide, il faut quelqu'un.
 */
export function canRunProvider(
  health: ProviderHealth | null,
  now = Date.now(),
): { allowed: boolean; reason: string; retryAt: string | null } {
  if (!health || health.state === 'UNKNOWN') {
    return { allowed: true, reason: 'jamais observé : on essaie', retryAt: null };
  }
  if (health.state === 'AVAILABLE') {
    return { allowed: true, reason: 'disponible', retryAt: null };
  }
  if (health.state === 'AUTH_ERROR') {
    return {
      allowed: false,
      reason: 'authentification refusée : aucune attente ne corrige cela, une personne le doit',
      retryAt: null,
    };
  }
  if (health.state === 'DEGRADED') {
    return { allowed: true, reason: 'dégradé : on essaie, en surveillant', retryAt: health.retryAt };
  }
  if (!health.retryAt) {
    return {
      allowed: false,
      reason: `${health.state} sans échéance connue`,
      retryAt: null,
    };
  }
  const due = Date.parse(health.retryAt);
  if (Number.isNaN(due) || due <= now) {
    return {
      allowed: true,
      reason: `échéance du ${health.retryAt} atteinte : on retente`,
      retryAt: health.retryAt,
    };
  }
  return {
    allowed: false,
    reason: `${health.state} jusqu'au ${health.retryAt}`,
    retryAt: health.retryAt,
  };
}

// --- Budget ----------------------------------------------------------------

export type BudgetMode = 'UNLIMITED' | 'CONFIGURED' | 'DISABLED';

export interface BudgetVerdict {
  allowed: boolean;
  mode: BudgetMode;
  reason: string;
}

/**
 * Le budget, avec ses trois modes explicites.
 *
 * `UNLIMITED` et `DISABLED` ne se confondent pas : le premier dit qu'aucun
 * plafond n'a été fixé, le second qu'on a délibérément coupé la dépense. Les
 * afficher pareil ferait lire « pas de limite » là où il y a « rien ne passe ».
 *
 * Un dépassement ne produit jamais un échec : la tâche est mise en pause, elle
 * repartira quand la fenêtre budgétaire se rouvrira.
 */
export function checkBudget(input: {
  mode: BudgetMode;
  dailySpentUsd?: number;
  dailyLimitUsd?: number | null;
  monthlySpentUsd?: number;
  monthlyLimitUsd?: number | null;
  taskCostUsd?: number | null;
  maxTaskCostUsd?: number | null;
}): BudgetVerdict {
  if (input.mode === 'DISABLED') {
    return { allowed: false, mode: 'DISABLED', reason: 'dépense IA coupée par configuration' };
  }
  if (input.mode === 'UNLIMITED') {
    return { allowed: true, mode: 'UNLIMITED', reason: 'aucun plafond configuré' };
  }

  const anyLimit = input.maxTaskCostUsd != null
    || input.dailyLimitUsd != null
    || input.monthlyLimitUsd != null;

  /**
   * Un coût inconnu n'est pas un coût nul.
   *
   * `taskCostUsd: null` veut dire « le tarif de ce modèle n'est pas connu »,
   * `undefined` veut dire « aucun coût de tâche à vérifier ici ». Les
   * confondre — ce que faisait `?? 0` — rendait « sous les plafonds » pour un
   * appel dont personne ne pouvait chiffrer la dépense : le plafond existait,
   * s'affichait, et ne protégeait rien.
   *
   * Le refus n'a lieu que si un plafond est réellement actif : sans plafond, il
   * n'y a rien à vérifier, et bloquer serait gratuit.
   */
  if (input.taskCostUsd === null && anyLimit) {
    return {
      allowed: false,
      mode: 'CONFIGURED',
      reason:
        'tarif du modèle inconnu : la dépense n’est pas calculable, '
        + 'et un plafond ne peut pas être vérifié contre un montant inconnu',
    };
  }

  const cost = input.taskCostUsd ?? 0;
  if (input.maxTaskCostUsd != null && cost > input.maxTaskCostUsd) {
    return {
      allowed: false,
      mode: 'CONFIGURED',
      reason: `coût estimé ${cost.toFixed(4)} $ au-dessus du plafond par tâche ${input.maxTaskCostUsd} $`,
    };
  }
  if (input.dailyLimitUsd != null && (input.dailySpentUsd ?? 0) + cost > input.dailyLimitUsd) {
    return {
      allowed: false,
      mode: 'CONFIGURED',
      reason: `plafond journalier ${input.dailyLimitUsd} $ atteint`,
    };
  }
  if (input.monthlyLimitUsd != null && (input.monthlySpentUsd ?? 0) + cost > input.monthlyLimitUsd) {
    return {
      allowed: false,
      mode: 'CONFIGURED',
      reason: `plafond mensuel ${input.monthlyLimitUsd} $ atteint`,
    };
  }
  return { allowed: true, mode: 'CONFIGURED', reason: 'sous les plafonds' };
}
