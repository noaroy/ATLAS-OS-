import type { FastifyInstance } from 'fastify';
import {
  createAgentRequestSchema,
  createMemoryRequestSchema,
  createMissionRequestSchema,
  improvementDecisionSchema,
  listEventsQuerySchema,
  listMissionsQuerySchema,
  loginRequestSchema,
  exportQuerySchema,
  memorySearchQuerySchema,
  reviewOpportunityRequestSchema,
  missionActionSchema,
  toggleSkillRequestSchema,
  triggerWorkflowRequestSchema,
  updateAgentRequestSchema,
  updateSettingsRequestSchema,
  upsertWorkflowRequestSchema,
  ATLAS_VERSION,
} from '@atlas/contracts';
import { badRequest, notFound, invalidState } from '@atlas/core';
import { assessHealth, buildDashboardStats } from '@atlas/runtime';
import { isValidCron } from '@atlas/automation';
import { DEMO_MISSION } from '@atlas/departments';
import { missionEconomics, estimateCostUsd, toCsv, toPrintableHtml } from '@atlas/intelligence';
import type { AtlasSystem } from '../bootstrap.ts';
import { sendOk } from './reply.ts';
import { buildCockpit } from './cockpit.ts';
import { isSecureRequest, requireFounder, requireOperator, tokenFrom } from './auth.ts';
import { appendSetCookie, clearSessionCookie, serializeSessionCookie } from './cookies.ts';
import { guardLogin, type Limiters } from './limits.ts';
import { UserRepository } from '@atlas/data';

/**
 * The complete REST surface.
 *
 * Grouped by resource, thin by design: routes validate, delegate to a service,
 * and shape the response. Business rules live in the packages that own them,
 * never here.
 */
