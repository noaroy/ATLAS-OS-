import { canonicalDomainOf } from '@atlas/core';
import type { Repositories } from '@atlas/data';
import { classifyReplyIntent, POSITIVE_REPLY_INTENTS, sameMailbox, type ReplyIntent } from '@atlas/departments';
import { readGlobalPause } from './sales-engine.ts';

/**
 * L'état commercial d'une entreprise, dans le vocabulaire de la boucle B.
 *
 * Aucun état n'est stocké ici : il est dérivé, à la demande, de ce qu'ATLAS
 * consigne déjà — brouillons, envois (réservation et issue), suppressions,
 * événements de conversation, issues commerciales. Stocker un second état
 * ferait deux vérités, et la seconde finit toujours par mentir.
 *
 * L'ordre de lecture est celui de la valeur : une issue (gagné, perdu,
 * proposition, rendez-vous) prime sur une réponse, qui prime sur un envoi,
 * qui prime sur un brouillon.
 *
 * DELIVERED est une inférence et le dit : Gmail ne confirme pas la remise.
 * Un envoi sans rebond après 24 heures est tenu pour remis.
 */

export type CommercialState =
  | 'NONE' | 'READY' | 'QUEUED' | 'PAUSED' | 'SENT' | 'DELIVERED' | 'FAILED' | 'BOUNCED'
  | 'REPLIED' | 'POSITIVE_REPLY' | 'NEGATIVE_REPLY' | 'MEETING' | 'PROPOSAL' | 'WON' | 'LOST' | 'SUPPRESSED';

export const DELIVERY_INFERENCE_MS = 24 * 3_600_000;
const NEGATIVE: readonly ReplyIntent[] = ['NEGATIVE', 'NOT_RELEVANT', 'OPT_OUT'];

export interface CommercialStateView {
  domain: string;
  state: CommercialState;
  /** Ce qui a décidé de l'état, lisible. */
  basis: string;
  /** Une relance automatique est-elle encore permise, en principe ? */
  followUpAllowed: boolean;
}

export function commercialStateOf(repos: Repositories, rawDomain: string, now = new Date(), mailbox = process.env.GMAIL_USER ?? ''): CommercialStateView {
  const domain = canonicalDomainOf(rawDomain);
  const view = (state: CommercialState, basis: string, followUpAllowed = false): CommercialStateView => ({ domain, state, basis, followUpAllowed });

  // ── Les issues, par ordre de valeur ────────────────────────────────────
  const outcomes = repos.salesEngine.outcomes({}).filter((o) => o.domain === domain);
  const has = (kind: string) => outcomes.some((o) => o.kind === kind);
  if (has('WON')) return view('WON', 'issue WON consignée');
  if (has('LOST')) return view('LOST', 'issue LOST consignée');
  if (has('PROPOSAL_SENT')) return view('PROPOSAL', 'proposition envoyée');
  if (has('MEETING_BOOKED') || has('MEETING_DONE')) return view('MEETING', 'rendez-vous consigné');

  // ── Suppression : un opt-out ou un rebond fige tout ────────────────────
  const suppression = repos.salesEngine.isSuppressed({ domain });
  const ledger = repos.sales.ledgerFor(domain);
  if (suppression.suppressed && suppression.entry?.reason === 'BOUNCE') return view('BOUNCED', 'rebond : adresse supprimée');
  if (suppression.suppressed || ledger?.kind === 'DO_NOT_CONTACT') return view('SUPPRESSED', suppression.entry ? `${suppression.entry.kind} ${suppression.entry.reason}` : 'ne pas contacter');

  // ── Les réponses : la plus récente décide ──────────────────────────────
  const conversation = repos.conversations.byDomain(domain);
  const events = conversation ? repos.conversations.eventsFor(conversation.id) : [];
  const replies = events
    .filter((e) => e.classification === 'REPLIED' || e.classification === 'NEEDS_REVIEW' || e.classification === 'BOUNCED')
    .filter((e) => !(mailbox && e.sender && sameMailbox(e.sender, mailbox)))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const last = replies[0];
  if (last) {
    const intent = classifyReplyIntent({
      subject: last.rawSubject, body: last.bodyExcerpt, sender: last.sender,
      classification: last.classification as 'REPLIED' | 'NEEDS_REVIEW' | 'BOUNCED',
    }).intent;
    if (intent === 'BOUNCE') return view('BOUNCED', 'rebond reçu');
    if (POSITIVE_REPLY_INTENTS.includes(intent)) return view('POSITIVE_REPLY', `réponse ${intent}`);
    if (NEGATIVE.includes(intent)) return view('NEGATIVE_REPLY', `réponse ${intent}`);
    if (intent !== 'OUT_OF_OFFICE') return view('REPLIED', `réponse ${intent}`);
  }

  // ── Les envois : le dernier fait foi ───────────────────────────────────
  const sends = repos.salesLoop.sentLog(500).filter((r) => r.domain === domain);
  const sent = sends.filter((r) => r.phase === 'SENT' && r.occurredAt).sort((a, b) => b.occurredAt!.localeCompare(a.occurredAt!));
  if (sent.length > 0) {
    const at = sent[0]!.occurredAt!;
    const aged = now.getTime() - Date.parse(at) >= DELIVERY_INFERENCE_MS;
    return aged
      ? view('DELIVERED', `envoyé le ${at.slice(0, 16)} · aucun rebond en 24 h (inféré)`, true)
      : view('SENT', `envoyé le ${at.slice(0, 16)}`, true);
  }
  if (repos.salesLoop.failedSendsFor(domain) > 0) return view('FAILED', 'échec technique à l’envoi');

  // ── Les brouillons ─────────────────────────────────────────────────────
  const drafts = repos.salesLoop.draftsForDomain(domain);
  if (drafts.some((d) => d.state === 'APPROVED_TO_SEND')) {
    return readGlobalPause(repos).paused ? view('PAUSED', 'approuvé, pause générale active') : view('QUEUED', 'approuvé, en file d’envoi');
  }
  if (drafts.some((d) => d.state === 'READY_FOR_APPROVAL')) return view('READY', 'brouillon en attente d’approbation');
  return view('NONE', 'aucun brouillon');
}

/** Le décompte par état, pour le tableau de bord. */
export function commercialStateCounts(repos: Repositories, now = new Date()): Record<CommercialState, number> {
  const counts = {
    NONE: 0, READY: 0, QUEUED: 0, PAUSED: 0, SENT: 0, DELIVERED: 0, FAILED: 0, BOUNCED: 0, REPLIED: 0,
    POSITIVE_REPLY: 0, NEGATIVE_REPLY: 0, MEETING: 0, PROPOSAL: 0, WON: 0, LOST: 0, SUPPRESSED: 0,
  } satisfies Record<CommercialState, number>;
  const domains = new Set<string>([
    ...repos.salesLoop.draftsInState('READY_FOR_APPROVAL').map((d) => d.domain),
    ...repos.salesLoop.draftsInState('APPROVED_TO_SEND').map((d) => d.domain),
    ...repos.salesLoop.sentLog(1000).map((r) => r.domain),
    ...repos.salesEngine.outcomes({}).map((o) => o.domain),
  ]);
  for (const d of domains) counts[commercialStateOf(repos, d, now).state] += 1;
  return counts;
}
