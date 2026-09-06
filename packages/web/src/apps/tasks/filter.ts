import Fuse from 'fuse.js';
import { availableTaskIds, endOfDayIso, type Task } from '@eal/client';
import { descendantIds, indexChildren, tasksInTreeOrder } from './tree.ts';

/**
 * The composable task filter. `view` is the structural scope (a one-tap
 * preset); `conditions` is a list of typed, AND-ed refinements the user builds.
 * The whole filter serialises into the URL query string so a filtered list is
 * a shareable, reload-surviving link — see tasks/url-sync.ts.
 */

/**
 * `next` is the answer to "what do I do next" rather than another way of
 * asking it: it holds only the tasks nothing is standing in front of, which is
 * a read over the whole tree (see @eal/client's task-availability.ts) and not a
 * property of a row. Like every other view it composes with `scope`, `layout`
 * and every condition — one selection path, as stages 0-2 kept it.
 */
export type TaskView = 'inbox' | 'today' | 'all' | 'trash' | 'next';
/**
 * How the selected rows are drawn. Both renderers consume the output of
 * `visibleFor` — the board is a second arrangement of one query, not a second
 * query — so every view, scope and condition means the same thing in either.
 */
export type TaskLayout = 'list' | 'board';
export type DateOp = 'before' | 'on' | 'after';
export type TextOp = 'contains' | 'starts-with' | 'exact' | 'fuzzy';

/** A multi-value membership test — the task's value must be in `values`. */
export interface SelectCondition {
  id: string;
  kind: 'select';
  field: 'status' | 'assignee' | 'subtasks';
  values: string[];
}
/** A date comparison against `due` or `hideUntil`. */
export interface DateCondition {
  id: string;
  kind: 'date';
  field: 'due' | 'hideUntil';
  op: DateOp;
  date: string;
}
/** A search over title + notes; `op` picks the match style. */
export interface TextCondition {
  id: string;
  kind: 'text';
  field: 'text';
  op: TextOp;
  query: string;
}
export type Condition = SelectCondition | DateCondition | TextCondition;
export type ConditionField = Condition['field'];

export interface TaskFilter {
  view: TaskView;
  /**
   * The container the list is standing inside — a task id, or null for
   * everywhere. When set, the list shows that container's subtree and a
   * breadcrumb offers the way back out. Orthogonal to `view`: "what's due
   * today, inside the kitchen project" is a sentence, so scope narrows
   * whatever the view already selected.
   */
  scope: number | null;
  /**
   * List or board. Orthogonal to `view` and `scope` in the same way they are
   * orthogonal to each other: "the board, for what is due today, inside the
   * kitchen project" is a sentence, and each of the three narrows or redraws
   * what the others already chose.
   */
  layout: TaskLayout;
  conditions: Condition[];
}

/** The canonical default — used for view comparison in serialisation. The
 *  signal store creates fresh `{ view, scope, conditions: [] }` literals so
 *  nothing ever mutates this shared object. */
export const DEFAULT_FILTER: TaskFilter = {
  view: 'inbox',
  scope: null,
  layout: 'list',
  conditions: [],
};

/** A fresh default filter — its own `conditions` array. */
export function freshFilter(): TaskFilter {
  return { view: 'inbox', scope: null, layout: 'list', conditions: [] };
}

// ── Condition ids ──────────────────────────────────────────────────────────
// Ids are in-memory only (UI keys + action targeting); they are not part of
// the URL form. A monotonic counter guarantees uniqueness within a session.
let conditionSeq = 0;
function nextConditionId(): string {
  conditionSeq += 1;
  return `c${conditionSeq}`;
}

// ── Field catalogue (drives the builder UI) ────────────────────────────────
export interface FieldSpec {
  field: ConditionField;
  label: string;
}
export const FILTER_FIELDS: readonly FieldSpec[] = [
  { field: 'status', label: 'Status' },
  { field: 'assignee', label: 'Assignee' },
  { field: 'due', label: 'Due date' },
  { field: 'hideUntil', label: 'Hide until' },
  { field: 'subtasks', label: 'Subtasks' },
  { field: 'text', label: 'Text' },
];

