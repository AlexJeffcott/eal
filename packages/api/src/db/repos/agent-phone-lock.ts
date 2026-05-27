import type { DatabaseClient } from '../client.ts';

/**
 * Cross-process serialisation for outbound calls placed by an agent
 * device. The `eal agent` worker runs in one OS process; the MCP child
 * `claude` spawns to invoke tools runs in another; both must share a
 * single "is the agent currently on a call?" answer. A SQLite row keyed
 * by the agent's device_id is the source of truth.
 *
 * Lifecycle:
 *   1. `claim()` does INSERT OR FAIL. A second concurrent claim fails
 *      until the holder calls `release()` or the row's `expires_at`
 *      sweeps past.
 *   2. `release()` deletes the row when the holder finishes its call.
 *   3. `sweepExpired()` deletes any rows whose lease passed without a
 *      release — the worker calls it on every scheduler tick so a crash
 *      mid-call doesn't strand the lock.
 */

export interface AgentPhoneLockRow {
  device_id: number;
  call_id: string;
  action_id: number;
  expires_at: string;
}

export interface ClaimAgentPhoneLockInput {
  deviceId: number;
  callId: string;
  actionId: number;
  expiresAt: string;
}

export interface AgentPhoneLockRepo {
  /** Returns the inserted row, or null if the device is already locked. */
  claim(input: ClaimAgentPhoneLockInput): AgentPhoneLockRow | null;
  /** Returns true if a row was removed. */
  release(deviceId: number): boolean;
  findByDevice(deviceId: number): AgentPhoneLockRow | null;
  /** Removes rows whose expires_at is in the past. Returns the count. */
  sweepExpired(now: string): number;
}

export function createAgentPhoneLockRepo(db: DatabaseClient): AgentPhoneLockRepo {
  const claimStmt = db.prepare<AgentPhoneLockRow, [number, string, number, string]>(
    `INSERT INTO agent_phone_lock (device_id, call_id, action_id, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(device_id) DO NOTHING
     RETURNING device_id, call_id, action_id, expires_at`,
  );
  const releaseStmt = db.prepare<unknown, [number]>(
    'DELETE FROM agent_phone_lock WHERE device_id = ?',
  );
  const findByDeviceStmt = db.prepare<AgentPhoneLockRow, [number]>(
    `SELECT device_id, call_id, action_id, expires_at
       FROM agent_phone_lock WHERE device_id = ?`,
  );
  const sweepExpiredStmt = db.prepare<unknown, [string]>(
    `DELETE FROM agent_phone_lock
      WHERE datetime(expires_at) <= datetime(?)`,
  );

  return {
    claim(input): AgentPhoneLockRow | null {
      return (
        claimStmt.get(input.deviceId, input.callId, input.actionId, input.expiresAt) ??
        null
      );
    },
    release(deviceId): boolean {
      return releaseStmt.run(deviceId).changes > 0;
    },
    findByDevice(deviceId): AgentPhoneLockRow | null {
      return findByDeviceStmt.get(deviceId) ?? null;
    },
    sweepExpired(now): number {
      return sweepExpiredStmt.run(now).changes;
    },
  };
}
