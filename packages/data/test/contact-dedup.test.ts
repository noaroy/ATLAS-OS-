import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '@atlas/core';
import { createRepositories, type Repositories } from '../src/index.ts';

/**
 * Un contact enregistré deux fois reste un contact.
 *
 * REVENUE-001 a écrit huit contacts sur Hagenauer+Denk : quatre paires
 * identiques, mêmes adresse et téléphone. Un agent qui repasse sur une
 * entreprise relit la même page et la reconsigne à l'identique.
 *
 * Un doublon n'est pas seulement inesthétique dans un livrable — il fausse le
 * jugement. « Huit contacts » suggère une organisation bien documentée là où il
 * y en a deux, et le client s'en aperçoit à la première tentative.
 *
 * Tout est syntaxique : aucune comparaison n'appelle le modèle.
 */

const logger = createLogger({ level: 'error', pretty: false });
let repos: Repositories;
let dir: string;
let companyId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-contact-'));
  repos = createRepositories(join(dir, 'c.db'), logger);
  companyId = repos.companies.upsert({
    canonicalKey: 'd:hagenauer-denk.de',
    name: 'Hagenauer+Denk KG',
    domain: 'hagenauer-denk.de',
    country: 'Germany',
    dataOrigin: 'live',
  }).company.id;
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const add = (over: Partial<Parameters<Repositories['companies']['addContact']>[0]> = {}) =>
  repos.companies.addContact({
    companyId,
    name: 'Contact général',
    role: null,
    email: null,
    phone: null,
    linkedin: null,
    confidence: 0.5,
    evidenceId: null,
    ...over,
  });

describe('déduplication déterministe des contacts', () => {
  test('le cas exact de REVENUE-001', () => {
    // Quatre passages sur la même page de contact, rapportant tantôt l'adresse
    // et tantôt le téléphone.
    for (let i = 0; i < 4; i++) add({ email: 'info@hagenauer-denk.de' });
    for (let i = 0; i < 4; i++) add({ phone: '+49 8323 96600' });

    const contacts = repos.companies.contactsFor(companyId);
    assert.equal(contacts.length, 1, 'huit relevés du même contact général en font un');

    // Et la déduplication ne doit rien perdre : le contact retenu porte les
    // deux canaux, alors qu'aucun relevé isolé ne les avait tous les deux.
    assert.equal(contacts[0]!.email, 'info@hagenauer-denk.de');
    assert.equal(contacts[0]!.phone, '+49 8323 96600');
  });

  test('un canal déjà connu n’est jamais réécrit', () => {
    add({ name: 'Anna Weber', email: 'a.weber@hagenauer-denk.de' });
    add({ name: 'Anna Weber', email: 'contact@hagenauer-denk.de', phone: '+49 8323 96600' });

    const [contact] = repos.companies.contactsFor(companyId);
    // Le nom rapproche les deux relevés ; l'adresse d'origine tient, et le
    // téléphone — qui manquait — est ajouté.
    assert.equal(contact!.email, 'a.weber@hagenauer-denk.de');
    assert.equal(contact!.phone, '+49 8323 96600');
  });

  test('une adresse identique à la casse près est la même', () => {
    add({ email: 'Info@Hagenauer-Denk.DE' });
    add({ email: '  info@hagenauer-denk.de  ' });
    assert.equal(repos.companies.contactsFor(companyId).length, 1);
  });

  test('un numéro composé différemment est le même numéro', () => {
    // « +49 8323 96600 » et « 08323 96600 » joignent la même personne.
    add({ phone: '+49 8323 96600' });
    add({ phone: '08323 96600' });
    add({ phone: '+49 (0)8323 / 96600' });
    assert.equal(repos.companies.contactsFor(companyId).length, 1);
  });

  test('un profil LinkedIn identique est le même contact', () => {
    add({ name: 'Anna Weber', linkedin: 'https://www.linkedin.com/in/anna-weber/' });
    add({ name: 'A. Weber', linkedin: 'linkedin.com/in/anna-weber' });
    assert.equal(repos.companies.contactsFor(companyId).length, 1);
  });

  test('deux « Contact général » sans coordonnées sont la même entrée', () => {
    // Ni l'un ni l'autre ne désigne quelqu'un.
    add();
    add();
    assert.equal(repos.companies.contactsFor(companyId).length, 1);
  });

  test('deux personnes différentes restent deux contacts', () => {
    add({ name: 'Anna Weber', role: 'Vertrieb', email: 'a.weber@hagenauer-denk.de' });
    add({ name: 'Klaus Denk', role: 'Geschäftsführung', email: 'k.denk@hagenauer-denk.de' });
    assert.equal(repos.companies.contactsFor(companyId).length, 2);
  });

  test('le même contact sur une autre entreprise n’est pas un doublon', () => {
    const other = repos.companies.upsert({
      canonicalKey: 'd:lilie.de',
      name: 'Lilie GmbH',
      domain: 'lilie.de',
      country: 'Germany',
      dataOrigin: 'live',
    }).company;

    add({ email: 'info@example-shared.de' });
    repos.companies.addContact({
      companyId: other.id,
      name: 'Contact général',
      role: null,
      email: 'info@example-shared.de',
      phone: null,
      linkedin: null,
      confidence: 0.5,
      evidenceId: null,
    });

    // La déduplication est bornée à l'entreprise, et doit l'être : un
    // prestataire partagé n'est pas une raison de fusionner deux dossiers.
    assert.equal(repos.companies.contactsFor(companyId).length, 1);
    assert.equal(repos.companies.contactsFor(other.id).length, 1);
  });

  test('l’entrée existante est rendue, pas une copie', () => {
    const first = add({ email: 'info@hagenauer-denk.de', name: 'Contact général' });
    const second = add({ email: 'info@hagenauer-denk.de', name: 'Service commercial' });
    assert.equal(second.id, first.id, 'le contact déjà enregistré doit être rendu tel quel');
  });

  test('un numéro trop court ne sert pas de signature', () => {
    // Quatre chiffres ne joignent personne : les rapprocher fusionnerait des
    // contacts sans rapport.
    add({ name: 'Poste A', phone: '1234' });
    add({ name: 'Poste B', phone: '5678' });
    assert.equal(repos.companies.contactsFor(companyId).length, 2);
  });
});
