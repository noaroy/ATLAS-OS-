import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '@atlas/core';

/**
 * Les réglages du moteur commercial en production (§13, §65–66, §89).
 *
 * Le défaut décide de ce qu'un serveur neuf fait tout seul : rien ne part,
 * personne de réel n'est contacté. Chaque valeur qui ouvrirait une porte doit
 * être posée à la main, et une valeur illisible doit refuser de démarrer
 * plutôt que d'être devinée.
 */

function configWith(env: Record<string, string>) {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATLAS_') || key.startsWith('GMAIL_')) delete process.env[key];
    }
    process.env.ATLAS_SESSION_SECRET = 'x'.repeat(32);
    Object.assign(process.env, env);
    return loadConfig('/dossier-inexistant-pour-le-test');
  } finally {
    process.env = saved;
  }
}

describe('le moteur commercial, par défaut', () => {
  test('l’envoi est coupé et le mode est INTERNAL_TEST', () => {
    const { sales } = configWith({});
    assert.equal(sales.outboundEnabled, false);
    assert.equal(sales.engineMode, 'INTERNAL_TEST');
    assert.equal(sales.engineEnabled, true);
    assert.equal(sales.discoveryEnabled, true);
  });

  test('les plafonds partent prudents : 10 par jour, 3 par heure, 2 min entre deux, pas le week-end', () => {
    const { sales } = configWith({});
    assert.equal(sales.maxNewOutreachPerDay, 10);
    assert.equal(sales.hourlySendCap, 3);
    assert.equal(sales.minSendDelaySeconds, 120);
    assert.equal(sales.sendWindow, '09:00-17:30');
    assert.equal(sales.weekendEnabled, false);
    assert.equal(sales.timezone, 'Europe/Paris');
    assert.equal(sales.maxFollowUps, 1);
    assert.equal(sales.bouncePauseRate, 0.05);
    assert.equal(sales.bounceMinSample, 20);
    assert.equal(sales.dailyAiBudgetUsd, 0.5);
  });

  test('ouvrir l’envoi est un choix explicite, et se lit', () => {
    const { sales } = configWith({ ATLAS_OUTBOUND_ENABLED: 'true', ATLAS_ENGINE_MODE: 'PRODUCTION', ATLAS_SALES_SEND_WINDOW: '08:30-18:00' });
    assert.equal(sales.outboundEnabled, true);
    assert.equal(sales.engineMode, 'PRODUCTION');
    assert.equal(sales.sendWindow, '08:30-18:00');
  });

  test('une valeur illisible refuse de démarrer plutôt que d’être devinée', () => {
    assert.throws(() => configWith({ ATLAS_SALES_SEND_WINDOW: '9h-17h' }), /ATLAS_SALES_SEND_WINDOW/);
    assert.throws(() => configWith({ ATLAS_ENGINE_MODE: 'STAGING' }), /ATLAS_ENGINE_MODE/);
    assert.throws(() => configWith({ ATLAS_SALES_MAX_FOLLOWUPS: '3' }), /ATLAS_SALES_MAX_FOLLOWUPS/);
    assert.throws(() => configWith({ ATLAS_SALES_BOUNCE_PAUSE_RATE: '1.5' }), /ATLAS_SALES_BOUNCE_PAUSE_RATE/);
  });
});
