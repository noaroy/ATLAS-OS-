import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '@atlas/core';
import { createRepositories, type Repositories } from '../src/index.ts';

/**
 * Le workflow de commande, et la garde qui empêche une livraison non relue.
 *
 * Le pipeline sait produire un rapport conforme à ses contrats. Rien de cela ne
 * dit qu'il peut partir : une source morte, une traduction qui déforme une
 * preuve, un contact de standard présenté comme un interlocuteur — ces défauts
 * ne se détectent qu'en lisant.
 *
 * La garde est donc dans le dépôt, et elle refuse plutôt qu'elle ne journalise.
 * Une garde qui se contente de signaler n'empêche rien.
 */

const logger = createLogger({ level: 'error', pretty: false });
let repos: Repositories;
let dir: string;
let missionId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-delivery-'));
  repos = createRepositories(join(dir, 'd.db'), logger);
  missionId = repos.missions.create({
    title: 'Étude Allemagne',
    objective: 'Identifier des distributeurs allemands.',
    context: {},
    createdBy: 'test',
  }).id;
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const newReport = () =>
  repos.orders.recordReport({
    missionId,
    pipelineVersion: 'v1.0.0',
    scoringVersion: 'v1',
    executionMode: 'live',
    evidenceIds: ['ev_1', 'ev_2'],
    sources: ['https://exemple-reel.de'],
    costUsd: 0.0118,
    candidates: 4,
    retained: 2,
  });

describe('aucune livraison sans revue humaine', () => {
  test('un rapport naît en GENERATED', () => {
    assert.equal(newReport().state, 'GENERATED');
  });

  test('le saut direct vers la livraison est refusé', () => {
    const report = newReport();
    assert.throws(
      () => repos.orders.setReportState(report.id, 'DELIVERED'),
      (err: unknown) => {
        assert.match(String((err as Error).message), /Transition refusée : GENERATED → DELIVERED/);
        assert.match(String((err as Error).message), /sans avoir été relu/);
        return true;
      },
    );
    assert.equal(repos.orders.getReport(report.id)!.state, 'GENERATED');
  });

  test('approuver sans passer par la revue est refusé', () => {
    const report = newReport();
    assert.throws(() => repos.orders.setReportState(report.id, 'APPROVED_FOR_DELIVERY'));
  });

  test('le chemin complet fonctionne, et horodate l’approbation', () => {
    const report = newReport();
    repos.orders.setReportState(report.id, 'PENDING_REVIEW');
    const approved = repos.orders.setReportState(report.id, 'APPROVED_FOR_DELIVERY', {
      reviewer: 'noaroy',
      passed: ['sources-live', 'no-simulation'],
      notes: 'Sources vérifiées une par une.',
    });

    assert.equal(approved.state, 'APPROVED_FOR_DELIVERY');
    assert.equal(approved.reviewer, 'noaroy');
    assert.ok(approved.approvedAt, 'l’approbation doit être horodatée');
    assert.deepEqual(approved.reviewPassed, ['sources-live', 'no-simulation']);

    const delivered = repos.orders.setReportState(report.id, 'DELIVERED');
    assert.ok(delivered.deliveredAt);
  });

  test('un rapport livré est final', () => {
    const report = newReport();
    repos.orders.setReportState(report.id, 'PENDING_REVIEW');
    repos.orders.setReportState(report.id, 'APPROVED_FOR_DELIVERY', { reviewer: 'noaroy' });
    repos.orders.setReportState(report.id, 'DELIVERED');
    assert.throws(() => repos.orders.setReportState(report.id, 'PENDING_REVIEW'));
  });

  test('un rapport refusé repasse par la revue, jamais directement en approuvé', () => {
    const report = newReport();
    repos.orders.setReportState(report.id, 'REJECTED', { notes: 'Deux sources mortes.' });
    assert.throws(() => repos.orders.setReportState(report.id, 'APPROVED_FOR_DELIVERY'));
    assert.equal(
      repos.orders.setReportState(report.id, 'PENDING_REVIEW').state,
      'PENDING_REVIEW',
      'ce qui a été refusé se revérifie',
    );
  });
});

describe('la traçabilité survit à la livraison', () => {
  test('tout ce qui permet de refaire ou défendre le rapport est conservé', () => {
    const report = newReport();
    repos.orders.setReportState(report.id, 'PENDING_REVIEW');
    repos.orders.setReportState(report.id, 'APPROVED_FOR_DELIVERY', { reviewer: 'noaroy' });
    const delivered = repos.orders.setReportState(report.id, 'DELIVERED');

    assert.equal(delivered.missionId, missionId);
    assert.equal(delivered.pipelineVersion, 'v1.0.0');
    assert.equal(delivered.scoringVersion, 'v1');
    assert.equal(delivered.executionMode, 'live');
    assert.deepEqual(delivered.evidenceIds, ['ev_1', 'ev_2']);
    assert.deepEqual(delivered.sources, ['https://exemple-reel.de']);
    assert.equal(delivered.costUsd, 0.0118);
    assert.equal(delivered.reviewer, 'noaroy');
    assert.ok(delivered.generatedAt);
    assert.ok(delivered.approvedAt);
    assert.ok(delivered.deliveredAt);
  });
});

describe('le workflow de commande', () => {
  test('une commande commence à l’extrait gratuit, rien n’est engagé', () => {
    const order = repos.orders.createOrder({
      clientName: 'Machines Dubois',
      brief: 'Distributeurs allemands pour nos machines d’emballage.',
      market: 'Allemagne',
      priceCents: 4900,
    });
    assert.equal(order.status, 'teaser-sent');
    assert.equal(order.paidAt, null);
    assert.equal(order.priceCents, 4900);
  });

  test('le paiement se constate à la main et n’est jamais posé seul', () => {
    // Aucun encaissement n'est branché : ce statut vient d'une constatation
    // humaine, et un « payé » qu'ATLAS poserait seul serait un statut auquel
    // on ne pourrait pas se fier.
    const order = repos.orders.createOrder({
      clientName: 'Machines Dubois',
      brief: 'Distributeurs allemands.',
      market: 'Allemagne',
      priceCents: 4900,
    });
    const paid = repos.orders.markPaid(order.id);
    assert.equal(paid.status, 'paid');
    assert.ok(paid.paidAt);
  });

  test('la mission se rattache à la commande', () => {
    const order = repos.orders.createOrder({
      clientName: 'Machines Dubois',
      brief: 'Distributeurs allemands.',
      market: 'Allemagne',
    });
    const started = repos.orders.setOrderStatus(order.id, 'in-production', missionId);
    assert.equal(started.missionId, missionId);
  });

  test('le prix est en centimes, jamais en flottant', () => {
    // 49,00 € stocké en flottant finit par valoir 48,999999.
    const order = repos.orders.createOrder({
      clientName: 'C',
      brief: 'B',
      market: 'M',
      priceCents: 4900,
    });
    assert.equal(repos.orders.getOrder(order.id)!.priceCents, 4900);
  });
});
