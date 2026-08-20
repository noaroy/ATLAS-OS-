import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreConversion,
  isConversionReady,
  CONVERSION_MODEL,
  type ObservedFact,
} from '../src/sales-conversion.ts';
import { findGrowthSignals } from '../src/growth-signals.ts';

/**
 * Le score de qualification dit si l'entreprise ressemble à notre client type.
 * Celui-ci dit si elle a des chances d'acheter. Un équipementier parfait sans
 * besoin visible, sans canal propre et dont on ne saurait pas démontrer trois
 * prospects est un mauvais premier client, même bien noté.
 */
const fact = (claim: string, nature: ObservedFact['nature'] = 'observed'): ObservedFact => ({
  claim,
  sourceUrl: nature === 'observed' ? 'https://usine.fr/' : null,
  nature,
});

const base = {
  companyName: 'Usine',
  contactIntent: 'GENERAL',
  contactSuitability: 'MEDIUM',
  qualificationScore: 72,
  qualificationTier: 'PRIORITY',
};

describe('le score porte sur l’achat, pas sur l’adéquation', () => {
  test('les poids font cent points', () => {
    assert.equal(CONVERSION_MODEL.reduce((s, d) => s + d.weight, 0), 100);
  });

  test('sans aucun fait, le score est nul et les manques sont nommés', () => {
    const score = scoreConversion({ ...base, facts: [], contactIntent: null, contactSuitability: null });
    assert.equal(score.total, 0);
    assert.equal(score.groundedDimensions, 0);
    assert.equal(score.personalization, null);
    assert.ok(score.gaps.length >= 6);
    assert.equal(isConversionReady(score).ready, false);
  });

  test('un besoin constaté rapporte, un besoin supposé non', () => {
    const observed = scoreConversion({
      ...base,
      facts: [fact('Nous recherchons des distributeurs pour couvrir l’Europe')],
    });
    const inferred = scoreConversion({
      ...base,
      facts: [fact('Nous recherchons des distributeurs pour couvrir l’Europe', 'inferred')],
    });
    assert.ok(observed.total > 0);
    // Le canal de contact ne dépend pas des faits : il garde ses points. Ce
    // qui doit tomber à zéro, ce sont les dimensions que les faits financent.
    const factFinanced = (s: typeof observed) =>
      s.components.filter((c) => c.key !== 'contactQuality').reduce((t, c) => t + c.points, 0);
    assert.ok(factFinanced(observed) > 0);
    assert.equal(factFinanced(inferred), 0, 'une déduction ne finance aucun point');
    assert.equal(inferred.groundedDimensions, 0);
  });

  test('un fait rapporté vaut moitié d’un fait constaté', () => {
    const observed = scoreConversion({ ...base, facts: [fact('export vers toute l’Europe')] });
    const reported = scoreConversion({
      ...base,
      facts: [fact('export vers toute l’Europe', 'reported')],
    });
    assert.ok(reported.total < observed.total);
    assert.ok(reported.total > 0);
  });

  test('un canal bloqué annule sa dimension', () => {
    const score = scoreConversion({
      ...base,
      contactIntent: 'TECHNICAL_SUPPORT',
      contactSuitability: 'BLOCKED',
      facts: [fact('machines spéciales sur mesure pour l’agroalimentaire')],
    });
    const channel = score.components.find((c) => c.key === 'contactQuality')!;
    assert.equal(channel.points, 0);
    assert.ok(score.gaps.includes('aucun canal commercial utilisable'));
  });

  test('une adresse commerciale vaut mieux qu’une adresse générale', () => {
    const facts = [fact('machines spéciales pour l’agroalimentaire')];
    const sales = scoreConversion({ ...base, contactIntent: 'SALES', contactSuitability: 'HIGH', facts });
    const general = scoreConversion({ ...base, contactIntent: 'GENERAL', contactSuitability: 'MEDIUM', facts });
    assert.ok(sales.total > general.total);
  });

  test('chaque point nomme le fait qui l’a financé', () => {
    const score = scoreConversion({
      ...base,
      facts: [fact('Nous recherchons des distributeurs en Europe pour nos machines spéciales')],
    });
    for (const component of score.components.filter((c) => c.points > 0 && c.key !== 'contactQuality')) {
      assert.ok(component.basis, `${component.key} sans justification`);
      assert.ok(component.sourceUrl, `${component.key} sans source`);
    }
  });
});

