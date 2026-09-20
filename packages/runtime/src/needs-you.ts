import type { Repositories } from '@atlas/data';
import {
  deriveConversationState,
  recommendedActionFor,
  isTechnicalEntity,
  type ConversationEvent,
  type ConversationStatus,
} from '@atlas/departments';

/**
 * Une seule file pour tout ce qui attend une personne.
 *
 * Le problème qu'elle résout n'est pas technique. Un système qui tourne seul
 * produit des décisions à prendre dans cinq endroits différents — une réponse
 * client dans la boîte, un brouillon dans le registre commercial, un patch dans
 * un worktree, une clé absente dans la configuration. Il faut alors se souvenir
 * d'aller regarder partout, et c'est précisément ce qu'on cesse de faire.
 *
 * D'où une file unique, et un format constant : ce qui s'est passé, pourquoi
 * cela compte, ce qu'ATLAS recommande, et la commande exacte à taper. Sans
 * identifiant de bail, sans numéro de migration, sans SQL — ces choses existent
 * et restent consultables ailleurs, mais elles n'aident personne à décider.
 */

export type NeedsYouKind =
  | 'CLIENT_REPLY'
  | 'OUTREACH'
  | 'ENGINEERING'
  | 'SYSTEM'
  | 'FOLLOW_UP';

export interface NeedsYouItem {
  kind: NeedsYouKind;
  /** Ce qui s'est passé, en une phrase, sans jargon. */
  what: string;
  /** Pourquoi cela mérite d'être traité maintenant. */
  why: string;
  /** Ce qu'ATLAS ferait, s'il décidait. */
  recommendation: string;
  /** La commande à taper. Une seule. */
  action: string;
  /** Plus c'est bas, plus c'est urgent. */
  rank: number;
}

const RANK: Record<NeedsYouKind, number> = {
  CLIENT_REPLY: 0,
  OUTREACH: 1,
  ENGINEERING: 2,
  FOLLOW_UP: 3,
  SYSTEM: 4,
};

/** Les états de conversation qui attendent réellement quelqu'un. */
const AWAITING: readonly ConversationStatus[] = [
  'INTERESTED', 'NEEDS_INFO', 'MEETING_REQUESTED', 'REPLIED', 'NEEDS_REVIEW',
];

export interface NeedsYouOptions {
  repos: Repositories;
  today?: string;
  /** Ce que le contrôle système a trouvé de bloquant, s'il a tourné. */
  systemBlockers?: ReadonlyArray<{ what: string; why: string; action: string }>;
}

/**
 * Rassembler ce qui attend une décision.
 *
 * Tout est lu en base. Aucune estimation : un élément qui figure ici correspond
 * à un état réellement persisté, et sa disparition suit l'action qu'on a prise.
 */
