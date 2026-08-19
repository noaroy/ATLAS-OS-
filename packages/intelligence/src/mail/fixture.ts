import type { MailInboxProvider, MailMessage, MailProviderStatus, MailQuery } from './types.ts';

/**
 * Une boîte de réception figée, pour les tests et les répétitions à blanc.
 *
 * Sans elle, vérifier qu'un `550` est bien classé en rebond exigerait un
 * compte Google, et la règle ne serait testable que par celui qui possède la
 * boîte. Les messages sont fournis à la construction : ils ne varient pas,
 * donc un échec de test désigne le code et non l'humeur d'un serveur.
 */
export class FixtureInboxProvider implements MailInboxProvider {
  readonly id = 'fixture';

  constructor(private readonly messages: readonly MailMessage[]) {}

  status(): MailProviderStatus {
    return {
      configured: true,
      code: 'FIXTURE_READY',
      detail: `${this.messages.length} message(s) figé(s)`,
      scopes: ['lecture seule (aucun réseau)'],
    };
  }

  async list(query: MailQuery = {}): Promise<MailMessage[]> {
    let messages = [...this.messages];
    if (query.since) messages = messages.filter((m) => m.receivedAt >= query.since!);
    if (query.max) messages = messages.slice(0, query.max);
    return messages;
  }
}

/** Un message minimal, pour n'écrire dans un test que ce qui compte. */
export function mailMessage(over: Partial<MailMessage> & { messageId: string }): MailMessage {
  return {
    threadId: null,
    from: 'quelqu-un@exemple.fr',
    to: ['commercial@atlas.example'],
    subject: null,
    receivedAt: '2026-08-19T09:00:00.000Z',
    bodyText: null,
    snippet: null,
    headers: {},
    ...over,
  };
}
