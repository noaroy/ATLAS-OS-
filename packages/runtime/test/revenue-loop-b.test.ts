import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../core/src/logger.ts';
import type { AtlasConfig } from '../../core/src/index.ts';
import { createRepositories, type Repositories, type TaskRow } from '../../data/src/index.ts';
import { makeTestConfig } from '../../testing/src/index.ts';
import { FixtureInboxProvider, mailMessage, DryRunOutboundProvider, type MailOutboundProvider } from '../../intelligence/src/index.ts';
import { validateOutreachDraft, evaluateFollowUp, type OutreachQualityInput } from '../../departments/src/index.ts';
import {
  materializeFirstTouchDrafts, runSendCycle, createSalesEngineHandlers, applyReplyConsequences, setGlobalPause,
  recordSalesOutcome, defaultOutbound, SALES_ENGINE_TASKS, FIRST_TOUCH_ACTOR,
} from '../src/sales-engine.ts';
import { runRevenueFactory } from '../src/revenue-factory.ts';
import { commercialStateOf } from '../src/commercial-state.ts';
import type { WorkerContext } from '../src/workers.ts';
import { site, fixtureFetch, discovered, partners, type SiteKind } from './helpers/factory-fixtures.ts';

/**
 * Boucle B — l'envoi contrôlé — et la chaîne entière, de bout en bout.
 *
 * Aucun message ne quitte la machine : le transport est un enregistreur, sans
 * réseau. Il permet de vérifier que la chaîne atteint la frontière du
 * transport avec exactement le texte validé, et qu'elle ne l'atteint jamais
 * quand une garde refuse. La configuration par défaut (interrupteur fermé,
 * INTERNAL_TEST) est éprouvée à part : rien n'y part, et l'expéditeur retenu
 * est l'expéditeur à blanc.
 */

const logger = createLogger({ level: 'error', pretty: false });
/** Lundi 28 septembre 2026, 10 h 30 à Paris : dans la fenêtre d'envoi. */
const NOW = new Date('2026-09-28T08:30:00.000Z');
const context: WorkerContext = { logger, heartbeat: () => true, shuttingDown: () => false, correlationId: null };
const task = (taskType: string) => ({ taskId: `tsk_${taskType}`, taskType } as unknown as TaskRow);

let dir: string;
let repos: Repositories;
let config: AtlasConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-loop-b-'));
  repos = createRepositories(join(dir, 'b.db'), logger);
  config = makeTestConfig(dir);
});
afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.GMAIL_USER;
});

/** La configuration du banc : interrupteur levé et approbation automatique, dans une base jetable. */
const bench = (base: AtlasConfig): AtlasConfig => ({
  ...base,
  sales: { ...base.sales, outboundEnabled: true, engineMode: 'PRODUCTION', humanApprovalRequired: false },
});

/** La frontière du transport : elle enregistre ce qu'on lui confie, et ne poste rien. */
class RecordingTransport implements MailOutboundProvider {
  readonly id = 'recording-transport';
  readonly messages: Array<{ to: string; subject: string; bodyText: string }> = [];
  failNext = false;
  status() { return { configured: true, code: 'READY', detail: 'banc d’essai : aucun réseau', scopes: [] }; }
  async sendEmail(message: { to: string; subject: string; bodyText: string }) {
    if (this.failNext) { this.failNext = false; throw new Error('SMTP 451 réessayer plus tard'); }
    this.messages.push({ to: message.to, subject: message.subject, bodyText: message.bodyText });
    return { externalMessageId: `rec-${this.messages.length}`, externalThreadId: `thr-${this.messages.length}`, simulated: true, sentAt: NOW.toISOString(), provider: this.id };
  }
  async replyToThread(message: { to: string; subject: string; bodyText: string; threadId: string }) { return this.sendEmail(message); }
}

const PARTNERS: Record<string, Array<{ domain: string; name: string }>> = {
  'merand.fr': [{ domain: 'bridor.fr', name: 'Bridor' }, { domain: 'panamar.es', name: 'Panamar' }],
  'fourpro.fr': [{ domain: 'greggs.co.uk', name: 'Greggs' }, { domain: 'europastry.com', name: 'Europastry' }, { domain: 'lantmannen.se', name: 'Lantmännen' }],
};