export function collectNeedsYou(options: NeedsYouOptions): NeedsYouItem[] {
  const { repos } = options;
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const items: NeedsYouItem[] = [];

  // --- Réponses de prospects et clients ---
  //
  // Une conversation technique (le self-test Gmail) n'attend rien de personne :
  // elle reste en base pour l'audit, jamais dans la liste de ce qu'il faut faire.
  for (const conversation of repos.conversations.all()) {
    if (isTechnicalEntity(conversation)) continue;
    const events = repos.conversations.eventsFor(conversation.id).map((e) => ({
      kind: e.kind,
      classification: e.classification,
      occurredAt: e.occurredAt,
      returnDate: e.returnDate,
      humanReviewed: e.humanReviewed,
      declaredStatus: (e.declaredStatus as ConversationStatus | null) ?? null,
    })) as ConversationEvent[];
    if (events.length === 0) continue;

    const state = deriveConversationState(events, { today });
    if (!AWAITING.includes(state.status)) continue;

    items.push({
      kind: 'CLIENT_REPLY',
      what: `${conversation.companyName} a répondu — ${state.status}`,
      why:
        state.status === 'INTERESTED'
          ? 'un prospect intéressé qui attend perd son intérêt'
          : 'quelqu’un attend une réponse de votre part',
      recommendation: recommendedActionFor(state.status),
      action: `npm run sales:inbox`,
      rank: RANK.CLIENT_REPLY,
    });
  }

  // --- Messages commerciaux rédigés, en attente d'approbation ---
  const drafts = repos.salesLoop.draftsInState('READY_FOR_APPROVAL');
  if (drafts.length > 0) {
    items.push({
      kind: 'OUTREACH',
      what: `${drafts.length} message(s) commerciaux rédigés`,
      why: 'aucun ne partira tant que vous ne les avez pas relus',
      recommendation: 'relire les faits cités et le destinataire, puis approuver ou refuser',
      action: 'npm run sales:loop -- drafts',
      rank: RANK.OUTREACH,
    });
  }

  // --- Travaux d'ingénierie à relire ou à appliquer ---
  const ready = repos.tasks.workspacesInState('READY_FOR_REVIEW');
  for (const workspace of ready) {
    items.push({
      kind: 'ENGINEERING',
      what: `un changement de code est prêt (${workspace.filesChanged} fichier(s), ${workspace.diffLines} ligne(s))`,
      why: 'le dépôt ne bougera pas sans votre accord',
      recommendation: 'lire le diff, puis approuver l’application ou l’abandonner',
      action: `npm run atlas:apply -- show ${workspace.taskId}`,
      rank: RANK.ENGINEERING,
    });
  }
  const approved = repos.tasks.workspacesInState('APPROVED_TO_APPLY');
  for (const workspace of approved) {
    items.push({
      kind: 'ENGINEERING',
      what: 'un changement approuvé n’a pas encore été appliqué',
      why: 'le travail est validé mais reste hors du dépôt',
      recommendation: 'appliquer maintenant, ou annuler l’approbation',
      action: `npm run atlas:apply -- run ${workspace.taskId} --by=vous`,
      rank: RANK.ENGINEERING,
    });
  }

  // --- Tâches bloquées sur une décision ---
  const waiting = repos.tasks.list({ status: 'WAITING_HUMAN', limit: 20 });
  for (const task of waiting) {
    items.push({
      kind: task.department === 'ENGINEERING' ? 'ENGINEERING' : 'SYSTEM',
      what: `« ${task.taskType} » est en attente : ${task.errorMessage ?? 'décision requise'}`,
      why: 'la tâche ne reprendra pas d’elle-même',
      recommendation:
        task.errorCode === 'AUTH_ERROR' || task.errorCode?.includes('NOT_CONFIGURED')
          ? 'fournir l’identifiant manquant, puis relancer la tâche'
          : 'lire le détail et décider de la relancer ou de l’annuler',
      action: `npm run atlas:task -- show ${task.taskId}`,
      rank: task.department === 'ENGINEERING' ? RANK.ENGINEERING : RANK.SYSTEM,
    });
  }

  // --- Ce que le contrôle système a trouvé ---
  for (const blocker of options.systemBlockers ?? []) {
    items.push({
      kind: 'SYSTEM',
      what: blocker.what,
      why: blocker.why,
      recommendation: 'sans cela, la partie concernée du système reste à l’arrêt',
      action: blocker.action,
      rank: RANK.SYSTEM,
    });
  }

  return items.sort((a, b) => a.rank - b.rank);
}

// --- Les chiffres du jour ---------------------------------------------------

export interface TodaySnapshot {
  contacted: number;
  replies: number;
  positiveReplies: number;
  paidClients: number;
  revenueEur: number;
  aiCostUsd: number | null;
  aiCostUnknownCalls: number;
  tasksDone: number;
}

/**
 * Ce qui s'est passé aujourd'hui, sans rien estimer.
 *
 * `aiCostUsd` vaut `null` quand aucun appel n'a de tarif connu — et le nombre
 * d'appels non chiffrés est rendu à part. Additionner ces appels comme s'ils
 * valaient zéro ferait lire « gratuit » là où l'on ne sait pas.
 */
