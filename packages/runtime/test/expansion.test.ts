import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../core/src/logger.ts';
import type { AtlasConfig } from '../../core/src/index.ts';
import { createRepositories, type Repositories } from '../../data/src/index.ts';
import { makeTestConfig } from '../../testing/src/index.ts';
import type { LlmProvider, LlmRequest } from '../../llm/src/index.ts';
import type { SearchProvider, SearchRequest, SearchResult } from '../../intelligence/src/index.ts';
import {
  runExpansion, resumeOpenExpansions, expansionReport, expansionGraph, promoteCandidates, strongestSeeds, scoreCandidate,
  entityKeyOf, isJunkDomain, trustOf, prospectExpansionSource, createExpansionHandlers, EXPANSION_TASK_TYPE, DEFAULT_EXPANSION_LIMITS,
  runAutopilotCycle, decideAutonomy, SAFE_AUTONOMOUS_TASK_TYPES, routeTask,
  type ExpansionDeps, type AutopilotObservation, type AutopilotProposal, type OpportunitySource,
} from '../src/index.ts';

/**
 * Le moteur d'expansion, éprouvé sur un petit monde fermé.
 *
 * Aucun réseau : le moteur de recherche et le lecteur de pages sont des
 * fixtures qui rendent un écosystème connu — un fabricant, ses pages
 * distributeurs et partenaires, un salon qui publie ses exposants, une
 * fédération qui liste ses membres, des résultats de recherche avec leur lot
 * d'annuaires et d'articles. Ce qu'on vérifie n'est pas la qualité du web,
 * c'est la conduite du moteur : une entité par entreprise, une preuve par
 * relation, des plafonds durs, une reprise sans doublon, et jamais un message.
 */

const logger = createLogger({ level: 'error', pretty: false });
const EPOCH = '1970-01-01T00:00:00.000Z';
let dir: string;
let repos: Repositories;
let config: AtlasConfig;

// ─── Le petit monde ──────────────────────────────────────────────────────────

const page = (title: string, body: string) => `<html><head><title>${title}</title><meta name="description" content="${title}"></head><body>${body}</body></html>`;
const a = (href: string, text: string) => `<li><a href="${href}">${text}</a> — partenaire de confiance</li>`;

const WORLD: Record<string, string> = {
  'https://acme-machines.fr/': page('Acme Machines – Fabricant de machines d’emballage industriel', `
    <nav>${a('/distributeurs', 'Nos distributeurs')} ${a('/partenaires', 'Partenaires')} ${a('/references', 'Références clients')} ${a('/contact', 'Contact')}</nav>
    <p>Acme Machines conçoit et fabrique des machines d’emballage pour l’industrie agroalimentaire. SIRET 123 456 789 00012 — Lyon, France.</p>`),
  'https://acme-machines.fr/distributeurs': page('Nos distributeurs – Acme Machines', `<ul>
    ${a('https://www.distri-nord.fr/', 'Distri Nord')} ${a('https://emballage-sud.fr/', 'Emballage Sud')} ${a('https://packtech.be/', 'PackTech')}
    ${a('https://www.linkedin.com/company/acme', 'LinkedIn')} ${a('https://facebook.com/acme', 'Facebook')}</ul>`),
  'https://acme-machines.fr/partenaires': page('Partenaires – Acme Machines', `<ul>${a('https://distri-nord.fr/partenariat', 'Distri Nord')} ${a('https://integra-pack.fr/', 'Integra Pack')} ${a('https://acme-machines.boutique-platform.example/', 'Notre boutique')}</ul><footer>Réalisation : <a href="https://agence-web-lyon.fr/">Agence Web Lyon</a></footer>`),
  'https://acme-machines.fr/references': page('Références – Acme Machines', `<ul>${a('https://biscuits-dupont.fr/', 'Biscuits Dupont')}</ul>`),
  'https://distri-nord.fr/': page('Distri Nord – distributeur de machines d’emballage', '<p>Distri Nord, distributeur en France. SIRET 987 654 321 00021. 59000 Lille.</p>'),
  'https://emballage-sud.fr/': page('Emballage Sud – solutions d’emballage industriel', '<p>Fabricant et distributeur. SIRET 111 222 333 00044. Marseille.</p>'),
  'https://machines-emballage-ouest.fr/': page('MEO – Fabricant de machines d’emballage', '<p>Fabricant de machines d’emballage à Nantes. SIRET 555 666 777 00088.</p>'),
  'https://rival-pack.fr/': page('Rival Pack – machines d’emballage', '<p>Rival Pack, fabricant. SIRET 999 888 777 00066.</p>'),
  'https://salon-emballage-expo.fr/': page('Salon Emballage Expo – le salon de l’emballage', `<nav>${a('/exposants', 'Liste des exposants')} ${a('/infos', 'Infos pratiques')}</nav>`),
  'https://salon-emballage-expo.fr/exposants': page('Exposants – Salon Emballage Expo', `<ul>
    ${a('https://distri-nord.fr/', 'Distri Nord')} ${a('https://machines-emballage-ouest.fr/', 'MEO')} ${a('https://expo-newco.fr/', 'Expo Newco')} ${a('https://foreign-pack.cn/', 'Foreign Pack')}</ul>`),
  'https://federation-emballage.fr/annuaire-des-membres': page('Annuaire des membres – Fédération de l’emballage', `<ul>
    ${a('https://acme-machines.fr/', 'Acme Machines')} ${a('https://distri-nord.fr/', 'Distri Nord')} ${a('https://emballage-sud.fr/', 'Emballage Sud')} ${a('https://member-only.fr/', 'Member Only')}</ul>`),
};

const result = (url: string, title: string, snippet: string, rank = 1): SearchResult => ({ title, url, snippet, provider: 'fixture', rank, query: '', retrievedAt: '2026-09-21T10:00:00.000Z' });

