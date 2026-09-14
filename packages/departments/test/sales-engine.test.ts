import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyReplyIntent,
  contactConfidence,
  evaluateSendPolicy,
  isWithinSendWindow,
  deliverabilityAlarm,
  chooseVariant,
  funnelRates,
  revenuePer100,
  cac,
  pipelinePotential,
  segmentDecision,
  compareVariants,
  recommend,
  engineeringInsights,
  applyStrategyChange,
  requiresHumanApproval,
  periodKey,
  DEFAULT_STRATEGY,
  POSITIVE_REPLY_INTENTS,
  type SendPolicy,
  type SendPolicyState,
} from '../src/sales-engine.ts';

/**
 * Les règles du moteur commercial, sans base ni réseau.
 *
 * Chaque test tient une décision qu'un envoi réel ne permettrait pas de
 * reprendre : un message parti à un opt-out, un segment élargi sur trois
 * réponses, un CAC affiché à zéro faute de client. Les chiffres de la
 * simulation de bout en bout (500 → 200 → 120 → 100 → 12 → 5 → 3 → 1) sont
 * ceux que le tableau de bord doit rendre, exactement.
 */

const POLICY: SendPolicy = {
  dailyCapPerMailbox: 10, hourlyCap: 3, minDelaySeconds: 120, sendWindow: '09:00-17:30',
  weekendEnabled: false, timezone: 'Europe/Paris', maxFollowUps: 1, bouncePauseRate: 0.05, bounceMinSample: 20,
};

/** Un mardi à 11 h à Paris (été : UTC+2). */
const TUESDAY_11H = new Date('2026-09-15T09:00:00.000Z');
/** Un samedi à 11 h à Paris. */
const SATURDAY_11H = new Date('2026-09-19T09:00:00.000Z');
/** Un mardi à 22 h à Paris. */
const TUESDAY_22H = new Date('2026-09-15T20:00:00.000Z');

const openState = (over: Partial<SendPolicyState> = {}): SendPolicyState => ({
  now: TUESDAY_11H,
  outboundEnabled: true,
  engineMode: 'PRODUCTION',
  globalPause: { paused: false },
  campaign: { approvedForSend: true, status: 'TESTING' },
  suppressed: { suppressed: false },
  replyReceived: false,
  purpose: 'FIRST_TOUCH',
  followUpsSent: 0,
  sentToday: 0,
  sentThisHour: 0,
  lastSentAt: null,
  bounces: { sent: 0, bounced: 0 },
  transportConfigured: true,
  ...over,
});

const reasons = (state: SendPolicyState) => evaluateSendPolicy(POLICY, state).blocks.map((b) => b.reason);

describe('intention d’une réponse (§16)', () => {
  test('un rebond reste un rebond, une absence reste une absence', () => {
    assert.equal(classifyReplyIntent({ classification: 'BOUNCED', body: 'Delivery failed' }).intent, 'BOUNCE');
    assert.equal(classifyReplyIntent({ classification: 'AUTO_REPLY', body: 'Je suis absent jusqu’au 24 août' }).intent, 'OUT_OF_OFFICE');
  });

  test('le désabonnement gagne sur tout le reste', () => {
    const v = classifyReplyIntent({ classification: 'REPLIED', body: 'Merci de me désabonner de vos envois, même si la proposition est intéressante.' });
    assert.equal(v.intent, 'OPT_OUT');
    assert.ok(v.confidence >= 0.9);
  });

  test('les classes commerciales se reconnaissent, en français et en anglais', () => {
    assert.equal(classifyReplyIntent({ classification: 'REPLIED', body: 'Bonjour, oui, cela m’intéresse. Pouvons-nous planifier un appel la semaine prochaine ?' }).intent, 'POSITIVE');
    assert.equal(classifyReplyIntent({ classification: 'REPLIED', body: 'Pas pour le moment, revenez vers nous à la rentrée.' }).intent, 'INTERESTED_LATER');
    assert.equal(classifyReplyIntent({ classification: 'REPLIED', body: 'Combien coûte votre prestation et comment se déroule-t-elle ?' }).intent, 'QUESTION');
    // « pas intéressé » est un opt-out depuis Reply Intake V1 : la règle ne bouge pas.
    assert.equal(classifyReplyIntent({ classification: 'REPLIED', body: 'Nous ne sommes pas intéressés, merci.' }).intent, 'OPT_OUT');
    assert.equal(classifyReplyIntent({ classification: 'REPLIED', body: 'Nous avons déjà un prestataire, cela ne nous convient pas.' }).intent, 'NEGATIVE');
    assert.equal(classifyReplyIntent({ classification: 'REPLIED', body: 'Vous avez la mauvaise personne, je ne suis pas en charge de ce sujet.' }).intent, 'NOT_RELEVANT');
    assert.equal(classifyReplyIntent({ classification: 'REPLIED', body: 'Not interested, thanks.' }).intent, 'NEGATIVE');
  });

  test('une question posée avec un refus n’est pas une ouverture', () => {
    const v = classifyReplyIntent({ classification: 'REPLIED', body: 'Nous avons déjà un prestataire et cela ne nous convient pas. Pourquoi nous écrivez-vous ?' });
    assert.equal(v.intent, 'NEGATIVE');
  });

  test('sans marqueur, NEUTRAL avec une confiance basse — jamais rangé d’office', () => {
    const v = classifyReplyIntent({ classification: 'REPLIED', body: 'Bien reçu.' });
    assert.equal(v.intent, 'NEUTRAL');
    assert.ok(v.confidence < 0.5);
    assert.ok(!POSITIVE_REPLY_INTENTS.includes('NEUTRAL'));
  });
});

