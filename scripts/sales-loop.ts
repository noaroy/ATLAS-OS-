/**
 * La boucle commerciale autonome.
 *
 * Elle enchaîne ce qui existait déjà en pièces détachées : chercher, résoudre
 * l'identité, filtrer sur l'ICP, noter la conversion, trouver un canal écrit,
 * interroger le registre global, rédiger — puis s'arrêter. Le dernier verbe est
 * le plus important : en V1, la boucle s'arrête avant l'envoi et attend une
 * décision humaine.
 *
 * Ce n'est pas de la prudence décorative. Un message parti ne se rattrape pas,
 * et les gardes de ce système ont toutes été écrites après coup, en réparant un
 * faux positif qui avait franchi les gardes précédentes. Tant que la liste de
 * ces incidents s'allonge, l'approbation humaine reste le dernier filet.
 *
 *   sales-loop discover              cherche, qualifie, rédige — n'envoie rien
 *   sales-loop drafts                ce qui attend une relecture
 *   sales-loop approve <id> --by=    autorise un envoi
 *   sales-loop reject <id> --by=     refuse
 *   sales-loop send                  envoie ce qui est approuvé
 *   sales-loop follow-ups            les relances dues, une seule par entreprise
 *   sales-loop reply <domaine> --body-file=<fichier>   consigne une réponse
 *
 * Le ton des messages sortants de ce chemin suit
 * `docs/SALES_HUMANIZATION_POLICY.md` -- source de verite unique. Les regles
 * verifiables sont appliquees par `checkHumanization` ; ce fichier ne les
 * recopie pas.
 */
import { readFileSync } from 'node:fs';
import { createLogger, loadConfig, canonicalDomainOf } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import { createSearchFabric } from '../packages/intelligence/src/search/fabric/factory.ts';
import { fetchRawPages } from '../packages/intelligence/src/contact-fetch.ts';
import { DryRunOutboundProvider } from '../packages/intelligence/src/mail/outbound.ts';
import {
  classifyPageType,
  resolveCompanyIdentity,
  icpStatus,
  resolveContacts,
  contactPagesFor,
  contactLinksIn,
  scoreConversion,
  findGrowthSignals,
  buildOutreachDraft,
  evaluateSendGate,
  evaluateFollowUp,
  canTransitionLoop,
  classifyInbound,
  detectOptOut,
  deriveConversationState,
  shouldNotify,
  type ConversationEvent,
  type ConversationStatus,
  type InboundKind,
  type ContactPage,
  type LoopState,
  type SendCandidate,
} from '../packages/departments/src/index.ts';

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m',
};

const [action = 'discover', ...rest] = process.argv.slice(2);
const flag = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const logger = createLogger({ level: 'error', pretty: false });
const config = loadConfig(process.cwd());
const repos = createRepositories(process.env.ATLAS_DB_PATH ?? 'data/atlas.db', logger);
const sales = config.sales;
const runId = `run-${Date.now()}`;
const today = flag('today') ?? new Date().toISOString().slice(0, 10);

/** Consigner un pas de la boucle, en refusant les transitions impossibles. */
function move(domain: string, to: LoopState, reason: string, actor = 'boucle-commerciale') {
  const from = repos.salesLoop.currentState(domain) as LoopState | null;
  const check = canTransitionLoop(from, to);
  if (!check.allowed) return check;
  repos.salesLoop.recordTransition({ domain, fromState: from, toState: to, reason, actor, runId });
  return check;
}

// ─── discover ───────────────────────────────────────────────────────────────

