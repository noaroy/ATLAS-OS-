import { z } from 'zod';
import type {
  AgentDefinition,
  Improvement,
  ImprovementChange,
  MemoryTier,
} from '@atlas/contracts';
import type { Logger } from '@atlas/core';
import { describeError } from '@atlas/core';
import type { LlmProvider } from '@atlas/llm';
import { parseJsonObject, textOf, totalTokens, userText } from '@atlas/llm';
import type { ObservationReport, Candidate } from './observations.ts';

/**
 * The Evolution Manager, actually doing its job (SRS §4.11).
 *
 * The heuristic detectors produce *signals*; this turns those signals plus the
 * observation report into a reasoned recommendation, written by the agent
 * whose persona and remit are defined for exactly that purpose.
 *
 * The agent never writes an `ImprovementChange` directly. It fills a flat,
 * enumerated form, which is then translated and validated into the closed
 * union — so a model that invents a change type, names an agent that does not
 * exist, or asks for something outside the union simply produces nothing.
 */

export interface AnalysisContext {
  report: ObservationReport;
  signals: Candidate[];
  agentKeys: string[];
  workflowKeys: string[];
  memoryTiers: MemoryTier[];
}

export interface AnalysisOutcome {
  assessment: string;
  candidates: Candidate[];
  tokensUsed: number;
  /** True when the agent could not be used and the raw signals stand alone. */
  degraded: boolean;
}

const CHANGE_TYPES = [
  'agent.setting',
  'agent.prompt.append',
  'orchestration.setting',
  'workflow.toggle',
  'memory.retention',
] as const;

const ORCHESTRATION_KEYS = [
  'taskMaxAttempts',
  'maxConcurrentTasks',
  'maxConcurrentMissions',
  'missionTokenBudget',
  'maxReplansPerMission',
] as const;

/** The shape the agent fills in. Flat and enumerated, never a raw union. */
const recommendationSchema = z.object({
  title: z.string().min(4).max(160),
  category: z.enum(['agent-tuning', 'orchestration', 'workflow', 'memory', 'reliability', 'performance']),
  rationale: z.string().min(10).max(2000),
  impact: z.enum(['low', 'medium', 'high']),
  risk: z.enum(['low', 'medium', 'high']),
  change: z.object({
    type: z.enum(CHANGE_TYPES),
    agentKey: z.string().optional(),
    field: z.enum(['maxSteps', 'model', 'enabled']).optional(),
    numberValue: z.number().optional(),
    textValue: z.string().max(2000).optional(),
    booleanValue: z.boolean().optional(),
    settingKey: z.enum(ORCHESTRATION_KEYS).optional(),
    workflowKey: z.string().optional(),
    tier: z.enum(['operational', 'strategic', 'business']).optional(),
  }),
});

const analysisSchema = z.object({
  assessment: z.string().min(10).max(4000),
  recommendations: z.array(recommendationSchema).max(5).default([]),
});

export class EvolutionAnalyst {
  #log: Logger;

  constructor(
    private readonly provider: LlmProvider,
    logger: Logger,
  ) {
    this.#log = logger.child({ scope: 'evolution:analyst' });
  }

  async analyse(
    agent: AgentDefinition,
    context: AnalysisContext,
    options: { model: string; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; maxTokens: number; signal?: AbortSignal },
  ): Promise<AnalysisOutcome> {
    try {
      const response = await this.provider.complete({
        model: agent.model ?? options.model,
        system: this.#systemPrompt(agent),
        messages: [userText(this.#briefing(context))],
        maxTokens: options.maxTokens,
        effort: options.effort,
        jsonSchema: this.#schema(context),
        signal: options.signal,
      });

      const tokensUsed = totalTokens(response.usage);

      if (response.refusal) {
        this.#log.warn('the Evolution Manager declined to analyse');
        return { assessment: '', candidates: context.signals, tokensUsed, degraded: true };
      }

      const parsed = parseJsonObject<unknown>(textOf(response.content));
      if (!parsed.ok) {
        this.#log.warn('analysis output unparseable', { error: parsed.error });
        return { assessment: '', candidates: context.signals, tokensUsed, degraded: true };
      }

      const validated = analysisSchema.safeParse(parsed.value);
      if (!validated.success) {
        this.#log.warn('analysis failed validation', {
          issues: validated.error.issues.slice(0, 3).map((i) => i.message),
        });
        return { assessment: '', candidates: context.signals, tokensUsed, degraded: true };
      }

      const candidates: Candidate[] = [];
      for (const recommendation of validated.data.recommendations) {
        const change = toChange(recommendation.change, context);
        if (!change) {
          this.#log.debug('discarded a recommendation that did not map to an allowed change', {
            type: recommendation.change.type,
          });
          continue;
        }
        candidates.push({
          title: recommendation.title,
          category: recommendation.category as Improvement['category'],
          rationale: recommendation.rationale,
          evidence: {
            source: 'evolution-manager',
            assessment: validated.data.assessment.slice(0, 600),
            missions: context.report.missions,
            failureClusters: context.report.failureClusters.slice(0, 3),
          },
          change,
          impact: recommendation.impact,
          risk: recommendation.risk,
        });
      }