describe('confiance dans un contact (§9)', () => {
  test('HIGH exige observé, même domaine, intention commerciale', () => {
    assert.equal(contactConfidence({ observed: true, sameDomain: true, intent: 'SALES', suitability: 'HIGH', sourceUrl: 'https://x.fr/contact' }).level, 'HIGH');
    assert.equal(contactConfidence({ observed: true, sameDomain: true, intent: 'GENERAL', suitability: 'MEDIUM', sourceUrl: 'https://x.fr/contact' }).level, 'MEDIUM');
    assert.equal(contactConfidence({ observed: false, sameDomain: true, intent: 'SALES', suitability: 'HIGH', sourceUrl: null }).level, 'LOW');
    assert.equal(contactConfidence({ observed: true, sameDomain: true, intent: 'HR', suitability: 'BLOCKED', sourceUrl: 'https://x.fr/jobs' }).level, 'LOW');
  });
});

describe('politique d’envoi globale (§12–13, §42, §65–67, §69)', () => {
  test('tout ouvert : autorisé', () => {
    const verdict = evaluateSendPolicy(POLICY, openState());
    assert.equal(verdict.allowed, true, verdict.blocks.map((b) => b.detail).join(' | '));
  });

  test('l’interrupteur général fermé bloque, quoi que disent les autres réglages', () => {
    assert.ok(reasons(openState({ outboundEnabled: false })).includes('OUTBOUND_DISABLED'));
  });

  test('INTERNAL_TEST ne contacte jamais un vrai prospect', () => {
    assert.ok(reasons(openState({ engineMode: 'INTERNAL_TEST' })).includes('INTERNAL_TEST_MODE'));
  });

  test('le coupe-circuit bloque', () => {
    assert.ok(reasons(openState({ globalPause: { paused: true, reason: 'AUTO_PAUSE_BOUNCE' } })).includes('GLOBAL_PAUSE'));
  });

  test('une campagne non approuvée ou absente bloque (§67)', () => {
    assert.ok(reasons(openState({ campaign: null })).includes('CAMPAIGN_NOT_APPROVED'));
    assert.ok(reasons(openState({ campaign: { approvedForSend: false, status: 'TESTING' } })).includes('CAMPAIGN_NOT_APPROVED'));
    assert.ok(reasons(openState({ campaign: { approvedForSend: true, status: 'PAUSED' } })).includes('CAMPAIGN_NOT_ACTIVE'));
  });

  test('suppression, réponse reçue, relance de trop : blocages structurels', () => {
    assert.ok(reasons(openState({ suppressed: { suppressed: true, detail: 'EMAIL x — OPT_OUT' } })).includes('SUPPRESSED'));
    assert.ok(reasons(openState({ replyReceived: true })).includes('REPLY_RECEIVED'));
    assert.ok(reasons(openState({ purpose: 'FOLLOW_UP', followUpsSent: 1 })).includes('MAX_FOLLOWUPS_REACHED'));
    assert.ok(!reasons(openState({ purpose: 'FOLLOW_UP', followUpsSent: 0 })).includes('MAX_FOLLOWUPS_REACHED'));
  });

  test('plafonds et délai minimal', () => {
    assert.ok(reasons(openState({ sentToday: 10 })).includes('DAILY_CAP_REACHED'));
    assert.ok(reasons(openState({ sentThisHour: 3 })).includes('HOURLY_CAP_REACHED'));
    assert.ok(reasons(openState({ lastSentAt: new Date(TUESDAY_11H.getTime() - 30_000).toISOString() })).includes('MIN_DELAY_NOT_ELAPSED'));
    assert.ok(!reasons(openState({ lastSentAt: new Date(TUESDAY_11H.getTime() - 300_000).toISOString() })).includes('MIN_DELAY_NOT_ELAPSED'));
  });

  test('fenêtre d’envoi et week-end, en heure locale du fuseau', () => {
    assert.equal(isWithinSendWindow(TUESDAY_11H, POLICY).open, true);
    assert.equal(isWithinSendWindow(TUESDAY_22H, POLICY).open, false);
    assert.equal(isWithinSendWindow(SATURDAY_11H, POLICY).open, false);
    assert.equal(isWithinSendWindow(SATURDAY_11H, { ...POLICY, weekendEnabled: true }).open, true);
    assert.ok(reasons(openState({ now: TUESDAY_22H })).includes('OUTSIDE_SEND_WINDOW'));
    assert.ok(reasons(openState({ now: SATURDAY_11H })).includes('WEEKEND'));
    // Le fuseau compte : 09:00 UTC est 11:00 à Paris mais 05:00 à New York.
    assert.equal(isWithinSendWindow(TUESDAY_11H, { ...POLICY, timezone: 'America/New_York' }).open, false);
  });

  test('trop de rebonds sur un échantillon suffisant : blocage, et pas avant', () => {
    assert.ok(reasons(openState({ bounces: { sent: 40, bounced: 4 } })).includes('BOUNCE_RATE_TOO_HIGH'));
    assert.ok(!reasons(openState({ bounces: { sent: 10, bounced: 4 } })).includes('BOUNCE_RATE_TOO_HIGH'));
    const small = deliverabilityAlarm({ sent: 10, bounced: 4 }, { rate: 0.05, minSample: 20 });
    assert.equal(small.alarm, false);
    assert.match(small.reason, /échantillon/);
  });

  test('un transport sans portée d’envoi bloque avant toute réservation', () => {
    assert.ok(reasons(openState({ transportConfigured: false })).includes('TRANSPORT_UNAVAILABLE'));
  });
});

