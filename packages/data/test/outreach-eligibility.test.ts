import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../core/src/logger.ts';
import { GUARD_VERSION } from '../../core/src/index.ts';
import { createRepositories, type Repositories } from '../src/index.ts';

/**
 * Le verrou d'avant le premier message.
 *
 * Le lot 002 a laissé en base deux prospects PRIORITY qui n'auraient jamais dû
 * l'être : l'éditeur d'une étude de marché, et une agence de communication.
 * Leurs lignes restent — elles sont la trace du défaut. Ce qui doit être
 * impossible, c'est qu'elles servent à envoyer quoi que ce soit.
 */
const logger = createLogger({ level: 'error', pretty: false });
let dir: string;
let repos: Repositories;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-eligibility-'));
  repos = createRepositories(join(dir, 'test.db'), logger);
});

after(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Une ligne telle que le lot 002 les écrivait : sans identité résolue. */
function legacyProspect(companyName: string, domain: string) {
  const { prospect } = repos.sales.discover({
    batchId: 'BATCH-002-LEGACY',
    companyName,
    domain,
    sourceUrl: `https://${domain}/`,
    // ni pageType, ni identityConfidence, ni guardVersion : c'est le point.
  });
  repos.sales.setScore(prospect.id, {
    score: 73.1,
    tier: 'PRIORITY',
    detail: {},
    whyFit: 'jugé prioritaire par le lot',
  });
  repos.sales.setState(prospect.id, 'QUALIFIED');
  return repos.sales.require(prospect.id);
}

describe('les deux faux positifs du lot 002', () => {
  test('restent PRIORITY dans l’historique — rien n’est réécrit', () => {
    const mordor = legacyProspect(
      'Entreprises du secteur Automatisation Industrielle…',
      'mordorintelligence.com',
    );
    assert.equal(mordor.tier, 'PRIORITY');
    assert.equal(mordor.state, 'QUALIFIED');
  });

  test('sont refusés à l’outreach malgré ce tier', () => {
    const p = repos.sales.forBatch('BATCH-002-LEGACY')[0]!;
    const verdict = repos.sales.outreachEligibility(p.id);
    assert.notEqual(verdict.eligibility, 'ELIGIBLE');
    assert.equal(verdict.historicalTier, 'PRIORITY', 'le verdict rappelle ce que le lot avait décidé');
    assert.ok(verdict.blockers.length > 0, 'un refus doit dire pourquoi');
  });

  test('n’atteignent même pas la revue fondateur', () => {
    const p = repos.sales.forBatch('BATCH-002-LEGACY')[0]!;
    assert.throws(() => repos.sales.setState(p.id, 'READY_FOR_REVIEW'), /Revue refusée/);
    assert.equal(repos.sales.require(p.id).state, 'QUALIFIED', 'l’état n’a pas bougé');
  });

  test('ne peuvent jamais atteindre APPROVED_TO_CONTACT', () => {
    const p = repos.sales.forBatch('BATCH-002-LEGACY')[0]!;
    // Depuis QUALIFIED la transition est déjà interdite ; le point du test est
    // qu'aucun détour n'existe, pas même avec un relecteur nommé.
    assert.throws(
      () => repos.sales.setState(p.id, 'APPROVED_TO_CONTACT', { reviewer: 'noaroy' }),
      /Transition refusée|Contact refusé/,
      'un relecteur nommé ne suffit pas à débloquer une identité non vérifiée',
    );
    assert.equal(repos.sales.require(p.id).state, 'QUALIFIED', 'l’état n’a pas bougé');
  });

  test('aucun chemin ne mène à CONTACTED non plus', () => {
    // Sauter l'approbation ne contourne rien : les deux transitions passent
    // par la même garde, parce qu'elles font toutes deux partir un message.
    const p = repos.sales.forBatch('BATCH-002-LEGACY')[0]!;
    assert.throws(
      () => repos.sales.setState(p.id, 'CONTACTED'),
      /Transition refusée|Contact refusé/,
    );
  });

  test('une invalidation explicite prime sur tout le reste', () => {
    // Même une ligne parfaitement formée redevient BLOCKED si un ré-audit l'a
    // condamnée : c'est un jugement porté, pas une absence de preuve.
    const { prospect } = repos.sales.discover({
      batchId: 'BATCH-INVALIDATED',
      companyName: 'Industriailes',
      domain: 'industri-ailes.fr',
      sourceUrl: 'https://industri-ailes.fr/',
      pageType: 'OFFICIAL_COMPANY_SITE',
      identityConfidence: 0.9,
      identitySources: ['og:site_name'],
      guardVersion: GUARD_VERSION,
    });
    const fact = repos.sales.addEvidence({
      prospectId: prospect.id,
      field: 'activite',
      claim: 'agence de communication',
      nature: 'observed',
      sourceUrl: 'https://industri-ailes.fr/',
      basis: null,
      confidence: 0.9,
    });
    repos.sales.addEvidence({
      prospectId: prospect.id,
      field: 'marche',
      claim: 'clients industriels',
      nature: 'observed',
      sourceUrl: 'https://industri-ailes.fr/',
      basis: null,
      confidence: 0.9,
    });
    repos.sales.setScore(prospect.id, { score: 71.6, tier: 'PRIORITY', detail: {}, whyFit: 'x' });
    repos.sales.setOutreach(prospect.id, {
      personalizationFactId: fact.id,
      messageShort: 'court',
      messageEmail: 'long',
      sourceUrl: 'https://industri-ailes.fr/',
    });
    repos.sales.setState(prospect.id, 'QUALIFIED');
    repos.sales.setState(prospect.id, 'READY_FOR_REVIEW');

    // Sans invalidation, cette ligne passerait : c'est précisément ce qui rend
    // le test utile.
    assert.equal(repos.sales.outreachEligibility(prospect.id).eligibility, 'ELIGIBLE');

    repos.sales.invalidate(
      prospect.id,
      'agence de communication : hors du profil fabricant de ce lot.',
    );

    const verdict = repos.sales.outreachEligibility(prospect.id);
    assert.equal(verdict.eligibility, 'BLOCKED');
    assert.match(verdict.reason, /agence de communication/);
    assert.throws(
      () => repos.sales.setState(prospect.id, 'APPROVED_TO_CONTACT', { reviewer: 'noaroy' }),
      /Contact refusé/,
    );
  });
});

describe('un prospect résolu sous les gardes actuelles', () => {
  test('devient éligible quand tout est réuni, et pas avant', () => {
    const { prospect } = repos.sales.discover({
      batchId: 'BATCH-003-LIKE',
      companyName: 'CIRMECA',
      domain: 'cirmeca.com',
      sourceUrl: 'https://cirmeca.com/',
      pageType: 'OFFICIAL_COMPANY_SITE',
      identityConfidence: 0.75,
      identitySources: ['titre du résultat', 'nom cohérent avec le domaine'],
      guardVersion: GUARD_VERSION,
    });

    // Un seul fait observé : pas assez.
    const first = repos.sales.addEvidence({
      prospectId: prospect.id,
      field: 'produit',
      claim: 'machines sur mesure',
      nature: 'observed',
      sourceUrl: 'https://cirmeca.com/',
      basis: null,
      confidence: 0.9,
    });
    repos.sales.setScore(prospect.id, { score: 70.18, tier: 'PRIORITY', detail: {}, whyFit: 'x' });
    assert.equal(repos.sales.outreachEligibility(prospect.id).eligibility, 'BLOCKED');

    repos.sales.addEvidence({
      prospectId: prospect.id,
      field: 'anciennete',
      claim: '40 ans d’activité',
      nature: 'observed',
      sourceUrl: 'https://cirmeca.com/',
      basis: null,
      confidence: 0.9,
    });
    // Deux faits, mais aucune personnalisation sourcée : toujours non.
    assert.equal(repos.sales.outreachEligibility(prospect.id).eligibility, 'BLOCKED');

    repos.sales.setOutreach(prospect.id, {
      personalizationFactId: first.id,
      messageShort: 'court',
      messageEmail: 'long',
      sourceUrl: 'https://cirmeca.com/',
    });
    assert.equal(repos.sales.outreachEligibility(prospect.id).eligibility, 'ELIGIBLE');
  });

  test('APPROVED_TO_CONTACT reste réservé à un humain nommé', () => {
    const p = repos.sales.forBatch('BATCH-003-LIKE')[0]!;
    repos.sales.setState(p.id, 'QUALIFIED');
    repos.sales.setState(p.id, 'READY_FOR_REVIEW');
    assert.throws(
      () => repos.sales.setState(p.id, 'APPROVED_TO_CONTACT'),
      /relecteur nommé/,
      'éligible ne veut pas dire approuvé',
    );
  });
});
