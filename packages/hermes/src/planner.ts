import type { AgentDefinition, Mission, MissionPlan, MissionPlanStep } from '@atlas/contracts';
import type { Logger } from '@atlas/core';
import { nowIso } from '@atlas/core';
import type { LlmProvider } from '@atlas/llm';
import { parseJsonObject, textOf, totalTokens, userText } from '@atlas/llm';
import type { MemoryService } from '@atlas/memory';

export interface PlanRequest {
  mission: Mission;
  agents: AgentDefinition[];
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens: number;
  signal?: AbortSignal;
}

export interface ReplanRequest {
  mission: Mission;
  agents: AgentDefinition[];
  completed: Array<{ ref: string; title: string; agentKey: string; summary: string }>;
  abandoned: Array<{ ref: string; title: string; agentKey: string; error: string }>;
  failedStep: { ref: string; title: string; error: string };
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens: number;
  signal?: AbortSignal;
}

export interface PlanOutcome {
  plan: MissionPlan;
  tokensUsed: number;
  /** True when planning fell back to the deterministic decomposition. */
  degraded: boolean;
}

interface RawPlan {
  summary?: string;
  rationale?: string;
  strategy?: string;
  steps?: Array<{
    ref?: string;
    title?: string;
    agentKey?: string;
    action?: string;
    instruction?: string;
    expectedOutput?: string;
    dependsOn?: string[];
  }>;
}

const MAX_STEPS = 12;

/** A plan with no steps: Hermes concluded the objective cannot be advanced. */
function emptyPlan(mission: Mission, reason: string): MissionPlan {
  return {
    summary: `No further steps for ${mission.title}`,
    rationale: `Replanning did not produce a usable remainder (${reason}).`,
    strategy: 'Conclude with the results already obtained.',
    steps: [],
    producedBy: 'hermes-replanner',
    producedAt: nowIso(),
  };
}

/**
 * Turns an objective into a plan (SRS §5.6, steps 2–3).
 *
 * Hermes decides *what* must happen and *who* should do it. The schema
 * enumerates the agents that actually exist, so the model cannot address a
 * specialist ATLAS does not employ; everything else is validated afterwards.
 */
export class MissionPlanner {
  #log: Logger;

  constructor(
    private readonly provider: LlmProvider,
    private readonly memory: MemoryService,
    logger: Logger,
  ) {
    this.#log = logger.child({ scope: 'hermes:planner' });
  }

