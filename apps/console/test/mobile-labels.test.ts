import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tierLabel, stateLabel, blockerLabel, blockerLabels, outboundLabel, headlineLabel, initials, since, compact, deltaVsYesterday, hostOf, usd, errorLabel } from '../src/lib/mobile-labels.ts';

/**
 * L'écran ne montre presque jamais un code interne. Chaque traduction est
 * tenue ici ; une valeur inconnue reste lisible plutôt qu'inventée.
 */

describe('les codes deviennent des mots', () => {
  test('paliers et états', () => {
    assert.equal(tierLabel('PRIORITY').text, 'Prioritaire');
    assert.equal(tierLabel('GOOD_FIT').text, 'Bon fit');
    assert.equal(tierLabel(null).text, 'Non évalué');
    assert.equal(stateLabel('READY_FOR_APPROVAL').text, 'À approuver');
    assert.equal(stateLabel('POSITIVE_REPLY').tone, 'good');
    assert.equal(stateLabel('NEEDS_ENRICHMENT').text, 'À enrichir');
  });

  test('blocages, y compris paramétrés', () => {
    assert.equal(blockerLabel('RECOMMENDATIONS_BELOW_2'), 'Cibles à enrichir');
    assert.equal(blockerLabel('SOURCED_FACTS_0/2'), 'Preuves à compléter (0/2)');
    assert.equal(blockerLabel('QUALITY_GATE:UNSUPPORTED_BUYING_INTENT'), 'Affirmation non sourcée');
    assert.equal(blockerLabel('DUPLICATE_OF:acme.fr'), 'Doublon de acme.fr');
    assert.equal(blockerLabel('CONTACT_ROLE_MISSING'), 'Contact à vérifier');
    assert.equal(blockerLabel('STATE_DISCOVERED'), 'État : découvert');
    assert.deepEqual(blockerLabels(['SUPPRESSED', 'DO_NOT_CONTACT']), ['Ne plus contacter']);
  });

  test('une valeur inconnue reste lisible, jamais masquée', () => {
    assert.equal(stateLabel('SOMETHING_NEW').text, 'Something new');
    assert.equal(blockerLabel('BRAND_NEW_GUARD'), 'Brand new guard');
  });

  test('aucune traduction ne laisse passer un code en majuscules soulignées', () => {
    for (const code of ['NO_OBSERVED_EMAIL', 'EMAIL_NOT_COMMERCIAL', 'IDENTITY_UNVERIFIED', 'FETCH_FAILED', 'INSUFFICIENT_SIGNAL',
      'FACTORY_NOT_ELIGIBLE', 'OUTBOUND_DISABLED', 'INTERNAL_TEST_MODE', 'CAMPAIGN_NOT_APPROVED', 'NO_SIGNAL_AFTER_4_ATTEMPTS']) {
      assert.doesNotMatch(blockerLabel(code), /[A-Z]{2,}_[A-Z]/, code);
    }
  });

  test('envoi et état de tête', () => {
    assert.equal(outboundLabel('OFF').text, 'Envoi coupé');
    assert.equal(outboundLabel('INTERNAL_TEST').text, 'Envoi en test');
    assert.equal(headlineLabel('DOWN').tone, 'bad');
    assert.equal(headlineLabel('STALE').text, 'Données anciennes');
  });
});

describe('formats', () => {
  const t0 = Date.parse('2026-09-28T12:00:00.000Z');
  test('initiales', () => {
    assert.equal(initials('Mérand SAS'), 'MÉ');
    assert.equal(initials('Boulangerie Pro Équipement'), 'BP');
    assert.equal(initials(''), '?');
  });
  test('âge relatif', () => {
    assert.equal(since('2026-09-28T11:59:40.000Z', t0), 'à l’instant');
    assert.equal(since('2026-09-28T11:57:00.000Z', t0), 'il y a 3 min');
    assert.equal(since('2026-09-27T11:00:00.000Z', t0), 'hier');
    assert.equal(since(null, t0), 'jamais');
  });
  test('nombres compacts, dollars, hôtes', () => {
    assert.equal(compact(1284).replace(/\s/g, ' '), '1 284');
    assert.equal(compact(12_900), '12,9 k');
    assert.equal(compact(null), '—');
    assert.equal(usd(0.0123), '$0.0123');
    assert.equal(hostOf('https://www.merand.fr/contact'), 'merand.fr');
  });
  test('tendance : rien à dire quand il n’y a rien', () => {
    assert.equal(deltaVsYesterday([0, 0]), null);
    assert.deepEqual(deltaVsYesterday([2, 5]), { text: '+3 vs hier', tone: 'good' });
    assert.deepEqual(deltaVsYesterday([5, 2]), { text: '−3 vs hier', tone: 'neutral' });
  });
});

describe('les échecs de lecture, en français', () => {
  test('l’anglais du navigateur ne passe jamais à l’écran', () => {
    assert.equal(errorLabel('Failed to fetch'), 'Serveur injoignable. Vérifiez la connexion, puis réessayez.');
    assert.equal(errorLabel('NetworkError when attempting to fetch resource.'), 'Serveur injoignable. Vérifiez la connexion, puis réessayez.');
    assert.equal(errorLabel(null), 'Serveur injoignable. Vérifiez la connexion, puis réessayez.');
    assert.match(errorLabel('HTTP 503'), /erreur/);
  });
  test('un message déjà rédigé par le serveur reste tel quel', () => {
    assert.equal(errorLabel('domaine invalide'), 'domaine invalide');
  });
});
