import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';
import { BUSINESS_EXPANSION } from '@atlas/departments';
import { createClientRun, runClientBatch, type ClientMissionDeps } from '../src/client-mission.ts';
import { brief, searchFixture, fetchFixture, llmFixture, TOUS } from './fixtures/sweden-mission.ts';

/**
 * Les défauts du benchmark VPS, rejoués de bout en bout dans le pipeline.
 *
 * Chaque site est une réplique fidèle de ce que la page réelle publiait au
 * moment du lot : le JSON-LD au thème parasite d'Angloscand, ses agents
 * étrangers et son Org.nr en pied de page ; le +45 d'un partenaire danois ;
 * le sélecteur de pays de Cyklop avec sa filiale suédoise en attributs. Le
 * modèle est scripté ; rien ne sort sur le réseau.
 */

const logger = createLogger({ level: 'error', pretty: false });
let dir: string;
let repos: Repositories;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-bench-fixes-'));
  repos = createRepositories(join(dir, 'atlas.db'), logger);
  repos.departments.ensure(BUSINESS_EXPANSION);
});
afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Un site de plusieurs pages, servi à l'adresse exacte (www ou pas, barre finale ou pas). */
const PAGES: Record<string, string> = {
  'https://angloscandlik.se/': `<html><head>
    <title>Industrial packaging machines - Cold Seal machines from Angloscandlik</title>
    <meta property="og:site_name" content="Angloscandlik" />
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","@id":"https://angloscandlik.se/#organization","name":"seodr. theme"},{"@type":"WebSite","@id":"https://angloscandlik.se/#website","name":"Angloscandlik","publisher":{"@id":"https://angloscandlik.se/#organization"}},{"@type":"WebPage","name":"Industrial packaging machines from Angloscandlik"}]}</script>
    </head><body>
    <p>Angloscandlik är distributör av förpackningsmaskiner och kontrollutrustning för läkemedel och kosmetik.</p>
    <p>Vi installerar och servar alla maskiner.</p>
    <a href="/contact/">Contact</a> <a href="/about-us/">About us</a></body></html>`,
  'https://angloscandlik.se/contact/': `<html><head><title>Contact - Angloscandlik</title></head><body>
    <p>Henrik W. Managing Director +46(0)70 6048070 · <a href="mailto:info@angloscandlik.se">info@angloscandlik.se</a></p>
    <p>Terje L. +47 908 76 992 · Janne J. +358 9 3505060 · Brice M. +324 6848 8852 · Ambjörn B. +49 171 686 3044</p>
    <h2>HEADQUARTERS Sweden</h2><p>Hamnmagasinet Skogsövägen 8<br>133 33 Saltsjöbaden<br>Sweden</p>
    <h2>SALES OFFICE Norway</h2><p>Vestfjordveien 51 NO-3142 Vestskogen Norway</p>
    <footer>Org.nr: 556964-0716</footer></body></html>`,
  'https://angloscandlik.se/about-us/': `<html><head><title>About us - Angloscandlik</title></head><body>
    <p>A Swedish company with local agents throughout Europe.</p><footer>Org.nr: 556964-0716</footer></body></html>`,

  'https://ppslik.se/': `<html><head><title>PPS Packaging</title></head><body>
    <p>PPS är distributör av förpackningsmaskiner och kontrollutrustning för livsmedel och läkemedel.</p>
    <p>Vi installerar och servar utrustningen.</p>
    <p>Besöksadress: Industrigatan 4, 211 24 Malmö · <a href="mailto:info@ppslik.se">info@ppslik.se</a></p>
    <p>Vår partner i Danmark: +45 32 12 34 56</p></body></html>`,

  'https://cykloplik.com/': `<html lang="en"><head><title>Cykloplik | Packaging Systems</title>
    <link rel="alternate" hreflang="sv-se" href="https://cykloplik.com/sv-se/"></head><body>
    <p>info@cykloplik.com +49 2236 6020 Find a Distributor</p>
    <div class="country-item" data-country-code="se" data-country-email="info@cykloplik.se" data-country-phone="+46 8 503 053 00"></div>
    <p>Cykloplik är distributör av förpackningsmaskiner och kontrollutrustning för läkemedel.</p>
    <a href="/contact">Contact</a></body></html>`,
  'https://cykloplik.com/contact': `<html lang="en"><head><title>Contact | Cykloplik</title></head><body>
    <p>info@cykloplik.com +49 2236 6020</p>
    <p>Cykloplik GmbH, Cologne, Germany — headquarters of the group.</p>
    <p>Select a location: France Norway Sweden Netherlands Denmark Germany</p></body></html>`,

  // Tout établi, aucune preuve de pays : la note doit dire le manque.
  'https://sanspays.com/': `<html><head><title>Sanspays Machines</title></head><body>
    <p>Sanspays är distributör av förpackningsmaskiner och kontrollutrustning för läkemedel och kosmetik.</p>
    <p>Vi installerar och servar alla maskiner.</p>
    <p><a href="mailto:info@sanspays.com">info@sanspays.com</a></p></body></html>`,
};

