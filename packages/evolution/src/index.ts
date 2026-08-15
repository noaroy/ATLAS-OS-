import type { Improvement, ImprovementChange } from '@atlas/contracts';
import type { EventBus, Logger } from '@atlas/core';
import { describeError, invalidState } from '@atlas/core';
import type { Repositories, RuntimeSettings } from '@atlas/data';
import type { MemoryService } from '@atlas/memory';
import type { LlmProvider } from '@atlas/llm';
import { nowIso } from '@atlas/core';
import { observe, detectImprovements, type ObservationReport, type Candidate } from './observations.ts';
import { EvolutionAnalyst } from './analyst.ts';

export * from './observations.ts';
export { EvolutionAnalyst } from './analyst.ts';

export interface EvolutionDeps {
  repos: Repositories;
  events: EventBus;
  memory: MemoryService;
  logger: Logger;
  settings: () => RuntimeSettings;
  /** Inference used by the Evolution Manager to reason over the signals. */
  provider: LlmProvider;
  maxTokens: number;
}

export interface EvolutionCycleResult {
  report: ObservationReport;
  proposed: Improvement[];
  autoApplied: Improvement[];
  skipped: number;
  /** The Evolution Manager's written assessment, when it was able to produce one. */
  assessment: string | null;
  /** True when the agent could not be used and only raw signals were considered. */
  degraded: boolean;
}

/**
 * The improvement loop: observe → analyse → propose → (approve) → apply → learn
 * (SRS §3.12, §6.8).
 *
 * Two invariants make self-improvement safe to leave running:
 *   1. Only changes expressible as `ImprovementChange` can ever be applied —
 *      a declarative, closed set. There is no path from here to running code.
 *   2. Every application snapshots the prior value first, so any change can be
 *      reverted exactly, by the founder, at any time.
 */
export class EvolutionEngine {
  #log: Logger;
  #analyst: EvolutionAnalyst;

  constructor(private readonly deps: EvolutionDeps) {
    this.#log = deps.logger.child({ scope: 'evolution' });
    this.#analyst = new EvolutionAnalyst(deps.provider, deps.logger);
  }

  /** One full cycle. Called on a schedule by the runtime supervisor. */
  async runCycle(): Promise<EvolutionCycleResult> {
    const settings = this.deps.settings();
    const report = observe(this.deps.repos);

    this.deps.events.publish({
      type: 'evolution.observed',
      severity: 'debug',
      source: 'evolution',
      message: `Observed ${report.agents.length} agents and ${report.failureClusters.length} failure pattern(s)`,
      payload: {
        missions: report.missions,
        failureClusters: report.failureClusters.length,
        memory: report.memory.total,
      },
    });

    if (!settings.evolutionEnabled || settings.evolutionAutonomy === 'observe') {
      return { report, proposed: [], autoApplied: [], skipped: 0, assessment: null, degraded: false };
    }

    // Threshold rules produce signals; the Evolution Manager decides what,
    // if anything, they mean.
    const signals = detectImprovements(report, {
      taskMaxAttempts: settings.taskMaxAttempts,
      maxConcurrentMissions: settings.maxConcurrentMissions,
      memoryRetention: settings.memoryRetention as unknown as Record<string, number>,
    });

    const analysis = await this.#consultEvolutionManager(report, signals, settings);
    const candidates = analysis.candidates;

    const proposed: Improvement[] = [];
    const autoApplied: Improvement[] = [];
    let skipped = 0;

    for (const candidate of candidates) {
      const improvement = this.#propose(candidate);
      if (!improvement) {
        // An identical proposal is already open — the founder has it.
        skipped++;
        continue;
      }
      proposed.push(improvement);

      // Autonomy never extends past low-risk changes. Anything that could
      // alter judgement quality waits for a human decision.
      if (settings.evolutionAutonomy === 'apply-low-risk' && improvement.risk === 'low') {
        try {
          autoApplied.push(this.apply(improvement.id, 'auto'));
        } catch (err) {
          this.#log.warn('auto-apply failed', { id: improvement.id, error: describeError(err) });
        }
      }
    }

    if (proposed.length > 0) {
      this.#log.info('improvements proposed', { count: proposed.length, autoApplied: autoApplied.length });
    }

    return {
      report,
      proposed,
      autoApplied,
      skipped,
      assessment: analysis.assessment || null,
      degraded: analysis.degraded,
    };
  }

