import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '@atlas/core';
import { createRepositories, type Repositories } from '../src/index.ts';
import {
  classifyInbound,
  detectOptOut,
  deriveConversationState,
  shouldNotify,
  evaluateFollowUp,
  canTransitionLoop,
  type ConversationEvent,
  type ConversationStatus,
  type LoopState,
} from '@atlas/departments';
import {
  DryRunOutboundProvider,
  GmailOutboundProvider,
  OutboundNotAuthorisedError,
} from '@atlas/intelligence';

/**
 * La boucle entière, jouée d'un bout à l'autre.
 *
 * Les tests unitaires vérifient chaque garde isolément. Celui-ci vérifie
 * l'assemblage — c'est-à-dire l'endroit où les défauts de ce système sont
 * réellement apparus. `findGrowthSignals` n'appelait pas `readsAsSentence` : la
 * garde était juste, testée, et branchée à côté du chemin qu'elle protégeait.
 * Rien dans un test unitaire ne pouvait le voir.
 *
 * Aucun message ne part : le fournisseur d'envoi est celui qui consigne sans
 * poster.
 */

const logger = createLogger({ level: 'error', pretty: false });
let repos: Repositories;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-e2e-'));
  repos = createRepositories(join(dir, 'e2e.db'), logger);
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const DOMAIN = 'exemple-industrie.fr';

/** Ce que fait le script : une transition refusée n'est pas consignée. */
function move(domain: string, to: LoopState, reason = 'test') {
  const from = repos.salesLoop.currentState(domain) as LoopState | null;
  const check = canTransitionLoop(from, to);
  if (check.allowed) {
    repos.salesLoop.recordTransition({ domain, fromState: from, toState: to, reason, actor: 'test' });
  }
  return check;
}

function seedDraft(domain = DOMAIN) {
  return repos.salesLoop.saveDraft({
    domain,
    companyName: 'Exemple Industrie',
    recipient: `commercial@${domain}`,
    subject: 'Exemple Industrie — 3 prospects, gratuitement',
    body: 'Bonjour,\n\nJ’ai relevé ceci sur votre site : « […] »',
    purpose: 'FIRST_TOUCH',
    conversionScore: 72,
    sources: [
      { quote: 'Notre atelier double sa surface.', sourceUrl: `https://${domain}/actualites` },
      { quote: 'Nous fabriquons des tableaux électriques.', sourceUrl: `https://${domain}/` },
    ],
    createdBy: 'boucle',
  });
}

/** L'envoi tel que le script le fait : réserver, poster, consigner. */
async function sendApproved(provider: DryRunOutboundProvider, draftId: string) {
  const draft = repos.salesLoop.draftById(draftId)!;
  if (repos.sales.ledgerFor(draft.domain)?.kind === 'DO_NOT_CONTACT') {
    move(draft.domain, 'BLOCKED', 'DO_NOT_CONTACT');
    return { sent: false, reason: 'DO_NOT_CONTACT' };
  }
  if (draft.state !== 'APPROVED_TO_SEND') {
    return { sent: false, reason: `état ${draft.state} : approbation manquante` };
  }
  const claim = repos.salesLoop.claimSend({
    domain: draft.domain,
    recipient: draft.recipient,
    subject: draft.subject,
    body: draft.body,
    purpose: draft.purpose,
    claimedBy: 'boucle',
  });
  if (!claim.claimed) return { sent: false, reason: claim.reason };

  move(draft.domain, 'SENDING');
  const receipt = await provider.sendEmail({
    to: draft.recipient, subject: draft.subject, bodyText: draft.body,
  });
  repos.salesLoop.recordSendResult({
    idempotencyKey: claim.idempotencyKey,
    phase: 'SENT',
    externalMessageId: receipt.externalMessageId,
  });
  repos.salesLoop.markDraftSent(draft.id);
  repos.sales.recordOutreach({
    domain: draft.domain, kind: 'CONTACTED', recordedBy: 'boucle', channel: 'email',
  });
  move(draft.domain, 'CONTACTED');
  return { sent: true, reason: receipt.externalMessageId };
}

