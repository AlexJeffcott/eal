import type { DatabaseClient } from '../client.ts';
import type { AgentRuleKind } from './agent-rules.ts';

export type AgentActionTrigger = 'scheduled' | 'tool';
export type AgentActionResult =
  | 'pending'
  | 'answered'
  | 'unanswered'
  | 'rejected'
  | 'failed'
  | 'sent';

export interface AgentActionRow {
  id: number;
  rule_id: number | null;
  kind: AgentRuleKind;
  target_device_id: number;
  trigger: AgentActionTrigger;
  result: AgentActionResult;
  call_id: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface InsertAgentActionInput {
  ruleId: number | null;
  kind: AgentRuleKind;
  targetDeviceId: number;
  trigger: AgentActionTrigger;
}

export interface FinishAgentActionInput {
  id: number;
  result: Exclude<AgentActionResult, 'pending'>;
  callId: string | null;
  error: string | null;
}

export interface AgentActionsRepo {
  insertPending(input: InsertAgentActionInput): AgentActionRow;
  /** Attach the freshly-minted family-phone call_id to a pending action. */
  attachCall(id: number, callId: string): AgentActionRow | null;
  finish(input: FinishAgentActionInput): AgentActionRow | null;
  findById(id: number): AgentActionRow | null;
  /** Most-recent first, optionally filtered by rule. Used by the admin log. */
  listRecent(limit: number, ruleId?: number): AgentActionRow[];
  /** Look up the pending action for an in-flight family-phone call_id. */
  findPendingByCallId(callId: string): AgentActionRow | null;
}

export function createAgentActionsRepo(db: DatabaseClient): AgentActionsRepo {
  const insertStmt = db.prepare<
    AgentActionRow,
    [number | null, AgentRuleKind, number, AgentActionTrigger]
  >(
    `INSERT INTO agent_actions (rule_id, kind, target_device_id, trigger)
     VALUES (?, ?, ?, ?)
     RETURNING id, rule_id, kind, target_device_id, trigger, result,
       call_id, error, created_at, finished_at`,
  );
  const attachCallStmt = db.prepare<AgentActionRow, [string, number]>(
    `UPDATE agent_actions
        SET call_id = ?
      WHERE id = ?
        AND result = 'pending'
     RETURNING id, rule_id, kind, target_device_id, trigger, result,
       call_id, error, created_at, finished_at`,
  );
  const finishStmt = db.prepare<
    AgentActionRow,
    [AgentActionResult, string | null, string | null, number]
  >(
    `UPDATE agent_actions
        SET result = ?,
            call_id = COALESCE(?, call_id),
            error = ?,
            finished_at = datetime('now')
      WHERE id = ?
        AND result = 'pending'
     RETURNING id, rule_id, kind, target_device_id, trigger, result,
       call_id, error, created_at, finished_at`,
  );
  const findByIdStmt = db.prepare<AgentActionRow, [number]>(
    `SELECT id, rule_id, kind, target_device_id, trigger, result,
            call_id, error, created_at, finished_at
       FROM agent_actions WHERE id = ?`,
  );
  const listRecentAllStmt = db.prepare<AgentActionRow, [number]>(
    `SELECT id, rule_id, kind, target_device_id, trigger, result,
            call_id, error, created_at, finished_at
       FROM agent_actions
      ORDER BY id DESC
      LIMIT ?`,
  );
  const listRecentByRuleStmt = db.prepare<AgentActionRow, [number, number]>(
    `SELECT id, rule_id, kind, target_device_id, trigger, result,
            call_id, error, created_at, finished_at
       FROM agent_actions
      WHERE rule_id = ?
      ORDER BY id DESC
      LIMIT ?`,
  );
  const findPendingByCallIdStmt = db.prepare<AgentActionRow, [string]>(
    `SELECT id, rule_id, kind, target_device_id, trigger, result,
            call_id, error, created_at, finished_at
       FROM agent_actions
      WHERE call_id = ?
        AND result = 'pending'`,
  );

  return {
    insertPending(input): AgentActionRow {
      const row = insertStmt.get(
        input.ruleId,
        input.kind,
        input.targetDeviceId,
        input.trigger,
      );
      if (!row) throw new Error('agent_actions.insertPending: RETURNING gave no row');
      return row;
    },
    attachCall(id, callId): AgentActionRow | null {
      return attachCallStmt.get(callId, id) ?? null;
    },
    finish(input): AgentActionRow | null {
      return (
        finishStmt.get(input.result, input.callId, input.error, input.id) ?? null
      );
    },
    findById(id): AgentActionRow | null {
      return findByIdStmt.get(id) ?? null;
    },
    listRecent(limit, ruleId): AgentActionRow[] {
      if (ruleId === undefined) return listRecentAllStmt.all(limit);
      return listRecentByRuleStmt.all(ruleId, limit);
    },
    findPendingByCallId(callId): AgentActionRow | null {
      return findPendingByCallIdStmt.get(callId) ?? null;
    },
  };
}
