import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { collectIdentitySignals, corroborateIdentity } from '../src/identity-signals.ts';
import { collectCountrySignals, corroborateCountry } from '../src/country-evidence.ts';
import { checkPriorityEligibility } from '../src/company-resolver.ts';
import { SALES_TIER_THRESHOLDS } from '../src/sales-score.ts';

/**
 * La chaîne que le lot exécute, de la page au verdict d'éligibilité.
 *
 * Le nom d'entreprise venait du titre du résultat de recherche. Pour
 * `nincar.com`, ce titre commençait par « Sous-traitance… » et la base a
 * enregistré une société appelée **« Sous »** : treize citations verbatim
 * parfaitement vérifiées n'ont produit aucun brouillon.
 *
 * Ces tests rejouent l'enchaînement réel — pages lues, signaux collectés,
 * corroboration, éligibilité — sur les deux dossiers qui l'ont révélé.
 */

/** Ce que le lot fait de ses pages, dans l'ordre. */
function chaine(
  pages: ReadonlyArray<{ url: string; html: string }>,
  domain: string,
  reste: { score: number; facts: number; pageType?: 'OFFICIAL_COMPANY_SITE' | 'UNKNOWN' },
) {
  const identite = corroborateIdentity(collectIdentitySignals(pages), domain);
  const pays = corroborateCountry(collectCountrySignals(pages));
  const eligibilite = checkPriorityEligibility({
    identity: identite.name
      ? {
          companyName: identite.name,
          canonicalDomain: domain,
          officialWebsite: `https://${domain}`,
          country: pays.country,
          identityConfidence: identite.confidence,
          identitySources: identite.supporting.map((s) => s.sourceType),
        }
      : null,
    pageType: reste.pageType ?? 'OFFICIAL_COMPANY_SITE',
    icp: 'MATCH',
    observedFacts: reste.facts,
    score: reste.score,
    scoreThreshold: SALES_TIER_THRESHOLDS.priority,
    hasSourcedPersonalization: reste.facts > 0,
  });
  return { identite, pays, eligibilite };
}

// Les deux pages, réduites à ce qui porte l'identité et le pays.
const HARMONY = [
  {
    url: 'https://www.harmony-beton.com/fr/',
    html: '<html><head>'
      + '<meta property="og:site_name" content="Harmony Béton">'
      + '<script type="application/ld+json">{"@type":"Organization","name":"Harmony Béton"}</script>'
      + '</head><body><h1>Harmony Béton</h1>'
      + '<p>Adresse : rue du bouleau, 13109 Simiane-Collongue, France</p>'
      + '</body></html>',
  },
];

const NINCAR = [
  {
    url: 'https://www.nincar.com/',
    html: '<html><head>'
      + '<meta property="og:site_name" content="Nincar">'
      + '<script type="application/ld+json">{"@type":"Organization",'
      + '"name":"Sous-traitance industrielle et représentation commerciale"}</script>'
      + '</head><body><h1>Nincar, votre partenaire industriel</h1>'
      + '<footer>© 2026 Studio218</footer></body></html>',
  },
];

// ─── LE TITRE DU MOTEUR ─────────────────────────────────────────────────────

describe('un titre de moteur ne contamine plus l’identité', () => {
  test('« Sous » n’apparaît nulle part dans la résolution', () => {
    const { identite } = chaine(NINCAR, 'nincar.com', { score: 71.82, facts: 13 });
    assert.notEqual(identite.name, 'Sous');
    assert.equal(identite.name, 'Nincar');
  });

  test('une accroche du JSON-LD ne devient pas une raison sociale', () => {
    /*
     * Le champ `name` de nincar.com contient « Sous-traitance industrielle et
     * représentation commerciale ». À six mots elle passait, et elle battait
     * « Nincar » parce que le JSON-LD pèse plus qu'un `og:site_name`.
     */
    const { identite } = chaine(NINCAR, 'nincar.com', { score: 71.82, facts: 13 });
    assert.doesNotMatch(identite.name ?? '', /Sous-traitance/);
  });

  test('l’agence web du copyright n’est pas l’entreprise', () => {
    const { identite } = chaine(NINCAR, 'nincar.com', { score: 71.82, facts: 13 });
    assert.notEqual(identite.name, 'Studio218');
  });
});

