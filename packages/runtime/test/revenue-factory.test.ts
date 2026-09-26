import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../core/src/logger.ts';
import type { AtlasConfig } from '../../core/src/index.ts';
import { createRepositories, MIGRATIONS, type Repositories } from '../../data/src/index.ts';
import { makeTestConfig } from '../../testing/src/index.ts';
import {
  runRevenueFactory, factoryQueue, duplicateOf, deterministicAssessments, createRevenueFactoryHandlers,
  REVENUE_FACTORY_TASK, DEFAULT_FACTORY_LIMITS,
} from '../src/revenue-factory.ts';
import { scheduleSalesCycle, SALES_ENGINE_TASKS } from '../src/sales-engine.ts';
import { EXPANSION_TASK_TYPE } from '../src/expansion/engine.ts';
import { routeTask } from '../src/hermes-router.ts';
import { site, fixtureFetch, discovered, partners } from './helpers/factory-fixtures.ts';

/**
 * La fabrique de revenu — boucle A.
 *
 * Chaque test tient une propriété qu'un opérateur lira sur l'écran ou que la
 * boucle B consommera : un état explicite par entreprise, une coordonnée lue
 * et jamais devinée, des recommandations tirées du graphe du prospect, un
 * doublon qui ne passe pas deux fois, une panne qui n'arrête pas le tour.
 */

const logger = createLogger({ level: 'error', pretty: false });
const NOW = new Date('2026-09-26T10:00:00.000Z');
let dir: string;
let repos: Repositories;
let config: AtlasConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-factory-'));
  repos = createRepositories(join(dir, 'f.db'), logger);
  config = makeTestConfig(dir);
});
afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = (fetch: ReturnType<typeof fixtureFetch>, limits = {}) =>
  runRevenueFactory({ repos, config, logger, fetchPages: fetch, now: () => NOW }, { limits });

const TWO_PARTNERS = [{ domain: 'bridor.fr', name: 'Bridor' }, { domain: 'panamar.es', name: 'Panamar' }];

