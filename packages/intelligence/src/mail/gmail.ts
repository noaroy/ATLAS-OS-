import { withDeadline, describeError } from '@atlas/core';
import type { Logger } from '@atlas/core';
import { USEFUL_HEADERS, type MailInboxProvider, type MailMessage, type MailProviderStatus, type MailQuery } from './types.ts';

/**
 * Lire une boîte Gmail, et rien d'autre.
 *
 * Ce fichier ne contient aucun appel qui modifie quoi que ce soit : ni envoi,
 * ni brouillon, ni libellé, ni corbeille. Ce n'est pas une intention, c'est
 * une propriété vérifiable — un test lit ce source et refuse tout verbe HTTP
 * autre que GET, ainsi que les chemins `send`, `drafts`, `modify` et `trash`.
 * Une garde qui se contente d'être promise finit par être oubliée.
 *
 * La portée demandée est `gmail.readonly`. Elle est déclarée ici pour qu'un
 * lecteur la voie sans aller chercher la console Google, et vérifiée à
 * l'exécution : un jeton porteur d'une portée plus large est refusé, parce
 * qu'un accès qu'on n'a pas voulu est un accès qu'on finira par utiliser.
 *
 * Aucun secret ne vit dans le dépôt. Tout vient de l'environnement, et rien
 * de ce qui en sort n'est journalisé — pas même tronqué.
 */

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** La seule portée acceptable. Toute autre est refusée à l'exécution. */
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

export interface GmailCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** L'adresse de la boîte lue. Sert au rapprochement, pas à l'envoi. */
  userId: string;
}

/**
 * Lit la configuration depuis l'environnement, ou dit précisément ce qui
 * manque.
 *
 * Ne jette pas : une messagerie non configurée est une situation normale, et
 * un script de synchronisation doit pouvoir l'annoncer proprement plutôt que
 * s'interrompre sur une pile d'appels.
 */
export function gmailCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { credentials: GmailCredentials | null; status: MailProviderStatus } {
  const required = {
    GMAIL_CLIENT_ID: env.GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET: env.GMAIL_CLIENT_SECRET,
    GMAIL_REFRESH_TOKEN: env.GMAIL_REFRESH_TOKEN,
    GMAIL_USER: env.GMAIL_USER,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value?.trim())
    .map(([name]) => name);

  if (missing.length > 0) {
    return {
      credentials: null,
      status: {
        configured: false,
        code: 'GMAIL_NOT_CONFIGURED',
        // Les noms des variables, jamais leurs valeurs.
        detail: `variable(s) absente(s) : ${missing.join(', ')}`,
        scopes: [GMAIL_READONLY_SCOPE],
      },
    };
  }

  return {
    credentials: {
      clientId: required.GMAIL_CLIENT_ID!,
      clientSecret: required.GMAIL_CLIENT_SECRET!,
      refreshToken: required.GMAIL_REFRESH_TOKEN!,
      userId: required.GMAIL_USER!,
    },
    status: {
      configured: true,
      code: 'GMAIL_READY',
      detail: `boîte ${required.GMAIL_USER}`,
      scopes: [GMAIL_READONLY_SCOPE],
    },
  };
}

