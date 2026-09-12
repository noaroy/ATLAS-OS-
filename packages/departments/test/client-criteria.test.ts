import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseClientBrief, adjustBrief, normaliseDomain, allCriteria } from '../src/client-brief.ts';
import {
  resolveQualification, scanCompetitors, decideCandidate, scoreCriteria, criteriaSchema,
} from '../src/client-criteria.ts';
import { buildBlockCatalogue } from '../src/verbatim-selection.ts';

/**
 * Le brief d'un client et la grille qu'il devient.
 *
 * ACRN n'est pas codé ici : ce sont des critères quelconques, et la règle
 * qui compte est la même pour tous — un verdict positif exige un passage
 * relu, une absence de passage est « à confirmer », et rien ne sauve un
 * dossier qui n'a pas de preuve.
 */
const BRIEF = {
  client: { name: 'Client', offering: 'machines de conditionnement', internalTest: true },
  market: { country: 'Suède', countryLabel: 'Suède' },
  targetRoles: ['distributor'],
  productKeywords: ['förpackningsmaskiner'],
  requiredCriteria: [
    { key: 'machines', label: 'Vend des machines', weight: 3 },
    { key: 'secteurs', label: 'Sert la pharma', weight: 2 },
  ],
  preferredCriteria: [{ key: 'service', label: 'Assure le service', weight: 1 }],
  exclusionCriteria: [{ key: 'fabricant', label: 'Fabrique des machines concurrentes', weight: 1 }],
  competitorExclusions: ['Ishida', 'Mettler Toledo'],
};

const brief = () => {
  const v = parseClientBrief(BRIEF);
  assert.ok(v.ok, v.errors.join(' ; '));
  return v.brief!;
};

const catalogue = (html: string) => buildBlockCatalogue([{ url: 'https://exempel.se/', html }]);

describe('le brief', () => {
  test('un brief valide est accepté avec ses valeurs par défaut', () => {
    const b = brief();
    assert.equal(b.version, 1);
    assert.equal(b.preferSpecialist, true);
    assert.deepEqual(b.excludedDomains, []);
    assert.equal(allCriteria(b).length, 4);
  });

  test('les erreurs sont nommées champ par champ', () => {
    const v = parseClientBrief({ ...BRIEF, requiredCriteria: [], market: { country: 'Suède' } });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /requiredCriteria/.test(e)));
    assert.ok(v.errors.some((e) => /countryLabel/.test(e)));
  });

  test('deux critères de même clé sont refusés', () => {
    const v = parseClientBrief({ ...BRIEF, preferredCriteria: [{ key: 'machines', label: 'Doublon de clé' }] });
    assert.equal(v.ok, false);
    assert.match(v.errors.join(' '), /double/);
  });

  test('un domaine se normalise sans www, sans schéma, sans chemin', () => {
    assert.equal(normaliseDomain('https://www.Nordpack.se/kontakt?x=1'), 'nordpack.se');
  });

  test('un ajustement monte la version et n’efface rien', () => {
    const v2 = adjustBrief(brief(), { excludeDomains: ['www.a.se'], keepDomains: ['b.se'], addCompetitors: ['Bizerba'], removeCriteriaKeys: ['service'] });
    assert.equal(v2.version, 2);
    assert.deepEqual(v2.excludedDomains, ['a.se']);
    assert.deepEqual(v2.keepDomains, ['b.se']);
    assert.ok(v2.competitorExclusions.includes('Ishida') && v2.competitorExclusions.includes('Bizerba'));
    assert.equal(v2.preferredCriteria.length, 0);
    assert.equal(v2.requiredCriteria.length, 2, 'les requis restent');
  });

  test('un domaine exclu puis conservé : l’exclusion l’emporte', () => {
    const v2 = adjustBrief(brief(), { excludeDomains: ['a.se'], keepDomains: ['a.se'] });
    assert.deepEqual(v2.keepDomains, []);
  });

  test('le schéma du modèle n’accepte que les clés du brief', () => {
    const schema = criteriaSchema(brief()) as { properties: { criteria: { items: { properties: { key: { enum: string[] } } } } } };
    assert.deepEqual(schema.properties.criteria.items.properties.key.enum, ['machines', 'secteurs', 'service', 'fabricant']);
  });
});

