import type { ActionRegistry } from '@fairfox/polly/actions';
import type { Task, TaskKind, UpdateTaskInput } from '@eal/client';
import type { AppStores } from '../../stores.ts';
import {
  dropPushSubscription,
  ensurePushSubscription,
  pushPermission,
  requestPushPermission,
} from '../../platform/push.ts';
import { adjacentLane, isTaskStatus } from './board.ts';
import {
  isConditionField,
  isTextOp,
  newCondition,
  type TaskFilter,
  type TaskLayout,
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
  // The level rules, in the order a specific message must beat a general one:
  // the stranded-children message quotes the pairing that failed, so it would
  // otherwise be swallowed by the three tests below it.
  if (raw.includes('would no longer fit under it')) {
    return 'What is already filed under this one would not fit at that level. Move it out first.';
  }
  if (raw.includes('a project cannot be filed under another task')) {
    return 'A project sits at the top level, not inside something else.';
  }
  if (raw.includes('an epic must be filed under a project')) {
    return 'An epic has to sit inside a project.';
  }
  if (raw.includes('a task cannot be filed under another task')) {
    return 'A plain task cannot hold anything. Make it a project or an epic first.';
  }
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
  return (
    value === 'inbox' ||
    value === 'today' ||
    value === 'all' ||
    value === 'trash' ||
    value === 'next'
  );
}

function isTaskKind(value: string): value is TaskKind {
  return value === 'project' || value === 'epic' || value === 'task';
}