async function discover(): Promise<void> {
  const queries = (flag('queries') ?? '').split('|').filter(Boolean);
  if (queries.length === 0) {
    console.error('usage: sales-loop discover --queries="requête 1|requête 2"');
    process.exit(1);
  }

  const fabric = createSearchFabric(config.search, {
    need: { countries: ['FR'], languages: ['fr'], commercial: true },
  });
  if (!fabric) {
    console.error('Aucun moteur de recherche configuré : la découverte en dépend.');
    process.exit(1);
  }

  const deadline = Date.now() + sales.wallClockMs;
  const known = new Set(repos.sales.knownDomains());
  const seen = new Set<string>();
  let evaluated = 0;
  let prepared = 0;

  const sentToday = repos.salesLoop.sentSince(`${today}T00:00:00.000Z`);
  const remainingToday = Math.max(0, sales.maxNewOutreachPerDay - sentToday);

  console.log(`\n  ${c.bold}BOUCLE COMMERCIALE${c.reset} ${c.dim}· ${runId}${c.reset}`);
  console.log(
    `  ${c.dim}seuil ${sales.minConversionScore}/100 · ${remainingToday} envoi(s) restant(s) ` +
      `aujourd'hui · ${Math.round(sales.wallClockMs / 60000)} min max${c.reset}\n`,
  );

  for (const query of queries) {
    if (Date.now() > deadline || evaluated >= sales.maxDomainsPerRun) break;
    let results;
    try {
      results = await fabric.search({ query, count: 10 }, { logger, timeoutMs: 20_000 });
    } catch {
      continue;
    }

    for (const result of results.results ?? []) {
      if (Date.now() > deadline || evaluated >= sales.maxDomainsPerRun) break;
      let domain: string;
      try {
        domain = canonicalDomainOf(new URL(result.url).hostname);
      } catch {
        continue;
      }
      if (!domain || seen.has(domain)) continue;
      seen.add(domain);

      // Rejet précoce : tant qu'on n'a pas payé une lecture de site, un refus
      // ne coûte rien. C'est là que se joue la tenue des trente minutes.
      if (known.has(domain)) {
        console.log(`  ${c.dim}—    ${domain.padEnd(30)}déjà au registre${c.reset}`);
        continue;
      }
      const page = classifyPageType({
        url: result.url, domain, title: result.title, snippet: result.snippet,
      });
      if (!page.ownerIsCandidate) continue;
      const identity = resolveCompanyIdentity({
        searchTitle: result.title ?? '', url: result.url, domain, page,
      });
      if (!identity.identity) continue;
      const icp = icpStatus({
        companyName: identity.identity.companyName, snippet: result.snippet,
      });
      if (icp.status === 'OUT_OF_ICP') {
        console.log(`  ${c.dim}—    ${domain.padEnd(30)}hors ICP${c.reset}`);
        continue;
      }

      move(domain, 'QUALIFYING', `découvert par « ${query} »`);
      evaluated += 1;

      // Lecture profonde : réservée aux survivants.
      const pages = await readSite(identity.identity.officialWebsite, domain);
      if (pages.length === 0) {
        move(domain, 'BLOCKED', 'site illisible');
        continue;
      }

      const signals = findGrowthSignals(pages.map((p) => ({ url: p.url, html: p.html })));
      const contacts = resolveContacts({ officialDomain: domain, pages });
      const primary = contacts.publicEmails.find((e) => e.suitability !== 'BLOCKED')
        ?? (contacts.contactFormUrl ? contacts.contactFormUrl : null);

      const facts = signals.map((s) => ({
        claim: s.quote, sourceUrl: s.sourceUrl, nature: 'observed' as const,
      }));
      const score = scoreConversion({
        companyName: identity.identity.companyName,
        facts,
        contactIntent: primary && typeof primary === 'object' ? primary.intent : null,
        contactSuitability: primary && typeof primary === 'object' ? primary.suitability : null,
        qualificationScore: null,
        qualificationTier: null,
      });

      const candidate: SendCandidate = {
        domain,
        companyName: identity.identity.companyName,
        officialDomain: domain,
        icpStatus: icp.status === 'MATCH' ? 'IN_ICP' : 'UNKNOWN',
        conversionScore: score.total,
        observedFacts: facts
          .filter((f) => f.sourceUrl)
          .map((f) => ({ quote: f.claim, sourceUrl: f.sourceUrl! })),
        commercialSignals: signals.map((s) => s.kind),
        contact:
          primary && typeof primary === 'object'
            ? {
                value: primary.value,
                type: 'EMAIL',
                intent: primary.intent,
                suitability: primary.suitability,
                observed: true,
                sourceUrl: primary.sourceUrl ?? null,
              }
            : null,
        ledger: repos.sales.ledgerFor(domain)?.kind === 'DO_NOT_CONTACT'
          ? 'DO_NOT_CONTACT'
          : known.has(domain)
            ? 'ALREADY_CONTACTED'
            : 'ELIGIBLE',
      };

      const gate = evaluateSendGate(candidate, {
        minConversionScore: sales.minConversionScore,
        remainingToday,
      });
      if (!gate.allowed) {
        move(domain, 'BLOCKED', gate.blocks.map((b) => b.reason).join(', '));
        console.log(
          `  ${c.red}BLOQ${c.reset} ${domain.padEnd(30)}${gate.blocks.map((b) => b.reason).join(', ')}`,
        );
        continue;
      }

      const outcome = buildOutreachDraft({
        company: candidate.companyName!,
        website: identity.identity.officialWebsite,
        facts: candidate.observedFacts.map((f) => ({
          evidenceId: f.sourceUrl, claim: f.quote, sourceUrl: f.sourceUrl,
          nature: 'observed' as const,
        })),
        contact: null,
        whyThisCompany: gate.passed.join(' · '),
        senderName: sales.senderName,
        offer: { priceEur: 49, deliveryHours: 48, freePreviewCount: 3, recurringAvailable: true },
      });
      if (!outcome.draft) {
        move(domain, 'BLOCKED', outcome.reason);
        continue;
      }

      const draft = repos.salesLoop.saveDraft({
        domain,
        companyName: candidate.companyName!,
        recipient: candidate.contact!.value,
        subject: `${candidate.companyName} — 3 prospects, gratuitement`,
        body: outcome.draft.messageEmail,
        purpose: 'FIRST_TOUCH',
        conversionScore: score.total,
        rationale: gate.passed.join(' · '),
        sources: [...candidate.observedFacts],
        createdBy: 'boucle-commerciale',
      });
      move(domain, 'READY_FOR_APPROVAL', `brouillon ${draft.id}`);
      prepared += 1;
      console.log(
        `  ${c.green}PRÊT${c.reset} ${domain.padEnd(30)}${String(score.total).padStart(3)}/100  ` +
          `${c.dim}${draft.id}${c.reset}`,
      );
    }
  }

  console.log(
    `\n  ${evaluated} société(s) lue(s) · ${prepared} brouillon(s) en attente de relecture`,
  );
  console.log(`  ${c.dim}Aucun message n'est parti. MESSAGES SENT: 0${c.reset}\n`);
}

