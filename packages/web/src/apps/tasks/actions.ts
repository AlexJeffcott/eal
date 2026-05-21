import type { ActionRegistry } from '@fairfox/polly/actions';
import type { Task, UpdateTaskInput } from '@eal/client';
import type { AppStores } from '../../stores.ts';
import {
  isConditionField,
  isTextOp,
  newCondition,
  type TaskFilter,
  type TaskView,
} from './filter.ts';

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function friendlyTaskError(err: unknown): string {
  const raw = describeError(err);
  if (raw.includes('title is required')) return 'Give the task a title before saving.';
  if (raw.includes('would create cycle')) return "You can't move a task inside itself.";
  if (raw.includes('not found or in trash')) return 'That task was already removed by another device.';
  if (raw.includes('parent task') && raw.includes('not found')) return 'That parent was already removed.';
  return raw;
}

function patchTasks(stores: AppStores, mutate: (map: Map<number, Task>) => void): void {
  const next = new Map(stores.$tasksById.value);
  mutate(next);
  stores.$tasksById.value = next;
}

/** Parse the `data-action-task-id` carried on a task control. */
function taskIdFromData(data: Record<string, unknown>): number | null {
  const raw = data['taskId'];
  if (typeof raw !== 'string') return null;
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}

/** Commit one task-field edit: persist it, then splice the canonical row back. */
async function commitTaskField(
  stores: AppStores,
  id: number,
  patch: UpdateTaskInput,
): Promise<void> {
  stores.$tasksError.value = null;
  try {
    const task = await stores.client.updateTask(id, patch);
    patchTasks(stores, (m) => m.set(task.id, task));
  } catch (err) {
    stores.$tasksError.value = friendlyTaskError(err);
  }
}

function isTaskView(value: string): value is TaskView {
  return value === 'inbox' || value === 'today' || value === 'all' || value === 'trash';
}

/**
 * The single seam through which the filter changes. Updating the filter is
 * "navigation" — it clears the linger set so just-completed tasks stop
 * lingering once the user moves to a different view or refinement.
 */
function applyFilter(stores: AppStores, patch: Partial<TaskFilter>): void {
  stores.$taskFilter.value = { ...stores.$taskFilter.value, ...patch };
  stores.$recentlyCompleted.value = new Set();
}

