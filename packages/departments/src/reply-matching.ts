/**
 * À quelle entreprise appartient cette réponse ?
 *
 * La question ressemble à celle de la résolution d'identité, et elle a le même
 * piège : il existe toujours une réponse plausible. Un message venu de
 * `contact@gmail.com` peut être rapproché de n'importe qui par le nom affiché,
 * et une signature contenant « CIRMECA » peut appartenir à un fournisseur qui
 * cite CIRMECA.
 *
 * Attribuer une réponse à la mauvaise entreprise est pire que ne pas
 * l'attribuer. Une réponse non rattachée reste dans une file à relire ; une
 * réponse mal rattachée fait relancer quelqu'un qui avait dit non, et clore un
 * dossier sur la parole d'un tiers.
 *
 * Quatre pistes, de la plus contraignante à la plus faible. Aucune ne devine :
 * chacune exige une correspondance exacte sur une valeur qu'ATLAS avait déjà
 * enregistrée avant l'envoi.
 */

export type MatchMethod =
  /** Le fil de discussion, ou l'en-tête `In-Reply-To`. Le plus sûr. */
  | 'THREAD'
  /** L'adresse exacte à laquelle on avait écrit. */
  | 'OUTREACH_ADDRESS'
  /** Le domaine de l'expéditeur, comparé au domaine officiel. */
  | 'SENDER_DOMAIN'
  /** Rien de fiable. */
  | 'NONE';

export interface MatchCandidate {
  canonicalDomain: string;
  companyName: string;
  /** L'adresse ou l'URL de formulaire retenue au moment de l'envoi. */
  outreachDestination: string | null;
  /** Les identifiants de fil déjà connus pour cette entreprise. */
  knownThreadIds?: readonly string[];
  /** Les identifiants de messages déjà rattachés — cible d'un `In-Reply-To`. */
  knownMessageIds?: readonly string[];
}

export interface IncomingForMatch {
  from: string;
  to?: readonly string[];
  threadId?: string | null;
  headers?: Record<string, string>;
  /**
   * Le corps, utile pour un seul cas : un rebond cite l'adresse qui a échoué.
   * Il n'est jamais lu pour deviner un nom d'entreprise — seulement pour y
   * retrouver, à l'identique, une adresse qu'ATLAS avait notée avant l'envoi.
   */
  bodyText?: string | null;
}

export interface MatchResult {
  candidate: MatchCandidate | null;
  method: MatchMethod;
  confidence: number;
  reason: string;
  /** Les entreprises que la piste désignait aussi, quand il y en a. */
  ambiguousWith: string[];
}

/** L'adresse seule, débarrassée du nom affiché et de la casse. */
export function emailAddressOf(value: string): string {
  const angled = /<([^>]+)>/.exec(value);
  const raw = (angled?.[1] ?? value).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+$/.test(raw) ? raw : '';
}

/** Le domaine d'une adresse, sans `www.` ni sous-domaine de messagerie. */
export function domainOfAddress(value: string): string {
  const address = emailAddressOf(value);
  const host = address.split('@')[1] ?? '';
  return host.replace(/^(mail|smtp|mx|email)\./, '');
}

/**
 * Les hébergeurs de messagerie grand public.
 *
 * Une réponse venue de `gmail.com` ne dit rien de l'entreprise : rapprocher
 * par ce domaine rattacherait tous les particuliers à la même société.
 */
const SHARED_MAIL_HOSTS = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.fr', 'hotmail.com',
  'hotmail.fr', 'yahoo.com', 'yahoo.fr', 'orange.fr', 'wanadoo.fr', 'free.fr',
  'sfr.fr', 'laposte.net', 'live.fr', 'icloud.com', 'protonmail.com',
];

/** Le nom de marque d'un domaine — `groupe-reval.com` → `groupe-reval`. */
function brandRoot(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, '').split('.');
  if (parts.length >= 3 && ['co', 'com', 'org', 'net'].includes(parts[parts.length - 2]!)) {
    return parts[parts.length - 3] ?? '';
  }
  return parts.length >= 2 ? parts[parts.length - 2]! : (parts[0] ?? '');
}

const GENERIC_BRAND_TOKENS = [
  'groupe', 'group', 'france', 'holding', 'company', 'societe',
  'sa', 'sas', 'sarl', 'sasu', 'eurl', 'international', 'intl',
];

/** Deux domaines désignent-ils la même maison ? */
export function relatedDomains(a: string, b: string): boolean {
  const significant = (host: string): string[] =>
    brandRoot(host)
      .split(/[-_]/)
      .filter((token) => token.length >= 4 && !GENERIC_BRAND_TOKENS.includes(token));
  const left = significant(a);
  const right = significant(b);
  if (left.length === 0 || right.length === 0) return brandRoot(a) === brandRoot(b);
  return left.some((token) => right.includes(token));
}