  /**
   * Puts the Evolution Manager to work on the signals (SRS §4.11).
   *
   * The agent is looked up by mandate, shown as working in the village
   * while it reasons, and its recommendation is recorded as a message to
   * Hermes — so this is a real handoff inside the organisation, not a label.
   *
   * If the agent is missing, disabled, or its output does not survive
   * validation, the raw signals are used instead and the cycle is marked
   * degraded rather than silently substituting a different judgement.
   */
  async #consultEvolutionManager(
    report: ObservationReport,
    signals: Candidate[],
    settings: RuntimeSettings,
  ): Promise<{ candidates: Candidate[]; assessment: string; degraded: boolean }> {
    const advisors = this.deps.repos.agents.listByMandate('system-analysis');
    const agent = advisors.find((a) => a.mandates.includes('advisory')) ?? advisors[0];

    if (!agent) {
      this.#log.warn('no agent carries the system-analysis mandate; using raw signals');
      return { candidates: signals, assessment: '', degraded: true };
    }

    this.deps.repos.agents.setState(agent.key, {
      status: 'analyzing',
      currentActivity: 'Reviewing how ATLAS is performing',
      lastActiveAt: nowIso(),
    });

    try {
      const outcome = await this.#analyst.analyse(
        agent,
        {
          report,
          signals,
          agentKeys: this.deps.repos.agents.listDefinitions().map((a) => a.key),
          workflowKeys: this.deps.repos.workflows.list().map((w) => w.key),
          memoryTiers: ['operational', 'strategic', 'business'],
        },
        {
          model: settings.hermesModel,
          effort: settings.llmEffort,
          maxTokens: this.deps.maxTokens,
        },
      );

      if (!outcome.degraded) {
        // The recommendation is transmitted to Hermes, which is what makes it
        // part of the organisation's communication trail rather than a
        // side-channel inside the evolution loop.
        this.deps.repos.messages.record({
          from: agent.key,
          to: 'hermes',
          kind: 'handoff',
          objective: 'Continuous improvement review',
          payload: {
            assessment: outcome.assessment.slice(0, 4000),
            recommendations: outcome.candidates.map((c) => ({
              title: c.title,
              risk: c.risk,
              change: c.change,
            })),
          },
          expectedOutput: 'A decision on each recommendation',
          status: 'delivered',
        });

        this.deps.events.publish({
          type: 'evolution.analysed',
          severity: 'info',
          source: agent.key,
          agentKey: agent.key,
          message: `${agent.name} reviewed the organisation and raised ${outcome.candidates.length} recommendation(s)`,
          payload: {
            assessment: outcome.assessment.slice(0, 600),
            recommendations: outcome.candidates.length,
            signalsConsidered: signals.length,
          },
        });

        // The assessment is worth keeping even when no change follows from it.
        if (outcome.assessment) {
          this.deps.memory.remember({
            kind: 'insight',
            title: `Performance review — ${new Date().toISOString().slice(0, 10)}`,
            content: outcome.assessment,
            tags: ['evolution', 'performance'],
            agentKey: agent.key,
            importance: 0.6,
          });
        }
      }

      return {
        candidates: outcome.candidates,
        assessment: outcome.assessment,
        degraded: outcome.degraded,
      };
    } finally {
      this.deps.repos.agents.setState(agent.key, {
        status: 'available',
        currentActivity: null,
        lastActiveAt: nowIso(),
      });
    }
  }

  #propose(candidate: Candidate): Improvement | null {
    const improvement = this.deps.repos.improvements.propose({
      title: candidate.title,
      category: candidate.category,
      rationale: candidate.rationale,
      evidence: candidate.evidence,
      change: candidate.change,
      impact: candidate.impact,
      risk: candidate.risk,
      proposedBy: 'evolution-manager',
    });
    if (!improvement) return null;

    this.deps.events.publish({
      type: 'evolution.proposed',
      severity: 'info',
      source: 'evolution-manager',
      message: `Improvement proposed: ${improvement.title}`,
      payload: {
        improvementId: improvement.id,
        category: improvement.category,
        risk: improvement.risk,
        impact: improvement.impact,
      },
    });

    return improvement;
  }

  approve(improvementId: string, decidedBy: string): Improvement {
    const improvement = this.deps.repos.improvements.require(improvementId);
    if (improvement.status !== 'proposed') {
      throw invalidState(`Improvement is ${improvement.status} and cannot be approved`);
    }
    this.deps.repos.improvements.setStatus(improvementId, 'approved', { decidedBy });
    return this.apply(improvementId, decidedBy);
  }

  reject(improvementId: string, decidedBy: string): Improvement {
    const improvement = this.deps.repos.improvements.require(improvementId);
    if (improvement.status !== 'proposed') {
      throw invalidState(`Improvement is ${improvement.status} and cannot be rejected`);
    }
    return this.deps.repos.improvements.setStatus(improvementId, 'rejected', { decidedBy });
  }

  /**
   * Applies a change, capturing the prior state first.
   *
   * The snapshot is taken before mutation and stored with the improvement, so
   * a revert restores exactly what was there — not a guess at a default.
   */
  apply(improvementId: string, decidedBy: string): Improvement {
    const improvement = this.deps.repos.improvements.require(improvementId);
    if (!['proposed', 'approved'].includes(improvement.status)) {
      throw invalidState(`Improvement is ${improvement.status} and cannot be applied`);
    }

    let revertData: Record<string, unknown>;
    try {
      revertData = this.#snapshot(improvement.change);
      this.#mutate(improvement.change);
    } catch (err) {
      this.deps.repos.improvements.setStatus(improvementId, 'failed', { decidedBy });
      this.#log.error('improvement could not be applied', {
        id: improvementId,
        error: describeError(err),
      });
      throw err;
    }

    const applied = this.deps.repos.improvements.setStatus(improvementId, 'applied', {
      decidedBy,
      revertData,
    });

    this.deps.events.publish({
      type: 'evolution.applied',
      severity: 'success',
      source: 'evolution',
      message: `Improvement applied: ${applied.title}`,
      payload: { improvementId, change: applied.change, decidedBy },
    });

    // Record the change as a lesson so future analysis knows it was tried.
    this.deps.memory.remember({
      kind: 'procedure',
      title: `System change: ${applied.title}`,
      content: [
        applied.rationale,
        '',
        `Change applied: ${JSON.stringify(applied.change)}`,
        `Decided by: ${decidedBy}. Reversible: yes.`,
      ].join('\n'),
      tags: ['evolution', applied.category],
      importance: 0.75,
    });

    return applied;
  }

  /** Restores the snapshot taken at apply time. */
  revert(improvementId: string, decidedBy: string): Improvement {
    const improvement = this.deps.repos.improvements.require(improvementId);
    if (improvement.status !== 'applied') {
      throw invalidState(`Only an applied improvement can be reverted (this one is ${improvement.status})`);
    }
    if (!improvement.revertData) {
      throw invalidState('No revert snapshot was recorded for this improvement');
    }

    this.#restore(improvement.change, improvement.revertData);
    const reverted = this.deps.repos.improvements.setStatus(improvementId, 'reverted', { decidedBy });

    this.deps.events.publish({
      type: 'evolution.reverted',
      severity: 'warning',
      source: 'evolution',
      message: `Improvement reverted: ${reverted.title}`,
      payload: { improvementId, decidedBy },
    });

    return reverted;
  }

  // ─── Change application ──────────────────────────────────────────────────

  #snapshot(change: ImprovementChange): Record<string, unknown> {
    switch (change.type) {
      case 'agent.setting': {
        const agent = this.deps.repos.agents.getDefinition(change.agentKey);
        if (!agent) throw invalidState(`Agent '${change.agentKey}' no longer exists`);
        return { previous: agent[change.field] };
      }
      case 'agent.prompt.append': {
        const agent = this.deps.repos.agents.getDefinition(change.agentKey);
        if (!agent) throw invalidState(`Agent '${change.agentKey}' no longer exists`);
        return { previousPrompt: agent.systemPrompt };
      }
      case 'orchestration.setting':
        return { previous: this.deps.repos.settings.get(`orchestration.${change.key}`, null) };
      case 'workflow.toggle': {
        const workflow = this.deps.repos.workflows.getByKey(change.workflowKey);
        if (!workflow) throw invalidState(`Workflow '${change.workflowKey}' no longer exists`);
        return { previousEnabled: workflow.enabled };
      }
      case 'memory.retention':
        return {
          previous: this.deps.repos.settings.get('memory.retention', {
            operational: 0.2,
            strategic: 0.1,
            business: 0.1,
          }),
        };
    }
  }

  #mutate(change: ImprovementChange): void {
    switch (change.type) {
      case 'agent.setting': {
        this.deps.repos.agents.updateDefinition(change.agentKey, {
          [change.field]: change.value,
        } as never);
        return;
      }
      case 'agent.prompt.append': {
        const agent = this.deps.repos.agents.getDefinition(change.agentKey)!;
        // Appended guidance is fenced so a later revert can never leave a
        // half-removed instruction behind.
        const marker = '\n\n<!-- evolution guidance -->\n';
        this.deps.repos.agents.updateDefinition(change.agentKey, {
          systemPrompt: `${agent.systemPrompt}${marker}${change.guidance}`,
        });
        return;
      }
      case 'orchestration.setting':
        this.deps.repos.settings.set(`orchestration.${change.key}`, change.value, 'evolution');
        return;
      case 'workflow.toggle':
        this.deps.repos.workflows.setEnabled(change.workflowKey, change.enabled);
        return;
      case 'memory.retention': {
        const current = this.deps.repos.settings.get('memory.retention', {
          operational: 0.2,
          strategic: 0.1,
          business: 0.1,
        });
        this.deps.repos.settings.set(
          'memory.retention',
          { ...current, [change.tier]: change.minImportance },
          'evolution',
        );
        return;
      }
    }
  }

  #restore(change: ImprovementChange, revertData: Record<string, unknown>): void {
    switch (change.type) {
      case 'agent.setting':
        this.deps.repos.agents.updateDefinition(change.agentKey, {
          [change.field]: revertData.previous,
        } as never);
        return;
      case 'agent.prompt.append':
        this.deps.repos.agents.updateDefinition(change.agentKey, {
          systemPrompt: String(revertData.previousPrompt ?? ''),
        });
        return;
      case 'orchestration.setting':
        this.deps.repos.settings.set(`orchestration.${change.key}`, revertData.previous, 'evolution');
        return;
      case 'workflow.toggle':
        this.deps.repos.workflows.setEnabled(change.workflowKey, Boolean(revertData.previousEnabled));
        return;
      case 'memory.retention':
        this.deps.repos.settings.set('memory.retention', revertData.previous, 'evolution');
        return;
    }
  }
}