const cle = (url: string) => url.replace(/^https?:\/\/www\./, 'https://').replace(/\/+$/, '').toLowerCase();
const fetchPages = async (urls: readonly string[]) => {
  const out: Array<{ url: string; html: string }> = [];
  for (const url of urls) {
    const hit = Object.entries(PAGES).find(([k]) => cle(k) === cle(url));
    if (hit) out.push({ url, html: hit[1] });
  }
  return out;
};

function deps(over: Partial<ClientMissionDeps> = {}): ClientMissionDeps & { llmCalls: () => number } {
  const llm = llmFixture();
  return {
    repos, search: searchFixture([]), fetchPages, llm, model: 'fixture', logger,
    now: () => '2026-09-16T10:00:00.000Z', estimatedCostPerCandidateUsd: 0.01,
    llmCalls: () => llm.calls, ...over,
  };
}
const options = (runId: string) => ({ runId, batchSize: 20, runBudgetUsd: 5, batchBudgetUsd: 5, dailyBudgetUsd: 0, createdBy: 'test' });

type Detail = {
  country: { country: string | null; basis: string; fit: string; fitReason: string; marketFitBasis: string | null; contradiction: string[]; foreignSignals: string[]; presence: { level: string; signals: string[] } };
  score: { total: number; relevance: number; confidence: number; evidence: { level: string; missing: string[] } };
  toConfirm: string[];
  triage: { status: string; priority: string | null; reasons: string[] };
};

describe('1. preuves pays : la hiérarchie tient dans le pipeline', () => {
  test('Angloscand : Org.nr + adresse suédoise, quatre indicatifs étrangers — suédoise sans réserve, et nommée par son vrai nom', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    await runClientBatch(deps({ search: searchFixture([{ domain: 'angloscandlik.se', title: 'Angloscandlik' }]) }), options(runId));
    const c = repos.clientCandidates.byDomain(runId, 'angloscandlik.se')!;
    const d = c.detail as Detail;
    assert.equal(d.country.country, 'Suède');
    assert.equal(d.country.basis, 'OFFICIAL_ID');
    assert.equal(d.country.fit, 'IN_SCOPE');
    assert.deepEqual(d.country.contradiction, [], 'les +47 / +358 / +32 / +49 ne contredisent rien');
    assert.ok(d.country.foreignSignals.some((x) => /Norvège/.test(x)));
    assert.ok(!d.toConfirm.some((x) => /pays/.test(x)), `pays jamais « à confirmer » : ${d.toConfirm.join(', ')}`);
    assert.ok(!d.triage.reasons.some((r) => /pays contredit/.test(r)), d.triage.reasons.join(' | '));
    assert.equal(c.name, 'Angloscandlik', 'jamais « seodr. theme »');
    assert.equal(c.stage, 'RETAINED');
    assert.equal(d.score.total, 100);
    assert.equal(d.score.evidence.level, 'COMPLETE');
  });

  test('PPS : adresse suédoise et un +45 — suédoise, le Danemark reste un signal lisible', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    await runClientBatch(deps({ search: searchFixture([{ domain: 'ppslik.se', title: 'PPS' }]) }), options(runId));
    const d = repos.clientCandidates.byDomain(runId, 'ppslik.se')!.detail as Detail;
    assert.equal(d.country.country, 'Suède');
    assert.equal(d.country.basis, 'POSTAL_ADDRESS');
    assert.deepEqual(d.country.contradiction, []);
    assert.ok(d.country.foreignSignals.some((x) => /Danemark/.test(x)));
    assert.ok(!d.toConfirm.some((x) => /pays/.test(x)));
  });

  test('Cyklop : siège allemand présumé, filiale suédoise dans le sélecteur de pays — à vérifier, jamais écarté pour le pays', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const d0 = deps({ search: searchFixture([{ domain: 'cykloplik.com', title: 'Cykloplik' }]) });
    await runClientBatch(d0, options(runId));
    const c = repos.clientCandidates.byDomain(runId, 'cykloplik.com')!;
    const d = c.detail as Detail;
    assert.equal(c.stage, 'REVIEW_REQUIRED');
    assert.notEqual(c.category, 'WRONG_COUNTRY', 'la présence suédoise interdit l’exclusion pays');
    assert.equal(d.country.country, 'Allemagne');
    assert.equal(d.country.basis, 'CORROBORATION');
    assert.equal(d.country.fit, 'NEEDS_VERIFICATION');
    assert.equal(d.country.marketFitBasis, 'PRESENCE_LIKELY');
    assert.equal(d.country.presence.level, 'LIKELY');
    assert.ok(d.country.presence.signals.some((s) => /info@cykloplik\.se/.test(s)));
    assert.equal(d0.llmCalls(), 1, 'la qualification a eu lieu : la société est lue, pas jetée');
    assert.ok(d.triage.reasons.some((r) => /pays/.test(r)));
  });
});