export function matchIncoming(
  message: IncomingForMatch,
  candidates: readonly MatchCandidate[],
): MatchResult {
  const none = (reason: string, ambiguousWith: string[] = []): MatchResult => ({
    candidate: null,
    method: 'NONE',
    confidence: 0,
    reason,
    ambiguousWith,
  });

  // 1. Le fil. Un identifiant que nous avions déjà noté ne se confond avec
  //    rien : il vient de notre propre envoi.
  if (message.threadId) {
    const byThread = candidates.filter((c) => c.knownThreadIds?.includes(message.threadId!));
    if (byThread.length === 1) {
      return {
        candidate: byThread[0]!,
        method: 'THREAD',
        confidence: 0.98,
        reason: `fil « ${message.threadId} » déjà rattaché à ${byThread[0]!.companyName}.`,
        ambiguousWith: [],
      };
    }
    if (byThread.length > 1) {
      return none(
        'le même fil est rattaché à plusieurs entreprises : rapprochement impossible sans lecture.',
        byThread.map((c) => c.canonicalDomain),
      );
    }
  }

  const inReplyTo = (message.headers?.['in-reply-to'] ?? '').replace(/[<>]/g, '').trim();
  if (inReplyTo) {
    const byMessage = candidates.filter((c) => c.knownMessageIds?.includes(inReplyTo));
    if (byMessage.length === 1) {
      return {
        candidate: byMessage[0]!,
        method: 'THREAD',
        confidence: 0.95,
        reason: `réponse à un message déjà rattaché à ${byMessage[0]!.companyName}.`,
        ambiguousWith: [],
      };
    }
  }

  // 2. L'adresse exacte à laquelle nous avions écrit. Elle a été relevée sur
  //    le site officiel avant l'envoi : la retrouver n'est pas une devinette.
  //
  //    Un rebond arrive presque toujours d'un `mailer-daemon` hébergé chez
  //    Google ou Microsoft. Son expéditeur ne désigne donc personne, et c'est
  //    l'adresse en échec — annoncée par `X-Failed-Recipients`, ou citée dans
  //    le corps — qui identifie l'entreprise. Sans cette piste, tous les
  //    rebonds finiraient non rattachés, c'est-à-dire précisément les messages
  //    qui demandent une action.
  const failed = emailAddressOf(message.headers?.['x-failed-recipients'] ?? '');
  if (failed) {
    const byFailed = candidates.filter(
      (c) => c.outreachDestination && emailAddressOf(c.outreachDestination) === failed,
    );
    if (byFailed.length === 1) {
      return {
        candidate: byFailed[0]!,
        method: 'OUTREACH_ADDRESS',
        confidence: 0.94,
        reason: `rebond sur « ${failed} », adresse contactée pour ${byFailed[0]!.companyName}.`,
        ambiguousWith: [],
      };
    }
  }

  const sender = emailAddressOf(message.from);
  if (sender) {
    const byAddress = candidates.filter(
      (c) => c.outreachDestination && emailAddressOf(c.outreachDestination) === sender,
    );
    if (byAddress.length === 1) {
      return {
        candidate: byAddress[0]!,
        method: 'OUTREACH_ADDRESS',
        confidence: 0.92,
        reason: `« ${sender} » est l'adresse contactée pour ${byAddress[0]!.companyName}.`,
        ambiguousWith: [],
      };
    }
    if (byAddress.length > 1) {
      return none(
        `« ${sender} » a servi pour plusieurs entreprises : rapprochement ambigu.`,
        byAddress.map((c) => c.canonicalDomain),
      );
    }
  }

  // 2 bis. L'adresse contactée, citée quelque part dans le message. Le corps
  //         d'un rebond reproduit l'en-tête d'origine ; y retrouver à
  //         l'identique une adresse déjà enregistrée n'est pas une déduction.
  const haystack = `${message.bodyText ?? ''} ${(message.to ?? []).join(' ')}`.toLowerCase();
  if (haystack.trim()) {
    const quoted = candidates.filter((c) => {
      const address = c.outreachDestination ? emailAddressOf(c.outreachDestination) : '';
      return address.length > 0 && haystack.includes(address);
    });
    if (quoted.length === 1) {
      return {
        candidate: quoted[0]!,
        method: 'OUTREACH_ADDRESS',
        confidence: 0.88,
        reason:
          `le message cite « ${emailAddressOf(quoted[0]!.outreachDestination!)} », ` +
          `l'adresse contactée pour ${quoted[0]!.companyName}.`,
        ambiguousWith: [],
      };
    }
    if (quoted.length > 1) {
      return none(
        'le message cite les adresses de plusieurs entreprises suivies.',
        quoted.map((c) => c.canonicalDomain),
      );
    }
  }

  // 3. Le domaine de l'expéditeur. Plus faible : une entreprise peut répondre
  //    depuis une autre boîte, et un domaine partagé ne désigne personne.
  const senderDomain = domainOfAddress(message.from);
  if (senderDomain && !SHARED_MAIL_HOSTS.includes(senderDomain)) {
    const exact = candidates.filter((c) => c.canonicalDomain === senderDomain);
    if (exact.length === 1) {
      return {
        candidate: exact[0]!,
        method: 'SENDER_DOMAIN',
        confidence: 0.85,
        reason: `expéditeur sur le domaine officiel de ${exact[0]!.companyName}.`,
        ambiguousWith: [],
      };
    }

    const related = candidates.filter((c) => relatedDomains(senderDomain, c.canonicalDomain));
    if (related.length === 1) {
      return {
        candidate: related[0]!,
        method: 'SENDER_DOMAIN',
        confidence: 0.7,
        reason:
          `« ${senderDomain} » porte la marque de ${related[0]!.companyName} sans être son ` +
          'domaine officiel — même maison, autre extension.',
        ambiguousWith: [],
      };
    }
    if (related.length > 1) {
      return none(
        `« ${senderDomain} » correspond à plusieurs entreprises suivies.`,
        related.map((c) => c.canonicalDomain),
      );
    }
  }

  if (senderDomain && SHARED_MAIL_HOSTS.includes(senderDomain)) {
    return none(
      `expéditeur sur « ${senderDomain} », un hébergeur partagé : le domaine ne désigne aucune entreprise.`,
    );
  }

  return none('aucun fil, aucune adresse contactée, aucun domaine connu : réponse non rattachée.');
}
