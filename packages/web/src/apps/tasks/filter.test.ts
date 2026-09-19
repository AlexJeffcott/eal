import { describe, expect, test } from 'bun:test';
import type { Task } from '@eal/client';
import {
  type Condition,
  DATE_OPS,
  DEFAULT_FILTER,
  FILTER_FIELDS,
  freshFilter,
  hasActiveRefinements,
  isConditionField,
  newCondition,
  parseFilterFromUrl,
  serializeFilterToUrl,
  STATUS_OPTIONS,
  SUBTASK_OPTIONS,
  type TaskFilter,
  TEXT_OPS,
  type TextOp,
  visibleFor,
} from './filter.ts';

function task(overrides: Partial<Task> & { id: number; title: string }): Task {
  return {
    parentId: null,
    notes: '',
    status: 'todo',
    kind: 'task',
    deferUntil: null,
    dueAt: null,
    createdBy: 1,
    assignedTo: null,
    updatedBy: 1,
    createdAt: '2026-05-20T08:00:00Z',
    updatedAt: '2026-05-20T08:00:00Z',
    completedAt: null,
    deletedAt: null,
    position: 0,
    sequential: false,
    clientId: null,
    ...overrides,
  };
}

function mapOf(...tasks: Task[]): Map<number, Task> {
  return new Map(tasks.map((t) => [t.id, t]));
}

const NOW = new Date('2026-05-20T12:00:00Z');
const ctx = { now: NOW };
const noLinger = new Set<number>();

// Condition builders for tests — `visibleFor` ignores `id`, so a dummy is fine.
function sel(field: 'status' | 'assignee' | 'subtasks', values: string[]): Condition {
  return { id: `c-${field}`, kind: 'select', field, values };
}
function dat(field: 'due' | 'hideUntil', op: 'before' | 'on' | 'after', date: string): Condition {
  return { id: `c-${field}`, kind: 'date', field, op, date };
}
function txt(query: string, op: TextOp = 'contains'): Condition {
  return { id: 'c-text', kind: 'text', field: 'text', op, query };
}
function withConds(view: TaskFilter['view'], conditions: Condition[]): TaskFilter {
  return { view, scope: null, layout: 'list', conditions };
}
/** A filter standing inside one container. */
function inScope(view: TaskFilter['view'], scope: number, conditions: Condition[] = []): TaskFilter {
  return { view, scope, layout: 'list', conditions };
}
function ids(out: Task[]): number[] {
  return out.map((t) => t.id);
}