  async plan(request: PlanRequest): Promise<PlanOutcome> {
    const { mission, agents } = request;
    if (agents.length === 0) {
      throw new Error('Cannot plan a mission with no enabled agents');
    }

    try {
      const response = await this.provider.complete({
        model: request.model,
        system: this.#systemPrompt(agents),
        messages: [userText(this.#userPrompt(mission))],
        maxTokens: request.maxTokens,
        effort: request.effort,
        jsonSchema: this.#schema(agents),
        meta: { missionId: mission.id, purpose: 'plan' },
        signal: request.signal,
      });

      if (response.refusal) {
        this.#log.warn('planner declined', { category: response.refusal.category });
        return this.#fallback(mission, agents, 'The model declined to plan this objective.');
      }

      const parsed = parseJsonObject<RawPlan>(textOf(response.content));
      if (!parsed.ok) {
        this.#log.warn('planner returned unparseable output', { error: parsed.error });
        return this.#fallback(mission, agents, parsed.error);
      }

      const steps = this.#validateSteps(parsed.value.steps ?? [], agents);
      if (steps.length === 0) {
        this.#log.warn('planner produced no usable steps');
        return this.#fallback(mission, agents, 'Plan contained no valid steps');
      }

      return {
        plan: {
          summary: parsed.value.summary?.trim() || mission.title,
          rationale: parsed.value.rationale?.trim() || 'Decomposed into specialist steps.',
          strategy: parsed.value.strategy?.trim() || 'Gather, analyse, deliver.',
          steps,
          producedBy: `${response.model} (${this.provider.kind})`,
          producedAt: nowIso(),
        },
        tokensUsed: totalTokens(response.usage),
        degraded: false,
      };
    } catch (err) {
      this.#log.error('planning failed, using deterministic fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.#fallback(mission, agents, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Reconsiders the remainder of a mission after a step it depended on failed.
   *
   * Deliberately narrower than planning from scratch: everything that already
   * succeeded is stated as fact and kept, and Hermes is asked only what should
   * happen *now*. It is allowed to answer "nothing" — an empty step list means
   * the objective cannot be advanced further, which is a valid conclusion.
   */
  async replan(request: ReplanRequest): Promise<PlanOutcome> {
    const { mission, agents } = request;

    try {
      const response = await this.provider.complete({
        model: request.model,
        system: [
          this.#systemPrompt(agents),
          '',
          '## You are replanning',
          'A step that later steps depended on has failed for good. The plan you made no longer holds.',
          'Decide what should happen now, given what has already been achieved.',
          'Do not repeat work that succeeded — its results are available to the steps you create.',
          'If the objective genuinely cannot be advanced any further, return an empty list of steps.',
        ].join('\n'),
        messages: [
          userText(
            [
              `# Objective\n${mission.objective}`,
              request.completed.length
                ? `# Already completed (results available)\n${request.completed
                    .map((c) => `- ${c.ref} (${c.agentKey}) ${c.title}\n  ${c.summary}`)
                    .join('\n')}`
                : '# Already completed\n(nothing)',
              `# What broke the plan\nStep ${request.failedStep.ref} — "${request.failedStep.title}" failed permanently: ${request.failedStep.error}`,
              request.abandoned.length
                ? `# Steps abandoned with it\n${request.abandoned
                    .map((a) => `- ${a.ref} ${a.title} (${a.error})`)
                    .join('\n')}`
                : '',
              'Produce the revised remainder now.',
            ]
              .filter(Boolean)
              .join('\n\n'),
          ),
        ],
        maxTokens: request.maxTokens,
        effort: request.effort,
        jsonSchema: this.#schema(agents, 0),
        meta: { missionId: mission.id, purpose: 'replan' },
        signal: request.signal,
      });

      if (response.refusal) {
        return { plan: emptyPlan(mission, 'The model declined to replan.'), tokensUsed: 0, degraded: true };
      }

      const parsed = parseJsonObject<RawPlan>(textOf(response.content));
      if (!parsed.ok) {
        this.#log.warn('replan output unparseable', { error: parsed.error });
        return {
          plan: emptyPlan(mission, parsed.error),
          tokensUsed: totalTokens(response.usage),
          degraded: true,
        };
      }

      // Steps carry fresh refs so they cannot collide with the refs of the
      // steps that survived.
      const steps = this.#validateSteps(parsed.value.steps ?? [], agents).map((step, index) => ({
        ...step,
        ref: `r${mission.replanCount + 1}-${index + 1}`,
      }));

      // Dependencies were validated against the model's own refs, which have
      // just been rewritten; remap by position and drop anything unresolved.
      const rawRefs = (parsed.value.steps ?? []).map((s) => s?.ref).filter(Boolean) as string[];
      const remap = new Map(rawRefs.map((original, index) => [original, steps[index]?.ref]));
      for (const step of steps) {
        step.dependsOn = step.dependsOn
          .map((d) => remap.get(d))
          .filter((d): d is string => Boolean(d));
      }

      return {
        plan: {
          summary: parsed.value.summary?.trim() || `Revised remainder of ${mission.title}`,
          rationale: parsed.value.rationale?.trim() || 'Revised after a prerequisite step failed.',
          strategy: parsed.value.strategy?.trim() || 'Recover the objective with the results already obtained.',
          steps,
          producedBy: `${response.model} (${this.provider.kind}, replan)`,
          producedAt: nowIso(),
        },
        tokensUsed: totalTokens(response.usage),
        degraded: false,
      };
    } catch (err) {
      this.#log.error('replanning failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        plan: emptyPlan(mission, err instanceof Error ? err.message : String(err)),
        tokensUsed: 0,
        degraded: true,
      };
    }
  }

