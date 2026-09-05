// Browser tier — component test against MockEalClient. NOT real-api coverage.
// See ./README.md for tier scope and where real-api coverage lives.
import { describe, test, expect, waitFor, done } from '@fairfox/polly/test/browser';
import { installEventDelegation } from '@fairfox/polly/actions';
import { flushMicrotasks } from '@eal/shared';
import { render } from 'preact';
import { createMockEalClient } from '@eal/client-mock';
import type { Task } from '@eal/client';
import { App } from '../../src/shell/app.tsx';
import { createStores, resetStoresForTest } from '../../src/stores.ts';
import { $householdUsers, $quickAddTitle } from '../../src/apps/tasks/stores.ts';
import { ACTION_REGISTRY } from '../../src/actions/registry.ts';
import { $route } from '../../src/shell/router.ts';

import '@fairfox/polly/ui/theme.css';
import '@fairfox/polly/ui/styles.css';
import '@fairfox/polly/ui/components.css';

const root =
  document.getElementById('app') ??
  (() => {
    const el = document.createElement('div');
    el.id = 'app';
    document.body.appendChild(el);
    return el;
  })();

const mock = createMockEalClient();
const stores = createStores(mock);
installEventDelegation((dispatch) => {
  const handler = ACTION_REGISTRY[dispatch.action];
  if (handler) void handler({ ...dispatch, stores });
});

function signedIn() {
  resetStoresForTest();
  mock.reset();
  // Reconciliation handler — same one main.tsx installs in production.
  mock.subscribeTaskEvents((event) => {
    const next = new Map(stores.$tasksById.value);
    if (event.type === 'task:tree-cloned') {
      for (const t of event.payload.tasks) next.set(t.id, t);
    } else {
      next.set(event.payload.id, event.payload);
    }
    stores.$tasksById.value = next;
  });
  mock.setCurrentUser({ userId: 1, displayName: 'alex' });
  stores.$currentUser.value = { userId: 1, displayName: 'alex' };
  // The shell router mounts the tasks app at /tasks.
  $route.value = '/tasks';
  render(<App />, root);
}

function clickAction(action: string, dataset: Record<string, string> = {}): void {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(`[data-action="${action}"]`));
  const match = candidates.find((el) =>
    Object.entries(dataset).every(([k, v]) => el.getAttribute(`data-action-${k}`) === v),
  );
  if (!match) throw new Error(`no [data-action="${action}"] with ${JSON.stringify(dataset)}`);
  match.click();
}

/** Invoke an action handler directly with its committed data. The form
 *  controls are ActionInput/ActionSelect, which dispatch programmatically and
 *  carry no `data-action` attribute to click — so component-tier tests drive
 *  the handler; the real component interaction is covered by the e2e. */
function commit(action: string, data: Record<string, string>): void {
  const handler = ACTION_REGISTRY[action];
  if (!handler) throw new Error(`no ${action} handler`);
  void handler({ element: document.body, event: new Event('click'), data, stores });
}

function rowIds(): number[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-task-row]'))
    .map((el) => Number(el.dataset['taskId']))
    .filter((n) => !Number.isNaN(n));
}

function rowTitles(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-task-row] [data-task-title]')).map(
    (el) => el.textContent ?? '',
  );
}

async function addTask(title: string): Promise<number> {
  const before = rowIds().length;
  $quickAddTitle.value = title;
  clickAction('tasks:quick-add');
  await waitFor(() => rowIds().length === before + 1);
  const created = stores.$tasksById.value;
  let id = -1;
  for (const t of created.values()) {
    if (t.title === title) id = t.id;
  }
  return id;
}