describe('variantes (§11)', () => {
  test('même clé, mêmes poids : même variante ; la répartition suit les poids', () => {
    const variants = [{ key: 'A', weight: 1 }, { key: 'B', weight: 1 }];
    assert.equal(chooseVariant('acme.fr', variants), chooseVariant('acme.fr', variants));
    const counts = { A: 0, B: 0 };
    for (let i = 0; i < 2000; i += 1) counts[chooseVariant(`d${i}.fr`, variants) as 'A' | 'B'] += 1;
    assert.ok(Math.abs(counts.A - counts.B) < 300, `${counts.A} / ${counts.B}`);
    assert.equal(chooseVariant('x', [{ key: 'A', weight: 0 }]), null);
    assert.equal(chooseVariant('x', [{ key: 'A', weight: 0 }, { key: 'B', weight: 2 }]), 'B');
  });
});

describe('entonnoir et indicateurs (§19–25, §57–63)', () => {
  test('la simulation de bout en bout donne exactement les chiffres attendus', () => {
    const rates = funnelRates({
      discovered: 500, icpQualified: 200, contactsFound: 120, contacted: 100, replied: 12,
      positiveReplies: 5, meetings: 3, clients: 1, revenueWon: 1200, spendUsd: 24,
    });
    assert.equal(rates.qualifiedRate, 0.4);
    assert.equal(rates.contactFoundRate, 0.6);
    assert.equal(rates.contactedRate, 100 / 120);
    assert.equal(rates.replyRate, 0.12);
    assert.equal(rates.positiveReplyRate, 0.05);
    assert.equal(rates.meetingPerContact, 0.03);
    assert.equal(rates.clientPerContact, 0.01);
    assert.equal(rates.revenuePer100, 1200);
    assert.equal(rates.cac, 24);
  });

  test('sans client, le CAC est absent — jamais zéro ; sans contact, le CA/100 aussi', () => {
    assert.equal(cac(24, 0), null);
    assert.equal(cac(null, 1), null);
    assert.equal(revenuePer100(0, 0), null);
    assert.equal(revenuePer100(600, 50), 1200);
  });

  test('le pipeline potentiel n’existe que sur des valeurs connues, et s’explique', () => {
    const unknown = pipelinePotential({ openMeetings: 3, hotLeads: 5, averageDealValue: null, meetingToClientRate: null, leadToMeetingRate: null });
    assert.equal(unknown.value, null);
    assert.match(unknown.explanation[0]!, /valeur moyenne inconnue/);
    const known = pipelinePotential({ openMeetings: 2, hotLeads: 4, averageDealValue: 1000, meetingToClientRate: 0.5, leadToMeetingRate: 0.5 });
    assert.equal(known.value, 2 * 0.5 * 1000 + 4 * 0.5 * 0.5 * 1000);
    assert.equal(known.explanation.length, 2);
  });
});

