import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';
import { BUSINESS_EXPANSION } from '@atlas/departments';
import {
  createClientRun, loadClientRun, adjustClientRun, runClientBatch, buildClientRunReport, titreDuSite,
  type ClientMissionDeps,
} from '../src/index.ts';

/**
 * Une mission client suédoise, de bout en bout, sans réseau ni modèle.
 *
 * Le moteur, les pages et le modèle sont des fixtures : ce que le test
 * vérifie, c'est le chemin — brief → requêtes → filtre → dédoublonnage →
 * pays → concurrents → critères → contacts → écriture → rapport — et ses
 * propriétés de reprise. Chaque cas de ce fichier correspond à une garantie
 * que l'audit avait trouvée absente.
 */
const logger = createLogger({ level: 'error', pretty: false });
let repos: Repositories;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-client-'));
  repos = createRepositories(join(dir, 'client.db'), logger);
  // La mission appartient à un département : celui-ci doit exister en base.
  repos.departments.ensure(BUSINESS_EXPANSION);
});
afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

import { brief, searchFixture, fetchFixture, llmFixture, TOUS } from './fixtures/sweden-mission.ts';

function deps(over: Partial<ClientMissionDeps> = {}): ClientMissionDeps & { llmCalls: () => number } {
  const llm = llmFixture();
  return {
    repos, search: searchFixture([]), fetchPages: fetchFixture(), llm, model: 'fixture', logger,
    now: () => '2026-09-11T10:00:00.000Z', estimatedCostPerCandidateUsd: 0.01,
    llmCalls: () => llm.calls, ...over,
  };
}

const options = (runId: string, extra: Record<string, unknown> = {}) => ({
  runId, batchSize: 20, runBudgetUsd: 5, batchBudgetUsd: 5, dailyBudgetUsd: 0, createdBy: 'test', ...extra,
});


// ─── Les garanties ───────────────────────────────────────────────────────────

