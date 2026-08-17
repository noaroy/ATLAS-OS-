import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';

/**
 * La déduplication des preuves, entreprise par entreprise.
 *
 * VAL-003 a rendu des candidats portant la même affirmation plusieurs fois :
 * les agents reformulent rarement, et un candidat revu produit la même phrase à
 * l'identique. Chaque copie comptait pourtant dans la force de la preuve, où la
 * largeur joue — trois exemplaires d'une même source y ressemblaient à trois
 * corroborations.
 *
 * La règle est syntaxique et le reste : elle rapproche deux écritures d'un même
 * texte, jamais deux textes différents. Juger que « distribue des machines
 * d'emballage » et « vend des machines de conditionnement » disent la même
 * chose demanderait de comprendre les phrases, donc un appel au modèle, donc
 * une dépense — pour un verdict qu'on ne pourrait ni rejouer ni auditer.
 */

const logger = createLogger({ level: 'error', pretty: false });
let repos: Repositories;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-dedup-'));
  repos = createRepositories(join(dir, 'd.db'), logger);
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Une entreprise réelle, et une affirmation écrite sur elle. */
function companyWithClaim(claim: string, field = 'sector') {
  const { company } = repos.companies.upsert({
    canonicalKey: 'd:bhs-world.com',
    name: 'BHS Corrugated',
    country: 'Allemagne',
    domain: 'bhs-world.com',
    dataOrigin: 'live',
  });
  repos.companies.appendEvidence({
    companyId: company.id,
    opportunityId: null,
    missionId: null,
    field,
    claim,
    value: null,
    nature: 'reported',
    sourceKey: 'src_test',
    sourceRef: 'https://bhs-world.com',
    sourceTitle: null,
    basis: null,
    confidence: 0.7,
    simulated: false,
    collectedAt: new Date().toISOString(),
    agentKey: 'explorer',
  });
  return company;
}

describe('déduplication exacte des preuves', () => {
  test('la même affirmation, déjà écrite, est retrouvée', () => {
    const claim = 'BHS Corrugated produit des machines de carton ondulé.';
    const company = companyWithClaim(claim);

    const found = repos.companies.findIdenticalEvidence(company.id, 'sector', claim);
    assert.ok(found, 'une affirmation identique doit être retrouvée');
    assert.equal(found.claim, claim);
  });

  test('la casse et les espaces ne créent pas un doublon', () => {
    const company = companyWithClaim('BHS Corrugated produit des machines de carton ondulé.');

    const found = repos.companies.findIdenticalEvidence(
      company.id,
      'SECTOR',
      '  bhs corrugated produit des machines de carton ondulé.  ',
    );
    assert.ok(found, 'une différence de casse ou d’espacement ne fait pas deux preuves');
  });

  test('une formulation différente reste une preuve distincte', () => {
    const company = companyWithClaim('BHS Corrugated produit des machines de carton ondulé.');

    const found = repos.companies.findIdenticalEvidence(
      company.id,
      'sector',
      'BHS Corrugated fabrique des lignes de production pour le carton.',
    );
    assert.equal(found, null, 'la déduplication ne doit pas juger du sens');
  });

  test('un autre champ reste une preuve distincte', () => {
    const claim = 'BHS Corrugated produit des machines de carton ondulé.';
    const company = companyWithClaim(claim, 'sector');

    // La même phrase versée à l'appui d'un autre fait n'est pas une copie :
    // elle dit quelque chose d'autre.
    assert.equal(repos.companies.findIdenticalEvidence(company.id, 'existence', claim), null);
  });

  test('la même affirmation sur une autre entreprise n’est pas un doublon', () => {
    const claim = 'Distribue des machines d’emballage en Bavière.';
    companyWithClaim(claim);

    const { company: other } = repos.companies.upsert({
      canonicalKey: 'd:autre-firma.de',
      name: 'Autre Firma GmbH',
      country: 'Allemagne',
      domain: 'autre-firma.de',
      dataOrigin: 'live',
    });

    // La déduplication est bornée à l'entreprise, et doit l'être : deux
    // sociétés peuvent très bien exercer le même métier, et le constater deux
    // fois n'est pas se répéter.
    assert.equal(repos.companies.findIdenticalEvidence(other.id, 'sector', claim), null);
  });
});