describe('la relecture des verdicts', () => {
  const html = '<p>Vi säljer förpackningsmaskiner till läkemedelsindustrin.</p><p>Vi installerar och servar maskinerna.</p>';

  test('ESTABLISHED avec un passage relu reste établi, et porte la citation', () => {
    const q = resolveQualification({
      criteria: [{ key: 'machines', verdict: 'ESTABLISHED', evidenceBlockIds: [1], note: 'vend des machines' }],
      specialisation: { verdict: 'SPECIALIST', evidenceBlockIds: [1], note: 'spécialiste' },
    }, brief(), catalogue(html));
    const m = q.criteria.find((c) => c.key === 'machines')!;
    assert.equal(m.verdict, 'ESTABLISHED');
    assert.match(m.evidence[0]!.evidenceQuote, /förpackningsmaskiner/);
    assert.equal(m.downgraded, null);
  });

  test('ESTABLISHED sans passage relu redescend en TO_CONFIRM, et le dit', () => {
    const q = resolveQualification({
      criteria: [{ key: 'machines', verdict: 'ESTABLISHED', evidenceBlockIds: [99], note: 'vend des machines' }],
    }, brief(), catalogue(html));
    const m = q.criteria.find((c) => c.key === 'machines')!;
    assert.equal(m.verdict, 'TO_CONFIRM');
    assert.match(m.downgraded ?? '', /sans passage relu/);
  });

  test('un critère oublié par le modèle est TO_CONFIRM, jamais absent', () => {
    const q = resolveQualification({ criteria: [] }, brief(), catalogue(html));
    assert.equal(q.criteria.length, 4);
    assert.ok(q.criteria.every((c) => c.verdict === 'TO_CONFIRM'));
  });

  test('un critère d’exclusion établi devient EXCLUDED, avec sa preuve', () => {
    const q = resolveQualification({
      criteria: [{ key: 'fabricant', verdict: 'ESTABLISHED', evidenceBlockIds: [1], note: 'fabrique' }],
    }, brief(), catalogue('<p>Vi tillverkar egna förpackningsmaskiner i vår fabrik.</p>'));
    assert.equal(q.criteria.find((c) => c.key === 'fabricant')!.verdict, 'EXCLUDED');
  });

  test('GENERALIST sans passage relu devient TO_CONFIRM', () => {
    const q = resolveQualification({ criteria: [], specialisation: { verdict: 'GENERALIST', evidenceBlockIds: [], note: 'large' } }, brief(), catalogue(html));
    assert.equal(q.specialisation.verdict, 'TO_CONFIRM');
  });

  test('une sortie illisible ne casse rien : tout est à confirmer', () => {
    for (const brut of [null, undefined, 'texte', 42, { criteria: 'x' }]) {
      const q = resolveQualification(brut, brief(), catalogue(html));
      assert.equal(q.criteria.length, 4, String(brut));
    }
  });
});

describe('les concurrents', () => {
  test('une marque citée mot entier est relevée, avec la phrase et la page', () => {
    const hits = scanCompetitors(catalogue('<p>Vi är återförsäljare för Ishida i hela Norden.</p>'), ['Ishida', 'Mettler Toledo']);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.competitor, 'Ishida');
    assert.match(hits[0]!.quote, /Ishida/);
    assert.equal(hits[0]!.sourceUrl, 'https://exempel.se/');
  });

  test('un nom enfoui dans un autre mot ne compte pas', () => {
    const hits = scanCompetitors(catalogue('<p>Produkten Ishidaflex tillverkas i Japan av oss.</p>'), ['Ishida']);
    assert.equal(hits.length, 0);
  });

  test('une marque de deux mots se cherche entière', () => {
    assert.equal(scanCompetitors(catalogue('<p>Vågar från Mettler Toledo finns i vårt sortiment.</p>'), ['Mettler Toledo']).length, 1);
    assert.equal(scanCompetitors(catalogue('<p>Mettler är ett vanligt efternamn.</p>'), ['Mettler Toledo']).length, 0);
  });

  test('un nom trop court est ignoré : il attraperait tout', () => {
    assert.equal(scanCompetitors(catalogue('<p>AB och CO.</p>'), ['AB']).length, 0);
  });
});

