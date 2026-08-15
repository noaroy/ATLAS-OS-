import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { cpus, totalmem, freemem, loadavg } from 'node:os';
import { z } from 'zod';
import { AtlasError, slugify, nowIso, formatDuration, withDeadline, describeError } from '@atlas/core';
import { databaseSizeMb } from '@atlas/data';
import type { AtlasTool, ToolContext } from './tool-types.ts';
import { ok, fail } from './tool-types.ts';
import { INTELLIGENCE_TOOLS } from './intelligence-tools.ts';
import { findContacts } from './contact-tool.ts';

/**
 * Outils dont l'appel sort d'ATLAS.
 *
 * C'est la part facturée ou dépendante d'un tiers d'une mission : celle qui
 * mérite d'être comptée à part dans l'économie.
 */
const EXTERNAL_TOOLS = new Set([
  'http_fetch',
  'trigger_workflow',
  'discover_companies',
  'find_contacts',
  'enrich_company',
]);

// ─── Memory ─────────────────────────────────────────────────────────────────

const memorySearch: AtlasTool<{ query: string; tier?: 'operational' | 'strategic' | 'business'; limit?: number }> = {
  name: 'memory_search',
  description:
    'Search everything ATLAS has learned before. Use this before researching anything — prior missions may already hold the answer, and reusing knowledge is faster and cheaper than rediscovering it.',
  category: 'knowledge',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What you are looking for, in natural language' },
      tier: {
        type: 'string',
        enum: ['operational', 'strategic', 'business'],
        description: 'Optional: restrict to one memory tier',
      },
      limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Maximum results (default 8)' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  parse: z.object({
    query: z.string().min(1).max(500),
    tier: z.enum(['operational', 'strategic', 'business']).optional(),
    limit: z.number().int().min(1).max(25).optional(),
  }),
  async execute(input, ctx) {
    // ── Registre métier vide : refus structurel ───────────────────────────
    // LIVE #004 puis LIVE #005 ont porté l'information dans le briefing — « le
    // registre métier est vide, n'interrogez pas la mémoire » — et l'agent a
    // cherché quand même : sept fois, puis cinq. Une information n'est pas un
    // garde-fou. Ce que le système doit empêcher, il doit l'empêcher.
    //
    // Le refus ne vise que la recherche *métier*. La mémoire système reste
    // ouverte à ses usages propres : ce sont deux réserves distinctes, et les
    // confondre était précisément l'erreur.
    const businessTier = input.tier === 'business' || input.tier === undefined;
    if (businessTier && ctx.missionId) {
      const mission = ctx.repos.missions.get(ctx.missionId);
      if (mission?.departmentKey && ctx.repos.companies.count() === 0) {
        return fail(
          'EMPTY_BUSINESS_REGISTRY — le registre métier ne contient aucune organisation. ' +
            "Aucune recherche mémoire ne peut rien y trouver, et celle-ci n'a donc pas été exécutée. " +
            'Passez directement à la découverte.',
          { hits: 0, outcome: 'empty-business-registry' },
        );
      }
    }

    const hits = ctx.memory.recall({
      text: input.query,
      tier: input.tier,
      limit: input.limit ?? 8,
    });
    if (hits.length === 0) return ok('No prior knowledge found for that query.', { hits: 0 });

    const lines = hits.map(
      (h, i) =>
        `${i + 1}. [${h.tier}/${h.kind}] ${h.title}\n   ${h.content.replace(/\s+/g, ' ').slice(0, 400)}`,
    );
    return ok(`Found ${hits.length} relevant item(s):\n${lines.join('\n')}`, {
      hits: hits.length,
      ids: hits.map((h) => h.id),
    });
  },
};

const memoryRemember: AtlasTool<{
  title: string;
  content: string;
  kind: 'fact' | 'insight' | 'entity' | 'procedure' | 'outcome' | 'preference' | 'lesson';
  tags?: string[];
  importance?: number;
}> = {
  name: 'memory_remember',
  description:
    'Record something worth keeping. Store durable knowledge — entities, lessons, procedures, insights — not step-by-step narration of what you just did.',
  category: 'knowledge',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: 200, description: 'Short, specific title' },
      content: { type: 'string', maxLength: 20000, description: 'The knowledge itself, self-contained' },
      kind: {
        type: 'string',
        enum: ['fact', 'insight', 'entity', 'procedure', 'outcome', 'preference', 'lesson'],
      },
      tags: {
        type: 'array',
        maxItems: 20,
        items: { type: 'string', maxLength: 40 },
        description: 'Short retrieval tags',
      },
      importance: { type: 'number', minimum: 0, maximum: 1, description: '0..1, default by kind' },
    },
    required: ['title', 'content', 'kind'],
    additionalProperties: false,
  },
  parse: z.object({
    title: z.string().min(2).max(200),
    content: z.string().min(1).max(20000),
    kind: z.enum(['fact', 'insight', 'entity', 'procedure', 'outcome', 'preference', 'lesson']),
    tags: z.array(z.string().max(40)).max(20).optional(),
    importance: z.number().min(0).max(1).optional(),
  }),
  async execute(input, ctx) {
    const item = ctx.memory.remember({
      kind: input.kind,
      title: input.title,
      content: input.content,
      tags: input.tags,
      importance: input.importance,
      missionId: ctx.missionId,
      agentKey: ctx.agentKey,
    });
    return ok(`Stored in ${item.tier} memory as "${item.title}".`, { memoryId: item.id, tier: item.tier });
  },
};