describe('parseFilterFromUrl', () => {
  test('empty search → default filter (inbox, no conditions)', () => {
    expect(parseFilterFromUrl('')).toEqual({
      view: 'inbox',
      scope: null,
      layout: 'list',
      conditions: [],
    });
  });

  test('parses the view and a list of conditions', () => {
    const f = parseFilterFromUrl('?view=all&c=status:todo&c=text:contains:milk');
    expect(f.view).toBe('all');
    expect(f.conditions).toHaveLength(2);
    const [a, b] = f.conditions;
    expect(a).toMatchObject({ kind: 'select', field: 'status', values: ['todo'] });
    expect(b).toMatchObject({ kind: 'text', field: 'text', op: 'contains', query: 'milk' });
  });

  test('text conditions parse every op and reject malformed ones', () => {
    expect(parseFilterFromUrl('?c=text:starts-with:buy').conditions[0]).toMatchObject({
      kind: 'text',
      op: 'starts-with',
      query: 'buy',
    });
    expect(parseFilterFromUrl('?c=text:exact:hi').conditions[0]).toMatchObject({ op: 'exact' });
    expect(parseFilterFromUrl('?c=text:fuzzy:mlk').conditions[0]).toMatchObject({ op: 'fuzzy' });
    expect(parseFilterFromUrl('?c=text:bogus:buy').conditions).toEqual([]);
    expect(parseFilterFromUrl('?c=text:contains:').conditions).toEqual([]);
    expect(parseFilterFromUrl('?c=text:containsX').conditions).toEqual([]);
    expect(parseFilterFromUrl('?c=notafield:contains:milk').conditions).toEqual([]);
  });

  test('a select condition carries multiple values', () => {
    const f = parseFilterFromUrl('?c=assignee:2,unassigned');
    expect(f.conditions[0]).toMatchObject({
      kind: 'select',
      field: 'assignee',
      values: ['2', 'unassigned'],
    });
  });

  test('a date condition carries op + date', () => {
    const f = parseFilterFromUrl('?c=due:before:2026-07-01');
    expect(f.conditions[0]).toMatchObject({
      kind: 'date',
      field: 'due',
      op: 'before',
      date: '2026-07-01',
    });
  });

  test('malformed conditions are dropped — a bad URL never throws', () => {
    const f = parseFilterFromUrl(
      '?view=wat&c=bogus&c=status:&c=status:purple&c=due:sideways:2026-07-01&c=due:before:2026-13-99&c=',
    );
    expect(f.view).toBe('inbox');
    expect(f.conditions).toEqual([]);
  });

  test('every condition gets a distinct id', () => {
    const f = parseFilterFromUrl('?c=status:todo&c=status:done');
    expect(f.conditions[0]?.id).not.toBe(f.conditions[1]?.id);
  });

  test('select conditions drop invalid values and keep the valid ones', () => {
    expect(parseFilterFromUrl('?c=status:todo,purple,blocked,done').conditions[0]).toMatchObject({
      field: 'status',
      values: ['todo', 'blocked', 'done'],
    });
    expect(parseFilterFromUrl('?c=subtasks:has,bogus,none').conditions[0]).toMatchObject({
      field: 'subtasks',
      values: ['has', 'none'],
    });
    expect(parseFilterFromUrl('?c=assignee:5,unassigned,abc').conditions[0]).toMatchObject({
      field: 'assignee',
      values: ['5', 'unassigned'],
    });
  });

  test('assignee accepts multi-digit ids but rejects partial-numeric values', () => {
    expect(parseFilterFromUrl('?c=assignee:55').conditions[0]).toMatchObject({ values: ['55'] });
    expect(parseFilterFromUrl('?c=assignee:5x').conditions).toEqual([]);
    expect(parseFilterFromUrl('?c=assignee:x5').conditions).toEqual([]);
  });

  test('date conditions parse every op and reject malformed dates', () => {
    expect(parseFilterFromUrl('?c=due:after:2026-07-01').conditions[0]).toMatchObject({
      field: 'due',
      op: 'after',
      date: '2026-07-01',
    });
    expect(parseFilterFromUrl('?c=due:before:x2026-07-01').conditions).toEqual([]);
    expect(parseFilterFromUrl('?c=due:before:2026-07-01x').conditions).toEqual([]);
    expect(parseFilterFromUrl('?c=due:before:2026-07-35').conditions).toEqual([]);
    expect(parseFilterFromUrl('?c=due:before:').conditions).toEqual([]);
  });

  test('unknown fields, colon-less, and empty-text conditions are dropped', () => {
    expect(parseFilterFromUrl('?c=somefield:value').conditions).toEqual([]);
    expect(parseFilterFromUrl('?c=textX').conditions).toEqual([]);
    expect(parseFilterFromUrl('?c=text:').conditions).toEqual([]);
  });
});

describe('parseFilterFromUrl — the next view', () => {
  test('view=next round-trips through the URL like every other preset', () => {
    expect(parseFilterFromUrl('?view=next').view).toBe('next');
    expect(serializeFilterToUrl(withConds('next', []))).toBe('?view=next');
    // And composes in the URL with everything else the filter carries.
    const round = parseFilterFromUrl('?view=next&in=7&layout=board&c=status%3Adoing');
    expect(round.view).toBe('next');
    expect(round.scope).toBe(7);
    expect(round.layout).toBe('board');
    expect(round.conditions).toHaveLength(1);
  });

  test('a misspelt view still opens the app at the inbox', () => {
    expect(parseFilterFromUrl('?view=nxt').view).toBe('inbox');
  });
});

describe('parseFilterFromUrl — scope', () => {
  test('in=<id> is the container the list is standing inside', () => {
    expect(parseFilterFromUrl('?view=all&in=42').scope).toBe(42);
  });

  test('a malformed scope degrades to null rather than throwing', () => {
    // Same rule the rest of the parser follows: a hand-edited or truncated URL
    // opens the app at the top level, it does not error at someone on a phone.
    for (const search of ['?in=', '?in=abc', '?in=-1', '?in=0', '?in=1.5', '?in=1,2']) {
      expect(parseFilterFromUrl(search).scope).toBeNull();
    }
  });
});

