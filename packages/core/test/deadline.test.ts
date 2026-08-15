import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError, withDeadline, withTimeout } from '@atlas/core';

/**
 * Annulation réelle des appels externes.
 *
 * LIVE #002 s'est figée 1 284 secondes sous un délai d'étape de 300. La cause
 * n'était pas un délai mal réglé : `withTimeout` place une course entre la
 * promesse et une minuterie, et le perdant est *ignoré*, jamais interrompu.
 * L'appel continuait donc à consommer socket, contexte et budget, et la
 * mission restait suspendue à son résultat.
 *
 * Ces tests portent sur la différence entre abandonner et arrêter.
 */

/** Un appel qui ne répond jamais de lui-même — comme la recherche bloquée. */
function neverResolves(signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

describe('withDeadline', () => {
  test('un appel bloqué est interrompu et l’erreur le dit', async () => {
    const started = Date.now();
    await assert.rejects(
      () => withDeadline(neverResolves, { ms: 60, label: 'recherche web' }),
      (err: unknown) =>
        err instanceof AtlasError &&
        err.code === 'TIMEOUT' &&
        /recherche web/.test(err.message) &&
        /cancelled/.test(err.message),
    );
    assert.ok(Date.now() - started < 2000, 'le délai doit trancher tout de suite');
  });

  test('l’annulation descend réellement jusqu’à l’appelé', async () => {
    // La preuve que demandait le rapport : ce n'est pas la course qui tranche,
    // c'est le signal qui parvient au travail lui-même.
    let sawAbort = false;

    await assert.rejects(() =>
      withDeadline(
        (signal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                sawAbort = true;
                reject(new Error('aborted'));
              },
              { once: true },
            );
          }),
        { ms: 50, label: 'appel externe' },
      ),
    );

    assert.equal(sawAbort, true, "l'appelé doit recevoir l'annulation, pas être oublié");
  });

  test('une annulation venue de plus haut descend elle aussi', async () => {
    // Un arrêt de mission doit atteindre le fournisseur sans que chaque niveau
    // ait à le relayer à la main.
    const parent = new AbortController();
    let sawAbort = false;

    const work = withDeadline(
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              sawAbort = true;
              reject(new Error('aborted'));
            },
            { once: true },
          );
        }),
      { ms: 60_000, label: 'appel long', signal: parent.signal },
    );

    setTimeout(() => parent.abort(), 30);
    await assert.rejects(work, (err: unknown) => err instanceof AtlasError && err.code === 'TIMEOUT');
    assert.equal(sawAbort, true);
  });

  test('un appel déjà annulé ne part pas du tout', async () => {
    const parent = new AbortController();
    parent.abort();
    let ran = false;

    await assert.rejects(() =>
      withDeadline(
        async () => {
          ran = true;
          return 'ok';
        },
        { ms: 1000, label: 'appel', signal: parent.signal },
      ),
    );
    assert.equal(ran, false, 'aucun appel externe après annulation');
  });

  test('un appel qui répond à temps passe intact', async () => {
    const value = await withDeadline(async () => 'résultat', { ms: 5000, label: 'appel rapide' });
    assert.equal(value, 'résultat');
  });

  test('une erreur métier n’est pas déguisée en timeout', async () => {
    await assert.rejects(
      () =>
        withDeadline(
          async () => {
            throw new AtlasError('PROVIDER_ERROR', 'le fournisseur a refusé');
          },
          { ms: 5000, label: 'appel' },
        ),
      (err: unknown) => err instanceof AtlasError && err.code === 'PROVIDER_ERROR',
    );
  });

  test('la minuterie est libérée après un succès', async () => {
    // Une minuterie oubliée retiendrait la boucle d'événements et empêcherait
    // le processus de s'arrêter proprement.
    const before = process.getActiveResourcesInfo().length;
    await withDeadline(async () => 'ok', { ms: 30_000, label: 'appel' });
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(process.getActiveResourcesInfo().length <= before + 1);
  });

  test('un appelé sourd à l’annulation ne bloque pas la mission pour autant', async () => {
    // Dernier recours. Un fournisseur qui ignore son signal ne doit pas pouvoir
    // figer une mission : passé le délai de grâce, on rend la main avec un
    // avertissement plutôt que d'attendre indéfiniment.
    let warned: string | null = null;

    await assert.rejects(
      () =>
        withDeadline(
          () => new Promise<never>(() => {}), // n'écoute rien, ne finit jamais
          { ms: 40, label: 'fournisseur sourd', graceMs: 60, onOrphan: (l) => (warned = l) },
        ),
      (err: unknown) => err instanceof AtlasError && err.code === 'TIMEOUT',
    );

    assert.equal(warned, 'fournisseur sourd', 'le manquement doit être journalisé');
  });

  test('ms à zéro laisse passer sans borne', async () => {
    assert.equal(await withDeadline(async () => 'ok', { ms: 0, label: 'sans borne' }), 'ok');
  });
});

describe('withTimeout, pour mémoire', () => {
  test('la course abandonne mais n’interrompt pas', async () => {
    // Le comportement d'origine, conservé pour le travail purement local dont
    // l'abandon ne coûte rien. Ce test documente précisément *pourquoi* il ne
    // convenait pas aux appels externes.
    let stillRunning = true;
    const work = new Promise<string>((resolve) => {
      setTimeout(() => {
        stillRunning = false;
        resolve('trop tard');
      }, 120);
    });

    await assert.rejects(() => withTimeout(work, 30, 'travail local'));
    assert.equal(stillRunning, true, 'la promesse perdante continue — voilà le défaut');

    await work;
  });
});