/** Une campagne approuvée, une graine attribuée, et la relation qui a fait découvrir l'entreprise. */
function campaignLineage(domains: readonly string[]) {
  const { segment } = repos.salesEngine.createSegment({ name: 'Équipementiers FR', countries: ['FR'] });
  repos.salesEngine.approveSegmentForSend(segment.id, 'founder@test.local');
  repos.salesEngine.attribute({ domain: 'graine.fr', segmentId: segment.id, messageVariant: 'A' });
  for (const d of domains) {
    repos.expansion.addRelationship({
      runId: null, sourceKey: 'graine.fr', sourceName: 'Graine', sourceKind: 'COMPANY', targetKey: d, targetName: d,
      relationshipType: 'COMPLEMENTARY_VENDOR', confidence: 0.8, status: 'VERIFIED', evidenceUrl: 'https://graine.fr/partenaires',
      evidenceSummary: `${d} est présenté comme partenaire de Graine.`, sourceMethod: 'fixture', sourceTrust: 'OFFICIAL', country: 'FR', sourceDate: null,
    });
  }
  return segment;
}

async function factoryOver(entries: ReadonlyArray<[string, string, SiteKind]>, now = NOW) {
  const sites = entries.map(([d, n, k]) => site(d, n, k));
  return runRevenueFactory({ repos, config, logger, fetchPages: fixtureFetch(sites), now: () => now });
}