describe('prêt à démarcher', () => {
  const rich = [
    fact('Nous recherchons des distributeurs pour développer l’export en Europe'),
    fact('Machines spéciales sur mesure pour l’agroalimentaire et la cosmétique'),
    fact('PME familiale de 40 salariés, nos clients sont des industriels'),
  ];

  test('trois faits constatés, un canal propre : prêt', () => {
    const score = scoreConversion({ ...base, contactIntent: 'SALES', contactSuitability: 'HIGH', facts: rich });
    const verdict = isConversionReady(score);
    assert.equal(verdict.ready, true, verdict.blockers.join(' · '));
    assert.ok(score.groundedDimensions >= 3);
    assert.ok(score.personalization);
  });

  test('un score élevé sur des déductions ne passe pas', () => {
    // Le total peut monter ; la matière reste absente. C'est la même erreur
    // que le lot 002, transposée du « qui » au « pourquoi ».
    const score = scoreConversion({
      ...base,
      facts: rich.map((f) => ({ ...f, nature: 'inferred' as const, sourceUrl: null })),
    });
    assert.equal(isConversionReady(score).ready, false);
    assert.ok(isConversionReady(score).blockers.some((b) => b.includes('constaté')));
  });

  test('la personnalisation vient d’un fait sourcé, ou n’existe pas', () => {
    const withSource = scoreConversion({ ...base, facts: rich });
    assert.ok(withSource.personalization?.sourceUrl?.startsWith('https://'));

    const without = scoreConversion({
      ...base,
      facts: [fact('quelque chose', 'reported')],
    });
    assert.equal(without.personalization, null);
    assert.ok(isConversionReady(without).blockers.includes('aucune personnalisation sourcée'));
  });
});

describe('les signaux relevés sur un site', () => {
  const page = (html: string, url = 'https://usine.fr/') => ({ url, html });

  test('une politique de cookies n’est pas un signal export', () => {
    // Relevé pour de vrai : « enregistrer des informations relatives à
    // l'exportation de vos données » capté comme un signal commercial.
    const signals = findGrowthSignals([
      page('<p>Ce cookie nous permet d’enregistrer des informations relatives à l’export de vos données personnelles.</p>'),
    ]);
    assert.deepEqual(signals, []);
  });

  test('un annuaire ne fournit aucun signal', () => {
    const signals = findGrowthSignals([
      page('<p>Pourquoi Usine de France : l’annuaire industriel de référence. De l’aéronautique à l’agroalimentaire, trouvez l’usine qu’il vous faut.</p>'),
    ]);
    assert.deepEqual(signals, []);
  });

  test('un vrai appel à distributeurs est relevé, avec sa phrase et sa source', () => {
    const signals = findGrowthSignals([
      page('<p>Vous souhaitez devenir distributeur de nos machines en Europe ? Rejoignez notre réseau commercial.</p>'),
    ]);
    assert.equal(signals.length, 1);
    assert.equal(signals[0]!.kind, 'DISTRIBUTION');
    assert.match(signals[0]!.quote, /devenir distributeur/i);
    assert.equal(signals[0]!.sourceUrl, 'https://usine.fr/');
  });

  test('la phrase est rendue telle quelle, jamais reformulée', () => {
    const phrase = 'Nous exportons nos équipements vers douze pays européens depuis 1998.';
    const signals = findGrowthSignals([page(`<div><p>${phrase}</p></div>`)]);
    assert.equal(signals.length, 1);
    assert.ok(phrase.includes(signals[0]!.quote.replace(/\.$/, '').trim().slice(0, 40)));
  });
});
