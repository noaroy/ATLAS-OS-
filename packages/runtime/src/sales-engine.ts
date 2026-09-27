import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { AtlasConfig, Logger } from '@atlas/core';
import { canonicalDomainOf, describeError, id, nowIso } from '@atlas/core';
import type {
  Repositories, TaskRow, OutreachDraftRow, SalesSegment, OptimizationRecommendation, OutcomeKind, SalesProspect,
} from '@atlas/data';
import type { MailInboxProvider, MailOutboundProvider } from '@atlas/intelligence';
import { GmailInboxProvider, GmailOutboundProvider, DryRunOutboundProvider } from '@atlas/intelligence';
import {
  classifyReplyIntent,
  evaluateSendPolicy,
  evaluateFollowUp,
  canTransitionLoop,
  chooseVariant,
  applyStrategyChange,
  deliverabilityAlarm,
  engineeringInsights,
  recommend,
  periodKey,
  DEFAULT_STRATEGY,
  HOT_LEAD_INTENTS,
  STOP_FOLLOW_UP_INTENTS,
  isTechnicalDomain,
  buildOutreachDraft,
  personalizationIsGrounded,
  validateOutreachDraft,
  customerFacingObservation,
  outreachFactFrom,
  isCommercialEvidence,
  type LoopState,
  type ReplyIntent,
  type SendPolicy,
  type SendPolicyState,
  type SendPolicyVerdict,
  type Strategy,
  type StrategyChange,
  type SegmentStats,
  type VariantStats,
} from '@atlas/departments';
import type { WorkerContext, WorkerOutcome } from './workers.ts';
import { syncSalesInbox, type InboxSyncReport } from './sales-inbox-sync.ts';
import { promoteExpansionBacklog } from './expansion/engine.ts';

/**
 * Le moteur commercial qui tourne seul — et s'arrête seul là où il le doit.
 *
 * Rien ici n'est une seconde version de ce qui existait. La découverte et la
 * qualification restent `scripts/sales-batch.ts`, lancé tel quel, avec ses
 * gardes ; la boîte se lit avec `syncSalesInbox` ; la relance se décide avec
 * `evaluateFollowUp` ; l'envoi passe par `outbound_sends` — la même place
 * exactement-une-fois que la boucle manuelle. Ce fichier relie, cadence, et
 * refuse : c'est la politique d'envoi qui dit non avant que quoi que ce soit
 * ne parte.
 *
 * Les handlers sont des workers déterministes du daemon : un bail, un
 * battement, une issue. Le planificateur crée leurs tâches avec des clés de
 * période, si bien qu'un redémarrage ne double aucun cycle.
 */

export const SALES_ENGINE_TASKS = {
  DISCOVERY: 'SALES_DISCOVERY',
  SEND: 'SALES_SEND',
  FOLLOW_UP: 'SALES_FOLLOW_UP',
  REPLY_SYNC: 'SALES_REPLY_CHECK',
  ANALYTICS: 'SALES_ANALYTICS',
  OPTIMIZATION: 'SALES_OPTIMIZATION',
  /** La fabrique de revenu (boucle A) : qualifier, lire contacts et faits, classer. */
  FACTORY: 'REVENUE_FACTORY',
} as const;

/** La cadence de chaque cycle, en minutes. Une journée = 1440. */
export const SALES_SCHEDULE: Record<keyof typeof SALES_ENGINE_TASKS, number> = {
  REPLY_SYNC: 15,
  SEND: 10,
  FOLLOW_UP: 1440,
  DISCOVERY: 1440,
  ANALYTICS: 60,
  OPTIMIZATION: 1440,
  // Douze entreprises par tour, un tour toutes les trente minutes : une
  // capacité de 576 par jour, bornée en pratique par ce que la découverte verse.
  FACTORY: 30,
};

export const SALES_SETTINGS = {
  GLOBAL_PAUSE: 'sales.globalPause',
  STRATEGY: 'sales.strategy',
  AUTO_APPLY_TINY: 'sales.autoApplyTiny',
  LAST_CYCLES: 'sales.lastCycles',
  LAST_OPTIMIZATION: 'sales.lastOptimization',
} as const;

const ACTOR = 'sales-engine';

export interface GlobalPause {
  paused: boolean;
  reason: string | null;
  by: string | null;
  at: string | null;
}

export function readGlobalPause(repos: Repositories): GlobalPause {
  return repos.settings.get<GlobalPause>(SALES_SETTINGS.GLOBAL_PAUSE, { paused: false, reason: null, by: null, at: null });
}

/** Le coupe-circuit. Toujours signé : une pause anonyme ne se lève pas en confiance. */
export function setGlobalPause(repos: Repositories, paused: boolean, by: string, reason: string | null): GlobalPause {
  if (!by.trim()) throw new Error('une pause ou une reprise sans auteur ne se consigne pas');
  const value: GlobalPause = { paused, reason: paused ? reason : null, by, at: nowIso() };
  repos.settings.set(SALES_SETTINGS.GLOBAL_PAUSE, value, by);
  repos.events.append({
    id: id('evt'), type: 'system.alert', severity: paused ? 'warning' : 'info', source: ACTOR,
    missionId: null, agentKey: null,
    message: paused ? `PAUSE ATLAS — ${reason ?? 'sans motif'}` : 'RESUME ATLAS',
    payload: { paused, reason, by }, createdAt: value.at!,
  });
  return value;
}

export function readStrategy(repos: Repositories): Strategy {
  const stored = repos.settings.get<Partial<Strategy>>(SALES_SETTINGS.STRATEGY, {});
  return {
    segmentWeights: { ...DEFAULT_STRATEGY.segmentWeights, ...(stored.segmentWeights ?? {}) },
    messageAllocation: { ...DEFAULT_STRATEGY.messageAllocation, ...(stored.messageAllocation ?? {}) },
    personaPriority: stored.personaPriority ?? [...DEFAULT_STRATEGY.personaPriority],
    angleWeights: { ...DEFAULT_STRATEGY.angleWeights, ...(stored.angleWeights ?? {}) },
  };
}

export function sendPolicyOf(config: AtlasConfig): SendPolicy {
  return {
    dailyCapPerMailbox: config.sales.maxNewOutreachPerDay,
    hourlyCap: config.sales.hourlySendCap,
    minDelaySeconds: config.sales.minSendDelaySeconds,
    sendWindow: config.sales.sendWindow,
    weekendEnabled: config.sales.weekendEnabled,
    timezone: config.sales.timezone,
    maxFollowUps: Math.min(config.sales.maxFollowUps, 1),
    bouncePauseRate: config.sales.bouncePauseRate,
    bounceMinSample: config.sales.bounceMinSample,
  };
}