describe('du prospect découvert au SEND_ELIGIBLE', () => {
  test('site complet et deux partenaires : HOT, éligible, et chaque élément garde sa provenance', async () => {
    discovered(repos, 'merand.fr', 'Mérand');
    partners(repos, 'merand.fr', TWO_PARTNERS);
    const report = await run(fixtureFetch([site('merand.fr', 'Mérand')]));

    assert.equal(report.processed, 1);
    const v = repos.revenueFactory.verdict('merand.fr')!;
    assert.equal(v.classification, 'HOT');
    assert.equal(v.sendEligible, true, JSON.stringify(v.blockers));
    // Sans graine attribuée, aucune campagne n'est devinée : l'action le dit.
    assert.equal(v.nextAction, 'boucle B — premier contact (campagne à rattacher et approuver)');
    assert.equal(repos.salesEngine.attributionFor('merand.fr'), null);
    // Contact : lu sur la page de contact officielle.
    assert.deepEqual(v.contactRoutes.find((r) => r.kind === 'EMAIL'), {
      kind: 'EMAIL', value: 'commercial@merand.fr', sourceUrl: 'https://merand.fr/contact', observed: true,
    });
    // Preuves : au moins deux, chacune avec l'adresse de la page où elle se lit.
    assert.ok(v.evidence.length >= 2);
    for (const e of v.evidence) assert.match(e.sourceUrl, /^https:\/\/merand\.fr\//);
    // Recommandations : du graphe du prospect, avec citation, source et confiance.
    assert.deepEqual(v.recommendations.map((r) => r.domain).sort(), ['bridor.fr', 'panamar.es']);
    for (const r of v.recommendations) {
      assert.match(r.sourceUrl, /^https:\/\//);
      assert.ok(r.evidenceQuote.length > 10);
      assert.equal(typeof r.confidence, 'number');
    }
    // Le prospect est qualifié pour la boucle B, avec un score expliqué.
    const p = repos.sales.discoveredSince(null)[0]!;
    assert.equal(p.state, 'QUALIFIED');
    assert.equal((p.scoreDetail as { method?: string }).method, 'factory-deterministic');
    assert.deepEqual(repos.sales.firstTouchReadiness(p.id), { ready: true, blockers: [] });
  });

  test('une citation n’est rangée « verbatim » que si elle se relit telle quelle dans la page', async () => {
    discovered(repos, 'merand.fr', 'Mérand');
    await run(fixtureFetch([site('merand.fr', 'Mérand')]));
    const p = repos.sales.discoveredSince(null)[0]!;
    const home = site('merand.fr', 'Mérand').get('https://merand.fr/')!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    for (const e of repos.sales.evidenceFor(p.id).filter((x) => x.field.startsWith('verbatim:'))) {
      assert.ok(home.includes(e.claim.replace(/\s+/g, ' ').trim()), e.claim);
    }
  });
});

describe('qualification rapide et rejet précoce', () => {
  test('un prospect déjà rejeté par la qualification : DROP, sans lire une seule page', async () => {
    const p = discovered(repos, 'hors-cible.fr', 'Hors Cible');
    repos.sales.setScore(p.id, { score: 20, tier: 'REJECTED', detail: {}, whyFit: 'agence de communication' });
    repos.sales.setState(p.id, 'REJECTED', { rejectReason: 'hors ICP' });
    const counter = { pages: 0, calls: 0 };
    await run(fixtureFetch([site('hors-cible.fr', 'Hors Cible')], { counter }));
    assert.equal(repos.revenueFactory.verdict('hors-cible.fr')!.classification, 'DROP');
    assert.equal(counter.calls, 0, 'aucune lecture pour un prospect déjà écarté');
  });

  test('trop peu de signal : NEEDS_ENRICHMENT, puis DROP après le plafond de passages — jamais un score inventé', async () => {
    discovered(repos, 'muet.fr', 'Muet');
    const fetch = fixtureFetch([site('muet.fr', 'Muet', 'NO_SIGNAL')]);
    await run(fetch);
    let v = repos.revenueFactory.verdict('muet.fr')!;
    assert.equal(v.classification, 'NEEDS_ENRICHMENT');
    assert.ok(v.blockers.includes('INSUFFICIENT_SIGNAL'));
    assert.equal(repos.sales.discoveredSince(null)[0]!.score, null, 'aucun score posé sans signal');
    for (let i = 1; i < DEFAULT_FACTORY_LIMITS.maxAttempts; i++) {
      await runRevenueFactory({ repos, config, logger, fetchPages: fetch, now: () => new Date(NOW.getTime() + i * 7 * 3_600_000) });
    }
    v = repos.revenueFactory.verdict('muet.fr')!;
    assert.equal(v.classification, 'DROP');
    assert.equal(v.attempts, DEFAULT_FACTORY_LIMITS.maxAttempts);
  });

  test('une qualification existante (lot) n’est jamais réécrite', async () => {
    const p = discovered(repos, 'qualifie.fr', 'Qualifié');
    repos.sales.setScore(p.id, { score: 81, tier: 'PRIORITY', detail: { method: 'llm' }, whyFit: 'fabricant qui recrute des revendeurs' });
    repos.sales.setState(p.id, 'QUALIFIED');
    await run(fixtureFetch([site('qualifie.fr', 'Qualifié')]));
    const after = repos.sales.get(p.id)!;
    assert.equal(after.score, 81);
    assert.equal(after.whyFit, 'fabricant qui recrute des revendeurs');
    assert.equal(repos.revenueFactory.verdict('qualifie.fr')!.scoreMethod, 'llm');
  });

  test('le score déterministe n’évalue que ce qui est observé', () => {
    assert.deepEqual(deterministicAssessments({ contactKind: null, commercialEmail: false, personName: null, personRole: null, factKinds: [], incomingCommercialRelationships: 0 }), []);
    const dims = deterministicAssessments({ contactKind: 'EMAIL', commercialEmail: true, personName: null, personRole: null, factKinds: ['DISTRIBUTION'], incomingCommercialRelationships: 0 }).map((a) => a.dimension);
    assert.deepEqual(dims.sort(), ['accessibility', 'expansionSignal', 'needFit']);
    assert.ok(!dims.includes('abilityToPay'), 'aucune capacité à payer affirmée sans preuve');
  });
});

describe('contact : lu, jamais déduit', () => {
  test('formulaire seul : route enregistrée, mais pas d’envoi — et aucune adresse fabriquée', async () => {
    discovered(repos, 'formulaire.fr', 'Formulaire');
    partners(repos, 'formulaire.fr', TWO_PARTNERS);
    await run(fixtureFetch([site('formulaire.fr', 'Formulaire', 'FORM_ONLY')]));
    const v = repos.revenueFactory.verdict('formulaire.fr')!;
    assert.equal(v.classification, 'NEEDS_ENRICHMENT');
    assert.equal(v.sendEligible, false);
    assert.ok(v.blockers.includes('NO_OBSERVED_EMAIL'));
    assert.ok(v.contactRoutes.some((r) => r.kind === 'FORM'));
    assert.equal(v.contactRoutes.some((r) => r.kind === 'EMAIL'), false);
    assert.equal(repos.sales.discoveredSince(null)[0]!.contactEmail, null, 'jamais contact@formulaire.fr par convention');
  });

  test('webmail ou boîte RGPD : pas une route commerciale', async () => {
    for (const [domain, kind] of [['webmail.fr', 'FREEMAIL'], ['rgpd.fr', 'PERSONAL_ONLY']] as const) {
      discovered(repos, domain, domain.split('.')[0]!);
      partners(repos, domain, TWO_PARTNERS);
    }
    await run(fixtureFetch([site('webmail.fr', 'Webmail', 'FREEMAIL'), site('rgpd.fr', 'Rgpd', 'PERSONAL_ONLY')]));
    for (const domain of ['webmail.fr', 'rgpd.fr']) {
      const v = repos.revenueFactory.verdict(domain)!;
      assert.equal(v.sendEligible, false, domain);
      assert.ok(v.blockers.some((b) => b === 'NO_OBSERVED_EMAIL' || b === 'EMAIL_NOT_COMMERCIAL'), `${domain}: ${v.blockers}`);
    }
  });
});

describe('recommandations', () => {
  test('une seule recommandation valide : NEEDS_ENRICHMENT, et une expansion ciblée posée — une seule fois', async () => {
    discovered(repos, 'solo.fr', 'Solo');
    partners(repos, 'solo.fr', [{ domain: 'alpha.fr', name: 'Alpha' }]);
    const fetch = fixtureFetch([site('solo.fr', 'Solo')]);
    const first = await run(fetch);
    const v = repos.revenueFactory.verdict('solo.fr')!;
    assert.equal(v.classification, 'NEEDS_ENRICHMENT');
    assert.ok(v.blockers.includes('RECOMMENDATIONS_BELOW_2'));
    assert.equal(v.recommendations.length, 0, 'aucune ou 2 à 3 : jamais une seule');
    assert.ok(first.expansionsEnqueued >= 1);
    const targeted = repos.tasks.list({ limit: 50 }).filter((t) => t.taskType === EXPANSION_TASK_TYPE && t.idempotencyKey?.startsWith('factory-expand:solo.fr'));
    assert.equal(targeted.length, 1);
    assert.deepEqual((targeted[0]!.payload as { seedProspectIds: string[] }).seedProspectIds, [repos.sales.discoveredSince(null)[0]!.id]);
    // Repasser dans la même période ne repose pas la même expansion.
    await runRevenueFactory({ repos, config, logger, fetchPages: fetch, now: () => new Date(NOW.getTime() + 7 * 3_600_000) });
    assert.equal(repos.tasks.list({ limit: 50 }).filter((t) => t.idempotencyKey?.startsWith('factory-expand:solo.fr')).length, 1);
  });

  test('concurrent, entreprise similaire, relation inférée, source secondaire et sous-domaine propre : exclus', async () => {
    discovered(repos, 'acme.fr', 'Acme');
    partners(repos, 'acme.fr', [
      { domain: 'rival.fr', name: 'Rival', type: 'COMPETITOR', confidence: 0.99 },
      { domain: 'pareil.fr', name: 'Pareil', type: 'SIMILAR_COMPANY', confidence: 0.99 },
      { domain: 'devine.fr', name: 'Deviné', status: 'INFERRED', confidence: 0.99 },
      { domain: 'annuaire.fr', name: 'Annuaire', trust: 'SECONDARY', confidence: 0.99 },
      { domain: 'shop.acme.fr', name: 'Acme Shop', confidence: 0.99 },
      ...TWO_PARTNERS,
    ]);
    await run(fixtureFetch([site('acme.fr', 'Acme')]));
    const v = repos.revenueFactory.verdict('acme.fr')!;
    assert.deepEqual(v.recommendations.map((r) => r.domain).sort(), ['bridor.fr', 'panamar.es']);
    assert.equal(v.sendEligible, true);
  });
});

describe('déduplication', () => {
  test('deux lignes du même domaine : un seul verdict, fusionné', async () => {
    discovered(repos, 'acme.fr', 'Acme', '2026-09-25T08:00:00.000Z');
    discovered(repos, 'www.acme.fr', 'Acme SAS', '2026-09-26T08:00:00.000Z');
    partners(repos, 'acme.fr', TWO_PARTNERS);
    await run(fixtureFetch([site('acme.fr', 'Acme')]));
    assert.equal(repos.revenueFactory.verdicts().length, 1);
    assert.equal(repos.revenueFactory.verdict('acme.fr')!.dedupeResult, 'MERGED:2');
  });

  test('un sous-domaine d’une entreprise connue : DUPLICATE, jamais éligible', async () => {
    discovered(repos, 'acme.fr', 'Acme');
    discovered(repos, 'boutique.acme.fr', 'Acme Boutique');
    await run(fixtureFetch([site('acme.fr', 'Acme'), site('boutique.acme.fr', 'Acme Boutique')]));
    const v = repos.revenueFactory.verdict('boutique.acme.fr')!;
    assert.equal(v.classification, 'DUPLICATE');
    assert.equal(v.dedupeResult, 'DUPLICATE_OF:acme.fr');
    assert.equal(v.sendEligible, false);
    assert.equal(duplicateOf('acme.de', new Set(['acme.fr'])), null, 'deux pays, deux filiales : pas un doublon');
  });
});

describe('les gardes terminales passent avant toute lecture', () => {
  test('déjà contacté, supprimé, ne pas contacter : BLOCKED, sans réseau', async () => {
    for (const d of ['contacte.fr', 'supprime.fr', 'dnc.fr']) { discovered(repos, d, d); partners(repos, d, TWO_PARTNERS); }
    repos.sales.recordOutreach({ domain: 'contacte.fr', kind: 'CONTACTED', recordedBy: 'test', channel: 'email' });
    repos.salesEngine.suppress({ kind: 'DOMAIN', value: 'supprime.fr', reason: 'OPT_OUT', createdBy: 'test' });
    repos.sales.recordOutreach({ domain: 'dnc.fr', kind: 'DO_NOT_CONTACT', recordedBy: 'test', channel: 'email' });
    const counter = { pages: 0, calls: 0 };
    await run(fixtureFetch([site('contacte.fr', 'C'), site('supprime.fr', 'S'), site('dnc.fr', 'D')], { counter }));
    assert.deepEqual(
      Object.fromEntries(['contacte.fr', 'supprime.fr', 'dnc.fr'].map((d) => [d, repos.revenueFactory.verdict(d)!.blockers[0]])),
      { 'contacte.fr': 'ALREADY_CONTACTED', 'supprime.fr': 'SUPPRESSED', 'dnc.fr': 'DO_NOT_CONTACT' },
    );
    for (const d of ['contacte.fr', 'supprime.fr', 'dnc.fr']) assert.equal(repos.revenueFactory.verdict(d)!.classification, 'BLOCKED');
    assert.equal(counter.calls, 0);
  });
});

describe('débit, pannes, reprise', () => {
  test('lots bornés : la file restante est comptée, le tour suivant la reprend', async () => {
    const sites = [];
    for (let i = 0; i < 30; i++) {
      const d = `pme${i}.fr`;
      discovered(repos, d, `PME ${i}`, new Date(NOW.getTime() - i * 60_000).toISOString());
      partners(repos, d, TWO_PARTNERS);
      sites.push(site(d, `PME ${i}`));
    }
    const fetch = fixtureFetch(sites);
    const first = await run(fetch);
    assert.equal(first.processed, DEFAULT_FACTORY_LIMITS.batchSize);
    assert.equal(first.queueRemaining, 30 - DEFAULT_FACTORY_LIMITS.batchSize);
    await run(fetch);
    await run(fetch);
    assert.equal(repos.revenueFactory.verdicts().length, 30, 'trois tours couvrent la file, sans doublon');
    assert.equal(factoryQueue(repos, NOW).length, 0);
  });

  test('un site injoignable ne bloque pas le tour ; une lecture qui lève non plus', async () => {
    discovered(repos, 'panne.fr', 'Panne');
    discovered(repos, 'exception.fr', 'Exception');
    discovered(repos, 'sain.fr', 'Sain');
    partners(repos, 'sain.fr', TWO_PARTNERS);
    const ok = fixtureFetch([site('sain.fr', 'Sain')]);
    const report = await runRevenueFactory({
      repos, config, logger, now: () => NOW,
      fetchPages: async (urls, max) => {
        if (urls.some((u) => u.includes('exception.fr'))) throw new Error('ECONNRESET');
        return ok(urls, max);
      },
    });
    assert.equal(report.processed, 3);
    assert.equal(report.errors.length, 0);
    assert.equal(repos.revenueFactory.verdict('panne.fr')!.classification, 'NEEDS_ENRICHMENT');
    assert.ok(repos.revenueFactory.verdict('panne.fr')!.blockers.includes('FETCH_FAILED'));
    assert.equal(repos.revenueFactory.verdict('exception.fr')!.classification, 'NEEDS_ENRICHMENT');
    assert.equal(repos.revenueFactory.verdict('sain.fr')!.sendEligible, true);
  });

  test('file presque vide : une expansion générale est posée pour nourrir la découverte, une fois par période', async () => {
    discovered(repos, 'seul.fr', 'Seul');
    const fetch = fixtureFetch([site('seul.fr', 'Seul')]);
    await run(fetch);
    await run(fetch);
    const supply = repos.tasks.list({ limit: 50 }).filter((t) => t.idempotencyKey?.startsWith('factory-supply:'));
    assert.equal(supply.length, 1);
    config.sales.discoveryEnabled = false;
    await runRevenueFactory({ repos, config, logger, fetchPages: fetch, now: () => new Date(NOW.getTime() + 7 * 3_600_000) });
    assert.equal(repos.tasks.list({ limit: 50 }).filter((t) => t.idempotencyKey?.startsWith('factory-supply:')).length, 1, 'découverte coupée : rien de plus');
  });

  test('reprise : un tour interrompu est clos, un second passage ne duplique aucune preuve, un éligible n’est plus enrichi', async () => {
    discovered(repos, 'merand.fr', 'Mérand');
    partners(repos, 'merand.fr', TWO_PARTNERS);
    const abandoned = repos.revenueFactory.startRun('crash', new Date(NOW.getTime() - 3_600_000).toISOString());
    const counter = { pages: 0, calls: 0 };
    const fetch = fixtureFetch([site('merand.fr', 'Mérand')], { counter });
    await run(fetch);
    assert.equal(repos.revenueFactory.run(abandoned.runId)!.status, 'FAILED');
    const p = repos.sales.discoveredSince(null)[0]!;
    const evidenceAfterFirst = repos.sales.evidenceFor(p.id).length;
    const callsAfterFirst = counter.calls;
    // Revérification d'un éligible, 25 heures plus tard : gardes relues, aucune lecture.
    await runRevenueFactory({ repos, config, logger, fetchPages: fetch, now: () => new Date(NOW.getTime() + 25 * 3_600_000) });
    assert.equal(counter.calls, callsAfterFirst, 'SEND_ELIGIBLE : on arrête d’enrichir');
    assert.equal(repos.sales.evidenceFor(p.id).length, evidenceAfterFirst);
    const v = repos.revenueFactory.verdict('merand.fr')!;
    assert.equal(v.attempts, 2);
    assert.equal(v.firstClassification, 'HOT');
    assert.equal(v.initialScore, v.revenueScore, 'le score initial reste celui du premier passage');
  });

  test('le coût IA d’un tour est nul et mesuré : aucun appel de modèle', async () => {
    discovered(repos, 'merand.fr', 'Mérand');
    const before = repos.llmCalls.usageSince('1970-01-01T00:00:00.000Z').calls;
    const report = await run(fixtureFetch([site('merand.fr', 'Mérand')]));
    assert.equal(report.costUsd, 0);
    assert.equal(repos.llmCalls.usageSince('1970-01-01T00:00:00.000Z').calls, before);
    assert.equal(repos.revenueFactory.run(report.runId)!.status, 'DONE');
  });
});

describe('intégration au daemon', () => {
  test('planifiée toutes les 30 minutes, routée vers le worker déterministe, servie par son handler', async () => {
    const planned = scheduleSalesCycle(repos, config, NOW);
    assert.ok(planned.created.some((k) => k.startsWith('sales:factory:30m:')), planned.created.join());
    assert.equal(routeTask(REVENUE_FACTORY_TASK).target, 'DETERMINISTIC');
    assert.equal(REVENUE_FACTORY_TASK, SALES_ENGINE_TASKS.FACTORY);
    discovered(repos, 'merand.fr', 'Mérand');
    const handlers = createRevenueFactoryHandlers({ repos, config, logger, fetchPages: fixtureFetch([site('merand.fr', 'Mérand')]), now: () => NOW });
    const outcome = await handlers[REVENUE_FACTORY_TASK]!({ taskId: 'tsk_f' } as never, { logger, heartbeat: () => true, shuttingDown: () => false, correlationId: null });
    assert.equal(outcome.kind, 'DONE');
    assert.equal((outcome.result as { messagesSent: number }).messagesSent, 0);
  });
});

describe('migration 40', () => {
  test('additive, idempotente, et réversible par la procédure documentée', () => {
    const m = MIGRATIONS.find((x) => x.version === 40)!;
    assert.equal(m.name, 'revenue-factory');
    repos.db.exec(m.sql); // rejouer ne casse rien
    const tables = () => (repos.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
    for (const t of ['revenue_factory_verdicts', 'revenue_factory_events', 'revenue_factory_runs']) assert.ok(tables().includes(t), t);
    const before = tables().length;
    repos.db.exec(`DROP TABLE revenue_factory_events; DROP TABLE revenue_factory_runs; DROP TABLE revenue_factory_verdicts;
      DELETE FROM schema_migrations WHERE version = 40;`);
    assert.equal(tables().length, before - 3);
    assert.ok(tables().includes('sales_prospects'), 'aucune autre table touchée');
  });
});
