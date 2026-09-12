import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAtlasEnv } from '../src/index.ts';

/**
 * Une seule façon de charger l'environnement, et personne qui puisse l'oublier.
 *
 * La panne : `npm run gmail:check` lisait dix mille messages dans la vraie boîte
 * pendant que `npm run sales:inbox-sync`, lancé la seconde d'après, déclarait
 * Gmail « non configuré ». Deux processus, le même disque, deux environnements —
 * parce que le second n'appelait tout simplement pas le chargeur. Aucune erreur,
 * aucun avertissement : une variable absente ressemble en tout point à une
 * variable qu'on a choisi de ne pas mettre.
 *
 * Dix-sept scripts étaient dans ce cas. Les corriger un par un ne suffit pas :
 * c'est le dix-huitième qui compte, celui qui sera écrit demain. D'où le test
 * structurel plus bas, qui lit le répertoire plutôt qu'une liste recopiée.
 */

const dirs: string[] = [];
const CLES = ['ATLAS_TEST_PRIORITE', 'ATLAS_TEST_LOCAL_SEUL', 'ATLAS_TEST_PARTAGE_SEUL'];

const bacASable = (env: string | null, envLocal: string | null): string => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-env-'));
  dirs.push(dir);
  if (env !== null) writeFileSync(join(dir, '.env'), env, 'utf8');
  if (envLocal !== null) writeFileSync(join(dir, '.env.local'), envLocal, 'utf8');
  return dir;
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const cle of CLES) delete process.env[cle];
});

describe('la priorité des sources de configuration', () => {
  test('.env.local l’emporte sur .env', () => {
    // C'est là que vivent les secrets d'amorçage — un jeton de rafraîchissement
    // OAuth, par exemple. Le fichier partagé ne doit jamais pouvoir les écraser.
    loadAtlasEnv(bacASable(
      'ATLAS_TEST_PRIORITE=partage',
      'ATLAS_TEST_PRIORITE=local',
    ));
    assert.equal(process.env.ATLAS_TEST_PRIORITE, 'local');
  });

  test('l’environnement réel l’emporte sur les deux fichiers', () => {
    // Sans cela, plus rien ne serait surchargeable depuis la ligne de commande
    // ni depuis le service systemd.
    process.env.ATLAS_TEST_PRIORITE = 'reel';
    loadAtlasEnv(bacASable(
      'ATLAS_TEST_PRIORITE=partage',
      'ATLAS_TEST_PRIORITE=local',
    ));
    assert.equal(process.env.ATLAS_TEST_PRIORITE, 'reel');
  });

  test('les deux fichiers se complètent, ils ne se remplacent pas', () => {
    loadAtlasEnv(bacASable(
      'ATLAS_TEST_PARTAGE_SEUL=depuis-env',
      'ATLAS_TEST_LOCAL_SEUL=depuis-env-local',
    ));
    assert.equal(process.env.ATLAS_TEST_PARTAGE_SEUL, 'depuis-env');
    assert.equal(process.env.ATLAS_TEST_LOCAL_SEUL, 'depuis-env-local');
  });

  test('un fichier absent n’est pas une erreur', () => {
    assert.doesNotThrow(() => loadAtlasEnv(bacASable(null, null)));
  });

  test('elle est idempotente : relire ne change rien', () => {
    const dir = bacASable(null, 'ATLAS_TEST_PRIORITE=une-fois');
    loadAtlasEnv(dir);
    loadAtlasEnv(dir);
    assert.equal(process.env.ATLAS_TEST_PRIORITE, 'une-fois');
  });

  test('les guillemets entourant une valeur sont retirés', () => {
    loadAtlasEnv(bacASable(null, 'ATLAS_TEST_LOCAL_SEUL="avec des espaces"'));
    assert.equal(process.env.ATLAS_TEST_LOCAL_SEUL, 'avec des espaces');
  });
});

describe('aucun script ne peut oublier de charger l’environnement', () => {
  test('chaque script d’ATLAS appelle la primitive', () => {
    // Le répertoire est lu, pas une liste recopiée : une liste aurait vieilli
    // au premier script ajouté, ce qui est exactement le mode de panne.
    const dir = new URL('../../../scripts/', import.meta.url);
    const scripts = readdirSync(dir)
      .filter((name) => name.endsWith('.ts') && !name.startsWith('.'));

    assert.ok(scripts.length > 20, `${scripts.length} script(s) trouvé(s) — le chemin est-il bon ?`);

    const oublis = scripts.filter((name) => {
      const brut = readFileSync(new URL(name, dir), 'utf8');
      // Les commentaires sont retirés avant de chercher. Sans cela un appel
      // commenté satisferait le test : la première version de celui-ci passait
      // sur un `// loadAtlasEnv();`, donc ne gardait rien du tout.
      const source = brut.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      // `loadConfig()` charge aussi l'environnement : les deux conviennent.
      return !/\bloadAtlasEnv\s*\(/.test(source) && !/\bloadConfig\s*\(/.test(source);
    });

    assert.deepEqual(
      oublis, [],
      `ces scripts ne chargent ni .env ni .env.local : ils verront une `
      + `configuration absente sans qu'aucune erreur ne le dise`,
    );
  });
});