export function registerRoutes(app: FastifyInstance, system: AtlasSystem, limiters: Limiters): void {
  const { repos, hermes, memory, evolution, automation, village, supervisor, config, events } = system;

  // ─── Auth ───────────────────────────────────────────────────────────────

  app.post('/api/auth/login', async (request, reply) => {
    const body = loginRequestSchema.parse(request.body);

    // Throttle before touching the password, so a brute-force attempt costs
    // the attacker a rejection rather than a scrypt verification.
    const { key } = guardLogin(limiters, request, reply, body.email, system.logger);

    const session = repos.users.authenticate(
      body.email,
      body.password,
      request.headers['user-agent'] ?? undefined,
    );

    // A successful sign-in clears the counter: someone who mistyped once
    // should not be throttled for the rest of the window.
    limiters.auth.reset(key);

    appendSetCookie(
      reply,
      serializeSessionCookie(session.token, {
        maxAgeSeconds: UserRepository.sessionTtlSeconds,
        secure: isSecureRequest(request, system),
      }),
    );

    // The token is still returned for non-browser clients (scripts, the demo,
    // integrations). Browsers ignore it and rely on the httpOnly cookie.
    return sendOk(reply, session);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = tokenFrom(request);
    if (token) repos.users.revoke(token);
    appendSetCookie(reply, clearSessionCookie(isSecureRequest(request, system)));
    return sendOk(reply, { loggedOut: true });
  });

  app.get('/api/auth/me', async (request, reply) => sendOk(reply, request.user));

  // ─── System ─────────────────────────────────────────────────────────────

  app.get('/healthz', async (_request, reply) =>
    reply.send({ ok: true, version: ATLAS_VERSION, uptime: Math.round(process.uptime()) }),
  );

  app.get('/api/health', async (_request, reply) => {
    const health = await assessHealth({
      repos,
      events,
      config,
      hermes: { activeCount: hermes.activeCount, queuedCount: hermes.queuedCount },
      n8nPing: automation.n8n ? () => automation.n8n!.ping() : undefined,
    });
    return sendOk(reply, health);
  });

  app.get('/api/stats', async (_request, reply) => sendOk(reply, buildDashboardStats(repos)));

  app.get('/api/resources', async (_request, reply) => sendOk(reply, repos.ops.recentSamples(120)));

  app.get('/api/settings', async (_request, reply) =>
    sendOk(reply, {
      runtime: system.settings(),
      mode: config.llm.mode,
      version: ATLAS_VERSION,
      n8nEnabled: automation.n8nEnabled,
    }),
  );

  app.patch('/api/settings', { preHandler: requireFounder }, async (request, reply) => {
    const patch = updateSettingsRequestSchema.parse(request.body);
    repos.settings.updateRuntime(patch, request.user!.id);
    return sendOk(reply, system.settings());
  });

  app.get('/api/alerts', async (request, reply) => {
    const query = request.query as { all?: string };
    return sendOk(reply, repos.ops.listAlerts(query.all === 'true'));
  });

  app.post('/api/alerts/:id/acknowledge', async (request, reply) => {
    const { id } = request.params as { id: string };
    repos.ops.acknowledgeAlert(id);
    return sendOk(reply, { acknowledged: true });
  });

  app.post('/api/alerts/acknowledge-all', async (_request, reply) =>
    sendOk(reply, { acknowledged: repos.ops.acknowledgeAll() }),
  );

  app.post('/api/system/backup', { preHandler: requireFounder }, async (_request, reply) => {
    const result = supervisor.backupNow('manual');
    return sendOk(reply, { bytes: result.bytes, pruned: result.pruned });
  });

  app.get('/api/system/backups', { preHandler: requireOperator }, async (_request, reply) =>
    sendOk(reply, repos.ops.listBackups(50)),
  );

  // ─── Missions ───────────────────────────────────────────────────────────

  app.get('/api/missions', async (request, reply) => {
    const query = listMissionsQuerySchema.parse(request.query);
    const { items, total } = repos.missions.list(query);
    return sendOk(reply, { items, total, limit: query.limit, offset: query.offset });
  });

  app.post('/api/missions', { preHandler: requireOperator }, async (request, reply) => {
    const body = createMissionRequestSchema.parse(request.body);
    const mission = await hermes.submit({ ...body, createdBy: request.user!.id });
    return sendOk(reply, mission, 201);
  });

  /**
   * La mission de démonstration locale.
   *
   * Refusée hors simulation, et le refus vit ici. Un bouton d'interface qui
   * « ne devrait pas » être cliqué en mode réel reste un bouton qu'un clic
   * suffit à déclencher ; la seule garantie qui tienne est celle que le serveur
   * applique lui-même.
   */
  app.post('/api/missions/demo', { preHandler: requireOperator }, async (request, reply) => {
    if (config.llm.mode !== 'simulation') {
      throw invalidState(
        "La mission de démonstration ne s'exécute qu'en mode simulation. ATLAS tourne " +
          'actuellement sur de l’inférence facturée : la lancer dépenserait de l’argent réel ' +
          'pour produire des données fabriquées. Démarrez ATLAS sans clé Anthropic ' +
          '(npm run dev:sim) pour l’utiliser.',
      );
    }

    const mission = await hermes.submit({ ...DEMO_MISSION, createdBy: request.user!.id });

    system.events.publish({
      type: 'mission.created',
      severity: 'info',
      source: 'founder',
      missionId: mission.id,
      message: `Mission de démonstration ${mission.code} créée — données simulées`,
      payload: { demo: true, departmentKey: DEMO_MISSION.departmentKey },
    });

    return sendOk(reply, mission, 201);
  });

  app.get('/api/missions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const mission = repos.missions.get(id);
    if (!mission) throw notFound('Mission');

    return sendOk(reply, {
      mission,
      tasks: repos.missions.tasksFor(id),
      messages: repos.messages.forMission(id),
      events: repos.events.forMission(id, 200),
      isActive: hermes.isActive(id),
      // La comptabilité économique appartient à toute mission, pas seulement à
      // celles qui alimentent un entonnoir d'opportunités. Elle n'était exposée
      // que par la route des opportunités : une mission générique ne montrait
      // donc aucun coût, et une mission de département n'en montrait un qu'à
      // condition d'ouvrir le bon onglet.
      economics: missionEconomics({
        repos,
        missionId: mission.id,
        model: system.settings().agentModel,
        simulated: config.llm.mode === 'simulation',
      }),
      // Ce qui a réellement produit ces chiffres. Un coût de 0,00 $ ne veut pas
      // dire la même chose selon qu'on tourne sur des jetons simulés ou sur de
      // l'inférence facturée, et le nombre seul ne le dit pas.
      mode: config.llm.mode,
      // Le *pourquoi* de la mission : plan retenu, allocations, branches
      // arrêtées, arbitrages budgétaires, conclusion et ses preuves.
      decisions: repos.decisions.forMission(id),
      // Les décisions qui affirment quelque chose sans preuve à l'appui. Vide
      // est le résultat attendu ; non vide est une anomalie à regarder.
      unsupportedClaims: repos.decisions.unsupportedClaims(id),
      // ── Le cockpit ──────────────────────────────────────────────────────
      // Tout ce que le Command Center affiche vient d'ici. Aucune métrique
      // n'est recalculée côté navigateur : un chiffre inventé par l'interface
      // est indiscernable d'un chiffre mesuré, et c'est précisément ce qu'on
      // ne veut pas dans un tableau de bord qui pilote une dépense.
      cockpit: buildCockpit(system, id),
    });
  });

  app.post('/api/missions/:id/actions', { preHandler: requireOperator }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { action } = missionActionSchema.parse(request.body);

    switch (action) {
      case 'start':
      case 'resume':
        hermes.start(id);
        return sendOk(reply, repos.missions.require(id));
      case 'pause':
        return sendOk(reply, hermes.pause(id));
      case 'cancel':
        return sendOk(reply, hermes.cancel(id));
      case 'retry':
        return sendOk(reply, hermes.retry(id));
      case 'validate':
        return sendOk(reply, hermes.validate(id, request.user!.id));
      case 'archive':
        return sendOk(reply, hermes.archive(id));
    }
  });

  // ─── Agents ─────────────────────────────────────────────────────────────

  app.get('/api/agents', async (_request, reply) => sendOk(reply, repos.agents.list()));

  app.get('/api/agents/:key', async (request, reply) => {
    const { key } = request.params as { key: string };
    const agent = repos.agents.get(key);
    if (!agent) throw notFound(`Agent '${key}'`);

    return sendOk(reply, {
      agent,
      recentEvents: repos.events.list({ agentKey: key, limit: 50 }),
      tools: system.registry.forAgent(agent.tools).map((t) => ({
        name: t.name,
        description: t.description,
        category: t.category,
      })),
    });
  });

  app.patch('/api/agents/:key', { preHandler: requireOperator }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const patch = updateAgentRequestSchema.parse(request.body);
    repos.agents.updateDefinition(key, patch);
    return sendOk(reply, repos.agents.get(key));
  });

  /** Runtime creation of a new specialist (SRS §4.15). */
  app.post('/api/agents', { preHandler: requireFounder }, async (request, reply) => {
    const body = createAgentRequestSchema.parse(request.body);

    if (repos.agents.getDefinition(body.key)) throw invalidState(`Agent '${body.key}' already exists`);
    if (!repos.buildings.get(body.building)) throw badRequest(`No building named '${body.building}'`);

    // Article VII: a specialist is composed from the shared skill catalogue,
    // never from a bespoke tool list of its own.
    const unknownSkills = body.skills.filter((s) => !repos.skills.get(s));
    if (unknownSkills.length > 0) {
      throw badRequest(`Unknown skills: ${unknownSkills.join(', ')}`, {
        available: repos.skills.list().map((s) => s.key),
      });
    }

    repos.agents.upsertDefinition({
      ...body,
      appearance: {
        // Derive a stable, distinct palette from the key so a new inhabitant
        // is visually identifiable the moment it appears in the village.
        hue: [...body.key].reduce((acc, ch) => (acc + ch.charCodeAt(0) * 7) % 360, 0),
        accent: '#7dd3fc',
        silhouette: 'scout',
        emblem: '◆',
      },
      enabled: true,
    });

    system.events.publish({
      type: 'village.updated',
      severity: 'success',
      source: 'founder',
      agentKey: body.key,
      message: `A new specialist joined ATLAS: ${body.name}`,
      payload: { agentKey: body.key, building: body.building },
    });

    return sendOk(reply, repos.agents.get(body.key), 201);
  });

  app.delete('/api/agents/:key', { preHandler: requireFounder }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const agent = repos.agents.getDefinition(key);
    if (!agent) throw notFound(`Agent '${key}'`);

    // Disabling keeps the history intact; deletion would orphan task records.
    repos.agents.updateDefinition(key, { enabled: false });
    return sendOk(reply, { disabled: true, key });
  });

  // ─── Memory ─────────────────────────────────────────────────────────────

  app.get('/api/memory', async (request, reply) => {
    const query = memorySearchQuerySchema.parse(request.query);
    const hits = memory.recall({
      text: query.q,
      tier: query.tier,
      tags: query.tags ? query.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
      limit: query.limit,
    });
    return sendOk(reply, { items: hits, stats: memory.stats() });
  });

  app.post('/api/memory', { preHandler: requireOperator }, async (request, reply) => {
    const body = createMemoryRequestSchema.parse(request.body);
    const item = memory.remember({ ...body, agentKey: null, missionId: null });
    return sendOk(reply, item, 201);
  });

  app.delete('/api/memory/:id', { preHandler: requireOperator }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!memory.get(id)) throw notFound('Memory item');
    memory.forget(id);
    return sendOk(reply, { forgotten: true });
  });

  app.post('/api/memory/consolidate', { preHandler: requireOperator }, async (_request, reply) =>
    sendOk(reply, memory.consolidate(system.settings().memoryRetention)),
  );

  // ─── Village ────────────────────────────────────────────────────────────

  app.get('/api/village', async (_request, reply) => sendOk(reply, village.snapshot()));

  // ─── Events ─────────────────────────────────────────────────────────────

  app.get('/api/events', async (request, reply) => {
    const query = listEventsQuerySchema.parse(request.query);
    return sendOk(reply, repos.events.list(query));
  });

  app.get('/api/messages', async (_request, reply) => sendOk(reply, repos.messages.recent(150)));

  // ─── Automation ─────────────────────────────────────────────────────────

  app.get('/api/workflows', async (_request, reply) =>
    sendOk(reply, { workflows: automation.listWorkflows(), n8nEnabled: automation.n8nEnabled }),
  );

  app.post('/api/workflows', { preHandler: requireOperator }, async (request, reply) => {
    const body = upsertWorkflowRequestSchema.parse(request.body);
    if (body.trigger.type === 'schedule' && !isValidCron(body.trigger.cron)) {
      throw badRequest(`"${body.trigger.cron}" is not a valid 5-field cron expression`);
    }
    const workflow = repos.workflows.upsert(body);
    automation.rescheduleAll();
    return sendOk(reply, workflow, 201);
  });

  app.post('/api/workflows/:key/trigger', { preHandler: requireOperator }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const body = triggerWorkflowRequestSchema.parse(request.body ?? {});
    const result = await automation.trigger(key, body.payload, body.missionId);
    return sendOk(reply, result);
  });

  app.post('/api/workflows/:key/toggle', { preHandler: requireOperator }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const workflow = repos.workflows.getByKey(key);
    if (!workflow) throw notFound(`Workflow '${key}'`);

    repos.workflows.setEnabled(key, !workflow.enabled);
    automation.rescheduleAll();
    return sendOk(reply, repos.workflows.getByKey(key));
  });

  app.get('/api/workflows/:id/runs', async (request, reply) => {
    const { id } = request.params as { id: string };
    return sendOk(reply, repos.workflows.runsFor(id, 30));
  });

  // ─── Evolution ──────────────────────────────────────────────────────────

  app.get('/api/improvements', async (request, reply) => {
    const query = request.query as { status?: string };
    const status = query.status as Parameters<typeof repos.improvements.list>[0];
    return sendOk(reply, {
      items: repos.improvements.list(status),
      counts: repos.improvements.countByStatus(),
    });
  });

  app.post('/api/improvements/:id/decision', { preHandler: requireFounder }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { decision } = improvementDecisionSchema.parse(request.body);
    const decidedBy = request.user!.id;

    switch (decision) {
      case 'approve':
        return sendOk(reply, evolution.approve(id, decidedBy));
      case 'reject':
        return sendOk(reply, evolution.reject(id, decidedBy));
      case 'revert':
        return sendOk(reply, evolution.revert(id, decidedBy));
    }
  });

  app.post('/api/evolution/run', { preHandler: requireOperator }, async (_request, reply) => {
    const result = await evolution.runCycle();
    return sendOk(reply, {
      report: result.report,
      proposed: result.proposed.length,
      autoApplied: result.autoApplied.length,
      skipped: result.skipped,
    });
  });

  // ─── Departments (Article IV) ───────────────────────────────────────────

  app.get('/api/departments', async (_request, reply) =>
    sendOk(
      reply,
      repos.departments.list().map((department) => ({
        department,
        stats: departmentStats(system, department.key),
      })),
    ),
  );

  app.get('/api/departments/:key', async (request, reply) => {
    const { key } = request.params as { key: string };
    const department = repos.departments.get(key);
    if (!department) throw notFound(`Department '${key}'`);

    const missions = repos.missions.list({ limit: 25, offset: 0 }).items.filter(
      (m) => m.departmentKey === key,
    );

    return sendOk(reply, {
      department,
      stats: departmentStats(system, key),
      missions,
      // A department's method is only real if its agents can actually run it.
      readiness: department.playbook.map((stage) => {
        const agent = repos.agents.getDefinition(stage.agentKey);
        return {
          ref: stage.ref,
          title: stage.title,
          team: stage.teamKey,
          agentKey: stage.agentKey,
          agentName: agent?.name ?? null,
          requiredSkills: stage.requiredSkills,
          ready: Boolean(
            agent?.enabled && stage.requiredSkills.every((s) => agent.skills.includes(s)),
          ),
        };
      }),
    });
  });

  // ─── Opportunities ──────────────────────────────────────────────────────

  /** Everything a department mission produced, funnel included. */
  app.get('/api/missions/:id/opportunities', async (request, reply) => {
    const { id } = request.params as { id: string };
    const mission = repos.missions.get(id);
    if (!mission) throw notFound('Mission');

    return sendOk(reply, {
      funnel: repos.opportunities.funnelFor(id),
      shortlist: repos.opportunities.shortlistFor(id).map((o) => o.id),
      opportunities: system.intelligence.detailsForMission(id),
      economics: mission.departmentKey
        ? missionEconomics({
            repos,
            missionId: id,
            model: system.settings().agentModel,
            simulated: config.llm.mode === 'simulation',
          })
        : null,
    });
  });

  app.get('/api/opportunities/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const opportunity = repos.opportunities.get(id);
    if (!opportunity) throw notFound(`Opportunity '${id}'`);

    const detail = system.intelligence.detail(id);
    return sendOk(reply, {
      ...detail,
      sources: repos.companies.listSources(),
      /** Where else this company has come up — the value of a shared registry. */
      alsoSeenIn: repos.opportunities
        .forCompany(detail.company.id)
        .filter((o) => o.id !== id)
        .map((o) => ({ opportunityId: o.id, missionId: o.missionId, stage: o.stage, score: o.score })),
    });
  });

  /**
   * The founder's own verdict on a candidate (Article XVI).
   *
   * ATLAS produces a shortlist; a human decides whether it may be shown to
   * anyone. Kept apart from qualification and scoring, which are the system's
   * judgements — conflating them would hide who concluded what.
   */
  app.post('/api/opportunities/:id/review', { preHandler: requireOperator }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = reviewOpportunityRequestSchema.parse(request.body);
    const opportunity = repos.opportunities.get(id);
    if (!opportunity) throw notFound(`Opportunité '${id}'`);

    const updated = repos.opportunities.setReview(id, {
      decision: body.decision,
      note: body.note?.trim() || null,
      reviewedBy: request.user!.email,
      reviewedAt: new Date().toISOString(),
    });

    const company = repos.companies.get(opportunity.companyId);
    events.publish({
      type: 'opportunity.shortlisted',
      severity: body.decision === 'rejected' ? 'warning' : 'success',
      source: 'founder',
      missionId: opportunity.missionId,
      message:
        body.decision === 'approved'
          ? `${company?.name ?? id} approuvée par le fondateur`
          : body.decision === 'rejected'
            ? `${company?.name ?? id} rejetée par le fondateur`
            : `${company?.name ?? id} annotée par le fondateur`,
      payload: { opportunityId: id, decision: body.decision },
    });

    return sendOk(reply, updated);
  });

  /** What this deployment can actually search, before anything is spent. */
  app.get('/api/discovery/capabilities', async (_request, reply) =>
    sendOk(reply, {
      mode: config.llm.mode,
      providers: system.discovery.capabilities(),
    }),
  );

  // ─── Export ─────────────────────────────────────────────────────────────

  /**
   * The shortlist as a file a client can be given.
   *
   * `approvedOnly` is the default for a reason: a file leaves ATLAS and is then
   * read without its context, so what has not been signed off should not be
   * the easy thing to send.
   */
  app.get('/api/missions/:id/export', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = exportQuerySchema.parse(request.query);

    const mission = repos.missions.get(id);
    if (!mission) throw notFound('Mission');

    const all = system.intelligence.detailsForMission(id);
    const selected =
      query.scope === 'approved'
        ? all.filter((d) => d.opportunity.review?.decision === 'approved')
        : query.scope === 'shortlist'
          ? all.filter((d) => d.opportunity.rank !== null)
          : all;

    if (selected.length === 0) {
      throw invalidState(
        query.scope === 'approved'
          ? "Aucune opportunité approuvée. Passez la shortlist en revue, ou exportez le périmètre « shortlist »."
          : 'Aucune opportunité à exporter pour cette mission.',
      );
    }

    const payload = {
      mission,
      department: mission.departmentKey ? repos.departments.get(mission.departmentKey) : null,
      opportunities: selected,
      economics: mission.departmentKey
        ? missionEconomics({
            repos,
            missionId: id,
            model: system.settings().agentModel,
            simulated: config.llm.mode === 'simulation',
          })
        : null,
      simulated: config.llm.mode === 'simulation',
      generatedAt: new Date().toISOString(),
    };

    const file = query.format === 'csv' ? toCsv(payload) : toPrintableHtml(payload);

    return reply
      .header('content-type', file.mediaType)
      .header('content-disposition', `attachment; filename="${file.filename}"`)
      .send(file.content);
  });

  app.get('/api/companies', async (request, reply) => {
    const query = request.query as { q?: string; country?: string; limit?: string };
    return sendOk(
      reply,
      repos.companies.search({
        text: query.q,
        country: query.country,
        limit: query.limit ? Number(query.limit) : 50,
      }),
    );
  });

  app.get('/api/companies/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const company = repos.companies.get(id);
    if (!company) throw notFound(`Company '${id}'`);

    return sendOk(reply, {
      company,
      evidence: repos.companies.evidenceFor(id),
      contacts: repos.companies.contactsFor(id),
      relations: repos.companies.relationsFor(id),
      opportunities: repos.opportunities.forCompany(id),
    });
  });

  // ─── Skills and tools ───────────────────────────────────────────────────

  /** The shared skill catalogue (Article VII), with its holders. */
  app.get('/api/skills', async (_request, reply) =>
    sendOk(
      reply,
      repos.skills.list().map((skill) => ({ ...skill, holders: repos.skills.holders(skill.key) })),
    ),
  );

  app.patch('/api/skills/:key', { preHandler: requireFounder }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const { enabled } = toggleSkillRequestSchema.parse(request.body);
    repos.skills.require(key);
    repos.skills.setEnabled(key, enabled);

    system.events.publish({
      type: 'system.alert',
      severity: enabled ? 'success' : 'warning',
      source: 'founder',
      message: enabled
        ? `Skill '${key}' enabled — its tools are available again to every agent that declares it.`
        : `Skill '${key}' disabled — its tools are withdrawn from every agent that declares it.`,
      payload: { key, enabled, holders: repos.skills.holders(key) },
    });

    return sendOk(reply, repos.skills.require(key));
  });

  /** The raw tool surface, grouped by the skill category each tool serves. */
  app.get('/api/tools', async (_request, reply) =>
    sendOk(
      reply,
      system.registry.names().map((name) => {
        const tool = system.registry.get(name)!;
        return { name: tool.name, description: tool.description, category: tool.category };
      }),
    ),
  );
}

