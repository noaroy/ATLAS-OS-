/**
 * L'envoi, derrière une abstraction — et derrière un refus par défaut.
 *
 * Le module de lecture n'expose volontairement aucune méthode d'envoi : ce qui
 * n'existe pas ne peut pas être appelé par erreur. Cette séparation est
 * conservée ici. L'envoi vit dans son propre fichier, avec sa propre porte, et
 * la porte est fermée tant que personne ne l'a ouverte explicitement.
 *
 * Deux raisons, pas une :
 *
 * 1. Le jeton Google détenu par ce déploiement porte la seule portée
 *    `gmail.readonly`. Un envoi échouerait de toute façon, mais il échouerait
 *    tard, après avoir réservé une place d'envoi — donc en bloquant le message
 *    au lieu de le refuser proprement.
 * 2. Élargir une portée OAuth est une décision qui appartient au propriétaire
 *    de la boîte. ATLAS ne la demande pas de lui-même, et ne la contourne pas.
 *
 * Le transport est écrit et complet. Ce n'est pas une contradiction : le jour
 * où la portée sera accordée, il ne devra pas rester de code à improviser sous
 * la pression d'un premier envoi réel. La porte et le moteur sont deux pièces
 * distinctes, et seule la porte demande une décision humaine.
 */
import { withDeadline } from '@atlas/core';
import {
  ACCEPTED_GMAIL_SCOPES, scopesInExcess, type MailProviderStatus,
} from './types.ts';

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface OutboundMessage {
  to: string;
  subject: string;
  bodyText: string;
  /** Présent pour une réponse : le fil auquel se rattacher. */
  threadId?: string | null;
  /** L'en-tête `In-Reply-To`, quand on répond à un message précis. */
  inReplyTo?: string | null;
}

export interface SendReceipt {
  /** Identifiant rendu par le fournisseur. Persisté, il rend l'envoi traçable. */
  externalMessageId: string;
  externalThreadId: string | null;
  sentAt: string;
  /** Le fournisseur qui a réellement traité l'envoi. */
  provider: string;
  /** Vrai quand rien n'est parti : simulation, ou porte fermée. */
  simulated: boolean;
}

/**
 * Ce qu'ATLAS attend d'un expéditeur.
 *
 * `replyToThread` n'est pas un `sendEmail` avec un argument de plus : une
 * réponse qui perd son fil devient un message isolé, et le rapprochement des
 * réponses suivantes se fait alors sur l'adresse au lieu du fil — la voie la
 * moins fiable des quatre.
 */
export interface MailOutboundProvider {
  readonly id: string;
  status(): MailProviderStatus;
  sendEmail(message: OutboundMessage): Promise<SendReceipt>;
  replyToThread(message: OutboundMessage & { threadId: string }): Promise<SendReceipt>;
}

export class OutboundNotAuthorisedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OutboundNotAuthorisedError';
    this.code = code;
  }
}

/**
 * L'expéditeur de développement : il consigne, il ne poste rien.
 *
 * Ce n'est pas un bouchon de test. C'est le fournisseur par défaut du système,
 * celui qui permet de dérouler la boucle entière — réservation, envoi,
 * événement, attente de réponse — sans qu'un inconnu reçoive quoi que ce soit
 * pendant qu'on la construit.
 */
export class DryRunOutboundProvider implements MailOutboundProvider {
  readonly id = 'dry-run';
  private counter = 0;
  readonly sent: Array<OutboundMessage & { at: string }> = [];

  status(): MailProviderStatus {
    return {
      configured: true,
      code: 'DRY_RUN_READY',
      detail: 'aucun message ne quitte la machine : les envois sont consignés localement.',
      scopes: [],
    };
  }

  async sendEmail(message: OutboundMessage): Promise<SendReceipt> {
    this.counter += 1;
    const at = new Date().toISOString();
    this.sent.push({ ...message, at });
    return {
      externalMessageId: `dry-run-${this.counter}`,
      externalThreadId: message.threadId ?? null,
      sentAt: at,
      provider: this.id,
      simulated: true,
    };
  }

  async replyToThread(message: OutboundMessage & { threadId: string }): Promise<SendReceipt> {
    return this.sendEmail(message);
  }
}

export interface GmailOutboundOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /**
   * Les portées réellement accordées au jeton.
   *
   * Passées explicitement plutôt que devinées : le seul moyen de les connaître
   * est d'échanger le jeton, et cet échange ne doit pas avoir lieu pour
   * découvrir qu'on n'avait pas le droit de l'appeler.
   */
  grantedScopes?: readonly string[];
}

/**
 * Le RFC 5322 minimal dont Gmail a besoin, encodé pour l'API.
 *
 * Le sujet passe en `=?UTF-8?B?…?=` : un accent envoyé brut dans un en-tête
 * ressort en caractères de remplacement chez la moitié des destinataires, et
 * un premier message qui s'affiche mal a déjà perdu.
 */
