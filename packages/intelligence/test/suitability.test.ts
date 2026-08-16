import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assessSuitability, capabilitiesOf } from '../src/search/capabilities.ts';
import { DuckDuckGoSearchProvider } from '../src/search/duckduckgo.ts';
import { MarginaliaSearchProvider } from '../src/search/marginalia.ts';

/**
 * Santé et adéquation, séparées.
 *
 * Deux missions réelles ont échoué avec un moteur parfaitement sain. La
 * première parce que DuckDuckGo bridait cette adresse ; la seconde parce que
 * Marginalia répondait en 300 ms et ne contenait rien du marché allemand. Dans
 * les deux cas le contrôle de santé disait « vert », et la mission a dépensé
 * pour découvrir que le moteur ne pouvait pas répondre à *cette* question.
 *
 * « Aucun distributeur allemand » et « ce moteur ne couvre pas l'allemand » sont
 * deux constats opposés. Rien ne les distinguait ; ces tests garantissent que
 * quelque chose les distingue désormais.
 */

const GERMAN_B2B = { countries: ['DE'], languages: ['de'], commercial: true };
const ENGLISH_DOCS = { countries: ['GB'], languages: ['en'], commercial: false };

describe('adéquation d’un moteur à une mission', () => {
  test('DuckDuckGo convient à la découverte B2B allemande', () => {
    const report = assessSuitability(new DuckDuckGoSearchProvider(), GERMAN_B2B);
    assert.equal(report.verdict, 'suitable', report.detail);
    assert.deepEqual(report.gaps, []);
  });

  test('Marginalia est sain mais inadapté au B2B allemand', () => {
    // Le cas exact qui a coûté 0,0427 $ pour zéro candidat.
    const report = assessSuitability(new MarginaliaSearchProvider(), GERMAN_B2B);
    assert.equal(report.verdict, 'unsuitable');
    assert.ok(report.gaps.length >= 2, `motifs : ${report.gaps.join(' · ')}`);
    assert.ok(report.detail.includes('anglophone') || report.detail.includes('restreint'));
  });

  test('Marginalia convient à une recherche documentaire anglophone', () => {
    // Un moteur inadapté à une mission ne l'est pas à toutes : le verdict porte
    // sur le couple, jamais sur le moteur seul.
    const report = assessSuitability(new MarginaliaSearchProvider(), ENGLISH_DOCS);
    assert.equal(report.verdict, 'suitable', report.detail);
  });

  test('la découverte commerciale est structurante', () => {
    // Un index qui ne contient pas d'entreprises ne peut pas en trouver, quelle
    // que soit la langue : ce manque-là ne se rattrape pas.
    const report = assessSuitability(new MarginaliaSearchProvider(), {
      countries: ['US'],
      languages: ['en'],
      commercial: true,
    });
    assert.equal(report.verdict, 'unsuitable');
  });

  test('un moteur inconnu n’est pas présumé capable', () => {
    // Le sens de l'erreur compte : refuser à tort coûte une question ; accepter
    // à tort coûte une mission entière.
    const caps = capabilitiesOf('moteur-jamais-vu');
    assert.equal(caps.generalWeb, false);
    assert.equal(caps.commercialDiscovery, false);
    assert.deepEqual(caps.geographicCoverage, []);
    assert.ok(caps.caveat);
  });

  test('chaque moteur déclaré expose ses limites', () => {
    // Une limite non écrite est une limite qu'on découvre en production.
    for (const key of ['duckduckgo', 'marginalia', 'searxng', 'brave']) {
      const caps = capabilitiesOf(key);
      assert.ok(caps.caveat, `${key} ne déclare aucune limite`);
      assert.ok(caps.caveat.length > 20, `${key} : limite trop vague`);
    }
  });

  test('un verdict d’adéquation explique toujours ce qui manque', () => {
    const report = assessSuitability(new MarginaliaSearchProvider(), GERMAN_B2B);
    for (const gap of report.gaps) assert.ok(gap.length > 10, `motif trop court : « ${gap} »`);
    assert.ok(report.detail.length > 40);
  });
});