const RESULTS: Array<{ match: RegExp; results: SearchResult[] }> = [
  { match: /"Acme Machines" distributeurs/i, results: [
    result('https://distri-nord.fr/marques/acme', 'Distri Nord — distributeur officiel Acme Machines', 'Distri Nord est distributeur officiel des machines Acme Machines en France.'),
    result('https://societe.com/societe/acme-machines', 'ACME MACHINES (Lyon) — Société', 'chiffre d’affaires, dirigeants', 2),
    // Une fiche d'annuaire *sur la graine*, sur un hôte inconnu des listes : ni un distributeur, ni une entreprise.
    result('https://fiches-pro.example/professionnels/acme-machines-123456789', 'Acme Machines à Lyon — distributeur de machines', 'Acme Machines, distributeur, Lyon. SIRET 123456789.', 3),
  ] },
  { match: /"Acme Machines" concurrents/i, results: [
    result('https://top10-emballage.fr/blog/top-10-machines', 'Top 10 des machines d’emballage', 'Acme Machines, Rival Pack, …'),
    result('https://rival-pack.fr/', 'Rival Pack – machines d’emballage, l’alternative à Acme Machines', 'Rival Pack propose une alternative aux machines Acme Machines.', 2),
  ] },
  { match: /alternative à Acme Machines/i, results: [
    result('https://rival-pack.fr/', 'Rival Pack – l’alternative à Acme Machines', 'Rival Pack, fabricant français, alternative à Acme Machines.'),
  ] },
  { match: /salon exposants/i, results: [
    result('https://salon-emballage-expo.fr/', 'Salon Emballage Expo – le salon de l’emballage', 'Le salon de référence de l’emballage industriel : exposants, conférences.'),
    result('https://lesechos.fr/industrie/salon-emballage', 'Le salon de l’emballage ouvre ses portes', 'article', 2),
  ] },
  { match: /fédération .* membres/i, results: [
    result('https://federation-emballage.fr/annuaire-des-membres', 'Annuaire des membres – Fédération de l’emballage', 'Les entreprises membres de la fédération.'),
  ] },
  { match: /fabricant$|entreprise$/i, results: [
    result('https://machines-emballage-ouest.fr/', 'MEO – Fabricant de machines d’emballage', 'MEO fabrique des machines d’emballage à Nantes.'),
    result('https://pappers.fr/entreprise/meo', 'MEO — Pappers', 'fiche entreprise', 2),
    result('https://lesechos.fr/industrie/emballage', 'L’emballage se réinvente', 'article', 3),
    result('https://agence-marketing-pack.fr/', 'Agence marketing packaging – agence de communication', 'agence de communication spécialisée emballage', 4),
  ] },
];

function fixtureSearch(log: string[] = []): SearchProvider {
  return {
    key: 'fixture', label: 'fixture', availability: () => ({ available: true, reason: 'fixture' }),
    async search(request: SearchRequest) {
      log.push(request.query);
      const hit = RESULTS.find((r) => r.match.test(request.query));
      return { results: hit ? hit.results.map((x) => ({ ...x, query: request.query })) : [], outcome: hit ? 'ok' : 'empty', detail: 'fixture', costUsd: 0.005, durationMs: 1 };
    },
  };
}

const fixtureFetch = (log: string[] = []) => async (url: string): Promise<string | null> => {
  log.push(url);
  const key = url.replace('https://www.', 'https://');
  return WORLD[key] ?? WORLD[`${key}/`] ?? null;
};

function deps(over: Partial<ExpansionDeps> = {}): ExpansionDeps {
  return { repos, config, logger, search: fixtureSearch(), fetchHtml: fixtureFetch(), provider: null, pacing: { searchGapMs: 0, backoffMs: 0 }, ...over };
}

const SEED = { name: 'Acme Machines', domain: 'acme-machines.fr', website: 'https://acme-machines.fr', country: 'France' };