describe('2. la note dit la preuve', () => {
  test('tout établi, pays non prouvé : pertinence 100, note 85, revue — jamais retenue seule', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    await runClientBatch(deps({ search: searchFixture([{ domain: 'sanspays.com', title: 'Sanspays' }]) }), options(runId));
    const c = repos.clientCandidates.byDomain(runId, 'sanspays.com')!;
    const d = c.detail as Detail;
    assert.equal(c.stage, 'REVIEW_REQUIRED');
    assert.equal(d.score.relevance, 100);
    assert.equal(d.score.total, 85);
    assert.equal(d.score.evidence.level, 'PARTIAL');
    assert.deepEqual(d.score.evidence.missing, ['pays']);
    assert.notEqual(d.triage.status, 'AUTO_APPROVED');
  });
});

describe('4. l’invariant de comptage', () => {
  test('un annuaire écarté avant lecture est inscrit et compté : la somme des états vaut le nombre de lignes, et se lit', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    // TOUS contient europages.se, un annuaire rejeté par le filtre — le vingt-et-unième du benchmark.
    const s = await runClientBatch(deps({ search: searchFixture(TOUS), fetchPages: fetchFixture() }), options(runId));
    assert.equal(s.discovered, 5);
    assert.equal(s.filteredOut, 1);
    assert.equal(s.processed, 5);
    const resume = repos.clientCandidates.summary(runId);
    const somme = Object.values(resume.byStage).reduce((a, b) => a + b, 0);
    assert.equal(resume.total, 6, 'vingt nouveaux plus un annuaire font vingt-et-un inscrits');
    assert.equal(somme, resume.total, 'chaque ligne dans un seul état');
    assert.equal(resume.distinctDomains, resume.total, 'aucun domaine en double');
    assert.equal(resume.prefiltered, 1);
    assert.equal(resume.candidates, s.discovered, 'les candidats lus sont les « nouveaux » du lot');
    assert.equal(resume.consistent, true);
    assert.equal(resume.byStage.EXCLUDED, s.excluded + s.filteredOut);
  });

  test('un second lot ne réinscrit rien : les comptes ne bougent que par les états', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const d = deps({ search: searchFixture(TOUS), fetchPages: fetchFixture() });
    await runClientBatch(d, options(runId));
    const avant = repos.clientCandidates.summary(runId);
    await runClientBatch(d, options(runId));
    const apres = repos.clientCandidates.summary(runId);
    assert.equal(apres.total, avant.total);
    assert.equal(apres.distinctDomains, avant.distinctDomains);
    assert.equal(apres.consistent, true);
  });
});
