import type { AgentDefinition, MissionPlan, MissionPlanStep, PlaybookStage } from '@atlas/contracts';
import { badRequest } from '@atlas/core';

/**
 * Turning a department's method into a concrete plan.
 *
 * A playbook is why a department is a product rather than a prompt: its method
 * is declared, reviewable and reproducible instead of reinvented on every run.
 * Hermes still owns orchestration — dispatch, supervision, replanning — but it
 * does not redesign a division's process for each job (Articles III and IV).
 */

/** Fills `{{field}}` placeholders from the mission brief. */
export function renderTemplate(template: string, brief: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    const value = path.split('.').reduce<unknown>((acc, key) => {
      if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
      return undefined;
    }, brief);
    return renderValue(value);
  });
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return 'unspecified';
  if (Array.isArray(value)) return value.length ? value.map(renderValue).join(', ') : 'unspecified';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export interface InstantiateInput {
  playbook: readonly PlaybookStage[];
  brief: Record<string, unknown>;
  /** Agents eligible to receive work, for validating the method is runnable. */
  agents: readonly AgentDefinition[];
  departmentName: string;
  producedBy: string;
  producedAt: string;
}

/**
 * Builds the mission plan from a playbook.
 *
 * Validated before anything is dispatched: a stage assigned to a missing agent,
 * or to one lacking a skill the stage requires, is a broken method and must
 * fail loudly at planning time rather than halfway through a paid run.
 */
export function instantiatePlaybook(input: InstantiateInput): MissionPlan {
  if (input.playbook.length === 0) throw badRequest('The department declares no playbook');

  const byKey = new Map(input.agents.map((a) => [a.key, a]));
  const refs = new Set(input.playbook.map((stage) => stage.ref));

  const steps: MissionPlanStep[] = input.playbook.map((stage) => {
    const agent = byKey.get(stage.agentKey);
    if (!agent) {
      throw badRequest(
        `Playbook stage '${stage.ref}' is assigned to '${stage.agentKey}', which is not available for mission work`,
      );
    }

    const missing = stage.requiredSkills.filter((skill) => !agent.skills.includes(skill));
    if (missing.length > 0) {
      throw badRequest(
        `Playbook stage '${stage.ref}' needs skill(s) ${missing.join(', ')}, which ${agent.name} does not hold`,
      );
    }

    const unknownDeps = stage.dependsOn.filter((ref) => !refs.has(ref));
    if (unknownDeps.length > 0) {
      throw badRequest(`Playbook stage '${stage.ref}' depends on unknown stage(s) ${unknownDeps.join(', ')}`);
    }

    return {
      ref: stage.ref,
      title: renderTemplate(stage.title, input.brief),
      agentKey: stage.agentKey,
      action: stage.action,
      instruction: renderTemplate(stage.instruction, input.brief),
      input: {
        team: stage.teamKey,
        stage: stage.advancesTo,
        brief: input.brief,
      },
      expectedOutput: renderTemplate(stage.expectedOutput, input.brief),
      dependsOn: [...stage.dependsOn],
      // Ce que l'étape exige d'avoir reçu, transporté tel quel jusqu'à la
      // tâche : c'est l'orchestrateur qui l'évaluera, avant tout appel LLM.
      preconditions: stage.preconditions ? [...stage.preconditions] : [],
    };
  });

  return {
    summary: `${input.departmentName} standard method, ${steps.length} stages.`,
    rationale:
      `This objective belongs to ${input.departmentName}, so Hermes applied that department's ` +
      `declared method rather than improvising a decomposition. Each stage is owned by a team ` +
      `and produces a checkable output the next stage depends on.`,
    strategy: input.playbook.map((s) => `${s.ref}: ${s.teamKey}`).join(' → '),
    steps,
    producedBy: input.producedBy,
    producedAt: input.producedAt,
  };
}
