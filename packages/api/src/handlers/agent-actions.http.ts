import { Elysia, t } from 'elysia';
import { assertNever } from '@eal/shared';
import type { DatabaseClient } from '../db/client.ts';
import type { Principal } from '../auth/principals.ts';
import {
  createAgentActionsRepo,
  type AgentActionResult,
  type AgentActionRow,
  type AgentActionTrigger,
} from '../db/repos/agent-actions.ts';
import { createAgentPhoneLockRepo } from '../db/repos/agent-phone-lock.ts';
import {
  createFamilyPhoneDevicesRepo,
  type FamilyPhoneDeviceRow,
} from '../db/repos/family-phone-devices.ts';
import { createAgentRulesRepo } from '../db/repos/agent-rules.ts';
import { AuthError } from './auth.shared.ts';

/**
 * Default TTL on a phone-lock claim. The agent worker is expected to
 * attach the call_id within a few seconds, drive the call, then finish
 * the action. A longer-than-necessary lease is harmless — the sweeper
 * reclaims it on the next tick if the worker crashes.
 */
export const DEFAULT_LOCK_TTL_SEC = 60;

export interface AgentActionsRoutesContext {
  db: DatabaseClient;
  getPrincipal: (request: Request) => Principal | null;
  /** Current time, injected for testability. Defaults to `new Date()`. */
  now?: () => Date;
}

