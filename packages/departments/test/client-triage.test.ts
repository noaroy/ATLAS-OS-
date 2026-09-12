import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  triageCandidate, compareReviewOrder, decideCandidate, AUTO_APPROVAL_MIN_SCORE,
  type CriterionResult, type SpecialisationResult, type TriageInput,
} from '../src/index.ts';

/**
 * Le tri final, cas par cas. Chaque cas correspond à une société du premier
 * lot suédois réel : celle qu'un humain relisait pour rien, celle qu'il
 * aurait dû voir en premier, celle qu'il ne doit jamais voir partir seule.
 */
const preuve = (quote = 'Vi säljer förpackningsmaskiner.') => ({ evidenceQuote: quote, sourceUrl: 'https://x.se/', normalizedClaim: quote, sourcePageTitle: null, evidenceType: 'COMMERCIAL_FACT' as const, blockId: 1 });
const critere = (key: string, kind: CriterionResult['kind'], verdict: CriterionResult['verdict'], avecPreuve = true): CriterionResult => ({
  key, label: `Critère ${key}`, kind, weight: 1, verdict, note: 'note', downgraded: null,
  evidence: (verdict === 'ESTABLISHED' || verdict === 'NOT_ESTABLISHED' || verdict === 'EXCLUDED') && avecPreuve ? [preuve()] : [],
});
const spec = (verdict: SpecialisationResult['verdict']): SpecialisationResult => ({ verdict, note: 'n', evidence: verdict === 'TO_CONFIRM' ? [] : [preuve()] });

function entree(over: Partial<TriageInput> & { criteria: CriterionResult[]; specialisation?: SpecialisationResult }): TriageInput {
  const specialisation = over.specialisation ?? spec('SPECIALIST');
  const decision = decideCandidate({ criteria: over.criteria, specialisation, competitors: [], preferSpecialist: true, countryStatus: over.countryStatus ?? 'IN_SCOPE' });
  return {
    decision, criteria: over.criteria, specialisation,
    countryStatus: over.countryStatus ?? 'IN_SCOPE', contradiction: over.contradiction ?? [],
    score: over.score ?? { total: 100, confidence: 1 }, generalistRisk: over.generalistRisk ?? 10,
    contact: over.contact ?? { method: 'EMAIL', confidence: 'MEDIUM' }, preferSpecialist: over.preferSpecialist ?? true,
    relevanceHits: over.relevanceHits ?? 5,
  };
}

describe('AUTO_APPROVED : seulement quand un humain n’aurait rien à vérifier', () => {
  test('tout établi, pays prouvé, canal publié, note haute : approuvée seule', () => {
    const t = triageCandidate(entree({ criteria: [critere('a', 'required', 'ESTABLISHED'), critere('b', 'required', 'ESTABLISHED'), critere('c', 'preferred', 'ESTABLISHED')] }));
    assert.equal(t.status, 'AUTO_APPROVED');
    assert.equal(t.recommendation, 'RETAIN');
    assert.deepEqual(t.reasons, []);
  });

  test('un pays non prouvé suffit à exiger un regard — en P1, parce que tout le reste est là', () => {
    const t = triageCandidate(entree({ criteria: [critere('a', 'required', 'ESTABLISHED')], countryStatus: 'NEEDS_VERIFICATION' }));
    assert.equal(t.status, 'HUMAN_REVIEW');
    assert.equal(t.priority, 'P1');
    assert.equal(t.recommendation, 'RETAIN');
    assert.ok(t.reasons.some((r) => /pays/.test(r)));
  });

  test('aucune coordonnée publiée : P1 aussi — la société vaut le regard, il manque la porte', () => {
    const t = triageCandidate(entree({ criteria: [critere('a', 'required', 'ESTABLISHED')], contact: { method: 'NONE', confidence: 'NONE' } }));
    assert.equal(t.status, 'HUMAN_REVIEW');
    assert.equal(t.priority, 'P1');
  });

  test('un canal hors domaine est un point à vérifier, pas une approbation', () => {
    const t = triageCandidate(entree({ criteria: [critere('a', 'required', 'ESTABLISHED')], contact: { method: 'EMAIL', confidence: 'LOW' } }));
    assert.equal(t.status, 'HUMAN_REVIEW');
    assert.ok(t.reasons.some((r) => /canal/.test(r)));
  });

  test('une contradiction de pays bloque l’approbation même avec une preuve forte', () => {
    const t = triageCandidate(entree({ criteria: [critere('a', 'required', 'ESTABLISHED')], contradiction: ['Finlande (PHONE_PREFIX +358 9)'] }));
    assert.equal(t.status, 'HUMAN_REVIEW');
    assert.ok(t.reasons.some((r) => /contredit/.test(r)));
  });

  test('un risque généraliste élevé bloque l’approbation quand le client préfère un spécialiste — et pas sinon', () => {
    const base = { criteria: [critere('a', 'required', 'ESTABLISHED')], generalistRisk: 75 };
    assert.equal(triageCandidate(entree(base)).status, 'HUMAN_REVIEW');
    assert.equal(triageCandidate(entree({ ...base, preferSpecialist: false })).status, 'AUTO_APPROVED');
  });

  test(`une note sous ${AUTO_APPROVAL_MIN_SCORE} n’est jamais approuvée seule`, () => {
    const t = triageCandidate(entree({ criteria: [critere('a', 'required', 'ESTABLISHED'), critere('b', 'preferred', 'TO_CONFIRM')], score: { total: 60, confidence: 0.5 } }));
    assert.equal(t.status, 'HUMAN_REVIEW');
    assert.ok(t.reasons.some((r) => /note 60/.test(r)));
  });

  test('un critère requis « établi » sans passage relu ne peut pas fonder une approbation', () => {
    const t = triageCandidate(entree({ criteria: [critere('a', 'required', 'ESTABLISHED', false)] }));
    assert.equal(t.status, 'HUMAN_REVIEW');
  });
});

