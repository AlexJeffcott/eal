import type {
  CreateTaskInput,
  ListTasksInput,
  Task,
  TaskKind,
  TaskStatus,
  UpdateTaskInput,
} from '@eal/client';
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
  return `#${task.id} [${task.kind}/${task.status}] ${task.title}${due}${defer}`;
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
      return `Created ${formatTask(await client.createTask(input))}`;
    },
  },
  {
    name: 'update_task',
    description:
      'Update an existing task’s title, notes, level, due date, or defer date. ' +
      'Changing the level is how a captured task becomes a project.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The task id' },
        title: { type: 'string' },
        notes: { type: 'string' },
        kind: KIND_PROPERTY,
        due_at: { type: 'string', description: 'ISO date/time, or empty string to clear' },
        defer_until: { type: 'string', description: 'ISO date/time, or empty string to clear' },
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
      return `Updated ${formatTask(await client.updateTask(id, input))}`;
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task as done. Works at any level — a project too.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'The task id' } },
      required: ['id'],
    },
    run: async (client, args) => {
      return `Completed ${formatTask(await client.completeTask(requireNumber(args, 'id')))}`;
    },
  },
  {
    name: 'reopen_task',
    description: 'Reopen a completed task (set it back to todo). Works at any level.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'The task id' } },
      required: ['id'],
    },
    run: async (client, args) => {
      return `Reopened ${formatTask(await client.reopenTask(requireNumber(args, 'id')))}`;
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
      return `Moved ${formatTask(await client.setTaskStatus(id, status))}`;
    },
  },
];

/** The tasks app's MCP contribution. */
export const tasksMcpApp: CliMcpApp = {
  id: 'tasks',
  tools: TOOLS,
};