/** Lecture bornée d'un site : le plafond de pages est ce qui tient l'horloge. */
async function readSite(website: string, domain: string): Promise<ContactPage[]> {
  const queue = contactPagesFor(website, domain);
  const visited = new Set<string>();
  const pages: ContactPage[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const batch = queue.filter((u) => !visited.has(u));
    for (const u of batch) visited.add(u);
    if (batch.length === 0) break;
    const fetched = await fetchRawPages(batch, {
      logger,
      timeoutMs: 10_000,
      maxPages: Math.max(0, sales.maxPagesPerDomain - pages.length),
    });
    pages.push(...fetched.pages);
    if (pass === 0 && fetched.pages[0]) {
      for (const link of contactLinksIn(fetched.pages[0].html, fetched.pages[0].url, domain)) {
        if (!visited.has(link)) queue.push(link);
      }
    }
  }
  return pages;
}

// ─── relecture et décision ──────────────────────────────────────────────────

function showDrafts(): void {
  const drafts = repos.salesLoop.draftsInState('READY_FOR_APPROVAL');
  console.log(`\n  ${c.bold}EN ATTENTE DE RELECTURE${c.reset} — ${drafts.length}\n`);
  for (const d of drafts) {
    console.log(`  ${c.bold}${d.companyName}${c.reset}  ${c.dim}${d.domain} · ${d.id}${c.reset}`);
    console.log(`    destinataire : ${d.recipient}`);
    console.log(`    score        : ${d.conversionScore ?? '—'}/100`);
    console.log(`    sujet        : ${d.subject}`);
    for (const s of d.sources) console.log(`    ${c.dim}« ${s.quote.slice(0, 90)} » ${s.sourceUrl}${c.reset}`);
    console.log(`    ${c.dim}${d.body.split('\n')[0]}…${c.reset}`);
    console.log();
  }
  if (drafts.length > 0) {
    console.log(`  ${c.dim}sales-loop approve <id> --by=<nom>   ·   sales-loop reject <id> --by=<nom>${c.reset}\n`);
  }
}

