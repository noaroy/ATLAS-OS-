import type { Improvement, ImprovementChange } from '@atlas/contracts';
import type { Repositories } from '@atlas/data';

/** A candidate improvement before it is persisted as a proposal. */
export interface Candidate {
  title: string;
  category: Improvement['category'];
  rationale: string;
  evidence: Record<string, unknown>;
  change: ImprovementChange;
  impact: Improvement['impact'];
  risk: Improvement['risk'];
}

export interface ObservationReport {
  agents: Array<{
    key: string;
    name: string;
    tasks: number;
    successRate: number;
    avgDurationMs: number;
    qualityScore: number;
  }>;
  failureClusters: Array<{ signature: string; count: number; agents: string[]; sample: string }>;
  workflows: Array<{ key: string; name: string; runs: number; lastStatus: string | null }>;
  memory: { total: number; byTier: Record<string, number> };
  missions: { total: number; failed: number; completed: number };
  generatedAt: string;
}

/**
 * The "observe" half of the improvement loop (SRS §3.12).
 *
 * Everything here is read-only measurement over what actually happened — no
 * inference, no model calls. Detectors downstream reason strictly about this
 * report, which is what makes each proposal traceable to evidence.
 */
export function observe(repos: Repositories): ObservationReport {
  const agents = repos.agents.listDefinitions().map((definition) => {
    const metrics = repos.agents.metricsFor(definition.key);
    return {
      key: definition.key,
      name: definition.name,
      tasks: metrics.tasksTotal,
      successRate: metrics.successRate,
      avgDurationMs: metrics.avgDurationMs,
      qualityScore: metrics.qualityScore,
    };
  });

  // Group failures by their normalised message so recurring faults surface as
  // one cluster rather than fifty individually-unremarkable errors.
  const clusters = new Map<string, { count: number; agents: Set<string>; sample: string }>();
  for (const task of repos.missions.recentFailures(120)) {
    const signature = normaliseError(task.error ?? 'unknown');
    const entry = clusters.get(signature) ?? { count: 0, agents: new Set<string>(), sample: task.error ?? '' };
    entry.count++;
    entry.agents.add(task.agentKey);
    clusters.set(signature, entry);
  }

  const counts = repos.missions.countsByStatus();

  return {
    agents,
    failureClusters: [...clusters.entries()]
      .map(([signature, entry]) => ({
        signature,
        count: entry.count,
        agents: [...entry.agents],
        sample: entry.sample.slice(0, 300),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    workflows: repos.workflows.list().map((w) => ({
      key: w.key,
      name: w.name,
      runs: w.runCount,
      lastStatus: w.lastStatus,
    })),
    memory: { total: repos.memory.total(), byTier: repos.memory.countByTier() },
    missions: {
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      failed: counts.failed ?? 0,
      completed: (counts.completed ?? 0) + (counts.validated ?? 0) + (counts.archived ?? 0),
    },
    generatedAt: new Date().toISOString(),
  };
}

/** Collapses ids, numbers and quotes so equivalent failures hash together. */
function normaliseError(message: string): string {
  return message
    .toLowerCase()
    .replace(/[a-z]{3}_[0-9a-z]{20,}/gi, '<id>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/["'`].*?["'`]/g, '<value>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/**
 * The "analyse and propose" half of the loop.
 *
 * Each detector encodes one operational judgement and must justify itself with
 * numbers from the report. Detectors only ever emit declarative, reversible
 * changes — the type system makes anything else unrepresentable (SRS §3.12).
 */
export function detectImprovements(
  report: ObservationReport,
  context: { taskMaxAttempts: number; maxConcurrentMissions: number; memoryRetention: Record<string, number> },
): Candidate[] {
  const candidates: Candidate[] = [];

  // ── Agents that fail more than they should ────────────────────────────
  for (const agent of report.agents) {
    if (agent.tasks >= 5 && agent.successRate < 70) {
      candidates.push({
        title: `Give ${agent.name} more room to complete its steps`,
        category: 'agent-tuning',
        rationale:
          `${agent.name} has completed ${agent.tasks} steps with a ${agent.successRate}% success rate. ` +
          `Raising its step allowance lets it recover from a failed tool call within the same step instead of failing outright.`,
        evidence: { agent: agent.key, tasks: agent.tasks, successRate: agent.successRate },
        change: { type: 'agent.setting', agentKey: agent.key, field: 'maxSteps', value: 12 },
        impact: 'medium',
        risk: 'low',
      });
    }

    // A slow, high-quality agent is fine; a slow, low-quality one is not.
    if (agent.tasks >= 8 && agent.avgDurationMs > 180_000 && agent.qualityScore < 70) {
      candidates.push({
        title: `Tighten ${agent.name}'s working instructions`,
        category: 'performance',
        rationale:
          `${agent.name} averages ${Math.round(agent.avgDurationMs / 1000)}s per step at a quality score of ` +
          `${agent.qualityScore}. Explicit guidance to converge sooner should cut time without costing quality.`,
        evidence: { agent: agent.key, avgDurationMs: agent.avgDurationMs, quality: agent.qualityScore },
        change: {
          type: 'agent.prompt.append',
          agentKey: agent.key,
          guidance:
            'Work efficiently: gather what the step genuinely needs, then conclude. Do not keep researching once you can answer.',
        },
        impact: 'medium',
        risk: 'medium',
      });
    }
  }

  // ── Recurring faults ──────────────────────────────────────────────────
  for (const cluster of report.failureClusters) {
    if (cluster.count < 3) continue;

    if (/timeout|rate.?limit|unreachable|provider/i.test(cluster.sample)) {
      const proposed = Math.min(6, context.taskMaxAttempts + 1);
      if (proposed > context.taskMaxAttempts) {
        candidates.push({
          title: 'Retry transient failures one more time',
          category: 'reliability',
          rationale:
            `A transient fault ("${cluster.sample.slice(0, 90)}") has caused ${cluster.count} step failures. ` +
            `These recover on retry, so one additional attempt should convert most of them into successes.`,
          evidence: { signature: cluster.signature, count: cluster.count, agents: cluster.agents },
          change: { type: 'orchestration.setting', key: 'taskMaxAttempts', value: proposed },
          impact: 'high',
          risk: 'low',
        });
      }
    }

    if (/step limit|no result|produced no/i.test(cluster.sample) && cluster.agents.length === 1) {
      const agentKey = cluster.agents[0]!;
      candidates.push({
        title: `Raise the step allowance for ${agentKey}`,
        category: 'agent-tuning',
        rationale:
          `${agentKey} has hit its step limit ${cluster.count} times, ending steps before they produced a result.`,
        evidence: { agent: agentKey, count: cluster.count, sample: cluster.sample },
        change: { type: 'agent.setting', agentKey, field: 'maxSteps', value: 14 },
        impact: 'medium',
        risk: 'low',
      });
    }
  }

  // ── Automation that keeps failing ─────────────────────────────────────
  for (const workflow of report.workflows) {
    if (workflow.runs >= 3 && workflow.lastStatus === 'failure') {
      candidates.push({
        title: `Disable the failing workflow "${workflow.name}"`,
        category: 'workflow',
        rationale:
          `"${workflow.name}" has run ${workflow.runs} times and its most recent run failed. ` +
          `Disabling it stops repeated failures from generating noise until it is fixed.`,
        evidence: { workflow: workflow.key, runs: workflow.runs, lastStatus: workflow.lastStatus },
        change: { type: 'workflow.toggle', workflowKey: workflow.key, enabled: false },
        impact: 'low',
        risk: 'low',
      });
    }
  }

  // ── Memory hygiene ────────────────────────────────────────────────────
  const operational = report.memory.byTier.operational ?? 0;
  if (operational > 800 && (context.memoryRetention.operational ?? 0.2) < 0.4) {
    candidates.push({
      title: 'Prune low-value operational memory more aggressively',
      category: 'memory',
      rationale:
        `Operational memory holds ${operational} entries. Raising the retention floor drops entries that were ` +
        `never recalled, which sharpens recall for the knowledge that is actually used.`,
      evidence: { operational, total: report.memory.total },
      change: { type: 'memory.retention', tier: 'operational', minImportance: 0.4 },
      impact: 'low',
      risk: 'low',
    });
  }

  return candidates;
}
