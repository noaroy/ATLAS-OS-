import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, notFound } from '@atlas/core';
import { OUTCOME_KINDS, SUPPRESSION_KINDS, SUPPRESSION_REASONS, SEGMENT_STATUSES } from '@atlas/data';
import {
  buildSalesDashboard,
  decideRecommendation,
  rollbackStrategy,
  recordSalesOutcome,
  readGlobalPause,
  setGlobalPause,
  readStrategy,
  runOptimizationCycle,
  scheduleSalesCycle,
  type DashboardRange,
} from '@atlas/runtime';
import type { AtlasSystem } from '../bootstrap.ts';
import { sendOk } from './reply.ts';
import { requireFounder, requireOperator } from './auth.ts';

/**
 * La surface HTTP du moteur commercial : une lecture, et des décisions.
 *
 * Les lectures sont ouvertes à toute session ; chaque décision qui change ce
 * qu'ATLAS a le droit de faire — pause, reprise, approbation d'une campagne,
 * validation d'une recommandation, issue commerciale, suppression — exige le
 * fondateur. Les routes valident et délèguent : aucune règle ne vit ici.
 */

const rangeSchema = z.enum(['7d', '30d', 'all']).default('30d');

const reasonSchema = z.object({ reason: z.string().trim().min(1).max(300) });

const outcomeSchema = z.object({
  domain: z.string().trim().min(3),
  kind: z.enum(OUTCOME_KINDS),
  revenueAmount: z.number().min(0).nullable().optional(),
  currency: z.string().trim().length(3).optional(),
  occurredAt: z.string().datetime().optional(),
  offer: z.string().trim().max(200).nullable().optional(),
  segmentId: z.string().trim().nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
});