function decide(decision: 'APPROVED_TO_SEND' | 'REJECTED'): void {
  const draftId = rest[0];
  const by = flag('by');
  if (!draftId || !by) {
    console.error('usage: sales-loop approve|reject <draftId> --by=<nom>');
    process.exit(1);
  }
  const draft = repos.salesLoop.draftById(draftId);
  if (!draft) {
    console.error(`brouillon inconnu : ${draftId}`);
    process.exit(1);
  }
  const outcome = repos.salesLoop.decideDraft({
    draftId, decision, decidedBy: by, note: flag('note'),
  });
  if (!outcome.applied) {
    console.error(outcome.reason);
    process.exit(1);
  }
  move(
    draft.domain,
    decision === 'APPROVED_TO_SEND' ? 'APPROVED_TO_SEND' : 'LOST',
    `décision de ${by}`,
    by,
  );
  console.log(`${draft.companyName} → ${decision} (par ${by})`);
}

// ─── envoi ──────────────────────────────────────────────────────────────────

async function send(): Promise<void> {
  if (sales.humanApprovalRequired && flag('confirm') !== 'oui') {
    console.log(
      `\n  ${c.amber}L'approbation humaine est exigée (ATLAS_SALES_HUMAN_APPROVAL=true).${c.reset}`,
    );
    console.log('  Les brouillons approuvés partiront avec : sales-loop send --confirm=oui\n');
  }

  const approved = repos.salesLoop.draftsInState('APPROVED_TO_SEND');
  if (approved.length === 0) {
    console.log('  Aucun brouillon approuvé.\n');
    return;
  }

  // Le fournisseur par défaut ne poste rien. Brancher un vrai expéditeur
  // suppose une portée OAuth d'envoi, que personne n'a accordée à ce jour.
  const provider = new DryRunOutboundProvider();
  console.log(`\n  expéditeur : ${provider.id} — ${provider.status().detail}\n`);

  const sentToday = repos.salesLoop.sentSince(`${today}T00:00:00.000Z`);
  let budget = Math.max(0, sales.maxNewOutreachPerDay - sentToday);

  for (const draft of approved) {
    if (budget <= 0) {
      console.log(`  ${c.amber}plafond quotidien atteint : ${sales.maxNewOutreachPerDay}${c.reset}`);
      break;
    }
    // Le registre est réinterrogé ici, et non seulement à la rédaction : un
    // opt-out peut être arrivé entre l'approbation et l'envoi.
    if (repos.sales.ledgerFor(draft.domain)?.kind === 'DO_NOT_CONTACT') {
      move(draft.domain, 'BLOCKED', 'DO_NOT_CONTACT arrivé après approbation');
      console.log(`  ${c.red}BLOQ${c.reset} ${draft.domain} — DO_NOT_CONTACT`);
      continue;
    }

    const claim = repos.salesLoop.claimSend({
      domain: draft.domain,
      recipient: draft.recipient,
      subject: draft.subject,
      body: draft.body,
      purpose: draft.purpose,
      claimedBy: 'boucle-commerciale',
    });
    if (!claim.claimed) {
      console.log(`  ${c.dim}—    ${draft.domain} — ${claim.reason}${c.reset}`);
      continue;
    }

    move(draft.domain, 'SENDING', `envoi de ${draft.id}`);
    try {
      const receipt = await provider.sendEmail({
        to: draft.recipient, subject: draft.subject, bodyText: draft.body,
      });
      repos.salesLoop.recordSendResult({
        idempotencyKey: claim.idempotencyKey,
        phase: 'SENT',
        externalMessageId: receipt.externalMessageId,
        externalThreadId: receipt.externalThreadId,
      });
      repos.salesLoop.markDraftSent(draft.id);
      repos.sales.recordOutreach({
        domain: draft.domain,
        kind: 'CONTACTED',
        recordedBy: 'boucle-commerciale',
        channel: 'email',
        note: receipt.simulated ? 'simulation : aucun message réel' : draft.subject,
      });
      move(draft.domain, 'CONTACTED', receipt.simulated ? 'simulé' : 'envoyé');
      budget -= 1;
      console.log(
        `  ${receipt.simulated ? c.dim : c.green}${receipt.simulated ? 'SIMU' : 'ENVO'}${c.reset} ` +
          `${draft.domain.padEnd(30)}${receipt.externalMessageId}`,
      );
    } catch (error) {
      repos.salesLoop.recordSendResult({
        idempotencyKey: claim.idempotencyKey,
        phase: 'FAILED',
        error: error instanceof Error ? error.message : String(error),
      });
      move(draft.domain, 'ACTION_REQUIRED', 'échec technique à l’envoi');
      console.log(`  ${c.red}ÉCHEC${c.reset} ${draft.domain} — ${String(error)}`);
    }
  }
  console.log();
}

