/**
 * La boîte de réception commerciale.
 *
 * Le registre d'outreach dit à qui on a écrit. Cette vue dit ce qui en est
 * revenu, et surtout ce qu'il reste à faire — un tableau qui n'indique pas la
 * prochaine action se relit sans rien décider.
 *
 * Aucun modèle, aucune recherche, aucun envoi. La classification est celle du
 * module déterministe ; l'état se recalcule à la lecture.
 *
 *   sales-inbox                        la boîte
 *   sales-inbox sync                   ouvre les conversations manquantes
 *   sales-inbox record <domaine> ...   consigne un événement entrant
 */
import { readFileSync } from 'node:fs';
import { createLogger, canonicalDomainOf } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import {
  classifyInbound,
  deriveConversationState,
  requiresHumanJudgement,
  type ConversationEvent,
  type ConversationStatus,
  type InboundKind,
} from '../packages/departments/src/index.ts';

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m',
};

const [action = 'show', ...rest] = process.argv.slice(2);
const flag = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const logger = createLogger({ level: 'error', pretty: false });
const repos = createRepositories(process.env.ATLAS_DB_PATH ?? 'data/atlas.db', logger);
const today = flag('today') ?? new Date().toISOString().slice(0, 10);

/** L'état courant d'une conversation, recalculé depuis ses événements. */
function stateOf(conversationId: string) {
  const events: ConversationEvent[] = repos.conversations.eventsFor(conversationId).map((e) => ({
    kind: e.kind as InboundKind,
    classification: e.classification as ConversationEvent['classification'],
    occurredAt: e.occurredAt,
    returnDate: e.returnDate,
    humanReviewed: e.humanReviewed,
    declaredStatus: (e.declaredStatus as ConversationStatus | null) ?? null,
  }));
  return deriveConversationState(events, {
    today,
    ledgerFollowUpAt: repos.conversations.ledgerFollowUpFor(conversationId),
  });
}

if (action === 'sync') {
  // Ouvre une conversation pour chaque entreprise à qui l'on a écrit et qui
  // n'en a pas encore. Idempotent : le domaine canonique est unique.
  let opened = 0;
  for (const entry of repos.sales.ledgerDomains()) {
    if (entry.kind !== 'CONTACTED') continue;
    const history = repos.sales.ledgerHistory(entry.domain);
    const contacted = history.find((h) => h.kind === 'CONTACTED');
    const prospect = repos.sales
      .batchIds()
      .flatMap((b) => repos.sales.forBatch(b))
      .find((p) => canonicalDomainOf(p.domain ?? '') === entry.domain);

    const { conversation, created } = repos.conversations.open({
      domain: entry.domain,
      companyName: prospect?.companyName ?? entry.domain,
      outreachLedgerEntryId: contacted?.id ?? null,
      channel: contacted?.channel ?? prospect?.contactMethod ?? null,
      destination: prospect?.contactEmail ?? prospect?.contactPage ?? prospect?.contactPhone ?? null,
      firstContactAt: contacted?.recordedAt,
      source: 'registre d’outreach',
    });
    if (created) opened += 1;
    console.log(
      `  ${created ? `${c.green}ouverte${c.reset}` : `${c.dim}déjà là${c.reset}`}  ` +
        `${conversation.companyName.slice(0, 28).padEnd(30)}${entry.domain}`,
    );
  }
  console.log(`\n${opened} conversation(s) ouverte(s). Aucun message envoyé.`);
} else if (action === 'record') {
  const [domain] = rest;
  if (!domain) throw new Error('usage: sales-inbox record <domaine> [--kind=] [--subject=] [--sender=] [--body-file=] [--status=] [--note=]');

  const conversation = repos.conversations.byDomain(domain);
  if (!conversation) throw new Error(`aucune conversation pour « ${domain} » — lancez d'abord : sales-inbox sync`);

  const kind = (flag('kind') ?? 'EMAIL_REPLY') as InboundKind;
  const bodyFile = flag('body-file');
  const body = bodyFile ? readFileSync(bodyFile, 'utf8') : flag('body');
  const declared = flag('status') as ConversationStatus | null;

  // Un état commercial exige un humain nommé : la règle ne fait que
  // reconnaître, elle ne conclut pas.
  if (declared && requiresHumanJudgement(declared) && !flag('by')) {
    throw new Error(`poser « ${declared} » exige --by=<nom> : cet état ne se déduit pas.`);
  }

  const verdict = classifyInbound({
    kind,
    subject: flag('subject'),
    sender: flag('sender'),
    body,
    receivedAt: flag('at') ?? undefined,
  });

  repos.conversations.recordInboundEvent({
    conversationId: conversation.id,
    kind,
    classification: verdict.classification,
    confidence: verdict.confidence,
    occurredAt: flag('at') ?? undefined,
    source: flag('source') ?? 'saisie manuelle',
    rawSubject: flag('subject'),
    sender: flag('sender'),
    bodyExcerpt: body,
    signals: verdict.signals,
    returnDate: verdict.returnDate,
    humanReviewed: Boolean(flag('by')),
    declaredStatus: declared,
    note: flag('note'),
  });

  console.log(`${conversation.companyName} — ${verdict.classification} (${verdict.confidence.toFixed(2)})`);
  for (const signal of verdict.signals) console.log(`  · ${signal}`);
  console.log(`  ${verdict.reason}`);
  const state = stateOf(conversation.id);
  console.log(`  → ${state.status}${state.followUpAt ? ` · relance ${state.followUpAt}` : ''}`);
  console.log(`  → ${state.nextAction}`);
} else {
  const conversations = repos.conversations.all();
  console.log(`\n  ${c.bold}SALES INBOX${c.reset}  ${c.dim}au ${today} · aucun message envoyé${c.reset}\n`);

  if (conversations.length === 0) {
    console.log('  Aucune conversation. Lancez : sales-inbox sync\n');
  }

  const header =
    `  ${'COMPANY'.padEnd(24)}${'LAST CONTACT'.padEnd(14)}${'LAST RESPONSE'.padEnd(16)}` +
    `${'STATUS'.padEnd(21)}${'FOLLOW-UP'.padEnd(13)}NEXT ACTION`;
  if (conversations.length > 0) console.log(`  ${c.dim}${header.trim()}${c.reset}`);

  const counts = new Map<string, number>();
  for (const conversation of conversations) {
    const events = repos.conversations.eventsFor(conversation.id);
    const lastResponse = events.at(-1);
    const state = stateOf(conversation.id);
    counts.set(state.status, (counts.get(state.status) ?? 0) + 1);

    const colour =
      state.status === 'BOUNCED' ? c.red
      : state.status === 'FOLLOW_UP_REQUIRED' || state.status === 'NEEDS_REVIEW' ? c.amber
      : state.status === 'REPLIED' || state.status === 'INTERESTED' || state.status === 'WON' ? c.green
      : c.reset;

    console.log(
      `  ${conversation.companyName.slice(0, 22).padEnd(24)}` +
        `${conversation.firstContactAt.slice(0, 10).padEnd(14)}` +
        `${(lastResponse ? `${lastResponse.classification.slice(0, 13)}` : '—').padEnd(16)}` +
        `${colour}${state.status.padEnd(21)}${c.reset}` +
        `${(state.followUpAt ?? '—').padEnd(13)}${c.dim}${state.nextAction.slice(0, 44)}${c.reset}`,
    );
  }

  if (conversations.length > 0) {
    console.log('');
    console.log(
      '  ' + [...counts.entries()].map(([status, n]) => `${status} ${n}`).join(' · '),
    );
  }
  console.log('\n  MESSAGES SENT: 0\n');
}

repos.close();