describe('une mission client suédoise, de bout en bout', () => {
  test('le brief devient une mission ; un lot découvre, filtre, qualifie et écrit chaque candidat', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const d = deps({ search: searchFixture(TOUS) });
    const s = await runClientBatch(d, options(runId));

    assert.ok(s.queriesRun >= 1);
    assert.equal(s.filteredOut, 1, 'europages est un annuaire, écarté sans être lu');
    assert.equal(s.discovered, 5);
    assert.equal(s.processed, 5);

    const parDomaine = new Map(repos.clientCandidates.forRun(runId).map((c) => [c.domain, c]));
    assert.equal(parDomaine.get('nordpack.se')?.stage, 'RETAINED');
    assert.equal(parDomaine.get('allmaskin.se')?.stage, 'EXCLUDED');
    assert.equal(parDomaine.get('allmaskin.se')?.category, 'COMPETITOR');
    assert.match(parDomaine.get('allmaskin.se')?.evidenceQuote ?? '', /Ishida/);
    assert.equal(parDomaine.get('generalbolaget.se')?.stage, 'REVIEW_REQUIRED', 'un généraliste est signalé, pas écarté seul');
    assert.equal(parDomaine.get('generalbolaget.se')?.category, 'TOO_GENERAL');
    assert.equal(parDomaine.get('packmaschinen.de')?.stage, 'EXCLUDED');
    assert.equal(parDomaine.get('packmaschinen.de')?.category, 'WRONG_COUNTRY');
    assert.equal(parDomaine.get('europages.se')?.category, 'DIRECTORY');
    // Le concurrent, l'allemand et le site vide ne coûtent aucun appel : 2 candidats lus par le modèle.
    assert.equal(d.llmCalls(), 2);
  });

  test('le pays est corroboré sur la page, jamais déclaré : Nordpack est suédoise par son org.nr', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    await runClientBatch(deps({ search: searchFixture([TOUS[0]!]) }), options(runId));
    const c = repos.clientCandidates.byDomain(runId, 'nordpack.se')!;
    const detail = c.detail as { country: { country: string; basis: string; quote: string } };
    assert.equal(detail.country.country, 'Suède');
    assert.equal(detail.country.basis, 'OFFICIAL_ID');
    assert.match(detail.country.quote, /556123-4567/);
  });

  test('les critères sont établis sur des citations relues, et la note ne compte que l’établi', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    await runClientBatch(deps({ search: searchFixture([TOUS[0]!]) }), options(runId));
    const c = repos.clientCandidates.byDomain(runId, 'nordpack.se')!;
    const d = c.detail as { criteria: Array<{ key: string; verdict: string; evidence: Array<{ quote: string }> }>; score: { total: number } };
    const spec = d.criteria.find((k) => k.key === 'specialisation-technique')!;
    assert.equal(spec.verdict, 'ESTABLISHED');
    assert.match(spec.evidence[0]!.quote, /distributör av förpackningsmaskiner/);
    assert.equal(d.score.total, 100);
    const preuves = repos.companies.evidenceFor(c.companyId!);
    assert.ok(preuves.some((e) => e.field === 'criterion:specialisation-technique' && e.sourceRef === 'https://nordpack.se/'));
  });

  test('les contacts viennent des pages : email observé, téléphone, aucune personne inventée', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    await runClientBatch(deps({ search: searchFixture([TOUS[0]!]) }), options(runId));
    const c = repos.clientCandidates.byDomain(runId, 'nordpack.se')!;
    const contacts = (c.detail as { contacts: { email: string; phone: string; personName: string | null } }).contacts;
    assert.equal(contacts.email, 'info@nordpack.se');
    assert.match(contacts.phone, /\+46/);
    assert.equal(contacts.personName, null);
    const enBase = repos.companies.contactsFor(c.companyId!);
    assert.equal(enBase.length, 1);
    assert.equal(enBase[0]!.email, 'info@nordpack.se');
  });

  test('chaque candidat est une étape modèle à part : le plafond par étape ne peut pas tomber sur le treizième', async () => {
    /*
     * Vu sur le premier lot réel suédois : ATLAS_MAX_LLM_CALLS_PER_STEP (12)
     * s'applique par taskRef, et tous les candidats partageaient le même.
     * items.se et elektromontage.se sont tombés en échec sans avoir été lus.
     */
    const runId = createClientRun(repos, brief(), 'test');
    const metas: string[] = [];
    const llm = llmFixture();
    const espion = { async complete(r: Parameters<typeof llm.complete>[0]) { metas.push(String(r.meta?.taskRef)); return llm.complete(r); } };
    await runClientBatch(deps({ search: searchFixture(TOUS), llm: espion }), options(runId));
    assert.ok(metas.length >= 2);
    assert.equal(new Set(metas).size, metas.length, 'aucun taskRef partagé entre deux candidats');
    assert.ok(metas.every((m) => m.startsWith('client-qualification:')));
  });

  test('une adresse personnelle publiée n’est jamais le destinataire : l’adresse générale passe devant', async () => {
    // Vu sur trinex.se : « per.heidnert@ » était la première adresse publiée.
    const runId = createClientRun(repos, brief(), 'test');
    await runClientBatch(deps({ search: searchFixture([{ domain: 'trinexlik.se', title: 'Trinexlik' }]) }), options(runId));
    const c = repos.clientCandidates.byDomain(runId, 'trinexlik.se')!;
    const contacts = (c.detail as { contacts: { email: string; emailIntent: string; personalEmailsSeen: number } }).contacts;
    assert.equal(contacts.email, 'info@trinexlik.se');
    assert.equal(contacts.emailIntent, 'GENERAL');
    assert.equal(contacts.personalEmailsSeen, 1);
    assert.ok(!repos.companies.contactsFor(c.companyId!).some((k) => k.email?.startsWith('per.')));
  });

  test('un pays déclaré n’est plus contredit par un téléphone étranger : le signal reste lisible, le pays tient', async () => {
    /*
     * Vu sur kafekonordic.se : addressCountry = SE, téléphone +358. La règle
     * précédente annulait la déclaration ; le benchmark VPS a montré son coût
     * — Angloscand et PPS, suédoises prouvées, « contredites » par les
     * numéros de leurs agents. Un indicatif est un signal faible : il ne
     * contredit jamais une preuve de rang supérieur. Il reste écrit dans
     * `foreignSignals`, pour que la revue le voie sans qu'il décide.
     */
    const runId = createClientRun(repos, brief(), 'test');
    await runClientBatch(deps({ search: searchFixture([{ domain: 'kafekolik.se', title: 'Kafekolik' }]) }), options(runId));
    const c = repos.clientCandidates.byDomain(runId, 'kafekolik.se')!;
    const d = c.detail as { country: { country: string | null; basis: string; contradiction: string[]; foreignSignals: string[] }; toConfirm: string[] };
    assert.equal(d.country.country, 'Suède');
    assert.equal(d.country.basis, 'DECLARED_METADATA');
    assert.deepEqual(d.country.contradiction, []);
    assert.ok(d.country.foreignSignals.some((x) => /Finlande \(PHONE_PREFIX/.test(x)));
    assert.ok(!d.toConfirm.some((x) => /pays/.test(x)));
  });

  test('un site sans matière est écarté pour preuves insuffisantes, pas retenu par défaut', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    await runClientBatch(deps({ search: searchFixture([TOUS[5]!]) }), options(runId));
    const c = repos.clientCandidates.byDomain(runId, 'tystbolag.se')!;
    assert.notEqual(c.stage, 'RETAINED');
  });
});