export interface AgentAction {
  id: number;
  ruleId: number | null;
  kind: 'place_call' | 'voice_message';
  targetDeviceId: number;
  trigger: AgentActionTrigger;
  result: AgentActionResult;
  callId: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export function toAgentAction(row: AgentActionRow): AgentAction {
  return {
    id: row.id,
    ruleId: row.rule_id,
    kind: row.kind,
    targetDeviceId: row.target_device_id,
    trigger: row.trigger,
    result: row.result,
    callId: row.call_id,
    error: row.error,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function requirePrincipal(
  ctx: AgentActionsRoutesContext,
  request: Request,
): Principal {
  const p = ctx.getPrincipal(request);
  if (!p) throw new AuthError(401, 'unauthenticated');
  return p;
}

function parseTrigger(value: string): AgentActionTrigger {
  if (value === 'scheduled' || value === 'tool') return value;
  throw new AuthError(400, `trigger must be "scheduled" or "tool", got "${value}"`);
}

/**
 * Validated terminal result for the finish route. `pending` is rejected
 * (it's the initial state, not a target).
 */
function parseFinishResult(value: string): Exclude<AgentActionResult, 'pending'> {
  switch (value) {
    case 'answered':
    case 'unanswered':
    case 'rejected':
    case 'failed':
    case 'sent':
      return value;
    case 'pending':
      throw new AuthError(400, 'cannot finish an action into result="pending"');
    default:
      throw new AuthError(
        400,
        `result must be one of answered|unanswered|rejected|failed|sent, got "${value}"`,
      );
  }
}

function isoSecondsFromNow(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

/**
 * Find the agent device owned by this user. There is at most one row
 * with kind='agent' per user (the pair flow enforces this implicitly:
 * the `eal agent` worker pairs once and re-uses its device). Returns
 * null when the user has not paired an agent yet — the routes treat
 * that as a 409 because the worker is supposed to do this on first
 * boot.
 */
function findAgentDeviceForPrincipal(
  db: DatabaseClient,
  principal: Principal,
): FamilyPhoneDeviceRow | null {
  interface Row {
    id: number;
    user_id: number;
    label: string;
    kind: 'handset' | 'pwa' | 'agent';
    created_at: string;
    paired_at: string | null;
  }
  const stmt = db.prepare<Row, [number]>(
    `SELECT id, user_id, label, kind, created_at, paired_at
       FROM family_phone_devices
      WHERE user_id = ? AND kind = 'agent'
      ORDER BY id
      LIMIT 1`,
  );
  return stmt.get(principal.userId) ?? null;
}

export function agentActionsHttpRoutes(ctx: AgentActionsRoutesContext) {
  const actions = createAgentActionsRepo(ctx.db);
  const locks = createAgentPhoneLockRepo(ctx.db);
  const devices = createFamilyPhoneDevicesRepo(ctx.db);
  const rules = createAgentRulesRepo(ctx.db);
  const now = ctx.now ?? (() => new Date());

  return new Elysia({ prefix: '/api/agent' })
    .onError(({ error, set }) => {
      if (error instanceof AuthError) {
        set.status = error.status;
        return { error: error.message };
      }
      set.status = 500;
      return { error: error instanceof Error ? error.message : 'internal error' };
    })
    .post(
      '/actions/place-call',
      ({ body, request, set }) => {
        const principal = requirePrincipal(ctx, request);
        const trigger = parseTrigger(body.trigger);
        const agent = findAgentDeviceForPrincipal(ctx.db, principal);
        if (!agent) {
          set.status = 409;
          return { error: 'no agent device paired for this user' };
        }
        const target = devices.findById(body.target_device_id);
        if (!target) {
          set.status = 400;
          return { error: `unknown target_device_id ${body.target_device_id}` };
        }
        if (body.rule_id !== undefined && body.rule_id !== null) {
          if (!rules.findById(body.rule_id)) {
            set.status = 400;
            return { error: `unknown rule_id ${body.rule_id}` };
          }
        }
        // Sweep expired leases before claiming so a crashed worker's
        // stale lock doesn't strand the next action.
        const nowDate = now();
        locks.sweepExpired(nowDate.toISOString());
        const action = actions.insertPending({
          ruleId: body.rule_id ?? null,
          kind: 'place_call',
          targetDeviceId: body.target_device_id,
          trigger,
        });
        const claimed = locks.claim({
          deviceId: agent.id,
          // We don't have a family-phone call_id yet — the worker
          // attaches it next. Use the action id as a placeholder so the
          // row is still well-formed.
          callId: `pending:${action.id}`,
          actionId: action.id,
          expiresAt: isoSecondsFromNow(nowDate, DEFAULT_LOCK_TTL_SEC),
        });
        if (!claimed) {
          // Lock is held; collapse the just-created audit row to failed
          // so the admin sees the attempt.
          actions.finish({
            id: action.id,
            result: 'failed',
            callId: null,
            error: 'busy',
          });
          set.status = 409;
          return { error: 'agent is already on a call', action_id: action.id };
        }
        return { action: toAgentAction(action) };
      },
      {
        body: t.Object({
          target_device_id: t.Number(),
          trigger: t.String(),
          rule_id: t.Optional(t.Union([t.Number(), t.Null()])),
        }),
      },
    )
    .post(
      '/actions/:id/attach-call',
      ({ params, body, request, set }) => {
        requirePrincipal(ctx, request);
        const id = Number(params.id);
        if (!Number.isInteger(id) || id <= 0) {
          set.status = 400;
          return { error: 'action id must be a positive integer' };
        }
        if (typeof body.call_id !== 'string' || body.call_id.length === 0) {
          set.status = 400;
          return { error: 'call_id is required' };
        }
        const updated = actions.attachCall(id, body.call_id);
        if (!updated) {
          set.status = 404;
          return { error: `pending action ${id} not found` };
        }
        return { action: toAgentAction(updated) };
      },
      {
        body: t.Object({
          call_id: t.String(),
        }),
      },
    )
    .post(
      '/actions/:id/finish',
      ({ params, body, request, set }) => {
        const principal = requirePrincipal(ctx, request);
        const id = Number(params.id);
        if (!Number.isInteger(id) || id <= 0) {
          set.status = 400;
          return { error: 'action id must be a positive integer' };
        }
        const result = parseFinishResult(body.result);
        const finished = actions.finish({
          id,
          result,
          callId: body.call_id ?? null,
          error: body.error ?? null,
        });
        if (!finished) {
          set.status = 404;
          return { error: `pending action ${id} not found` };
        }
        // Release the lock held by this user's agent device. If the
        // device row is gone (e.g., un-pair mid-call), the release is
        // a no-op — the lock cascaded with the device.
        const agent = findAgentDeviceForPrincipal(ctx.db, principal);
        if (agent) locks.release(agent.id);
        // Burn the never-coverage on the result enum so a future
        // variant fails to type-check here.
        ((): void => {
          switch (result) {
            case 'answered':
            case 'unanswered':
            case 'rejected':
            case 'failed':
            case 'sent':
              return;
            default:
              return assertNever(result);
          }
        })();
        return { action: toAgentAction(finished) };
      },
      {
        body: t.Object({
          result: t.String(),
          call_id: t.Optional(t.Union([t.String(), t.Null()])),
          error: t.Optional(t.Union([t.String(), t.Null()])),
        }),
      },
    )
    .get('/actions', ({ query, request, set }) => {
      requirePrincipal(ctx, request);
      const limitRaw = Array.isArray(query['limit']) ? query['limit'][0] : query['limit'];
      const ruleIdRaw = Array.isArray(query['rule_id']) ? query['rule_id'][0] : query['rule_id'];
      const limit = limitRaw === undefined ? 50 : Number(limitRaw);
      if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
        set.status = 400;
        return { error: 'limit must be a positive integer ≤ 500' };
      }
      let ruleId: number | undefined;
      if (ruleIdRaw !== undefined) {
        const n = Number(ruleIdRaw);
        if (!Number.isInteger(n) || n <= 0) {
          set.status = 400;
          return { error: 'rule_id must be a positive integer' };
        }
        ruleId = n;
      }
      return {
        actions: actions.listRecent(limit, ruleId).map(toAgentAction),
      };
    });
}
