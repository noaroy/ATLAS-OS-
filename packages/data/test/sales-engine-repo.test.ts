import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../core/src/logger.ts';
import { createRepositories, MIGRATIONS, type Repositories } from '../src/index.ts';

/**
 * La mémoire du moteur commercial : ce que la base garantit seule, sans que
 * le code au-dessus ait à y penser. Une suppression normalisée, une
 * attribution qui n'écrase pas, une issue qui exige un auteur, une
 * recommandation qui ne se propose pas deux fois.
 */

const logger = createLogger({ level: 'error', pretty: false });
let dir: string;
let repos: Repositories;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-sales-repo-'));
  repos = createRepositories(join(dir, 'atlas.db'), logger);
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('migration 36', () => {
  test('est versionnée, idempotente, et crée les tables du moteur', () => {
    const last = MIGRATIONS[MIGRATIONS.length - 1]!;
    assert.equal(last.version, 36);
    const tables = (repos.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    for (const expected of [
      'sales_segments', 'sales_attributions', 'sales_outcomes', 'suppression_list', 'sales_experiments',
      'optimization_recommendations', 'strategy_versions', 'engineering_insights', 'sales_friction_events', 'sales_lead_reviews',
    ]) assert.ok(tables.includes(expected), expected);
    // Rejouer le SQL ne casse rien : chaque CREATE est IF NOT EXISTS.
    const applied = repos.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 36').get() as { n: number };
    assert.equal(applied.n, 1);
    const columns = (repos.db.prepare('PRAGMA table_info(daemon_runs)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(columns.includes('last_heartbeat_at'));
  });
});

describe('segments', () => {
  test('création idempotente par nom, approbation signée, statut journalisé', () => {
    const a = repos.salesEngine.createSegment({ name: 'PME B2B FR', countries: ['FR'], keywords: ['machines spéciales'] });
    const b = repos.salesEngine.createSegment({ name: 'pme b2b fr' });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(b.segment.id, a.segment.id);
    assert.equal(a.segment.approvedForSend, false);
    assert.throws(() => repos.salesEngine.approveSegmentForSend(a.segment.id, ' '), /auteur/);
    const approved = repos.salesEngine.approveSegmentForSend(a.segment.id, 'founder@test.local');
    assert.equal(approved.approvedForSend, true);
    assert.equal(approved.approvedBy, 'founder@test.local');
    const paused = repos.salesEngine.setSegmentStatus(a.segment.id, 'PAUSED', 'founder@test.local', 'trop de rebonds');
    assert.equal(paused.status, 'PAUSED');
    assert.match(paused.notes ?? '', /TESTING → PAUSED — trop de rebonds/);
    assert.deepEqual(repos.salesEngine.segments({ status: 'PAUSED' }).map((s) => s.id), [a.segment.id]);
  });
});

describe('attributions', () => {
  test('la première attribution tient ; une valeur nulle n’écrase jamais ; le contact se date une fois', () => {
    const seg = repos.salesEngine.createSegment({ name: 'A' }).segment;
    repos.salesEngine.attribute({ domain: 'https://www.Acme.fr/', segmentId: seg.id, messageVariant: 'A' });
    repos.salesEngine.attribute({ domain: 'acme.fr', segmentId: 'autre', messageVariant: null, persona: 'dirigeant' });
    const a = repos.salesEngine.attributionFor('acme.fr')!;
    assert.equal(a.segmentId, seg.id);
    assert.equal(a.messageVariant, 'A');
    assert.equal(a.persona, 'dirigeant');
    repos.salesEngine.markContacted('acme.fr', '2026-09-01T10:00:00.000Z');
    repos.salesEngine.markContacted('acme.fr', '2026-09-02T10:00:00.000Z');
    assert.equal(repos.salesEngine.attributionFor('acme.fr')!.contactedAt, '2026-09-01T10:00:00.000Z');
    assert.equal(repos.salesEngine.attributions({ segmentId: seg.id, contactedSince: '2026-09-01T00:00:00.000Z' }).length, 1);
    assert.equal(repos.salesEngine.attributions({ contactedSince: '2026-09-02T00:00:00.000Z' }).length, 0);
  });
});

describe('issues commerciales', () => {
  test('un auteur est exigé ; un client gagné exige un montant ; la devise vaut EUR par défaut', () => {
    assert.throws(() => repos.salesEngine.recordOutcome({ domain: 'acme.fr', kind: 'WON', revenueAmount: 10, recordedBy: '' }), /auteur/);
    assert.throws(() => repos.salesEngine.recordOutcome({ domain: 'acme.fr', kind: 'WON', recordedBy: 'x' }), /montant/);
    const won = repos.salesEngine.recordOutcome({ domain: 'acme.fr', kind: 'WON', revenueAmount: 1200, recordedBy: 'founder' });
    assert.equal(won.currency, 'EUR');
    assert.equal(repos.salesEngine.outcomesFor('acme.fr').length, 1);
    assert.equal(repos.salesEngine.outcomes({ kind: 'WON' }).length, 1);
    assert.equal(repos.salesEngine.outcomes({ since: '2999-01-01T00:00:00.000Z' }).length, 0);
  });
});

describe('liste de suppression', () => {
  test('normalise, dédoublonne, et répond par adresse, domaine (déduit de l’adresse) ou société', () => {
    const first = repos.salesEngine.suppress({ kind: 'EMAIL', value: '  Jean.Dupont@Acme.FR ', reason: 'OPT_OUT', createdBy: 'reply' });
    const again = repos.salesEngine.suppress({ kind: 'EMAIL', value: 'jean.dupont@acme.fr', reason: 'MANUAL', createdBy: 'x' });
    assert.equal(first.created, true);
    assert.equal(again.created, false);
    assert.equal(again.entry.reason, 'OPT_OUT', 'la première raison reste');
    assert.equal(repos.salesEngine.isSuppressed({ email: 'JEAN.DUPONT@acme.fr' }).suppressed, true);
    assert.equal(repos.salesEngine.isSuppressed({ email: 'autre@acme.fr' }).suppressed, false);
    repos.salesEngine.suppress({ kind: 'DOMAIN', value: 'www.bloque.fr', reason: 'BOUNCE', createdBy: 'reply' });
    assert.equal(repos.salesEngine.isSuppressed({ email: 'n-importe-qui@bloque.fr' }).suppressed, true, 'le domaine se déduit de l’adresse');
    repos.salesEngine.suppress({ kind: 'COMPANY', value: '  Société   Exemple ', reason: 'LEGAL', createdBy: 'x' });
    assert.equal(repos.salesEngine.isSuppressed({ company: 'société exemple' }).suppressed, true);
    assert.throws(() => repos.salesEngine.suppress({ kind: 'DOMAIN', value: '', reason: 'MANUAL', createdBy: 'x' }));
    assert.equal(repos.salesEngine.suppressions().length, 3);
  });
});

describe('recommandations, versions, insights, frictions', () => {
  test('une même idée ouverte ne se propose pas deux fois ; refusée, elle peut revenir', () => {
    const a = repos.salesEngine.propose({ kind: 'SCALE_SEGMENT', title: 'x', reason: 'y', fingerprint: 'SCALE:seg' });
    const b = repos.salesEngine.propose({ kind: 'SCALE_SEGMENT', title: 'x', reason: 'y', fingerprint: 'SCALE:seg' });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    repos.salesEngine.setRecommendationStatus(a.recommendation.id, 'REJECTED', 'founder');
    const c = repos.salesEngine.propose({ kind: 'SCALE_SEGMENT', title: 'x', reason: 'y', fingerprint: 'SCALE:seg' });
    assert.equal(c.created, true);
    assert.throws(() => repos.salesEngine.setRecommendationStatus(c.recommendation.id, 'APPROVED', ''), /auteur/);
  });

  test('les versions se numérotent, se relient à une recommandation, et se marquent annulées', () => {
    const v1 = repos.salesEngine.recordStrategyVersion({ before: { a: 1 }, after: { a: 2 }, reason: 'test', createdBy: 'founder' });
    const v2 = repos.salesEngine.recordStrategyVersion({ before: { a: 2 }, after: { a: 1 }, reason: 'rollback', createdBy: 'founder', rollbackOf: v1.id });
    assert.equal(v1.version, 1);
    assert.equal(v2.version, 2);
    assert.equal(v2.rollbackOf, v1.id);
    repos.salesEngine.markRolledBack(v1.id);
    assert.ok(repos.salesEngine.strategyVersion(v1.id)!.rolledBackAt);
    assert.equal(repos.salesEngine.strategyVersions()[0]!.id, v2.id);
  });

  test('un insight revu augmente sa fréquence et rouvre s’il était résolu', () => {
    const first = repos.salesEngine.upsertInsight({ title: 'Recherche', detail: '5 échecs', fingerprint: 'SEARCH_FAILURE' });
    repos.salesEngine.setInsightStatus(first.id, 'RESOLVED');
    const again = repos.salesEngine.upsertInsight({ title: 'Recherche', detail: '9 échecs', fingerprint: 'SEARCH_FAILURE' });
    assert.equal(again.id, first.id);
    assert.equal(again.frequency, 2);
    assert.equal(again.status, 'OPEN');
    assert.equal(again.detail, '9 échecs');
  });

  test('les frictions se comptent par nature depuis une date et se purgent', () => {
    repos.salesEngine.recordFriction({ kind: 'CONTACT_NOT_FOUND', domain: 'a.fr' });
    repos.salesEngine.recordFriction({ kind: 'CONTACT_NOT_FOUND', domain: 'b.fr' });
    repos.salesEngine.recordFriction({ kind: 'SEND_BLOCKED', domain: 'c.fr', detail: 'x'.repeat(900) });
    const counts = repos.salesEngine.frictionCounts('2000-01-01T00:00:00.000Z');
    assert.equal(counts.CONTACT_NOT_FOUND, 2);
    assert.equal(counts.SEND_BLOCKED, 1);
    assert.equal(repos.salesEngine.frictions({ kind: 'SEND_BLOCKED' })[0]!.detail!.length, 500);
    assert.equal(repos.salesEngine.pruneFrictions('2999-01-01T00:00:00.000Z'), 3);
  });

  test('une réponse chaude traitée se rouvre à la réponse suivante', () => {
    repos.salesEngine.reopenLead('acme.fr');
    assert.equal(repos.salesEngine.leadReview('acme.fr')?.status, 'OPEN');
    repos.salesEngine.markLeadHandled('acme.fr', 'founder', 'appelé');
    assert.equal(repos.salesEngine.leadReview('acme.fr')?.status, 'HANDLED');
    repos.salesEngine.reopenLead('acme.fr');
    assert.equal(repos.salesEngine.leadReview('acme.fr')?.status, 'OPEN');
    assert.throws(() => repos.salesEngine.markLeadHandled('acme.fr', ''), /auteur/);
  });
});
