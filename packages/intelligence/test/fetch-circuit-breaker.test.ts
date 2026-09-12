import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '@atlas/core';
import { fetchRawPages, classifyFetchError } from '../src/contact-fetch.ts';

/**
 * Ne pas s'acharner sur un hôte mort.
 *
 * Relevé sur un cycle réel le 26/08/2026 : `schaeffler.fr` a refusé quatorze
 * connexions d'affilée, dix secondes chacune. Deux minutes trente de cycle pour
 * zéro page — la file des chemins conventionnels se déroulait jusqu'au bout sur
 * un hôte qui ne répondait plus.
 *
 * Ce que ces tests tiennent :
 *
 *   · Un 404 ne ferme pas un domaine. Une page absente ne dit rien des vingt
 *     suivantes, et couper là ferait perdre des sites vivants dont un seul
 *     chemin est faux.
 *   · Une panne de transport répétée le ferme. C'est la répétition d'une même
 *     panne qui signale un hôte mort, pas un incident isolé.
 *   · Le disjoncteur est strictement par hôte. Un domaine fermé ne doit jamais
 *     empêcher de lire le suivant.
 */

const logger = createLogger({ level: 'error', pretty: false });
const vrai = globalThis.fetch;
afterEach(() => { globalThis.fetch = vrai; });

/** Un réseau simulé : chaque hôte se comporte comme on le décide. */
function reseau(comportement: (host: string) => 'refuse' | 'timeout' | 'dns' | '404' | 'ok') {
  let appels = 0;
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    appels += 1;
    const host = new URL(String(input)).hostname;
    switch (comportement(host)) {
      case 'refuse': {
        const e = new TypeError('fetch failed');
        (e as unknown as { cause: { code: string } }).cause = { code: 'ECONNREFUSED' };
        throw e;
      }
      case 'timeout': {
        const e = new TypeError('fetch failed');
        (e as unknown as { cause: { code: string } }).cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
        throw e;
      }
      case 'dns': {
        const e = new TypeError('fetch failed');
        (e as unknown as { cause: { code: string } }).cause = { code: 'ENOTFOUND' };
        throw e;
      }
      case '404':
        return new Response('introuvable', { status: 404 });
      default:
        return new Response('<html><body><p>Une page.</p></body></html>', { status: 200 });
    }
  }) as typeof globalThis.fetch;
  return { compte: () => appels };
}

const chemins = (host: string, n: number) =>
  Array.from({ length: n }, (_, i) => `https://${host}/page-${i}`);

describe('un hôte qui ne répond plus est abandonné', () => {
  test('trois refus consécutifs ferment le domaine', async () => {
    const net = reseau(() => 'refuse');
    const out = await fetchRawPages(chemins('mort.invalid', 14), {
      logger, timeoutMs: 50, maxPages: 8,
    });

    assert.equal(out.pages.length, 0);
    assert.equal(out.aborted.length, 1);
    assert.equal(out.aborted[0]!.host, 'mort.invalid');
    assert.equal(out.aborted[0]!.kind, 'CONNECTION_REFUSED');
    // Trois tentatives, pas quatorze : c'est tout l'objet du disjoncteur.
    assert.equal(net.compte(), 3, `${net.compte()} appels réseau`);
    assert.equal(out.attempts, 3);
  });

  test('les adresses épargnées sont comptées comme temps gagné', async () => {
    reseau(() => 'timeout');
    const out = await fetchRawPages(chemins('lent.invalid', 14), {
      logger, timeoutMs: 10_000, maxPages: 8,
    });

    // Onze adresses non tentées, dix secondes chacune au pire.
    assert.equal(out.timeSavedMsEstimate, 11 * 10_000);
    assert.equal(out.aborted[0]!.kind, 'TIMEOUT');
  });

  test('une panne DNS ferme aussi le domaine', async () => {
    reseau(() => 'dns');
    const out = await fetchRawPages(chemins('inexistant.invalid', 10), {
      logger, timeoutMs: 50, maxPages: 5,
    });
    assert.equal(out.aborted[0]!.kind, 'DNS_FAILURE');
  });

  test('le seuil se règle sans changer le reste', async () => {
    const net = reseau(() => 'refuse');
    await fetchRawPages(chemins('mort2.invalid', 14), {
      logger, timeoutMs: 50, maxPages: 8, maxDomainFailures: 2,
    });
    assert.equal(net.compte(), 2);
  });
});

