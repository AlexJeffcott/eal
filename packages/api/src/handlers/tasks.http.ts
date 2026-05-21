import { Elysia, t } from 'elysia';
import type { DatabaseClient } from '../db/client.ts';
import type { Principal } from '../auth/principals.ts';
import { AuthError } from './auth.shared.ts';
import {
  cloneTaskCore,
  completeTaskCore,
  createTaskCore,
  deleteTaskCore,
  getTaskCore,
  listTasksCore,
  reopenTaskCore,
  restoreTaskCore,
  updateTaskCore,
  type Task,
} from './tasks.shared.ts';

export type TaskEvent =
  | { type: 'task:created'; topic: 'tasks'; payload: Task }
  | { type: 'task:updated'; topic: 'tasks'; payload: Task }
  | { type: 'task:deleted'; topic: 'tasks'; payload: Task }
  | { type: 'task:tree-cloned'; topic: 'tasks'; payload: { rootId: number; tasks: Task[] } };

export interface TasksRoutesContext {
  db: DatabaseClient;
  getPrincipal: (request: Request) => Principal | null;
  broadcastTask: (event: TaskEvent) => void;
}

/**
 * Trivially-true type guards over the query record so we can parse `assigned_to=me`
 * vs `assigned_to=42`. Elysia hands us `string | string[] | undefined` for every
 * query value; we reduce to the discriminated input the core expects.
 */
function parseAssigneeLike(
  raw: string | string[] | undefined,
): number | 'me' | undefined {
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  if (value === 'me') return 'me';
  const n = Number(value);
  if (Number.isNaN(n) || !Number.isFinite(n) || n <= 0) {
    throw new AuthError(400, `expected positive integer or "me", got "${value}"`);
  }
  return Math.trunc(n);
}

function parseParentId(
  raw: string | string[] | undefined,
): number | null | undefined {
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  if (value === 'null') return null;
  const n = Number(value);
  if (Number.isNaN(n) || !Number.isFinite(n) || n <= 0) {
    throw new AuthError(400, `parent_id must be a positive integer or "null", got "${value}"`);
  }
  return Math.trunc(n);
}

function parseStatus(raw: string | string[] | undefined): 'open' | 'done' | undefined {
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === 'open' || value === 'done') return value;
  throw new AuthError(400, `status must be "open" or "done", got "${value}"`);
}

function parseBoolFlag(raw: string | string[] | undefined): boolean {
  if (raw === undefined) return false;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === '1' || value === 'true';
}

function parseString(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value;
}

function requirePrincipal(
  ctx: TasksRoutesContext,
  request: Request,
): Principal {
  const p = ctx.getPrincipal(request);
  if (!p) throw new AuthError(401, 'unauthenticated');
  return p;
}