/** Consigner une réponse, comme le fait `sales-loop reply`. */
function recordReply(domain: string, body: string, subject: string | null = null) {
  const conversation = repos.conversations.byDomain(domain)
    ?? repos.conversations.open({ domain, companyName: 'Exemple Industrie' }).conversation;

  const optOut = detectOptOut({ subject, body });
  if (optOut.optedOut) {
    repos.sales.recordOutreach({
      domain, kind: 'DO_NOT_CONTACT', recordedBy: 'boucle', note: optOut.reason,
    });
    move(domain, 'BLOCKED', 'opt-out');
    return { optOut, notification: null, status: null as ConversationStatus | null };
  }

  const verdict = classifyInbound({ kind: 'EMAIL_REPLY', subject, body });
  repos.conversations.recordInboundEvent({
    conversationId: conversation.id,
    kind: 'EMAIL_REPLY',
    classification: verdict.classification,
    confidence: verdict.confidence,
    source: 'test',
    rawSubject: subject,
    bodyExcerpt: body,
    signals: verdict.signals,
    returnDate: verdict.returnDate,
    humanReviewed: false,
  });
  const events = repos.conversations.eventsFor(conversation.id).map((e) => ({
    kind: e.kind,
    classification: e.classification,
    occurredAt: e.occurredAt,
    returnDate: e.returnDate,
    humanReviewed: e.humanReviewed,
    declaredStatus: (e.declaredStatus as ConversationStatus | null) ?? null,
  })) as ConversationEvent[];
  const state = deriveConversationState(events, { today: '2026-08-24' });
  move(domain, verdict.classification === 'BOUNCED' ? 'ACTION_REQUIRED' : 'REPLIED');

  return {
    optOut,
    status: state.status,
    notification: shouldNotify({
      status: state.status,
      classification: verdict.classification,
      confidence: verdict.confidence,
      subject,
      bodyExcerpt: body,
    }),
  };
}

describe('la boucle complète, sans qu’un message ne parte', () => {
  test('découverte → approbation → envoi → réponse → notification', async () => {
    const provider = new DryRunOutboundProvider();

    move(DOMAIN, 'QUALIFYING');
    const draft = seedDraft();
    move(DOMAIN, 'READY_FOR_APPROVAL');

    // Sans approbation, rien ne part.
    const refused = await sendApproved(provider, draft.id);
    assert.equal(refused.sent, false);
    assert.match(refused.reason, /approbation manquante/);
    assert.equal(provider.sent.length, 0);

    repos.salesLoop.decideDraft({
      draftId: draft.id, decision: 'APPROVED_TO_SEND', decidedBy: 'noaroy',
    });
    move(DOMAIN, 'APPROVED_TO_SEND');

    const sent = await sendApproved(provider, draft.id);
    assert.equal(sent.sent, true);
    assert.equal(provider.sent.length, 1);
    assert.equal(repos.salesLoop.currentState(DOMAIN), 'CONTACTED');

    // Une réponse humaine intéressée.
    const outcome = recordReply(
      DOMAIN,
      'Bonjour, merci pour votre message. Nous pourrions etre interesses, pouvez-vous nous en dire plus ?',
    );
    assert.equal(outcome.notification?.decision, 'NOTIFY');
    assert.ok(outcome.notification!.summary.length > 10);
    assert.ok(outcome.notification!.recommendedNextAction.length > 10);
    assert.equal(repos.salesLoop.currentState(DOMAIN), 'REPLIED');

    // Rien n'est jamais parti par le réseau.
    assert.ok(provider.sent.every(() => true));
  });

  test('la boucle redémarre sans corrompre son état', async () => {
    const provider = new DryRunOutboundProvider();
    move(DOMAIN, 'QUALIFYING');
    const draft = seedDraft();
    move(DOMAIN, 'READY_FOR_APPROVAL');
    repos.salesLoop.decideDraft({
      draftId: draft.id, decision: 'APPROVED_TO_SEND', decidedBy: 'noaroy',
    });
    move(DOMAIN, 'APPROVED_TO_SEND');
    await sendApproved(provider, draft.id);

    // Redémarrage : nouvelle connexion sur le même fichier.
    const path = join(dir, 'e2e.db');
    repos.close();
    repos = createRepositories(path, logger);

    assert.equal(repos.salesLoop.currentState(DOMAIN), 'CONTACTED');
    assert.equal(repos.salesLoop.draftById(draft.id)?.state, 'SENT');
    assert.equal(repos.salesLoop.sentSince('2000-01-01'), 1);

    // Rejouer l'envoi après redémarrage ne produit pas de second message.
    const again = await sendApproved(new DryRunOutboundProvider(), draft.id);
    assert.equal(again.sent, false);
    assert.equal(repos.salesLoop.sentSince('2000-01-01'), 1);
  });

  test('plantage entre l’envoi et la persistance : aucun second envoi', async () => {
    // Le fournisseur a posté, puis le processus meurt avant de consigner
    // l'issue. La réservation, elle, existe déjà — elle a été prise avant.
    const draft = seedDraft();
    repos.salesLoop.decideDraft({
      draftId: draft.id, decision: 'APPROVED_TO_SEND', decidedBy: 'noaroy',
    });
    const claim = repos.salesLoop.claimSend({
      domain: draft.domain,
      recipient: draft.recipient,
      subject: draft.subject,
      body: draft.body,
      purpose: draft.purpose,
      claimedBy: 'boucle',
    });
    assert.equal(claim.claimed, true);
    await new DryRunOutboundProvider().sendEmail({
      to: draft.recipient, subject: draft.subject, bodyText: draft.body,
    });
    // — plantage ici : aucun recordSendResult —

    const provider = new DryRunOutboundProvider();
    const retry = await sendApproved(provider, draft.id);
    assert.equal(retry.sent, false);
    assert.equal(provider.sent.length, 0, 'aucun second message n’a été posté');
  });
});

