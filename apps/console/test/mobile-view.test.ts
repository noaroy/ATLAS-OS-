import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { RevenueMobile, MobileProspectRow } from '../src/lib/api.ts';
import { heroMetric, funnelSteps, homeActions, filterProspects, parseFilter, parseTab, prospectVerdict } from '../src/lib/mobile-view.ts';

/**
 * Les décisions d'affichage du cockpit mobile, sans navigateur : quel chiffre
 * domine, quelles trois actions au plus, quelles lignes pour quel filtre.
 */

function revenue(over: { kpis?: Partial<RevenueMobile['kpis']>; todo?: Partial<RevenueMobile['todo']>; header?: Partial<RevenueMobile['header']>; trends?: Partial<RevenueMobile['trends']>; factory?: Partial<RevenueMobile['loops']['factory']> } = {}): RevenueMobile {
  const base = {
    generatedAt: '2026-09-28T10:00:00.000Z',
    header: {
      status: 'ONLINE', reasons: [], outbound: 'OFF', sendWindow: { window: '09:00-17:30', open: true },
      killSwitch: { paused: false, reason: null, by: null, at: null }, aiCostTodayUsd: null, aiCostUnknownCalls: 0,
      lastRevenueActionAt: null, lastRevenueAction: null, lastSyncAt: null, lastCycleAt: null,
      services: [{ id: 'gmail', label: 'Gmail', state: 'ok', detail: 'ok' }],
      ...over.header,
    },
    kpis: {
      discoveredToday: 0, qualifiedToday: 0, highPriority: 0, contactReady: 0, sentToday: 0, repliesToday: 0,
      positiveRepliesToday: 0, meetings: 0, proposals: null, won: 0, revenueSigned: 0, currency: 'EUR', pipelinePotential: null,
      ...over.kpis,
    },
    funnel: [
      { key: 'DISCOVERED', count: 400, rate: null }, { key: 'QUALIFIED', count: 100, rate: 0.25 }, { key: 'CONTACT_READY', count: 40, rate: 0.4 },
      { key: 'SENT', count: 20, rate: 0.5 }, { key: 'REPLY', count: 4, rate: 0.2 }, { key: 'MEETING', count: 1, rate: 0.25 },
      { key: 'PROPOSAL', count: null, rate: null }, { key: 'WON', count: 0, rate: 0 },
    ],
    todo: { hotLeads: 0, approvals: 0, followUps: 0, recommendations: 0, segmentsToApprove: 0, total: 0, ...over.todo },
    trends: { days: ['1', '2', '3', '4', '5', '6', '7'], found: [0, 0, 0, 0, 0, 2, 5], qualified: [0, 0, 0, 0, 0, 1, 3], replies: [0, 0, 0, 0, 0, 0, 0], ...over.trends },
    loops: { factory: { processed24h: 60, target24h: 50, runs24h: 5, mainBlocker: null, ...over.factory } },
  };
  return base as unknown as RevenueMobile;
}

describe('le chiffre qui domine', () => {
  test('qualifiés aujourd’hui d’abord, avec la tendance d’hier', () => {
    const h = heroMetric(revenue({ kpis: { qualifiedToday: 3, discoveredToday: 5 } }));
    assert.equal(h.value, 3);
    assert.match(h.label, /qualifiés/);
    assert.deepEqual(h.delta, { text: '+2 vs hier', tone: 'good' });
  });
  test('rien de qualifié mais des découvertes : les découvertes', () => {
    const h = heroMetric(revenue({ kpis: { qualifiedToday: 0, discoveredToday: 5 } }));
    assert.equal(h.value, 5);
    assert.match(h.label, /trouvés/);
  });
  test('journée vide : un zéro mesuré se dit, au singulier près', () => {
    const h = heroMetric(revenue());
    assert.equal(h.value, 0);
    assert.equal(h.label, 'prospects qualifiés aujourd’hui');
  });
});

describe('le funnel compact', () => {
  test('sept étapes, sans « Proposition », jauge en racine carrée', () => {
    const { steps, replyRate } = funnelSteps(revenue());
    assert.deepEqual(steps.map((s) => s.label), ['Trouvés', 'Qualifiés', 'Prêts', 'Envoyés', 'Réponses', 'RDV', 'Gagnés']);
    assert.equal(steps[0]!.share, 1);
    assert.equal(steps[1]!.share, 0.5, 'racine de 100/400');
    assert.equal(replyRate, 0.2);
  });
});

describe('« À faire » : trois cartes au plus, les plus urgentes d’abord', () => {
  test('rien à faire : aucune carte (l’écran dit que tout va bien)', () => {
    assert.deepEqual(homeActions(revenue()), []);
  });
  test('réponses chaudes, puis approbations, puis relances — et jamais plus de trois', () => {
    const a = homeActions(revenue({ todo: { hotLeads: 2, approvals: 5, followUps: 1 }, header: { killSwitch: { paused: true, reason: 'essai', by: 'f', at: null } } }));
    assert.deepEqual(a.map((x) => x.key), ['hot', 'approve', 'follow']);
    assert.equal(a[0]!.title, '2 réponses chaudes');
    assert.equal(a[1]!.to, '/m/outreach?tab=approve');
  });
  test('un service en panne passe devant un simple retard de la fabrique', () => {
    const a = homeActions(revenue({ header: { services: [{ id: 'search', label: 'Search', state: 'down', detail: '3 échecs' }] }, factory: { processed24h: 10, mainBlocker: 'NO_OBSERVED_EMAIL (7)' } }));
    assert.deepEqual(a.map((x) => x.key), ['down']);
  });
  test('fabrique sous l’objectif : le blocage principal, en français', () => {
    const [a] = homeActions(revenue({ factory: { processed24h: 12, mainBlocker: 'RECOMMENDATIONS_BELOW_2 (7)' } }));
    assert.equal(a!.title, 'Fabrique sous l’objectif — 12/50');
    assert.match(a!.hint, /cibles à enrichir/);
    assert.doesNotMatch(a!.hint, /_/);
  });
});

