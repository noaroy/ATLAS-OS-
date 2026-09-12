import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/rate-limit.ts';
import { parseRetryAfter } from '../src/index.ts';

/**
 * The limiter guards the login path, so its edge behaviour matters: an
 * off-by-one lets an extra attempt through, and a fixed window would let an
 * attacker double their allowance across the boundary.
 */
describe('RateLimiter', () => {
  test('allows exactly the configured number of attempts', () => {
    const limiter = new RateLimiter({ limit: 3, windowMs: 1000 });
    const now = 1_000_000;

    assert.equal(limiter.consume('k', now).allowed, true);
    assert.equal(limiter.consume('k', now).allowed, true);
    assert.equal(limiter.consume('k', now).allowed, true);
    assert.equal(limiter.consume('k', now).allowed, false, 'the fourth must be refused');
  });

  test('reports how many attempts remain', () => {
    const limiter = new RateLimiter({ limit: 3, windowMs: 1000 });
    const now = 1_000_000;

    assert.equal(limiter.consume('k', now).remaining, 2);
    assert.equal(limiter.consume('k', now).remaining, 1);
    assert.equal(limiter.consume('k', now).remaining, 0);
  });

  test('keys are independent', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000 });
    const now = 1_000_000;

    assert.equal(limiter.consume('a', now).allowed, true);
    assert.equal(limiter.consume('b', now).allowed, true, 'one key must not throttle another');
    assert.equal(limiter.consume('a', now).allowed, false);
  });

  test('the window slides rather than resetting in blocks', () => {
    const limiter = new RateLimiter({ limit: 2, windowMs: 1000 });
    const start = 1_000_000;

    limiter.consume('k', start);
    limiter.consume('k', start + 900);
    assert.equal(limiter.consume('k', start + 950).allowed, false);

    // The first attempt has now aged out, freeing exactly one slot — a fixed
    // window would instead have freed both.
    assert.equal(limiter.consume('k', start + 1001).allowed, true);
    assert.equal(limiter.consume('k', start + 1002).allowed, false);
  });

  test('retry-after reflects when the window actually frees up', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000 });
    const start = 1_000_000;

    limiter.consume('k', start);
    const blocked = limiter.consume('k', start + 400);

    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterMs, 600);
  });

  test('a refused attempt does not extend the block', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000 });
    const start = 1_000_000;

    limiter.consume('k', start);
    limiter.consume('k', start + 100); // refused
    limiter.consume('k', start + 200); // refused

    assert.equal(
      limiter.consume('k', start + 1001).allowed,
      true,
      'hammering while blocked must not push the window forward',
    );
  });

  test('reset clears a key, so a successful login forgives earlier typos', () => {
    const limiter = new RateLimiter({ limit: 2, windowMs: 1000 });
    const now = 1_000_000;

    limiter.consume('k', now);
    limiter.consume('k', now);
    assert.equal(limiter.consume('k', now).allowed, false);

    limiter.reset('k');
    assert.equal(limiter.consume('k', now).allowed, true);
  });

  test('peek reports without recording an attempt', () => {
    const limiter = new RateLimiter({ limit: 2, windowMs: 1000 });
    const now = 1_000_000;

    assert.equal(limiter.peek('k', now).remaining, 2);
    assert.equal(limiter.peek('k', now).remaining, 2, 'peeking must not consume');
    limiter.consume('k', now);
    assert.equal(limiter.peek('k', now).remaining, 1);
  });

  test('key tracking stays bounded under rotating keys', () => {
    const limiter = new RateLimiter({ limit: 5, windowMs: 1000, maxKeys: 50 });

    // An attacker rotating source addresses must not grow the map without
    // bound — the limiter would otherwise become the denial of service.
    for (let i = 0; i < 5000; i++) limiter.consume(`ip-${i}`, 1_000_000 + i);

    assert.ok(
      limiter.trackedKeys <= 100,
      `expected bounded tracking, got ${limiter.trackedKeys} keys`,
    );
  });
});

describe('un délai annoncé trop lointain', () => {
  test('une date à l’an 2999 est refusée comme un nombre trop grand', () => {
    // Le chemin numérique plafonnait à sept jours ; le chemin date ne plafonnait
    // pas. Un en-tête malformé — ou hostile — garait donc une tâche pour un
    // millénaire, alors qu'un `Retry-After: 99999999` était refusé.
    assert.equal(parseRetryAfter('Tue, 01 Jan 2999 00:00:00 GMT'), null);
    assert.equal(parseRetryAfter('99999999'), null);
  });

  test('un délai raisonnable passe, quelle que soit la forme', () => {
    const now = Date.parse('2026-08-26T00:00:00.000Z');
    assert.equal(parseRetryAfter('60', now), now + 60_000);
    assert.equal(parseRetryAfter('2026-08-26T01:00:00.000Z', now), now + 3_600_000);
  });

  test('une date déjà passée ne programme rien', () => {
    const now = Date.parse('2026-08-26T00:00:00.000Z');
    assert.equal(parseRetryAfter('2026-08-25T00:00:00.000Z', now), null);
  });
});