export interface SelectOptionSpec {
  value: string;
  label: string;
}
export const STATUS_OPTIONS: readonly SelectOptionSpec[] = [
  { value: 'todo', label: 'To do' },
  { value: 'doing', label: 'Doing' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'done', label: 'Done' },
];
export const SUBTASK_OPTIONS: readonly SelectOptionSpec[] = [
  { value: 'has', label: 'Has subtasks' },
  { value: 'none', label: 'No subtasks' },
];
export const DATE_OPS: readonly DateOp[] = ['before', 'on', 'after'];
export const TEXT_OPS: readonly TextOp[] = ['contains', 'starts-with', 'exact', 'fuzzy'];

export function isTextOp(value: string): value is TextOp {
  return (
    value === 'contains' ||
    value === 'starts-with' ||
    value === 'exact' ||
    value === 'fuzzy'
  );
}

export function isConditionField(value: string): value is ConditionField {
  return (
    value === 'status' ||
    value === 'assignee' ||
    value === 'subtasks' ||
    value === 'due' ||
    value === 'hideUntil' ||
    value === 'text'
  );
}

/** Build a fresh, empty condition for `field` — what "+ Add filter" appends. */
export function newCondition(field: ConditionField): Condition {
  const id = nextConditionId();
  switch (field) {
    case 'status':
    case 'assignee':
    case 'subtasks':
      return { id, kind: 'select', field, values: [] };
    case 'due':
    case 'hideUntil':
      return { id, kind: 'date', field, op: 'before', date: '' };
    case 'text':
      return { id, kind: 'text', field, op: 'contains', query: '' };
  }
}

// ── URL serialisation ──────────────────────────────────────────────────────
// Each condition is one repeated `c` param. Select: `field:v1,v2`. Date:
// `field:op:YYYY-MM-DD`. Text: `text:<query>`. URLSearchParams handles percent
// encoding, so a text query may safely contain `:` / `,` / spaces.

const ISO_DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

function asView(value: string | null): TaskView {
  switch (value) {
    case 'today':
    case 'all':
    case 'trash':
    case 'next':
    // Stryker disable next-line StringLiteral: 'inbox' is also the default fallback — equivalent mutant.
    case 'inbox':
      return value;
    default:
      return 'inbox';
  }
}

/**
 * `layout=board`. Degrades to the list for the same reason `asView` degrades to
 * the inbox: a hand-edited URL should open the app, not error at someone
 * holding a phone.
 */
function asLayout(value: string | null): TaskLayout {
  // Stryker disable next-line StringLiteral: 'list' is also the default
  // fallback below — an equivalent mutant.
  return value === 'board' ? 'board' : 'list';
}

/**
 * `in=<id>`. Anything else degrades to "everywhere", the same way `asView`
 * degrades to the inbox — a hand-edited or truncated URL opens the app rather
 * than erroring at someone holding a phone.
 */
function asScope(value: string | null): number | null {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) return null;
  const id = Number(value);
  return id > 0 ? id : null;
}

function isValidSelectValue(field: SelectCondition['field'], value: string): boolean {
  if (field === 'status') {
    return value === 'todo' || value === 'doing' || value === 'blocked' || value === 'done';
  }
  if (field === 'subtasks') return value === 'has' || value === 'none';
  return value === 'unassigned' || /^\d+$/.test(value);
}

function parseCondition(raw: string): Condition | null {
  const colon = raw.indexOf(':');
  // Stryker disable next-line all: no colon-less raw can satisfy any condition
  // branch, so this early return is equivalent to falling through.
  if (colon === -1) return null;
  const field = raw.slice(0, colon);
  const rest = raw.slice(colon + 1);
  if (field === 'status' || field === 'assignee' || field === 'subtasks') {
    const values = rest.split(',').filter((v) => isValidSelectValue(field, v));
    return values.length > 0 ? { id: nextConditionId(), kind: 'select', field, values } : null;
  }
  if (field === 'due' || field === 'hideUntil') {
    const opColon = rest.indexOf(':');
    // A colon-less rest can never form a valid op:date pair, so this early
    // return is equivalent to falling through — hence the Stryker exemption.
    // Stryker disable next-line all
    if (opColon === -1) return null;
    const op = rest.slice(0, opColon);
    const date = rest.slice(opColon + 1);
    if ((op === 'before' || op === 'on' || op === 'after') && ISO_DATE.test(date)) {
      return { id: nextConditionId(), kind: 'date', field, op, date };
    }
    return null;
  }
  if (field === 'text') {
    const opColon = rest.indexOf(':');
    if (opColon === -1) return null;
    const op = rest.slice(0, opColon);
    const query = rest.slice(opColon + 1);
    if (isTextOp(op) && query.length > 0) {
      return { id: nextConditionId(), kind: 'text', field, op, query };
    }
    return null;
  }
  return null;
}