function isTaskLayout(value: string): value is TaskLayout {
  return value === 'list' || value === 'board';
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

  'tasks:set-layout': ({ data, stores }) => {
    const layout = data['layout'];
    if (typeof layout === 'string' && isTaskLayout(layout)) {
      applyFilter(stores, { layout });
    }
  },

  // Paging the board on a narrow screen. Not routed through applyFilter: the
  // lane is where you are looking, not what you asked for, so it must not clear
  // the linger set — a task you tick in the Doing lane should stay put long
  // enough to see it move.
  'tasks:board-lane-step': ({ data, stores }) => {
    const step = data['step'];
    if (step !== 'next' && step !== 'prev') return;
    stores.$boardLane.value = adjacentLane(stores.$boardLane.value, step === 'next' ? 1 : -1);
  },

  'tasks:enter-scope': ({ data, stores }) => {
    // Standing inside a container. The inbox is the one view that cannot hold
    // a scoped row — it means unfiled capture at the top level, so everything
    // in a subtree is disqualified by definition — so entering from there
    // moves to All. Today and Trash both read sensibly scoped and are kept.
    const id = taskIdFromData(data);
    if (id === null) return;
    const { view } = stores.$taskFilter.value;
    applyFilter(stores, { scope: id, view: view === 'inbox' ? 'all' : view });
  },

  'tasks:leave-scope': ({ stores }) => {
    applyFilter(stores, { scope: null });
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
    // Capture lands where the user is standing. Creating a root task while
    // scoped into a project would file it somewhere the list cannot show, so
    // the row would appear to vanish; inside a scope, quick-add fills the
    // container. A scope naming something that cannot hold a task is rejected
    // by the server and surfaces below, rather than being quietly re-filed.
    const { scope } = stores.$taskFilter.value;
    // Through the outbox, online or not: the entry is stored before it is sent,
    // shows as pending until the server's row comes back, and is sent again for
    // as long as no answer arrives. A refusal lands in `$tasksError` and hands
    // the title back to the input — see outbox.ts.
    await stores.outbox.capture({ title, parentId: scope });
  },

  'tasks:toggle': async ({ data, stores }) => {
    const idRaw = data['taskId'];
    if (typeof idRaw !== 'string') return;
    const id = Number(idRaw);
    const current = stores.$tasksById.value.get(id);
    if (!current) return;
    stores.$tasksError.value = null;
    // Any unfinished state completes; only `done` reopens. A task you started,
    // and one you are stuck on, both tick off in one tap — being made to move a
    // card to Doing before you may finish it would be a tax on the fast path.
    const completing = current.status !== 'done';
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

  'tasks:set-kind': ({ data, stores }) => {
    // The level picker. The server owns the rule, so an illegal promotion comes
    // back through commitTaskField's catch and lands in $tasksError like any
    // other rejected field edit — the picker does not pre-filter its options,
    // because the reason a move is illegal is worth reading.
    const id = taskIdFromData(data);
    const value = data['value'];
    if (id === null || typeof value !== 'string' || !isTaskKind(value)) return;
    void commitTaskField(stores, id, { kind: value });
  },

  'tasks:set-sequential': ({ data, stores }) => {
    // The Order picker in the detail editor. Two values and no third, so an
    // unrecognised one is dropped rather than guessed at: the alternative is
    // treating "seqential" as parallel and quietly reordering someone's
    // project. Only ever rendered on a container (tasks-panel.tsx), which is
    // where the flag means anything.
    const id = taskIdFromData(data);
    const value = data['value'];
    if (id === null || (value !== 'sequential' && value !== 'parallel')) return;
    void commitTaskField(stores, id, { sequential: value === 'sequential' });
  },

  'tasks:set-status': async ({ data, stores }) => {
    // The lane picker on a board card, and the Status field in the detail
    // editor — one action, because moving a card and choosing a state from the
    // editor are the same write.
    const id = taskIdFromData(data);
    const value = data['value'];
    if (id === null || typeof value !== 'string' || !isTaskStatus(value)) return;
    stores.$tasksError.value = null;
    try {
      const task = await stores.client.setTaskStatus(id, value);
      patchTasks(stores, (m) => m.set(task.id, task));
      // Same linger rule the checkbox follows: a card moved into Done stays
      // visible under a status filter until the next navigation, and one moved
      // back out loses the mark.
      const linger = new Set(stores.$recentlyCompleted.value);
      if (value === 'done') linger.add(id);
      else linger.delete(id);
      stores.$recentlyCompleted.value = linger;
    } catch (err) {
      stores.$tasksError.value = friendlyTaskError(err);
    }
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

  /**
   * Turn deadlines into something the phone does when eal is closed.
   *
   * This must run from a real tap and nothing else. `Notification.requestPermission()`
   * is gesture-gated in every browser that implements it: called from a boot
   * path, a timer or a promise resolved after the gesture has been forgotten, it
   * resolves 'denied' without ever showing the prompt — and 'denied' is the one
   * state eal cannot walk back from, because only the browser's own site
   * settings can. So the whole sequence stays inside the click handler.
   */
  'tasks:enable-reminders': async ({ stores }) => {
    stores.$tasksError.value = null;
    if (pushPermission() === 'unsupported') {
      stores.$reminderState.value = 'unsupported';
      return;
    }
    stores.$reminderState.value = 'working';
    try {
      const granted = await requestPushPermission();
      if (granted !== 'granted') {
        stores.$reminderState.value = granted === 'denied' ? 'denied' : 'off';
        return;
      }
      const subscription = await ensurePushSubscription();
      if (subscription === null) {
        // Permission is granted but no subscription came back — the server has
        // no VAPID keypair configured, or the vendor refused. Both are real and
        // neither is the person's fault, so say so rather than leaving a
        // control that looks like it did nothing.
        stores.$reminderState.value = 'off';
        stores.$tasksError.value =
          'Notifications are allowed, but this server cannot send them yet.';
        return;
      }
      await stores.client.subscribeUserPush(subscription);
      stores.$reminderState.value = 'on';
    } catch (err) {
      stores.$reminderState.value = 'off';
      stores.$tasksError.value = friendlyTaskError(err);
    }
  },

  /**
   * Stop them. Both halves, in this order: the browser drops the subscription
   * (which is what stops the buzzing) and then the server forgets the endpoint
   * (which is what stops it trying). Reversing the order would leave a window
   * where the server has forgotten a subscription that still delivers.
   */
  'tasks:disable-reminders': async ({ stores }) => {
    stores.$tasksError.value = null;
    stores.$reminderState.value = 'working';
    try {
      const endpoint = await dropPushSubscription();
      if (endpoint !== null) await stores.client.unsubscribeUserPush(endpoint);
      stores.$reminderState.value = 'off';
    } catch (err) {
      stores.$reminderState.value = 'on';
      stores.$tasksError.value = friendlyTaskError(err);
    }
  },
};

/**
 * Read this browser's reminder state at sign-in, and refresh the subscription
 * when it is already granted.
 *
 * Re-registering on every boot is deliberate, and mirrors what the devices app
 * already does on every device connect: a vendor may rotate an endpoint, and a
 * server may be given a new VAPID keypair, and in both cases the row the server
 * holds is dead while the browser still believes it is subscribed. Rebinding
 * costs one round trip and closes that gap.
 *
 * No permission is ever *requested* here — see the gesture rule above. This
 * only reads a grant that already exists.
 */
export async function bootstrapTaskReminders(stores: AppStores): Promise<void> {
  const permission = pushPermission();
  if (permission === 'unsupported') {
    stores.$reminderState.value = 'unsupported';
    return;
  }
  if (permission === 'denied') {
    stores.$reminderState.value = 'denied';
    return;
  }
  if (permission !== 'granted') {
    stores.$reminderState.value = 'off';
    return;
  }
  try {
    const subscription = await ensurePushSubscription();
    if (subscription === null) {
      stores.$reminderState.value = 'off';
      return;
    }
    await stores.client.subscribeUserPush(subscription);
    stores.$reminderState.value = 'on';
  } catch (err) {
    // Non-fatal, and deliberately not surfaced in the tasks error banner: the
    // person did not ask for this, it happened on their behalf at boot.
    console.warn('[reminders] re-subscribe at boot failed:', err);
    stores.$reminderState.value = 'off';
  }
}