describe('field catalogue', () => {
  test('FILTER_FIELDS lists the six fields with their labels', () => {
    expect(FILTER_FIELDS).toEqual([
      { field: 'status', label: 'Status' },
      { field: 'assignee', label: 'Assignee' },
      { field: 'due', label: 'Due date' },
      { field: 'hideUntil', label: 'Hide until' },
      { field: 'subtasks', label: 'Subtasks' },
      { field: 'text', label: 'Text' },
    ]);
  });

  test('the select-option and date-op catalogues', () => {
    expect(STATUS_OPTIONS).toEqual([
      { value: 'todo', label: 'To do' },
      { value: 'doing', label: 'Doing' },
      { value: 'blocked', label: 'Blocked' },
      { value: 'done', label: 'Done' },
    ]);
    expect(SUBTASK_OPTIONS).toEqual([
      { value: 'has', label: 'Has subtasks' },
      { value: 'none', label: 'No subtasks' },
    ]);
    expect(DATE_OPS).toEqual(['before', 'on', 'after']);
    expect(TEXT_OPS).toEqual(['contains', 'starts-with', 'exact', 'fuzzy']);
  });
});

describe('serializeFilterToUrl', () => {
  test('the default filter serialises to an empty string', () => {
    expect(serializeFilterToUrl(DEFAULT_FILTER)).toBe('');
    expect(serializeFilterToUrl(freshFilter())).toBe('');
  });

  test('emits the view and one c param per non-empty condition', () => {
    expect(
      serializeFilterToUrl(
        withConds('all', [sel('status', ['todo']), dat('due', 'after', '2026-06-01')]),
      ),
    ).toBe('?view=all&c=status%3Atodo&c=due%3Aafter%3A2026-06-01');
  });

  test('a text condition serialises with its op', () => {
    expect(serializeFilterToUrl(withConds('all', [txt('milk', 'fuzzy')]))).toBe(
      '?view=all&c=text%3Afuzzy%3Amilk',
    );
  });

  test('inert (empty) conditions are omitted', () => {
    expect(
      serializeFilterToUrl(
        withConds('inbox', [sel('status', []), txt('   '), dat('due', 'before', '')]),
      ),
    ).toBe('');
  });

  test('a scope emits in=<id>, alongside the view and the conditions', () => {
    expect(serializeFilterToUrl(inScope('all', 42))).toBe('?view=all&in=42');
    expect(serializeFilterToUrl(inScope('inbox', 7, [sel('status', ['todo'])]))).toBe(
      '?in=7&c=status%3Atodo',
    );
  });

  test('the board layout rides the URL beside the view, the scope and the conditions', () => {
    const board: TaskFilter = { view: 'all', scope: 42, layout: 'board', conditions: [] };
    expect(serializeFilterToUrl(board)).toBe('?view=all&in=42&layout=board');
    // The list is the default, so it is not spelled out — the canonical inbox
    // URL stays empty.
    expect(serializeFilterToUrl({ ...board, layout: 'list' })).toBe('?view=all&in=42');
  });

  test('layout=board parses back; anything else degrades to the list', () => {
    expect(parseFilterFromUrl('?layout=board').layout).toBe('board');
    expect(parseFilterFromUrl('?layout=kanban').layout).toBe('list');
    expect(parseFilterFromUrl('?layout=').layout).toBe('list');
    expect(parseFilterFromUrl('').layout).toBe('list');
  });

  test('serialize ∘ parse ∘ serialize is stable for any filter', () => {
    const filters: TaskFilter[] = [
      withConds('today', [sel('assignee', ['1', 'unassigned']), txt('a:b,c d')]),
      withConds('trash', [dat('hideUntil', 'on', '2026-12-25')]),
      withConds('all', [sel('subtasks', ['has'])]),
      inScope('all', 42, [txt('tiles')]),
      { view: 'all', scope: 42, layout: 'board', conditions: [sel('status', ['blocked'])] },
      DEFAULT_FILTER,
    ];
    for (const f of filters) {
      const once = serializeFilterToUrl(f);
      expect(serializeFilterToUrl(parseFilterFromUrl(once))).toBe(once);
    }
  });
});

