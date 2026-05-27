import type { DatabaseClient } from '../client.ts';

export type AgentRuleKind = 'place_call' | 'voice_message';

export interface AgentRuleRow {
  id: number;
  name: string;
  enabled: 0 | 1;
  target_device_id: number;
  kind: AgentRuleKind;
  body: string | null;
  system_prompt: string | null;
  next_fire_at: string;
  interval_sec: number | null;
  cooldown_sec: number;
  last_fired_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsertAgentRuleInput {
  name: string;
  enabled: boolean;
  targetDeviceId: number;
  kind: AgentRuleKind;
  body: string | null;
  systemPrompt: string | null;
  nextFireAt: string;
  intervalSec: number | null;
  cooldownSec: number;
}

export interface UpdateAgentRuleInput extends InsertAgentRuleInput {
  id: number;
}

export interface AgentRulesRepo {
  insert(input: InsertAgentRuleInput): AgentRuleRow;
  update(input: UpdateAgentRuleInput): AgentRuleRow | null;
  /** Mark a rule as just fired, bumping next_fire_at by interval_sec.
   * Returns the patched row, or null if the id no longer exists. */
  markFired(input: { id: number; firedAt: string; nextFireAt: string | null }): AgentRuleRow | null;
  findById(id: number): AgentRuleRow | null;
  listAll(): AgentRuleRow[];
  /** Rules whose next_fire_at is in the past and whose cooldown has passed. */
  listDue(now: string): AgentRuleRow[];
  deleteById(id: number): boolean;
}

export function createAgentRulesRepo(db: DatabaseClient): AgentRulesRepo {
  const insertStmt = db.prepare<
    AgentRuleRow,
    [string, 0 | 1, number, AgentRuleKind, string | null, string | null, string, number | null, number]
  >(
    `INSERT INTO agent_rules
       (name, enabled, target_device_id, kind, body, system_prompt,
        next_fire_at, interval_sec, cooldown_sec)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id, name, enabled, target_device_id, kind, body, system_prompt,
       next_fire_at, interval_sec, cooldown_sec, last_fired_at,
       created_at, updated_at`,
  );
  const updateStmt = db.prepare<
    AgentRuleRow,
    [string, 0 | 1, number, AgentRuleKind, string | null, string | null, string, number | null, number, number]
  >(
    `UPDATE agent_rules
        SET name = ?, enabled = ?, target_device_id = ?, kind = ?,
            body = ?, system_prompt = ?, next_fire_at = ?,
            interval_sec = ?, cooldown_sec = ?,
            updated_at = datetime('now')
      WHERE id = ?
     RETURNING id, name, enabled, target_device_id, kind, body, system_prompt,
       next_fire_at, interval_sec, cooldown_sec, last_fired_at,
       created_at, updated_at`,
  );
  const markFiredStmt = db.prepare<AgentRuleRow, [string, string | null, number]>(
    `UPDATE agent_rules
        SET last_fired_at = ?,
            next_fire_at = COALESCE(?, next_fire_at),
            updated_at = datetime('now')
      WHERE id = ?
     RETURNING id, name, enabled, target_device_id, kind, body, system_prompt,
       next_fire_at, interval_sec, cooldown_sec, last_fired_at,
       created_at, updated_at`,
  );
  const findByIdStmt = db.prepare<AgentRuleRow, [number]>(
    `SELECT id, name, enabled, target_device_id, kind, body, system_prompt,
            next_fire_at, interval_sec, cooldown_sec, last_fired_at,
            created_at, updated_at
       FROM agent_rules WHERE id = ?`,
  );
  const listAllStmt = db.prepare<AgentRuleRow, []>(
    `SELECT id, name, enabled, target_device_id, kind, body, system_prompt,
            next_fire_at, interval_sec, cooldown_sec, last_fired_at,
            created_at, updated_at
       FROM agent_rules
      ORDER BY id`,
  );
  // SQLite's datetime() returns space-separated values ("2025-01-01 12:30:00"),
  // while next_fire_at / last_fired_at on the wire are ISO with a 'T'. Coerce
  // both sides of every comparison through datetime() so the string compare is
  // apples-to-apples.
  const listDueStmt = db.prepare<AgentRuleRow, [string, string]>(
    `SELECT id, name, enabled, target_device_id, kind, body, system_prompt,
            next_fire_at, interval_sec, cooldown_sec, last_fired_at,
            created_at, updated_at
       FROM agent_rules
      WHERE enabled = 1
        AND datetime(next_fire_at) <= datetime(?)
        AND (last_fired_at IS NULL
             OR datetime(last_fired_at, '+' || cooldown_sec || ' seconds')
                <= datetime(?))
      ORDER BY next_fire_at`,
  );
  const deleteByIdStmt = db.prepare<unknown, [number]>(
    'DELETE FROM agent_rules WHERE id = ?',
  );

  return {
    insert(input): AgentRuleRow {
      const row = insertStmt.get(
        input.name,
        input.enabled ? 1 : 0,
        input.targetDeviceId,
        input.kind,
        input.body,
        input.systemPrompt,
        input.nextFireAt,
        input.intervalSec,
        input.cooldownSec,
      );
      if (!row) throw new Error('agent_rules.insert: RETURNING gave no row');
      return row;
    },
    update(input): AgentRuleRow | null {
      return (
        updateStmt.get(
          input.name,
          input.enabled ? 1 : 0,
          input.targetDeviceId,
          input.kind,
          input.body,
          input.systemPrompt,
          input.nextFireAt,
          input.intervalSec,
          input.cooldownSec,
          input.id,
        ) ?? null
      );
    },
    markFired(input): AgentRuleRow | null {
      return markFiredStmt.get(input.firedAt, input.nextFireAt, input.id) ?? null;
    },
    findById(id): AgentRuleRow | null {
      return findByIdStmt.get(id) ?? null;
    },
    listAll(): AgentRuleRow[] {
      return listAllStmt.all();
    },
    listDue(now): AgentRuleRow[] {
      return listDueStmt.all(now, now);
    },
    deleteById(id): boolean {
      return deleteByIdStmt.run(id).changes > 0;
    },
  };
}