// ─── relances ───────────────────────────────────────────────────────────────

function followUps(): void {
  const contacted = repos.salesLoop.domainsInState('CONTACTED')
    .concat(repos.salesLoop.domainsInState('WAITING_REPLY'));
  console.log(`\n  ${c.bold}RELANCES${c.reset} ${c.dim}au ${today}${c.reset}\n`);

  let due = 0;
  for (const domain of new Set(contacted)) {
    const history = repos.salesLoop.historyFor(domain);
    const contactedOn = history.find((h) => h.toState === 'CONTACTED')?.occurredAt.slice(0, 10);
    if (!contactedOn) continue;
    const decision = evaluateFollowUp({
      domain,
      status: 'CONTACTED',
      contactedOn,
      followUpsSent: repos.salesLoop.followUpsFor(domain),
      doNotContact: repos.sales.ledgerFor(domain)?.kind === 'DO_NOT_CONTACT',
      afterBusinessDays: sales.followUpAfterDays,
      today,
    });
    const colour = decision.verdict === 'DUE' ? c.amber : c.dim;
    console.log(`  ${colour}${decision.verdict.padEnd(20)}${c.reset}${domain.padEnd(30)}${decision.reason}`);
    if (decision.verdict === 'DUE') {
      move(domain, 'FOLLOW_UP_REQUIRED', decision.reason);
      due += 1;
    }
  }
  console.log(`\n  ${due} relance(s) due(s). Aucune n'est partie : elles passent par l'approbation.\n`);
}

// ─── réponses entrantes ─────────────────────────────────────────────────────

/**
 * Une réponse arrive, et la boucle en tire les conséquences.
 *
 * Rien n'est réimplémenté ici : le classement vient de Reply Intake V1, l'état
 * de `deriveConversationState`, le filtre de bruit des règles de notification.
 * Ce qui manquait était le câblage — une réponse consignée quelque part sans
 * que la machine à états ni le registre en sachent rien.
 *
 * Le désabonnement est traité avant tout le reste. C'est la seule réaction qui
 * ne souffre aucun délai : attendre qu'un humain le lise reviendrait à laisser
 * partir une relance à quelqu'un qui a dit non.
 */
/**
 * Le corps du message, lu d'ou il vient reellement.
 *
 * Un vrai courriel fait plusieurs paragraphes. Le passer en argument de ligne
 * de commande a echoue en pratique : au-dela d'une centaine de caracteres
 * multi-mots, l'appel se bloque avant meme que Node demarre — reproduit avec
 * une action qui ne lit jamais ce parametre, donc imputable a la couche
 * d'appel et non au script.
 *
 * Un fichier ou l'entree standard n'ont pas cette limite, et se pretent mieux
 * a un texte qu'on relit avant de le consigner.
 *
 *   sales-loop reply <domaine> --body-file=reponse.txt
 *   cat reponse.txt | sales-loop reply <domaine> --stdin
 */
function readBody(): string {
  const file = flag('body-file');
  if (file) return readFileSync(file, 'utf8').trim();
  if (process.argv.includes('--stdin')) return readFileSync(0, 'utf8').trim();
  return flag('body') ?? '';
}