describe('newCondition / isConditionField / hasActiveRefinements', () => {
  test('newCondition builds an empty condition for every field', () => {
    expect(newCondition('status')).toMatchObject({ kind: 'select', field: 'status', values: [] });
    expect(newCondition('assignee')).toMatchObject({ kind: 'select', field: 'assignee', values: [] });
    expect(newCondition('subtasks')).toMatchObject({ kind: 'select', field: 'subtasks', values: [] });
    expect(newCondition('due')).toMatchObject({ kind: 'date', field: 'due', op: 'before', date: '' });
    expect(newCondition('hideUntil')).toMatchObject({
      kind: 'date',
      field: 'hideUntil',
      op: 'before',
      date: '',
    });
    expect(newCondition('text')).toMatchObject({
      kind: 'text',
      field: 'text',
      op: 'contains',
      query: '',
    });
  });

  test('newCondition ids are unique and look like c<n>', () => {
    expect(newCondition('status').id).not.toBe(newCondition('status').id);
    expect(newCondition('status').id).toMatch(/^c\d+$/);
  });

  test('isConditionField accepts the six fields and rejects others', () => {
    for (const f of ['status', 'assignee', 'subtasks', 'due', 'hideUntil', 'text']) {
      expect(isConditionField(f)).toBe(true);
    }
    expect(isConditionField('view')).toBe(false);
    expect(isConditionField('')).toBe(false);
  });

  test('hasActiveRefinements is true exactly when conditions exist', () => {
    expect(hasActiveRefinements(freshFilter())).toBe(false);
    expect(hasActiveRefinements(withConds('all', []))).toBe(false);
    expect(hasActiveRefinements(withConds('all', [txt('x')]))).toBe(true);
  });
});

describe('visibleFor — view scoping', () => {
  test('inbox: roots that are unassigned and not deferred', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'plain' }),
      task({ id: 2, title: 'assigned', assignedTo: 1 }),
      task({ id: 3, title: 'deferred', deferUntil: '2099-01-01T00:00:00Z' }),
      task({ id: 4, title: 'child', parentId: 1 }),
    );
    expect(ids(visibleFor(withConds('inbox', []), tasks, noLinger, ctx))).toEqual([1]);
  });

  test('today: unfinished tasks deferred up to end of today or undeferred', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'undeferred' }),
      task({ id: 2, title: 'past defer', deferUntil: '2020-01-01T00:00:00Z' }),
      task({ id: 3, title: 'future defer', deferUntil: '2099-01-01T00:00:00Z' }),
      task({ id: 4, title: 'done', status: 'done', completedAt: '2026-05-20T09:00:00Z' }),
    );
    expect(ids(visibleFor(withConds('today', []), tasks, noLinger, ctx)).sort()).toEqual([1, 2]);
  });

  test('today keeps a started task and a blocked one — only done leaves the list', () => {
    // The two states stage 2 added are the whole point of the view: a task you
    // are stuck on is more on today's list than one you have not touched.
    const tasks = mapOf(
      task({ id: 1, title: 'not started' }),
      task({ id: 2, title: 'under way', status: 'doing' }),
      task({ id: 3, title: 'stuck', status: 'blocked' }),
      task({ id: 4, title: 'finished', status: 'done', completedAt: '2026-05-20T09:00:00Z' }),
    );
    expect(ids(visibleFor(withConds('today', []), tasks, noLinger, ctx)).sort()).toEqual([1, 2, 3]);
  });

  test('today: a task deferred to exactly end-of-day stays visible (inclusive cutoff)', () => {
    const endOfToday = (() => {
      const d = new Date(NOW);
      d.setHours(23, 59, 59, 999);
      return d.toISOString();
    })();
    const tasks = mapOf(task({ id: 1, title: 'deferred to cutoff', deferUntil: endOfToday }));
    expect(ids(visibleFor(withConds('today', []), tasks, noLinger, ctx))).toEqual([1]);
  });

  test('all: every live task; trash: every deleted task', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'live' }),
      task({ id: 2, title: 'gone', deletedAt: '2026-05-20T09:00:00Z' }),
    );
    expect(ids(visibleFor(withConds('all', []), tasks, noLinger, ctx))).toEqual([1]);
    expect(ids(visibleFor(withConds('trash', []), tasks, noLinger, ctx))).toEqual([2]);
  });

  test('a subtask lists in all and today; the inbox is unfiled capture only', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'parent' }),
      task({ id: 2, title: 'open subtask', parentId: 1 }),
      task({ id: 3, title: 'deleted subtask', parentId: 1, deletedAt: '2026-05-20T09:00:00Z' }),
    );
    const view = (v: TaskFilter['view']): number[] =>
      ids(visibleFor(withConds(v, []), tasks, noLinger, ctx));
    expect(view('all')).toEqual([1, 2]);
    expect(view('today')).toEqual([1, 2]);
    // A subtask is already filed under its parent, so it is not capture.
    expect(view('inbox')).toEqual([1]);
    expect(view('trash')).toEqual([3]);
  });

  test('a subtask lists even when its own parent fails the view', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'deferred parent', deferUntil: '2099-01-01T00:00:00Z' }),
      task({ id: 2, title: 'subtask due now', parentId: 1 }),
    );
    expect(ids(visibleFor(withConds('today', []), tasks, noLinger, ctx))).toEqual([2]);
  });
});

