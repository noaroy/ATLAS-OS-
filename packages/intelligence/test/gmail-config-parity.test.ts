import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAtlasEnv, createLogger } from '@atlas/core';
import { GmailInboxProvider } from '../src/index.ts';

/**
 * Deux commandes, une seule configuration.
 *
 * La panne : `npm run gmail:check` confirmait `gmail.readonly` et lisait dix
 * mille sept cent soixante et onze messages dans la vraie boîte ; lancé la
 * seconde d'après, `npm run sales:inbox-sync` déclarait `GMAIL_NOT_CONFIGURED`
 * et donnait les quatre variables pour absentes. Même machine, même disque,
 * même fichier — mais le second script n'appelait pas le chargeur, si bien que
 * `.env.local` n'existait pas pour son processus.
 *
 * Ce qui rendait la chose difficile à voir : une variable jamais chargée est
 * indiscernable d'une variable qu'on a choisi de ne pas mettre. Le script
 * n'avait donc rien d'anormal à signaler, et ne signalait rien.
 *
 * Le test vérifie la propriété qui manquait : à environnement identique, les
 * deux chemins doivent voir exactement la même chose. Les valeurs employées ici
 * sont des factices — aucun vrai identifiant n'entre dans un test.
 */

const dirs: string[] = [];
const GMAIL_KEYS = [
  'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'GMAIL_USER',
] as const;

const FIXTURES = {
  GMAIL_CLIENT_ID: 'factice-1234.apps.googleusercontent.com',
  GMAIL_CLIENT_SECRET: 'factice-secret-jamais-reel',
  GMAIL_REFRESH_TOKEN: 'factice-refresh-jamais-reel',
  GMAIL_USER: 'factice@exemple.invalid',
} as const;

const sauvegarde: Record<string, string | undefined> = {};
for (const cle of GMAIL_KEYS) sauvegarde[cle] = process.env[cle];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const cle of GMAIL_KEYS) {
    if (sauvegarde[cle] === undefined) delete process.env[cle];
    else process.env[cle] = sauvegarde[cle];
  }
});

/** Un projet jetable portant les identifiants dans `.env.local`, comme en vrai. */
const projetAvecEnvLocal = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-parite-'));
  dirs.push(dir);
  writeFileSync(
    join(dir, '.env.local'),
    Object.entries(FIXTURES).map(([k, v]) => `${k}=${v}`).join('\n'),
    'utf8',
  );
  return dir;
};

/** Ce que chaque chemin lit réellement, une fois l'environnement chargé. */
const configurationVue = () => {
  const status = new GmailInboxProvider({
    logger: createLogger({ level: 'error', pretty: false }),
  }).status();
  return {
    configured: status.configured,
    code: status.code,
    scopes: [...status.scopes].sort(),
    // Les valeurs ne sont pas comparées en clair : leur longueur et leur
    // présence suffisent à prouver que les deux chemins lisent la même chose,
    // et un secret n'a rien à faire dans une sortie de test.
    empreinte: GMAIL_KEYS.map((cle) => `${cle}:${(process.env[cle] ?? '').length}`).join('|'),
  };
};

describe('gmail:check et sales:inbox-sync voient la même configuration', () => {
  test('à environnement identique, les deux chemins lisent la même chose', () => {
    const projet = projetAvecEnvLocal();
    for (const cle of GMAIL_KEYS) delete process.env[cle];

    // Le chemin de `gmail:check` : il charge, puis lit.
    loadAtlasEnv(projet);
    const vuParCheck = configurationVue();

    // Le chemin de `sales:inbox-sync`, désormais identique. Avant la
    // correction, ce second relevé rendait `configured: false` alors que le
    // premier rendait `true` — dans le même processus, à une ligne d'écart.
    loadAtlasEnv(projet);
    const vuParSync = configurationVue();

    assert.deepEqual(vuParSync, vuParCheck);
    assert.equal(vuParCheck.configured, true, 'les identifiants fixtures doivent suffire');
  });

  test('sans chargement, la configuration paraît absente — la panne d’origine', () => {
    // Reproduit ce que faisait `sales:inbox-sync` : lire sans avoir chargé.
    // Le fichier existe, les identifiants y sont, et le provider ne voit rien.
    projetAvecEnvLocal();
    for (const cle of GMAIL_KEYS) delete process.env[cle];

    const sansChargement = configurationVue();
    assert.equal(sansChargement.configured, false);
    assert.match(sansChargement.code, /NOT_CONFIGURED/);
  });

  test('l’environnement réel l’emporte sur le fichier, pour les deux chemins', () => {
    const projet = projetAvecEnvLocal();
    for (const cle of GMAIL_KEYS) delete process.env[cle];
    process.env.GMAIL_USER = 'surcharge@exemple.invalid';

    loadAtlasEnv(projet);
    assert.equal(process.env.GMAIL_USER, 'surcharge@exemple.invalid');
    // Et les autres viennent bien du fichier : la surcharge est ciblée.
    assert.equal(process.env.GMAIL_CLIENT_ID, FIXTURES.GMAIL_CLIENT_ID);
  });

  test('aucun secret ne sort du relevé de configuration', () => {
    const projet = projetAvecEnvLocal();
    for (const cle of GMAIL_KEYS) delete process.env[cle];
    loadAtlasEnv(projet);

    const rendu = JSON.stringify(configurationVue());
    assert.ok(!rendu.includes(FIXTURES.GMAIL_CLIENT_SECRET), 'le secret client ne doit pas y figurer');
    assert.ok(!rendu.includes(FIXTURES.GMAIL_REFRESH_TOKEN), 'le jeton ne doit pas y figurer');
  });
});
