import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';
import { BUSINESS_EXPANSION } from '@atlas/departments';
import { createClientRun, runClientBatch } from '../src/client-mission.ts';
import { buildReviewQueue } from '../src/client-report-run.ts';
import { brief, searchFixture, llmFixture } from './fixtures/sweden-mission.ts';
import { BENCHMARK, BENCHMARK_PAGES, DIRECTORY_RESULT } from './fixtures/benchmark-sweden.ts';

/**
 * Le benchmark suédois rejoué en un lot, hors ligne, en moins d'une seconde.
 *
 * Ce qu'il tient : les huit sorties attendues — nom, siège, présence, preuve,
 * tri — et l'invariant de comptage sur le lot entier. Il remplace le web live
 * pour vérifier que les défauts corrigés ne reviennent pas ; le web live reste
 * l'épreuve finale, pas la première.
 */

const logger = createLogger({ level: 'error', pretty: false });
let dir: string;
let repos: Repositories;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-bench-replay-'));
  repos = createRepositories(join(dir, 'atlas.db'), logger);
  repos.departments.ensure(BUSINESS_EXPANSION);
});
afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const cle = (url: string) => url.replace(/^https?:\/\/www\./, 'https://').replace(/\/+$/, '').toLowerCase();
const fetchPages = async (urls: readonly string[]) => {
  const out: Array<{ url: string; html: string }> = [];
  for (const url of urls) {
    const hit = Object.entries(BENCHMARK_PAGES).find(([k]) => cle(k) === cle(url));
    if (hit) out.push({ url, html: hit[1] });
  }
  return out;
};

type Detail = {
  country: { country: string | null; basis: string; fit: string; legalHeadquartersCountry: string | null; targetMarketPresence: string; contradiction: string[]; foreignSignals: string[]; presence: { level: string } };
  score?: { total: number; relevance: number; evidence: { level: string; missing: string[] } };
  triage: { status: string; priority: string | null; reasons: string[] };
};