describe('visibleFor — the next view', () => {
  // The rule itself lives in @eal/client (task-availability.ts) and is proved
  // there, property-based. What is checked here is the wiring: that the fifth
  // view consults it, and that it composes with scope, layout and conditions
  // like every other view rather than being a second selection path.

  function seqProject(): Map<number, Task> {
    return mapOf(
      task({ id: 1, title: 'kitchen', kind: 'project', sequential: true, position: 0 }),
      task({ id: 2, title: 'step one', parentId: 1, position: 0 }),
      task({ id: 3, title: 'step two', parentId: 1, position: 1 }),
      task({ id: 4, title: 'loose', position: 1 }),
    );
  }

  test('shows the first step of a sequential project, and never the container', () => {
    expect(ids(visibleFor(withConds('next', []), seqProject(), noLinger, ctx))).toEqual([2, 4]);
  });

  test('a parallel project hands out both steps', () => {
    const tasks = seqProject();
    const project = tasks.get(1);
    if (project === undefined) throw new Error('fixture');
    tasks.set(1, { ...project, sequential: false });
    expect(ids(visibleFor(withConds('next', []), tasks, noLinger, ctx))).toEqual([2, 3, 4]);
  });

  test('completing the first step advances the view to the second', () => {
    const tasks = seqProject();
    const first = tasks.get(2);
    if (first === undefined) throw new Error('fixture');
    tasks.set(2, { ...first, status: 'done', completedAt: '2026-05-20T09:00:00Z' });
    expect(ids(visibleFor(withConds('next', []), tasks, noLinger, ctx))).toEqual([3, 4]);
  });

  test('blocked, done, deferred and trashed rows are all out', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'ready' }),
      task({ id: 2, title: 'stuck', status: 'blocked' }),
      task({ id: 3, title: 'finished', status: 'done', completedAt: '2026-05-20T09:00:00Z' }),
      task({ id: 4, title: 'later', deferUntil: '2099-01-01T00:00:00Z' }),
      task({ id: 5, title: 'binned', deletedAt: '2026-05-20T09:00:00Z' }),
    );
    expect(ids(visibleFor(withConds('next', []), tasks, noLinger, ctx))).toEqual([1]);
  });

  test('it composes with a scope', () => {
    const tasks = seqProject();
    expect(ids(visibleFor(inScope('next', 1), tasks, noLinger, ctx))).toEqual([2]);
  });

  test('it composes with a condition', () => {
    const tasks = seqProject();
    expect(
      ids(visibleFor(withConds('next', [txt('loose')]), tasks, noLinger, ctx)),
    ).toEqual([4]);
  });

  test('a just-completed step lingers beside the one it unlocked', () => {
    // The same beat the today view and the status conditions already keep: the
    // list should read as advancing, not as jumping.
    const tasks = seqProject();
    const first = tasks.get(2);
    if (first === undefined) throw new Error('fixture');
    tasks.set(2, { ...first, status: 'done', completedAt: '2026-05-20T09:00:00Z' });
    expect(
      ids(visibleFor(withConds('next', []), tasks, new Set([2]), ctx)),
    ).toEqual([2, 3, 4]);
  });

  test('rows come back in tree order, like every other view', () => {
    const tasks = seqProject();
    expect(ids(visibleFor(withConds('next', []), tasks, noLinger, ctx))).toEqual([2, 4]);
  });
});