describe('vie d’un segment (§3–4)', () => {
  test('sous la taille de test : pas de conclusion', () => {
    assert.equal(segmentDecision('TESTING', { contacted: 0, replied: 0, positive: 0, meetings: 0, clients: 0, revenue: 0 }).action, 'INSUFFICIENT_DATA');
    assert.equal(segmentDecision('TESTING', { contacted: 30, replied: 5, positive: 4, meetings: 1, clients: 0, revenue: 0 }).action, 'CONTINUE_TEST');
  });

  test('un bon segment se valide puis s’élargit ; un mauvais se réduit ; un segment avec rendez-vous se garde', () => {
    assert.equal(segmentDecision('TESTING', { contacted: 60, replied: 8, positive: 5, meetings: 1, clients: 0, revenue: 0 }).action, 'SCALE');
    assert.equal(segmentDecision('TESTING', { contacted: 60, replied: 5, positive: 2, meetings: 0, clients: 0, revenue: 0 }).action, 'VALIDATE');
    assert.equal(segmentDecision('TESTING', { contacted: 60, replied: 1, positive: 0, meetings: 0, clients: 0, revenue: 0 }).action, 'REDUCE');
    assert.equal(segmentDecision('TESTING', { contacted: 60, replied: 1, positive: 0, meetings: 1, clients: 0, revenue: 0 }).action, 'HOLD');
    assert.equal(segmentDecision('PAUSED', { contacted: 600, replied: 100, positive: 90, meetings: 9, clients: 3, revenue: 0 }).action, 'HOLD');
  });
});

describe('comparaison de variantes et recommandations (§26–36)', () => {
  const stats = (key: string, contacted: number, positive: number) => ({ key, contacted, replied: positive, positive, meetings: 0, clients: 0, revenue: 0 });

  test('un petit échantillon donne INSUFFICIENT_DATA, pas un gagnant', () => {
    const c = compareVariants(stats('A', 8, 4), stats('B', 9, 0));
    assert.equal(c.confident, false);
    assert.match(c.reason, /INSUFFICIENT_DATA/);
  });

  test('un écart net sur un échantillon suffisant est concluant', () => {
    const c = compareVariants(stats('B', 120, 14), stats('A', 120, 3));
    assert.equal(c.confident, true);
    assert.ok((c.lift ?? 0) > 1);
  });

  test('segment A bon, segment B mauvais, message B meilleur : trois recommandations, humaines', () => {
    const { recommendations, insufficient } = recommend({
      segments: [
        { id: 'segA', name: 'A', status: 'TESTING', explorationWeight: 1, stats: { contacted: 80, replied: 12, positive: 7, meetings: 2, clients: 0, revenue: 0 } },
        { id: 'segB', name: 'B', status: 'TESTING', explorationWeight: 1, stats: { contacted: 80, replied: 2, positive: 0, meetings: 0, clients: 0, revenue: 0 } },
        { id: 'segC', name: 'C', status: 'TESTING', explorationWeight: 1, stats: { contacted: 12, replied: 3, positive: 3, meetings: 1, clients: 0, revenue: 0 } },
      ],
      variants: [{ dimension: 'message_variant', stats: [stats('A', 100, 3), stats('B', 100, 13)] }],
      followUps: { sent: 60, replied: 0 },
      frictions: {},
      discovered: 400,
      contacted: 160,
    });
    const kinds = recommendations.map((r) => r.kind);
    assert.ok(kinds.includes('SCALE_SEGMENT'), kinds.join());
    assert.ok(kinds.includes('REDUCE_SEGMENT'));
    assert.ok(kinds.includes('PROMOTE_MESSAGE'));
    assert.ok(kinds.includes('CHANGE_FOLLOWUP'));
    assert.equal(recommendations.find((r) => r.kind === 'PROMOTE_MESSAGE')?.change?.key, 'B');
    assert.ok(recommendations.every((r) => r.humanRequired), 'aucun changement automatique par défaut');
    assert.deepEqual(insufficient.map((i) => i.subject), ['segment C']);
  });

  test('un plateau bas partout appelle un nouveau message ; trop de contacts introuvables appelle une meilleure source', () => {
    const { recommendations } = recommend({
      segments: [],
      variants: [{ dimension: 'message_variant', stats: [stats('A', 100, 1), stats('B', 100, 2)] }],
      followUps: null,
      frictions: { CONTACT_NOT_FOUND: 60 },
      discovered: 100,
      contacted: 40,
    });
    const kinds = recommendations.map((r) => r.kind);
    assert.ok(kinds.includes('TEST_NEW_MESSAGE'));
    assert.ok(kinds.includes('IMPROVE_CONTACT_SOURCE'));
    assert.ok(!kinds.includes('PROMOTE_MESSAGE'), 'un écart 1 % vs 2 % sur 100 n’est pas concluant');
  });

  test('les frictions répétées deviennent des insights d’ingénierie, sans code', () => {
    const insights = engineeringInsights({ SEARCH_FAILURE: 7, LLM_FAILURE: 1, COUNTRY_UNCERTAIN: 12 }, { discovered: 50, contacted: 10 });
    assert.deepEqual(insights.map((i) => i.fingerprint), ['COUNTRY_UNCERTAIN', 'SEARCH_FAILURE']);
  });
});