export interface GmailProviderOptions {
  logger: Logger;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export class GmailInboxProvider implements MailInboxProvider {
  readonly id = 'gmail';

  private readonly credentials: GmailCredentials | null;
  private readonly configStatus: MailProviderStatus;
  private readonly timeoutMs: number;
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(private readonly options: GmailProviderOptions) {
    const { credentials, status } = gmailCredentialsFromEnv(options.env);
    this.credentials = credentials;
    this.configStatus = status;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  status(): MailProviderStatus {
    return this.configStatus;
  }

  /**
   * Échange le jeton de rafraîchissement contre un jeton d'accès.
   *
   * La réponse annonce les portées obtenues. Si Google en accorde d'autres que
   * la lecture — parce que le consentement initial était plus large — l'échange
   * est refusé ici. Le fichier ne peut certes pas écrire, mais un jeton
   * d'écriture qui circule finira par être passé ailleurs.
   */
  private async token(): Promise<string> {
    if (!this.credentials) {
      throw new Error(`GMAIL_NOT_CONFIGURED — ${this.configStatus.detail}`);
    }
    const now = Date.now();
    if (this.accessToken && this.accessToken.expiresAt > now + 30_000) {
      return this.accessToken.value;
    }

    const body = new URLSearchParams({
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      refresh_token: this.credentials.refreshToken,
      grant_type: 'refresh_token',
    });

    const response = await withDeadline(
      (signal) =>
        fetch(OAUTH_TOKEN_URL, {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
        }),
      { ms: this.timeoutMs, label: 'gmail token' },
    );

    if (!response.ok) {
      // Le corps d'une erreur OAuth peut contenir des fragments de secret.
      throw new Error(`échange de jeton refusé (HTTP ${response.status})`);
    }
    const payload = (await response.json()) as {
      access_token?: string; expires_in?: number; scope?: string;
    };
    if (!payload.access_token) throw new Error('réponse OAuth sans jeton d’accès');

    const granted = (payload.scope ?? '').split(/\s+/).filter(Boolean);
    const extra = granted.filter((scope) => scope !== GMAIL_READONLY_SCOPE);
    if (extra.length > 0) {
      throw new Error(
        `jeton trop large : ${extra.join(', ')}. ATLAS n'accepte que ${GMAIL_READONLY_SCOPE} — ` +
          'régénérez un consentement en lecture seule.',
      );
    }

    this.accessToken = {
      value: payload.access_token,
      expiresAt: now + (payload.expires_in ?? 3600) * 1000,
    };
    return this.accessToken.value;
  }

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const token = await this.token();
    const url = new URL(`${GMAIL_API}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const response = await withDeadline(
      (signal) =>
        fetch(url, {
          method: 'GET',
          signal,
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        }),
      { ms: this.timeoutMs, label: `gmail ${path}` },
    );
    if (!response.ok) throw new Error(`Gmail a répondu HTTP ${response.status} sur ${path}`);
    return (await response.json()) as T;
  }

  async list(query: MailQuery = {}): Promise<MailMessage[]> {
    if (!this.credentials) {
      throw new Error(`GMAIL_NOT_CONFIGURED — ${this.configStatus.detail}`);
    }
    const max = Math.min(query.max ?? 50, 200);
    const filters = [query.rawFilter, query.since ? `after:${query.since.slice(0, 10).replace(/-/g, '/')}` : null]
      .filter(Boolean)
      .join(' ');

    const listing = await this.get<{ messages?: Array<{ id: string; threadId: string }> }>(
      `/users/${encodeURIComponent(this.credentials.userId)}/messages`,
      { maxResults: String(max), ...(filters ? { q: filters } : {}) },
    );

    const messages: MailMessage[] = [];
    for (const stub of listing.messages ?? []) {
      try {
        messages.push(await this.fetchMessage(stub.id));
      } catch (err) {
        // Un message illisible ne doit pas interrompre la synchronisation :
        // les autres réponses attendent, et l'échec est nommé.
        this.options.logger.warn('message Gmail non lu', {
          messageId: stub.id,
          error: describeError(err),
        });
      }
    }
    return messages;
  }

  private async fetchMessage(messageId: string): Promise<MailMessage> {
    const raw = await this.get<GmailMessage>(
      `/users/${encodeURIComponent(this.credentials!.userId)}/messages/${encodeURIComponent(messageId)}`,
      { format: 'full' },
    );

    const headers: Record<string, string> = {};
    for (const header of raw.payload?.headers ?? []) {
      const name = header.name.toLowerCase();
      if (USEFUL_HEADERS.includes(name as (typeof USEFUL_HEADERS)[number])) {
        headers[name] = header.value;
      }
    }
    const headerOf = (name: string): string | null =>
      raw.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? null;

    return {
      messageId: raw.id,
      threadId: raw.threadId ?? null,
      from: headerOf('from') ?? '',
      to: (headerOf('to') ?? '').split(',').map((a) => a.trim()).filter(Boolean),
      subject: headerOf('subject'),
      receivedAt: raw.internalDate
        ? new Date(Number(raw.internalDate)).toISOString()
        : new Date().toISOString(),
      bodyText: extractPlainText(raw.payload),
      snippet: raw.snippet ?? null,
      headers,
    };
  }
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
  headers?: Array<{ name: string; value: string }>;
}

interface GmailMessage {
  id: string;
  threadId?: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart;
}

/**
 * Le texte brut d'un message, quand il y en a un.
 *
 * On ne descend pas dans le HTML : un corps HTML converti approximativement
 * introduit des mots qui n'y étaient pas, et ces mots servent ensuite à
 * classer la réponse.
 */
export function extractPlainText(part: GmailPart | undefined, depth = 0): string | null {
  if (!part || depth > 8) return null;
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8');
  }
  for (const child of part.parts ?? []) {
    const found = extractPlainText(child, depth + 1);
    if (found) return found;
  }
  return null;
}