describe('visibleFor — tree order', () => {
  test('a child follows its parent, not its own position among the roots', () => {
    // Every position here is per-parent, so a flat position sort would put the
    // child (position 0) ahead of the second root (position 1).
    const tasks = mapOf(
      task({ id: 1, title: 'first root', position: 0 }),
      task({ id: 2, title: 'second root', position: 1 }),
      task({ id: 3, title: 'child of the second', parentId: 2, position: 0 }),
    );
    expect(ids(visibleFor(withConds('all', []), tasks, noLinger, ctx))).toEqual([1, 2, 3]);
  });

  test('text search reaches a subtask', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'Plan the trip' }),
      task({ id: 2, title: 'Book flights', parentId: 1 }),
    );
    expect(ids(visibleFor(withConds('all', [txt('flights')]), tasks, noLinger, ctx))).toEqual([2]);
  });
});

describe('visibleFor — scope', () => {
  // project 1 ▸ epic 2 ▸ task 3, plus task 4 straight under the project and an
  // unrelated root 5. The shape the three fixed levels are for.
  function household(): Map<number, Task> {
    return mapOf(
      task({ id: 1, title: 'renovate', kind: 'project' }),
      task({ id: 2, title: 'kitchen', kind: 'epic', parentId: 1 }),
      task({ id: 3, title: 'buy tiles', parentId: 2 }),
      task({ id: 4, title: 'call the plumber', parentId: 1 }),
      task({ id: 5, title: 'unrelated' }),
    );
  }

  test('a scope shows the container’s whole subtree, at every depth', () => {
    expect(ids(visibleFor(inScope('all', 1), household(), noLinger, ctx))).toEqual([2, 3, 4]);
  });

  test('the container itself is not a row — the breadcrumb names it', () => {
    expect(ids(visibleFor(inScope('all', 1), household(), noLinger, ctx))).not.toContain(1);
  });

  test('an inner scope narrows further', () => {
    expect(ids(visibleFor(inScope('all', 2), household(), noLinger, ctx))).toEqual([3]);
  });

  test('a leaf scope is empty, and so is one naming a row this mirror lacks', () => {
    expect(visibleFor(inScope('all', 3), household(), noLinger, ctx)).toHaveLength(0);
    expect(visibleFor(inScope('all', 999), household(), noLinger, ctx)).toHaveLength(0);
  });

  test('scope narrows what the view already selected, it does not replace it', () => {
    const tasks = household();
    const done = tasks.get(4);
    if (done === undefined) throw new Error('fixture');
    tasks.set(4, { ...done, deletedAt: '2026-05-20T09:00:00Z' });
    // Trash, scoped: the one trashed row inside the project, not every trashed
    // row in the household.
    expect(ids(visibleFor(inScope('trash', 1), tasks, noLinger, ctx))).toEqual([4]);
    expect(ids(visibleFor(inScope('all', 1), tasks, noLinger, ctx))).toEqual([2, 3]);
  });

  test('the inbox is the one view a scope can never satisfy', () => {
    // The inbox means unfiled capture at the top level; everything in a
    // subtree is filed by definition. tasks:enter-scope moves off the inbox
    // for exactly this reason.
    expect(visibleFor(inScope('inbox', 1), household(), noLinger, ctx)).toHaveLength(0);
  });
});

