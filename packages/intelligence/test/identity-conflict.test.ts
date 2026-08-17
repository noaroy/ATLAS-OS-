import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';
import { assessIdentity, canMerge } from '../src/identity.ts';

/**
 * Deux entreprises réelles ne doivent jamais n'en faire qu'une.
 *
 * REVENUE-001 a produit une fiche nommée « Heidelberg Druckmaschinen AG »
 * portant le domaine `bhs-corrugated.com` et la ville de BHS Corrugated. Deux
 * fabricants allemands réels, distincts, tous deux de lignée `live`.
 *
 * La barrière de lignée ne pouvait rien voir, et n'avait rien à voir : la
 * provenance des deux fiches était irréprochable. Ce qui a cédé est ailleurs —
 * `enrich()` remplaçait tous les champs, domaine et ville compris, et la clé
 * canonique est figée à la création. Un enrichissement a donc réécrit
 * l'identité d'une fiche existante sans que rien ne recalcule sa clé.
 */

const HEIDELBERG = {
  name: 'Heidelberg Druckmaschinen AG',
  domain: 'heidelberg.com',
  country: 'Germany',
  city: 'Wiesloch',
};

const BHS = {
  name: 'BHS Corrugated Maschinen- und Anlagenbau GmbH',
  domain: 'bhs-corrugated.com',
  country: 'Germany',
  city: 'Weiherhammer',
};

describe('Heidelberg et BHS restent deux entreprises', () => {
  test('le cas exact de REVENUE-001', () => {
    const verdict = assessIdentity(HEIDELBERG, BHS);
    assert.equal(verdict.verdict, 'different');
    assert.equal(canMerge(verdict), false);
    assert.ok(
      verdict.conflicts.some((c) => /domaines différents/.test(c)),
      `le conflit de domaine doit être nommé : ${verdict.conflicts.join(' · ')}`,
    );
  });

  test('un domaine divergent tranche seul, quels que soient les accords', () => {
    // Même pays, même ville, même secteur, même raison sociale : rien de tout
    // cela ne rachète deux domaines différents.
    const verdict = assessIdentity(
      { ...HEIDELBERG, city: 'Weiherhammer', legalName: 'Maschinenbau AG' },
      { ...BHS, legalName: 'Maschinenbau AG' },
    );
    assert.equal(verdict.verdict, 'different');
  });

  test('des identifiants légaux différents tranchent aussi', () => {
    const verdict = assessIdentity(
      { name: 'Meyer GmbH', registryId: 'HRB 12345', country: 'Germany' },
      { name: 'Meyer GmbH', registryId: 'HRB 98765', country: 'Germany' },
    );
    assert.equal(verdict.verdict, 'different');
  });

  test('un même nom dans deux pays n’est pas la même entreprise', () => {
    const verdict = assessIdentity(
      { name: 'Meyer GmbH', country: 'Germany' },
      { name: 'Meyer GmbH', country: 'Austria' },
    );
    assert.equal(verdict.verdict, 'different');
  });
});

describe('ce qui autorise une fusion', () => {
  test('même domaine et même nom : la même entreprise', () => {
    const verdict = assessIdentity(
      { name: 'Lilie GmbH', domain: 'lilie.de', country: 'Germany' },
      { name: 'Lilie GmbH & Co. KG', domain: 'lilie.de', country: 'Germany' },
    );
    assert.equal(verdict.verdict, 'same');
    assert.equal(canMerge(verdict), true);
  });

  test('un nom seul ne suffit pas à fusionner', () => {
    // Le seuil est haut, et il doit l'être : le coût d'une fusion erronée est
    // un dossier client mêlant deux entreprises, découvert par le client.
    const verdict = assessIdentity({ name: 'Meyer GmbH' }, { name: 'Meyer GmbH' });
    assert.equal(verdict.verdict, 'uncertain');
    assert.equal(canMerge(verdict), false);
  });

  test('l’incertitude n’est jamais arrondie vers la fusion', () => {
    const verdict = assessIdentity(
      { name: 'Burghardt Verpackungsmaschinen', country: 'Germany' },
      { name: 'Burghardt Verpackung', domain: 'verpackungsmaschinen.de' },
    );
    assert.notEqual(verdict.verdict, 'same');
  });
});

// ── Le verrou côté écriture ────────────────────────────────────────────────

const logger = createLogger({ level: 'error', pretty: false });
let repos: Repositories;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-ident-'));
  repos = createRepositories(join(dir, 'i.db'), logger);
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('l’enrichissement ne redéfinit jamais l’identité', () => {
  const heidelberg = () =>
    repos.companies.upsert({
      canonicalKey: 'd:heidelberg.com',
      name: 'Heidelberg Druckmaschinen AG',
      domain: 'heidelberg.com',
      website: 'https://www.heidelberg.com',
      country: 'Germany',
      city: 'Wiesloch',
      dataOrigin: 'live',
    }).company;

  test('le chemin exact du défaut : un domaine ne se réécrit pas', () => {
    const company = heidelberg();
    const { company: after, conflicts } = repos.companies.enrich(company.id, {
      domain: 'bhs-corrugated.com',
      city: 'Weiherhammer',
    });

    assert.equal(after.domain, 'heidelberg.com', 'le domaine d’origine doit tenir');
    assert.equal(after.city, 'Wiesloch', 'la ville d’origine doit tenir');
    assert.equal(conflicts.length, 2, `deux contradictions attendues : ${conflicts.join(' · ')}`);
  });

  test('une contradiction met la fiche en quarantaine', () => {
    const company = heidelberg();
    repos.companies.enrich(company.id, { domain: 'bhs-corrugated.com' });

    const reloaded = repos.companies.require(company.id);
    assert.equal(reloaded.identityStatus, 'conflict');
  });

  test('la clé canonique et le domaine ne peuvent plus diverger', () => {
    // C'est la propriété que la fiche défectueuse violait : `d:heidelberg.com`
    // portant `bhs-corrugated.com`, sans que rien ne recalcule la clé.
    const company = heidelberg();
    repos.companies.enrich(company.id, { domain: 'bhs-corrugated.com' });

    const reloaded = repos.companies.require(company.id);
    assert.equal(reloaded.canonicalKey, `d:${reloaded.domain}`);
  });

  test('un champ vide se laisse compléter', () => {
    // La correction interdit de *remplacer*, pas de documenter : une fiche sans
    // ville accepte celle qu'on lui apporte.
    const { company } = repos.companies.upsert({
      canonicalKey: 'd:lilie.de',
      name: 'Lilie GmbH',
      domain: 'lilie.de',
      country: 'Germany',
      dataOrigin: 'live',
    });
    const { company: after, conflicts } = repos.companies.enrich(company.id, {
      city: 'Bochum',
      description: 'Distributeur de machines d’emballage.',
    });

    assert.equal(after.city, 'Bochum');
    assert.equal(after.description, 'Distributeur de machines d’emballage.');
    assert.deepEqual(conflicts, []);
    assert.equal(after.identityStatus, 'ok');
  });

  test('une répétition à l’identique n’est pas une contradiction', () => {
    const company = heidelberg();
    const { conflicts } = repos.companies.enrich(company.id, {
      domain: 'HEIDELBERG.COM',
      city: '  Wiesloch  ',
    });
    assert.deepEqual(conflicts, [], 'casse et espaces ne font pas deux valeurs');
  });
});