// ─── L'IDENTITÉ ISSUE DES PAGES ─────────────────────────────────────────────

describe('l’identité lue dans les pages fait monter la confiance', () => {
  test('deux sources déclarantes concordantes franchissent le seuil', () => {
    const { identite } = chaine(HARMONY, 'harmony-beton.com', { score: 72.74, facts: 9 });
    assert.equal(identite.name, 'Harmony Béton');
    assert.ok(identite.confidence >= 0.75, `${identite.confidence}`);
  });

  test('une seule source déclarante reste sous le seuil', () => {
    // nincar.com ne déclare son nom qu'en `og:site_name`.
    const { identite } = chaine(NINCAR, 'nincar.com', { score: 71.82, facts: 13 });
    assert.ok(identite.confidence < 0.75, `${identite.confidence}`);
  });
});

// ─── LE PAYS ────────────────────────────────────────────────────────────────

describe('le pays vient des pages, jamais de l’extension', () => {
  test('une adresse France explicite est prise en compte', () => {
    const { pays } = chaine(HARMONY, 'harmony-beton.com', { score: 72.74, facts: 9 });
    assert.equal(pays.country, 'France');
  });

  test('un .fr sans aucune preuve laisse UNKNOWN', () => {
    const { pays } = chaine(
      [{ url: 'https://exemple.fr/', html: '<p>Nos ateliers de production.</p>' }],
      'exemple.fr', { score: 71, facts: 3 },
    );
    assert.equal(pays.country, null);
  });

  test('un .com français reste reconnu si la page le prouve', () => {
    // L'extension ne joue dans aucun sens : c'est la page qui tranche.
    const { pays } = chaine(HARMONY, 'harmony-beton.com', { score: 72.74, facts: 9 });
    assert.equal(pays.country, 'France');
  });
});

// ─── LE VERDICT ─────────────────────────────────────────────────────────────

describe('le verdict d’éligibilité, au bout de la chaîne', () => {
  test('Harmony-béton devient éligible', () => {
    const { eligibilite, identite, pays } = chaine(HARMONY, 'harmony-beton.com', { score: 72.74, facts: 9 });
    assert.equal(identite.confidence >= 0.75, true);
    assert.equal(pays.country, 'France');
    assert.equal(eligibilite.eligible, true, eligibilite.blockers.join(' · '));
  });

  test('Nincar reste bloqué, et pour la bonne raison', () => {
    /*
     * Le nom est désormais correct — « Nincar » et non « Sous » — mais une
     * seule source le porte et le site ne publie aucun pays. BLOCKED reste le
     * bon résultat : on ne force pas le passage.
     */
    const { eligibilite, identite, pays } = chaine(NINCAR, 'nincar.com', { score: 71.82, facts: 13 });
    assert.equal(identite.name, 'Nincar');
    assert.equal(pays.country, null);
    assert.equal(eligibilite.eligible, false);
    assert.match(eligibilite.blockers.join(' '), /pays non établi|identité/i);
  });

  test('aucune page ne donne aucun brouillon', () => {
    const { eligibilite } = chaine([], 'inconnu.fr', { score: 80, facts: 5 });
    assert.equal(eligibilite.eligible, false);
  });

  test('la chaîne n’envoie rien : elle ne rend qu’un verdict', () => {
    // Garantie structurelle : ces fonctions sont pures, sans base ni réseau.
    const avant = JSON.stringify(HARMONY);
    chaine(HARMONY, 'harmony-beton.com', { score: 72.74, facts: 9 });
    assert.equal(JSON.stringify(HARMONY), avant);
  });
});
