import { availableTaskIds } from '@eal/client';
import type {
  CreateTaskInput,
  ListTasksInput,
  Task,
  TaskKind,
  TaskStatus,
  TaskStatusChange,
  UpdateTaskInput,
} from '@eal/client';
import { describeRecurrence, parseRecurrence, type Recurrence } from '@eal/shared';
import type { CliMcpApp, EalMcpTool } from './types.ts';

/**
 * The tasks app's assistant tools — a bounded, **non-destructive** slice of the
 * eal task API. There is deliberately no delete tool: the assistant can create,
 * update, move along the workflow axis, complete and reopen, but never destroy.
 */

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * A level argument, when present. An unrecognised one throws rather than being
 * dropped: silently ignoring `kind: "epik"` would create a task at the wrong
 * level and report success, which is the worst answer available.
 */
function optionalKind(args: Record<string, unknown>, key: string): TaskKind | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (value === 'project' || value === 'epic' || value === 'task') return value;
  throw new Error(`${key} must be "project", "epic" or "task"`);
}

/**
 * A workflow state argument. Throws on anything else for the same reason
 * `optionalKind` does: an unrecognised state silently dropped would move a card
 * nowhere and report success.
 */
function requireStatus(args: Record<string, unknown>, key: string): TaskStatus {
  const value = args[key];
  if (value === 'todo' || value === 'doing' || value === 'blocked' || value === 'done') {
    return value;
  }
  throw new Error(`${key} must be "todo", "doing", "blocked" or "done"`);
}

/**
 * A boolean argument, when present. Same refusal as `optionalKind`: an
 * unrecognised value silently dropped would report success having changed
 * nothing, and for this flag "nothing changed" and "the project now hands out
 * one step at a time" look identical in the reply.
 */
function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${key} must be true or false`);
  return value;
}

/**
 * A recurrence argument, when present. `null` is a value here, not an absence:
 * it ends the series. The rule is checked with the server's own parser before
 * it is sent, so a rule the api would refuse is refused here with the same
 * words, and never half-applied.
 */
function optionalRecurrence(
  args: Record<string, unknown>,
  key: string,
): Recurrence | null | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  return parseRecurrence(value);
}

/**
 * The calendar date on this machine. The assistant runs at home, so its date
 * is the household's; the api's own is UTC's, a day behind late in a European
 * evening. Sent with a completion so a recurring task comes round on the right
 * day. Same function as web/src/platform/local-date.ts, which the CLI cannot
 * import.
 */
function localDateToday(now: Date = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function requireNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number`);
  }
  return value;
}

// The level is part of a task's identity, not decoration: the assistant has to
// know that #12 is a project before it offers to file something under it, and
// the level rule (project → epic → task) is the reason a create can be
// rejected. Every line the assistant reads therefore carries it.
function formatTask(task: Task): string {
  const due = task.dueAt !== null ? ` (due ${task.dueAt})` : '';
  const defer = task.deferUntil !== null ? ` (deferred to ${task.deferUntil})` : '';
  // Only said when it is true and can bite. Parallel is the default, so
  // printing it on every container would be a word on every line meaning
  // "nothing unusual" — and it would crowd out the ones that do mean something.
  const order = task.kind !== 'task' && task.sequential ? ' (sequential)' : '';
  // In words, because the assistant repeats this line to a person.
  const repeats = task.recurrence !== null ? ` (repeats: ${describeRecurrence(task.recurrence)})` : '';
  return `#${task.id} [${task.kind}/${task.status}]${order} ${task.title}${due}${defer}${repeats}`;
}

/**
 * What a status move did, as the assistant should say it. A recurring task's
 * completion is two facts — this one is done, the next one exists — and the
 * assistant that reports only the first will be asked "did it delete my
 * reminder?".
 */
function formatStatusChange(verb: string, change: TaskStatusChange): string {
  const lines = [`${verb} ${formatTask(change.task)}`];
  const [next, ...rest] = change.spawned;
  if (next !== undefined) {
    const inside = rest.length === 0 ? '' : ` (with ${rest.length} item${rest.length === 1 ? '' : 's'} inside, all reset to todo)`;
    lines.push(`It repeats. Next occurrence: ${formatTask(next)}${inside}`);
  }
  if (change.removed.length > 0) {
    lines.push(
      `The next occurrence it had spawned was untouched, so it was removed (#${change.removed.join(', #')}) and this task repeats again.`,
    );
  }
  return lines.join('\n');
}