describe('la décision', () => {
  const critere = (key: string, kind: 'required' | 'preferred' | 'exclusion', verdict: 'ESTABLISHED' | 'NOT_ESTABLISHED' | 'TO_CONFIRM' | 'EXCLUDED') =>
    ({ key, label: key, kind, weight: 1, verdict, note: 'n', evidence: [], downgraded: null });
  const spec = (verdict: 'SPECIALIST' | 'GENERALIST' | 'TO_CONFIRM') => ({ verdict, note: 'n', evidence: [] });
  const base = { competitors: [], preferSpecialist: true, countryStatus: 'IN_SCOPE' as const };

  test('un pays prouvé hors marché écarte avant tout', () => {
    const d = decideCandidate({ ...base, criteria: [critere('a', 'required', 'ESTABLISHED')], specialisation: spec('SPECIALIST'), countryStatus: 'OUT_OF_SCOPE' });
    assert.equal(d.category, 'WRONG_COUNTRY');
  });

  test('une marque concurrente écarte, même si tout le reste est établi', () => {
    const d = decideCandidate({ ...base, criteria: [critere('a', 'required', 'ESTABLISHED')], specialisation: spec('SPECIALIST'), competitors: [{ competitor: 'Ishida', quote: 'q', sourceUrl: 'u' }] });
    assert.equal(d.category, 'COMPETITOR');
  });

  test('un généraliste établi est mis en revue, marqué TOO_GENERAL — jamais écarté sur une seule lecture', () => {
    const criteria = [critere('a', 'required', 'ESTABLISHED')];
    const d = decideCandidate({ ...base, criteria, specialisation: spec('GENERALIST') });
    assert.equal(d.outcome, 'REVIEW_REQUIRED');
    assert.equal(d.category, 'TOO_GENERAL');
    assert.ok(d.toConfirm.some((x) => /spécialisation/.test(x)));
    assert.equal(decideCandidate({ ...base, criteria, specialisation: spec('GENERALIST'), preferSpecialist: false }).outcome, 'RETAINED');
  });

  test('un requis contredit par les pages écarte pour faible pertinence', () => {
    const d = decideCandidate({ ...base, criteria: [critere('a', 'required', 'ESTABLISHED'), critere('b', 'required', 'NOT_ESTABLISHED')], specialisation: spec('SPECIALIST') });
    assert.equal(d.category, 'LOW_RELEVANCE');
  });

  test('rien d’établi n’est pas un dossier : revue requise, preuves insuffisantes', () => {
    const d = decideCandidate({ ...base, criteria: [critere('a', 'required', 'TO_CONFIRM')], specialisation: spec('TO_CONFIRM') });
    assert.equal(d.outcome, 'REVIEW_REQUIRED');
    assert.equal(d.category, 'INSUFFICIENT_EVIDENCE');
  });

  test('un requis à confirmer laisse le dossier en revue, avec les points nommés', () => {
    const d = decideCandidate({ ...base, criteria: [critere('a', 'required', 'ESTABLISHED'), critere('b', 'required', 'TO_CONFIRM')], specialisation: spec('SPECIALIST') });
    assert.equal(d.outcome, 'REVIEW_REQUIRED');
    assert.deepEqual(d.toConfirm, ['b']);
  });

  test('un pays non prouvé laisse aussi le dossier en revue', () => {
    const d = decideCandidate({ ...base, criteria: [critere('a', 'required', 'ESTABLISHED')], specialisation: spec('SPECIALIST'), countryStatus: 'NEEDS_VERIFICATION' });
    assert.equal(d.outcome, 'REVIEW_REQUIRED');
    assert.ok(d.toConfirm.includes('pays'));
  });

  test('tout établi, pays prouvé, spécialiste : retenu', () => {
    const d = decideCandidate({ ...base, criteria: [critere('a', 'required', 'ESTABLISHED'), critere('p', 'preferred', 'TO_CONFIRM')], specialisation: spec('SPECIALIST') });
    assert.equal(d.outcome, 'RETAINED');
    assert.deepEqual(d.toConfirm, ['p'], 'un souhaité à confirmer ne bloque pas, mais reste nommé');
  });
});

describe('la note', () => {
  const critere = (key: string, kind: 'required' | 'preferred', verdict: 'ESTABLISHED' | 'TO_CONFIRM' | 'NOT_ESTABLISHED', weight = 1) =>
    ({ key, label: key, kind, weight, verdict, note: 'n', evidence: [], downgraded: null });

  test('70 points aux requis, 30 aux souhaités, au prorata des poids', () => {
    const s = scoreCriteria([critere('a', 'required', 'ESTABLISHED', 3), critere('b', 'required', 'TO_CONFIRM', 1), critere('p', 'preferred', 'ESTABLISHED')]);
    assert.equal(s.total, Math.round(0.75 * 70 + 1 * 30));
  });

  test('à confirmer vaut zéro, pas la moitié — et la confiance le dit à part', () => {
    const s = scoreCriteria([critere('a', 'required', 'TO_CONFIRM'), critere('b', 'required', 'ESTABLISHED')]);
    assert.equal(s.total, 50);
    assert.equal(s.confidence, 0.5);
  });

  test('sans critère souhaité, les requis font 100', () => {
    assert.equal(scoreCriteria([critere('a', 'required', 'ESTABLISHED')]).total, 100);
  });
});