// ─── Research ───────────────────────────────────────────────────────────────

/** Hosts that must never be reachable from a tool — blocks SSRF into the VPS. */
const BLOCKED_HOST = /^(localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|metadata\.)/i;
const MAX_FETCH_BYTES = 512 * 1024;

const httpFetch: AtlasTool<{ url: string; purpose: string }> = {
  name: 'http_fetch',
  description:
    'Fetch the text content of a public HTTPS URL. Use for a specific page you already know about. Content is truncated; private and internal addresses are refused.',
  category: 'research',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute https:// URL' },
      purpose: { type: 'string', description: 'Why you need this page — recorded in the audit log' },
    },
    required: ['url', 'purpose'],
    additionalProperties: false,
  },
  parse: z.object({ url: z.string().url().max(2000), purpose: z.string().min(3).max(300) }),
  async execute(input, ctx) {
    let target: URL;
    try {
      target = new URL(input.url);
    } catch {
      return fail('That is not a valid URL.');
    }
    if (target.protocol !== 'https:') return fail('Only https:// URLs are permitted.');
    if (BLOCKED_HOST.test(target.hostname)) {
      return fail('Refused: that host is internal or private and is not reachable from tools.');
    }

    // ── Plafond de récupérations sur la mission entière ────────────────────
    // Compté sur la mission et non sur l'étape : un plafond par étape se
    // contournerait en répartissant les récupérations entre les étapes.
    const ceiling = ctx.config.web.maxTotalFetchesPerMission;
    if (ctx.missionId && ceiling > 0) {
      const already = ctx.repos.toolCalls.countTool(ctx.missionId, 'http_fetch');
      if (already >= ceiling) {
        return fail(
          `Plafond atteint : cette mission a déjà récupéré ${already} page(s), sa limite. ` +
            'Concluez avec ce que vous avez déjà lu.',
        );
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    ctx.signal?.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const response = await fetch(target, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'user-agent': 'ATLAS-OS/1.0 (+autonomous research agent)', accept: 'text/html,text/plain' },
      });
      if (!response.ok) return fail(`Request failed with HTTP ${response.status}.`);

      const raw = (await response.text()).slice(0, MAX_FETCH_BYTES);
      const text = stripHtml(raw);
      return ok(`Content of ${target.href} (truncated to 8000 chars):\n\n${text.slice(0, 8000)}`, {
        url: target.href,
        status: response.status,
        bytes: raw.length,
      });
    } catch (err) {
      return fail(`Could not fetch that URL: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  },
};

// ─── Analysis ───────────────────────────────────────────────────────────────

const scoreCandidates: AtlasTool<{
  criteria: Array<{ name: string; weight: number }>;
  candidates: Array<{ name: string; scores: Record<string, number> }>;
}> = {
  name: 'score_candidates',
  description:
    'Compute weighted scores and a ranking across candidates. Do the judgement yourself, then use this to make the arithmetic exact and reproducible.',
  category: 'analysis',
  inputSchema: {
    type: 'object',
    properties: {
      criteria: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            weight: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['name', 'weight'],
          additionalProperties: false,
        },
      },
      candidates: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            scores: { type: 'object', description: 'criterion name → score 0..100' },
          },
          required: ['name', 'scores'],
          additionalProperties: false,
        },
      },
    },
    required: ['criteria', 'candidates'],
    additionalProperties: false,
  },
  parse: z.object({
    criteria: z.array(z.object({ name: z.string().max(80), weight: z.number().min(0).max(1) })).min(1).max(15),
    candidates: z
      .array(z.object({ name: z.string().max(160), scores: z.record(z.number()) }))
      .min(1)
      .max(100),
  }),
  async execute(input) {
    const totalWeight = input.criteria.reduce((sum, c) => sum + c.weight, 0) || 1;

    const ranked = input.candidates
      .map((candidate) => {
        let weighted = 0;
        const missing: string[] = [];
        for (const criterion of input.criteria) {
          const raw = candidate.scores[criterion.name];
          if (raw === undefined) {
            missing.push(criterion.name);
            continue;
          }
          weighted += Math.max(0, Math.min(100, raw)) * criterion.weight;
        }
        return {
          name: candidate.name,
          score: Math.round((weighted / totalWeight) * 10) / 10,
          missing,
        };
      })
      .sort((a, b) => b.score - a.score);

    const table = ranked
      .map((r, i) => `${i + 1}. ${r.name} — ${r.score}/100${r.missing.length ? ` (missing: ${r.missing.join(', ')})` : ''}`)
      .join('\n');

    return ok(`Weighted ranking:\n${table}`, { ranking: ranked });
  },
};

// ─── Production ─────────────────────────────────────────────────────────────

const createDocument: AtlasTool<{ title: string; format: 'markdown' | 'text' | 'csv'; body: string }> = {
  name: 'create_document',
  description:
    'Write a deliverable to the mission artifact store: a report, synthesis, dataset, or client-facing document. Returns the stored path.',
  category: 'production',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: 200, description: 'Document title' },
      format: { type: 'string', enum: ['markdown', 'text', 'csv'] },
      body: { type: 'string', maxLength: 400000, description: 'Full document content' },
    },
    required: ['title', 'format', 'body'],
    additionalProperties: false,
  },
  parse: z.object({
    title: z.string().min(2).max(200),
    format: z.enum(['markdown', 'text', 'csv']),
    body: z.string().min(1).max(400_000),
  }),
  async execute(input, ctx) {
    const extension = input.format === 'markdown' ? 'md' : input.format === 'csv' ? 'csv' : 'txt';
    const folder = ctx.missionId ?? 'unassigned';
    const directory = join(ctx.config.paths.artifactDir, folder);
    const filename = `${slugify(input.title)}-${Date.now().toString(36)}.${extension}`;
    const fullPath = join(directory, filename);

    await mkdir(directory, { recursive: true });
    await writeFile(fullPath, input.body, 'utf8');

    // The relative path is what the API serves; the absolute path stays server-side.
    const relativePath = `${folder}/${filename}`;
    return ok(`Saved "${input.title}" to the artifact store (${relativePath}).`, {
      artifact: {
        name: input.title,
        kind: input.format === 'csv' ? 'dataset' : 'report',
        mediaType: input.format === 'markdown' ? 'text/markdown' : input.format === 'csv' ? 'text/csv' : 'text/plain',
        path: relativePath,
        bytes: Buffer.byteLength(input.body, 'utf8'),
        createdBy: ctx.agentKey,
        createdAt: nowIso(),
      },
    });
  },
};

// ─── Automation ─────────────────────────────────────────────────────────────

const triggerWorkflow: AtlasTool<{ workflow: string; payload?: Record<string, unknown> }> = {
  name: 'trigger_workflow',
  description:
    'Run a registered automation workflow (n8n) and wait for its result. Use for actions ATLAS delegates to the automation layer rather than performing itself.',
  category: 'automation',
  inputSchema: {
    type: 'object',
    properties: {
      workflow: { type: 'string', description: 'Registered workflow key' },
      payload: { type: 'object', description: 'Input data for the workflow' },
    },
    required: ['workflow'],
    additionalProperties: false,
  },
  parse: z.object({ workflow: z.string().min(1).max(80), payload: z.record(z.unknown()).optional() }),
  async execute(input, ctx) {
    if (!ctx.automation) return fail('The automation layer is not enabled in this deployment.');

    const available = ctx.automation.listWorkflowKeys();
    if (!available.includes(input.workflow)) {
      return fail(
        `No workflow named "${input.workflow}". Registered workflows: ${available.join(', ') || 'none'}.`,
      );
    }

    const result = await ctx.automation.trigger(input.workflow, input.payload ?? {}, ctx.missionId);
    if (result.status === 'failure') return fail(`Workflow failed: ${result.error ?? 'unknown error'}`);
    return ok(`Workflow "${input.workflow}" completed.\n${JSON.stringify(result.output ?? {}, null, 2).slice(0, 4000)}`, {
      workflow: input.workflow,
      output: result.output,
    });
  },
};

// ─── Observation ────────────────────────────────────────────────────────────

const systemStatus: AtlasTool<Record<string, unknown>> = {
  name: 'system_status',
  description:
    'Read live technical health: resource usage, mission throughput, recent failures, and open alerts. Use this to diagnose, not to narrate.',
  category: 'observation',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  parse: z.record(z.unknown()),
  async execute(_input, ctx) {
    const memTotal = totalmem() / 1024 / 1024;
    const memUsed = memTotal - freemem() / 1024 / 1024;
    const load = loadavg()[0] ?? 0;
    const cores = cpus().length || 1;

    const counts = ctx.repos.missions.countsByStatus();
    const failures = ctx.repos.missions.recentFailures(10);
    const alerts = ctx.repos.ops.listAlerts(false, 10);
    const dbMb = databaseSizeMb(ctx.config.paths.databaseFile);

    const report = [
      `Uptime: ${formatDuration(process.uptime() * 1000)}`,
      `CPU load (1m): ${load.toFixed(2)} across ${cores} core(s)`,
      `Memory: ${memUsed.toFixed(0)} / ${memTotal.toFixed(0)} MB`,
      `Database: ${dbMb} MB`,
      `Missions by status: ${JSON.stringify(counts)}`,
      `Open alerts: ${alerts.length}${alerts.length ? ` — ${alerts.map((a) => a.title).join('; ')}` : ''}`,
      failures.length
        ? `Recent task failures:\n${failures.map((f) => `  • ${f.agentKey}/${f.action}: ${f.error ?? 'unknown'}`).join('\n')}`
        : 'Recent task failures: none',
    ].join('\n');

    return ok(report, {
      cpuLoad: load / cores,
      memoryUsedMb: Math.round(memUsed),
      databaseSizeMb: dbMb,
      openAlerts: alerts.length,
      recentFailures: failures.length,
    });
  },
};

const inspectMission: AtlasTool<{ missionId?: string }> = {
  name: 'inspect_mission',
  description:
    'Read the full record of a mission: its plan, every step, the agents involved, and what each produced. Defaults to the mission you are working on.',
  category: 'observation',
  inputSchema: {
    type: 'object',
    properties: { missionId: { type: 'string', description: 'Mission id; omit for the current mission' } },
    additionalProperties: false,
  },
  parse: z.object({ missionId: z.string().max(60).optional() }),
  async execute(input, ctx) {
    const missionId = input.missionId ?? ctx.missionId;
    if (!missionId) return fail('No mission id supplied and no current mission.');

    const mission = ctx.repos.missions.get(missionId);
    if (!mission) return fail(`Mission ${missionId} does not exist.`);

    const tasks = ctx.repos.missions.tasksFor(missionId);
    const lines = tasks.map(
      (t) =>
        `  • [${t.status}] ${t.ref} ${t.title} → ${t.agentKey} (${formatDuration(t.durationMs)})` +
        (t.error ? `\n      error: ${t.error}` : ''),
    );

    return ok(
      [
        `Mission ${mission.code}: ${mission.title}`,
        `Status: ${mission.status} — progress ${Math.round(mission.progress * 100)}%`,
        `Objective: ${mission.objective}`,
        mission.plan ? `Strategy: ${mission.plan.strategy}` : 'No plan recorded.',
        `Steps:\n${lines.join('\n') || '  (none)'}`,
      ].join('\n'),
      { missionId, taskCount: tasks.length, status: mission.status },
    );
  },
};

// ─── Registry ───────────────────────────────────────────────────────────────

const ALL_TOOLS: AtlasTool<never>[] = [
  memorySearch,
  memoryRemember,
  httpFetch,
  scoreCandidates,
  createDocument,
  triggerWorkflow,
  systemStatus,
  inspectMission,
  ...INTELLIGENCE_TOOLS,
  findContacts as AtlasTool<never>,
] as AtlasTool<never>[];

/**
 * The tool catalogue and its permission boundary.
 *
 * An agent may only call tools on its own allow-list. This is enforced here at
 * execution time, not merely by omitting the tool from the prompt — a model
 * that invents a tool name gets a clear refusal instead of an escalation
 * (SRS §5.14: each agent holds only the access it needs).
 */
export class ToolRegistry {
  #tools = new Map<string, AtlasTool<never>>();

  constructor(tools: AtlasTool<never>[] = ALL_TOOLS) {
    for (const tool of tools) this.#tools.set(tool.name, tool);
  }

  register(tool: AtlasTool<never>): void {
    this.#tools.set(tool.name, tool);
  }

  get(name: string): AtlasTool<never> | undefined {
    return this.#tools.get(name);
  }

  names(): string[] {
    return [...this.#tools.keys()].sort();
  }

  /** Resolves an agent's allow-list, silently ignoring names that no longer exist. */
  forAgent(allowed: string[]): AtlasTool<never>[] {
    return allowed.map((name) => this.#tools.get(name)).filter((t): t is AtlasTool<never> => Boolean(t));
  }

  /**
   * Validates and runs a tool call. Every failure path returns a `ToolResult`
   * rather than throwing, so a malformed call teaches the model to correct
   * itself instead of failing the whole task.
   */
  async invoke(
    name: string,
    rawInput: unknown,
    allowed: string[],
    ctx: ToolContext,
  ): Promise<{ result: import('./tool-types.ts').ToolResult; category: string | null }> {
    const tool = this.#tools.get(name);
    if (!tool) {
      return { result: fail(`No tool named "${name}". Available: ${allowed.join(', ')}.`), category: null };
    }
    if (!allowed.includes(name)) {
      return {
        result: fail(`You are not permitted to use "${name}". Your tools: ${allowed.join(', ') || 'none'}.`),
        category: tool.category,
      };
    }

    const parsed = tool.parse.safeParse(rawInput);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
      return { result: fail(`Invalid input for "${name}" — ${issues}`), category: tool.category };
    }

    const started = Date.now();
    try {
      // ── Borne dure ────────────────────────────────────────────────────────
      // LIVE #002 : `discover_companies` est resté en vol 1 284 secondes sous
      // un délai d'étape de 300, parce que ce délai n'enveloppait que
      // l'inférence propre de l'agent, jamais l'exécution de ses outils. Le
      // signal transmis ici combine la borne de l'outil et l'annulation venue
      // de la mission, si bien qu'elle descend jusqu'au fournisseur.
      const result = await withDeadline(
        (signal) => tool.execute(parsed.data as never, { ...ctx, signal }),
        {
          ms: ctx.config.orchestration.toolTimeoutMs,
          label: `outil ${name}`,
          signal: ctx.signal,
          onOrphan: (label) =>
            ctx.logger.error('un appel externe a ignoré son annulation', { tool: label }),
        },
      );
      this.#recordToolCall(ctx, name, tool.category, started, result.isError, null, result.data);
      return { result, category: tool.category };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const timedOut = err instanceof AtlasError && err.code === 'TIMEOUT';

      this.#recordToolCall(ctx, name, tool.category, started, true, message);


      if (timedOut) {
        ctx.logger.warn('tool timed out and was cancelled', { tool: name, error: message });
        // Rendu comme résultat d'outil, pas levé : l'agent garde la main pour
        // conclure avec ce qu'il a plutôt que de faire échouer toute l'étape.
        return {
          result: fail(
            `L'outil « ${name} » a dépassé son délai et a été annulé (${message}). ` +
              "Ne le relancez pas à l'identique : concluez avec ce que vous avez, ou changez d'approche.",
          ),
          category: tool.category,
        };
      }

      ctx.logger.error('tool threw', { tool: name, error: message });
      return {
        result: fail(`Tool "${name}" failed: ${message}`),
        category: tool.category,
      };
    }
  }

  /**
   * Consigne l'appel d'outil, réussi comme échoué.
   *
   * L'événement `agent.tool` est en sévérité `debug` et le journal d'événements
   * écarte le `debug` — si bien qu'un outil qui *réussit* ne laissait aucune
   * trace. L'économie d'une mission ne comptait donc que les échecs : LIVE #001
   * affichait « 5 appels externes » parce que les cinq avaient échoué.
   *
   * Seuls des faits sont conservés : nom, durée, issue. Jamais les arguments
   * ni la réponse.
   */
  #recordToolCall(
    ctx: ToolContext,
    name: string,
    category: string | null,
    started: number,
    isError: boolean,
    error: string | null,
    data?: Record<string, unknown>,
  ): void {
    if (!ctx.missionId) return;
    try {
      ctx.repos.toolCalls.record({
        missionId: ctx.missionId,
        taskRef: ctx.taskRef ?? null,
        agentKey: ctx.agentKey,
        tool: name,
        category,
        durationMs: Date.now() - started,
        ok: !isError,
        error: error ? error.slice(0, 300) : null,
        external: EXTERNAL_TOOLS.has(name),
        // L'outil seul sait ce qui identifie son appel et quelle en fut
        // l'issue métier ; la plateforme se contente de les conserver.
        signature: typeof data?.signature === 'string' ? data.signature : null,
        outcome: typeof data?.outcome === 'string' ? data.outcome : null,
        createdAt: nowIso(),
      });
    } catch (err) {
      // La comptabilité ne doit jamais faire échouer le travail qu'elle mesure.
      ctx.logger.warn('could not record tool call', { tool: name, error: describeError(err) });
    }
  }
}

/** Crude but dependency-free HTML → text, adequate for feeding a model. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export { ALL_TOOLS };