describe('lots, reprise, dédoublonnage', () => {
  test('deux lots : le second ne réinscrit ni ne retraite ce que le premier a terminé', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const d = deps({ search: searchFixture(TOUS) });
    const s1 = await runClientBatch(d, options(runId));
    const appelsApres1 = d.llmCalls();
    const s2 = await runClientBatch(d, options(runId));
    assert.equal(s1.discovered, 5);
    assert.equal(s2.discovered, 0, 'aucun nouveau domaine : tout est déjà connu');
    assert.equal(s2.processed, 0);
    assert.equal(d.llmCalls(), appelsApres1, 'aucun appel repayé');
    assert.equal(repos.clientCandidates.forRun(runId).length, 6);
  });

  test('une interruption au milieu d’un lot ne perd rien, et --resume reprend là où c’était', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    // La lecture de generalbolaget tombe : le candidat passe en échec reprenable, les autres continuent.
    const d = deps({ search: searchFixture(TOUS), fetchPages: fetchFixture(new Set(['generalbolaget.se'])) });
    const s1 = await runClientBatch(d, options(runId));
    assert.equal(s1.failed, 1);
    assert.equal(repos.clientCandidates.byDomain(runId, 'nordpack.se')?.stage, 'RETAINED');
    assert.equal(repos.clientCandidates.byDomain(runId, 'generalbolaget.se')?.stage, 'FAILED_RETRYABLE');
    const appels = d.llmCalls();

    // Reprise : le réseau est revenu. Seul l'échec reprenable est retraité.
    const d2 = deps({ search: searchFixture(TOUS), fetchPages: fetchFixture(), llm: d.llm });
    const s2 = await runClientBatch(d2, options(runId, { resumeOnly: true }));
    assert.equal(s2.processed, 1);
    assert.equal(repos.clientCandidates.byDomain(runId, 'generalbolaget.se')?.stage, 'REVIEW_REQUIRED');
    assert.equal(d.llmCalls(), appels + 1, 'un seul appel de plus : celui du candidat repris');
  });

  test('un candidat qui échoue trois fois devient définitif et n’est plus repris', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const d = deps({ search: searchFixture([TOUS[2]!]), fetchPages: fetchFixture(new Set(['generalbolaget.se'])) });
    await runClientBatch(d, options(runId));
    await runClientBatch(d, options(runId, { resumeOnly: true }));
    await runClientBatch(d, options(runId, { resumeOnly: true }));
    const c = repos.clientCandidates.byDomain(runId, 'generalbolaget.se')!;
    assert.equal(c.stage, 'FAILED_FINAL');
    assert.equal(c.attempts, 3);
    const s4 = await runClientBatch(d, options(runId, { resumeOnly: true }));
    assert.equal(s4.processed, 0);
  });

  test('--exclude écarte des domaines avant toute lecture', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const d = deps({ search: searchFixture(TOUS) });
    const s = await runClientBatch(d, options(runId, { exclude: ['nordpack.se', 'www.allmaskin.se'] }));
    assert.equal(s.discovered, 3);
    assert.equal(repos.clientCandidates.byDomain(runId, 'nordpack.se'), null);
  });

  test('le plafond arrête proprement : les candidats traités restent, les autres attendent', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    // Le registre des appels est vide en fixture : on simule la dépense par un plafond nul sur l'estimation.
    const d = deps({ search: searchFixture(TOUS), estimatedCostPerCandidateUsd: 0.5 });
    const s = await runClientBatch(d, options(runId, { runBudgetUsd: 0.4 }));
    assert.match(s.stoppedBecause ?? '', /plafond/);
    assert.equal(s.processed, 0);
    assert.equal(repos.clientCandidates.pending(runId, 50).length, 5, 'rien n’est perdu, tout attend');
  });

  test('tous les moteurs muets : zéro candidat, aucune invention, aucun appel modèle', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const d = deps({ search: searchFixture(TOUS, 'rate-limited') });
    const s = await runClientBatch(d, options(runId));
    assert.equal(s.discovered, 0);
    assert.equal(d.llmCalls(), 0);
  });
});