describe('AUTO_EXCLUDED : une exclusion qui se relit, jamais une lecture seule', () => {
  test('pays prouvé hors marché, marque concurrente : écartées seules', () => {
    assert.equal(triageCandidate(entree({ criteria: [critere('a', 'required', 'ESTABLISHED')], countryStatus: 'OUT_OF_SCOPE' })).status, 'AUTO_EXCLUDED');
    const d = decideCandidate({ criteria: [critere('a', 'required', 'ESTABLISHED')], specialisation: spec('SPECIALIST'), competitors: [{ competitor: 'Ishida', quote: 'Ishida', sourceUrl: 'https://x.se/' }], preferSpecialist: true, countryStatus: 'IN_SCOPE' });
    assert.equal(triageCandidate({ ...entree({ criteria: [critere('a', 'required', 'ESTABLISHED')] }), decision: d }).status, 'AUTO_EXCLUDED');
  });

  test('un critère requis contredit par un passage relu écarte seul, citation à l’appui', () => {
    const t = triageCandidate(entree({ criteria: [critere('a', 'required', 'NOT_ESTABLISHED'), critere('b', 'required', 'ESTABLISHED')] }));
    assert.equal(t.status, 'AUTO_EXCLUDED');
    assert.match(t.reasons[0]!, /contredit par la page : « Vi säljer/);
  });

  test('un critère requis contredit SANS passage relu part en revue P3 — le modèle ne tranche pas seul', () => {
    const t = triageCandidate(entree({ criteria: [critere('a', 'required', 'NOT_ESTABLISHED', false)] }));
    assert.equal(t.status, 'HUMAN_REVIEW');
    assert.equal(t.priority, 'P3');
    assert.equal(t.recommendation, 'EXCLUDE');
  });

  test('le contredit passe avant le généraliste : Bravida, Trainor, Willab ne sont plus « à revoir »', () => {
    const t = triageCandidate(entree({ criteria: [critere('a', 'required', 'NOT_ESTABLISHED'), critere('b', 'required', 'NOT_ESTABLISHED')], specialisation: spec('GENERALIST'), generalistRisk: 100 }));
    assert.equal(t.status, 'AUTO_EXCLUDED');
  });
});

describe('HUMAN_REVIEW : classée, motivée', () => {
  test('un généraliste établi avec ses critères requis établis : P2, à confirmer', () => {
    const t = triageCandidate(entree({ criteria: [critere('a', 'required', 'ESTABLISHED')], specialisation: spec('GENERALIST'), generalistRisk: 70 }));
    assert.equal(t.status, 'HUMAN_REVIEW');
    assert.equal(t.priority, 'P2');
    assert.equal(t.recommendation, 'TO_CONFIRM');
  });

  test('un généraliste à note basse et risque très haut : P3', () => {
    const t = triageCandidate(entree({ criteria: [critere('a', 'required', 'ESTABLISHED'), critere('b', 'required', 'TO_CONFIRM')], specialisation: spec('GENERALIST'), generalistRisk: 90, score: { total: 30, confidence: 0.5 } }));
    assert.equal(t.priority, 'P3');
  });

  test('rien d’établi : P2 si les pages portent le domaine, P3 sinon', () => {
    const criteria = [critere('a', 'required', 'TO_CONFIRM'), critere('b', 'required', 'TO_CONFIRM')];
    assert.equal(triageCandidate(entree({ criteria, relevanceHits: 3 })).priority, 'P2');
    assert.equal(triageCandidate(entree({ criteria, relevanceHits: 0 })).priority, 'P3');
  });

  test('un critère requis à confirmer : P2, la raison nomme le critère', () => {
    const t = triageCandidate(entree({ criteria: [critere('a', 'required', 'ESTABLISHED'), critere('b', 'required', 'TO_CONFIRM')], score: { total: 50, confidence: 0.5 } }));
    assert.equal(t.priority, 'P2');
    assert.ok(t.reasons.some((r) => /Critère b/.test(r)));
  });

  test('la file se lit P1, puis P2, puis P3 ; à priorité égale la meilleure note d’abord', () => {
    const file = [{ priority: 'P3' as const, score: 90 }, { priority: 'P1' as const, score: 70 }, { priority: 'P1' as const, score: 100 }, { priority: 'P2' as const, score: 10 }].sort(compareReviewOrder);
    assert.deepEqual(file.map((x) => `${x.priority}:${x.score}`), ['P1:100', 'P1:70', 'P2:10', 'P3:90']);
  });
});