const assertNothingSent = () => {
  assert.equal(repos.salesLoop.sentSince(EPOCH), 0, 'MESSAGES SENT: 0');
  assert.ok(!repos.tasks.list({ limit: 500 }).some((t) => t.taskType === 'SALES_SEND'), 'jamais un SALES_SEND');
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-expansion-'));
  repos = createRepositories(join(dir, 'atlas.db'), logger);
  config = makeTestConfig(dir);
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

// ─── 1–4. Une graine, plusieurs relations, une entité, des preuves ──────────

describe('1. une graine forte s’étend en plusieurs types de relations', () => {
  test('distributeurs, partenaires, références, exposants, membres, concurrents, semblables — chacun avec sa preuve', async () => {
    const { run, report } = await runExpansion(deps(), { seeds: [SEED], limits: { maxDepth: 1 } });
    assert.equal(run.status, 'DONE');
    const types = new Set(repos.expansion.relationshipsForRun(run.id).map((r) => r.relationshipType));
    for (const t of ['DISTRIBUTOR', 'VISIBLE_PARTNER', 'LIKELY_CUSTOMER', 'TRADE_SHOW_EXHIBITOR', 'ASSOCIATION_MEMBER', 'COMPETITOR', 'SIMILAR_COMPANY']) {
      assert.ok(types.has(t), `relation ${t} attendue (obtenu : ${[...types].join(', ')})`);
    }
    for (const r of repos.expansion.relationshipsForRun(run.id)) {
      assert.ok(r.evidenceUrl.startsWith('https://'), 'chaque relation a une URL de preuve');
      assert.ok(r.evidenceSummary.length > 0);
    }
    assert.ok(report.stats.uniqueCompanies >= 7, `${report.stats.uniqueCompanies} entreprises`);
    assert.ok(report.stats.funnel.highPriority >= 1, 'au moins un prioritaire');
    assert.match(report.summary, /aucun message envoyé/);
    assertNothingSent();
  });
});

describe('2 + 3. la même entreprise par plusieurs chemins : une entité, plusieurs preuves', () => {
  test('Distri Nord, trouvée par la page distributeurs, la page partenaires, sa propre page, le salon et la fédération : une ligne, cinq preuves', async () => {
    const { run } = await runExpansion(deps(), { seeds: [SEED], limits: { maxDepth: 1 } });
    const candidates = repos.expansion.candidates(run.id, { limit: 500 }).filter((c) => c.canonicalDomain === 'distri-nord.fr');
    assert.equal(candidates.length, 1, 'une seule entité pour distri-nord.fr');
    const rels = repos.expansion.relationshipsTo('distri-nord.fr');
    const urls = new Set(rels.map((r) => r.evidenceUrl));
    assert.ok(urls.size >= 4, `plusieurs preuves distinctes conservées : ${[...urls].join(', ')}`);
    const types = new Set(rels.map((r) => r.relationshipType));
    assert.ok(types.has('DISTRIBUTOR') && types.has('VISIBLE_PARTNER') && types.has('TRADE_SHOW_EXHIBITOR') && types.has('ASSOCIATION_MEMBER'));
    const evidence = repos.expansion.evidenceOf('distri-nord.fr');
    assert.ok(evidence.filter((e) => e.kind === 'RELATIONSHIP').length >= 4);
    assert.ok(evidence.some((e) => e.kind === 'COUNTRY' && /France/.test(e.claim)), 'le pays est prouvé par sa propre page (SIRET)');
    assert.equal(candidates[0]!.stage, 'HIGH_PRIORITY');
  });
});

describe('4. deux entreprises homonymes ne fusionnent pas', () => {
  test('même nom, domaines différents → deux clés ; sans domaine, jamais rattachée d’office', () => {
    assert.notEqual(entityKeyOf({ name: 'Nordpack', domain: 'nordpack.se' }), entityKeyOf({ name: 'Nordpack', domain: 'nordpack.co.uk' }));
    assert.notEqual(entityKeyOf({ name: 'Nordpack AB', domain: null }), entityKeyOf({ name: 'Nordpack', domain: 'nordpack.se' }));
    assert.equal(entityKeyOf({ name: 'Nordpack AB', domain: null }), entityKeyOf({ name: 'NORDPACK', domain: null }), 'le nom normalisé ignore la forme juridique');
    assert.equal(entityKeyOf({ name: 'Distri Nord', domain: 'www.distri-nord.fr' }), 'distri-nord.fr');
    const run = repos.expansion.startRun({ purpose: 'SALES', trigger: 'test', seeds: [], strategies: [], limits: {} });
    const { created } = repos.expansion.upsertCandidate({ runId: run.id, entityKey: 'nordpack.se', companyName: 'Nordpack', canonicalDomain: 'nordpack.se', website: null, country: null, depth: 1, seedKey: null });
    const second = repos.expansion.upsertCandidate({ runId: run.id, entityKey: 'nordpack.co.uk', companyName: 'Nordpack', canonicalDomain: 'nordpack.co.uk', website: null, country: null, depth: 1, seedKey: null });
    const twice = repos.expansion.upsertCandidate({ runId: run.id, entityKey: 'nordpack.se', companyName: 'NORDPACK AB', canonicalDomain: 'nordpack.se', website: null, country: 'Suède', depth: 2, seedKey: null });
    assert.equal(twice.created, false, 'la même clé enrichit, ne crée pas');
    assert.deepEqual(twice.candidate.aliases, ['NORDPACK AB']);
    assert.equal(twice.candidate.depth, 1, 'la profondeur la plus courte est gardée');
    assert.equal(twice.candidate.country, 'Suède');
    assert.equal(created, true);
    assert.equal(second.created, true, 'un homonyme sur un autre domaine est une autre entreprise');
  });
});

// ─── 5–8. Les plafonds ──────────────────────────────────────────────────────

describe('5. la profondeur est bornée', () => {
  test('profondeur 1 : aucun enfant n’est exploré ; profondeur 2 : les enfants sûrs le sont, jamais leurs enfants', async () => {
    const one = await runExpansion(deps(), { seeds: [SEED], limits: { maxDepth: 1 } });
    assert.ok(repos.expansion.candidates(one.run.id, { limit: 500 }).every((c) => c.depth <= 1));
    const two = await runExpansion(deps(), { seeds: [SEED], limits: { maxDepth: 2, maxSearchCalls: 100, maxFetches: 100 } });
    const depths = repos.expansion.candidates(two.run.id, { limit: 500 }).map((c) => c.depth);
    assert.ok(depths.every((d) => d <= 2), `profondeurs : ${[...new Set(depths)].join(',')}`);
    assert.ok((two.run.progress as { processed: string[] }).processed.length > 1, 'des enfants ont été explorés');
    const three = await runExpansion(deps(), { seeds: [SEED], limits: { maxDepth: 5 } });
    assert.equal((three.run.limits as { maxDepth: number }).maxDepth, 2, 'jamais au-delà de 2, même demandé');
  });
});

describe('6. le plafond de candidats', () => {
  test('maxCandidates=4 : quatre entreprises au plus, et le tour le dit', async () => {
    const { run, report } = await runExpansion(deps(), { seeds: [SEED], limits: { maxDepth: 1, maxCandidates: 4 } });
    assert.ok(report.stats.funnel.universe <= 4, `${report.stats.funnel.universe} candidats`);
    assert.ok(report.stats.stoppedBy.includes('MAX_CANDIDATES'));
    assert.ok(['DONE', 'CAPPED'].includes(run.status));
  });
});

describe('7. le plafond de requêtes', () => {
  test('maxSearchCalls=2 : deux appels au moteur, pas un de plus ; les pages officielles sont quand même lues', async () => {
    const queries: string[] = [];
    const { run, report } = await runExpansion(deps({ search: fixtureSearch(queries) }), { seeds: [SEED], limits: { maxDepth: 1, maxSearchCalls: 2 } });
    assert.equal(queries.length, 2);
    assert.equal(run.searchCalls, 2);
    assert.ok(report.stats.stoppedBy.includes('MAX_SEARCH_CALLS'));
    assert.ok(repos.expansion.relationshipsForRun(run.id).some((r) => r.relationshipType === 'DISTRIBUTOR' && r.sourceTrust === 'OFFICIAL'), 'la page distributeurs a été lue sans requête');
  });
});

describe('8. le budget IA', () => {
  const fakeProvider = (calls: LlmRequest[]): LlmProvider => ({
    kind: 'simulation',
    async complete(request) {
      calls.push(request);
      const isProfile = request.meta?.taskRef === 'expansion-profile';
      const text = isProfile
        ? JSON.stringify({ activity: 'machines d’emballage', sector: 'emballage', search_terms: ['emballage', 'conditionnement'], country: 'France' })
        : JSON.stringify({ candidates: [] });
      return { content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { inputTokens: 2000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: 'claude-haiku-4-5-20251001', refusal: null };
    },
  });

  test('maxAiCostUsd minuscule : aucun appel ; plafond raisonnable : des appels, et le coût réel est compté', async () => {
    const none: LlmRequest[] = [];
    const capped = await runExpansion(deps({ provider: fakeProvider(none) }), { seeds: [SEED], limits: { maxDepth: 1, maxAiCostUsd: 0.0001 } });
    assert.equal(none.length, 0, 'sous un plafond nul, le modèle n’est jamais appelé');
    assert.ok(capped.report.stats.stoppedBy.includes('MAX_AI_COST'));
    assert.ok(capped.report.stats.funnel.universe > 0, 'le chemin déterministe continue sans le modèle');

    const some: LlmRequest[] = [];
    const ok = await runExpansion(deps({ provider: fakeProvider(some) }), { seeds: [SEED], limits: { maxDepth: 1, maxAiCostUsd: 0.05 } });
    assert.ok(some.length >= 1);
    assert.ok(ok.run.aiCostUsd > 0 && ok.run.aiCostUsd <= 0.05, `coût IA ${ok.run.aiCostUsd}`);
    assert.ok(some.every((r) => r.meta?.purpose === 'prospect-expansion'));
    assert.ok(some.every((r) => !JSON.stringify(r).includes('sk-')), 'aucune clé dans un prompt');
  });

  test('le budget IA commercial du jour, épuisé, coupe le modèle avant le plafond du tour', async () => {
    const cfg: AtlasConfig = { ...config, sales: { ...config.sales, dailyAiBudgetUsd: 0.01 } };
    repos.llmCalls.record({ missionId: null, taskRef: null, agentKey: null, purpose: 'test', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02, durationMs: 1, ok: true, error: null, toolCalls: 0, subject: null, contextChars: null, evidenceCount: null, createdAt: new Date().toISOString() });
    const calls: LlmRequest[] = [];
    const { report } = await runExpansion(deps({ config: cfg, provider: fakeProvider(calls) }), { seeds: [SEED], limits: { maxDepth: 1, maxAiCostUsd: 0.5 } });
    assert.equal(calls.length, 0);
    assert.ok(report.stats.stoppedBy.includes('DAILY_AI_BUDGET'));
  });
});

// ─── 9–11. Les preuves ──────────────────────────────────────────────────────

describe('9. le bruit est filtré', () => {
  test('annuaires, réseaux sociaux, articles, listes « top 10 », agences hors profil : jamais des candidats', async () => {
    const { run } = await runExpansion(deps(), { seeds: [SEED], limits: { maxDepth: 1 } });
    const domains = repos.expansion.candidates(run.id, { limit: 500 }).map((c) => c.canonicalDomain);
    for (const junk of ['linkedin.com', 'facebook.com', 'societe.com', 'pappers.fr', 'lesechos.fr', 'top10-emballage.fr', 'fiches-pro.example', 'acme-machines.boutique-platform.example', 'agence-web-lyon.fr']) {
      assert.ok(!domains.includes(junk), `${junk} ne doit pas être un candidat`);
    }
    assert.ok(!repos.expansion.relationshipsForRun(run.id).some((r) => r.targetKey === 'fiches-pro.example'), 'une fiche d’annuaire sur la graine n’est pas une relation');
    assert.ok(isJunkDomain('kompass.com') && isJunkDomain('fr.wikipedia.org') && isJunkDomain('impots.gouv.fr') && !isJunkDomain('distri-nord.fr'));
    const agency = repos.expansion.candidates(run.id, { limit: 500 }).find((c) => c.canonicalDomain === 'agence-marketing-pack.fr');
    assert.ok(!agency || agency.stage === 'REJECTED', 'une agence de communication est hors profil : rejetée, jamais qualifiée');
  });
});

describe('10. une preuve officielle l’emporte sur une preuve secondaire', () => {
  test('même relation, même confiance : le candidat prouvé par une page officielle est mieux noté', () => {
    const icp = { countries: ['France'], keywords: [], exclusions: [] };
    const rel = (url: string, trust: 'OFFICIAL' | 'SECONDARY') => ({
      id: 'r', runId: 'x', sourceKey: 'acme-machines.fr', sourceName: 'Acme', sourceKind: 'COMPANY' as const, targetKey: 'a.fr', targetName: 'A', relationshipType: 'DISTRIBUTOR',
      confidence: 0.8, status: 'VERIFIED' as const, evidenceUrl: url, evidenceSummary: 's', sourceMethod: 'PARTNER', sourceTrust: trust, country: 'France', sourceDate: null, discoveredAt: EPOCH,
    });
    const ev = (url: string, trust: 'OFFICIAL' | 'SECONDARY') => ({ id: 'e', runId: 'x', entityKey: 'a.fr', kind: 'RELATIONSHIP' as const, claim: 'c', url, excerpt: null, trust, method: 'PARTNER', confidence: 0.8, collectedAt: EPOCH });
    const base = { name: 'Fabricant A', domain: 'a.fr', country: 'France', countryProven: true, depth: 1, snippet: 'fabricant de machines industrielles', aiRelevant: null, icp };
    const official = scoreCandidate({ ...base, relationships: [rel('https://acme-machines.fr/distributeurs', 'OFFICIAL')], evidence: [ev('https://acme-machines.fr/distributeurs', 'OFFICIAL')] });
    const secondary = scoreCandidate({ ...base, relationships: [rel('https://blog.example.com/post', 'SECONDARY')], evidence: [ev('https://blog.example.com/post', 'SECONDARY')] });
    assert.ok(official.score > secondary.score + 10, `${official.score} vs ${secondary.score}`);
    assert.equal(official.stage, 'HIGH_PRIORITY');
    assert.notEqual(secondary.stage, 'HIGH_PRIORITY');
    assert.equal(trustOf('https://acme-machines.fr/distributeurs', { name: 'Acme', domain: 'acme-machines.fr', website: null, country: null }, { name: 'A', domain: 'a.fr', website: null, country: null }), 'OFFICIAL');
    assert.equal(trustOf('https://a.fr/partenaires', { name: 'Acme', domain: 'acme-machines.fr', website: null, country: null }, { name: 'A', domain: 'a.fr', website: null, country: null }), 'OFFICIAL');
    assert.equal(trustOf('https://blog.example.com/x', { name: 'Acme', domain: 'acme-machines.fr', website: null, country: null }, { name: 'A', domain: 'a.fr', website: null, country: null }), 'SECONDARY');
    assert.equal(trustOf('https://salon.fr/exposants', { name: 'Salon', domain: 'salon.fr', website: null, country: null, kind: 'EVENT' }, { name: 'A', domain: 'a.fr', website: null, country: null }), 'ASSOCIATION_EVENT');
  });
});

describe('11. sans preuve, jamais HIGH_PRIORITY', () => {
  test('un score élevé sans preuve forte, ou sans relation assez sûre, reste QUALIFIED au mieux — et dit pourquoi', () => {
    const icp = { countries: ['France'], keywords: ['emballage'], exclusions: [] };
    const rel = (confidence: number, trust: 'OFFICIAL' | 'SECONDARY') => ({
      id: 'r', runId: 'x', sourceKey: 's', sourceName: 'S', sourceKind: 'COMPANY' as const, targetKey: 'a.fr', targetName: 'A', relationshipType: 'DISTRIBUTOR',
      confidence, status: 'INFERRED' as const, evidenceUrl: 'https://x.fr/p', evidenceSummary: 's', sourceMethod: 'PARTNER', sourceTrust: trust, country: 'France', sourceDate: null, discoveredAt: EPOCH,
    });
    const base = { name: 'Emballage A', domain: 'a.fr', country: 'France', countryProven: true, depth: 1, snippet: 'fabricant emballage industriel machine', aiRelevant: true, icp };
    const noEvidence = scoreCandidate({ ...base, relationships: [rel(0.9, 'OFFICIAL')], evidence: [] });
    assert.notEqual(noEvidence.stage, 'HIGH_PRIORITY');
    assert.match(noEvidence.rejectReason ?? '', /aucune preuve forte/);
    const weakRelation = scoreCandidate({ ...base, relationships: [rel(0.4, 'OFFICIAL')], evidence: [{ id: 'e', runId: 'x', entityKey: 'a.fr', kind: 'RELATIONSHIP', claim: 'c', url: 'https://x.fr/p', excerpt: null, trust: 'OFFICIAL', method: 'PARTNER', confidence: 0.4, collectedAt: EPOCH }] });
    assert.notEqual(weakRelation.stage, 'HIGH_PRIORITY');
    const noRelation = scoreCandidate({ ...base, relationships: [], evidence: [] });
    assert.equal(noRelation.stage, 'UNIVERSE');
    assert.throws(() => repos.expansion.addRelationship({ runId: null, sourceKey: 's', sourceName: 'S', sourceKind: 'COMPANY', targetKey: 't', targetName: 'T', relationshipType: 'OTHER', confidence: 1, status: 'VERIFIED', evidenceUrl: '   ', evidenceSummary: 'x', sourceMethod: 'PARTNER', sourceTrust: 'OFFICIAL', country: null, sourceDate: null }), /sans URL de preuve/);
  });
});

// ─── 12–15. La persistance ──────────────────────────────────────────────────

describe('12 + 14. les relations persistent, sans doublon', () => {
  test('chaque champ est relu tel quel ; la même (source, cible, type, preuve) n’est écrite qu’une fois ; une seconde preuve est une seconde ligne', () => {
    const input = {
      runId: 'run', sourceKey: 'acme-machines.fr', sourceName: 'Acme Machines', sourceKind: 'COMPANY' as const, targetKey: 'distri-nord.fr', targetName: 'Distri Nord',
      relationshipType: 'DISTRIBUTOR', confidence: 0.8, status: 'VERIFIED' as const, evidenceUrl: 'https://acme-machines.fr/distributeurs', evidenceSummary: 'page distributeurs',
      sourceMethod: 'PARTNER', sourceTrust: 'OFFICIAL' as const, country: 'France', sourceDate: '2026-09-01', discoveredAt: '2026-09-21T10:00:00.000Z',
    };
    const first = repos.expansion.addRelationship(input);
    assert.equal(first.created, true);
    const again = repos.expansion.addRelationship({ ...input, confidence: 0.5 });
    assert.equal(again.created, false);
    assert.equal(again.relationship.confidence, 0.8, 'une confiance moindre n’écrase pas');
    const better = repos.expansion.addRelationship({ ...input, confidence: 0.9 });
    assert.equal(better.created, false);
    assert.equal(repos.expansion.relationship(first.relationship.id)!.confidence, 0.9, 'une confiance meilleure s’écrit');
    const second = repos.expansion.addRelationship({ ...input, evidenceUrl: 'https://salon.fr/exposants', sourceTrust: 'ASSOCIATION_EVENT' });
    assert.equal(second.created, true);
    assert.equal(repos.expansion.relationshipsTo('distri-nord.fr').length, 2);
    const stored = repos.expansion.relationship(first.relationship.id)!;
    assert.deepEqual({ ...stored, confidence: 0.8, id: 'x' }, { ...input, confidence: 0.8, id: 'x' });
  });
});

describe('13. reprise après redémarrage', () => {
  test('un tour laissé RUNNING est repris là où il en était, sur la même base, sans refaire ni dupliquer', async () => {
    // Un tour qui meurt avant d'avoir fini : on simule en plafonnant la durée à zéro (rien n'est traité, la file reste entière)… puis en rouvrant.
    const first = await runExpansion(deps(), { seeds: [SEED], limits: { maxDepth: 2, maxWallMs: 0, maxSearchCalls: 100, maxFetches: 100 } });
    assert.equal(first.run.status, 'CAPPED', 'arrêté par la durée : la file n’est pas vide');
    assert.ok(((first.run.progress as { queue: unknown[] }).queue).length >= 1, 'la file survit à l’arrêt');
    // Le processus meurt : on remet le tour en RUNNING tel qu'un arrêt brutal l'aurait laissé.
    repos.db.prepare("UPDATE prospect_expansion_runs SET status = 'RUNNING', finished_at = NULL WHERE id = ?").run(first.run.id);
    const relsBefore = repos.expansion.relationshipsForRun(first.run.id).length;
    const file = join(dir, 'atlas.db');
    repos.close();
    repos = createRepositories(file, logger);
    assert.equal(repos.expansion.openRuns().length, 1);
    // La reprise relève la durée : c'est le seul plafond que l'arrêt a consommé.
    const resumed = await resumeOpenExpansions(deps(), { limits: { maxWallMs: 60_000 } });
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0]!.id, first.run.id, 'le même tour, pas un nouveau');
    assert.ok(['DONE', 'CAPPED'].includes(resumed[0]!.status));
    assert.equal(repos.expansion.runs(10).length, 1, 'aucun tour supplémentaire');
    const processed = (resumed[0]!.progress as { processed: string[] }).processed;
    assert.ok(processed.length >= 1 && new Set(processed).size === processed.length, `chaque graine traitée une fois : ${processed.join(', ')}`);
    assert.ok(repos.expansion.relationshipsForRun(first.run.id).length >= relsBefore);
    const keys = repos.expansion.candidates(first.run.id, { limit: 500 }).map((c) => c.entityKey);
    assert.equal(new Set(keys).size, keys.length, 'aucun candidat dupliqué par la reprise');
    assertNothingSent();
  });
});

