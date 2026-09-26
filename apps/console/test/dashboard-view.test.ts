import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  freshnessOf, applyResult, ago, mainResultOf, rankSegments, todoLines, describeRecommendation, systemProblems,
  systemVerdict, opportunitySummary, STALE_AFTER_MS, DEAD_AFTER_MS, type LiveState,
} from '../src/lib/dashboard-view.ts';

/**
 * Les règles d'affichage de l'accueil, sans navigateur.
 *
 * Ce qui compte ici : une coupure ne remet jamais un chiffre à zéro, l'âge
 * des données se voit dès qu'il compte, une reconnexion resynchronise, et
 * chaque libellé dit ce que Noa doit faire — pas ce que la machine a fait.
 */

const board = { cards: 1 } as unknown as { cards: number };

describe('fraîcheur et coupure (§reconnexion)', () => {
  test('une première lecture réussie est « À jour » ; l’âge s’affiche après quelques secondes', () => {
    const t0 = 1_000_000;
    assert.equal(freshnessOf(t0, t0 + 2_000, false).label, 'À jour');
    assert.equal(freshnessOf(t0, t0 + 12_000, false).label, 'Mis à jour il y a 12 s');
    assert.equal(freshnessOf(null, t0, false).state, 'never');
  });

  test('coupure du backend : la dernière valeur est conservée et l’état passe en obsolète, puis en rouge', () => {
    const t0 = 1_000_000;
    let state: LiveState<typeof board> = { data: null, lastOkAt: null, failures: 0, lastError: null };
    state = applyResult(state, { ok: true, data: board, at: t0 });
    state = applyResult(state, { ok: false, error: 'Failed to fetch' });
    state = applyResult(state, { ok: false, error: 'Failed to fetch' });
    assert.deepEqual(state.data, board, 'les chiffres ne sont pas remis à zéro');
    assert.equal(state.failures, 2);
    assert.equal(freshnessOf(state.lastOkAt, t0 + 5_000, true).state, 'stale', 'hors ligne : obsolète même récent');
    assert.equal(freshnessOf(state.lastOkAt, t0 + STALE_AFTER_MS, false).state, 'stale');
    assert.equal(freshnessOf(state.lastOkAt, t0 + DEAD_AFTER_MS, false).state, 'dead');
    assert.match(freshnessOf(state.lastOkAt, t0 + DEAD_AFTER_MS, false).label, /obsolètes/);
  });

  test('reconnexion : la lecture suivante remet la fraîcheur à zéro et efface les échecs', () => {
    const t0 = 1_000_000;
    let state: LiveState<typeof board> = { data: board, lastOkAt: t0, failures: 3, lastError: 'x' };
    state = applyResult(state, { ok: true, data: { cards: 2 }, at: t0 + 200_000 });
    assert.equal(state.failures, 0);
    assert.equal(state.lastError, null);
    assert.deepEqual(state.data, { cards: 2 });
    assert.equal(freshnessOf(state.lastOkAt, t0 + 201_000, false).state, 'fresh');
  });

  test('l’ancienneté se dit en secondes, minutes, heures, jours', () => {
    const now = Date.parse('2026-09-15T12:00:00.000Z');
    assert.equal(ago('2026-09-15T11:59:37.000Z', now), 'Il y a 23 s');
    assert.equal(ago('2026-09-15T11:37:00.000Z', now), 'Il y a 23 min');
    assert.equal(ago('2026-09-15T09:00:00.000Z', now), 'Il y a 3 h');
    assert.equal(ago('2026-09-10T12:00:00.000Z', now), 'Il y a 5 j');
  });
});

