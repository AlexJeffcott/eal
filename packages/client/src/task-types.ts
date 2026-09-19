import type { Recurrence } from '@eal/shared';

export type { Recurrence };

/**
 * The three fixed levels a task can sit at: project → epic → task. The epic
 * level is optional — a project may hold tasks directly. Which kind may sit
 * under which is enforced server-side (handlers/tasks.shared.ts:levelViolation);
 * a rejected move comes back through the ordinary `{ error }` envelope.
 */
export type TaskKind = 'project' | 'epic' | 'task';

/**
 * The workflow axis — where a task is in the doing of it, independent of the
 * level axis above. A project and a task each have one, and the board shows
 * cards from every project in the same four lanes.
 *
 * `blocked` is distinct from `doing` on purpose: "moving" and "stuck waiting on
 * someone" are different answers, and the list said neither while everything
 * read 'open'. It is also distinct from `deferUntil`, which is time-based and
 * clears itself.
 *
 * The server owns the transitions (packages/api/src/handlers/tasks.shared.ts)
 * and the storage owns the `done` ⇔ `completedAt` tie.
 */
export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done';

/**
 * Wire shape for a single task — what the SPA stores in its reactive map and
 * what the WS broadcast carries on every `task:*` event. CamelCase to match
 * CurrentUser / SayHelloResult / CliPairStartResult.
 *
 * The server source of truth lives at packages/api/src/handlers/tasks.shared.ts
 * (the Task interface there); this declaration must stay byte-identical at the
 * field level. A drift here breaks SPA optimistic reconciliation silently.
 */
export interface Task {
  id: number;
  parentId: number | null;
  title: string;
  notes: string;
  status: TaskStatus;
  kind: TaskKind;
  deferUntil: string | null;
  dueAt: string | null;
  createdBy: number;
  assignedTo: number | null;
  updatedBy: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  deletedAt: string | null;
  position: number;
  /**
   * Does this container hand out its work one step at a time (`true`) or all at
   * once (`false`)? It governs the row's children, so it is inert on a leaf and
   * the editor only offers the control on a container.
   *
   * What it means is `task-availability.ts:availableTaskIds` — the one place the
   * rule lives, shared by the SPA's Available view and the assistant's
   * `next_actions` tool.
   */
  sequential: boolean;
  /**
   * The id the capturing device gave this task before the server had one, or
   * null. It is on the wire so the device can match a row that comes back by
   * broadcast or by seed to the outbox entry still waiting for it — the case
   * where the create landed and its response did not.
   */
  clientId: string | null;
  /**
   * The rule this task repeats by, or null — `@eal/shared` recurrence.ts. It
   * sits on the one live row of a series: completing that row makes the next
   * occurrence and moves the rule onto it.
   */
  recurrence: Recurrence | null;
}

export interface CreateTaskInput {
  title: string;
  kind?: TaskKind;
  parentId?: number | null;
  assignedTo?: number | null;
  notes?: string;
  deferUntil?: string | null;
  dueAt?: string | null;
  sequential?: boolean;
  /** A UUID minted by the device. Sent twice, it still makes one task. */
  clientId?: string;
  recurrence?: Recurrence | null;
}

export interface UpdateTaskInput {
  title?: string;
  notes?: string;
  kind?: TaskKind;
  assignedTo?: number | null;
  parentId?: number | null;
  deferUntil?: string | null;
  dueAt?: string | null;
  position?: number;
  sequential?: boolean;
  /** A rule to set, or `null` to end the series. */
  recurrence?: Recurrence | null;
}

/**
 * What a move along the status axis did — `completeTask`, `reopenTask` and
 * `setTaskStatus` all answer with it.
 *
 * `task` is the row that was asked about. `spawned` is the next occurrence a
 * completion made, root first (more than one row when the task was a
 * container). `removed` is the ids of an untouched successor that a reopen
 * took back: those rows are gone, not binned. Both are empty for a task that
 * does not recur.
 */
export interface TaskStatusChange {
  task: Task;
  spawned: Task[];
  removed: number[];
}

export interface ListTasksInput {
  parentId?: number | null;
  kind?: TaskKind;
  assignedTo?: number | 'me';
  createdBy?: number | 'me';
  status?: TaskStatus;
  dueBefore?: string;
  deferAfter?: string;
  today?: boolean;
  todayCutoff?: string;
  inbox?: boolean;
  trash?: boolean;
  q?: string;
}

export interface TaskDetail {
  task: Task;
  children: Task[];
}

export interface CloneTaskResult {
  rootId: number;
  tasks: Task[];
}

export type TaskEvent =
  | { type: 'task:created'; topic: 'tasks'; payload: Task }
  | { type: 'task:updated'; topic: 'tasks'; payload: Task }
  | { type: 'task:deleted'; topic: 'tasks'; payload: Task }
  | { type: 'task:tree-cloned'; topic: 'tasks'; payload: CloneTaskResult }
  /** Rows that no longer exist — an untouched successor, taken back by a reopen. */
  | { type: 'task:removed'; topic: 'tasks'; payload: { ids: number[] } };