describe('Tasks UI (browser)', () => {
  test('signed-in empty state renders the filter bar + panel', () => {
    signedIn();
    expect(document.querySelector('[data-tasks-panel]')).not.toBeNull();
    expect(document.querySelector('[data-tasks-filter-bar]')).not.toBeNull();
    expect(document.querySelector('[data-tasks-empty]')?.textContent ?? '').toContain('inbox');
  });

  test('anonymous: no tasks panel, sign-in card instead', () => {
    resetStoresForTest();
    mock.reset();
    render(<App />, root);
    expect(document.querySelector('[data-tasks-panel]')).toBeNull();
    expect(document.querySelector('[data-sign-in]')).not.toBeNull();
  });

  test('quick-add creates a task, clears the input, renders the row', async () => {
    signedIn();
    await addTask('Buy milk');
    expect(rowTitles()).toEqual(['Buy milk']);
    expect($quickAddTitle.value).toBe('');
  });

  test('quick-add with an empty title is a silent no-op', async () => {
    signedIn();
    $quickAddTitle.value = '   ';
    clickAction('tasks:quick-add');
    // The empty-title path returns before any await; flushing the microtask
    // queue settles the dispatch deterministically — no arbitrary delay.
    await flushMicrotasks();
    expect(mock.peekTasks()).toHaveLength(0);
  });

  test('quick-add server failure surfaces friendly copy, restores the input', async () => {
    signedIn();
    mock.mockTaskError(new Error('would create cycle: nope'));
    $quickAddTitle.value = 'retry me';
    clickAction('tasks:quick-add');
    await waitFor(() => document.querySelector('[data-tasks-error]') !== null);
    expect(document.querySelector('[data-tasks-error]')?.textContent ?? '').toContain(
      "can't move a task inside itself",
    );
    expect($quickAddTitle.value).toBe('retry me');
  });

  test('toggle flips status; the row keeps its data-task-status in sync', async () => {
    signedIn();
    const id = await addTask('walk dog');
    clickAction('tasks:toggle', { 'task-id': String(id) });
    await waitFor(
      () => document.querySelector<HTMLElement>(`[data-task-id="${id}"]`)?.dataset['taskStatus'] === 'done',
    );
    clickAction('tasks:toggle', { 'task-id': String(id) });
    await waitFor(
      () => document.querySelector<HTMLElement>(`[data-task-id="${id}"]`)?.dataset['taskStatus'] === 'open',
    );
  });

  test('delete moves a row to Trash; restore brings it back', async () => {
    signedIn();
    const id = await addTask('thing');
    clickAction('tasks:delete', { 'task-id': String(id) });
    await waitFor(() => rowIds().length === 0);

    clickAction('tasks:set-view', { view: 'trash' });
    await waitFor(() => rowIds().length === 1);
    expect(document.querySelector('[data-action="tasks:restore"]')).not.toBeNull();
    // Quick-add is hidden in Trash.
    expect(document.querySelector('[data-tasks-quick-add-form]')).toBeNull();

    clickAction('tasks:restore', { 'task-id': String(id) });
    await waitFor(() => rowIds().length === 0);
    clickAction('tasks:set-view', { view: 'inbox' });
    await waitFor(() => rowIds().length === 1);
  });

  describe('composable filter', () => {
    test('status condition: Open hides done tasks, Done shows only them', async () => {
      signedIn();
      const a = await addTask('a');
      await addTask('b');
      clickAction('tasks:toggle', { 'task-id': String(a) }); // complete 'a'
      await waitFor(
        () => document.querySelector<HTMLElement>(`[data-task-id="${a}"]`)?.dataset['taskStatus'] === 'done',
      );

      clickAction('tasks:add-condition', { field: 'status' });
      await waitFor(() => document.querySelector('[data-condition-field="status"]') !== null);

      // Narrow to Open — adding the condition cleared linger, so done 'a' drops.
      clickAction('tasks:toggle-condition-value', { value: 'open' });
      await waitFor(() => rowTitles().join(',') === 'b');

      // Flip the value set to Done.
      clickAction('tasks:toggle-condition-value', { value: 'open' });
      clickAction('tasks:toggle-condition-value', { value: 'done' });
      await waitFor(() => rowTitles().join(',') === 'a');
    });

    test('assignee condition: filter to a member or to unassigned', async () => {
      signedIn();
      // The value buttons are built from the household roster.
      $householdUsers.value = [{ id: 1, displayName: 'alex', inIvrMenu: false }];
      await addTask('unassigned one');
      const mineId = 9001;
      const mine: Task = {
        id: mineId,
        parentId: null,
        title: 'mine one',
        notes: '',
        status: 'open',
        deferUntil: null,
        dueAt: null,
        createdBy: 1,
        assignedTo: 1,
        updatedBy: 1,
        createdAt: '2026-05-20T08:00:00Z',
        updatedAt: '2026-05-20T08:00:00Z',
        completedAt: null,
        deletedAt: null,
        position: 50,
      };
      stores.$tasksById.value = new Map([...stores.$tasksById.value, [mineId, mine]]);
      // Assigned tasks aren't in the Inbox view — switch to All.
      clickAction('tasks:set-view', { view: 'all' });
      await waitFor(() => rowIds().length === 2);

      clickAction('tasks:add-condition', { field: 'assignee' });
      await waitFor(() => document.querySelector('[data-condition-field="assignee"]') !== null);

      clickAction('tasks:toggle-condition-value', { value: '1' });
      await waitFor(() => rowTitles().join(',') === 'mine one');

      clickAction('tasks:toggle-condition-value', { value: '1' });
      clickAction('tasks:toggle-condition-value', { value: 'unassigned' });
      await waitFor(() => rowTitles().join(',') === 'unassigned one');
    });

    test('text condition narrows by title; Clear all drops every condition', async () => {
      signedIn();
      await addTask('Buy milk');
      await addTask('Buy bread');
      await addTask('Call dentist');

      clickAction('tasks:add-condition', { field: 'text' });
      await waitFor(() => document.querySelector('[data-condition-field="text"]') !== null);

      const conditionId = stores.$taskFilter.value.conditions[0]?.id;
      if (conditionId === undefined) throw new Error('no text condition');
      commit('tasks:set-condition-text', { conditionId, value: 'buy' });
      await waitFor(() => rowIds().length === 2);
      expect(rowTitles().sort()).toEqual(['Buy bread', 'Buy milk']);

      clickAction('tasks:clear-filters');
      await waitFor(() => rowIds().length === 3);
      expect(document.querySelector('[data-condition-row]')).toBeNull();
    });
  });

  describe('linger', () => {
    test('completing a task under a status=open condition keeps it visible until navigation', async () => {
      signedIn();
      const a = await addTask('a');
      await addTask('b');

      // Restrict to open FIRST, then complete — the completed task must linger.
      clickAction('tasks:add-condition', { field: 'status' });
      await waitFor(() => document.querySelector('[data-condition-field="status"]') !== null);
      clickAction('tasks:toggle-condition-value', { value: 'open' });
      await waitFor(() => rowIds().length === 2);

      clickAction('tasks:toggle', { 'task-id': String(a) });
      await waitFor(
        () => document.querySelector<HTMLElement>(`[data-task-id="${a}"]`)?.dataset['taskStatus'] === 'done',
      );
      // Still on screen — struck-through, not vanished.
      expect(rowIds().includes(a)).toBe(true);

      // Navigating (any filter change) clears the linger; status=open hides it.
      clickAction('tasks:set-view', { view: 'all' });
      await waitFor(() => rowTitles().join(',') === 'b');
    });
  });

  describe('convergence', () => {
    test('a server broadcast overwrites the optimistic local row', async () => {
      signedIn();
      const id = await addTask('race');
      const local = stores.$tasksById.value.get(id);
      if (!local) throw new Error('test bug: no local copy');
      mock.emitTaskEvent({
        type: 'task:updated',
        topic: 'tasks',
        payload: { ...local, title: 'racing (server-canonical)' },
      });
      await waitFor(() => rowTitles()[0] === 'racing (server-canonical)');
    });

    test('a broadcasted deletion removes the row with no local action', async () => {
      signedIn();
      const seeded: Task = {
        id: 99,
        parentId: null,
        title: 'remote',
        notes: '',
        status: 'open',
        deferUntil: null,
        dueAt: null,
        createdBy: 2,
        assignedTo: null,
        updatedBy: 2,
        createdAt: '2026-05-20T08:00:00Z',
        updatedAt: '2026-05-20T08:00:00Z',
        completedAt: null,
        deletedAt: null,
        position: 0,
      };
      stores.$tasksById.value = new Map([[seeded.id, seeded]]);
      await waitFor(() => rowIds().length === 1);
      mock.emitTaskEvent({
        type: 'task:deleted',
        topic: 'tasks',
        payload: { ...seeded, deletedAt: '2026-05-20T10:00:00Z' },
      });
      await waitFor(() => rowIds().length === 0);
    });
  });
});