function reply(): void {
  const domain = rest[0] ? canonicalDomainOf(rest[0]) : null;
  if (!domain) {
    console.error('usage: sales-loop reply <domaine> --body="…" [--subject=] [--kind=] [--by=]');
    process.exit(1);
  }
  const conversation = repos.conversations.byDomain(domain);
  if (!conversation) {
    console.error(`aucune conversation ouverte pour ${domain}.`);
    process.exit(1);
  }

  const body = readBody();
  const subject = flag('subject');
  const kind = (flag('kind') ?? 'EMAIL_REPLY') as InboundKind;

  // 1. Le désabonnement, avant toute autre lecture.
  const optOut = detectOptOut({ subject, body });
  if (optOut.optedOut) {
    repos.sales.recordOutreach({
      domain,
      kind: 'DO_NOT_CONTACT',
      recordedBy: flag('by') ?? 'boucle-commerciale',
      channel: 'email',
      note: optOut.reason,
    });
    move(domain, 'BLOCKED', `opt-out : ${optOut.reason}`);
    console.log(`\n  ${c.red}DO_NOT_CONTACT${c.reset}  ${conversation.companyName}`);
    console.log(`  ${optOut.reason}`);
    console.log(`  ${c.dim}Aucune relance ne partira. Aucune découverte future ne rouvrira ce domaine.${c.reset}
`);
    return;
  }

  // 2. Le classement déterministe, puis l'état qui en découle.
  const verdict = classifyInbound({ kind, subject, sender: flag('sender'), body });
  repos.conversations.recordInboundEvent({
    conversationId: conversation.id,
    kind,
    classification: verdict.classification,
    confidence: verdict.confidence,
    source: flag('source') ?? 'boucle-commerciale',
    rawSubject: subject,
    sender: flag('sender'),
    bodyExcerpt: body,
    signals: verdict.signals,
    returnDate: verdict.returnDate,
    humanReviewed: Boolean(flag('by')),
    declaredStatus: (flag('status') as ConversationStatus | null) ?? null,
    note: flag('note'),
  });

  const events = repos.conversations.eventsFor(conversation.id).map((e) => ({
    kind: e.kind,
    classification: e.classification,
    occurredAt: e.occurredAt,
    returnDate: e.returnDate,
    humanReviewed: e.humanReviewed,
    declaredStatus: (e.declaredStatus as ConversationStatus | null) ?? null,
  })) as ConversationEvent[];
  const state = deriveConversationState(events, { today });

  // 3. La boucle avance : une réponse humaine sort de l'attente.
  const target = verdict.classification === 'BOUNCED' ? 'ACTION_REQUIRED' : 'REPLIED';
  move(domain, target, `réponse ${verdict.classification}`);

  // 4. Faut-il déranger quelqu'un ?
  const notification = shouldNotify({
    status: state.status,
    classification: verdict.classification,
    confidence: verdict.confidence,
    subject,
    bodyExcerpt: body,
  });

  if (notification.decision === 'SILENT') {
    console.log(`
  ${c.dim}Consigné, sans notification — ${notification.reason}.${c.reset}
`);
    return;
  }

  console.log(`
  ${c.bold}${c.green}RÉPONSE À TRAITER${c.reset}
`);
  console.log(`  COMPANY          ${conversation.companyName}  ${c.dim}${domain}${c.reset}`);
  console.log(`  INTENT           ${notification.intent}`);
  console.log(`  CONFIDENCE       ${notification.confidence.toFixed(2)}`);
  console.log(`  SUMMARY          ${notification.summary}`);
  console.log(`  NEXT ACTION      ${notification.recommendedNextAction}`);
  if (notification.draftReply) {
    console.log(`
  ${c.bold}DRAFT REPLY${c.reset} ${c.dim}(proposée, non envoyée)${c.reset}`);
    for (const l of notification.draftReply.split('\n')) console.log(`    ${l}`);
  } else {
    console.log(`
  ${c.dim}Aucune réponse pré-écrite : le message doit être lu avant d'y répondre.${c.reset}`);
  }
  console.log(`
  ${c.dim}MESSAGES SENT: 0${c.reset}
`);
}

// ─── aiguillage ─────────────────────────────────────────────────────────────

try {
  if (action === 'discover') await discover();
  else if (action === 'drafts') showDrafts();
  else if (action === 'approve') decide('APPROVED_TO_SEND');
  else if (action === 'reject') decide('REJECTED');
  else if (action === 'send') await send();
  else if (action === 'follow-ups') followUps();
  else if (action === 'reply') reply();
  else {
    console.error(`action inconnue : « ${action} ».`);
    console.error('attendu : discover | drafts | approve | reject | send | follow-ups | reply');
    process.exit(1);
  }
} finally {
  repos.close();
}
