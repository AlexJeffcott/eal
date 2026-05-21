import type {
  CreateTaskInput,
  ListTasksInput,
  Task,
  UpdateTaskInput,
} from '@eal/client';
import type { CliMcpApp, EalMcpTool } from './types.ts';

/**
 * The tasks app's assistant tools — a bounded, **non-destructive** slice of the
 * eal task API. There is deliberately no delete tool: the assistant can create,
 * update, complete, and reopen, but never destroy.
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

function requireNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number`);
  }
  return value;
}

function formatTask(task: Task): string {
  const due = task.dueAt !== null ? ` (due ${task.dueAt})` : '';
  const defer = task.deferUntil !== null ? ` (deferred to ${task.deferUntil})` : '';
  return `#${task.id} [${task.status}] ${task.title}${due}${defer}`;
}

const TOOLS: EalMcpTool[] = [
  {
    name: 'list_tasks',
    description: 'List tasks, optionally filtered by status, a search term, or scope.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'done'], description: 'Only tasks with this status' },
        q: { type: 'string', description: 'Case-insensitive search over title and notes' },
        today: { type: 'boolean', description: 'Only tasks due or active today' },
        inbox: { type: 'boolean', description: 'Only top-level tasks with no project/parent' },
      },
    },
    run: async (client, args) => {
      const input: ListTasksInput = {};
      const status = optionalString(args, 'status');
      if (status === 'open' || status === 'done') input.status = status;
      const q = optionalString(args, 'q');
      if (q !== undefined) input.q = q;
      if (args['today'] === true) input.today = true;
      if (args['inbox'] === true) input.inbox = true;
      const tasks = await client.listTasks(input);
      if (tasks.length === 0) return 'No tasks match.';
      return tasks.map(formatTask).join('\n');
    },
  },
  {
    name: 'get_task',
    description: 'Get one task with its notes and direct subtasks.',
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
    description: 'Update an existing task’s title, notes, due date, or defer date.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The task id' },
        title: { type: 'string' },
        notes: { type: 'string' },
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
      const dueAt = optionalString(args, 'due_at');
      if (dueAt !== undefined) input.dueAt = dueAt.length === 0 ? null : dueAt;
      const deferUntil = optionalString(args, 'defer_until');
      if (deferUntil !== undefined) input.deferUntil = deferUntil.length === 0 ? null : deferUntil;
      return `Updated ${formatTask(await client.updateTask(id, input))}`;
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task as done.',
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
    description: 'Reopen a completed task (set it back to open).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'The task id' } },
      required: ['id'],
    },
    run: async (client, args) => {
      return `Reopened ${formatTask(await client.reopenTask(requireNumber(args, 'id')))}`;
    },
  },
];

/** The tasks app's MCP contribution. */
export const tasksMcpApp: CliMcpApp = {
  id: 'tasks',
  tools: TOOLS,
};