describe('visibleFor — conditions', () => {
  test('status: membership of the chosen set', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'open' }),
      task({ id: 2, title: 'done', status: 'done', completedAt: '2026-05-20T09:00:00Z' }),
    );
    expect(ids(visibleFor(withConds('all', [sel('status', ['todo'])]), tasks, noLinger, ctx))).toEqual([1]);
    expect(ids(visibleFor(withConds('all', [sel('status', ['done'])]), tasks, noLinger, ctx))).toEqual([2]);
    expect(
      ids(visibleFor(withConds('all', [sel('status', ['todo', 'done'])]), tasks, noLinger, ctx)).sort(),
    ).toEqual([1, 2]);
  });

  test('an empty select condition is inert — matches everything', () => {
    const tasks = mapOf(task({ id: 1, title: 'a' }), task({ id: 2, title: 'b' }));
    expect(ids(visibleFor(withConds('all', [sel('status', [])]), tasks, noLinger, ctx)).sort()).toEqual([1, 2]);
  });

  test('assignee: by user id, and "unassigned" for a null assignee', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'alex', assignedTo: 1 }),
      task({ id: 2, title: 'elisa', assignedTo: 2 }),
      task({ id: 3, title: 'nobody' }),
    );
    expect(ids(visibleFor(withConds('all', [sel('assignee', ['1'])]), tasks, noLinger, ctx))).toEqual([1]);
    expect(ids(visibleFor(withConds('all', [sel('assignee', ['unassigned'])]), tasks, noLinger, ctx))).toEqual([3]);
    expect(
      ids(visibleFor(withConds('all', [sel('assignee', ['1', '2'])]), tasks, noLinger, ctx)).sort(),
    ).toEqual([1, 2]);
  });

  test('subtasks: has vs none, by live children', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'parent' }),
      task({ id: 2, title: 'child', parentId: 1 }),
      task({ id: 3, title: 'lonely' }),
      task({ id: 4, title: 'ex-parent' }),
      task({ id: 5, title: 'dead child', parentId: 4, deletedAt: '2026-05-20T09:00:00Z' }),
    );
    expect(ids(visibleFor(withConds('all', [sel('subtasks', ['has'])]), tasks, noLinger, ctx))).toEqual([1]);
    // 2 is a leaf and lists like any other. 4's only child is deleted, so it
    // counts as having none.
    expect(
      ids(visibleFor(withConds('all', [sel('subtasks', ['none'])]), tasks, noLinger, ctx)).sort(),
    ).toEqual([2, 3, 4]);
  });

  test('due date: before / on / after, and no-due tasks fail any due condition', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'jun', dueAt: '2026-06-15T00:00:00Z' }),
      task({ id: 2, title: 'jul', dueAt: '2026-07-20T00:00:00Z' }),
      task({ id: 3, title: 'none' }),
    );
    expect(ids(visibleFor(withConds('all', [dat('due', 'before', '2026-07-01')]), tasks, noLinger, ctx))).toEqual([1]);
    expect(ids(visibleFor(withConds('all', [dat('due', 'after', '2026-07-01')]), tasks, noLinger, ctx))).toEqual([2]);
    expect(ids(visibleFor(withConds('all', [dat('due', 'on', '2026-06-15')]), tasks, noLinger, ctx))).toEqual([1]);
  });

  test('due comparison is exclusive at the boundary for before/after', () => {
    const tasks = mapOf(task({ id: 1, title: 'exactly', dueAt: '2026-07-01T09:00:00Z' }));
    expect(ids(visibleFor(withConds('all', [dat('due', 'before', '2026-07-01')]), tasks, noLinger, ctx))).toEqual([]);
    expect(ids(visibleFor(withConds('all', [dat('due', 'after', '2026-07-01')]), tasks, noLinger, ctx))).toEqual([]);
    expect(ids(visibleFor(withConds('all', [dat('due', 'on', '2026-07-01')]), tasks, noLinger, ctx))).toEqual([1]);
  });

  test('hide-until date filters on deferUntil', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'soon', deferUntil: '2026-06-01T00:00:00Z' }),
      task({ id: 2, title: 'later', deferUntil: '2026-09-01T00:00:00Z' }),
    );
    expect(
      ids(visibleFor(withConds('all', [dat('hideUntil', 'before', '2026-07-01')]), tasks, noLinger, ctx)),
    ).toEqual([1]);
  });

  test('an empty date condition is inert', () => {
    const tasks = mapOf(task({ id: 1, title: 'no due' }));
    expect(ids(visibleFor(withConds('all', [dat('due', 'before', '')]), tasks, noLinger, ctx))).toEqual([1]);
  });

  test('text matches title and notes, case-insensitively and trimmed', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'Buy MILK' }),
      task({ id: 2, title: 'Eggs', notes: 'a dozen' }),
    );
    expect(ids(visibleFor(withConds('all', [txt('  milk ')]), tasks, noLinger, ctx))).toEqual([1]);
    expect(ids(visibleFor(withConds('all', [txt('DOZEN')]), tasks, noLinger, ctx))).toEqual([2]);
  });

  test('text op: contains / starts-with span both title and notes', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'Buy milk' }),
      task({ id: 2, title: 'Milkshake' }),
      task({ id: 3, title: 'Eggs', notes: 'milk and bread' }),
    );
    const run = (op: TextOp, q: string): number[] =>
      ids(visibleFor(withConds('all', [txt(q, op)]), tasks, noLinger, ctx)).sort();
    expect(run('contains', 'milk')).toEqual([1, 2, 3]);
    // starts-with hits #2's title and #3's notes, not #1 ('buy milk').
    expect(run('starts-with', 'milk')).toEqual([2, 3]);
  });

  test('text op: exact matches a whole title or whole notes, nothing looser', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'milk' }),
      task({ id: 2, title: 'Buy milk' }), // contains 'milk' but not exact
      task({ id: 3, title: 'x', notes: 'milk' }), // notes are exactly 'milk'
    );
    expect(
      ids(visibleFor(withConds('all', [txt('milk', 'exact')]), tasks, noLinger, ctx)).sort(),
    ).toEqual([1, 3]);
  });

  test('text op: fuzzy searches title and notes, and rejects the unrelated', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'Errand', notes: 'buy milk' }), // match via notes
      task({ id: 2, title: 'milk run' }), // match via title
      task({ id: 3, title: 'Sleep' }), // no match
    );
    expect(
      ids(visibleFor(withConds('all', [txt('milk', 'fuzzy')]), tasks, noLinger, ctx)).sort(),
    ).toEqual([1, 2]);
    expect(visibleFor(withConds('all', [txt('xyzzy', 'fuzzy')]), tasks, noLinger, ctx)).toHaveLength(0);
  });

  test('an empty text query is inert regardless of op', () => {
    // Non-empty title AND notes, so an `exact` empty-query mutant cannot match
    // by accident on a blank field.
    const tasks = mapOf(
      task({ id: 1, title: 'apples', notes: 'from the shop' }),
      task({ id: 2, title: 'bread', notes: 'wholemeal' }),
    );
    for (const op of ['contains', 'starts-with', 'exact', 'fuzzy'] as const) {
      expect(
        ids(visibleFor(withConds('all', [txt('', op)]), tasks, noLinger, ctx)).sort(),
      ).toEqual([1, 2]);
    }
  });

  test('conditions are AND-ed — every one must pass', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'milk', status: 'todo', assignedTo: 1 }),
      task({ id: 2, title: 'milk', status: 'done', assignedTo: 1, completedAt: '2026-05-20T09:00:00Z' }),
      task({ id: 3, title: 'milk', status: 'todo', assignedTo: 2 }),
    );
    const filter = withConds('all', [
      txt('milk'),
      sel('status', ['todo']),
      sel('assignee', ['1']),
    ]);
    expect(ids(visibleFor(filter, tasks, noLinger, ctx))).toEqual([1]);
  });
});

