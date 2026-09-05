import { Elysia, t } from 'elysia';
import { ensures, requires } from '@fairfox/polly/verify';
import type { DatabaseClient } from '../db/client.ts';
import type { Principal } from '../auth/principals.ts';
import { AuthError } from './auth.shared.ts';
import { taskStatusMachine } from '../specs/tasks-status-machine.ts';

const POLLY_ANCHOR = process.env['POLLY_VERIFY'] === '1';
import {
  cloneTaskCore,
  completeTaskCore,
  createTaskCore,
  deleteTaskCore,
  getTaskCore,
  listTasksCore,
  reopenTaskCore,
  restoreTaskCore,
  setTaskStatusCore,
  updateTaskCore,
  type Task,
  type TaskKind,
  type TaskStatus,
} from './tasks.shared.ts';

export type TaskEvent =
  | { type: 'task:created'; topic: 'tasks'; payload: Task }
  | { type: 'task:updated'; topic: 'tasks'; payload: Task }
  | { type: 'task:deleted'; topic: 'tasks'; payload: Task }
  | { type: 'task:tree-cloned'; topic: 'tasks'; payload: { rootId: number; tasks: Task[] } };

/** The level vocabulary, as Elysia sees it on a create or update body. */
const TASK_KIND = t.Union([t.Literal('project'), t.Literal('epic'), t.Literal('task')]);

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

/**
 * The one place a status string is admitted, whether it arrived as a `?status=`
 * query value or in a `POST /:id/status` body. The body is typed `t.String()`
 * rather than a union of four literals so the refusal comes from here: Elysia's
 * own schema rejection is flattened to a 500 by the `onError` above, and "the
 * server broke" is the wrong answer to "blockd" — the client maps the
 * `{ error }` envelope and the person needs to read what went wrong.
 */
function requireStatus(value: string): TaskStatus {
  if (value === 'todo' || value === 'doing' || value === 'blocked' || value === 'done') {
    return value;
  }
  throw new AuthError(
    400,
    `status must be "todo", "doing", "blocked" or "done", got "${value}"`,
  );
}

function parseStatus(raw: string | string[] | undefined): TaskStatus | undefined {
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  return requireStatus(value);
}

