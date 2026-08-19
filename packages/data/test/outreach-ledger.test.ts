import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createLogger } from '../../core/src/logger.ts';
import { GUARD_VERSION } from '../../core/src/index.ts';
import { createRepositories, type Repositories } from '../src/index.ts';

/**
 * Une entreprise n'existe qu'une fois.
 *
 * Les lots sont des passes de prospection : CIRMECA et SERAAP sont ressortis
 * en 003 puis en 004, avec deux identifiants différents et rien pour les
 * relier. Approuver les deux lignes aurait envoyé deux messages à la même
 * maison — la déduplication doit donc vivre au-dessus des lots, sur le
 * domaine canonique.
 */
const logger = createLogger({ level: 'error', pretty: false });
let dir: string;
let repos: Repositories;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-ledger-'));
  repos = createRepositories(join(dir, 'test.db'), logger);
});

after(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Un prospect complet, tel qu'un lot conforme en produit. */
function readyProspect(batchId: string, name: string, domain: string, score = 72, url?: string) {
  const { prospect } = repos.sales.discover({
    batchId,
    companyName: name,
    domain,
    website: `https://${domain}`,
    sourceUrl: url ?? `https://${domain}/`,
    pageType: 'OFFICIAL_COMPANY_SITE',
    identityConfidence: 0.75,
    identitySources: ['titre du résultat', 'nom cohérent avec le domaine'],
    guardVersion: GUARD_VERSION,
  });
  const fact = repos.sales.addEvidence({
    prospectId: prospect.id,
    field: 'produit',
    claim: 'machines sur mesure',
    nature: 'observed',
    sourceUrl: `https://${domain}/`,
    basis: null,
    confidence: 0.9,
  });
  repos.sales.addEvidence({
    prospectId: prospect.id,
    field: 'anciennete',
    claim: '40 ans',
    nature: 'observed',
    sourceUrl: `https://${domain}/`,
    basis: null,
    confidence: 0.9,
  });
  repos.sales.setScore(prospect.id, { score, tier: 'PRIORITY', detail: {}, whyFit: 'fabricant B2B' });
  repos.sales.setContact(prospect.id, {
    email: `contact@${domain}`,
    sourceUrl: `https://${domain}/contact`,
    method: 'EMAIL',
    confidenceLabel: 'HIGH',
    observed: true,
    confidence: 0.9,
  });
  repos.sales.setOutreach(prospect.id, {
    personalizationFactId: fact.id,
    messageShort: 'court',
    messageEmail: 'long',
    sourceUrl: `https://${domain}/`,
  });
  return repos.sales.require(prospect.id);
}

describe('déduplication au-dessus des lots', () => {
  test('une entreprise inconnue reste éligible', () => {
    const p = readyProspect('BATCH-A', 'Nouvelle Usine', 'nouvelle-usine.fr');
    assert.equal(repos.sales.outreachEligibility(p.id).eligibility, 'ELIGIBLE');
  });

  test('SERAAP contacté à la main devient ALREADY_CONTACTED', () => {
    const p = readyProspect('BATCH-003', 'SERAAP', 'seraap.com');
    assert.equal(repos.sales.outreachEligibility(p.id).eligibility, 'ELIGIBLE');

    repos.sales.recordOutreach({
      domain: 'seraap.com',
      kind: 'CONTACTED',
      channel: 'email',
      recordedBy: 'noaroy',
      note: 'contacté manuellement',
    });

    const verdict = repos.sales.outreachEligibility(p.id);
    assert.equal(verdict.eligibility, 'ALREADY_CONTACTED');
    assert.match(verdict.reason, /Déjà contactée/);
  });

  test('CIRMECA aussi, et le même domaine dans un autre lot est couvert', () => {
    repos.sales.recordOutreach({ domain: 'cirmeca.com', kind: 'CONTACTED', recordedBy: 'noaroy' });

    const inBatch003 = readyProspect('BATCH-003', 'CIRMECA', 'cirmeca.com');
    assert.equal(repos.sales.outreachEligibility(inBatch003.id).eligibility, 'ALREADY_CONTACTED');

    // La même entreprise, redécouverte dans un lot suivant : ligne distincte,
    // identifiant distinct, même verdict.
    const inBatch004 = readyProspect('BATCH-004', 'CIRMECA', 'cirmeca.com');
    assert.notEqual(inBatch004.id, inBatch003.id, 'ce sont bien deux lignes');
    assert.equal(repos.sales.outreachEligibility(inBatch004.id).eligibility, 'ALREADY_CONTACTED');
  });

  test('une autre URL du même domaine ne contourne pas la garde', () => {
    // Trouvée par une page différente, avec ou sans `www.` : le domaine
    // canonique est le même, donc l'entreprise aussi.
    const other = readyProspect(
      'BATCH-005',
      'Cirmeca Machines',
      'www.cirmeca.com',
      74,
      'https://www.cirmeca.com/nos-machines/presses',
    );
    assert.equal(repos.sales.outreachEligibility(other.id).eligibility, 'ALREADY_CONTACTED');
  });

  test('un score plus élevé ne contourne pas la garde', () => {
    const p = repos.sales.forBatch('BATCH-003').find((x) => x.domain === 'seraap.com')!;
    repos.sales.setScore(p.id, { score: 98, tier: 'PRIORITY', detail: {}, whyFit: 'excellent' });
    assert.equal(repos.sales.outreachEligibility(p.id).eligibility, 'ALREADY_CONTACTED');
  });
});

describe('exclusion volontaire', () => {
  test('SEMSO écarté ne revient pas', () => {
    const p = readyProspect('BATCH-004', 'SEMSO', 'semso.com');
    repos.sales.recordOutreach({
      domain: 'semso.com',
      kind: 'DO_NOT_CONTACT',
      recordedBy: 'noaroy',
      note: 'abandonné volontairement pour cette campagne',
    });

    const verdict = repos.sales.outreachEligibility(p.id);
    assert.equal(verdict.eligibility, 'DO_NOT_CONTACT');
    assert.match(verdict.reason, /abandonné volontairement/);
  });

  test('même retrouvé dans un lot suivant, il reste écarté', () => {
    const again = readyProspect('BATCH-006', 'SEMSO Industries', 'semso.com', 88);
    assert.equal(repos.sales.outreachEligibility(again.id).eligibility, 'DO_NOT_CONTACT');
  });

  test('aucun état d’envoi n’est atteignable', () => {
    const p = repos.sales.forBatch('BATCH-006')[0]!;
    repos.sales.setState(p.id, 'QUALIFIED');
    assert.throws(
      () => repos.sales.setState(p.id, 'READY_FOR_REVIEW'),
      /Revue refusée/,
      'un prospect écarté ne va même pas en revue',
    );
    assert.equal(repos.sales.require(p.id).state, 'QUALIFIED');
  });

  test('DO_NOT_CONTACT prime sur un envoi antérieur', () => {
    // Une entreprise à qui on a écrit, puis qu'on décide d'écarter, reste
    // écartée : l'ordre chronologique ne doit pas pouvoir inverser cela.
    repos.sales.recordOutreach({ domain: 'ecartee.fr', kind: 'CONTACTED', recordedBy: 'noaroy' });
    repos.sales.recordOutreach({ domain: 'ecartee.fr', kind: 'DO_NOT_CONTACT', recordedBy: 'noaroy' });
    const p = readyProspect('BATCH-007', 'Écartée', 'ecartee.fr');
    assert.equal(repos.sales.outreachEligibility(p.id).eligibility, 'DO_NOT_CONTACT');
  });
});

describe('le registre est append-only', () => {
  test('deux décisions successives se lisent toutes les deux', () => {
    repos.sales.recordOutreach({
      domain: 'histoire.fr', kind: 'CONTACTED', recordedBy: 'noaroy',
      channel: 'email', note: 'premier envoi', recordedAt: '2026-08-01T09:00:00.000Z',
    });
    repos.sales.recordOutreach({
      domain: 'histoire.fr', kind: 'CONTACTED', recordedBy: 'noaroy',
      channel: 'telephone', note: 'relance', recordedAt: '2026-08-15T09:00:00.000Z',
    });

    const history = repos.sales.ledgerHistory('histoire.fr');
    assert.equal(history.length, 2, 'la seconde écriture n’écrase pas la première');
    assert.equal(history[0]!.note, 'premier envoi');
    assert.equal(history[1]!.note, 'relance');
  });

  test('la base refuse toute modification ou suppression', () => {
    // La garantie est portée par SQLite, pas par la discipline des appelants :
    // une trace d'envoi ne s'efface pas, et l'effacer ne reprendrait rien.
    const db = new Database(join(dir, 'test.db'));
    assert.throws(
      () => db.prepare("UPDATE outreach_ledger SET kind = 'DO_NOT_CONTACT' WHERE canonical_domain = 'histoire.fr'").run(),
      /append-only/,
    );
    assert.throws(
      () => db.prepare("DELETE FROM outreach_ledger WHERE canonical_domain = 'histoire.fr'").run(),
      /append-only/,
    );
    db.close();
    assert.equal(repos.sales.ledgerHistory('histoire.fr').length, 2);
  });

  test('une décision anonyme est refusée', () => {
    assert.throws(
      () => repos.sales.recordOutreach({ domain: 'x.fr', kind: 'CONTACTED', recordedBy: '  ' }),
      /qui a décidé/,
    );
  });

  test('les domaines connus couvrent les lots et le registre', () => {
    const known = repos.sales.knownDomains();
    assert.ok(known.has('seraap.com'));
    assert.ok(known.has('cirmeca.com'), 'sans www.');
    assert.ok(known.has('semso.com'));
    assert.ok(known.has('nouvelle-usine.fr'));
  });
});