describe('la boucle d’ajustement et le rapport', () => {
  test('un brief v2 exclut, conserve, renforce — et le travail v1 reste', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const d = deps({ search: searchFixture(TOUS) });
    await runClientBatch(d, options(runId));

    const v2 = adjustClientRun(repos, runId, {
      keepDomains: ['nordpack.se'], excludeDomains: ['tystbolag.se'], addCompetitors: ['Bizerba'],
      addKeywords: ['etikettering'], notes: 'le client veut des spécialistes',
    });
    assert.equal(v2.version, 2);
    assert.ok(v2.competitorExclusions.includes('Bizerba'));
    assert.deepEqual(loadClientRun(repos, runId).brief.version, 2);
    assert.equal(repos.clientCandidates.byDomain(runId, 'tystbolag.se')?.category, 'CLIENT_EXCLUDED');
    assert.equal(repos.clientCandidates.byDomain(runId, 'nordpack.se')?.stage, 'RETAINED', 'la v1 est intacte');
    assert.equal(loadClientRun(repos, runId).context.briefs.length, 2);
  });

  test('le rapport lit tous les lots : retenues, à revoir, écartées avec raison et preuve', async () => {
    const runId = createClientRun(repos, brief(), 'test');
    const d = deps({ search: searchFixture(TOUS.slice(0, 3)) });
    await runClientBatch(d, options(runId));
    const d2 = deps({ search: searchFixture(TOUS.slice(3)), llm: d.llm });
    await runClientBatch(d2, options(runId));

    const r = buildClientRunReport(repos, runId, {
      status: 'PARTIAL', generatedAt: '2026-09-11T12:00:00.000Z',
      scoringModel: BUSINESS_EXPANSION.scoringModel, executionMode: 'live',
    });
    assert.equal(r.report.status, 'PARTIAL');
    // Nordpack retenue, Generalbolaget à revoir (généraliste signalé) : deux fiches visibles.
    assert.equal(r.report.prospects.length, 2);
    const p = r.report.prospects[0]!;
    assert.equal(p.company, 'Nordpack AB');
    assert.ok(p.criteria && p.criteria.length === 3);
    assert.equal(p.criteria![0]!.verdictLabel, 'Établi');
    assert.equal(p.verification?.status, 'VERIFIED');
    assert.equal(p.verification?.country.value, 'Suède');
    assert.ok((r.report.exclusions ?? []).length >= 2);
    const general = r.report.prospects.find((p) => p.company === 'Generalbolaget')!;
    assert.equal(general.verification?.status, 'REVIEW_REQUIRED');
    assert.ok(general.verification?.toConfirm.some((x) => /spécialisation/.test(x)));
    const concurrent = r.report.exclusions!.find((e) => e.category === 'COMPETITOR')!;
    assert.match(concurrent.quote ?? '', /Ishida/);
    assert.match(r.html, /Sélection intermédiaire/);
    assert.match(r.html, /Entreprises écartées/);
    assert.match(r.html, /Vos critères/);
    assert.match(r.csv, /critere_specialisation-technique/);
    assert.match(r.csv, /contact_formulaire/);
    assert.match(r.exclusionsCsv, /Distribue une marque concurrente/);
    assert.doesNotMatch(r.html, /ATLAS/);

    const final = buildClientRunReport(repos, runId, {
      status: 'FINAL', generatedAt: '2026-09-11T13:00:00.000Z',
      scoringModel: BUSINESS_EXPANSION.scoringModel, executionMode: 'live',
    });
    assert.match(final.html, /Rapport final/);
  });
});

describe('titreDuSite : le nom d’une société lu dans le titre de sa page d’accueil', () => {
  const page = (title: string) => [{ url: 'https://exemple.se/', html: `<html><head><title>${title}</title></head><body></body></html>` }];

  test('coupe au séparateur même sans espaces autour, et retire les crochets d’une entité collée', () => {
    // Lu tel quel sur le premier lot réel : « … säkerhetsventiler |&nbsp[iTEMS ».
    assert.equal(titreDuSite(page('Rörkopplingar, manometrar &amp; säkerhetsventiler |&nbsp;[iTEMS')), 'Rörkopplingar, manometrar & säkerhetsventiler');
    assert.equal(titreDuSite(page('Nordpack AB – Förpackningsmaskiner')), 'Nordpack AB');
    assert.equal(titreDuSite(page('Nordpack AB | Start')), 'Nordpack AB');
  });

  test('un tiret dans un nom composé n’est pas un séparateur', () => {
    assert.equal(titreDuSite(page('Trinex-Lik AB')), 'Trinex-Lik AB');
    assert.equal(titreDuSite(page('Trinex-Lik AB - Start')), 'Trinex-Lik AB');
  });

  test('sans titre, ou avec un titre trop long, rien plutôt qu’un nom faux', () => {
    assert.equal(titreDuSite(page('')), null);
    assert.equal(titreDuSite(page('x'.repeat(80))), null);
  });

  test('fpack.se : une accroche dans le titre ne nomme pas — la marque l’emporte, et sans marque, rien (le domaine reprend)', () => {
    assert.equal(titreDuSite(page('Förpackningsmaskiner för dina behov - Fpack')), 'Fpack');
    assert.equal(titreDuSite(page('Fpack | Förpackningsmaskiner för dina behov')), 'Fpack');
    assert.equal(titreDuSite(page('Förpackningsmaskiner för dina behov')), null, 'un slogan seul n’est le nom de personne');
    assert.equal(titreDuSite(page('Packaging solutions for your needs')), null);
  });
});