/** The tasks app's actions. */
export const TASKS_ACTIONS: ActionRegistry<AppStores> = {
  'tasks:set-view': ({ data, stores }) => {
    const view = data['view'];
    if (typeof view === 'string' && isTaskView(view)) {
      applyFilter(stores, { view });
    }
  },

  'tasks:add-condition': ({ data, stores }) => {
    const field = data['field'];
    if (typeof field !== 'string' || !isConditionField(field)) return;
    const { conditions } = stores.$taskFilter.value;
    applyFilter(stores, { conditions: [...conditions, newCondition(field)] });
  },

  'tasks:remove-condition': ({ data, stores }) => {
    const id = data['conditionId'];
    if (typeof id !== 'string') return;
    const { conditions } = stores.$taskFilter.value;
    applyFilter(stores, { conditions: conditions.filter((c) => c.id !== id) });
  },

  'tasks:toggle-condition-value': ({ data, stores }) => {
    // A select condition's value buttons toggle membership of the value set.
    const id = data['conditionId'];
    const value = data['value'];
    if (typeof id !== 'string' || typeof value !== 'string') return;
    const { conditions } = stores.$taskFilter.value;
    applyFilter(stores, {
      conditions: conditions.map((c) => {
        if (c.id !== id || c.kind !== 'select') return c;
        const values = c.values.includes(value)
          ? c.values.filter((v) => v !== value)
          : [...c.values, value];
        return { ...c, values };
      }),
    });
  },

  'tasks:set-condition-op': ({ data, stores }) => {
    const id = data['conditionId'];
    const op = data['value'];
    if (typeof id !== 'string' || (op !== 'before' && op !== 'on' && op !== 'after')) return;
    const { conditions } = stores.$taskFilter.value;
    applyFilter(stores, {
      conditions: conditions.map((c) => (c.id === id && c.kind === 'date' ? { ...c, op } : c)),
    });
  },

  'tasks:set-condition-date': ({ data, stores }) => {
    const id = data['conditionId'];
    const value = data['value'];
    if (typeof id !== 'string' || typeof value !== 'string') return;
    const { conditions } = stores.$taskFilter.value;
    applyFilter(stores, {
      conditions: conditions.map((c) =>
        c.id === id && c.kind === 'date' ? { ...c, date: value } : c,
      ),
    });
  },

  'tasks:set-condition-text': ({ data, stores }) => {
    // ActionInput (saveOn="input") dispatches live on every keystroke so the
    // list filters as the user types.
    const id = data['conditionId'];
    const value = data['value'];
    if (typeof id !== 'string' || typeof value !== 'string') return;
    const { conditions } = stores.$taskFilter.value;
    applyFilter(stores, {
      conditions: conditions.map((c) =>
        c.id === id && c.kind === 'text' ? { ...c, query: value } : c,
      ),
    });
  },

  'tasks:set-condition-text-op': ({ data, stores }) => {
    const id = data['conditionId'];
    const op = data['value'];
    if (typeof id !== 'string' || typeof op !== 'string' || !isTextOp(op)) return;
    const { conditions } = stores.$taskFilter.value;
    applyFilter(stores, {
      conditions: conditions.map((c) => (c.id === id && c.kind === 'text' ? { ...c, op } : c)),
    });
  },

  'tasks:clear-filters': ({ stores }) => {
    // Drops every condition but keeps the current view scope.
    applyFilter(stores, { conditions: [] });
  },

  'tasks:quick-add': async ({ event, stores }) => {
    // The dispatch may be a form submit; prevent the browser's default reload.
    // preventDefault must be called synchronously, BEFORE any await.
    event.preventDefault();
    const title = stores.$quickAddTitle.value.trim();
    if (title.length === 0) return;
    stores.$tasksError.value = null;
    // Clear input immediately so the user can keep typing the next task.
    stores.$quickAddTitle.value = '';
    try {
      const task = await stores.client.createTask({ title });
      // The optimistic insertion: server already returned the canonical row,
      // so we splice it straight into the store. WS broadcast will arrive
      // and overwrite with byte-identical data.
      patchTasks(stores, (m) => m.set(task.id, task));
    } catch (err) {
      stores.$tasksError.value = friendlyTaskError(err);
      // Restore the input so the user can retry without retyping.
      stores.$quickAddTitle.value = title;
    }
  },

  'tasks:toggle': async ({ data, stores }) => {
    const idRaw = data['taskId'];
    if (typeof idRaw !== 'string') return;
    const id = Number(idRaw);
    const current = stores.$tasksById.value.get(id);
    if (!current) return;
    stores.$tasksError.value = null;
    const completing = current.status === 'open';
    try {
      const task = completing
        ? await stores.client.completeTask(id)
        : await stores.client.reopenTask(id);
      patchTasks(stores, (m) => m.set(task.id, task));
      // Linger: a task you just completed stays visible (with a strike-through)
      // until you navigate, instead of vanishing under a status=open / today
      // filter. Reopening removes the linger mark — it's open again.
      const linger = new Set(stores.$recentlyCompleted.value);
      if (completing) linger.add(id);
      else linger.delete(id);
      stores.$recentlyCompleted.value = linger;
    } catch (err) {
      stores.$tasksError.value = friendlyTaskError(err);
    }
  },

  'tasks:delete': async ({ data, stores }) => {
    const idRaw = data['taskId'];
    if (typeof idRaw !== 'string') return;
    const id = Number(idRaw);
    stores.$tasksError.value = null;
    try {
      const task = await stores.client.deleteTask(id);
      patchTasks(stores, (m) => m.set(task.id, task));
    } catch (err) {
      stores.$tasksError.value = friendlyTaskError(err);
    }
  },

  'tasks:expand': ({ data, stores }) => {
    // Clicking a task title opens its detail editor — or closes it if already
    // open. A set, so a parent and a nested subtask can both stay expanded.
    const id = taskIdFromData(data);
    if (id === null) return;
    const next = new Set(stores.$expandedTaskIds.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    stores.$expandedTaskIds.value = next;
  },

  'tasks:add-subtask': async ({ data, stores }) => {
    // Dispatched by the subtask ActionInput (saveOn="enter"). The parent id
    // rides on actionData; the title is the committed value.
    const parentId = taskIdFromData(data);
    const value = data['value'];
    if (parentId === null || typeof value !== 'string') return;
    const title = value.trim();
    if (title.length === 0) return;
    stores.$tasksError.value = null;
    try {
      const task = await stores.client.createTask({ title, parentId });
      patchTasks(stores, (m) => m.set(task.id, task));
    } catch (err) {
      stores.$tasksError.value = friendlyTaskError(err);
    }
  },

  // The detail-editor fields are ActionInput/ActionSelect — each commits its
  // value through the action system, delivered here as `data.value`.
  'tasks:edit-notes': ({ data, stores }) => {
    const id = taskIdFromData(data);
    const value = data['value'];
    if (id === null || typeof value !== 'string') return;
    void commitTaskField(stores, id, { notes: value });
  },

  'tasks:edit-due': ({ data, stores }) => {
    const id = taskIdFromData(data);
    const value = data['value'];
    if (id === null || typeof value !== 'string') return;
    void commitTaskField(stores, id, { dueAt: value === '' ? null : value });
  },

  'tasks:edit-defer': ({ data, stores }) => {
    const id = taskIdFromData(data);
    const value = data['value'];
    if (id === null || typeof value !== 'string') return;
    void commitTaskField(stores, id, { deferUntil: value === '' ? null : value });
  },

  'tasks:edit-assignee': ({ data, stores }) => {
    const id = taskIdFromData(data);
    const value = data['value'];
    if (id === null || typeof value !== 'string') return;
    void commitTaskField(stores, id, { assignedTo: value === '' ? null : Number(value) });
  },

  'tasks:restore': async ({ data, stores }) => {
    const idRaw = data['taskId'];
    if (typeof idRaw !== 'string') return;
    const id = Number(idRaw);
    stores.$tasksError.value = null;
    try {
      const task = await stores.client.restoreTask(id);
      patchTasks(stores, (m) => m.set(task.id, task));
    } catch (err) {
      stores.$tasksError.value = friendlyTaskError(err);
    }
  },
};