  #systemPrompt(agents: AgentDefinition[]): string {
    const roster = agents
      .map(
        (a) =>
          `- ${a.key} (${a.name}, ${a.role})\n    specialism: ${a.mission}\n    actions: ${a.actions.join(', ')}\n    skills: ${a.skills.join(', ') || 'none'}`,
      )
      .join('\n');

    return [
      'You are Hermes, operations director of ATLAS — an autonomous digital organisation.',
      '',
      'A mission arrives as an objective. Your job is to decide what must happen, in what order, and which specialist should do each part. You do not perform the work yourself.',
      '',
      '## Your team',
      roster,
      '',
      '## How to decompose',
      '- Assign each step to the specialist whose stated specialism actually covers it. Never give an agent work outside its remit.',
      '- Prefer the smallest plan that fully achieves the objective. Three well-scoped steps beat eight thin ones.',
      '- Use `dependsOn` only for real data dependencies. Steps left independent run in parallel, so unnecessary dependencies cost wall-clock time.',
      '- Write each instruction as a complete brief: the agent sees only the objective, its own instruction, and the results it depends on.',
      '- If the objective produces something the founder will read or send, end with a step that creates the deliverable.',
      '- State in `rationale` why this decomposition — that reasoning is shown to the founder.',
    ].join('\n');
  }

  #userPrompt(mission: Mission): string {
    const sections = [`# Objective\n${mission.objective}`, `# Mission title\n${mission.title}`];

    if (Object.keys(mission.context).length > 0) {
      sections.push(`# Context supplied by the founder\n${JSON.stringify(mission.context, null, 2).slice(0, 4000)}`);
    }

    const briefing = this.memory.briefing(`${mission.title} ${mission.objective}`, { budget: 1800 });
    if (briefing) {
      sections.push(`# What ATLAS already knows\n${briefing}\n\nUse this to avoid re-doing work already done.`);
    }

    sections.push('Produce the plan now.');
    return sections.join('\n\n');
  }

  /** The agent roster becomes an enum, so plans can only address real agents. */
  #schema(agents: AgentDefinition[], minSteps = 1): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One sentence describing the intended outcome' },
        rationale: { type: 'string', description: 'Why this decomposition, shown to the founder' },
        strategy: { type: 'string', description: 'The approach in one or two sentences' },
        steps: {
          type: 'array',
          description: `Entre ${minSteps} et ${MAX_STEPS} étapes.`,
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string', description: 'Short unique id for this step, e.g. s1' },
              title: { type: 'string', description: 'What this step achieves' },
              agentKey: { type: 'string', enum: agents.map((a) => a.key) },
              action: { type: 'string', description: 'One of the chosen agent\'s advertised actions' },
              instruction: {
                type: 'string',
                description: 'Complete brief for the agent — it sees nothing else about the plan',
              },
              expectedOutput: { type: 'string', description: 'What this step must return' },
              dependsOn: {
                type: 'array',
                items: { type: 'string' },
                description: 'refs of steps whose results this step needs',
              },
            },
            required: ['ref', 'title', 'agentKey', 'action', 'instruction', 'expectedOutput', 'dependsOn'],
            additionalProperties: false,
          },
        },
      },
      required: ['summary', 'rationale', 'strategy', 'steps'],
      additionalProperties: false,
    };
  }

  /**
   * Repairs a plan into something safely executable.
   *
   * A plan is model output, so it is validated rather than trusted: unknown
   * agents, invented actions, dangling dependencies and cycles are all fixed
   * or dropped here, never at dispatch time.
   */
  #validateSteps(raw: NonNullable<RawPlan['steps']>, agents: AgentDefinition[]): MissionPlanStep[] {
    const byKey = new Map(agents.map((a) => [a.key, a]));
    const steps: MissionPlanStep[] = [];
    const seenRefs = new Set<string>();

    for (const [index, item] of raw.slice(0, MAX_STEPS).entries()) {
      const agent = item.agentKey ? byKey.get(item.agentKey) : undefined;
      if (!agent) {
        this.#log.warn('dropping step for unknown agent', { agentKey: item.agentKey });
        continue;
      }
      if (!item.instruction?.trim()) continue;

      let ref = (item.ref ?? `s${index + 1}`).trim().slice(0, 24) || `s${index + 1}`;
      while (seenRefs.has(ref)) ref = `${ref}-${seenRefs.size}`;
      seenRefs.add(ref);

      const action =
        item.action && agent.actions.includes(item.action) ? item.action : (agent.actions[0] ?? 'execute');

      steps.push({
        ref,
        title: (item.title ?? `Step ${index + 1}`).slice(0, 200),
        agentKey: agent.key,
        action,
        instruction: item.instruction.trim(),
        input: {},
        expectedOutput: (item.expectedOutput ?? 'A structured result for this step.').slice(0, 500),
        dependsOn: [],
      });
    }

    // Resolve dependencies only against steps that survived validation, and
    // only backwards — that alone makes cycles unrepresentable.
    const positionOf = new Map(steps.map((s, i) => [s.ref, i]));
    steps.forEach((step, index) => {
      const declared = raw[index]?.dependsOn ?? [];
      step.dependsOn = declared
        .map((d) => String(d).trim())
        .filter((d) => {
          const target = positionOf.get(d);
          return target !== undefined && target < index;
        });
    });

    return steps;
  }

  /**
   * Deterministic decomposition used when the model is unavailable or its plan
   * is unusable. A degraded plan is still a working mission — the founder is
   * told, and the mission proceeds rather than failing at the first hurdle.
   */
  #fallback(mission: Mission, agents: AgentDefinition[], reason: string): PlanOutcome {
    const pick = (key: string) => agents.find((a) => a.key === key);
    const explorer = pick('explorer') ?? agents[0]!;
    const analyst = pick('analyst') ?? explorer;
    const architect = pick('architect') ?? analyst;

    const steps: MissionPlanStep[] = [
      {
        ref: 's1',
        title: 'Gather source material',
        agentKey: explorer.key,
        action: explorer.actions[0] ?? 'research',
        instruction: `Gather the information needed to address this objective:\n\n${mission.objective}\n\nReturn well-sourced material, noting where evidence is thin.`,
        input: {},
        expectedOutput: 'Sourced material relevant to the objective.',
        dependsOn: [],
      },
      {
        ref: 's2',
        title: 'Analyse and prioritise',
        agentKey: analyst.key,
        action: analyst.actions[0] ?? 'analyze',
        instruction:
          'Analyse the gathered material against the mission objective. State your criteria, rank what matters, and give a clear recommendation with reasons.',
        input: {},
        expectedOutput: 'Analysis, ranking and a reasoned recommendation.',
        dependsOn: ['s1'],
      },
      {
        ref: 's3',
        title: 'Produce the deliverable',
        agentKey: architect.key,
        action: architect.actions[0] ?? 'produce-report',
        instruction:
          'Assemble the findings and analysis into a single deliverable for the founder. Lead with the conclusion, then the supporting evidence. Save it to the artifact store.',
        input: {},
        expectedOutput: 'A saved report answering the objective.',
        dependsOn: ['s2'],
      },
    ];

    return {
      plan: {
        summary: mission.title,
        rationale: `Standard three-stage decomposition applied because adaptive planning was unavailable (${reason}).`,
        strategy: 'Gather source material, analyse it, then produce the deliverable.',
        steps,
        producedBy: 'hermes-fallback-planner',
        producedAt: nowIso(),
      },
      tokensUsed: 0,
      degraded: true,
    };
  }
}