describe('libellés', () => {
  test('un segment se résume par son meilleur résultat', () => {
    assert.equal(mainResultOf({ clients: 2, meetings: 5, positiveReplies: 9, contacted: 80 }), '2 clients');
    assert.equal(mainResultOf({ clients: 0, meetings: 1, positiveReplies: 9, contacted: 80 }), '1 RDV');
    assert.equal(mainResultOf({ clients: 0, meetings: 0, positiveReplies: 1, contacted: 80 }), '1 réponse positive');
    assert.equal(mainResultOf({ clients: 0, meetings: 0, positiveReplies: 0, contacted: 12 }), '12 contactées');
    assert.equal(mainResultOf({ clients: 0, meetings: 0, positiveReplies: 0, contacted: 0 }), 'aucun contact');
  });

  test('cinq segments au plus, les plus parlants d’abord', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: String(i), clients: i % 3, meetings: i, positiveReplies: 0, contacted: 10 }));
    const ranked = rankSegments(many);
    assert.equal(ranked.length, 5);
    assert.equal(ranked[0]!.clients, 2);
  });

  test('« À faire » ne liste que ce qui existe, avec le bon pluriel', () => {
    assert.deepEqual(todoLines({ hotLeads: 0, approvals: 0, followUps: 0, recommendations: 0, segmentsToApprove: 0 }), []);
    const lines = todoLines({ hotLeads: 3, approvals: 1, followUps: 0, recommendations: 1, segmentsToApprove: 0 });
    assert.deepEqual(lines.map((l) => l.label), ['3 réponses à traiter', '1 prospect à vérifier', '1 recommandation ATLAS']);
  });

  test('une recommandation se dit en langage humain, avec une question et deux réponses', () => {
    const r = describeRecommendation({
      kind: 'SCALE_SEGMENT', title: 'Élargir le segment Machines industrielles', reason: 'x', hasChange: true,
      evidence: { positiveRate: 0.0875, contacted: 80 },
    });
    assert.equal(r.eyebrow, 'ATLAS a repéré une opportunité');
    assert.match(r.headline, /Machines industrielles/);
    assert.match(r.headline, /8\.8 %/);
    assert.equal(r.yes, 'Oui, tester');
    assert.equal(r.no, 'Pas maintenant');
    assert.equal(r.yesDecision, 'test');
    const insight = describeRecommendation({ kind: 'ENGINEERING_INSIGHT', title: 'Le moteur échoue', reason: '7 échecs', hasChange: false });
    assert.equal(insight.yes, 'Vu');
    assert.equal(insight.yesDecision, 'approve');
  });

  test('la ligne système ne parle que quand quelque chose cloche', () => {
    const ok = { state: 'ok', detail: 'x' };
    assert.deepEqual(systemProblems({ search: ok, llm: ok, gmail: ok, workers: ok, outbound: { paused: false, pauseReason: null } }), []);
    const problems = systemProblems({ search: ok, llm: ok, gmail: { state: 'down', detail: 'jeton expiré' }, workers: ok, outbound: { paused: true, pauseReason: 'AUTO_PAUSE_BOUNCE' } });
    assert.deepEqual(problems, ['Email : jeton expiré', 'Envois en pause — AUTO_PAUSE_BOUNCE']);
  });

  test('le verdict système dit ce qui bloque un premier contact', () => {
    const ok = { state: 'ok', detail: 'x' };
    const live = { enabled: true, mode: 'PRODUCTION', paused: false, pauseReason: null };
    assert.deepEqual(systemVerdict({ search: ok, llm: ok, gmail: ok, workers: ok, outbound: live }), { tone: 'ok', headline: 'En marche — rien ne bloque', blockers: [] });
    const dry = systemVerdict({ search: ok, llm: ok, gmail: ok, workers: ok, outbound: { ...live, mode: 'DRY_RUN' } });
    assert.equal(dry.tone, 'warn');
    assert.deepEqual(dry.blockers, ['Mode DRY_RUN : aucun envoi réel']);
    const off = systemVerdict({ search: ok, llm: ok, gmail: ok, workers: ok, outbound: { ...live, enabled: false } });
    assert.equal(off.tone, 'bad');
    assert.match(off.blockers[0]!, /interrupteur fermé/);
    assert.equal(systemVerdict({ search: ok, llm: ok, gmail: ok, workers: ok, outbound: { ...live, paused: true, pauseReason: 'x' } }).tone, 'bad');
  });

  test('une opportunité n’est prête que si son email a été observé', () => {
    assert.deepEqual(opportunitySummary({ tier: 'PRIORITY', score: 90, contact: { email: 'a@b.fr', observed: true } }),
      { tier: 'Priorité · 90', contact: 'Email observé : a@b.fr', ready: true });
    assert.equal(opportunitySummary({ tier: null, score: null, contact: { email: 'a@b.fr', observed: false } }).ready, false);
    assert.equal(opportunitySummary({ tier: null, score: null, contact: { email: null, observed: false } }).contact, 'Contact à trouver');
  });
});