function parseKind(raw: string | string[] | undefined): TaskKind | undefined {
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === 'project' || value === 'epic' || value === 'task') return value;
  throw new AuthError(400, `kind must be "project", "epic" or "task", got "${value}"`);
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
            kind: body.kind,
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
          kind: t.Optional(TASK_KIND),
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
          kind: parseKind(query['kind']),
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
            kind: body.kind,
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
          kind: t.Optional(TASK_KIND),
          assigned_to: t.Optional(t.Union([t.Number(), t.Null()])),
          parent_id: t.Optional(t.Union([t.Number(), t.Null()])),
          defer_until: t.Optional(t.Union([t.String(), t.Null()])),
          due_at: t.Optional(t.Union([t.String(), t.Null()])),
          position: t.Optional(t.Number()),
        }),
      },
    )
    .post('/:id/complete', ({ params, request }) => {
      requires(
        taskStatusMachine.value.status === 'todo' ||
          taskStatusMachine.value.status === 'doing' ||
          taskStatusMachine.value.status === 'blocked',
        'complete: must be live and unfinished',
      );
      const principal = requirePrincipal(ctx, request);
      const task = completeTaskCore(ctx.db, Number(params.id), principal);
      ctx.broadcastTask({ type: 'task:updated', topic: 'tasks', payload: task });
      if (POLLY_ANCHOR) taskStatusMachine.value = { status: 'done' };
      ensures(taskStatusMachine.value.status === 'done', 'complete: end in done');
      return { task };
    })
    .post('/:id/reopen', ({ params, request }) => {
      requires(taskStatusMachine.value.status === 'done', 'reopen: must be done');
      const principal = requirePrincipal(ctx, request);
      const task = reopenTaskCore(ctx.db, Number(params.id), principal);
      ctx.broadcastTask({ type: 'task:updated', topic: 'tasks', payload: task });
      if (POLLY_ANCHOR) taskStatusMachine.value = { status: 'todo' };
      ensures(taskStatusMachine.value.status === 'todo', 'reopen: end in todo');
      return { task };
    })
    /**
     * The board's lane move. Its own verb rather than a field on PATCH: the
     * status axis is the one part of a task with a formal model behind it
     * (specs/tasks-status-machine.ts), and a route that only ever moves along
     * that axis is a thing the model can be anchored to. A title edit is not a
     * workflow transition and should not be modelled as one.
     */
    .post(
      '/:id/status',
      ({ params, body, request }) => {
        requires(
          taskStatusMachine.value.status === 'todo' ||
            taskStatusMachine.value.status === 'doing' ||
            taskStatusMachine.value.status === 'blocked' ||
            taskStatusMachine.value.status === 'done',
          'setStatus: must be live',
        );
        const principal = requirePrincipal(ctx, request);
        const next = requireStatus(body.status);
        const task = setTaskStatusCore(ctx.db, Number(params.id), next, principal);
        ctx.broadcastTask({ type: 'task:updated', topic: 'tasks', payload: task });
        // Written as four literal assignments rather than one on `body.status`
        // so polly's static extractor records every landing state: the model
        // then explores all four and proves the ensures below on each. A single
        // `{ status: body.status }` extracts to nothing and would model this
        // route as changing no state at all.
        if (POLLY_ANCHOR) {
          if (task.status === 'done') taskStatusMachine.value = { status: 'done' };
          else if (task.status === 'doing') taskStatusMachine.value = { status: 'doing' };
          else if (task.status === 'blocked') taskStatusMachine.value = { status: 'blocked' };
          else taskStatusMachine.value = { status: 'todo' };
        }
        ensures(
          taskStatusMachine.value.status === 'todo' ||
            taskStatusMachine.value.status === 'doing' ||
            taskStatusMachine.value.status === 'blocked' ||
            taskStatusMachine.value.status === 'done',
          'setStatus: ends live — the workflow axis never reaches the trash',
        );
        return { task };
      },
      { body: t.Object({ status: t.String() }) },
    )
    .post('/:id/clone', ({ params, request }) => {
      const principal = requirePrincipal(ctx, request);
      const result = cloneTaskCore(ctx.db, Number(params.id), principal);
      ctx.broadcastTask({ type: 'task:tree-cloned', topic: 'tasks', payload: result });
      return result;
    })
    .delete('/:id', ({ params, request }) => {
      requires(
        taskStatusMachine.value.status === 'todo' ||
          taskStatusMachine.value.status === 'doing' ||
          taskStatusMachine.value.status === 'blocked' ||
          taskStatusMachine.value.status === 'done',
        'delete: must be live (any of the four workflow states)',
      );
      const principal = requirePrincipal(ctx, request);
      const task = deleteTaskCore(ctx.db, Number(params.id), principal);
      ctx.broadcastTask({ type: 'task:deleted', topic: 'tasks', payload: task });
      if (POLLY_ANCHOR) taskStatusMachine.value = { status: 'deleted' };
      ensures(taskStatusMachine.value.status === 'deleted', 'delete: end in deleted');
      return { task };
    })
    .post('/:id/restore', ({ params, request }) => {
      requires(taskStatusMachine.value.status === 'deleted', 'restore: must be deleted');
      const principal = requirePrincipal(ctx, request);
      const task = restoreTaskCore(ctx.db, Number(params.id), principal);
      ctx.broadcastTask({ type: 'task:updated', topic: 'tasks', payload: task });
      if (POLLY_ANCHOR) taskStatusMachine.value = { status: 'todo' };
      ensures(taskStatusMachine.value.status === 'todo', 'restore: end in todo (predictable resurrection)');
      return { task };
    });
}