describe('task detail editor', () => {
  test('clicking a task title expands an inline editor with every field', async () => {
    signedIn();
    const id = await addTask('Fix the gate');
    expect(document.querySelector('[data-task-detail]')).toBeNull();

    clickAction('tasks:expand', { 'task-id': String(id) });
    await waitFor(() => document.querySelector('[data-task-detail]') !== null);

    const labels = document.querySelector('[data-task-detail]')?.textContent ?? '';
    expect(labels).toContain('Notes');
    expect(labels).toContain('Due');
    expect(labels).toContain('Hide until');
    expect(labels).toContain('Assignee');
    expect(labels).toContain('Subtasks');
  });

  test('clicking the title again collapses the editor', async () => {
    signedIn();
    const id = await addTask('Plan the trip');
    clickAction('tasks:expand', { 'task-id': String(id) });
    await waitFor(() => document.querySelector('[data-task-detail]') !== null);

    clickAction('tasks:expand', { 'task-id': String(id) });
    await waitFor(() => document.querySelector('[data-task-detail]') === null);
    expect(document.querySelector('[data-task-detail]')).toBeNull();
  });

  test('choosing an assignee commits it and shows a badge on the row', async () => {
    signedIn();
    $householdUsers.value = [
      { id: 1, displayName: 'alex', inIvrMenu: false },
      { id: 2, displayName: 'elisa', inIvrMenu: false },
    ];
    // Use the All view — assigning a task drops it out of the Inbox (Inbox is
    // unassigned tasks), and we want the row to stay visible.
    clickAction('tasks:set-view', { view: 'all' });
    const id = await addTask('Buy milk');
    expect(document.querySelector('[data-task-assignee]')).toBeNull();

    clickAction('tasks:expand', { 'task-id': String(id) });
    await waitFor(() => document.querySelector('[data-task-detail]') !== null);

    commit('tasks:edit-assignee', { taskId: String(id), value: '2' });

    await waitFor(() => stores.$tasksById.value.get(id)?.assignedTo === 2);
    await waitFor(() => document.querySelector('[data-task-assignee]') !== null);
    expect(document.querySelector('[data-task-assignee]')?.textContent).toContain('elisa');
  });

  test('setting a due date commits it and shows a due badge', async () => {
    signedIn();
    const id = await addTask('Call the plumber');
    clickAction('tasks:expand', { 'task-id': String(id) });
    await waitFor(() => document.querySelector('[data-task-detail]') !== null);

    commit('tasks:edit-due', { taskId: String(id), value: '2026-06-15' });

    await waitFor(() => stores.$tasksById.value.get(id)?.dueAt === '2026-06-15');
    await waitFor(() => document.querySelector('[data-task-due]') !== null);
    expect(document.querySelector('[data-task-due]')?.textContent).toContain('2026-06-15');
  });
});