describe('filtres de prospects', () => {
  const row = (over: Partial<MobileProspectRow>): MobileProspectRow => ({
    domain: 'x.fr', companyName: 'X', score: 50, tier: 'GOOD_FIT', factoryClass: null, sendEligible: false, commercialState: 'NONE',
    contactReady: false, mainBlocker: null, blockers: 0, discoveredAt: '', lastActivityAt: '', ...over,
  });
  const rows = [
    row({ domain: 'prio.fr', companyName: 'Prio', tier: 'PRIORITY', sendEligible: true, factoryClass: 'HOT' }),
    row({ domain: 'bloque.fr', companyName: 'Bloqué', factoryClass: 'NEEDS_ENRICHMENT' }),
    row({ domain: 'envoye.fr', companyName: 'Envoyé', commercialState: 'SENT', sendEligible: true }),
    row({ domain: 'repondu.fr', companyName: 'Répondu', commercialState: 'POSITIVE_REPLY' }),
  ];
  test('chaque filtre garde ce qu’il dit', () => {
    const d = (f: Parameters<typeof filterProspects>[1]) => filterProspects(rows, f, '').map((r) => r.domain);
    assert.equal(d('all').length, 4);
    assert.deepEqual(d('priority'), ['prio.fr']);
    assert.deepEqual(d('ready'), ['prio.fr'], 'un éligible déjà contacté n’est plus « prêt »');
    assert.deepEqual(d('blocked'), ['bloque.fr']);
    assert.deepEqual(d('contacted'), ['envoye.fr', 'repondu.fr']);
    assert.deepEqual(d('replies'), ['repondu.fr']);
  });
  test('recherche sur le nom ou le domaine ; paramètres d’URL inconnus → valeur par défaut', () => {
    assert.deepEqual(filterProspects(rows, 'all', 'répo').map((r) => r.domain), ['repondu.fr']);
    assert.deepEqual(filterProspects(rows, 'all', 'bloque.fr').map((r) => r.domain), ['bloque.fr']);
    assert.equal(parseFilter('nimporte'), 'all');
    assert.equal(parseTab(null), 'approve');
    assert.equal(parseTab('replies'), 'replies');
  });
});

describe('le verdict d’une fiche : l’avancement n’est pas un blocage', () => {
  const draft = (state: string) => ({ id: 'd', purpose: 'FIRST_TOUCH', state, recipient: 'a@x.fr', subject: 's', body: 'b', sources: [], createdAt: '', createdBy: 'engine' });
  test('rien ne manque : prêt pour premier contact', () => {
    assert.deepEqual(prospectVerdict({ blockers: [], firstTouchReady: true, drafts: [] }), { tone: 'good', icon: 'check', title: 'Prêt pour premier contact', items: [] });
  });
  test('ce qui manque se compte et se dit en français', () => {
    const v = prospectVerdict({ blockers: ['NO_OBSERVED_EMAIL', 'RECOMMENDATIONS_BELOW_2'], firstTouchReady: false, drafts: [] });
    assert.equal(v.title, 'Bloqué — 2 éléments manquants');
    assert.deepEqual(v.items, ['Adresse email à trouver', 'Cibles à enrichir']);
  });
  test('un brouillon écrit attend l’approbation — il n’est pas « bloqué »', () => {
    const v = prospectVerdict({ blockers: ['PRIOR_FIRST_TOUCH'], firstTouchReady: false, drafts: [draft('READY_FOR_APPROVAL')] });
    assert.equal(v.title, 'Brouillon prêt — à approuver');
    assert.deepEqual(v.items, []);
  });
  test('contacté, puis réponse : la conversation prime', () => {
    assert.match(prospectVerdict({ blockers: ['ALREADY_SENT', 'PRIOR_FIRST_TOUCH'], firstTouchReady: false, drafts: [draft('SENT')] }).title, /Déjà contacté/);
    assert.match(prospectVerdict({ blockers: ['LEDGER_CONTACTED', 'REPLY_RECEIVED', 'ALREADY_SENT'], firstTouchReady: false, drafts: [draft('SENT')] }).title, /A répondu/);
  });
  test('la fabrique retient : « bloqué », même si les gardes du premier contact passent', () => {
    const factory = { classification: 'NEEDS_ENRICHMENT', sendEligible: false, blockers: ['IDENTITY_UNVERIFIED'], processedAt: '' };
    const v = prospectVerdict({ blockers: [], firstTouchReady: true, drafts: [], factory });
    assert.match(v.title, /^Bloqué — 1 élément manquant$/);
    assert.equal(v.items.length, 1);
    assert.doesNotMatch(v.items[0]!, /_/);
    assert.equal(prospectVerdict({ blockers: [], firstTouchReady: true, drafts: [], factory: { ...factory, sendEligible: true, blockers: [] } }).title, 'Prêt pour premier contact');
  });
  test('une suppression passe devant tout', () => {
    assert.equal(prospectVerdict({ blockers: ['REPLY_RECEIVED', 'SUPPRESSED'], firstTouchReady: false, drafts: [] }).title, 'Ne plus contacter');
  });
});