describe('15. rejouer est idempotent là où cela doit l’être', () => {
  test('un tour terminé rejoué par son id ne fait rien ; les mêmes graines rejouées ne dupliquent ni relations ni preuves', async () => {
    const first = await runExpansion(deps(), { seeds: [SEED], limits: { maxDepth: 1 } });
    const again = await runExpansion(deps(), { seeds: [SEED], resumeRunId: first.run.id });
    assert.equal(again.run.id, first.run.id);
    assert.equal(again.run.updatedAt, first.run.updatedAt, 'rien n’a été réécrit');
    const totalRelsBefore = repos.db.prepare('SELECT COUNT(*) AS n FROM prospect_relationships').get() as { n: number };
    const totalEvBefore = repos.db.prepare('SELECT COUNT(*) AS n FROM prospect_evidence').get() as { n: number };
    const second = await runExpansion(deps(), { seeds: [SEED], limits: { maxDepth: 1 } });
    assert.notEqual(second.run.id, first.run.id, 'un nouveau tour daté — l’histoire se relit');
    const totalRelsAfter = repos.db.prepare('SELECT COUNT(*) AS n FROM prospect_relationships').get() as { n: number };
    const totalEvAfter = repos.db.prepare('SELECT COUNT(*) AS n FROM prospect_evidence').get() as { n: number };
    assert.equal(totalRelsAfter.n, totalRelsBefore.n, 'la même preuve ne compte pas deux fois, même dans un second tour');
    assert.equal(totalEvAfter.n, totalEvBefore.n);
    assert.equal(second.report.stats.newCompanies, first.report.stats.newCompanies);
  });
});

