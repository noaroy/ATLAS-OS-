import type { Logger } from '@atlas/core';
import { openDatabase, type Db } from './database.ts';
import { UserRepository } from './repositories/users.ts';
import { SettingsRepository } from './repositories/settings.ts';
import { AgentRepository, BuildingRepository } from './repositories/agents.ts';
import { SkillRepository } from './repositories/skills.ts';
import { MissionRepository } from './repositories/missions.ts';
import { MessageRepository } from './repositories/messages.ts';
import { EventRepository } from './repositories/events.ts';
import { MemoryRepository } from './repositories/memory.ts';
import { WorkflowRepository } from './repositories/workflows.ts';
import { ImprovementRepository } from './repositories/improvements.ts';
import { OpsRepository } from './repositories/ops.ts';
import { DepartmentRepository } from './repositories/departments.ts';
import { CompanyRepository } from './repositories/companies.ts';
import { OpportunityRepository } from './repositories/opportunities.ts';
import { LlmCallRepository } from './repositories/llm-calls.ts';
import { OrderRepository } from './repositories/orders.ts';
import { SalesRepository } from './repositories/sales.ts';
import { ToolCallRepository } from './repositories/tool-calls.ts';
import { DecisionRepository } from './repositories/decisions.ts';

export * from './database.ts';
export * from './migrations.ts';
export { UserRepository } from './repositories/users.ts';
export { SettingsRepository, type RuntimeSettings } from './repositories/settings.ts';
export { AgentRepository, BuildingRepository } from './repositories/agents.ts';
export { SkillRepository } from './repositories/skills.ts';
export { MissionRepository } from './repositories/missions.ts';
export { MessageRepository } from './repositories/messages.ts';
export { EventRepository } from './repositories/events.ts';
export { MemoryRepository } from './repositories/memory.ts';
export { WorkflowRepository } from './repositories/workflows.ts';
export { ImprovementRepository, fingerprintChange } from './repositories/improvements.ts';
export { OpsRepository } from './repositories/ops.ts';
export { DepartmentRepository } from './repositories/departments.ts';
export { CompanyRepository, type UpsertCompanyInput } from './repositories/companies.ts';
export { OpportunityRepository } from './repositories/opportunities.ts';
export * from './repositories/llm-calls.ts';
export * from './repositories/tool-calls.ts';

/**
 * The complete persistence surface, assembled once at boot and injected
 * everywhere. No module reaches for the raw connection except through here.
 */
export interface Repositories {
  db: Db;
  users: UserRepository;
  settings: SettingsRepository;
  skills: SkillRepository;
  agents: AgentRepository;
  buildings: BuildingRepository;
  missions: MissionRepository;
  messages: MessageRepository;
  events: EventRepository;
  memory: MemoryRepository;
  workflows: WorkflowRepository;
  improvements: ImprovementRepository;
  ops: OpsRepository;
  departments: DepartmentRepository;
  companies: CompanyRepository;
  opportunities: OpportunityRepository;
  llmCalls: LlmCallRepository;
  orders: OrderRepository;
  sales: SalesRepository;
  toolCalls: ToolCallRepository;
  decisions: DecisionRepository;
  close(): void;
}

export function createRepositories(databaseFile: string, logger: Logger): Repositories {
  const db = openDatabase(databaseFile, logger);
  const skills = new SkillRepository(db);

  // Agents resolve their tool allow-list through the skill registry, so a
  // skill that is withdrawn immediately narrows every agent that held it.
  const skillTools = (declared: readonly string[]): string[] => {
    const tools = new Set<string>();
    for (const key of declared) {
      const skill = skills.get(key);
      if (!skill?.enabled) continue;
      for (const tool of skill.tools) tools.add(tool);
    }
    return [...tools].sort();
  };

  return {
    db,
    users: new UserRepository(db),
    settings: new SettingsRepository(db),
    skills,
    agents: new AgentRepository(db, skillTools),
    buildings: new BuildingRepository(db),
    missions: new MissionRepository(db),
    messages: new MessageRepository(db),
    events: new EventRepository(db),
    memory: new MemoryRepository(db),
    workflows: new WorkflowRepository(db),
    improvements: new ImprovementRepository(db),
    ops: new OpsRepository(db),
    departments: new DepartmentRepository(db),
    companies: new CompanyRepository(db),
    opportunities: new OpportunityRepository(db),
    llmCalls: new LlmCallRepository(db),
    orders: new OrderRepository(db),
    sales: new SalesRepository(db),
    toolCalls: new ToolCallRepository(db),
    decisions: new DecisionRepository(db),
    close() {
      // A WAL checkpoint on shutdown keeps the main file self-contained, so a
      // backup taken right after a stop is complete on its own.
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        /* best effort — never block shutdown on a checkpoint */
      }
      db.close();
    },
  };
}

export { OrderRepository } from './repositories/orders.ts';
export type {
  ClientOrder,
  ClientReportRow,
  OrderStatus,
} from './repositories/orders.ts';

export { SalesRepository } from './repositories/sales.ts';
export type {
  SalesProspect,
  SalesEvidence,
  ProspectState,
  ProspectTier,
} from './repositories/sales.ts';