describe('stratégie versionnée et bornée (§31–33, §75–77)', () => {
  test('un poids bouge d’un pas borné, dans [0, 2] ; un paramètre hors périmètre est refusé', () => {
    const one = applyStrategyChange(DEFAULT_STRATEGY, { param: 'segmentWeights', key: 'segA', delta: 0.25 });
    assert.equal(one.applied, true);
    assert.equal(one.next.segmentWeights.segA, 1.25);
    assert.equal(applyStrategyChange(DEFAULT_STRATEGY, { param: 'segmentWeights', key: 'segA', delta: 0.6 }).applied, false);
    assert.equal(applyStrategyChange(DEFAULT_STRATEGY, { param: 'dailyCap' as never, key: 'x', delta: 0.1 }).applied, false);
    const clamped = applyStrategyChange({ ...DEFAULT_STRATEGY, segmentWeights: { segA: 1.9 } }, { param: 'segmentWeights', key: 'segA', delta: 0.25 });
    assert.equal(clamped.next.segmentWeights.segA, 2);
    // L'objet d'origine n'est jamais muté : la version d'avant reste lisible.
    assert.equal(DEFAULT_STRATEGY.segmentWeights.segA, undefined);
  });

  test('l’ordre des personas n’accepte qu’un ajout à la fois', () => {
    const ok = applyStrategyChange(DEFAULT_STRATEGY, { param: 'personaPriority', value: ['directeur commercial', 'dirigeant', 'responsable export', 'business development', 'directeur marketing'] });
    assert.equal(ok.applied, true);
    const tooMany = applyStrategyChange(DEFAULT_STRATEGY, { param: 'personaPriority', value: ['a', 'b'] });
    assert.equal(tooMany.applied, false);
  });

  test('par défaut, tout changement exige une personne ; le pas fin ne s’applique seul que si on l’a permis', () => {
    const change = { param: 'segmentWeights' as const, key: 'segA', delta: 0.05 };
    assert.equal(requiresHumanApproval(change, { ...DEFAULT_STRATEGY, segmentWeights: { segA: 1 } }).required, true);
    assert.equal(requiresHumanApproval(change, { ...DEFAULT_STRATEGY, segmentWeights: { segA: 1 } }, { autoApplyTiny: true }).required, false);
    assert.equal(requiresHumanApproval({ ...change, key: 'nouveau' }, DEFAULT_STRATEGY, { autoApplyTiny: true }).required, true);
    assert.equal(requiresHumanApproval({ ...change, delta: 0.3 }, { ...DEFAULT_STRATEGY, segmentWeights: { segA: 1 } }, { autoApplyTiny: true }).required, true);
  });
});

describe('planification (§37–41)', () => {
  test('la même fenêtre donne la même clé ; la fenêtre suivante en donne une autre', () => {
    const a = periodKey('send', new Date('2026-09-15T09:03:00.000Z'), 10);
    const b = periodKey('send', new Date('2026-09-15T09:08:00.000Z'), 10);
    const c = periodKey('send', new Date('2026-09-15T09:11:00.000Z'), 10);
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.notEqual(periodKey('send', new Date('2026-09-15T09:03:00.000Z'), 10), periodKey('reply', new Date('2026-09-15T09:03:00.000Z'), 10));
  });
});