/** Shared prose so all three schemas describe the levels the same way. */
const KIND_DESCRIPTION =
  'Level in the hierarchy. A project holds epics and tasks and sits at the top; ' +
  'an epic must sit inside a project; a task may sit loose, inside a project, or ' +
  'inside an epic — never inside another task.';

const KIND_PROPERTY = {
  type: 'string',
  enum: ['project', 'epic', 'task'],
  description: KIND_DESCRIPTION,
};

/**
 * Shared prose for the workflow axis, which every status-bearing schema quotes.
 * `blocked` is spelled out because an assistant that reads it as a synonym for
 * `doing` would lose the one distinction the household asked for.
 */
const STATUS_DESCRIPTION =
  'Workflow state. `todo` is written down but not started; `doing` is in ' +
  'progress; `blocked` is started but stuck waiting on someone or something ' +
  'else; `done` is finished. Independent of the level: a project and a task ' +
  'each have one.';

const STATUS_PROPERTY = {
  type: 'string',
  enum: ['todo', 'doing', 'blocked', 'done'],
  description: STATUS_DESCRIPTION,
};

/**
 * The recurrence argument. The schema is the four rules of `@eal/shared`
 * recurrence.ts, and the description is written against the two sentences a
 * person actually says — "every Tuesday" and "every 5 days after I do it" —
 * because the hard part for an assistant is not the rule's shape, it is
 * `basis`, which no one ever says out loud.
 */
const RECURRENCE_DESCRIPTION =
  'Make the task repeat. When it is completed, the next occurrence is created ' +
  'automatically with the next due date. One of four rules, chosen by `every`:\n' +
  '- {"every":"days","interval":N,"basis":…} — every N days (N from 1 to 365).\n' +
  '- {"every":"weekdays","basis":…} — Monday to Friday.\n' +
  '- {"every":"week","days":["tue"],"basis":…} — weekly on the named days; ' +
  'days are "mon","tue","wed","thu","fri","sat","sun", at least one.\n' +
  '- {"every":"month","day":N,"basis":…} — monthly on day N (1 to 31; in a ' +
  'shorter month it falls on the last day).\n' +
  '`basis` is required and says where the count starts. Use "due" for a fixed ' +
  'schedule that does not slip when the task is done late: "every Tuesday", ' +
  '"on the 1st of each month", "put the bins out weekly" → ' +
  '{"every":"week","days":["tue"],"basis":"due"}. Use "completed" when the gap ' +
  'is what matters and it should be counted from the day it was actually done: ' +
  '"every 5 days after I do it", "water the plants every 5 days", "change the ' +
  'filter 3 months after the last time" → {"every":"days","interval":5,"basis":"completed"}. ' +
  'Send no other fields. A recurring task should normally also have a `due_at` ' +
  'for its first occurrence.';

const RECURRENCE_PROPERTY = {
  type: 'object',
  description: RECURRENCE_DESCRIPTION,
  properties: {
    every: { type: 'string', enum: ['days', 'weekdays', 'week', 'month'] },
    interval: { type: 'number', description: 'Only with every="days": 1 to 365.' },
    days: {
      type: 'array',
      items: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
      description: 'Only with every="week": at least one.',
    },
    day: { type: 'number', description: 'Only with every="month": 1 to 31.' },
    basis: { type: 'string', enum: ['due', 'completed'] },
  },
  required: ['every', 'basis'],
};

/**
 * Shared prose for the order flag. Spelled out in terms of what it *does* to
 * the answer, because the flag has no effect the assistant can see on the row
 * it is set on — only on which of that row's descendants `next_actions`
 * returns.
 */
const SEQUENTIAL_PROPERTY = {
  type: 'boolean',
  description:
    'Only meaningful on a container (a project or an epic). true means the ' +
    'container hands out its work one step at a time: only its first ' +
    'unfinished child, and what is available inside that child, count as ' +
    'available. false (the default) means everything inside it is available at ' +
    'once. Nests: a sequential project holding a sequential epic exposes one ' +
    'task overall, not one per level.',
};