export function encodeRfc822(message: OutboundMessage, from: string): string {
  const subject = `=?UTF-8?B?${Buffer.from(message.subject, 'utf8').toString('base64')}?=`;
  const headers = [
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  if (message.inReplyTo) {
    headers.push(`In-Reply-To: ${message.inReplyTo}`, `References: ${message.inReplyTo}`);
  }
  const body = Buffer.from(message.bodyText, 'utf8').toString('base64');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

/** Base64 « URL-safe », la seule forme que l'API Gmail accepte pour `raw`. */
export function base64Url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * L'expéditeur Gmail : transport complet, porte fermée.
 *
 * `assertAuthorised` est appelée en premier dans les deux méthodes d'envoi, et
 * avant tout accès réseau. C'est délibéré : un refus doit survenir avant la
 * réservation d'une place d'envoi, sinon un message se retrouve bloqué —
 * réservé, jamais parti, et impossible à reprendre sans décision humaine.
 */
export class GmailOutboundProvider implements MailOutboundProvider {
  readonly id = 'gmail';
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly grantedScopes: readonly string[];
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(options: GmailOutboundOptions = {}) {
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.grantedScopes = options.grantedScopes ?? [];
  }

  /**
   * Ce que le vrai jeton porte, constate et non suppose.
   *
   * `null` tant que personne n'a demande. C'est la nuance qui manquait : la
   * version precedente partait d'une liste vide et en concluait « portee
   * absente », si bien que le controle annoncait GMAIL_SEND_SCOPE_MISSING
   * quelle que soit la realite — un verdict code en dur, pas une observation.
   * La portee a ete accordee, et le controle a continue de dire non.
   */
  private discovered: readonly string[] | null = null;

  /**
   * Interroger le jeton reel, sans rien envoyer.
   *
   * Un echange de jeton de rafraichissement vers `oauth2.googleapis.com` : la
   * reponse porte les portees reellement accordees. Aucune requete vers Gmail,
   * aucun message, aucun brouillon — c'est exactement ce que fait deja la
   * verification de lecture.
   */
  async verifyScopes(): Promise<{ granted: readonly string[]; canSend: boolean } | null> {
    if (!this.credentials()) return null;
    await this.token();
    const granted = this.discovered ?? [];
    return { granted, canSend: granted.includes(GMAIL_SEND_SCOPE) };
  }

  private authorised(): boolean {
    // Une liste passee au constructeur fait autorite — les tests s'en servent
    // pour decrire un jeton sans reseau. Sinon, ce qu'on a constate.
    const known = this.grantedScopes.length > 0 ? this.grantedScopes : this.discovered;
    return known !== null && known.includes(GMAIL_SEND_SCOPE);
  }

  private credentials(): {
    clientId: string; clientSecret: string; refreshToken: string; user: string;
  } | null {
    const clientId = this.env.GMAIL_CLIENT_ID?.trim();
    const clientSecret = this.env.GMAIL_CLIENT_SECRET?.trim();
    const refreshToken = this.env.GMAIL_REFRESH_TOKEN?.trim();
    const user = this.env.GMAIL_USER?.trim();
    if (!clientId || !clientSecret || !refreshToken || !user) return null;
    return { clientId, clientSecret, refreshToken, user };
  }

  /**
   * L'interrupteur general, lu a la source.
   *
   * `ATLAS_OUTBOUND_ENABLED` est deja verifie par la politique d'envoi du
   * moteur commercial. Il l'est aussi ICI, dans le transport, pour qu'aucun
   * chemin — un script lance a la main, une route ajoutee plus tard, une
   * tache restee en file avant un redemarrage — ne puisse poster tant que le
   * proprietaire n'a pas leve l'interrupteur. Deux gardes independantes
   * valent mieux qu'une garde parfaite.
   */
  private outboundEnabled(): boolean {
    return /^(1|true|yes|on)$/i.test((this.env.ATLAS_OUTBOUND_ENABLED ?? '').trim());
  }

  status(): MailProviderStatus {
    if (!this.outboundEnabled()) {
      return {
        configured: false,
        code: 'OUTBOUND_DISABLED',
        detail: 'ATLAS_OUTBOUND_ENABLED n’est pas vrai : aucun message réel ne part, quel que soit le chemin.',
        scopes: this.grantedScopes,
      };
    }
    if (!this.authorised()) {
      const jamaisRegarde = this.grantedScopes.length === 0 && this.discovered === null;
      return {
        configured: false,
        // « Pas encore verifie » n'est pas « refuse ». Les confondre faisait
        // annoncer une portee manquante alors qu'elle etait accordee, et que
        // personne n'avait simplement pose la question.
        code: jamaisRegarde ? 'GMAIL_SEND_SCOPE_UNVERIFIED' : 'GMAIL_SEND_SCOPE_MISSING',
        detail:
          `le jeton courant ne porte pas ${GMAIL_SEND_SCOPE}. ` +
          'Cette portée doit être accordée explicitement par le propriétaire de la boîte ; ' +
          'ATLAS ne la demande pas de lui-même.',
        scopes: this.grantedScopes,
      };
    }
    return this.credentials()
      ? {
          configured: true,
          code: 'GMAIL_SEND_READY',
          detail: 'portée d’envoi accordée et identifiants présents.',
          scopes: [GMAIL_SEND_SCOPE],
        }
      : {
          configured: false,
          code: 'GMAIL_NOT_CONFIGURED',
          detail:
            'portée accordée, mais identifiants absents : ' +
            'GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_USER.',
          scopes: [GMAIL_SEND_SCOPE],
        };
  }

  /**
   * Le refus, toujours au même endroit et toujours avant le réseau.
   *
   * Aucun repli silencieux : ni bascule vers la simulation, ni retour d'un
   * accusé factice. Un envoi qui ne peut pas avoir lieu doit interrompre
   * l'appelant, pas lui laisser croire qu'il a eu lieu.
   */
  private assertAuthorised(): void {
    if (!this.outboundEnabled()) {
      throw new OutboundNotAuthorisedError(
        'OUTBOUND_DISABLED',
        'envoi refusé : ATLAS_OUTBOUND_ENABLED n’est pas vrai — le transport n’envoie rien.',
      );
    }
    if (!this.authorised()) {
      throw new OutboundNotAuthorisedError(
        'GMAIL_SEND_SCOPE_MISSING',
        `envoi refusé : ${GMAIL_SEND_SCOPE} n’a pas été accordée.`,
      );
    }
    if (!this.credentials()) {
      throw new OutboundNotAuthorisedError(
        'GMAIL_NOT_CONFIGURED',
        'envoi refusé : identifiants Gmail absents de l’environnement.',
      );
    }
  }

  /**
   * Échange le jeton de rafraîchissement, en refusant une portée inattendue.
   *
   * Le miroir de ce que fait la lecture : là-bas on refuse tout ce qui dépasse
   * la lecture, ici on refuse tout ce qui dépasse l'envoi. Un jeton plus large
   * que nécessaire finit toujours par être utilisé pour autre chose.
   */
  private async token(): Promise<string> {
    const credentials = this.credentials()!;
    const now = Date.now();
    if (this.accessToken && this.accessToken.expiresAt > now + 30_000) {
      return this.accessToken.value;
    }

    const response = await withDeadline(
      (signal) =>
        fetch(OAUTH_TOKEN_URL, {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
            refresh_token: credentials.refreshToken,
            grant_type: 'refresh_token',
          }),
        }),
      { ms: this.timeoutMs, label: 'gmail send token' },
    );

    if (!response.ok) {
      // Le corps d'une erreur OAuth peut contenir des fragments de secret.
      throw new Error(`échange de jeton refusé (HTTP ${response.status})`);
    }
    const payload = (await response.json()) as {
      access_token?: string; expires_in?: number; scope?: string;
    };
    if (!payload.access_token) throw new Error('réponse OAuth sans jeton d’accès');

    // Le meme jeton sert a lire et a envoyer : refuser ici tout ce qui depasse
    // l'envoi rendait l'envoi impossible des lors que la lecture etait accordee.
    const granted = (payload.scope ?? '').split(/\s+/).filter(Boolean);
    const unexpected = scopesInExcess(granted);
    if (unexpected.length > 0) {
      throw new OutboundNotAuthorisedError(
        'GMAIL_SCOPE_TOO_BROAD',
        `jeton trop large : ${unexpected.join(', ')}. `
          + `ATLAS n'accepte que ${ACCEPTED_GMAIL_SCOPES.join(' et ')}.`,
      );
    }
    this.discovered = granted;

    this.accessToken = {
      value: payload.access_token,
      expiresAt: now + (payload.expires_in ?? 3600) * 1000,
    };
    return this.accessToken.value;
  }

  private async post(message: OutboundMessage): Promise<SendReceipt> {
    this.assertAuthorised();
    const credentials = this.credentials()!;
    const token = await this.token();

    const raw = base64Url(encodeRfc822(message, credentials.user));
    const payload: Record<string, string> = { raw };
    if (message.threadId) payload.threadId = message.threadId;

    const response = await withDeadline(
      (signal) =>
        fetch(`${GMAIL_API}/users/me/messages/send`, {
          method: 'POST',
          signal,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
        }),
      { ms: this.timeoutMs, label: 'gmail send' },
    );

    if (!response.ok) {
      // L'échec est remonté tel quel : l'appelant consigne FAILED, et la place
      // réservée reste prise. Ne pas réessayer ici est le point : un retry
      // automatique sur un envoi partiellement abouti est précisément la façon
      // d'envoyer deux fois.
      throw new Error(`envoi refusé par Gmail (HTTP ${response.status})`);
    }

    const sent = (await response.json()) as { id?: string; threadId?: string };
    if (!sent.id) throw new Error('réponse Gmail sans identifiant de message');

    return {
      externalMessageId: sent.id,
      externalThreadId: sent.threadId ?? message.threadId ?? null,
      sentAt: new Date().toISOString(),
      provider: this.id,
      simulated: false,
    };
  }

  async sendEmail(message: OutboundMessage): Promise<SendReceipt> {
    return this.post(message);
  }

  async replyToThread(message: OutboundMessage & { threadId: string }): Promise<SendReceipt> {
    // Le fil est obligatoire ici, et transmis à l'API : c'est ce qui distingue
    // une réponse d'un nouveau message adressé à la même personne.
    return this.post(message);
  }
}