describe('une page absente ne condamne pas le site', () => {
  test('quatorze 404 ne ferment aucun domaine', async () => {
    /*
     * La distinction qui compte. Un 404 dit qu'une page n'existe pas ; les
     * vingt suivantes existent peut-être. Beaucoup de sites vivants n'ont
     * aucun des chemins conventionnels qu'on essaie.
     */
    const net = reseau(() => '404');
    const out = await fetchRawPages(chemins('vivant.invalid', 14), {
      logger, timeoutMs: 50, maxPages: 8,
    });

    assert.equal(out.aborted.length, 0, 'aucun domaine fermé');
    assert.equal(net.compte(), 14, 'toutes les adresses ont été tentées');
    assert.equal(out.failures.every((f) => f.kind === 'HTTP_4XX'), true);
  });

  test('une page qui passe innocente l’hôte', async () => {
    // Un site lent qui répond une fois sur trois reste lisible : le compteur
    // se remet à zéro dès qu'une page arrive.
    let n = 0;
    reseau(() => {
      n += 1;
      // Deux échecs, une réussite, deux échecs, une réussite…
      return n % 3 === 0 ? 'ok' : 'refuse';
    });
    const out = await fetchRawPages(chemins('capricieux.invalid', 12), {
      logger, timeoutMs: 50, maxPages: 4,
    });

    assert.equal(out.aborted.length, 0, 'jamais deux échecs consécutifs de trop');
    assert.ok(out.pages.length >= 2, `${out.pages.length} page(s) lue(s)`);
  });
});

describe('un domaine fermé n’en pénalise aucun autre', () => {
  test('le suivant est lu normalement', async () => {
    const net = reseau((host) => (host === 'mort.invalid' ? 'refuse' : 'ok'));
    const out = await fetchRawPages(
      [...chemins('mort.invalid', 10), ...chemins('vivant.invalid', 3)],
      { logger, timeoutMs: 50, maxPages: 5 },
    );

    assert.equal(out.aborted.length, 1);
    assert.equal(out.aborted[0]!.host, 'mort.invalid');
    assert.equal(out.pages.length, 3, 'le domaine sain est lu entièrement');
    // Trois tentatives sur le mort, trois sur le vivant.
    assert.equal(net.compte(), 6);
  });
});

describe('chaque panne porte son nom', () => {
  test('le code de cause prime sur le texte', () => {
    const avec = (code: string) => {
      const e = new TypeError('fetch failed');
      (e as unknown as { cause: { code: string } }).cause = { code };
      return e;
    };
    assert.equal(classifyFetchError(avec('ECONNREFUSED')), 'CONNECTION_REFUSED');
    assert.equal(classifyFetchError(avec('ENOTFOUND')), 'DNS_FAILURE');
    assert.equal(classifyFetchError(avec('EAI_AGAIN')), 'DNS_FAILURE');
    assert.equal(classifyFetchError(avec('UND_ERR_CONNECT_TIMEOUT')), 'TIMEOUT');
    assert.equal(classifyFetchError(avec('ERR_TLS_CERT_ALTNAME_INVALID')), 'TLS_FAILURE');
    assert.equal(classifyFetchError(avec('ECONNRESET')), 'CONNECTION_REFUSED');
  });

  test('un statut HTTP se distingue d’une panne de transport', () => {
    assert.equal(classifyFetchError(null, 404), 'HTTP_4XX');
    assert.equal(classifyFetchError(null, 410), 'HTTP_4XX');
    assert.equal(classifyFetchError(null, 500), 'HTTP_5XX');
    assert.equal(classifyFetchError(null, 503), 'HTTP_5XX');
  });

  test('une panne inconnue reste OTHER plutôt que d’être rangée au hasard', () => {
    assert.equal(classifyFetchError(new Error('quelque chose d’inhabituel')), 'OTHER');
  });
});

describe('le délai d’ATLAS est un timeout comme un autre', () => {
  test('la forme réelle de `withDeadline` est reconnue', async () => {
    /*
     * Relevé sur robaut.fr pendant un cycle réel : le délai interne d'ATLAS
     * lève une AtlasError de code 'TIMEOUT' dont le message dit « exceeded
     * 12000ms and was cancelled ». Aucun des deux ne correspondait aux motifs
     * attendus — le classificateur rendait OTHER, qui ne ferme aucun domaine.
     *
     * Autrement dit : le disjoncteur ne se déclenchait jamais sur la panne la
     * plus fréquente. Il paraissait fonctionner parce que les tests
     * simulaient des codes réseau bruts.
     */
    const { AtlasError } = await import('@atlas/core');
    const reel = new AtlasError('TIMEOUT', 'page robaut.fr exceeded 12000ms and was cancelled');
    assert.equal(classifyFetchError(reel), 'TIMEOUT');
  });

  test('et il ferme bien le domaine', async () => {
    const { AtlasError } = await import('@atlas/core');
    let appels = 0;
    globalThis.fetch = (async () => {
      appels += 1;
      throw new AtlasError('TIMEOUT', 'page lent.invalid exceeded 12000ms and was cancelled');
    }) as typeof globalThis.fetch;

    const out = await fetchRawPages(chemins('lent.invalid', 14), {
      logger, timeoutMs: 50, maxPages: 8,
    });
    assert.equal(out.aborted.length, 1);
    assert.equal(out.aborted[0]!.kind, 'TIMEOUT');
    assert.equal(appels, 3, `${appels} tentatives au lieu de 3`);
  });
});