describe('visibleFor — linger', () => {
  test('a recently-completed task stays visible under a status=todo condition', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'just done', status: 'done', completedAt: '2026-05-20T11:00:00Z' }),
      task({ id: 2, title: 'still open' }),
    );
    const filter = withConds('all', [sel('status', ['todo'])]);
    expect(ids(visibleFor(filter, tasks, new Set(), ctx))).toEqual([2]);
    expect(ids(visibleFor(filter, tasks, new Set([1]), ctx)).sort()).toEqual([1, 2]);
  });

  test('linger does NOT excuse a task that fails an assignee or text condition', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'done + hers', status: 'done', completedAt: '2026-05-20T11:00:00Z', assignedTo: 2 }),
    );
    expect(
      visibleFor(withConds('all', [sel('status', ['todo']), sel('assignee', ['1'])]), tasks, new Set([1]), ctx),
    ).toHaveLength(0);
    expect(
      visibleFor(withConds('all', [sel('status', ['todo']), txt('nope')]), tasks, new Set([1]), ctx),
    ).toHaveLength(0);
  });
});

describe('visibleFor — ordering', () => {
  test('rows are ordered by position, ascending', () => {
    const tasks = mapOf(
      task({ id: 1, title: 'third', position: 2 }),
      task({ id: 2, title: 'first', position: 0 }),
      task({ id: 3, title: 'second', position: 1 }),
    );
    expect(ids(visibleFor(withConds('all', []), tasks, noLinger, ctx))).toEqual([2, 3, 1]);
  });

  test('rows at the same position fall back to id order, ascending', () => {
    const tasks = mapOf(
      task({ id: 3, title: 'c', position: 0 }),
      task({ id: 1, title: 'a', position: 0 }),
      task({ id: 2, title: 'b', position: 0 }),
    );
    expect(ids(visibleFor(withConds('all', []), tasks, noLinger, ctx))).toEqual([1, 2, 3]);
  });
});
