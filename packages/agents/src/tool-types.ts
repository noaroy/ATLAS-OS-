import type { z } from 'zod';
import type { AgentKey, MissionId, SkillCategory, TaskId } from '@atlas/contracts';
import type { AtlasConfig, EventBus, Logger } from '@atlas/core';
import type { Repositories } from '@atlas/data';
import type { MemoryService } from '@atlas/memory';
import type { DiscoveryService, OpportunityService } from '@atlas/intelligence';

/**
 * Narrow gateway to the automation layer.
 *
 * Declaring the interface here rather than importing `@atlas/automation`
 * keeps the dependency pointing one way: agents know that workflows can be
 * triggered, not how n8n works.
 */
export interface AutomationGateway {
  trigger(
    workflowKey: string,
    payload: Record<string, unknown>,
    missionId: MissionId | null,
  ): Promise<{ status: 'success' | 'failure'; output: Record<string, unknown> | null; error?: string }>;
  listWorkflowKeys(): string[];
}

export interface ToolContext {
  missionId: MissionId | null;
  taskId: TaskId | null;
  /**
   * Ref de l'étape servie, pour imputer le coût.
   *
   * `taskId` est une clé technique ; `taskRef` est ce que le fondateur lit dans
   * un rapport. Sans elle, le coût de la recherche de LIVE #002 apparaissait
   * « hors étape » alors qu'il appartenait manifestement à la découverte.
   */
  taskRef: string | null;
  agentKey: AgentKey;
  /** Le département qui commande le travail, quand il y en a un. */
  departmentKey?: string | null;
  config: AtlasConfig;
  repos: Repositories;
  memory: MemoryService;
  events: EventBus;
  logger: Logger;
  automation: AutomationGateway | null;
  /** The opportunity pipeline. Null in deployments without a department. */
  intelligence: OpportunityService | null;
  /** Résout une requête de découverte auprès des providers configurés. */
  discovery: DiscoveryService | null;
  signal?: AbortSignal;
}

export interface ToolResult {
  /** Text handed back to the model as the tool result. */
  content: string;
  isError: boolean;
  /** Structured data kept in the task record for the console and downstream steps. */
  data?: Record<string, unknown>;
}

/**
 * A concrete action ATLAS can perform.
 *
 * A tool is the *implementation*; a Skill is the reusable know-how it provides
 * (Article VII). Agents declare skills, never tools, and the allow-list is
 * derived — so a tool cannot be granted without the skill that justifies it.
 *
 * `inputSchema` is hand-written JSON Schema (what the model sees) and `parse`
 * is the zod validator (what ATLAS trusts). Keeping both explicit means the
 * model's contract and the runtime's guarantees are each stated once.
 */
export interface AtlasTool<TInput = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  parse: z.ZodType<TInput>;
  /** Shares the Skill vocabulary, so one taxonomy describes both. */
  category: SkillCategory;
  /**
   * Cet outil clôt-il une unité de travail indépendante ?
   *
   * Quand il réussit, tout ce qui a servi à y arriver cesse d'être utile : le
   * contexte accumulé est remplacé par une ligne de relevé, et l'unité
   * suivante repart à propre.
   *
   * L'enrichissement de VAL-003 l'a montré par la mesure. Chaque candidat
   * enrichi restait dans la conversation, donc l'entrée croissait à chaque
   * appel : 5 710 jetons au premier, 32 443 au huitième — 178 584 en tout pour
   * cinq candidats. Le coût suivait le carré du nombre de candidats, quand le
   * travail, lui, était strictement proportionnel.
   *
   * L'enrichissement de l'entreprise B n'a aucun besoin de savoir ce qui a été
   * trouvé sur l'entreprise A. Le lui envoyer ne l'aide pas : cela le fait
   * seulement payer plus cher, et raisonner sur un contexte plus bruyant.
   */
  boundary?: boolean;
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}

export const ok = (content: string, data?: Record<string, unknown>): ToolResult => ({
  content,
  isError: false,
  ...(data ? { data } : {}),
});

/**
 * Un échec d'outil, avec ce qu'il faut pour le diagnostiquer.
 *
 * Les données accompagnent l'échec au même titre que le succès : sans elles, la
 * télémétrie perd la nature de la panne. LIVE #003 ne pouvait pas distinguer
 * « recherche impossible » de « marché vide » précisément parce que l'échec ne
 * portait qu'un message.
 */
export const fail = (content: string, data?: Record<string, unknown>): ToolResult => ({
  content,
  isError: true,
  ...(data ? { data } : {}),
});