export function tasksHttpRoutes(ctx: TasksRoutesContext) {
  // Reuses the same `{ error: string }` envelope the rest of the api uses,
  // already pinned by handlers/auth.http.test.ts and depended on by
  // packages/client/src/eal-client.ts:extractServerError.
  return new Elysia({ prefix: '/api/v1/tasks' })
    .onError(({ error, set }) => {
      if (error instanceof AuthError) {
        set.status = error.status;
        return { error: error.message };
      }
      set.status = 500;
      return { error: error instanceof Error ? error.message : 'internal error' };
    })
    .post(
      '/',
      ({ body, request }) => {
        const principal = requirePrincipal(ctx, request);
        // Snake_case on the wire (REST convention), camelCase in TS. Explicit
        // mapping keeps this honest under refactor — no spread, no cast.
        const task = createTaskCore(
          ctx.db,
          {
            title: body.title,
            parentId: body.parent_id,
            assignedTo: body.assigned_to,
            notes: body.notes,
            deferUntil: body.defer_until,
            dueAt: body.due_at,
          },
          principal,
        );
        ctx.broadcastTask({ type: 'task:created', topic: 'tasks', payload: task });
        return { task };
      },
      {
        body: t.Object({
          title: t.String(),
          parent_id: t.Optional(t.Union([t.Number(), t.Null()])),
          assigned_to: t.Optional(t.Union([t.Number(), t.Null()])),
          notes: t.Optional(t.String()),
          defer_until: t.Optional(t.Union([t.String(), t.Null()])),
          due_at: t.Optional(t.Union([t.String(), t.Null()])),
        }),
      },
    )
    .get('/', ({ query, request }) => {
      const principal = requirePrincipal(ctx, request);
      const tasks = listTasksCore(
        ctx.db,
        {
          parentId: parseParentId(query['parent_id']),
          assignedTo: parseAssigneeLike(query['assigned_to']),
          createdBy: parseAssigneeLike(query['created_by']),
          status: parseStatus(query['status']),
          dueBefore: parseString(query['due_before']),
          deferAfter: parseString(query['defer_after']),
          today: parseBoolFlag(query['today']),
          todayCutoff: parseString(query['today_cutoff']),
          inbox: parseBoolFlag(query['inbox']),
          trash: parseBoolFlag(query['trash']),
          q: parseString(query['q']),
        },
        principal,
      );
      return { tasks };
    })
    .get('/:id', ({ params, request }) => {
      requirePrincipal(ctx, request);
      return getTaskCore(ctx.db, Number(params.id));
    })
    .patch(
      '/:id',
      ({ params, body, request }) => {
        const principal = requirePrincipal(ctx, request);
        const task = updateTaskCore(
          ctx.db,
          Number(params.id),
          {
            title: body.title,
            notes: body.notes,
            assignedTo: body.assigned_to,
            parentId: body.parent_id,
            deferUntil: body.defer_until,
            dueAt: body.due_at,
            position: body.position,
          },
          principal,
        );
        ctx.broadcastTask({ type: 'task:updated', topic: 'tasks', payload: task });
        return { task };
      },
      {
        body: t.Object({
          title: t.Optional(t.String()),
          notes: t.Optional(t.String()),
          assigned_to: t.Optional(t.Union([t.Number(), t.Null()])),
          parent_id: t.Optional(t.Union([t.Number(), t.Null()])),
          defer_until: t.Optional(t.Union([t.String(), t.Null()])),
          due_at: t.Optional(t.Union([t.String(), t.Null()])),
          position: t.Optional(t.Number()),
        }),
      },
    )
    .post('/:id/complete', ({ params, request }) => {
      const principal = requirePrincipal(ctx, request);
      const task = completeTaskCore(ctx.db, Number(params.id), principal);
      ctx.broadcastTask({ type: 'task:updated', topic: 'tasks', payload: task });
      return { task };
    })
    .post('/:id/reopen', ({ params, request }) => {
      const principal = requirePrincipal(ctx, request);
      const task = reopenTaskCore(ctx.db, Number(params.id), principal);
      ctx.broadcastTask({ type: 'task:updated', topic: 'tasks', payload: task });
      return { task };
    })
    .post('/:id/clone', ({ params, request }) => {
      const principal = requirePrincipal(ctx, request);
      const result = cloneTaskCore(ctx.db, Number(params.id), principal);
      ctx.broadcastTask({ type: 'task:tree-cloned', topic: 'tasks', payload: result });
      return result;
    })
    .delete('/:id', ({ params, request }) => {
      const principal = requirePrincipal(ctx, request);
      const task = deleteTaskCore(ctx.db, Number(params.id), principal);
      ctx.broadcastTask({ type: 'task:deleted', topic: 'tasks', payload: task });
      return { task };
    })
    .post('/:id/restore', ({ params, request }) => {
      const principal = requirePrincipal(ctx, request);
      const task = restoreTaskCore(ctx.db, Number(params.id), principal);
      ctx.broadcastTask({ type: 'task:updated', topic: 'tasks', payload: task });
      return { task };
    });
}