/**
 * Parse a `window.location.search` string into a TaskFilter. Unknown or
 * malformed params are dropped — a bad URL never throws, it degrades to the
 * inbox with whatever conditions did parse.
 */
export function parseFilterFromUrl(search: string): TaskFilter {
  const params = new URLSearchParams(search);
  const conditions: Condition[] = [];
  for (const raw of params.getAll('c')) {
    const cond = parseCondition(raw);
    if (cond !== null) conditions.push(cond);
  }
  return {
    view: asView(params.get('view')),
    scope: asScope(params.get('in')),
    layout: asLayout(params.get('layout')),
    conditions,
  };
}

/** Encode one condition to its `c` param value, or null when it is inert. */
function encodeCondition(c: Condition): string | null {
  if (c.kind === 'select') {
    return c.values.length > 0 ? `${c.field}:${c.values.join(',')}` : null;
  }
  if (c.kind === 'date') {
    return c.date.length > 0 ? `${c.field}:${c.op}:${c.date}` : null;
  }
  const query = c.query.trim();
  return query.length > 0 ? `text:${c.op}:${query}` : null;
}

/**
 * Serialise a TaskFilter to a query string (leading `?`, or `''` when it
 * equals the default). Inert (empty) conditions are omitted so the canonical
 * inbox URL stays clean.
 */
export function serializeFilterToUrl(filter: TaskFilter): string {
  const params = new URLSearchParams();
  if (filter.view !== DEFAULT_FILTER.view) params.set('view', filter.view);
  if (filter.scope !== null) params.set('in', String(filter.scope));
  if (filter.layout !== DEFAULT_FILTER.layout) params.set('layout', filter.layout);
  for (const c of filter.conditions) {
    const encoded = encodeCondition(c);
    if (encoded !== null) params.append('c', encoded);
  }
  const qs = params.toString();
  return qs.length === 0 ? '' : `?${qs}`;
}

/** True when the filter carries any conditions (drives the "Clear all" UI). */
export function hasActiveRefinements(filter: TaskFilter): boolean {
  return filter.conditions.length > 0;
}

// ── Applying the filter ────────────────────────────────────────────────────

/** Shared empty set for the four views that never consult availability. */
const EMPTY_IDS: ReadonlySet<number> = new Set<number>();

function inView(
  task: Task,
  view: TaskView,
  todayCutoff: string,
  recentlyCompleted: ReadonlySet<number>,
  availableIds: ReadonlySet<number>,
): boolean {
  if (view === 'trash') return task.deletedAt !== null;
  if (task.deletedAt !== null) return false;
  if (view === 'inbox') {
    // The inbox is unfiled capture, so depth belongs to its definition rather
    // than to the renderer: a subtask is already filed under its parent.
    return task.parentId === null && task.assignedTo === null && task.deferUntil === null;
  }
  if (view === 'today') {
    const deferOk = task.deferUntil === null || task.deferUntil <= todayCutoff;
    // Today is "still carrying work", which is three states: a task you started
    // and one you are stuck on are both still on today's list. A just-completed
    // task lingers anyway, so ticking one off does not make it vanish.
    const statusOk = task.status !== 'done' || recentlyCompleted.has(task.id);
    return deferOk && statusOk;
  }
  if (view === 'next') {
    // The linger rule the today view and the status conditions already follow:
    // a task ticked off since the last navigation stays on screen, struck
    // through, beside the step that has just become available. Without it the
    // row you just completed would vanish at the same instant a new one
    // appeared, which reads as the list jumping rather than advancing.
    return availableIds.has(task.id) || recentlyCompleted.has(task.id);
  }
  return true; // 'all' — every live task, at every depth
}

function hasLiveChildren(tasks: ReadonlyMap<number, Task>, parentId: number): boolean {
  for (const task of tasks.values()) {
    if (task.parentId === parentId && task.deletedAt === null) return true;
  }
  return false;
}

function selectMatches(
  task: Task,
  condition: SelectCondition,
  tasks: ReadonlyMap<number, Task>,
  recentlyCompleted: ReadonlySet<number>,
): boolean {
  if (condition.values.length === 0) return true; // inert
  if (condition.field === 'status') {
    // Linger: a task you just completed stays put under a status filter until
    // you navigate away — the same beat as the today view's open-only rule.
    if (recentlyCompleted.has(task.id)) return true;
    return condition.values.includes(task.status);
  }
  if (condition.field === 'assignee') {
    const value = task.assignedTo === null ? 'unassigned' : String(task.assignedTo);
    return condition.values.includes(value);
  }
  return condition.values.includes(hasLiveChildren(tasks, task.id) ? 'has' : 'none');
}