const TOOLS: EalMcpTool[] = [
  {
    name: 'list_tasks',
    description: 'List tasks, optionally filtered by status, a search term, or scope.',
    inputSchema: {
      type: 'object',
      properties: {
        status: STATUS_PROPERTY,
        q: { type: 'string', description: 'Case-insensitive search over title and notes' },
        today: { type: 'boolean', description: 'Only tasks due or active today' },
        inbox: { type: 'boolean', description: 'Only top-level tasks with no project/parent' },
        kind: KIND_PROPERTY,
      },
    },
    run: async (client, args) => {
      const input: ListTasksInput = {};
      const status = optionalString(args, 'status');
      if (
        status === 'todo' ||
        status === 'doing' ||
        status === 'blocked' ||
        status === 'done'
      ) {
        input.status = status;
      }
      const q = optionalString(args, 'q');
      if (q !== undefined) input.q = q;
      if (args['today'] === true) input.today = true;
      if (args['inbox'] === true) input.inbox = true;
      const kind = optionalKind(args, 'kind');
      if (kind !== undefined) input.kind = kind;
      const tasks = await client.listTasks(input);
      if (tasks.length === 0) return 'No tasks match.';
      return tasks.map(formatTask).join('\n');
    },
  },
  {
    name: 'get_task',
    description: 'Get one task with its level, notes and direct subtasks.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'The task id' } },
      required: ['id'],
    },
    run: async (client, args) => {
      const detail = await client.getTask(requireNumber(args, 'id'));
      const lines = [formatTask(detail.task)];
      if (detail.task.notes.length > 0) lines.push(`notes: ${detail.task.notes}`);
      if (detail.children.length > 0) {
        lines.push('subtasks:');
        for (const child of detail.children) lines.push(`  ${formatTask(child)}`);
      }
      return lines.join('\n');
    },
  },
  {
    name: 'create_task',
    description: 'Create a new task. Returns the created task.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title' },
        notes: { type: 'string', description: 'Longer free-text notes' },
        kind: KIND_PROPERTY,
        parent_id: { type: 'number', description: 'id of a parent task to nest this under' },
        due_at: { type: 'string', description: 'ISO date/time the task is due' },
        defer_until: { type: 'string', description: 'ISO date/time before which the task is hidden' },
        sequential: SEQUENTIAL_PROPERTY,
        recurrence: RECURRENCE_PROPERTY,
      },
      required: ['title'],
    },
    run: async (client, args) => {
      const input: CreateTaskInput = { title: requireString(args, 'title') };
      const notes = optionalString(args, 'notes');
      if (notes !== undefined) input.notes = notes;
      const kind = optionalKind(args, 'kind');
      if (kind !== undefined) input.kind = kind;
      if (typeof args['parent_id'] === 'number') input.parentId = args['parent_id'];
      const dueAt = optionalString(args, 'due_at');
      if (dueAt !== undefined) input.dueAt = dueAt;
      const deferUntil = optionalString(args, 'defer_until');
      if (deferUntil !== undefined) input.deferUntil = deferUntil;
      const sequential = optionalBoolean(args, 'sequential');
      if (sequential !== undefined) input.sequential = sequential;
      const recurrence = optionalRecurrence(args, 'recurrence');
      if (recurrence !== undefined) input.recurrence = recurrence;
      return `Created ${formatTask(await client.createTask(input))}`;
    },
  },
  {
    name: 'update_task',
    description:
      'Update an existing task’s title, notes, level, due date, defer date, or ' +
      'the order it hands out its work. Changing the level is how a captured ' +
      'task becomes a project.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The task id' },
        title: { type: 'string' },
        notes: { type: 'string' },
        kind: KIND_PROPERTY,
        due_at: { type: 'string', description: 'ISO date/time, or empty string to clear' },
        defer_until: { type: 'string', description: 'ISO date/time, or empty string to clear' },
        sequential: SEQUENTIAL_PROPERTY,
        recurrence: {
          ...RECURRENCE_PROPERTY,
          type: ['object', 'null'],
          description: `${RECURRENCE_DESCRIPTION} Send null to stop the task repeating.`,
        },
      },
      required: ['id'],
    },
    run: async (client, args) => {
      const id = requireNumber(args, 'id');
      const input: UpdateTaskInput = {};
      const title = optionalString(args, 'title');
      if (title !== undefined) input.title = title;
      const notes = optionalString(args, 'notes');
      if (notes !== undefined) input.notes = notes;
      const kind = optionalKind(args, 'kind');
      if (kind !== undefined) input.kind = kind;
      const dueAt = optionalString(args, 'due_at');
      if (dueAt !== undefined) input.dueAt = dueAt.length === 0 ? null : dueAt;
      const deferUntil = optionalString(args, 'defer_until');
      if (deferUntil !== undefined) input.deferUntil = deferUntil.length === 0 ? null : deferUntil;
      const sequential = optionalBoolean(args, 'sequential');
      if (sequential !== undefined) input.sequential = sequential;
      const recurrence = optionalRecurrence(args, 'recurrence');
      if (recurrence !== undefined) input.recurrence = recurrence;
      return `Updated ${formatTask(await client.updateTask(id, input))}`;
    },
  },
  {
    name: 'complete_task',
    description:
      'Mark a task as done. Works at any level — a project too. If the task ' +
      'repeats, its next occurrence is created and reported in the reply.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'The task id' } },
      required: ['id'],
    },
    run: async (client, args) => {
      const change = await client.completeTask(requireNumber(args, 'id'), {
        today: localDateToday(),
      });
      return formatStatusChange('Completed', change);
    },
  },
  {
    name: 'reopen_task',
    description:
      'Reopen a completed task (set it back to todo). Works at any level. If ' +
      'completing it had spawned a next occurrence that nobody has touched ' +
      'since, that occurrence is removed and this task repeats again — so ' +
      'reopening undoes a completion made by mistake.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'The task id' } },
      required: ['id'],
    },
    run: async (client, args) => {
      return formatStatusChange('Reopened', await client.reopenTask(requireNumber(args, 'id')));
    },
  },
  {
    name: 'set_task_status',
    description:
      'Move a task along the workflow axis — what dragging its card to another ' +
      'board lane does. Use this to say a task is started, or stuck. ' +
      'Non-destructive: it can never trash a task or bring one back.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The task id' },
        status: STATUS_PROPERTY,
      },
      required: ['id', 'status'],
    },
    run: async (client, args) => {
      const id = requireNumber(args, 'id');
      const status = requireStatus(args, 'status');
      return formatStatusChange(
        'Moved',
        await client.setTaskStatus(id, status, { today: localDateToday() }),
      );
    },
  },
  {
    // A tool of its own, not a flag on list_tasks. Every list_tasks filter is a
    // predicate over one row, handed to the api as a query parameter and
    // answered in SQL; "available" is a read over the whole tree above a row
    // and cannot be one of those without lying about what the api can do. It
    // also has to be findable: the assistant is asked "what should I do next"
    // in those words, and a boolean buried in another tool's schema is not what
    // it reaches for.
    name: 'next_actions',
    description:
      'Answer "what should I do next": every task that can actually be started ' +
      'right now. Excludes anything blocked, done, deferred to a future date, ' +
      'or still holding unfinished subtasks, and honours the sequential flag on ' +
      'every container above a task — inside a sequential project only the ' +
      'current step is offered. Read-only.',
    inputSchema: { type: 'object', properties: {} },
    run: async (client) => {
      // The whole live set, because availability is a property of the tree, not
      // of a row: a task's answer depends on every ancestor above it and on its
      // siblings' states. Trashed rows are already excluded by the api's list.
      const tasks = await client.listTasks({});
      const availableIds = availableTaskIds(tasks, { now: new Date() });
      const available = tasks.filter((task) => availableIds.has(task.id));
      if (available.length === 0) {
        return 'Nothing is available. Everything left is blocked, deferred, or waiting on a step before it.';
      }
      return available.map(formatTask).join('\n');
    },
  },
];

/** The tasks app's MCP contribution. */
export const tasksMcpApp: CliMcpApp = {
  id: 'tasks',
  tools: TOOLS,
};
