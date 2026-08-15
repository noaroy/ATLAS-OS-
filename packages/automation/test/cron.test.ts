import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, nextRun, isValidCron } from '../src/cron.ts';

describe('cron parser', () => {
  test('parses wildcards into full ranges', () => {
    const cron = parseCron('* * * * *');
    assert.equal(cron.minutes.size, 60);
    assert.equal(cron.hours.size, 24);
    assert.equal(cron.daysOfMonth.size, 31);
    assert.equal(cron.months.size, 12);
  });

  test('parses lists, ranges and steps', () => {
    const cron = parseCron('0,30 9-17 * * 1-5');
    assert.deepEqual([...cron.minutes].sort((a, b) => a - b), [0, 30]);
    assert.equal(cron.hours.size, 9);
    assert.deepEqual([...cron.daysOfWeek].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  });

  test('supports */n steps', () => {
    assert.equal(parseCron('*/15 * * * *').minutes.size, 4);
    assert.deepEqual([...parseCron('0 */6 * * *').hours].sort((a, b) => a - b), [0, 6, 12, 18]);
  });

  test('treats Sunday as both 0 and 7', () => {
    assert.deepEqual([...parseCron('0 0 * * 7').daysOfWeek], [0]);
  });

  test('supports named shorthands', () => {
    assert.deepEqual([...parseCron('@daily').hours], [0]);
  });

  test('rejects malformed expressions', () => {
    for (const bad of ['* * * *', '60 * * * *', '* 25 * * *', 'nonsense', '*/0 * * * *']) {
      assert.equal(isValidCron(bad), false, `expected "${bad}" to be rejected`);
    }
  });
});

describe('nextRun', () => {
  test('returns the next matching minute, strictly in the future', () => {
    const from = new Date('2026-03-10T08:14:30Z');
    const next = nextRun('*/15 * * * *', from);
    assert.equal(next?.toISOString(), '2026-03-10T08:15:00.000Z');
  });

  test('never returns the current minute', () => {
    const from = new Date('2026-03-10T08:15:00Z');
    const next = nextRun('*/15 * * * *', from);
    assert.equal(next?.toISOString(), '2026-03-10T08:30:00.000Z');
  });

  test('rolls into the next day', () => {
    const next = nextRun('15 2 * * *', new Date('2026-03-10T08:00:00Z'));
    assert.equal(next?.toISOString(), '2026-03-11T02:15:00.000Z');
  });

  test('rolls into the next month', () => {
    const next = nextRun('0 0 1 * *', new Date('2026-03-10T08:00:00Z'));
    assert.equal(next?.toISOString(), '2026-04-01T00:00:00.000Z');
  });

  test('matches day-of-month OR day-of-week when both are restricted', () => {
    // The 1st is a Wednesday in April 2026; Friday the 3rd must also match.
    const next = nextRun('0 12 1 4 5', new Date('2026-04-01T13:00:00Z'));
    assert.equal(next?.toISOString(), '2026-04-03T12:00:00.000Z');
  });

  test('returns null for a date that can never occur', () => {
    assert.equal(nextRun('0 0 30 2 *', new Date('2026-01-01T00:00:00Z')), null);
  });
});