/**
 * Live counters for a department, derived from rows rather than tracked.
 *
 * Cost per qualified opportunity is aggregated across the department's whole
 * history, not one mission: the unit economics only mean something over a run
 * of work.
 */
function departmentStats(system: AtlasSystem, key: string) {
  const { repos } = system;
  const missions = repos.missions.list({ limit: 500, offset: 0 }).items.filter(
    (m) => m.departmentKey === key,
  );

  let tokens = 0;
  let qualified = 0;
  for (const mission of missions) {
    tokens += repos.missions.tokensUsed(mission.id);
    qualified += repos.opportunities.countQualified(mission.id);
  }

  const cost = estimateCostUsd(tokens, system.settings().agentModel);

  return {
    departmentKey: key,
    missionsTotal: missions.length,
    missionsActive: missions.filter((m) => ['running', 'assigned', 'planned', 'created'].includes(m.status))
      .length,
    opportunitiesDiscovered: repos.opportunities.countForDepartment(key),
    opportunitiesQualified: qualified,
    opportunitiesShortlisted: repos.opportunities.countForDepartment(key, ['shortlisted']),
    companiesKnown: repos.companies.count(),
    evidenceItems: missions.reduce(
      (sum, m) => sum + repos.companies.countEvidenceForMission(m.id),
      0,
    ),
    costPerQualifiedOpportunity:
      cost !== null && qualified > 0 ? Math.round((cost / qualified) * 10_000) / 10_000 : null,
  };
}
