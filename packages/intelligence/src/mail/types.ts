/**
 * Une boîte de réception, vue comme un flux de messages lisibles.
 *
 * L'abstraction n'est pas un ornement : le classement des réponses est une
 * règle métier qui doit pouvoir être testée sur des messages figés, sans
 * réseau ni compte. Si `classifyInbound` connaissait Gmail, il faudrait une
 * boîte Google pour vérifier qu'un `550` est bien un rebond — et la règle
 * deviendrait invérifiable le jour où l'on changerait de messagerie.
 *
 * L'interface ne décrit donc que la lecture. Il n'y a pas de méthode d'envoi,
 * pas de brouillon, pas de suppression, pas de libellé : ce qui n'existe pas
 * ne peut pas être appelé par erreur, et une revue de code n'a pas à vérifier
 * qu'on s'en est abstenu.
 */

export interface MailMessage {
  /** Identifiant stable côté fournisseur. Sert de clé d'idempotence. */
  messageId: string;
  /** Le fil auquel il appartient, quand le fournisseur en expose un. */
  threadId: string | null;
  from: string;
  to: string[];
  subject: string | null;
  receivedAt: string;
  /** Le texte, ou l'extrait que le fournisseur a bien voulu donner. */
  bodyText: string | null;
  snippet: string | null;
  /**
   * Les en-têtes utiles au rapprochement — `In-Reply-To`, `References`,
   * `Return-Path`, `Auto-Submitted`. Pas l'intégralité : un en-tête inutile
   * coûte à transporter et à lire.
   */
  headers: Record<string, string>;
}

export interface MailQuery {
  /** Ne remonter que les messages postérieurs à cette date. */
  since?: string;
  /** Plafond dur. Une boîte se lit par tranches, elle ne se vide pas. */
  max?: number;
  /** Filtre propre au fournisseur, quand il en accepte un. */
  rawFilter?: string;
}

/**
 * Ce qu'ATLAS attend d'une messagerie : pouvoir lire, et savoir si elle est
 * joignable.
 */
export interface MailInboxProvider {
  readonly id: string;
  /**
   * L'état de la configuration, sans jamais révéler de secret.
   *
   * Rendu plutôt que jeté : une messagerie non configurée est une situation
   * normale — en développement, en test, sur une machine neuve — et doit
   * produire un message clair, pas une pile d'appels.
   */
  status(): MailProviderStatus;
  list(query?: MailQuery): Promise<MailMessage[]>;
}

export interface MailProviderStatus {
  configured: boolean;
  /** `GMAIL_NOT_CONFIGURED`, `FIXTURE_READY`… — lisible par une machine. */
  code: string;
  /** Ce qui manque, nommé. Jamais la valeur d'un secret. */
  detail: string;
  /** Les portées demandées, pour qu'un lecteur voie qu'elles sont en lecture. */
  scopes: readonly string[];
}

/** Les en-têtes qui servent réellement au rapprochement. */
export const USEFUL_HEADERS = [
  'in-reply-to',
  'references',
  'message-id',
  'return-path',
  'auto-submitted',
  'x-autoreply',
  'x-failed-recipients',
  'delivered-to',
] as const;