describe('la porte qualité', () => {
  const good: OutreachQualityInput = {
    recipient: 'commercial@merand.fr', subject: 'Recherche de distributeurs', domain: 'merand.fr', observedEmail: 'commercial@merand.fr',
    sources: [
      { quote: 'Nous recherchons des distributeurs pour commercialiser nos équipements en Europe du Nord', sourceUrl: 'https://merand.fr/' },
      { quote: 'Bridor distribue les équipements de la société en France.', sourceUrl: 'https://merand.fr/partenaires' },
      { quote: 'Panamar distribue les équipements de la société en France.', sourceUrl: 'https://merand.fr/partenaires' },
    ],
    body: `Bonjour,\n\nJ'ai vu sur votre site que vous indiquez rechercher des distributeurs pour commercialiser nos équipements en Europe du Nord.\n\n`
      + `Pour exemple, 2 entreprises relevées :\n- Bridor (bridor.fr) : « Bridor distribue les équipements de la société en France. » — https://merand.fr/partenaires\n`
      + `- Panamar (panamar.es) : « Panamar distribue les équipements de la société en France. » — https://merand.fr/partenaires\n\n`
      + `Je peux vous en préparer 3 gratuitement, simplement pour que vous jugiez si le résultat est pertinent.`,
  };

  test('un brouillon conforme passe', () => {
    assert.deepEqual(validateOutreachDraft(good), { ok: true, reasons: [], detail: [] });
  });

  test('chaque défaut rend son motif machine-lisible', () => {
    const reasons = (over: Partial<OutreachQualityInput>) => validateOutreachDraft({ ...good, ...over }).reasons;
    assert.deepEqual(reasons({ observedEmail: null }), ['RECIPIENT_UNVERIFIED']);
    assert.deepEqual(reasons({ recipient: 'x@gmail.com', observedEmail: 'x@gmail.com' }), ['RECIPIENT_UNVERIFIED']);
    assert.ok(reasons({ sources: good.sources.slice(0, 2) }).includes('RECOMMENDATIONS_BELOW_2'));
    assert.ok(reasons({ sources: [good.sources[0]!, { quote: '', sourceUrl: 'https://merand.fr/p' }, good.sources[2]!] }).includes('PROVENANCE_MISSING'));
    assert.ok(reasons({ body: good.body.replace(/J'ai vu[^\n]*\n/, 'Bonjour à toute l’équipe.\n') }).includes('NOT_PERSONALIZED'));
    assert.ok(reasons({ body: `${good.body}\n\nBridor et Panamar cherchent activement de nouveaux fournisseurs comme vous.` }).includes('UNSUPPORTED_BUYING_INTENT'));
    assert.ok(reasons({ body: `${good.body} {{prenom}}` }).includes('PLACEHOLDER_LEFT'));
    assert.ok(reasons({ subject: '' }).includes('SUBJECT_INVALID'));
    assert.ok(reasons({ body: good.body.slice(0, 200) }).some((r) => r === 'BODY_TOO_SHORT'));
  });

  test('une intention citée entre guillemets, sourcée, n’est pas une affirmation du message', () => {
    const quoted = { ...good, body: `${good.body}\n\nSur leur site : « nous recherchons de nouveaux fournisseurs d'emballage ».` };
    assert.equal(validateOutreachDraft(quoted).reasons.includes('UNSUPPORTED_BUYING_INTENT'), false);
  });
});

describe('la boucle B ne consomme que SEND_ELIGIBLE', () => {
  test('un prospect que la fabrique juge non éligible n’est jamais rédigé', async () => {
    campaignLineage(['formulaire.fr']);
    discovered(repos, 'formulaire.fr', 'Formulaire');
    partners(repos, 'formulaire.fr', PARTNERS['merand.fr']!);
    await factoryOver([['formulaire.fr', 'Formulaire', 'FORM_ONLY']]);
    // Même en forçant une adresse après coup, le verdict de la fabrique garde la porte.
    const p = repos.sales.discoveredSince(null)[0]!;
    repos.sales.setContact(p.id, { email: 'commercial@formulaire.fr', sourceUrl: 'https://formulaire.fr/contact', observed: true, method: 'EMAIL' });
    const report = materializeFirstTouchDrafts(repos, bench(config), { now: NOW, transportConfigured: true });
    assert.equal(report.drafted, 0);
    assert.ok(report.skipped[0]!.reasons.includes('FACTORY_NOT_ELIGIBLE'), JSON.stringify(report));
  });

  test('rédaction impossible (aucune citation relue à sa source) : pas de file, retour en NEEDS_ENRICHMENT', async () => {
    campaignLineage(['reformule.fr']);
    const p = discovered(repos, 'reformule.fr', 'Reformule');
    partners(repos, 'reformule.fr', PARTNERS['merand.fr']!);
    repos.sales.setContact(p.id, { email: 'commercial@reformule.fr', sourceUrl: 'https://reformule.fr/contact', observed: true, method: 'EMAIL' });
    for (const [i, claim] of ['Fabricant de fours pour la boulangerie industrielle', 'Présent dans plusieurs pays d’Europe'].entries()) {
      repos.sales.addEvidence({ prospectId: p.id, field: `signal:distribution${i}`, claim, nature: 'observed', sourceUrl: 'https://reformule.fr/', basis: null, confidence: 0.8 });
    }
    repos.sales.setScore(p.id, { score: 72, tier: 'PRIORITY', detail: {}, whyFit: 'fabricant' });
    await factoryOver([['reformule.fr', 'Reformule', 'FULL']]);
    assert.equal(repos.revenueFactory.verdict('reformule.fr')!.sendEligible, true);
    const report = materializeFirstTouchDrafts(repos, bench(config), { now: NOW, transportConfigured: true });
    assert.equal(report.drafted, 0);
    const v = repos.revenueFactory.verdict('reformule.fr')!;
    assert.equal(v.classification, 'NEEDS_ENRICHMENT');
    assert.equal(v.sendEligible, false);
    assert.ok(v.blockers.includes('NO_SOURCED_FACT'), JSON.stringify(v.blockers));
    assert.equal(repos.salesLoop.draftsForDomain('reformule.fr').length, 0);
  });

  test('un texte altéré après validation est refusé au moment de partir, et le brouillon est fermé', async () => {
    campaignLineage(['merand.fr']);
    discovered(repos, 'merand.fr', 'Mérand');
    partners(repos, 'merand.fr', PARTNERS['merand.fr']!);
    await factoryOver([['merand.fr', 'Mérand', 'FULL']]);
    materializeFirstTouchDrafts(repos, bench(config), { now: NOW, transportConfigured: true });
    const [draft] = repos.salesLoop.draftsInState('APPROVED_TO_SEND');
    assert.ok(draft, 'approuvé automatiquement');
    repos.db.prepare('UPDATE outreach_drafts SET body = ? WHERE id = ?').run(`${draft!.body}\n\nBridor cherche activement de nouveaux fournisseurs.`, draft!.id);
    const transport = new RecordingTransport();
    const report = await runSendCycle({ repos, config: bench(config), logger }, { outbound: async () => transport, now: NOW });
    assert.equal(transport.messages.length, 0);
    assert.ok(report.blocked[0]!.reasons.includes('QUALITY_GATE:UNSUPPORTED_BUYING_INTENT'), JSON.stringify(report.blocked));
    assert.equal(repos.salesLoop.draftById(draft!.id)!.state, 'ABANDONED');
  });
});

describe('les gardes d’envoi', () => {
  async function approvedMerand() {
    campaignLineage(['merand.fr']);
    discovered(repos, 'merand.fr', 'Mérand');
    partners(repos, 'merand.fr', PARTNERS['merand.fr']!);
    await factoryOver([['merand.fr', 'Mérand', 'FULL']]);
    const r = materializeFirstTouchDrafts(repos, bench(config), { now: NOW, transportConfigured: true });
    assert.equal(r.autoApproved, 1, JSON.stringify(r));
    return repos.salesLoop.draftsInState('APPROVED_TO_SEND')[0]!;
  }

  test('configuration par défaut : interrupteur fermé et INTERNAL_TEST — rien ne part, expéditeur à blanc', async () => {
    const draft = await approvedMerand();
    assert.equal(config.sales.outboundEnabled, false);
    assert.equal(config.sales.engineMode, 'INTERNAL_TEST');
    assert.ok((await defaultOutbound(config)()) instanceof DryRunOutboundProvider);
    const transport = new RecordingTransport();
    const report = await runSendCycle({ repos, config, logger }, { outbound: async () => transport, now: NOW });
    assert.equal(transport.messages.length, 0);
    assert.ok(report.blocked[0]!.reasons.includes('OUTBOUND_DISABLED'));
    assert.ok(report.blocked[0]!.reasons.includes('INTERNAL_TEST_MODE'));
    assert.equal(repos.salesLoop.draftById(draft.id)!.state, 'APPROVED_TO_SEND', 'un blocage de configuration ne ferme rien');
  });

  test('interrupteur fermé : même un texte non conforme n’est pas fermé — rien n’est touché avant la mise en service', async () => {
    const draft = await approvedMerand();
    repos.db.prepare('UPDATE outreach_drafts SET body = ? WHERE id = ?').run('{{prenom}}', draft.id);
    const report = await runSendCycle({ repos, config, logger }, { outbound: async () => new RecordingTransport(), now: NOW });
    assert.ok(!report.blocked[0]!.reasons.some((r) => r.startsWith('QUALITY_GATE:')));
    assert.equal(repos.salesLoop.draftById(draft.id)!.state, 'APPROVED_TO_SEND');
  });

  test('kill switch : rien ne part, l’état commercial dit PAUSED', async () => {
    await approvedMerand();
    setGlobalPause(repos, true, 'founder@test.local', 'essai');
    const transport = new RecordingTransport();
    const report = await runSendCycle({ repos, config: bench(config), logger }, { outbound: async () => transport, now: NOW });
    assert.equal(transport.messages.length, 0);
    assert.ok(report.blocked[0]!.reasons.includes('GLOBAL_PAUSE'));
    assert.equal(commercialStateOf(repos, 'merand.fr', NOW).state, 'PAUSED');
  });

  test('hors fenêtre et plafond du jour : le brouillon attend, rien ne part', async () => {
    await approvedMerand();
    const transport = new RecordingTransport();
    const night = await runSendCycle({ repos, config: bench(config), logger }, { outbound: async () => transport, now: new Date('2026-09-28T21:00:00.000Z') });
    assert.ok(night.blocked[0]!.reasons.includes('OUTSIDE_SEND_WINDOW'));
    const capped = { ...bench(config), sales: { ...bench(config).sales, maxNewOutreachPerDay: 0 } };
    const full = await runSendCycle({ repos, config: capped, logger }, { outbound: async () => transport, now: NOW });
    assert.ok(full.blocked[0]!.reasons.includes('DAILY_CAP_REACHED'));
    assert.equal(transport.messages.length, 0);
  });

  test('supprimé entre l’approbation et l’envoi : bloqué, brouillon fermé', async () => {
    const draft = await approvedMerand();
    repos.salesEngine.suppress({ kind: 'EMAIL', value: 'commercial@merand.fr', reason: 'OPT_OUT', createdBy: 'test' });
    const transport = new RecordingTransport();
    const report = await runSendCycle({ repos, config: bench(config), logger }, { outbound: async () => transport, now: NOW });
    assert.equal(transport.messages.length, 0);
    assert.ok(report.blocked[0]!.reasons.includes('SUPPRESSED'));
    assert.equal(repos.salesLoop.draftById(draft.id)!.state, 'ABANDONED');
  });

  test('redémarrage après une réservation sans issue : aucun second envoi', async () => {
    const draft = await approvedMerand();
    const claim = repos.salesLoop.claimSend({ domain: draft.domain, recipient: draft.recipient, subject: draft.subject, body: draft.body, purpose: draft.purpose, claimedBy: 'processus-mort' });
    assert.equal(claim.claimed, true);
    const transport = new RecordingTransport();
    const report = await runSendCycle({ repos, config: bench(config), logger }, { outbound: async () => transport, now: NOW });
    assert.equal(transport.messages.length, 0, 'la place est déjà prise : on ne rejoue pas');
    assert.match(report.blocked[0]!.reasons[0]!, /^CLAIM_REFUSED/);
  });

  test('échec du transport : FAILED consigné, aucune boucle de réessai aveugle', async () => {
    await approvedMerand();
    const transport = new RecordingTransport();
    transport.failNext = true;
    const report = await runSendCycle({ repos, config: bench(config), logger }, { outbound: async () => transport, now: NOW });
    assert.equal(report.failed.length, 1);
    assert.equal(commercialStateOf(repos, 'merand.fr', NOW).state, 'FAILED');
    const again = await runSendCycle({ repos, config: bench(config), logger }, { outbound: async () => transport, now: new Date(NOW.getTime() + 600_000) });
    assert.equal(transport.messages.length, 0, 'la place réservée n’est pas rejouée d’office');
    assert.equal(again.sent + again.simulated, 0);
  });
});

describe('réponses et relances', () => {
  const reply = (over: Record<string, unknown> = {}) => ({
    eventId: 'evt', conversationId: 'cnv', domain: 'merand.fr', companyName: 'Mérand', classification: 'REPLIED', confidence: 0.8,
    subject: 'RE: Recherche de distributeurs', sender: 'commercial@merand.fr', body: 'Oui, cela nous intéresse, appelons-nous.', receivedAt: NOW.toISOString(), ...over,
  });

  test('positive, négative, opt-out, rebond : chacun a sa conséquence', () => {
    assert.equal(applyReplyConsequences(repos, reply()).hotLead, true);
    assert.equal(applyReplyConsequences(repos, reply({ body: 'Nous avons déjà un prestataire, pas de besoin.' })).intent, 'NEGATIVE');
    const optOut = applyReplyConsequences(repos, reply({ domain: 'stop.fr', sender: 'contact@stop.fr', body: 'Merci de me désinscrire.' }));
    assert.equal(optOut.intent, 'OPT_OUT');
    assert.equal(repos.salesEngine.isSuppressed({ domain: 'stop.fr' }).suppressed, true);
    assert.equal(commercialStateOf(repos, 'stop.fr', NOW).state, 'SUPPRESSED');
    const bounce = applyReplyConsequences(repos, reply({ domain: 'rebond.fr', classification: 'BOUNCED', sender: 'mailer-daemon@googlemail.com', body: 'Address not found' }));
    assert.equal(bounce.intent, 'BOUNCE');
  });

  test('régression : une réponse positive rapprochée « à relire » (NEEDS_REVIEW) arrête aussi les relances et les envois', async () => {
    const domain = 'merand.fr';
    for (const [from, to] of [[null, 'QUALIFYING'], ['QUALIFYING', 'READY_FOR_APPROVAL'], ['READY_FOR_APPROVAL', 'APPROVED_TO_SEND'], ['APPROVED_TO_SEND', 'SENDING'], ['SENDING', 'CONTACTED']] as const) {
      repos.salesLoop.recordTransition({ domain, fromState: from, toState: to, actor: 'test' });
    }
    const { conversation } = repos.conversations.open({ domain, companyName: 'Mérand', source: 'test', firstContactAt: '2026-09-01T09:00:00.000Z' });
    repos.conversations.recordInboundEvent({ conversationId: conversation.id, kind: 'EMAIL_REPLY', classification: 'NEEDS_REVIEW', confidence: 0.6, source: 'test', sender: 'commercial@merand.fr', bodyExcerpt: 'Oui, intéressés.', occurredAt: '2026-09-02T09:00:00.000Z' });
    const consequence = applyReplyConsequences(repos, reply({ classification: 'NEEDS_REVIEW' }));
    assert.equal(consequence.intent, 'POSITIVE');
    assert.equal(repos.salesLoop.currentState(domain), 'REPLIED');
    const handlers = createSalesEngineHandlers({ repos, config, logger, now: () => new Date('2026-10-30T09:00:00.000Z') });
    const fu = await handlers[SALES_ENGINE_TASKS.FOLLOW_UP]!(task(SALES_ENGINE_TASKS.FOLLOW_UP), context);
    assert.equal((fu.result as { due: number }).due, 0);
  });

  test('relance : permise après silence, interdite après réponse, opt-out ou issue', () => {
    const base = { domain: 'merand.fr', status: 'CONTACTED' as const, contactedOn: '2026-09-01', lastActivityOn: null, followUpsSent: 0, doNotContact: false, afterBusinessDays: 3, today: '2026-09-28' };
    assert.equal(evaluateFollowUp(base).verdict, 'DUE');
    assert.equal(evaluateFollowUp({ ...base, doNotContact: true }).verdict, 'FORBIDDEN');
    assert.equal(evaluateFollowUp({ ...base, followUpsSent: 1 }).verdict === 'DUE', false, 'une seule relance');
    for (const status of ['REPLIED', 'WON', 'LOST', 'NOT_INTERESTED'] as const) {
      assert.notEqual(evaluateFollowUp({ ...base, status: status as never }).verdict, 'DUE', status);
    }
  });
});

describe('E2E — du candidat à la réponse, sans contacter personne', () => {
  test('lot de candidats → fabrique → SEND_ELIGIBLE → mail personnalisé → porte → file → transport → réponse → rendez-vous → gagné', async () => {
    const bench$ = bench(config);
    const segment = campaignLineage(['merand.fr', 'fourpro.fr', 'formulaire.fr', 'solo.fr', 'supprime.fr']);

    // ── Le lot : ce que la découverte aurait versé ─────────────────────
    discovered(repos, 'merand.fr', 'Mérand', '2026-09-28T07:00:00.000Z');
    discovered(repos, 'www.merand.fr', 'Mérand SAS', '2026-09-28T07:05:00.000Z');       // même entreprise, autre ligne
    discovered(repos, 'shop.merand.fr', 'Mérand Boutique', '2026-09-28T07:06:00.000Z');  // sous-domaine
    discovered(repos, 'fourpro.fr', 'FourPro', '2026-09-28T07:10:00.000Z');
    discovered(repos, 'formulaire.fr', 'Formulaire', '2026-09-28T07:20:00.000Z');       // formulaire seul
    discovered(repos, 'solo.fr', 'Solo', '2026-09-28T07:30:00.000Z');                   // une seule recommandation
    discovered(repos, 'supprime.fr', 'Supprimé', '2026-09-28T07:40:00.000Z');           // opt-out antérieur
    const rejected = discovered(repos, 'agence.fr', 'Agence', '2026-09-28T07:50:00.000Z');
    repos.sales.setScore(rejected.id, { score: 18, tier: 'REJECTED', detail: {}, whyFit: 'agence de communication' });
    repos.sales.setState(rejected.id, 'REJECTED', { rejectReason: 'hors ICP' });
    partners(repos, 'merand.fr', PARTNERS['merand.fr']!);
    partners(repos, 'fourpro.fr', PARTNERS['fourpro.fr']!);
    partners(repos, 'formulaire.fr', PARTNERS['merand.fr']!);
    partners(repos, 'solo.fr', [{ domain: 'alpha.fr', name: 'Alpha' }]);
    partners(repos, 'supprime.fr', PARTNERS['merand.fr']!);
    repos.salesEngine.suppress({ kind: 'DOMAIN', value: 'supprime.fr', reason: 'OPT_OUT', createdBy: 'test' });

    // ── Boucle A ────────────────────────────────────────────────────────
    const factory = await factoryOver([
      ['merand.fr', 'Mérand', 'FULL'], ['fourpro.fr', 'FourPro', 'FULL'], ['formulaire.fr', 'Formulaire', 'FORM_ONLY'],
      ['solo.fr', 'Solo', 'FULL'], ['supprime.fr', 'Supprimé', 'FULL'], ['shop.merand.fr', 'Mérand Boutique', 'FULL'],
    ]);
    const cls = (d: string) => repos.revenueFactory.verdict(d)?.classification;
    assert.equal(factory.processed, 7, JSON.stringify(factory.byClass));
    assert.deepEqual(
      { merand: cls('merand.fr'), fourpro: cls('fourpro.fr'), formulaire: cls('formulaire.fr'), solo: cls('solo.fr'), supprime: cls('supprime.fr'), agence: cls('agence.fr'), shop: cls('shop.merand.fr') },
      { merand: 'HOT', fourpro: 'HOT', formulaire: 'NEEDS_ENRICHMENT', solo: 'NEEDS_ENRICHMENT', supprime: 'BLOCKED', agence: 'DROP', shop: 'DUPLICATE' },
    );
    assert.equal(repos.revenueFactory.verdict('merand.fr')!.dedupeResult, 'MERGED:2');
    const eligible = repos.revenueFactory.verdicts({ sendEligible: true }).map((v) => v.domain).sort();
    assert.deepEqual(eligible, ['fourpro.fr', 'merand.fr']);
    // La campagne est héritée de la graine, pas devinée.
    assert.equal(repos.salesEngine.attributionFor('merand.fr')!.segmentId, segment.id);

    // ── Boucle B : rédaction, porte, approbation automatique ────────────
    const drafts = materializeFirstTouchDrafts(repos, bench$, { now: NOW, transportConfigured: true });
    assert.equal(drafts.drafted, 2, JSON.stringify(drafts));
    assert.equal(drafts.autoApproved, 2);
    const byDomain = Object.fromEntries(repos.salesLoop.draftsInState('APPROVED_TO_SEND').map((d) => [d.domain, d]));
    assert.deepEqual(Object.keys(byDomain).sort(), eligible, 'seuls les SEND_ELIGIBLE sont rédigés');
    // Personnalisation propre au destinataire : ses recommandations, pas celles de l'autre.
    assert.match(byDomain['merand.fr']!.body, /Bridor/);
    assert.doesNotMatch(byDomain['merand.fr']!.body, /Greggs|Europastry/);
    assert.match(byDomain['fourpro.fr']!.body, /Greggs/);
    assert.doesNotMatch(byDomain['fourpro.fr']!.body, /Bridor|Panamar/);
    // La provenance survit : chaque source du brouillon est une preuve ou une recommandation du verdict.
    for (const d of eligible) {
      const v = repos.revenueFactory.verdict(d)!;
      const known = new Set([...v.evidence.map((e) => e.sourceUrl), ...v.recommendations.map((r) => r.sourceUrl)]);
      for (const s of byDomain[d]!.sources) assert.ok(known.has(s.sourceUrl), `${d}: ${s.sourceUrl}`);
      assert.equal(byDomain[d]!.recipient, v.contactRoutes.find((r) => r.kind === 'EMAIL')!.value);
      assert.equal(byDomain[d]!.createdBy, FIRST_TOUCH_ACTOR);
    }
    assert.equal(commercialStateOf(repos, 'merand.fr', NOW).state, 'QUEUED');

    // ── Transport : exactement le texte validé, et rien d'autre ──────────
    // (Le délai minimal entre deux envois se juge sur l'horodatage réel de
    // l'issue ; il est éprouvé dans sales-engine.test.ts, pas ici.)
    const transport = new RecordingTransport();
    const first = await runSendCycle({ repos, config: bench$, logger }, { outbound: async () => transport, now: NOW });
    const second = await runSendCycle({ repos, config: bench$, logger }, { outbound: async () => transport, now: new Date(NOW.getTime() + 180_000) });
    assert.equal(first.simulated + second.simulated, 2);
    assert.equal(first.sent + second.sent, 0, 'le banc ne compte aucun envoi réel');
    assert.equal(transport.messages.length, 2);
    for (const m of transport.messages) {
      const d = m.to.split('@')[1]!;
      assert.equal(m.bodyText, byDomain[d]!.body, 'le transport reçoit le texte validé, à l’octet près');
    }
    // Rejouer le cycle, ou tout le pipeline, ne renvoie rien.
    await runSendCycle({ repos, config: bench$, logger }, { outbound: async () => transport, now: new Date(NOW.getTime() + 600_000) });
    const redo = materializeFirstTouchDrafts(repos, bench$, { now: new Date(NOW.getTime() + 600_000), transportConfigured: true });
    await runSendCycle({ repos, config: bench$, logger }, { outbound: async () => transport, now: new Date(NOW.getTime() + 900_000) });
    assert.equal(redo.drafted, 0);
    assert.equal(transport.messages.length, 2, 'aucun doublon d’envoi');
    for (const d of ['formulaire.fr', 'solo.fr', 'supprime.fr', 'agence.fr', 'shop.merand.fr']) {
      assert.ok(!transport.messages.some((m) => m.to.endsWith(`@${d}`)), `${d} ne reçoit rien`);
    }
    // SENT puis DELIVERED, jugés depuis l'horodatage réellement consigné de l'envoi.
    const sentAt = Date.parse(repos.salesLoop.sentLog(10).find((r) => r.domain === 'merand.fr' && r.phase === 'SENT')!.occurredAt!);
    assert.equal(commercialStateOf(repos, 'merand.fr', new Date(sentAt + 60_000)).state, 'SENT');
    assert.equal(commercialStateOf(repos, 'merand.fr', new Date(sentAt + 25 * 3_600_000)).state, 'DELIVERED');

    // ── Réponse simulée, par le vrai chemin d'import de la boîte ───────
    process.env.GMAIL_USER = 'commercial@atlas.example';
    const inbox = new FixtureInboxProvider([
      mailMessage({ messageId: 'rep-1', from: 'Service commercial <commercial@merand.fr>', to: ['commercial@atlas.example'], subject: 'RE: Recherche de distributeurs', bodyText: 'Bonjour, oui cela nous intéresse, proposez-nous un créneau.', receivedAt: new Date(NOW.getTime() + 26 * 3_600_000).toISOString() }),
      mailMessage({ messageId: 'rep-2', from: 'FourPro <commercial@fourpro.fr>', to: ['commercial@atlas.example'], subject: 'RE: Recherche', bodyText: 'Merci de me désinscrire de vos envois.', receivedAt: new Date(NOW.getTime() + 27 * 3_600_000).toISOString() }),
    ]);
    const handlers = createSalesEngineHandlers({ repos, config: bench$, logger, now: () => new Date(NOW.getTime() + 28 * 3_600_000), inbox: () => inbox, outbound: async () => new DryRunOutboundProvider() });
    const sync = await handlers[SALES_ENGINE_TASKS.REPLY_SYNC]!(task(SALES_ENGINE_TASKS.REPLY_SYNC), context);
    assert.equal(sync.kind, 'DONE', JSON.stringify(sync));
    const later = new Date(NOW.getTime() + 28 * 3_600_000);
    assert.equal(commercialStateOf(repos, 'merand.fr', later).state, 'POSITIVE_REPLY');
    assert.equal(commercialStateOf(repos, 'fourpro.fr', later).state, 'SUPPRESSED');
    assert.equal(repos.sales.ledgerFor('fourpro.fr')?.kind, 'DO_NOT_CONTACT');

    // Aucune relance après une réponse ou un opt-out, même des semaines plus tard.
    const followUps = createSalesEngineHandlers({ repos, config: bench$, logger, now: () => new Date('2026-10-30T09:00:00.000Z') });
    const fu = await followUps[SALES_ENGINE_TASKS.FOLLOW_UP]!(task(SALES_ENGINE_TASKS.FOLLOW_UP), context);
    assert.equal((fu.result as { due: number }).due, 0);

    // ── L'issue commerciale, et la boucle de retour ─────────────────────
    recordSalesOutcome(repos, { domain: 'merand.fr', kind: 'MEETING_BOOKED', by: 'founder@test.local' });
    assert.equal(commercialStateOf(repos, 'merand.fr', later).state, 'MEETING');
    recordSalesOutcome(repos, { domain: 'merand.fr', kind: 'PROPOSAL_SENT', by: 'founder@test.local' });
    assert.equal(commercialStateOf(repos, 'merand.fr', later).state, 'PROPOSAL');
    recordSalesOutcome(repos, { domain: 'merand.fr', kind: 'WON', revenueAmount: 1_500, currency: 'EUR', by: 'founder@test.local' });
    assert.equal(commercialStateOf(repos, 'merand.fr', later).state, 'WON');
    const v = repos.revenueFactory.verdict('merand.fr')!;
    const won = repos.salesEngine.outcomes({}).find((o) => o.domain === 'merand.fr' && o.kind === 'WON')!;
    assert.equal(v.firstClassification, 'HOT');
    assert.equal(typeof v.initialScore, 'number');
    assert.equal(won.revenueAmount, 1_500, 'score initial et revenu réel se rejoignent par le domaine');

    // Rien n'a quitté la machine.
    assert.ok(transport.messages.every((m) => m.to.endsWith('@merand.fr') || m.to.endsWith('@fourpro.fr')));
  });
});