      this.#log.info('Evolution Manager produced an analysis', {
        recommendations: validated.data.recommendations.length,
        usable: candidates.length,
      });

      return { assessment: validated.data.assessment, candidates, tokensUsed, degraded: false };
    } catch (err) {
      this.#log.error('analysis failed', { error: describeError(err) });
      return { assessment: '', candidates: context.signals, tokensUsed: 0, degraded: true };
    }
  }

  #systemPrompt(agent: AgentDefinition): string {
    return [
      agent.systemPrompt.trim(),
      '',
      '## This analysis',
      'You are reviewing how ATLAS itself has been performing. You are not working on a mission.',
      '',
      'You may only recommend changes from the fixed set offered in the response schema. That set is the',
      'boundary of what the organisation is permitted to change about itself — you cannot modify code,',
      'and you should not describe changes outside it.',
      '',
      'Prefer one well-evidenced recommendation over several plausible ones. Returning an empty list is a',
      'correct answer when the data does not support a change; say so in your assessment.',
      'Every recommendation must name the measurement that motivated it.',
    ].join('\n');
  }

  #briefing(context: AnalysisContext): string {
    const { report } = context;

    const agents = report.agents
      .map(
        (a) =>
          `- ${a.key}: ${a.tasks} steps, ${a.successRate}% success, avg ${Math.round(a.avgDurationMs / 1000)}s, quality ${a.qualityScore}`,
      )
      .join('\n');

    const failures = report.failureClusters.length
      ? report.failureClusters
          .map((c) => `- ${c.count}× across [${c.agents.join(', ')}]: ${c.sample}`)
          .join('\n')
      : '(none)';

    const signals = context.signals.length
      ? context.signals
          .map((s) => `- [${s.risk} risk] ${s.title} — ${s.rationale}`)
          .join('\n')
      : '(no automated signal fired)';

    return [
      '# Mission throughput',
      `total ${report.missions.total}, completed ${report.missions.completed}, failed ${report.missions.failed}`,
      '',
      '# Agent performance',
      agents || '(no agents have run yet)',
      '',
      '# Recurring failures',
      failures,
      '',
      '# Memory',
      `${report.memory.total} items — ${JSON.stringify(report.memory.byTier)}`,
      '',
      '# Automated signals',
      'These were raised by threshold rules. Treat them as observations to weigh, not conclusions to repeat.',
      signals,
      '',
      'Give your assessment and any recommendations now.',
    ].join('\n');
  }

  /**
   * The response schema. Agent and workflow names are enumerated from what
   * actually exists, so a recommendation cannot address something absent.
   */
  #schema(context: AnalysisContext): Record<string, unknown> {
    const changeProperties: Record<string, unknown> = {
      type: { type: 'string', enum: CHANGE_TYPES },
      settingKey: { type: 'string', enum: ORCHESTRATION_KEYS, description: 'For orchestration.setting' },
      field: { type: 'string', enum: ['maxSteps', 'model', 'enabled'], description: 'For agent.setting' },
      numberValue: { type: 'number', description: 'Numeric value, when the change takes one' },
      textValue: { type: 'string', description: 'Prompt guidance or model name' },
      booleanValue: { type: 'boolean', description: 'Boolean value, when the change takes one' },
      tier: {
        type: 'string',
        enum: context.memoryTiers,
        description: 'For memory.retention',
      },
    };

    if (context.agentKeys.length > 0) {
      changeProperties.agentKey = {
        type: 'string',
        enum: context.agentKeys,
        description: 'For agent.setting and agent.prompt.append',
      };
    }
    if (context.workflowKeys.length > 0) {
      changeProperties.workflowKey = {
        type: 'string',
        enum: context.workflowKeys,
        description: 'For workflow.toggle',
      };
    }

    return {
      type: 'object',
      properties: {
        assessment: {
          type: 'string',
          description: 'How ATLAS is performing, and what the evidence shows',
        },
        recommendations: {
          type: 'array',
          description: 'Three at most; none is a valid answer.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              category: {
                type: 'string',
                enum: ['agent-tuning', 'orchestration', 'workflow', 'memory', 'reliability', 'performance'],
              },
              rationale: {
                type: 'string',
                description: 'The measurement that motivated this, and the expected effect',
              },
              impact: { type: 'string', enum: ['low', 'medium', 'high'] },
              risk: { type: 'string', enum: ['low', 'medium', 'high'] },
              change: {
                type: 'object',
                properties: changeProperties,
                required: ['type'],
                additionalProperties: false,
              },
            },
            required: ['title', 'category', 'rationale', 'impact', 'risk', 'change'],
            additionalProperties: false,
          },
        },
      },
      required: ['assessment', 'recommendations'],
      additionalProperties: false,
    };
  }
}

