import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCountryEvidence, collectCountrySignals, corroborateCountry, assessMarketPresence, decideCountry,
  COUNTRY_SIGNAL_RANK,
} from '../src/country-evidence.ts';
import { collectIdentitySignals, corroborateIdentity, isParasiteName, companyNameFromDomain, jsonLdNodes } from '../src/identity-signals.ts';
import { qualificationScore, evidenceLevelOf, EVIDENCE_FACTOR, type CriterionResult } from '../src/client-criteria.ts';
import { triageCandidate } from '../src/client-triage.ts';

/**
 * Les quatre défauts du benchmark VPS (INTERNAL_TEST Suède, 20 candidats),
 * fixés à la source, chacun avec la page qui l'a révélé.
 *
 *   1. Angloscand : Org.nr et adresse de Saltsjöbaden sur la page de contact,
 *      et les téléphones de ses agents en Norvège, Finlande, Belgique,
 *      Allemagne — « pays contredit ». Un indicatif ne contredit rien.
 *   2. PPS : adresse suédoise, un +45 — pénalisé pour un voisin.
 *   3. Cyklop : siège allemand par concordance, filiale suédoise visible dans
 *      le sélecteur de pays — « Allemagne », écarté. La présence compte.
 *   4. Angloscand encore : le JSON-LD d'une extension SEO nomme l'Organization
 *      « seodr. theme » ; le vrai nom est dans og:site_name.
 *   5. Une note de 100 avec un pays non prouvé : la note ne disait pas le
 *      manque.
 */

const CONTACT_ANGLOSCAND = `<html><head><title>Contact - Angloscand</title></head><body>
  <h1>Contact</h1>
  <p>Henrik Wahlgren Managing Director +46(0)70 6048070</p>
  <p>Terje Løken +47 908 76 992</p>
  <p>Janne Janhonen +358 9 3505060</p>
  <p>Brice Margerin +324 6848 8852</p>
  <p>Ambjörn Breuer +49 171 686 3044 Eco Pack Solutions</p>
  <h2>HEADQUARTERS Sweden</h2>
  <p>Hamnmagasinet Skogsövägen 8<br>133 33 Saltsjöbaden<br>Sweden</p>
  <h2>SALES OFFICE Norway</h2>
  <p>Angloscand Europe AB Vestfjordveien 51 NO-3142 Vestskogen Norway</p>
  <h2>Germany</h2><p>Grüne Twiete 130a 25469 Halstenbek Germany</p>
  <footer>Org.nr: 556964-0716 · Privacy Policy</footer>
</body></html>`;

const HOME_ANGLOSCAND = `<html><head>
  <title>Industrial packaging machines - Cold Seal machines and Cold Seal materials from Angloscand</title>
  <meta property="og:site_name" content="Angloscand" />
  <script type="application/ld+json" class="rank-math-schema">{"@context":"https://schema.org","@graph":[{"@type":"Organization","@id":"https://angloscand.eu/#organization","name":"seodr. theme"},{"@type":"WebSite","@id":"https://angloscand.eu/#website","url":"https://angloscand.eu","name":"Angloscand","publisher":{"@id":"https://angloscand.eu/#organization"}},{"@type":"WebPage","@id":"https://angloscand.eu/#webpage","name":"Industrial packaging machines - Cold Seal machines from Angloscand","isPartOf":{"@id":"https://angloscand.eu/#website"}}]}</script>
  </head><body><h1>Cold Seal packaging machines</h1><p>Angloscand supplies cold seal machines to Scandinavian industry.</p></body></html>`;

const HOME_PPS = `<html><head><title>PPS Packaging</title></head><body>
  <p>PPS levererar förpackningsmaskiner och kontrollutrustning till livsmedelsindustrin.</p>
  <p>Besöksadress: Industrigatan 4, 211 24 Malmö</p>
  <p>Vår partner i Danmark: +45 32 12 34 56</p>
</body></html>`;

const HOME_CYKLOP = `<html lang="en"><head><title>Cyklop | Leading in Packaging Systems</title>
  <link rel="alternate" hreflang="sv-se" href="https://www.cyklop.com/sv-se/">
  <link rel="alternate" hreflang="de-de" href="https://www.cyklop.com/de-de/">
  </head><body>
  <p>info@cyklop.com + 49 2236 6020 Find a Distributor</p>
  <div class="country-item" data-country-code="se" data-country-email="info@cyklop.se" data-country-phone="+46 8 503 053 00"></div>
  <p>Cyklop develops strapping and stretch wrapping machines for logistics.</p>
</body></html>`;
const CONTACT_CYKLOP = `<html lang="en"><head><title>Contact Worldwide | Cyklop</title></head><body>
  <p>info@cyklop.com +49 2236 6020</p>
  <p>Cyklop GmbH, Cologne, Germany — headquarters of the group.</p>
  <p>Select a location: France Norway Sweden Netherlands Italy Denmark Belgium Germany</p>
</body></html>`;