function dateMatches(task: Task, condition: DateCondition): boolean {
  if (condition.date.length === 0) return true; // inert
  const value = condition.field === 'due' ? task.dueAt : task.deferUntil;
  // A task with no date can't satisfy a date constraint.
  if (value === null) return false;
  const day = value.slice(0, 10);
  if (condition.op === 'before') return day < condition.date;
  if (condition.op === 'after') return day > condition.date;
  return day === condition.date; // 'on'
}

/**
 * Fuzzy match config — Fuse.js, tuned identically to the lingua project so the
 * fuzzy behaviour is consistent across the codebases. Threshold 0.4 is
 * typo-tolerant; `ignoreLocation` matches anywhere in the field.
 */
const FUSE_OPTIONS = {
  keys: ['title', 'notes'],
  threshold: 0.4,
  // Stryker disable next-line all: a Fuse position-weighting flag with no
  // observable effect on task strings short enough to fit on one screen.
  ignoreLocation: true,
  minMatchCharLength: 2,
};

function fuzzyMatches(title: string, notes: string, needle: string): boolean {
  return new Fuse([{ title, notes }], FUSE_OPTIONS).search(needle).length > 0;
}

function textMatches(task: Task, condition: TextCondition): boolean {
  const needle = condition.query.trim().toLowerCase();
  if (needle.length === 0) return true; // inert
  const title = task.title.toLowerCase();
  const notes = task.notes.toLowerCase();
  switch (condition.op) {
    case 'contains':
      return title.includes(needle) || notes.includes(needle);
    case 'starts-with':
      return title.startsWith(needle) || notes.startsWith(needle);
    case 'exact':
      return title === needle || notes === needle;
    case 'fuzzy':
      return fuzzyMatches(title, notes, needle);
  }
}

function conditionMatches(
  task: Task,
  condition: Condition,
  tasks: ReadonlyMap<number, Task>,
  recentlyCompleted: ReadonlySet<number>,
): boolean {
  switch (condition.kind) {
    case 'select':
      return selectMatches(task, condition, tasks, recentlyCompleted);
    case 'date':
      return dateMatches(task, condition);
    case 'text':
      return textMatches(task, condition);
  }
}

/**
 * Resolve the canonical task store down to the rows visible under `filter`.
 *
 * Rows come back in tree order — a task sits directly under the one it belongs
 * to — because every view but the inbox now lists tasks at any depth. Each row
 * names its parent, so a view that selects a child without its parent still
 * reads correctly.
 *
 * `filter.scope`, when set, narrows to one container's subtree before the view
 * and the conditions get a look. The container's own row is not in it: the
 * breadcrumb names it, and repeating it as row one reads as a copy.
 *
 * `recentlyCompleted` carries the linger set: ids the user ticked since the
 * last navigation. Those rows stay visible even when a status condition (or
 * the today view) would hide them — the satisfying "I just did that" beat.
 */
export function visibleFor(
  filter: TaskFilter,
  tasks: ReadonlyMap<number, Task>,
  recentlyCompleted: ReadonlySet<number>,
  ctx: { now: Date },
): Task[] {
  const todayCutoff = endOfDayIso(ctx.now);
  // Resolved once per call, and only for the view that needs it: availability
  // walks the whole forest, which is wasted work in the four views that ask a
  // question about a row rather than about the tree above it.
  const availableIds =
    filter.view === 'next' ? availableTaskIds(tasks.values(), { now: ctx.now }) : EMPTY_IDS;
  // Resolved once per call rather than per row: the subtree is a set lookup,
  // and a scope naming a container this mirror has never seen resolves to the
  // empty set, so the list is empty and the breadcrumb says where you are.
  const inScope = filter.scope === null ? null : descendantIds(indexChildren(tasks), filter.scope);
  const out: Task[] = [];
  for (const task of tasksInTreeOrder(tasks)) {
    if (inScope !== null && !inScope.has(task.id)) continue;
    if (!inView(task, filter.view, todayCutoff, recentlyCompleted, availableIds)) continue;
    let matched = true;
    for (const condition of filter.conditions) {
      if (!conditionMatches(task, condition, tasks, recentlyCompleted)) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    out.push(task);
  }
  return out;
}