type FlatChange = z.infer<typeof recommendationSchema>['change'];

/**
 * Translates the agent's flat form into the closed `ImprovementChange` union.
 *
 * Returns null for anything incoherent. This is the gate that keeps model
 * output from widening what the system is allowed to do to itself.
 */
function toChange(flat: FlatChange, context: AnalysisContext): ImprovementChange | null {
  switch (flat.type) {
    case 'agent.setting': {
      if (!flat.agentKey || !context.agentKeys.includes(flat.agentKey) || !flat.field) return null;

      if (flat.field === 'maxSteps') {
        const value = Math.round(flat.numberValue ?? 0);
        if (!Number.isFinite(value) || value < 1 || value > 30) return null;
        return { type: 'agent.setting', agentKey: flat.agentKey, field: 'maxSteps', value };
      }
      if (flat.field === 'enabled') {
        if (typeof flat.booleanValue !== 'boolean') return null;
        return { type: 'agent.setting', agentKey: flat.agentKey, field: 'enabled', value: flat.booleanValue };
      }
      if (flat.field === 'model') {
        const value = flat.textValue?.trim();
        if (!value || value.length > 80) return null;
        return { type: 'agent.setting', agentKey: flat.agentKey, field: 'model', value };
      }
      return null;
    }

    case 'agent.prompt.append': {
      const guidance = flat.textValue?.trim();
      if (!flat.agentKey || !context.agentKeys.includes(flat.agentKey)) return null;
      if (!guidance || guidance.length < 10) return null;
      return { type: 'agent.prompt.append', agentKey: flat.agentKey, guidance };
    }

    case 'orchestration.setting': {
      if (!flat.settingKey) return null;
      const value = Math.round(flat.numberValue ?? Number.NaN);
      if (!Number.isFinite(value)) return null;

      // Each dial has its own sane range; a recommendation outside it is
      // rejected rather than clamped, so the founder never approves a number
      // the agent did not actually propose.
      const bounds: Record<(typeof ORCHESTRATION_KEYS)[number], [number, number]> = {
        taskMaxAttempts: [1, 10],
        maxConcurrentTasks: [1, 20],
        maxConcurrentMissions: [1, 20],
        missionTokenBudget: [0, 10_000_000],
        maxReplansPerMission: [0, 5],
      };
      const [min, max] = bounds[flat.settingKey];
      if (value < min || value > max) return null;

      return { type: 'orchestration.setting', key: flat.settingKey, value };
    }

    case 'workflow.toggle': {
      if (!flat.workflowKey || !context.workflowKeys.includes(flat.workflowKey)) return null;
      if (typeof flat.booleanValue !== 'boolean') return null;
      return { type: 'workflow.toggle', workflowKey: flat.workflowKey, enabled: flat.booleanValue };
    }

    case 'memory.retention': {
      if (!flat.tier) return null;
      const minImportance = flat.numberValue ?? Number.NaN;
      if (!Number.isFinite(minImportance) || minImportance < 0 || minImportance > 1) return null;
      return { type: 'memory.retention', tier: flat.tier, minImportance };
    }

    default:
      return null;
  }
}

export { toChange as __toChangeForTests };