/** Add a subtask — in production the subtask ActionInput dispatches this on Enter. */
function addSubtask(parentId: number, title: string): void {
  commit('tasks:add-subtask', { taskId: String(parentId), value: title });
}

/** The id of the one listed row that is not `notThis`. Throws rather than
 *  returning a widened type, so the caller reads a plain number. */
function otherRowId(notThis: number): number {
  const found = rowIds().find((id) => id !== notThis);
  if (found === undefined) throw new Error(`no listed row other than ${notThis}`);
  return found;
}

describe('subtasks', () => {
  test('a subtask gets its own row, right after its parent, naming it', async () => {
    signedIn();
    clickAction('tasks:set-view', { view: 'all' });
    const parentId = await addTask('Plan the trip');

    clickAction('tasks:expand', { 'task-id': String(parentId) });
    await waitFor(() => document.querySelector('[data-task-detail]') !== null);

    addSubtask(parentId, 'Book flights');
    await waitFor(() => rowTitles().length === 2);

    // Tree order: the child follows the parent it belongs to.
    expect(rowTitles()).toEqual(['Plan the trip', 'Book flights']);

    // The child's row names its container; the parent's row carries none.
    const parentBadges = document.querySelectorAll('[data-task-parent]');
    expect(parentBadges.length).toBe(1);
    expect(parentBadges[0]?.textContent).toContain('Plan the trip');

    // The parent's row gains a done/total progress badge.
    await waitFor(() => document.querySelector('[data-task-progress]') !== null);
    expect(document.querySelector('[data-task-progress]')?.textContent).toContain('0/1');
  });

  test('progress counts the whole subtree, not just the direct children', async () => {
    signedIn();
    clickAction('tasks:set-view', { view: 'all' });
    const parentId = await addTask('Plan the trip');
    addSubtask(parentId, 'Book flights');
    await waitFor(() => rowIds().length === 2);

    addSubtask(otherRowId(parentId), 'Pick seats');
    await waitFor(() => rowIds().length === 3);

    const progress = document.querySelectorAll('[data-task-progress]');
    // The root counts both descendants; the middle task counts its one.
    expect(progress[0]?.textContent).toContain('0/2');
    expect(progress[1]?.textContent).toContain('0/1');
  });

  test('a subtask is itself expandable — the tree is recursive', async () => {
    signedIn();
    clickAction('tasks:set-view', { view: 'all' });
    const parentId = await addTask('Plan the trip');
    clickAction('tasks:expand', { 'task-id': String(parentId) });
    await waitFor(() => document.querySelector('[data-task-detail]') !== null);
    addSubtask(parentId, 'Book flights');
    await waitFor(() => rowIds().length === 2);

    const subId = otherRowId(parentId);
    clickAction('tasks:expand', { 'task-id': String(subId) });
    // Parent detail + subtask detail are both open at once.
    await waitFor(() => document.querySelectorAll('[data-task-detail]').length === 2);
    expect(document.querySelectorAll('[data-task-detail]').length).toBe(2);
  });

  test('the inbox stays unfiled capture — a subtask never lands there', async () => {
    signedIn();
    clickAction('tasks:set-view', { view: 'all' });
    const parentId = await addTask('Plan the trip');
    addSubtask(parentId, 'Book flights');
    await waitFor(() => rowTitles().length === 2);

    clickAction('tasks:set-view', { view: 'inbox' });
    await waitFor(() => rowTitles().length === 1);
    expect(rowTitles()).toEqual(['Plan the trip']);
  });
});

done();