describe('benchmark suédois — rejeu déterministe', () => {
  test('les neuf cas sortent comme attendu, et le lot compte juste', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const llm = llmFixture();
    const appelsParDomaine = new Map<string, number>();
    const espion = {
      async complete(r: Parameters<typeof llm.complete>[0]) {
        const domaine = String(r.meta?.taskRef ?? '').replace('client-qualification:', '');
        appelsParDomaine.set(domaine, (appelsParDomaine.get(domaine) ?? 0) + 1);
        return llm.complete(r);
      },
    };
    const t0 = Date.now();
    const summary = await runClientBatch(
      { repos, search: searchFixture([...BENCHMARK.map((c) => ({ domain: c.domain, title: c.title })), DIRECTORY_RESULT]), fetchPages, llm: espion, model: 'fixture', logger, now: () => '2026-09-16T10:00:00.000Z', estimatedCostPerCandidateUsd: 0.01 },
      { runId, batchSize: 20, runBudgetUsd: 5, batchBudgetUsd: 5, dailyBudgetUsd: 0, createdBy: 'test' },
    );
    const ms = Date.now() - t0;
    assert.ok(ms < 5_000, `le rejeu doit rester rapide (${ms} ms)`);

    const echecs: string[] = [];
    for (const cas of BENCHMARK) {
      const c = repos.clientCandidates.byDomain(runId, cas.domain);
      if (!c) { echecs.push(`${cas.domain}: absent`); continue; }
      const d = c.detail as Detail;
      const attendu = cas.expect;
      const check = (label: string, ok: boolean, got: unknown) => { if (!ok) echecs.push(`${cas.domain} · ${label} : obtenu ${JSON.stringify(got)}`); };
      check(`stage=${attendu.stage}`, c.stage === attendu.stage, `${c.stage} (${c.category ?? '-'} · ${c.reason ?? ''})`);
      check(`name=${attendu.name}`, c.name === attendu.name, c.name);
      check(`country=${attendu.country}`, d.country.country === attendu.country, d.country.country);
      check('legalHeadquartersCountry = country', d.country.legalHeadquartersCountry === d.country.country, d.country.legalHeadquartersCountry);
      if (attendu.countryBasis) check(`basis=${attendu.countryBasis}`, d.country.basis === attendu.countryBasis, d.country.basis);
      check(`presence=${attendu.presence}`, d.country.targetMarketPresence === attendu.presence, d.country.targetMarketPresence);
      check(`fit=${attendu.fit}`, d.country.fit === attendu.fit, d.country.fit);
      check(`triage=${attendu.triage}`, d.triage.status === attendu.triage, d.triage);
      if (attendu.category !== undefined) check(`category=${attendu.category}`, c.category === attendu.category, c.category);
      if (attendu.evidence) check(`evidence=${attendu.evidence}`, d.score?.evidence.level === attendu.evidence, d.score?.evidence);
      if (attendu.contradictionEmpty) check('contradiction vide', d.country.contradiction.length === 0, d.country.contradiction);
      if (attendu.foreignSignal) check('signal étranger lisible', d.country.foreignSignals.some((x) => attendu.foreignSignal!.test(x)), d.country.foreignSignals);
      check(`llmCalled=${attendu.llmCalled}`, (appelsParDomaine.get(cas.domain) ?? 0) > 0 === attendu.llmCalled, appelsParDomaine.get(cas.domain) ?? 0);
      if (attendu.stage === 'RETAINED') check('retenue = preuve complète et note ≥ 70', d.score?.evidence.level === 'COMPLETE' && (d.score?.total ?? 0) >= 70, d.score);
      if (attendu.total !== undefined) check(`total=${attendu.total}`, d.score?.total === attendu.total, d.score?.total);
      // Rien de ce qu'un humain lira ne porte un objet interpolé.
      const lisible = `${c.name ?? ''} ${c.reason ?? ''} ${JSON.stringify(c.detail)}`;
      check('aucun « [object Object] »', !lisible.includes('[object Object]'), c.reason);
    }
    assert.deepEqual(echecs, [], `\n${echecs.join('\n')}`);

    // Weibang : une présomption, dite comme telle — revue P3, sans note, raison lisible.
    const weibang = repos.clientCandidates.byDomain(runId, 'yanbanmachine-lik.com')!;
    assert.match(weibang.reason ?? '', /concordance/);
    assert.match(weibang.reason ?? '', /un seul signal Suède \(version linguistique \(hreflang sv\)\), insuffisant/);
    const triageWeibang = (weibang.detail as Detail).triage;
    assert.equal(triageWeibang.status, 'HUMAN_REVIEW');
    assert.equal(triageWeibang.priority, 'P3');
    assert.ok(triageWeibang.reasons.some((r) => /présomption/.test(r)), triageWeibang.reasons.join(' | '));
    assert.equal((weibang.detail as Detail).score, undefined, 'pas de note : pas de lecture');
    const fiche = buildReviewQueue(repos, runId).find((i) => i.domain === 'yanbanmachine-lik.com')!;
    assert.equal(fiche.scored, false);
    assert.equal(fiche.countryPresumed, true);
    assert.match(fiche.recommendationLabel, /présomption/);
    assert.ok(!JSON.stringify(fiche).includes('[object Object]'));

    // Le comptage : neuf lus, un annuaire écarté avant lecture, dix inscrits, un état par ligne.
    assert.equal(summary.discovered, 9);
    assert.equal(summary.filteredOut, 1);
    assert.equal(summary.processed, 9);
    const resume = repos.clientCandidates.summary(runId);
    assert.equal(resume.total, 10);
    assert.equal(resume.candidates, 9);
    assert.equal(resume.prefiltered, 1);
    assert.equal(resume.consistent, true);
    assert.equal(Object.values(resume.byStage).reduce((a, b) => a + b, 0), 10);
    assert.equal(resume.byStage.RETAINED, 3);
    assert.equal(resume.byStage.REVIEW_REQUIRED, 5, 'dont Weibang, présumée chinoise');
    assert.equal(resume.byStage.EXCLUDED, 2, 'le fabricant étranger prouvé et l’annuaire');
    // Aucun appel modèle pour ce qui n'a rien à lire ou n'est pas du marché.
    assert.equal(appelsParDomaine.get('levo-lik.se') ?? 0, 0);
    assert.equal(appelsParDomaine.get('hlunpack-lik.com') ?? 0, 0);
    assert.equal(appelsParDomaine.get('yanbanmachine-lik.com') ?? 0, 0);
    assert.equal([...appelsParDomaine.values()].reduce((a, b) => a + b, 0), 6, 'six qualifications, une par candidat lisible du marché');
  });
});