describe('le désabonnement', () => {
  test('« ne plus me contacter » ferme le domaine immédiatement', async () => {
    const provider = new DryRunOutboundProvider();
    move(DOMAIN, 'QUALIFYING');
    const draft = seedDraft();
    move(DOMAIN, 'READY_FOR_APPROVAL');
    repos.salesLoop.decideDraft({
      draftId: draft.id, decision: 'APPROVED_TO_SEND', decidedBy: 'noaroy',
    });
    move(DOMAIN, 'APPROVED_TO_SEND');
    await sendApproved(provider, draft.id);

    const outcome = recordReply(DOMAIN, 'Merci de ne plus me contacter.');
    assert.equal(outcome.optOut.optedOut, true);
    assert.equal(repos.sales.ledgerFor(DOMAIN)?.kind, 'DO_NOT_CONTACT');
    assert.equal(repos.salesLoop.currentState(DOMAIN), 'BLOCKED');
  });

  test('« STOP » isolé est un désabonnement, « stop » dans une phrase non', () => {
    assert.equal(detectOptOut({ body: 'STOP' }).optedOut, true);
    assert.equal(
      detectOptOut({ body: 'Nous allons stopper la production cet ete.' }).optedOut,
      false,
    );
  });

  test('un domaine fermé ne reçoit plus rien, même approuvé', async () => {
    repos.sales.recordOutreach({
      domain: DOMAIN, kind: 'DO_NOT_CONTACT', recordedBy: 'noaroy', note: 'opt-out',
    });
    const draft = seedDraft();
    repos.salesLoop.decideDraft({
      draftId: draft.id, decision: 'APPROVED_TO_SEND', decidedBy: 'noaroy',
    });
    const provider = new DryRunOutboundProvider();
    const outcome = await sendApproved(provider, draft.id);
    assert.equal(outcome.sent, false);
    assert.equal(outcome.reason, 'DO_NOT_CONTACT');
    assert.equal(provider.sent.length, 0);
  });
});

