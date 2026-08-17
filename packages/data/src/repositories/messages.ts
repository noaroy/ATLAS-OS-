import type { AgentMessage, AgentMessageKind, MissionId } from '@atlas/contracts';
import { id, nowIso } from '@atlas/core';
import type { Db } from '../database.ts';
import { fromJson, toJson } from '../database.ts';

interface MessageRow {
  id: string;
  mission_id: string | null;
  task_id: string | null;
  from_actor: string;
  to_actor: string;
  kind: AgentMessageKind;
  objective: string;
  payload: string;
  expected_output: string | null;
  status: AgentMessage['status'];
  created_at: string;
}

const toMessage = (row: MessageRow): AgentMessage => ({
  id: row.id,
  missionId: row.mission_id,
  taskId: row.task_id,
  from: row.from_actor as AgentMessage['from'],
  to: row.to_actor as AgentMessage['to'],
  kind: row.kind,
  objective: row.objective,
  payload: fromJson<Record<string, unknown>>(row.payload, {}),
  expectedOutput: row.expected_output,
  status: row.status,
  createdAt: row.created_at,
});

/**
 * The structured communication layer (SRS §2.9 / §5.8).
 *
 * Every assignment, result, and handoff is recorded here, which is what lets
 * the Command Center answer "why did this agent do that" after the fact.
 */
export class MessageRepository {
  constructor(private readonly db: Db) {}

  record(input: {
    missionId?: MissionId | null;
    taskId?: string | null;
    from: string;
    to: string;
    kind: AgentMessageKind;
    objective: string;
    payload?: Record<string, unknown>;
    expectedOutput?: string | null;
    status?: AgentMessage['status'];
  }): AgentMessage {
    const row: MessageRow = {
      id: id('msg'),
      mission_id: input.missionId ?? null,
      task_id: input.taskId ?? null,
      from_actor: input.from,
      to_actor: input.to,
      kind: input.kind,
      objective: input.objective,
      payload: toJson(input.payload ?? {}),
      expected_output: input.expectedOutput ?? null,
      status: input.status ?? 'sent',
      created_at: nowIso(),
    };

    this.db
      .prepare(
        `INSERT INTO agent_messages (id, mission_id, task_id, from_actor, to_actor, kind,
                                     objective, payload, expected_output, status, created_at)
         VALUES (@id, @mission_id, @task_id, @from_actor, @to_actor, @kind,
                 @objective, @payload, @expected_output, @status, @created_at)`,
      )
      .run(row);
    return toMessage(row);
  }

  markAnswered(messageId: string, status: AgentMessage['status'] = 'answered'): void {
    this.db.prepare('UPDATE agent_messages SET status = ? WHERE id = ?').run(status, messageId);
  }

  forMission(missionId: MissionId): AgentMessage[] {
    return (
      this.db
        .prepare('SELECT * FROM agent_messages WHERE mission_id = ? ORDER BY created_at')
        .all(missionId) as MessageRow[]
    ).map(toMessage);
  }

  recent(limit = 100): AgentMessage[] {
    return (
      this.db
        .prepare('SELECT * FROM agent_messages ORDER BY created_at DESC LIMIT ?')
        .all(limit) as MessageRow[]
    ).map(toMessage);
  }
}
