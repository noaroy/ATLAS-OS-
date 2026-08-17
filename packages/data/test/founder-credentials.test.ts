import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../core/src/logger.ts';
import { createRepositories, type Repositories } from '../src/index.ts';

/**
 * Le compte fondateur et son mot de passe.
 *
 * Ce que ces tests protègent : qu'aucun mot de passe ne soit récupérable depuis
 * la base, qu'un changement de mot de passe ferme réellement les portes déjà
 * ouvertes, et que deux comptes portant le même mot de passe ne produisent pas
 * la même empreinte.
 */
const logger = createLogger({ level: 'error', pretty: false });
let dir: string;
let repos: Repositories;

const SECRET = 'un-mot-de-passe-choisi';

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-auth-'));
  repos = createRepositories(join(dir, 'auth.db'), logger);
});

after(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('identifiants du fondateur', () => {
  test('un compte créé se connecte avec son mot de passe, et seulement avec lui', () => {
    const user = repos.users.create({
      email: 'Founder@Atlas.local',
      name: 'Founder',
      role: 'founder',
      password: SECRET,
    });

    // L'adresse est normalisée : se tromper de casse ne doit pas fermer la porte.
    assert.equal(user.email, 'founder@atlas.local');

    const session = repos.users.authenticate('founder@atlas.local', SECRET);
    assert.ok(session.token.length > 20);

    assert.throws(() => repos.users.authenticate('founder@atlas.local', SECRET + 'x'));
    assert.throws(() => repos.users.authenticate('founder@atlas.local', ''));
  });

  test("le mot de passe n'est nulle part dans le fichier de base", () => {
    // La vérification qui compte vraiment : on cherche le mot de passe en clair
    // dans les octets du fichier, y compris le journal WAL.
    for (const file of ['auth.db', 'auth.db-wal']) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(join(dir, file));
      } catch {
        continue; // le WAL peut ne pas exister
      }
      assert.equal(
        bytes.includes(Buffer.from(SECRET, 'utf8')),
        false,
        `« ${SECRET} » se retrouve en clair dans ${file}`,
      );
    }
  });

  test('deux comptes au même mot de passe ont des empreintes différentes', () => {
    // C'est ce que fait le sel : sans lui, une table d'empreintes identiques
    // révélerait quels comptes partagent un mot de passe, et une seule attaque
    // les ouvrirait tous.
    const second = repos.users.create({
      email: 'second@atlas.local',
      name: 'Second',
      role: 'operator',
      password: SECRET,
    });

    const rows = repos.db
      .prepare('SELECT password_hash, password_salt FROM users')
      .all() as Array<{ password_hash: string; password_salt: string }>;

    assert.equal(new Set(rows.map((r) => r.password_salt)).size, rows.length, 'sels identiques');
    assert.equal(new Set(rows.map((r) => r.password_hash)).size, rows.length, 'empreintes identiques');

    assert.ok(repos.users.authenticate('second@atlas.local', SECRET));
  });

  test('changer le mot de passe ferme les sessions déjà ouvertes', () => {
    const user = repos.users.findByEmail('founder@atlas.local')!;
    const before = repos.users.authenticate('founder@atlas.local', SECRET);
    assert.ok(repos.users.resolveSession(before.token), 'la session doit être valide avant');

    repos.users.setPassword(user.id, 'un-autre-mot-de-passe');
    const closed = repos.users.revokeAllForUser(user.id);

    assert.ok(closed >= 1, 'au moins une session devait être fermée');
    assert.equal(
      repos.users.resolveSession(before.token),
      null,
      'un jeton émis avant le changement ne doit plus ouvrir la porte',
    );

    assert.throws(() => repos.users.authenticate('founder@atlas.local', SECRET), 'ancien mot de passe');
    assert.ok(repos.users.authenticate('founder@atlas.local', 'un-autre-mot-de-passe'));
  });

  test("la forme des identifiants est lisible sans exposer quoi que ce soit", () => {
    const user = repos.users.findByEmail('founder@atlas.local')!;
    const shape = repos.users.credentialShape(user.id);

    assert.equal(shape.algorithm, 'scrypt');
    assert.equal(shape.hashBytes, 64);
    assert.equal(shape.saltBytes, 16);

    // Rien dans cette structure ne doit ressembler à du matériel secret.
    const serialised = JSON.stringify(shape);
    assert.equal(serialised.includes('un-autre-mot-de-passe'), false);
    assert.ok(serialised.length < 120, 'cette structure ne doit rien transporter d’autre');
  });

  test('la liste des comptes ne contient ni empreinte ni sel', () => {
    for (const user of repos.users.list()) {
      const keys = Object.keys(user);
      for (const forbidden of ['password', 'passwordHash', 'password_hash', 'salt', 'password_salt']) {
        assert.equal(keys.includes(forbidden), false, `« ${forbidden} » ne doit pas sortir du dépôt`);
      }
    }
  });
});