const segmentSchema = z.object({
  name: z.string().trim().min(2).max(120),
  countries: z.array(z.string().trim().min(2)).default([]),
  sectors: z.array(z.string().trim()).default([]),
  companySize: z.object({ min: z.number().int().min(0).optional(), max: z.number().int().min(1).optional() }).nullable().optional(),
  keywords: z.array(z.string().trim()).default([]),
  exclusions: z.array(z.string().trim()).default([]),
  targetPersonas: z.array(z.string().trim()).default([]),
  buyingSignals: z.array(z.string().trim()).default([]),
  offerAngle: z.string().trim().max(300).nullable().optional(),
  explorationWeight: z.number().min(0).max(2).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const suppressSchema = z.object({
  kind: z.enum(SUPPRESSION_KINDS),
  value: z.string().trim().min(3),
  reason: z.enum(SUPPRESSION_REASONS).default('MANUAL'),
  evidence: z.string().trim().max(500).nullable().optional(),
});

export function registerSalesRoutes(app: FastifyInstance, system: AtlasSystem): void {
  const { repos, config } = system;

  // ─── La page unique ──────────────────────────────────────────────────────
  app.get('/api/cc/dashboard', async (request, reply) => {
    const query = request.query as { range?: string; segment?: string };
    const range: DashboardRange = rangeSchema.parse(query.range || undefined);
    const segmentId = query.segment?.trim() || null;
    if (segmentId && !repos.salesEngine.segment(segmentId)) throw notFound(`segment ${segmentId}`);
    return sendOk(reply, buildSalesDashboard(repos, config, { range, segmentId }));
  });

  // ─── Le coupe-circuit ────────────────────────────────────────────────────
  app.get('/api/sales/pause', async (_request, reply) => sendOk(reply, readGlobalPause(repos)));

  app.post('/api/sales/pause', { preHandler: requireFounder }, async (request, reply) => {
    const body = reasonSchema.partial().parse(request.body ?? {});
    return sendOk(reply, setGlobalPause(repos, true, request.user!.email, body.reason ?? 'pause demandée depuis le tableau de bord'));
  });

  app.post('/api/sales/resume', { preHandler: requireFounder }, async (request, reply) =>
    sendOk(reply, setGlobalPause(repos, false, request.user!.email, null)));

  // ─── Les recommandations et la stratégie ─────────────────────────────────
  app.get('/api/sales/recommendations', async (request, reply) => {
    const { status } = request.query as { status?: string };
    return sendOk(reply, repos.salesEngine.recommendations(status ? { status: status.split(',') as never } : {}));
  });

  app.post('/api/sales/recommendations/:id/:decision', { preHandler: requireFounder }, async (request, reply) => {
    const { id, decision } = request.params as { id: string; decision: string };
    if (!['test', 'approve', 'reject'].includes(decision)) throw badRequest(`décision inconnue : ${decision}`);
    if (!repos.salesEngine.recommendation(id)) throw notFound(`recommandation ${id}`);
    return sendOk(reply, decideRecommendation(repos, id, decision as 'test' | 'approve' | 'reject', request.user!.email));
  });

  app.post('/api/sales/optimize', { preHandler: requireOperator }, async (_request, reply) =>
    sendOk(reply, runOptimizationCycle(repos, config, new Date())));

  app.get('/api/sales/strategy', async (_request, reply) =>
    sendOk(reply, { strategy: readStrategy(repos), versions: repos.salesEngine.strategyVersions(20) }));

  app.post('/api/sales/strategy/:versionId/rollback', { preHandler: requireFounder }, async (request, reply) => {
    const { versionId } = request.params as { versionId: string };
    const body = reasonSchema.partial().parse(request.body ?? {});
    return sendOk(reply, rollbackStrategy(repos, versionId, request.user!.email, body.reason ?? 'retour arrière demandé'));
  });

  app.get('/api/sales/insights', async (_request, reply) => sendOk(reply, repos.salesEngine.insights()));

  app.post('/api/sales/insights/:id/:status', { preHandler: requireOperator }, async (request, reply) => {
    const { id, status } = request.params as { id: string; status: string };
    if (!['OPEN', 'ACKNOWLEDGED', 'RESOLVED'].includes(status)) throw badRequest(`statut inconnu : ${status}`);
    repos.salesEngine.setInsightStatus(id, status as 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED');
    return sendOk(reply, { id, status });
  });

  // ─── Les issues commerciales : toujours humaines ─────────────────────────
  app.post('/api/sales/outcomes', { preHandler: requireFounder }, async (request, reply) => {
    const body = outcomeSchema.parse(request.body);
    return sendOk(reply, recordSalesOutcome(repos, { ...body, by: request.user!.email }), 201);
  });

  app.get('/api/sales/outcomes', async (request, reply) => {
    const { domain } = request.query as { domain?: string };
    return sendOk(reply, domain ? repos.salesEngine.outcomesFor(domain) : repos.salesEngine.outcomes());
  });

  // ─── Les segments (campagnes) ────────────────────────────────────────────
  app.get('/api/sales/segments', async (_request, reply) => sendOk(reply, repos.salesEngine.segments()));

  app.post('/api/sales/segments', { preHandler: requireFounder }, async (request, reply) => {
    const body = segmentSchema.parse(request.body);
    const { segment, created } = repos.salesEngine.createSegment(body);
    return sendOk(reply, { segment, created }, created ? 201 : 200);
  });

  app.post('/api/sales/segments/:id/:action', { preHandler: requireFounder }, async (request, reply) => {
    const { id, action } = request.params as { id: string; action: string };
    const segment = repos.salesEngine.segment(id);
    if (!segment) throw notFound(`segment ${id}`);
    const by = request.user!.email;
    switch (action) {
      case 'approve':
        return sendOk(reply, repos.salesEngine.approveSegmentForSend(id, by));
      case 'revoke': {
        const body = reasonSchema.partial().parse(request.body ?? {});
        return sendOk(reply, repos.salesEngine.revokeSegmentApproval(id, by, body.reason ?? 'approbation retirée'));
      }
      case 'pause':
        return sendOk(reply, repos.salesEngine.setSegmentStatus(id, 'PAUSED', by));
      case 'stop':
        return sendOk(reply, repos.salesEngine.setSegmentStatus(id, 'STOPPED', by));
      case 'resume':
        return sendOk(reply, repos.salesEngine.setSegmentStatus(id, 'TESTING', by, 'reprise'));
      default: {
        if ((SEGMENT_STATUSES as readonly string[]).includes(action)) {
          return sendOk(reply, repos.salesEngine.setSegmentStatus(id, action as (typeof SEGMENT_STATUSES)[number], by));
        }
        throw badRequest(`action inconnue : ${action}`);
      }
    }
  });

  // ─── La liste de suppression ─────────────────────────────────────────────
  app.get('/api/sales/suppressions', async (_request, reply) => sendOk(reply, repos.salesEngine.suppressions()));

  app.post('/api/sales/suppress', { preHandler: requireFounder }, async (request, reply) => {
    const body = suppressSchema.parse(request.body);
    const result = repos.salesEngine.suppress({ ...body, source: 'dashboard', createdBy: request.user!.email });
    if (body.kind === 'DOMAIN') {
      repos.sales.recordOutreach({ domain: body.value, kind: 'DO_NOT_CONTACT', recordedBy: request.user!.email, note: `suppression ${body.reason}` });
    }
    return sendOk(reply, result, result.created ? 201 : 200);
  });

  // ─── Les réponses chaudes ────────────────────────────────────────────────
  app.post('/api/sales/leads/:domain/handled', { preHandler: requireOperator }, async (request, reply) => {
    const { domain } = request.params as { domain: string };
    const body = z.object({ note: z.string().trim().max(500).nullable().optional() }).parse(request.body ?? {});
    repos.salesEngine.markLeadHandled(domain, request.user!.email, body.note ?? null);
    return sendOk(reply, repos.salesEngine.leadReview(domain));
  });

  // ─── La cadence, à la demande ────────────────────────────────────────────
  app.post('/api/sales/schedule', { preHandler: requireOperator }, async (_request, reply) =>
    sendOk(reply, scheduleSalesCycle(repos, config, new Date())));
}