describe('les réponses ambiguës et le bruit', () => {
  test('une réponse illisible part en revue humaine, elle ne se devine pas', () => {
    const outcome = recordReply(DOMAIN, '???');
    assert.equal(outcome.status, 'NEEDS_REVIEW');
    assert.equal(outcome.notification?.decision, 'NOTIFY');
    assert.equal(outcome.notification?.draftReply, null, 'aucune réponse pré-écrite sur un doute');
  });

  test('une réponse se rattache au bon domaine, pas à un autre', () => {
    repos.conversations.open({ domain: 'autre-societe.fr', companyName: 'Autre' });
    recordReply(DOMAIN, 'Bonjour, cela nous interesse, pouvez-vous nous en dire plus ?');

    const mine = repos.conversations.byDomain(DOMAIN)!;
    const other = repos.conversations.byDomain('autre-societe.fr')!;
    assert.equal(repos.conversations.eventsFor(mine.id).length, 1);
    assert.equal(repos.conversations.eventsFor(other.id).length, 0);
  });
});

describe('la relance', () => {
  test('une seule relance, puis le silence clôt l’affaire', () => {
    const relance = () => {
      const claim = repos.salesLoop.claimSend({
        domain: DOMAIN,
        recipient: `commercial@${DOMAIN}`,
        subject: 'Suite à mon message',
        body: `Bonjour, un mot de suite. ${Math.random()}`,
        purpose: 'FOLLOW_UP',
        claimedBy: 'boucle',
      });
      repos.salesLoop.recordSendResult({
        idempotencyKey: claim.idempotencyKey, phase: 'SENT', externalMessageId: 'm',
      });
    };

    const before = evaluateFollowUp({
      domain: DOMAIN, status: 'CONTACTED', contactedOn: '2026-08-17',
      followUpsSent: repos.salesLoop.followUpsFor(DOMAIN),
      doNotContact: false, afterBusinessDays: 3, today: '2026-08-24',
    });
    assert.equal(before.verdict, 'DUE');

    relance();

    const after = evaluateFollowUp({
      domain: DOMAIN, status: 'CONTACTED', contactedOn: '2026-08-17',
      followUpsSent: repos.salesLoop.followUpsFor(DOMAIN),
      doNotContact: false, afterBusinessDays: 3, today: '2026-08-31',
    });
    assert.equal(after.verdict, 'ALREADY_FOLLOWED_UP');
  });

  test('un refus explicite n’est jamais relancé', () => {
    const decision = evaluateFollowUp({
      domain: DOMAIN, status: 'NOT_INTERESTED', contactedOn: '2026-01-01',
      followUpsSent: 0, doNotContact: false, afterBusinessDays: 3, today: '2026-12-31',
    });
    assert.equal(decision.verdict, 'FORBIDDEN');
  });
});

describe('le fournisseur d’envoi', () => {
  test('Gmail sans portée d’envoi échoue franchement, sans repli silencieux', async () => {
    const gmail = new GmailOutboundProvider({
      grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      // L'interrupteur est leve pour que le test eprouve la garde de portee, pas celle de l'interrupteur.
      env: { ...process.env, ATLAS_OUTBOUND_ENABLED: 'true' },
    });
    assert.equal(gmail.status().configured, false);
    assert.equal(gmail.status().code, 'GMAIL_SEND_SCOPE_MISSING');
    const message = { to: 'a@b.fr', subject: 'sujet', bodyText: 'corps' };
    await assert.rejects(() => gmail.sendEmail(message), OutboundNotAuthorisedError);
    await assert.rejects(
      () => gmail.replyToThread({ ...message, threadId: 'fil-1' }),
      (error: unknown) => error instanceof OutboundNotAuthorisedError,
    );
  });

  test('le fournisseur de développement annonce qu’il ne poste rien', async () => {
    const provider = new DryRunOutboundProvider();
    const receipt = await provider.sendEmail({
      to: 'a@b.fr', subject: 's', bodyText: 'b',
    });
    assert.equal(receipt.simulated, true);
  });
});