const page = (url: string, html: string) => ({ url, html });

describe('1. hiérarchie des preuves pays', () => {
  test('un indicatif étranger ne contredit jamais un Org.nr ni une adresse : Angloscand est suédoise, sans réserve', () => {
    const pages = [page('https://angloscand.eu/', HOME_ANGLOSCAND), page('https://angloscand.eu/contact/', CONTACT_ANGLOSCAND)];
    const strong = extractCountryEvidence(pages);
    assert.equal(strong.country, 'Suède');
    assert.equal(strong.basis, 'OFFICIAL_ID');
    const signals = collectCountrySignals(pages);
    assert.ok(signals.some((s) => s.type === 'PHONE_PREFIX' && s.country === 'Norvège'));
    const d = decideCountry({ strong, signals, corroboration: corroborateCountry(signals), presence: assessMarketPresence(pages, 'Suède'), accepted: ['Suède'] });
    assert.equal(d.country, 'Suède');
    assert.equal(d.fit, 'IN_SCOPE');
    assert.deepEqual(d.contradiction, [], 'aucune contradiction : les +47/+358/+32/+49 sont des signaux faibles');
    assert.ok(d.foreignSignals.some((x) => /Finlande/.test(x)) && d.foreignSignals.some((x) => /Belgique/.test(x)), 'gardés pour la lecture');
    assert.equal(d.marketFitBasis, 'SEAT');
  });

  test('une adresse suédoise et un +45 : PPS reste suédoise (adresse > indicatif)', () => {
    const pages = [page('https://pps.se/', HOME_PPS)];
    const strong = extractCountryEvidence(pages);
    assert.equal(strong.basis, 'POSTAL_ADDRESS');
    const signals = collectCountrySignals(pages);
    const d = decideCountry({ strong, signals, corroboration: corroborateCountry(signals), presence: assessMarketPresence(pages, 'Suède'), accepted: ['Suède'] });
    assert.equal(d.country, 'Suède');
    assert.equal(d.fit, 'IN_SCOPE');
    assert.deepEqual(d.contradiction, []);
    assert.ok(d.foreignSignals.some((x) => /Danemark \(PHONE_PREFIX/.test(x)));
  });

  test('une preuve de même rang contredit encore : deux déclarations, deux pays, aucun siège', () => {
    const pages = [
      page('https://x.se/', `<html><body><p>Adresse : Storgatan 1, 111 22 Stockholm</p></body></html>`),
      page('https://x.se/legal', `<html><body><p>TVA intracommunautaire : FR17928914423</p></body></html>`),
    ];
    const strong = extractCountryEvidence(pages);
    const signals = collectCountrySignals(pages);
    const d = decideCountry({ strong, signals, corroboration: corroborateCountry(signals), presence: null, accepted: ['Suède'] });
    // La TVA française est un identifiant (rang 3) : elle prime sur l'adresse (rang 2).
    assert.equal(strong.basis, 'OFFICIAL_ID');
    assert.equal(strong.country, 'France');
    assert.equal(d.fit, 'OUT_OF_SCOPE');
  });

  test('les rangs sont ceux annoncés : indicatif et mention à zéro', () => {
    assert.equal(COUNTRY_SIGNAL_RANK.PHONE_PREFIX, 0);
    assert.equal(COUNTRY_SIGNAL_RANK.MENTION_IN_IDENTITY_PAGE, 0);
    assert.ok(COUNTRY_SIGNAL_RANK.OFFICIAL_ID > COUNTRY_SIGNAL_RANK.POSTAL_ADDRESS);
  });

  test('Kafeko : SE déclaré, +358 publié — le pays tient, le téléphone reste un signal étranger lisible', () => {
    const pages = [page('https://kafeko.se/', `<html><head><script type="application/ld+json">{"@type":"Organization","name":"Kafeko Nordic","address":{"@type":"PostalAddress","addressCountry":"SE"}}</script></head><body><p>Tel +358 9 4131 5400</p></body></html>`)];
    const strong = extractCountryEvidence(pages);
    const signals = collectCountrySignals(pages);
    const d = decideCountry({ strong, signals, corroboration: corroborateCountry(signals), presence: assessMarketPresence(pages, 'Suède'), accepted: ['Suède'] });
    assert.equal(d.country, 'Suède');
    assert.deepEqual(d.contradiction, []);
    assert.ok(d.foreignSignals.some((x) => /Finlande/.test(x)));
  });
});

describe('1b. implantation sur le marché', () => {
  test('Cyklop : siège allemand par concordance, présence suédoise probable → à vérifier, pas écarté', () => {
    const pages = [page('https://www.cyklop.com/', HOME_CYKLOP), page('https://www.cyklop.com/contact', CONTACT_CYKLOP)];
    const strong = extractCountryEvidence(pages);
    assert.equal(strong.country, null, 'aucune preuve forte de siège');
    const signals = collectCountrySignals(pages);
    const corroboration = corroborateCountry(signals);
    assert.equal(corroboration.country, 'Allemagne');
    const presence = assessMarketPresence(pages, 'Suède');
    assert.equal(presence.level, 'LIKELY', presence.reason);
    assert.ok(presence.signals.some((s) => s.type === 'LOCAL_EMAIL_DOMAIN' && s.rawValue === 'info@cyklop.se'));
    assert.ok(presence.signals.some((s) => s.type === 'LOCAL_PHONE'));
    assert.ok(presence.signals.some((s) => s.type === 'LOCAL_LANGUAGE_VERSION'));
    const d = decideCountry({ strong, signals, corroboration, presence, accepted: ['Suède'] });
    assert.equal(d.country, 'Allemagne');
    assert.equal(d.basis, 'CORROBORATION');
    assert.equal(d.fit, 'NEEDS_VERIFICATION');
    assert.equal(d.marketFitBasis, 'PRESENCE_LIKELY');
    assert.match(d.fitReason, /présence Suède probable/);
  });

  test('une filiale suédoise avec adresse, siège au Danemark : pertinente pour la Suède', () => {
    const pages = [
      page('https://nordicpack.dk/', `<html><body><p>Nordicpack A/S, Industrivej 2, 8000 Aarhus, Danmark · CVR 12345678</p><p>Adresse : Industrivej 2, Aarhus, Danemark</p></body></html>`),
      page('https://nordicpack.dk/sverige', `<html><body><p>Nordicpack Sverige AB · Verkstadsgatan 12, 214 35 Malmö · +46 40 123 456</p></body></html>`),
    ];
    const strong = extractCountryEvidence(pages);
    const signals = collectCountrySignals(pages);
    const presence = assessMarketPresence(pages, 'Suède');
    assert.equal(presence.level, 'ESTABLISHED', presence.reason);
    const d = decideCountry({ strong, signals, corroboration: corroborateCountry(signals), presence, accepted: ['Suède'] });
    assert.equal(d.fit, 'IN_SCOPE');
    assert.equal(d.marketFitBasis, 'LOCAL_PRESENCE');
    assert.match(d.fitReason, /implantation Suède établie/);
  });

  test('un seul signal faible ne fait pas une présence ; un marché sans profil n’en évalue aucune', () => {
    const pages = [page('https://intrus.de/', `<html><body><p>Kontakt: +46 8 111 22 33</p></body></html>`)];
    assert.equal(assessMarketPresence(pages, 'Suède').level, 'WEAK');
    assert.equal(assessMarketPresence(pages, 'Atlantide').level, 'NONE');
  });
});

describe('4. le nom de société', () => {
  test('Angloscand : « seodr. theme » n’est jamais un nom ; og:site_name l’emporte', () => {
    const signals = collectIdentitySignals([page('https://angloscand.eu/', HOME_ANGLOSCAND)]);
    assert.ok(!signals.some((s) => /theme/i.test(s.value)), signals.map((s) => `${s.sourceType}:${s.value}`).join(' | '));
    const identity = corroborateIdentity(signals, 'angloscand.eu');
    assert.equal(identity.name, 'Angloscand');
  });

  test('le nom d’une Organization se lit dans son nœud, pas dans le WebPage voisin', () => {
    const nodes = jsonLdNodes('{"@graph":[{"@type":"Organization","name":"Acme AB"},{"@type":"WebPage","name":"Bienvenue chez Acme — accueil"}]}');
    assert.equal(nodes.length, 1);
    const signals = collectIdentitySignals([page('https://acme.se/', `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage","name":"Startsida - Acme AB"},{"@type":"Organization","name":"Acme AB","legalName":"Acme Aktiebolag"}]}</script></head><body></body></html>`)]);
    const org = signals.filter((s) => s.sourceType === 'JSONLD_ORGANIZATION').map((s) => s.value);
    assert.deepEqual(org, ['Acme AB']);
    assert.ok(signals.some((s) => s.sourceType === 'SCHEMA_LEGAL_NAME' && s.value === 'Acme Aktiebolag'));
  });

  test('les noms parasites sont reconnus, les vrais noms non ; le domaine donne un repli propre', () => {
    for (const bad of ['seodr. theme', 'Divi Theme', 'Just another WordPress site', 'Site Title', 'Demo']) assert.equal(isParasiteName(bad), true, bad);
    for (const good of ['Angloscand', 'Nordpack AB', 'Thematic Solutions', 'Templeton Machines']) assert.equal(isParasiteName(good), false, good);
    assert.equal(companyNameFromDomain('angloscand.se'), 'Angloscand');
    assert.equal(companyNameFromDomain('https://www.nord-pack.com/'), 'Nord Pack');
  });
});

describe('2. note et niveau de preuve', () => {
  const critere = (key: string, kind: 'required' | 'preferred', verdict: CriterionResult['verdict'], weight = 1, withEvidence = true): CriterionResult => ({
    key, label: `Critère ${key}`, kind, weight, verdict, note: 'n',
    evidence: verdict === 'ESTABLISHED' && withEvidence ? [{ evidenceQuote: 'q', sourceUrl: 'https://x.se/' } as CriterionResult['evidence'][number]] : [],
    downgraded: null,
  });
  const tous = [critere('a', 'required', 'ESTABLISHED', 3), critere('b', 'required', 'ESTABLISHED', 2), critere('c', 'preferred', 'ESTABLISHED', 1)];

  test('tout établi, pays dans le marché : 100/100 et preuve complète', () => {
    const s = qualificationScore(tous, 'IN_SCOPE');
    assert.equal(s.relevance, 100);
    assert.equal(s.total, 100);
    assert.equal(s.evidence.level, 'COMPLETE');
  });

  test('tout établi mais pays non prouvé : pertinence 100, note 85, preuve partielle nommant le pays', () => {
    const s = qualificationScore(tous, 'NEEDS_VERIFICATION');
    assert.equal(s.relevance, 100);
    assert.equal(s.total, Math.round(100 * EVIDENCE_FACTOR.PARTIAL));
    assert.equal(s.evidence.level, 'PARTIAL');
    assert.deepEqual(s.evidence.missing, ['pays']);
  });

  test('un critère requis à confirmer : la note baisse deux fois — dans la pertinence et dans la preuve', () => {
    const s = qualificationScore([critere('a', 'required', 'ESTABLISHED', 3), critere('b', 'required', 'TO_CONFIRM', 2), critere('c', 'preferred', 'ESTABLISHED', 1)], 'IN_SCOPE');
    assert.equal(s.relevance, 72);
    assert.equal(s.total, Math.round(72 * EVIDENCE_FACTOR.PARTIAL));
    assert.deepEqual(s.evidence.missing, ['Critère b']);
    assert.equal(evidenceLevelOf({ criteria: [critere('a', 'required', 'TO_CONFIRM')], countryStatus: 'IN_SCOPE' }).level, 'INSUFFICIENT');
  });

  test('le tri n’approuve jamais seul un dossier dont la preuve n’est pas complète', () => {
    const decision = { outcome: 'RETAINED' as const, category: null, reason: 'ok', toConfirm: [] };
    const base = {
      decision, criteria: tous, specialisation: { verdict: 'SPECIALIST' as const, note: '', evidence: [] },
      countryStatus: 'IN_SCOPE' as const, contradiction: [], score: { total: 100, confidence: 1 }, generalistRisk: 0,
      contact: { method: 'EMAIL' as const, confidence: 'HIGH' as const }, preferSpecialist: true, relevanceHits: 3,
    };
    assert.equal(triageCandidate({ ...base, evidence: { level: 'COMPLETE', missing: [] } }).status, 'AUTO_APPROVED');
    const t = triageCandidate({ ...base, evidence: { level: 'PARTIAL', missing: ['pays'] } });
    assert.equal(t.status, 'HUMAN_REVIEW');
    assert.ok(t.reasons.some((r) => /preuve partielle : pays/.test(r)));
  });
});