const startOfUtcDay = (now: Date): string => `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
const daysAgo = (now: Date, days: number): string => new Date(now.getTime() - days * 86_400_000).toISOString();

/** Les rebonds sur les envois des trente derniers jours. */
export function bounceCounts(repos: Repositories, now: Date): { sent: number; bounced: number } {
  const since = daysAgo(now, 30);
  const sent = repos.salesLoop.sentSince(since);
  const bounced = repos.conversations.eventsSince(since).filter((e) => e.classification === 'BOUNCED').length;
  return { sent, bounced };
}

/** Une réponse humaine est-elle déjà arrivée de ce domaine ? */
export function replyReceivedFor(repos: Repositories, domain: string): boolean {
  const conversation = repos.conversations.byDomain(domain);
  if (!conversation) return false;
  // NEEDS_REVIEW compte : une réponse rapprochée avec un doute reste une
  // réponse. Tant qu'une personne ne l'a pas relue, aucun message automatique
  // (premier contact, relance) ne part vers ce domaine.
  return repos.conversations
    .eventsFor(conversation.id)
    .some((e) => e.classification === 'REPLIED' || e.classification === 'NEEDS_REVIEW' || e.classification === 'BOUNCED' || e.humanReviewed);
}

/**
 * L'état complet dont la politique d'envoi a besoin pour un brouillon donné.
 * Tout est relu au moment de l'envoi, jamais mémorisé : un opt-out arrivé
 * entre l'approbation et l'envoi doit compter.
 */
export function policyStateFor(
  repos: Repositories,
  config: AtlasConfig,
  draft: Pick<OutreachDraftRow, 'domain' | 'recipient' | 'companyName' | 'purpose'>,
  now: Date,
  transportConfigured: boolean,
): SendPolicyState {
  const attribution = repos.salesEngine.attributionFor(draft.domain);
  const segment = attribution?.segmentId ? repos.salesEngine.segment(attribution.segmentId) : null;
  const suppression = repos.salesEngine.isSuppressed({
    email: draft.recipient, domain: draft.domain, company: draft.companyName,
  });
  const log = repos.salesLoop.sentLog(200).filter((row) => row.phase === 'SENT' && row.occurredAt);
  const lastSentAt = log.map((r) => r.occurredAt!).sort().at(-1) ?? null;
  return {
    now,
    outboundEnabled: config.sales.outboundEnabled,
    engineMode: config.sales.engineMode,
    globalPause: readGlobalPause(repos),
    campaign: segment ? { approvedForSend: segment.approvedForSend, status: segment.status } : null,
    suppressed: {
      suppressed: suppression.suppressed,
      detail: suppression.entry ? `${suppression.entry.kind} ${suppression.entry.value} — ${suppression.entry.reason}` : null,
    },
    replyReceived: replyReceivedFor(repos, draft.domain),
    purpose: draft.purpose === 'FOLLOW_UP' ? 'FOLLOW_UP' : 'FIRST_TOUCH',
    followUpsSent: repos.salesLoop.followUpsFor(draft.domain),
    sentToday: repos.salesLoop.sentSince(startOfUtcDay(now)),
    sentThisHour: repos.salesLoop.sentSince(new Date(now.getTime() - 3_600_000).toISOString()),
    lastSentAt,
    bounces: bounceCounts(repos, now),
    transportConfigured,
  };
}

// ─── Dépendances ─────────────────────────────────────────────────────────────

export interface DiscoveryResult {
  ran: boolean;
  reason: string;
  batchId: string | null;
  exitCode: number | null;
  costUsd: number | null;
  /**
   * Vrai pour une indisponibilité structurelle — rien qu'une reprise demain ne
   * répare — par opposition à une condition qui peut changer d'elle-même
   * (budget épuisé, fournisseur en pause). Le distinguer est ce qui évite de
   * reproposer la même tâche vouée à échouer chaque jour au lieu de nommer la
   * décision humaine qu'elle attend.
   */
  needsHuman?: boolean;
  /** Découverte serveur : les prospects versés depuis l'expansion (plusieurs lots possibles). */
  promotedIds?: string[];
}

export interface SalesEngineDeps {
  repos: Repositories;
  config: AtlasConfig;
  logger: Logger;
  now?: () => Date;
  /** La boîte à lire. Par défaut Gmail, en lecture seule. */
  inbox?: () => MailInboxProvider;
  /** L'expéditeur, portées vérifiées. Par défaut Gmail, ou l'expéditeur à blanc. */
  outbound?: () => Promise<MailOutboundProvider>;
  /** La découverte. Par défaut `scripts/sales-batch.ts`, lancé tel quel. */
  discovery?: (input: { budgetUsd: number; segment: SalesSegment | null; heartbeat: () => void }) => Promise<DiscoveryResult>;
  /** La racine du dépôt, où vivent les scripts. */
  sourceRoot?: string;
}

const defaultInbox = (logger: Logger) => (): MailInboxProvider => new GmailInboxProvider({ logger });

/**
 * L'expéditeur réel n'existe que si l'interrupteur est levé et le mode est
 * PRODUCTION ; sinon l'expéditeur à blanc, qui ne poste rien. La vérification
 * des portées interroge le jeton réel — un refus survient avant toute
 * réservation de place d'envoi.
 */
export const defaultOutbound = (config: AtlasConfig) => async (): Promise<MailOutboundProvider> => {
  if (!config.sales.outboundEnabled || config.sales.engineMode !== 'PRODUCTION') return new DryRunOutboundProvider();
  const gmail = new GmailOutboundProvider({});
  try {
    await gmail.verifyScopes();
  } catch {
    /* le statut dira ce qui manque ; rien ne part */
  }
  return gmail;
};

/**
 * La découverte, telle qu'elle existe : le script de lot, avec ses gardes,
 * son preflight et son plafond. Sur un serveur qui n'a que `dist/`, ou sans
 * `tsx`, elle ne tourne pas — et le dit, au lieu d'inventer une variante.
 */
export const defaultDiscovery = (deps: { config: AtlasConfig; logger: Logger; sourceRoot: string; repos: Repositories }) =>
  async (input: { budgetUsd: number; segment: SalesSegment | null; heartbeat: () => void }): Promise<DiscoveryResult> => {
    const script = join(deps.sourceRoot, 'scripts', 'sales-batch.ts');
    if (!existsSync(script)) {
      // L'image serveur est volontairement dist-only (voir docs/OPERATOR.md) :
      // ni `scripts/` ni `tsx`. La découverte y passe par le graphe
      // d'expansion : les candidats qualifiés des tours SALES terminés sont
      // versés au registre commercial (provenance, dédoublonnage, $0). Rien à
      // verser n'est pas une attente humaine : la fabrique pose elle-même les
      // expansions qui nourriront le passage suivant.
      const { promoted } = promoteExpansionBacklog(deps.repos, { limit: 50 });
      if (promoted.length === 0) {
        return { ran: false, reason: 'aucun candidat d’expansion qualifié à verser (image serveur : découverte par le graphe)', batchId: null, exitCode: null, costUsd: 0 };
      }
      const batchId = deps.repos.sales.get(promoted[0]!)?.batchId ?? null;
      return { ran: true, reason: `${promoted.length} prospect(s) versé(s) depuis l’expansion`, batchId, exitCode: 0, costUsd: 0, promotedIds: promoted };
    }
    if (deps.config.llm.mode !== 'live') {
      return { ran: false, reason: `mode LLM « ${deps.config.llm.mode} », pas « live »`, batchId: null, exitCode: null, costUsd: null };
    }
    const before = deps.repos.sales.batchIds();
    const args = [
      '--import', 'tsx', script, '--go',
      `--budget=${input.budgetUsd.toFixed(2)}`,
      ...(input.segment ? [`--segment=${input.segment.id}`] : []),
    ];
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, args, {
        cwd: deps.sourceRoot,
        env: { ...process.env, ATLAS_DB_PATH: deps.config.paths.databaseFile },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const beat = setInterval(input.heartbeat, 5_000);
      beat.unref?.();
      const timer = setTimeout(() => child.kill('SIGTERM'), deps.config.sales.wallClockMs + 60_000);
      child.stdout.on('data', (chunk: Buffer) => deps.logger.debug('sales-batch', { line: chunk.toString('utf8').trimEnd().slice(0, 400) }));
      child.stderr.on('data', (chunk: Buffer) => deps.logger.warn('sales-batch stderr', { line: chunk.toString('utf8').trimEnd().slice(0, 400) }));
      child.on('exit', (code) => {
        clearInterval(beat);
        clearTimeout(timer);
        resolve(code);
      });
      child.on('error', () => {
        clearInterval(beat);
        clearTimeout(timer);
        resolve(null);
      });
    });
    const after = deps.repos.sales.batchIds();
    const batchId = after.find((id) => !before.includes(id)) ?? null;
    return {
      ran: true,
      reason: exitCode === 0 ? 'lot terminé' : `lot sorti avec le code ${exitCode ?? 'inconnu'}`,
      batchId,
      exitCode,
      costUsd: null,
    };
  };

// ─── Les segments à découvrir ────────────────────────────────────────────────

/** Ce que le lot actuel sait chercher : la France. Le reste attend, et le dit. */
export function segmentSupportedByBatch(segment: SalesSegment): boolean {
  if (segment.countries.length === 0) return true;
  return segment.countries.some((c) => /^(fr|france|français|francais)$/i.test(c.trim()));
}

/**
 * Le segment du jour : parmi les segments vivants, pondérés par leur poids
 * d'exploration et la stratégie, en rotation déterministe par jour — le même
 * jour choisit le même segment, deux jours consécutifs n'en choisissent pas
 * forcément le même.
 */
export function pickSegmentForDiscovery(segments: SalesSegment[], strategy: Strategy, now: Date): SalesSegment | null {
  const live = segments.filter((s) => ['TESTING', 'VALIDATED', 'SCALE'].includes(s.status));
  if (live.length === 0) return null;
  const weighted = live.map((s) => ({
    key: s.id,
    weight: Math.max(0, s.explorationWeight * (strategy.segmentWeights[s.id] ?? 1)),
  }));
  const day = Math.floor(now.getTime() / 86_400_000);
  const chosen = chooseVariant(`discovery:${day}`, weighted);
  return live.find((s) => s.id === chosen) ?? live[0]!;
}

// ─── Les handlers ────────────────────────────────────────────────────────────

export interface SendCycleReport {
  considered: number;
  sent: number;
  simulated: number;
  blocked: Array<{ draftId: string; domain: string; reasons: string[] }>;
  failed: Array<{ draftId: string; domain: string; error: string }>;
  transport: string;
}

const move = (repos: Repositories, domain: string, to: LoopState, reason: string) => {
  const from = repos.salesLoop.currentState(domain) as LoopState | null;
  const check = canTransitionLoop(from, to);
  if (!check.allowed) return false;
  repos.salesLoop.recordTransition({ domain, fromState: from, toState: to, reason, actor: ACTOR, runId: null });
  return true;
};

/**
 * Après une réponse : plus aucune relance ne doit partir. Les brouillons de
 * relance encore ouverts sont abandonnés, avec le motif — jamais effacés.
 */
export function cancelFollowUps(repos: Repositories, domain: string, reason: string): number {
  let cancelled = 0;
  for (const state of ['READY_FOR_APPROVAL', 'APPROVED_TO_SEND']) {
    for (const draft of repos.salesLoop.draftsInState(state)) {
      if (draft.domain !== canonicalDomainOf(domain) || draft.purpose !== 'FOLLOW_UP') continue;
      const decided = repos.salesLoop.decideDraft({ draftId: draft.id, decision: 'ABANDONED', decidedBy: ACTOR, note: reason });
      if (decided.applied) cancelled += 1;
    }
  }
  return cancelled;
}

/** Les conséquences d'une réponse importée, tirées une seule fois par événement. */
export function applyReplyConsequences(
  repos: Repositories,
  reply: InboxSyncReport['imported'][number],
): { intent: ReplyIntent; cancelledFollowUps: number; suppressed: boolean; hotLead: boolean } {
  const verdict = classifyReplyIntent({
    subject: reply.subject, body: reply.body, sender: reply.sender,
    classification: reply.classification as 'BOUNCED' | 'AUTO_REPLY' | 'REPLIED' | 'NEEDS_REVIEW',
  });
  let suppressed = false;
  let cancelled = 0;

  if (verdict.intent === 'OPT_OUT') {
    repos.salesEngine.suppress({ kind: 'EMAIL', value: reply.sender, reason: 'OPT_OUT', source: 'reply', evidence: reply.subject ?? null, createdBy: ACTOR });
    repos.salesEngine.suppress({ kind: 'DOMAIN', value: reply.domain, reason: 'OPT_OUT', source: 'reply', evidence: reply.subject ?? null, createdBy: ACTOR });
    repos.sales.recordOutreach({ domain: reply.domain, kind: 'DO_NOT_CONTACT', recordedBy: ACTOR, channel: 'email', note: 'opt-out reçu' });
    move(repos, reply.domain, 'BLOCKED', 'opt-out reçu');
    suppressed = true;
  } else if (verdict.intent === 'BOUNCE') {
    repos.salesEngine.suppress({ kind: 'EMAIL', value: reply.sender.includes('@') ? reply.sender : `bounce@${reply.domain}`, reason: 'BOUNCE', source: 'reply', evidence: reply.subject ?? null, createdBy: ACTOR });
    move(repos, reply.domain, 'ACTION_REQUIRED', 'rebond');
    suppressed = true;
  } else if (verdict.classification === 'REPLIED'
    || (reply.classification === 'NEEDS_REVIEW' && STOP_FOLLOW_UP_INTENTS.includes(verdict.intent))) {
    // Une réponse à relire (rapprochement incertain) sort aussi la boucle de
    // l'attente : sans quoi le worker de relance la croyait encore silencieuse.
    move(repos, reply.domain, 'REPLIED', `réponse ${verdict.intent}${reply.classification === 'NEEDS_REVIEW' ? ' (à relire)' : ''}`);
  }

  if (STOP_FOLLOW_UP_INTENTS.includes(verdict.intent)) {
    cancelled = cancelFollowUps(repos, reply.domain, `réponse ${verdict.intent} reçue`);
  }
  const hotLead = HOT_LEAD_INTENTS.includes(verdict.intent);
  if (hotLead) repos.salesEngine.reopenLead(reply.domain);

  return { intent: verdict.intent, cancelledFollowUps: cancelled, suppressed, hotLead };
}

export function createSalesEngineHandlers(deps: SalesEngineDeps): Record<string, (task: TaskRow, context: WorkerContext) => Promise<WorkerOutcome>> {
  const { repos, config } = deps;
  const now = deps.now ?? (() => new Date());
  const inbox = deps.inbox ?? defaultInbox(deps.logger);
  const outbound = deps.outbound ?? defaultOutbound(config);
  const sourceRoot = deps.sourceRoot ?? process.cwd();
  const discovery = deps.discovery ?? defaultDiscovery({ config, logger: deps.logger, sourceRoot, repos });

  const replySync = async (): Promise<WorkerOutcome> => {
    const provider = inbox();
    let report: InboxSyncReport;
    try {
      report = await syncSalesInbox(repos, provider, { mailbox: process.env.GMAIL_USER?.trim() ?? '', engineMode: config.sales.engineMode });
    } catch (error) {
      // Réseau, jeton expiré, quota : la boîte n'est pas lisible maintenant.
      // La friction est consignée pour la ligne SYSTÈME, et la tâche échoue
      // proprement — le daemon la reprendra avec son délai, sans rien perdre :
      // le curseur n'a pas bougé.
      const detail = describeError(error);
      repos.salesEngine.recordFriction({ kind: 'GMAIL_UNAVAILABLE', detail });
      return { kind: 'FAILED', errorCode: 'GMAIL_SYNC_FAILED', errorMessage: detail };
    }
    if (!report.ran) {
      // Deux « rien à faire » qui ne se ressemblent pas : sans identifiants, la
      // boîte est illisible — friction, pour la ligne SYSTÈME. Sans conversation
      // ouverte, il n'y a simplement rien à rapprocher : la boîte va bien, le
      // passage est consigné comme tel, et ce n'est une panne pour personne.
      const configured = provider.status().configured;
      if (!configured) {
        repos.salesEngine.recordFriction({ kind: 'GMAIL_UNAVAILABLE', detail: report.skipped });
      }
      return { kind: 'DONE', result: { ran: false, configured, skipped: report.skipped } };
    }
    const consequences = report.imported.map((reply) => ({ domain: reply.domain, ...applyReplyConsequences(repos, reply) }));
    return {
      kind: 'DONE',
      result: {
        ran: true, scanned: report.scanned, matched: report.matched, newEvents: report.newEvents,
        duplicates: report.duplicates, unmatched: report.unmatched, outbound: report.outbound,
        byClassification: report.byClassification,
        intents: consequences.map((c) => `${c.domain}:${c.intent}`),
        cancelledFollowUps: consequences.reduce((s, c) => s + c.cancelledFollowUps, 0),
        hotLeads: consequences.filter((c) => c.hotLead).length,
      },
    };
  };

  const followUps = async (): Promise<WorkerOutcome> => {
    const today = now().toISOString().slice(0, 10);
    const domains = new Set([
      ...repos.salesLoop.domainsInState('CONTACTED'),
      ...repos.salesLoop.domainsInState('WAITING_REPLY'),
    ]);
    let due = 0;
    let forbidden = 0;
    for (const domain of domains) {
      // Le self-test n'est relancé par personne : il ne compte pas comme un silence.
      if (isTechnicalDomain(domain)) continue;
      const contactedOn = repos.salesLoop.historyFor(domain).find((h) => h.toState === 'CONTACTED')?.occurredAt.slice(0, 10);
      if (!contactedOn) continue;
      const suppressed = repos.salesEngine.isSuppressed({ domain }).suppressed;
      const decision = evaluateFollowUp({
        domain,
        status: 'CONTACTED',
        contactedOn,
        followUpsSent: repos.salesLoop.followUpsFor(domain),
        doNotContact: suppressed || repos.sales.ledgerFor(domain)?.kind === 'DO_NOT_CONTACT' || replyReceivedFor(repos, domain),
        afterBusinessDays: config.sales.followUpAfterDays,
        today,
      });
      if (decision.verdict === 'FORBIDDEN') forbidden += 1;
      if (decision.verdict === 'DUE') {
        // La machine à états passe par WAITING_REPLY avant FOLLOW_UP_REQUIRED :
        // le silence est constaté, puis la relance est due.
        if (repos.salesLoop.currentState(domain) === 'CONTACTED') move(repos, domain, 'WAITING_REPLY', 'silence depuis le contact');
        if (move(repos, domain, 'FOLLOW_UP_REQUIRED', decision.reason)) due += 1;
      }
    }
    // Les relances dues n'écrivent rien : elles passent par un brouillon et
    // une approbation, comme un premier contact.
    return { kind: 'DONE', result: { considered: domains.size, due, forbidden } };
  };

  const send = async (_task: TaskRow, context: WorkerContext): Promise<WorkerOutcome> => {
    // Le premier contact se prépare avant l'envoi, mais ne part que par
    // `runSendCycle` : aucun autre chemin réseau n'existe.
    const provider = await outbound();
    const at = now();
    const firstTouch = materializeFirstTouchDrafts(repos, config, { now: at, transportConfigured: provider.status().configured });
    const report = await runSendCycle({ ...deps, sourceRoot }, { outbound: async () => provider, now: at, heartbeat: context.heartbeat });
    return { kind: 'DONE', result: { ...report, firstTouch: { ...firstTouch, skipped: firstTouch.skipped.length } } };
  };

  const discover = async (_task: TaskRow, context: WorkerContext): Promise<WorkerOutcome> => {
    if (!config.sales.discoveryEnabled) return { kind: 'DONE', result: { ran: false, reason: 'découverte désactivée' } };
    const today = startOfUtcDay(now());
    const spentToday = repos.llmCalls.usageSince(today).knownCostUsd;
    const remaining = Math.max(0, config.sales.dailyAiBudgetUsd - spentToday);
    // La découverte serveur (graphe d'expansion) ne coûte rien : le budget IA
    // du jour ne la suspend pas. Seul le lot en sous-processus le consomme.
    const serverDiscovery = !deps.discovery && !existsSync(join(sourceRoot, 'scripts', 'sales-batch.ts'));
    if (remaining < 0.05 && !serverDiscovery) {
      repos.salesEngine.recordFriction({ kind: 'BUDGET_EXHAUSTED', detail: `${spentToday.toFixed(2)} $ dépensés sur ${config.sales.dailyAiBudgetUsd.toFixed(2)} $` });
      return { kind: 'PAUSED_BUDGET', errorCode: 'DAILY_AI_BUDGET', errorMessage: `budget IA du jour épuisé (${spentToday.toFixed(2)} $)` };
    }
    const strategy = readStrategy(repos);
    const segment = pickSegmentForDiscovery(repos.salesEngine.segments(), strategy, now());
    if (segment && !segmentSupportedByBatch(segment)) {
      repos.salesEngine.recordFriction({
        kind: 'DISCOVERY_UNAVAILABLE', segmentId: segment.id,
        detail: `segment ${segment.name} : pays ${segment.countries.join(', ')} hors du périmètre du lot actuel (France)`,
      });
      return { kind: 'DONE', result: { ran: false, reason: 'segment hors périmètre du lot', segmentId: segment.id } };
    }
    const budget = Math.min(remaining, config.sales.maxBudgetUsd > 0 ? Math.max(config.sales.maxBudgetUsd, 0.12) : remaining);
    const result = await discovery({ budgetUsd: budget, segment, heartbeat: () => void context.heartbeat() });
    if (!result.ran) {
      repos.salesEngine.recordFriction({ kind: 'DISCOVERY_UNAVAILABLE', segmentId: segment?.id ?? null, detail: result.reason });
      if (result.needsHuman) {
        // DONE dirait « rien à signaler » : faux — une personne doit lancer la
        // découverte par le canal qui l'a réellement (atlas-cli, dépôt complet).
        // WAITING_HUMAN le nomme, au lieu de reproposer la même tâche vouée à
        // échouer identiquement demain.
        const cmd = `bash deployment/atlas-cli.sh npm run sales -- --go --budget=${budget.toFixed(2)}${segment ? ` --segment=${segment.id}` : ''}`;
        return {
          kind: 'WAITING_HUMAN',
          errorCode: 'DISCOVERY_MANUAL_REQUIRED',
          errorMessage: `${result.reason} — lancer manuellement : ${cmd}`,
        };
      }
      return { kind: 'DONE', result: { ran: false, reason: result.reason, segmentId: segment?.id ?? null } };
    }
    // Le lot ne connaît pas les segments : l'attribution se fait ici, sur ce
    // qu'il a réellement découvert.
    let attributed = 0;
    const discoveredProspects = result.promotedIds
      ? result.promotedIds.map((pid) => repos.sales.get(pid)).filter((p): p is NonNullable<typeof p> => Boolean(p))
      : result.batchId ? repos.sales.forBatch(result.batchId) : [];
    if (segment) {
      for (const prospect of discoveredProspects) {
        if (!prospect.domain) continue;
        repos.salesEngine.attribute({
          domain: prospect.domain, prospectId: prospect.id, segmentId: segment.id,
          angle: segment.offerAngle, discoveredAt: prospect.discoveredAt,
          messageVariant: chooseVariant(prospect.domain, Object.entries(strategy.messageAllocation).map(([key, weight]) => ({ key, weight }))),
        });
        attributed += 1;
        if (!prospect.contactEmail && !prospect.contactPage) {
          repos.salesEngine.recordFriction({ kind: 'CONTACT_NOT_FOUND', domain: prospect.domain, segmentId: segment.id });
        }
        if (!prospect.country) repos.salesEngine.recordFriction({ kind: 'COUNTRY_UNCERTAIN', domain: prospect.domain, segmentId: segment.id });
      }
    }
    if (result.exitCode !== 0) {
      repos.salesEngine.recordFriction({ kind: 'LLM_FAILURE', segmentId: segment?.id ?? null, detail: result.reason });
    }
    return { kind: 'DONE', result: { ran: true, batchId: result.batchId, exitCode: result.exitCode, discovered: discoveredProspects.length, attributed, segmentId: segment?.id ?? null, costUsd: result.costUsd ?? null, messagesSent: 0 } };
  };

  const analytics = async (): Promise<WorkerOutcome> => {
    const at = now();
    const alarm = deliverabilityAlarm(bounceCounts(repos, at), { rate: config.sales.bouncePauseRate, minSample: config.sales.bounceMinSample });
    let autoPaused = false;
    if (alarm.alarm && !readGlobalPause(repos).paused) {
      setGlobalPause(repos, true, ACTOR, `AUTO_PAUSE_BOUNCE — ${alarm.reason}`);
      repos.ops.raiseAlertOnce({ level: 'critical', title: 'Envois en pause : trop de rebonds', detail: alarm.reason, source: ACTOR });
      autoPaused = true;
    }
    const frictions = repos.salesEngine.frictionCounts(daysAgo(at, 7));
    const discovered = repos.sales.discoveredSince(daysAgo(at, 7)).length;
    const contacted = repos.salesEngine.attributions({ contactedSince: daysAgo(at, 7) }).length;
    const insights = engineeringInsights(frictions, { discovered, contacted });
    for (const insight of insights) repos.salesEngine.upsertInsight(insight);
    repos.salesEngine.pruneFrictions(daysAgo(at, 90));
    return { kind: 'DONE', result: { bounceRate: alarm.rate, autoPaused, insights: insights.length, frictions } };
  };

  const optimize = async (): Promise<WorkerOutcome> => {
    const outcome = runOptimizationCycle(repos, config, now());
    return { kind: 'DONE', result: { proposed: outcome.proposed, insufficient: outcome.insufficient.length } };
  };

  return {
    [SALES_ENGINE_TASKS.REPLY_SYNC]: replySync,
    [SALES_ENGINE_TASKS.FOLLOW_UP]: followUps,
    [SALES_ENGINE_TASKS.SEND]: send,
    [SALES_ENGINE_TASKS.DISCOVERY]: discover,
    [SALES_ENGINE_TASKS.ANALYTICS]: analytics,
    [SALES_ENGINE_TASKS.OPTIMIZATION]: optimize,
  };
}

// ─── Le premier contact automatique ──────────────────────────────────────────

export type FirstTouchRecommendation = NonNullable<Parameters<typeof buildOutreachDraft>[0]['recommendations']>[number];

export const FIRST_TOUCH_ACTOR = 'sales-engine:first-touch';
export const AUTO_APPROVAL_ACTOR = 'sales-engine:auto-approval';
const TIER_ORDER: Record<string, number> = { PRIORITY: 0, GOOD_FIT: 1, WATCH: 2 };

const byTierThenScore = (a: SalesProspect, b: SalesProspect): number =>
  (TIER_ORDER[a.tier ?? ''] ?? 3) - (TIER_ORDER[b.tier ?? ''] ?? 3)
  || (b.score ?? -1) - (a.score ?? -1)
  || (a.domain ?? '').localeCompare(b.domain ?? '')
  || a.id.localeCompare(b.id);

const FIRST_TOUCH_COMMERCIAL_RELATIONSHIP_TYPES = new Set<string>([
  'DISTRIBUTOR', 'RESELLER', 'INTEGRATOR', 'IMPORTER', 'WHOLESALER', 'INSTALLER',
  'MAINTENANCE_PARTNER', 'OEM_PARTNER', 'COMPLEMENTARY_VENDOR', 'LIKELY_CUSTOMER', 'VISIBLE_PARTNER',
]);

/**
 * L'échantillon par défaut vient du graphe d'expansion du prospect lui-même.
 * Une relation générique de segment, un concurrent ou une relation inférée ne
 * suffit jamais : il faut une cible commerciale vérifiée et une source officielle.
 */
export function registryRecommendationsFor(repos: Repositories, prospect: SalesProspect): FirstTouchRecommendation[] {
  if (!prospect.domain) return [];
  const own = canonicalDomainOf(prospect.domain);
  const isDomainLike = (value: string): boolean =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(value.trim());
  const hasThreeWords = (value: string): boolean => value.trim().split(/\s+/).filter(Boolean).length >= 3;

  const relationships = repos.expansion.relationshipsOf(own)
    .filter((r) => {
      if (canonicalDomainOf(r.sourceKey) !== own) return false;
      if (r.status !== 'VERIFIED' || r.sourceTrust !== 'OFFICIAL') return false;
      if (!FIRST_TOUCH_COMMERCIAL_RELATIONSHIP_TYPES.has(r.relationshipType)) return false;
      if (!/^https?:\/\//i.test(r.evidenceUrl) || !hasThreeWords(r.evidenceSummary)) return false;
      if (!r.targetName.trim() || !isDomainLike(r.targetKey)) return false;
      const targetDomain = canonicalDomainOf(r.targetKey);
      return Boolean(targetDomain)
        && targetDomain !== own
        && !targetDomain.endsWith(`.${own}`)
        && !own.endsWith(`.${targetDomain}`);
    })
    .sort((a, b) =>
      b.confidence - a.confidence
      || canonicalDomainOf(a.targetKey).localeCompare(canonicalDomainOf(b.targetKey))
      || a.evidenceUrl.localeCompare(b.evidenceUrl));

  const out: FirstTouchRecommendation[] = [];
  const seen = new Set<string>();
  for (const relationship of relationships) {
    const domain = canonicalDomainOf(relationship.targetKey);
    if (seen.has(domain)) continue;
    seen.add(domain);
    const evidence = relationship.evidenceSummary.trim();
    out.push({
      company: relationship.targetName.trim(),
      domain,
      sourceUrl: relationship.evidenceUrl,
      evidenceQuote: evidence,
      fitReason: evidence,
    });
    if (out.length === 3) break;
  }
  return out.length >= 2 ? out : [];
}

/**
 * Un dossier déclaré éligible par la fabrique, que la rédaction refuse : il
 * n'est pas mis en file, il repasse à l'enrichissement avec le motif. Sans
 * verdict de fabrique, rien n'est écrit.
 */
function backToEnrichment(repos: Repositories, domain: string, blockers: string[]): void {
  const v = repos.revenueFactory.verdict(domain);
  if (!v) return;
  repos.revenueFactory.record({
    domain, prospectId: v.prospectId, companyName: v.companyName, corporateGroup: v.corporateGroup,
    classification: 'NEEDS_ENRICHMENT', sendEligible: false, revenueScore: v.revenueScore, scoreMethod: v.scoreMethod,
    qualificationReason: v.qualificationReason, evidence: v.evidence, contactRoutes: v.contactRoutes,
    recommendations: v.recommendations, dedupeResult: v.dedupeResult, blockers,
    nextAction: 'rédaction refusée : enrichir puis repasser', processingCostUsd: 0, pagesFetched: 0, runId: null,
  });
}

export interface FirstTouchReport {
  considered: number;
  drafted: number;
  autoApproved: number;
  skipped: Array<{ domain: string; reasons: string[] }>;
}

/**
 * Du prospect canonique au brouillon `outreach_drafts`, pour ceux — et
 * seulement ceux — que toutes les gardes laissent passer. Le brouillon naît
 * READY_FOR_APPROVAL. Il n'est approuvé automatiquement que si
 * `sales.humanApprovalRequired` est faux ET que la politique d'envoi entière
 * ne trouve rien à redire ; l'approbation est alors signée et publiée.
 * Rien ne part d'ici : `runSendCycle` reste le seul chemin d'envoi.
 */
export function materializeFirstTouchDrafts(
  repos: Repositories,
  config: AtlasConfig,
  options: {
    now: Date;
    transportConfigured: boolean;
    limit?: number;
    recommendationsFor?: (prospect: SalesProspect) => FirstTouchRecommendation[];
  },
): FirstTouchReport {
  const report: FirstTouchReport = { considered: 0, drafted: 0, autoApproved: 0, skipped: [] };
  const recommendationsFor = options.recommendationsFor ?? ((p: SalesProspect) => registryRecommendationsFor(repos, p));
  const limit = options.limit ?? config.sales.maxNewOutreachPerDay;
  const done = new Set<string>();

  for (const p of repos.sales.discoveredSince(null).sort(byTierThenScore)) {
    if (report.drafted >= limit) break;
    if (!p.domain || done.has(canonicalDomainOf(p.domain))) continue;
    const domain = canonicalDomainOf(p.domain);
    done.add(domain);
    report.considered += 1;

    const reasons = [...repos.sales.firstTouchReadiness(p.id).blockers];
    // La boucle B ne consomme que ce que la fabrique (boucle A) a déclaré
    // SEND_ELIGIBLE. Sans verdict (fabrique jamais passée), les gardes
    // ci-dessous restent seules juges, comme avant.
    const factory = repos.revenueFactory.verdict(domain);
    if (factory && !factory.sendEligible) reasons.push('FACTORY_NOT_ELIGIBLE');
    if (reasons.length === 0) {
      const drafts = repos.salesLoop.draftsForDomain(domain);
      if (repos.salesEngine.isSuppressed({ email: p.contactEmail, domain, company: p.companyName }).suppressed) reasons.push('SUPPRESSED');
      if (replyReceivedFor(repos, domain)) reasons.push('REPLY_RECEIVED');
      if (repos.salesLoop.lastSentTo(domain) !== null) reasons.push('ALREADY_SENT');
      const firstTouchDrafts = drafts.filter((d) => d.purpose === 'FIRST_TOUCH');
      const hasActiveFirstTouch = firstTouchDrafts.some((d) => d.state !== 'ABANDONED');
      const loop = repos.salesLoop.currentState(domain);
      if (firstTouchDrafts.length > 0 && !hasActiveFirstTouch && loop === 'READY_FOR_APPROVAL') {
        move(repos, domain, 'BLOCKED', 'brouillon abandonné obsolète');
        move(repos, domain, 'QUALIFYING', 'requalification après brouillon abandonné');
      }
      if (hasActiveFirstTouch) reasons.push('PRIOR_FIRST_TOUCH');
      const loopAfterRecovery = repos.salesLoop.currentState(domain);
      if (loopAfterRecovery !== null && loopAfterRecovery !== 'QUALIFYING') reasons.push(`LOOP_${loopAfterRecovery}`);
    }
    if (reasons.length > 0) {
      report.skipped.push({ domain, reasons });
      continue;
    }

    const recommendations = recommendationsFor(p);
    const outcome = buildOutreachDraft({
      company: p.companyName,
      website: p.website,
      facts: repos.sales.evidenceFor(p.id).filter(isCommercialEvidence).map(outreachFactFrom),
      contact: {
        name: p.contactName, role: p.contactRole, email: p.contactEmail, phone: p.contactPhone,
        contactPage: p.contactPage, sourceUrl: p.contactSourceUrl, confidence: p.contactConfidence ?? 0,
        named: Boolean(p.contactName),
      },
      whyThisCompany: p.whyFit ?? '',
      senderName: config.sales.senderName,
      offer: { priceEur: 49, deliveryHours: 48, freePreviewCount: 3, recurringAvailable: true },
      recommendations,
    });
    if (!outcome.draft || !personalizationIsGrounded(outcome.draft)) {
      const refusal = [outcome.refusal ?? 'NOT_GROUNDED', outcome.reason];
      report.skipped.push({ domain, reasons: refusal });
      backToEnrichment(repos, domain, [outcome.refusal ?? 'NOT_GROUNDED']);
      continue;
    }

    const d = outcome.draft;
    const sources = [
      { quote: d.evidenceExcerpt, sourceUrl: d.sourceUsedForPersonalization },
      ...d.recommendations.map((r) => ({ quote: r.fitReason, sourceUrl: r.sourceUrl })),
    ];
    // La porte qualité relit le texte produit, avant la file : destinataire
    // lu sur le site, 2 recommandations citées, provenance, personnalisation,
    // aucune intention d'achat affirmée, longueur. Un refus ne met rien en
    // file et renvoie le dossier à l'enrichissement, motif compris.
    const quality = validateOutreachDraft({
      recipient: p.contactEmail!, subject: d.subject, body: d.messageEmail, sources,
      observedEmail: p.contactObserved ? p.contactEmail : null, domain,
    });
    if (!quality.ok) {
      report.skipped.push({ domain, reasons: quality.reasons.map((r) => `QUALITY_GATE:${r}`) });
      backToEnrichment(repos, domain, quality.reasons.map((r) => `QUALITY_GATE:${r}`));
      continue;
    }
    const saved = repos.salesLoop.saveDraft({
      domain, companyName: p.companyName, recipient: p.contactEmail!, subject: d.subject, body: d.messageEmail,
      purpose: 'FIRST_TOUCH', conversionScore: p.score, rationale: p.whyFit,
      sources,
      createdBy: FIRST_TOUCH_ACTOR,
    });
    if (repos.salesLoop.currentState(domain) === null) move(repos, domain, 'QUALIFYING', 'prospect canonique prêt au premier contact');
    move(repos, domain, 'READY_FOR_APPROVAL', `brouillon ${saved.id}`);
    report.drafted += 1;
  }

  report.autoApproved = autoApproveFirstTouch(repos, config, options.now, options.transportConfigured);
  return report;
}

/**
 * L'approbation automatique, quand la configuration la permet. Seuls les
 * brouillons de ce pipeline, et seulement ceux que la politique d'envoi
 * complète laisserait partir maintenant. Chaque approbation est consignée
 * (décision signée) et publiée (événement).
 */
export function autoApproveFirstTouch(repos: Repositories, config: AtlasConfig, now: Date, transportConfigured: boolean): number {
  if (config.sales.humanApprovalRequired) return 0;
  const policy = sendPolicyOf(config);
  let approved = 0;
  for (const draft of repos.salesLoop.draftsInState('READY_FOR_APPROVAL')) {
    if (draft.createdBy !== FIRST_TOUCH_ACTOR || draft.purpose !== 'FIRST_TOUCH') continue;
    const verdict = evaluateSendPolicy(policy, policyStateFor(repos, config, draft, now, transportConfigured));
    if (verdict.blocks.length > 0) continue;
    if (repos.sales.ledgerFor(draft.domain) !== null || repos.salesLoop.lastSentTo(draft.domain) !== null) continue;
    const note = 'humanApprovalRequired=false · politique d’envoi sans blocage · faits et échantillon sourcés';
    const decided = repos.salesLoop.decideDraft({ draftId: draft.id, decision: 'APPROVED_TO_SEND', decidedBy: AUTO_APPROVAL_ACTOR, note });
    if (!decided.applied) continue;
    move(repos, draft.domain, 'APPROVED_TO_SEND', `approbation automatique de ${draft.id}`);
    repos.events.append({
      id: id('evt'), type: 'system.alert', severity: 'info', source: AUTO_APPROVAL_ACTOR, missionId: null, agentKey: null,
      message: `Premier contact approuvé automatiquement — ${draft.domain} (${draft.id})`,
      payload: { draftId: draft.id, domain: draft.domain, note }, createdAt: nowIso(),
    });
    approved += 1;
  }
  return approved;
}

// ─── Le cycle d'envoi ────────────────────────────────────────────────────────

/**
 * Envoyer ce qui est approuvé — et seulement si tout le reste est vrai.
 *
 * L'ordre des vérifications est celui des conséquences : la politique
 * globale (interrupteur, mode, pause, campagne, suppression, fenêtre,
 * plafonds) avant tout accès à la place d'envoi ; puis le registre et
 * l'historique ; puis la réservation exactement-une-fois ; puis le transport.
 * Un refus à n'importe quel étage laisse le brouillon intact et le dit.
 */
export async function runSendCycle(
  deps: SalesEngineDeps,
  options: { outbound: () => Promise<MailOutboundProvider>; now: Date; heartbeat?: () => boolean; limit?: number },
): Promise<SendCycleReport> {
  const { repos, config } = deps;
  const report: SendCycleReport = { considered: 0, sent: 0, simulated: 0, blocked: [], failed: [], transport: 'aucun' };
  const approved = repos.salesLoop.draftsInState('APPROVED_TO_SEND');
  if (approved.length === 0) return report;

  const provider = await options.outbound();
  const transport = provider.status();
  report.transport = `${provider.id} · ${transport.code}`;
  const policy = sendPolicyOf(config);

  for (const draft of approved.slice(0, options.limit ?? 50)) {
    report.considered += 1;
    options.heartbeat?.();

    const state = policyStateFor(repos, config, draft, options.now, transport.configured);
    const verdict: SendPolicyVerdict = evaluateSendPolicy(policy, state);
    const reasons: string[] = verdict.blocks.map((b) => b.reason);

    // Le registre est réinterrogé ici, et non seulement à la rédaction : un
    // opt-out peut être arrivé entre l'approbation et l'envoi.
    if (repos.sales.ledgerFor(draft.domain)?.kind === 'DO_NOT_CONTACT') reasons.push('DO_NOT_CONTACT');
    // Un premier contact du pipeline automatique repasse la porte qualité au
    // moment de partir : le texte en file est celui qui a été validé, et le
    // destinataire est toujours l'adresse lue sur le site officiel. Dernière
    // porte, évaluée seulement quand plus rien d'autre ne retient l'envoi :
    // interrupteur fermé, rien n'est touché — un brouillon approuvé n'est
    // fermé qu'au moment où il aurait réellement pu partir.
    if (reasons.length === 0 && draft.createdBy === FIRST_TOUCH_ACTOR && draft.purpose === 'FIRST_TOUCH') {
      const quality = validateOutreachDraft({
        recipient: draft.recipient, subject: draft.subject, body: draft.body, sources: draft.sources,
        observedEmail: observedEmailFor(repos, draft.domain, draft.recipient), domain: draft.domain,
      });
      for (const r of quality.reasons) reasons.push(`QUALITY_GATE:${r}`);
    }
    if (draft.purpose !== 'FOLLOW_UP' && repos.salesLoop.lastSentTo(draft.domain) !== null) reasons.push('ALREADY_SENT');

    if (reasons.length > 0) {
      report.blocked.push({ draftId: draft.id, domain: draft.domain, reasons });
      // Un blocage structurel (registre, suppression, réponse) ferme le brouillon ;
      // un blocage de cadence (fenêtre, plafond) le laisse attendre le prochain cycle.
      const structural = reasons.some((r) => ['DO_NOT_CONTACT', 'SUPPRESSED', 'REPLY_RECEIVED', 'ALREADY_SENT', 'MAX_FOLLOWUPS_REACHED'].includes(r)
        || r.startsWith('QUALITY_GATE:'));
      if (structural) {
        repos.salesLoop.decideDraft({ draftId: draft.id, decision: 'ABANDONED', decidedBy: ACTOR, note: reasons.join(', ') });
        move(repos, draft.domain, 'BLOCKED', reasons.join(', '));
      }
      repos.salesEngine.recordFriction({ kind: 'SEND_BLOCKED', domain: draft.domain, detail: reasons.join(', ') });
      continue;
    }

    const claim = repos.salesLoop.claimSend({
      domain: draft.domain, recipient: draft.recipient, subject: draft.subject, body: draft.body,
      purpose: draft.purpose, claimedBy: ACTOR,
    });
    if (!claim.claimed) {
      report.blocked.push({ draftId: draft.id, domain: draft.domain, reasons: [`CLAIM_REFUSED: ${claim.reason}`] });
      continue;
    }

    move(repos, draft.domain, 'SENDING', `envoi de ${draft.id}`);
    try {
      const receipt = await provider.sendEmail({ to: draft.recipient, subject: draft.subject, bodyText: draft.body });
      repos.salesLoop.recordSendResult({
        idempotencyKey: claim.idempotencyKey, phase: 'SENT',
        externalMessageId: receipt.externalMessageId, externalThreadId: receipt.externalThreadId,
      });
      repos.salesLoop.markDraftSent(draft.id);
      repos.sales.recordOutreach({
        domain: draft.domain, kind: 'CONTACTED', recordedBy: ACTOR, channel: 'email',
        note: receipt.simulated ? 'simulation : aucun message réel' : draft.subject,
      });
      repos.conversations.open({
        domain: draft.domain, companyName: draft.companyName, channel: 'email',
        destination: draft.recipient, source: ACTOR,
      });
      repos.salesEngine.markContacted(draft.domain, options.now.toISOString());
      move(repos, draft.domain, 'CONTACTED', receipt.simulated ? 'simulé' : 'envoyé');
      if (receipt.simulated) report.simulated += 1;
      else report.sent += 1;
    } catch (error) {
      repos.salesLoop.recordSendResult({ idempotencyKey: claim.idempotencyKey, phase: 'FAILED', error: describeError(error) });
      move(repos, draft.domain, 'ACTION_REQUIRED', 'échec technique à l’envoi');
      report.failed.push({ draftId: draft.id, domain: draft.domain, error: describeError(error) });
    }
  }
  return report;
}

/** L'adresse lue sur le site officiel pour ce domaine, si c'est bien le destinataire. */
function observedEmailFor(repos: Repositories, domain: string, recipient: string): string | null {
  const want = recipient.trim().toLowerCase();
  const match = repos.sales.discoveredSince(null).find((p) => p.domain && canonicalDomainOf(p.domain) === domain
    && p.contactObserved && p.contactEmail?.trim().toLowerCase() === want);
  return match?.contactEmail ?? null;
}

// ─── Le planificateur ────────────────────────────────────────────────────────

export interface ScheduleReport {
  created: string[];
  existing: string[];
}

/**
 * Crée les tâches du cycle courant. Les clés de période rendent l'appel
 * idempotent : repasser toutes les cinq minutes ne crée rien deux fois, et
 * un redémarrage ne rejoue pas un cycle déjà consigné. Les cycles quotidiens
 * sont posés pour une heure fixe UTC ; un cycle manqué (serveur éteint) est
 * rattrapé au prochain passage de la même journée, pas au-delà.
 */
export function scheduleSalesCycle(repos: Repositories, config: AtlasConfig, now: Date): ScheduleReport {
  const report: ScheduleReport = { created: [], existing: [] };
  if (!config.sales.engineEnabled) return report;

  const dailyAt = (hourUtc: number): string => {
    const at = new Date(now);
    at.setUTCHours(hourUtc, 0, 0, 0);
    return (at.getTime() < now.getTime() ? now : at).toISOString();
  };

  const plan: Array<{ key: keyof typeof SALES_ENGINE_TASKS; availableAt: string; priority: number; maxAttempts: number }> = [
    { key: 'REPLY_SYNC', availableAt: now.toISOString(), priority: 30, maxAttempts: 3 },
    { key: 'SEND', availableAt: now.toISOString(), priority: 40, maxAttempts: 2 },
    { key: 'ANALYTICS', availableAt: now.toISOString(), priority: 10, maxAttempts: 2 },
    { key: 'FACTORY', availableAt: now.toISOString(), priority: 35, maxAttempts: 2 },
    { key: 'FOLLOW_UP', availableAt: dailyAt(6), priority: 20, maxAttempts: 2 },
    { key: 'DISCOVERY', availableAt: dailyAt(5), priority: 5, maxAttempts: 1 },
    { key: 'OPTIMIZATION', availableAt: dailyAt(7), priority: 5, maxAttempts: 2 },
  ];

  for (const step of plan) {
    if (step.key === 'DISCOVERY' && !config.sales.discoveryEnabled) continue;
    const idempotencyKey = periodKey(step.key.toLowerCase(), now, SALES_SCHEDULE[step.key]);
    const { created } = repos.tasks.create({
      taskType: SALES_ENGINE_TASKS[step.key],
      department: 'sales',
      workerType: 'DETERMINISTIC',
      priority: step.priority,
      payload: { scheduledBy: ACTOR, period: idempotencyKey },
      availableAt: step.availableAt,
      maxAttempts: step.maxAttempts,
      idempotencyKey,
      correlationId: idempotencyKey,
    });
    (created ? report.created : report.existing).push(idempotencyKey);
  }
  repos.settings.set(SALES_SETTINGS.LAST_CYCLES, { at: now.toISOString(), created: report.created.length }, ACTOR);
  return report;
}

// ─── L'optimisation ──────────────────────────────────────────────────────────

const emptyStats = (): SegmentStats => ({ contacted: 0, replied: 0, positive: 0, meetings: 0, clients: 0, revenue: 0 });

/**
 * Les statistiques par segment et par variante, depuis les attributions, les
 * réponses et les issues. Une entreprise compte dans le segment qui l'a
 * produite ; une réponse compte une fois par entreprise ; une issue compte
 * une fois par entreprise et par nature.
 */
export function gatherSalesStats(repos: Repositories, since: string | null): {
  bySegment: Map<string, SegmentStats>;
  byVariant: Map<string, VariantStats>;
  followUps: { sent: number; replied: number };
} {
  const attributions = repos.salesEngine.attributions({ contactedSince: since });
  const events = repos.conversations.eventsSince(since);
  const outcomes = repos.salesEngine.outcomes({ since });

  const intentByDomain = new Map<string, ReplyIntent[]>();
  for (const e of events) {
    if (e.classification !== 'REPLIED' && e.classification !== 'NEEDS_REVIEW') continue;
    const verdict = classifyReplyIntent({ subject: e.rawSubject, body: e.bodyExcerpt, sender: e.sender, classification: e.classification as 'REPLIED' | 'NEEDS_REVIEW' });
    const list = intentByDomain.get(e.domain) ?? [];
    list.push(verdict.intent);
    intentByDomain.set(e.domain, list);
  }
  const positive = (domain: string) =>
    (intentByDomain.get(domain) ?? []).some((i) => ['POSITIVE', 'INTERESTED_LATER', 'QUESTION'].includes(i));

  const bySegment = new Map<string, SegmentStats>();
  const byVariant = new Map<string, VariantStats>();
  for (const a of attributions) {
    const seg = a.segmentId ?? 'sans-segment';
    const stats = bySegment.get(seg) ?? emptyStats();
    stats.contacted += 1;
    if (intentByDomain.has(a.domain)) stats.replied += 1;
    if (positive(a.domain)) stats.positive += 1;
    const mine = outcomes.filter((o) => o.domain === a.domain);
    if (mine.some((o) => o.kind === 'MEETING_BOOKED' || o.kind === 'MEETING_DONE')) stats.meetings += 1;
    if (mine.some((o) => o.kind === 'WON')) {
      stats.clients += 1;
      stats.revenue += mine.filter((o) => o.kind === 'WON').reduce((s, o) => s + (o.revenueAmount ?? 0), 0);
    }
    bySegment.set(seg, stats);

    if (a.messageVariant) {
      const v = byVariant.get(a.messageVariant) ?? { key: a.messageVariant, ...emptyStats() };
      v.contacted += 1;
      if (intentByDomain.has(a.domain)) v.replied += 1;
      if (positive(a.domain)) v.positive += 1;
      if (mine.some((o) => o.kind === 'MEETING_BOOKED' || o.kind === 'MEETING_DONE')) v.meetings += 1;
      if (mine.some((o) => o.kind === 'WON')) {
        v.clients += 1;
        v.revenue += mine.filter((o) => o.kind === 'WON').reduce((s, o) => s + (o.revenueAmount ?? 0), 0);
      }
      byVariant.set(a.messageVariant, v);
    }
  }

  const followUpLog = repos.salesLoop.sentLog(1000).filter((r) => r.purpose === 'FOLLOW_UP' && r.phase === 'SENT' && (!since || (r.occurredAt ?? '') >= since));
  const followUps = {
    sent: followUpLog.length,
    replied: followUpLog.filter((r) => intentByDomain.has(r.domain)).length,
  };
  return { bySegment, byVariant, followUps };
}

export function runOptimizationCycle(repos: Repositories, config: AtlasConfig, now: Date): {
  proposed: number;
  insufficient: Array<{ subject: string; sample: number; needed: number }>;
} {
  const since = daysAgo(now, 90);
  const { bySegment, byVariant, followUps } = gatherSalesStats(repos, since);
  const segments = repos.salesEngine.segments().map((s) => ({
    id: s.id, name: s.name, status: s.status, explorationWeight: s.explorationWeight,
    stats: bySegment.get(s.id) ?? emptyStats(),
  }));
  const result = recommend({
    segments,
    variants: byVariant.size > 0 ? [{ dimension: 'message_variant', stats: [...byVariant.values()] }] : [],
    followUps: followUps.sent > 0 ? followUps : null,
    frictions: repos.salesEngine.frictionCounts(daysAgo(now, 30)),
    discovered: repos.sales.discoveredSince(daysAgo(now, 30)).length,
    contacted: repos.salesEngine.attributions({ contactedSince: daysAgo(now, 30) }).length,
  });
  let proposed = 0;
  for (const draft of result.recommendations) {
    const { created } = repos.salesEngine.propose({
      kind: draft.kind, title: draft.title, reason: draft.reason, evidence: draft.evidence,
      sampleSize: draft.sampleSize, expectedImpact: draft.expectedImpact, risk: draft.risk,
      change: draft.change ? { ...draft.change } : null, humanRequired: draft.humanRequired,
      fingerprint: draft.fingerprint,
    });
    if (created) proposed += 1;
  }
  repos.settings.set(SALES_SETTINGS.LAST_OPTIMIZATION, { at: now.toISOString(), proposed, insufficient: result.insufficient }, ACTOR);
  void config;
  return { proposed, insufficient: result.insufficient };
}

// ─── Les décisions humaines ──────────────────────────────────────────────────

export type RecommendationDecision = 'test' | 'approve' | 'reject';

/**
 * TESTER applique la moitié du pas proposé — une expérience bornée, versionnée,
 * réversible. VALIDER applique le pas entier. REFUSER ne touche à rien. Dans
 * tous les cas, la stratégie d'avant est gardée avec la raison, et la
 * recommandation porte la version qu'elle a produite.
 */
export function decideRecommendation(
  repos: Repositories,
  recommendationId: string,
  decision: RecommendationDecision,
  by: string,
  now: Date = new Date(),
): { recommendation: OptimizationRecommendation; applied: boolean; reason: string } {
  const recommendation = repos.salesEngine.recommendation(recommendationId);
  if (!recommendation) throw new Error(`recommandation inconnue : ${recommendationId}`);
  if (!['PROPOSED', 'TESTING'].includes(recommendation.status)) {
    return { recommendation, applied: false, reason: `déjà ${recommendation.status}` };
  }
  if (decision === 'reject') {
    return { recommendation: repos.salesEngine.setRecommendationStatus(recommendationId, 'REJECTED', by), applied: false, reason: 'refusée' };
  }

  const change = recommendation.change as unknown as StrategyChange | null;
  if (!change) {
    // Un insight ou un test de message n'a rien à appliquer : la décision est
    // prise, la mise en œuvre est humaine.
    const status = decision === 'test' ? 'TESTING' : 'APPROVED';
    return { recommendation: repos.salesEngine.setRecommendationStatus(recommendationId, status, by), applied: false, reason: 'aucun réglage à appliquer : décision consignée' };
  }

  const before = readStrategy(repos);
  const scaled: StrategyChange = decision === 'test' && typeof change.delta === 'number'
    ? { ...change, delta: Number((change.delta / 2).toFixed(4)) }
    : change;
  const outcome = applyStrategyChange(before, scaled);
  if (!outcome.applied) return { recommendation, applied: false, reason: outcome.reason };

  const metricsBefore = Object.fromEntries(
    [...gatherSalesStats(repos, daysAgo(now, 90)).bySegment.entries()].map(([k, v]) => [k, v]),
  );
  const version = repos.salesEngine.recordStrategyVersion({
    before: before as unknown as Record<string, unknown>,
    after: outcome.next as unknown as Record<string, unknown>,
    reason: `${decision === 'test' ? 'TEST' : 'VALIDATION'} de ${recommendation.title} — ${outcome.reason}`,
    recommendationId,
    metricsBefore,
    createdBy: by,
  });
  repos.settings.set(SALES_SETTINGS.STRATEGY, outcome.next, by);
  if (change.param === 'segmentWeights' && change.key) {
    const segment = repos.salesEngine.segment(change.key);
    if (segment) repos.salesEngine.setSegmentWeight(segment.id, outcome.next.segmentWeights[segment.id] ?? segment.explorationWeight);
  }
  const updated = repos.salesEngine.setRecommendationStatus(
    recommendationId, decision === 'test' ? 'TESTING' : 'APPROVED', by, { strategyVersionId: version.id },
  );
  return { recommendation: updated, applied: true, reason: `${outcome.reason} (version ${version.version})` };
}

/** Revenir à la stratégie d'avant une version : une nouvelle version, inverse, signée. */
export function rollbackStrategy(repos: Repositories, versionId: string, by: string, reason: string): { applied: boolean; reason: string } {
  const version = repos.salesEngine.strategyVersion(versionId);
  if (!version) return { applied: false, reason: `version inconnue : ${versionId}` };
  if (version.rolledBackAt) return { applied: false, reason: 'déjà annulée' };
  const current = readStrategy(repos);
  const restored = version.before as unknown as Strategy;
  repos.salesEngine.recordStrategyVersion({
    before: current as unknown as Record<string, unknown>,
    after: restored as unknown as Record<string, unknown>,
    reason: `ROLLBACK de la version ${version.version} — ${reason}`,
    recommendationId: version.recommendationId,
    createdBy: by,
    rollbackOf: version.id,
  });
  repos.settings.set(SALES_SETTINGS.STRATEGY, restored, by);
  repos.salesEngine.markRolledBack(version.id);
  if (version.recommendationId) repos.salesEngine.setRecommendationStatus(version.recommendationId, 'ROLLED_BACK', by);
  for (const [segmentId, weight] of Object.entries(restored.segmentWeights ?? {})) {
    if (repos.salesEngine.segment(segmentId)) repos.salesEngine.setSegmentWeight(segmentId, weight);
  }
  return { applied: true, reason: `stratégie restaurée avant la version ${version.version}` };
}

/**
 * Une issue commerciale, saisie par une personne. Elle est écrite dans la
 * table des issues, déclarée dans la conversation (état humain), et fait
 * avancer la boucle quand la transition existe. Rien n'est déduit : le
 * montant, la date, l'offre viennent de la saisie.
 */
export function recordSalesOutcome(
  repos: Repositories,
  input: {
    domain: string;
    kind: OutcomeKind;
    revenueAmount?: number | null;
    currency?: string | null;
    occurredAt?: string;
    offer?: string | null;
    segmentId?: string | null;
    by: string;
    note?: string | null;
  },
) {
  const outcome = repos.salesEngine.recordOutcome({ ...input, recordedBy: input.by });
  const conversation = repos.conversations.byDomain(input.domain)
    ?? repos.conversations.open({ domain: input.domain, companyName: input.domain, source: input.by }).conversation;
  const declared = input.kind === 'WON' ? 'WON' : input.kind === 'LOST' ? 'LOST' : 'MEETING_REQUESTED';
  repos.conversations.recordInboundEvent({
    conversationId: conversation.id,
    kind: 'MANUAL_NOTE',
    classification: 'REPLIED',
    confidence: 1,
    occurredAt: outcome.occurredAt,
    source: input.by,
    rawSubject: `${input.kind}${input.offer ? ` — ${input.offer}` : ''}`,
    sender: input.by,
    bodyExcerpt: input.note ?? null,
    signals: [input.kind],
    returnDate: null,
    humanReviewed: true,
    declaredStatus: declared,
    note: input.note ?? null,
  });
  if (input.kind === 'WON') move(repos, input.domain, 'WON', `client gagné — ${input.by}`);
  if (input.kind === 'LOST') move(repos, input.domain, 'LOST', `affaire perdue — ${input.by}`);
  repos.salesEngine.markLeadHandled(input.domain, input.by, input.kind);
  return outcome;
}