export function todaySnapshot(repos: Repositories, today?: string): TodaySnapshot {
  const day = today ?? new Date().toISOString().slice(0, 10);
  const since = `${day}T00:00:00.000Z`;

  const usage = repos.tasks.aiUsageSince(since);
  const missionUsage = repos.llmCalls.usageSince(since);
  const orders = repos.orders.listOrders(200).filter((o) => o.paymentStatus === 'CONFIRMED');

  let replies = 0;
  let positive = 0;
  for (const conversation of repos.conversations.all()) {
    if (isTechnicalEntity(conversation)) continue;
    const events = repos.conversations.eventsFor(conversation.id);
    if (events.length === 0) continue;
    const state = deriveConversationState(
      events.map((e) => ({
        kind: e.kind,
        classification: e.classification,
        occurredAt: e.occurredAt,
        returnDate: e.returnDate,
        humanReviewed: e.humanReviewed,
        declaredStatus: (e.declaredStatus as ConversationStatus | null) ?? null,
      })) as ConversationEvent[],
      { today: day },
    );
    if (['REPLIED', 'INTERESTED', 'NEEDS_INFO', 'MEETING_REQUESTED', 'NOT_INTERESTED']
      .includes(state.status)) replies += 1;
    if (['INTERESTED', 'MEETING_REQUESTED', 'WON'].includes(state.status)) positive += 1;
  }

  return {
    contacted: repos.sales.ledgerDomains().filter((d) => d.kind === 'CONTACTED' && !isTechnicalEntity(d)).length,
    replies,
    positiveReplies: positive,
    paidClients: orders.length,
    revenueEur: orders.reduce((sum, o) => sum + (o.priceCents ?? 0), 0) / 100,
    // Les deux registres, additionnes.
    //
    // Les workers ecrivent dans `ai_calls`, le pipeline de prospection dans
    // `llm_calls`. N'en lire qu'un affichait « Coût IA : N/A » pendant que
    // 6,82 $ avaient reellement ete depenses — un tableau de bord de cout qui
    // sous-declare a zero est pire qu'absent : il rassure.
    aiCostUsd: usage.calls + missionUsage.calls === 0
      ? null
      : usage.knownCostUsd + missionUsage.knownCostUsd,
    aiCostUnknownCalls: usage.unknownCostCalls + missionUsage.unknownCostCalls,
    tasksDone: repos.tasks.completedSince(since).length,
  };
}

export interface PipelineSnapshot {
  discovered: number;
  qualified: number;
  contacted: number;
  interested: number;
  preview: number;
  paid: number;
}

/**
 * L'entonnoir commercial, tel que la base le connaît.
 *
 * `preview` reste à `-1` — un aperçu gratuit est produit et transmis à la main,
 * rien en base ne permet de les compter. Le rendre négatif plutôt que nul force
 * l'affichage à écrire N/A au lieu de laisser croire à zéro.
 */
export function pipelineSnapshot(repos: Repositories, today?: string): PipelineSnapshot {
  const day = today ?? new Date().toISOString().slice(0, 10);
  const ledger = repos.sales.ledgerDomains();

  let discovered = 0;
  let qualified = 0;
  for (const batchId of repos.sales.batchIds()) {
    for (const prospect of repos.sales.forBatch(batchId)) {
      discovered += 1;
      if (prospect.tier && prospect.tier !== 'REJECTED') qualified += 1;
    }
  }

  let interested = 0;
  for (const conversation of repos.conversations.all()) {
    if (isTechnicalEntity(conversation)) continue;
    const events = repos.conversations.eventsFor(conversation.id);
    if (events.length === 0) continue;
    const state = deriveConversationState(
      events.map((e) => ({
        kind: e.kind,
        classification: e.classification,
        occurredAt: e.occurredAt,
        returnDate: e.returnDate,
        humanReviewed: e.humanReviewed,
        declaredStatus: (e.declaredStatus as ConversationStatus | null) ?? null,
      })) as ConversationEvent[],
      { today: day },
    );
    if (['INTERESTED', 'MEETING_REQUESTED', 'NEEDS_INFO'].includes(state.status)) interested += 1;
  }

  return {
    discovered,
    qualified,
    contacted: ledger.filter((d) => d.kind === 'CONTACTED' && !isTechnicalEntity(d)).length,
    interested,
    preview: -1,
    paid: repos.orders.listOrders(200).filter((o) => o.paymentStatus === 'CONFIRMED').length,
  };
}