// ─── 16–19. L'Autopilot ─────────────────────────────────────────────────────

const READY: AutopilotObservation['providers'] = {
  DETERMINISTIC: { ready: true, detail: 't' }, OPENAI: { ready: true, detail: 't' }, CLAUDE: { ready: true, detail: 't' },
  CLAUDE_CODE: { ready: true, detail: 't' }, DETERMINISTIC_EXTERNAL: { ready: true, detail: 't' }, SEARCH: { ready: true, detail: 't' },
};

function seedStrongProspects() {
  for (const [name, domain, tier, score] of [['Acme Machines', 'acme-machines.fr', 'PRIORITY', 80], ['Emballage Sud', 'emballage-sud.fr', 'GOOD_FIT', 70]] as const) {
    const { prospect } = repos.sales.discover({ batchId: 'B1', companyName: name, domain, country: 'France', discoveredAt: '2026-09-20T10:00:00.000Z' });
    repos.sales.setScore(prospect.id, { score, tier, detail: {}, whyFit: 'test' } as never);
    repos.sales.setState(prospect.id, 'QUALIFIED');
  }
}

describe('16. l’Autopilot reçoit les occasions d’expansion', () => {
  test('des prospects forts jamais explorés → une proposition sûre, chiffrée, avec ses preuves et sa suite', async () => {
    seedStrongProspects();
    const cfg: AtlasConfig = { ...config, sales: { ...config.sales, discoveryEnabled: true } };
    const report = await runAutopilotCycle(repos, cfg, logger, { trigger: 'test', observe: { providers: READY, probeClaudeCode: false, cwd: dir }, sources: [prospectExpansionSource] });
    const created = report.created.find((a) => /Étendre l'univers commercial/.test(a.objective));
    assert.ok(created, JSON.stringify(report.decisions));
    const proposal = created!.proposal as unknown as AutopilotProposal;
    assert.equal(proposal.category, 'DISCOVERY');
    assert.equal(proposal.execution.kind, 'INTERNAL_TASK');
    assert.equal((proposal.execution as { taskType: string }).taskType, EXPANSION_TASK_TYPE);
    assert.ok(proposal.expectedCostUsd > 0 && proposal.expectedCostUsd < 0.2);
    assert.ok(proposal.evidence.some((e) => /acme-machines\.fr/.test(e)));
    assert.equal(proposal.requiresHumanApproval, false);
    assert.equal(proposal.source, 'prospect-expansion');
    assert.ok(SAFE_AUTONOMOUS_TASK_TYPES.includes(EXPANSION_TASK_TYPE));
    assert.equal(routeTask(EXPANSION_TASK_TYPE).target, 'DETERMINISTIC', 'servie par le daemon du serveur : bibliothèque, pas script');
    assertNothingSent();
  });

  test('sans prospect fort, ni découverte activée : rien n’est proposé', () => {
    const ctx = { repos, config: { ...config, sales: { ...config.sales, discoveryEnabled: false } }, now: new Date(), observation: {} as AutopilotObservation };
    assert.deepEqual(prospectExpansionSource.propose(ctx), []);
    seedStrongProspects();
    const on = { ...ctx, config: { ...config, sales: { ...config.sales, discoveryEnabled: true } }, observation: { spend: { salesRemainingUsd: 0.5 } } as unknown as AutopilotObservation };
    assert.equal(prospectExpansionSource.propose(on).length, 1);
  });
});

describe('17. l’Autopilot lance l’expansion seul, et la suite verse dans la file', () => {
  test('la tâche est confiée au worker déterministe, tourne sous ses plafonds, et la suite est proposée à la fin', async () => {
    seedStrongProspects();
    const cfg: AtlasConfig = { ...config, sales: { ...config.sales, discoveryEnabled: true } };
    const first = await runAutopilotCycle(repos, cfg, logger, { trigger: 'test', observe: { providers: READY, probeClaudeCode: false, cwd: dir }, sources: [prospectExpansionSource] });
    const executed = first.executed.find((e) => e.taskType === EXPANSION_TASK_TYPE);
    assert.ok(executed, 'confiée sans personne');
    assert.equal(executed!.agent, 'DETERMINISTIC');
    const task = repos.tasks.byId(executed!.taskId)!;
    assert.equal(task.status, 'QUEUED');

    // Le daemon, en deux lignes : prendre la tâche, la servir avec le handler réel (moteur et pages fixtures).
    const handlers = createExpansionHandlers(deps());
    const claimed = repos.tasks.claim({ owner: 'daemon-test', leaseMs: 60_000, workerTypes: ['DETERMINISTIC'] });
    assert.equal(claimed.task?.taskId, task.taskId);
    const outcome = await handlers[EXPANSION_TASK_TYPE]!(claimed.task!, { logger, heartbeat: () => true, shuttingDown: () => false, correlationId: null });
    assert.equal(outcome.kind, 'DONE');
    const result = outcome.result as { runId: string; funnel: { universe: number; highPriority: number }; messagesSent: number };
    assert.ok(result.funnel.universe > 0);
    assert.equal(result.messagesSent, 0);
    repos.tasks.complete(task.taskId, outcome.result ?? {}, 'daemon-test', outcome.costUsd ?? null);

    const second = await runAutopilotCycle(repos, cfg, logger, { now: new Date(Date.now() + 60_000), trigger: 'test', observe: { providers: READY, probeClaudeCode: false, cwd: dir }, sources: [prospectExpansionSource] });
    assert.equal(repos.autopilot.action(executed!.actionId)!.status, 'DONE');
    const promote = second.created.find((a) => /Verser/.test(a.objective));
    assert.ok(promote, 'la suite : verser les candidats qualifiés');
    const promoted = second.executed.find((e) => e.actionId === promote!.id);
    assert.ok(promoted, 'confiée seule aussi : ce ne sont que des prospects DISCOVERED');
    const c2 = repos.tasks.claim({ owner: 'daemon-test', leaseMs: 60_000, workerTypes: ['DETERMINISTIC'] });
    const o2 = await handlers[EXPANSION_TASK_TYPE]!(c2.task!, { logger, heartbeat: () => true, shuttingDown: () => false, correlationId: null });
    assert.equal(o2.kind, 'DONE');
    assert.ok((o2.result as { promoted: number }).promoted >= 1);
    const discovered = repos.sales.discoveredSince(null).filter((p) => p.batchId.startsWith('xpn_'));
    assert.ok(discovered.length >= 1);
    assert.ok(discovered.every((p) => p.state === 'DISCOVERED'), 'DISCOVERED, jamais approuvé, jamais contacté');
    assert.ok(repos.sales.evidenceFor(discovered[0]!.id).length >= 1, 'avec ses preuves');
    assertNothingSent();
  });
});

describe('18 + 19. l’envoi reste humain ; aucun SALES_SEND', () => {
  test('une occasion d’envoi proposée à côté de l’expansion reste WAITING_HUMAN ; l’expansion n’a jamais posé d’envoi', async () => {
    seedStrongProspects();
    const cfg: AtlasConfig = { ...config, sales: { ...config.sales, discoveryEnabled: true } };
    const outbound: OpportunitySource = {
      name: 'test-outbound',
      propose: () => [{
        objective: 'envoyer la première campagne', category: 'REVENUE', expectedBusinessValue: 'DIRECT_REVENUE', expectedCostUsd: 0, expectedFounderTimeMinutes: 5,
        confidence: 0.9, urgency: 'HIGH', evidence: ['test'], risk: 'HIGH', reversibility: 'IRREVERSIBLE', recommendedAgent: 'HUMAN', requiresHumanApproval: true,
        reason: 'test', gate: 'EXTERNAL_OUTBOUND', execution: { kind: 'FOUNDER_DECISION', command: 'npm run sales:loop -- send' },
      }],
    };
    const report = await runAutopilotCycle(repos, cfg, logger, { trigger: 'test', observe: { providers: READY, probeClaudeCode: false, cwd: dir }, sources: [prospectExpansionSource, outbound] });
    const send = report.created.find((a) => /campagne/.test(a.objective))!;
    assert.equal(send.status, 'WAITING_HUMAN');
    const expansion = report.created.find((a) => /Étendre/.test(a.objective))!;
    assert.equal(expansion.status, 'QUEUED');
    assert.equal(decideAutonomy({ ...(expansion.proposal as unknown as AutopilotProposal), gate: 'OUTBOUND_ACTIVATION' }, { observation: report.observation, config: cfg, cycleSpentUsd: 0 }).verdict, 'WAITING_HUMAN');
    await runExpansion(deps(), { seeds: [SEED], limits: { maxDepth: 1 } });
    assertNothingSent();
    assert.equal(config.sales.outboundEnabled, false);
    assert.equal(config.sales.engineMode, 'INTERNAL_TEST');
  });
});

// ─── 20–21. Réutilisation client, exclusions ────────────────────────────────

describe('20. le Client Engine réutilise les primitives', () => {
  test('une mission client étend avec son propre profil (Suède), sans rien verser dans notre file commerciale', async () => {
    const swedishWorld: Record<string, string> = {
      'https://nordpack.se/': page('Nordpack – förpackningsmaskiner', `<nav>${a('/aterforsaljare', 'Återförsäljare')}</nav><p>Nordpack AB, Göteborg, Sverige. Org.nr 556123-4567.</p>`),
      'https://nordpack.se/aterforsaljare': page('Återförsäljare – Nordpack', `<ul>${a('https://packdistribution.se/', 'Pack Distribution AB')} ${a('https://emballage-sud.fr/', 'Emballage Sud')}</ul>`),
      'https://packdistribution.se/': page('Pack Distribution AB – förpackningsmaskiner', '<p>Pack Distribution AB, Stockholm, Sverige.</p>'),
    };
    const fetchSv = async (url: string) => swedishWorld[url] ?? swedishWorld[`${url}/`] ?? null;
    const { run, report } = await runExpansion(deps({ fetchHtml: fetchSv, search: null }), {
      seeds: [{ name: 'Nordpack', domain: 'nordpack.se', website: 'https://nordpack.se', country: 'Suède' }],
      purpose: 'CLIENT', missionId: 'msn_test', icp: { countries: ['Suède'], keywords: ['förpackning', 'packaging'], exclusions: [] }, limits: { maxDepth: 1 },
    });
    assert.equal(run.purpose, 'CLIENT');
    assert.equal(run.missionId, 'msn_test');
    const sv = repos.expansion.candidate(run.id, 'packdistribution.se')!;
    assert.ok(sv, 'le distributeur suédois est trouvé');
    assert.ok(['QUALIFIED', 'HIGH_PRIORITY', 'RELEVANT'].includes(sv.stage), sv.stage);
    const fr = repos.expansion.candidate(run.id, 'emballage-sud.fr')!;
    assert.ok(fr.stage !== 'QUALIFIED' && fr.stage !== 'HIGH_PRIORITY', 'un français n’est pas qualifié pour un profil suédois');
    assert.equal(report.stats.relationships >= 2, true);
    const promoted = promoteCandidates(repos, run.id);
    assert.equal(promoted.promoted.length, 0, 'une mission client ne verse rien dans notre file commerciale');
    assert.equal(repos.sales.discoveredSince(null).length, 0);
  });
});

describe('21. les entités techniques (self-test) restent exclues', () => {
  test('une graine ou un candidat sur selftest.atlas.invalid n’entre jamais dans l’univers', async () => {
    const { prospect } = repos.sales.discover({ batchId: 'B1', companyName: 'Self Test', domain: 'selftest.atlas.invalid', country: 'France', discoveredAt: '2026-09-20T10:00:00.000Z' });
    repos.sales.setScore(prospect.id, { score: 99, tier: 'PRIORITY', detail: {}, whyFit: 'self-test' } as never);
    repos.sales.setState(prospect.id, 'QUALIFIED');
    assert.equal(strongestSeeds(repos).length, 0);
    await assert.rejects(runExpansion(deps(), { seeds: [{ name: 'Self Test', domain: 'selftest.atlas.invalid', website: null, country: null }] }), /aucune graine exploitable/);
    const world: Record<string, string> = { ...WORLD, 'https://acme-machines.fr/partenaires': page('Partenaires', `<ul>${a('https://mail.selftest.atlas.invalid/', 'Self Test Mail')} ${a('https://integra-pack.fr/', 'Integra Pack')}</ul>`) };
    const { run } = await runExpansion(deps({ fetchHtml: async (u) => world[u] ?? world[`${u}/`] ?? null }), { seeds: [SEED], limits: { maxDepth: 1 } });
    assert.ok(!repos.expansion.candidates(run.id, { limit: 500 }).some((c) => (c.canonicalDomain ?? '').includes('selftest.atlas.invalid')));
  });
});

describe('le rapport, le graphe, les chiffres', () => {
  test('l’entonnoir, les preuves par confiance, les coûts par candidat — et le voisinage d’une entreprise', async () => {
    const { run } = await runExpansion(deps(), { seeds: [SEED], limits: { maxDepth: 1 } });
    const report = expansionReport(repos, run.id);
    const f = report.stats.funnel;
    assert.ok(f.universe >= f.relevant && f.relevant >= f.qualified && f.qualified >= f.highPriority);
    assert.ok(report.stats.evidence.OFFICIAL > 0 && report.stats.evidence.ASSOCIATION_EVENT > 0);
    assert.ok(report.stats.evidence.OFFICIAL > report.stats.evidence.SECONDARY);
    assert.ok(report.stats.searchCostUsd > 0);
    assert.ok(report.stats.costPerQualifiedUsd !== null && report.stats.costPerQualifiedUsd > 0);
    assert.ok(report.stats.evidenceRate !== null && report.stats.evidenceRate > 0.8);
    assert.ok(report.topCandidates.length > 0 && report.topCandidates[0]!.score !== null);
    const graph = expansionGraph(repos, 'distri-nord.fr');
    assert.ok(graph.entity);
    assert.ok(graph.relationships.every((r) => r.direction === 'IN' && r.evidenceUrl));
    assert.ok(graph.relationships.length >= 4);
    assert.ok(graph.evidence.some((e) => e.kind === 'COUNTRY'));
    assert.equal(DEFAULT_EXPANSION_LIMITS.maxDepth, 2);
  });
});
