import type { Task } from '@eal/client';

/**
 * Tree reads over the SPA's local task mirror.
 *
 * Every view except the inbox lists tasks at any depth (see filter.ts), so a
 * row has to name the task it sits under and report progress across its whole
 * subtree. Both reads walk one parent → children index, built once per render,
 * instead of each row rescanning the map.
 */

/**
 * Children of each parent id, in list order. Deleted rows are kept — Trash
 * orders by the same tree — so every reader states its own rule about them.
 */
export type ChildIndex = ReadonlyMap<number, readonly Task[]>;

export interface Progress {
  done: number;
  total: number;
}

/** Sibling order: the per-parent `position`, then id as the tiebreak. */
function byPositionId(a: Task, b: Task): number {
  if (a.position !== b.position) return a.position - b.position;
  return a.id - b.id;
}

export function indexChildren(tasks: ReadonlyMap<number, Task>): ChildIndex {
  const index = new Map<number, Task[]>();
  for (const task of tasks.values()) {
    const parentId = task.parentId;
    if (parentId === null) continue;
    const siblings = index.get(parentId);
    if (siblings === undefined) index.set(parentId, [task]);
    else siblings.push(task);
  }
  for (const siblings of index.values()) siblings.sort(byPositionId);
  return index;
}

function accumulate(index: ChildIndex, id: number, seen: Set<number>, acc: Progress): void {
  const children = index.get(id);
  if (children === undefined) return;
  for (const child of children) {
    if (child.deletedAt !== null) continue;
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    acc.total += 1;
    if (child.status === 'done') acc.done += 1;
    accumulate(index, child.id, seen, acc);
  }
}

/**
 * How much of a task's subtree is finished — every live descendant, not only
 * the direct children. `total` is 0 for a leaf, which is how a caller decides
 * whether to render the badge at all. A trashed subtask counts for nothing and
 * its own children are not walked; it is reachable through Trash instead.
 *
 * The `seen` set is not decoration. The server rejects a re-parent that would
 * make a cycle (`wouldCycle` in the tasks repo), but this mirror is patched by
 * broadcasts that can arrive in any order, so a cycle is representable here
 * until the next broadcast lands. A plain walk would not terminate.
 */
export function progressOf(index: ChildIndex, id: number): Progress {
  const acc: Progress = { done: 0, total: 0 };
  accumulate(index, id, new Set<number>([id]), acc);
  return acc;
}

/**
 * Every id beneath `id`, at any depth — the set a scoped list draws from.
 *
 * The container itself is not a member — the breadcrumb already names it, so
 * listing it as the first row would be a second copy of the thing the reader
 * is standing inside. The one exception is a container caught in a cycle,
 * which is its own descendant; the guard below stops the walk rather than
 * pretending the mirror is a tree.
 *
 * Deleted rows *are* members, unlike `progressOf`, because Trash is a view
 * over this same tree: a trashed subtask has to stay reachable while its
 * project is the scope, or scoping in would be a way to lose it.
 *
 * The `seen` guard is `progressOf`'s, for `progressOf`'s reason — a mirror
 * patched by out-of-order broadcasts can hold a cycle the server rejected, and
 * an unguarded walk would not terminate.
 */
export function descendantIds(index: ChildIndex, id: number): Set<number> {
  const seen = new Set<number>();
  const walk = (parentId: number): void => {
    const children = index.get(parentId);
    if (children === undefined) return;
    for (const child of children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      walk(child.id);
    }
  };
  walk(id);
  return seen;
}

/**
 * The containers `id` sits inside, outermost first — what the breadcrumb walks
 * back along. `id`'s own row is not included; nor is a parent the mirror has
 * not seen yet, which ends the chain early rather than inventing a crumb.
 *
 * Cycle guard again, and note it also covers the self-parent case a single
 * broadcast could carry.
 */
export function ancestorsOf(tasks: ReadonlyMap<number, Task>, id: number): Task[] {
  const chain: Task[] = [];
  const seen = new Set<number>([id]);
  let current = tasks.get(id);
  while (current !== undefined && current.parentId !== null && !seen.has(current.parentId)) {
    seen.add(current.parentId);
    const parent = tasks.get(current.parentId);
    if (parent === undefined) break;
    chain.push(parent);
    current = parent;
  }
  return chain.reverse();
}

/**
 * No cycle guard here, unlike `progressOf`. A task has one parent, so a cycle
 * in the mirror is a closed loop that no root points into: the walk below
 * starts at the roots and cannot enter one. Members of a cycle are picked up
 * by the stranded pass instead.
 */
function visit(index: ChildIndex, task: Task, out: Task[], placed: Set<number>): void {
  out.push(task);
  placed.add(task.id);
  const children = index.get(task.id);
  if (children === undefined) return;
  for (const child of children) visit(index, child, out, placed);
}

/**
 * Every task in tree order: a root, then its subtree, then the next root.
 *
 * This is what keeps a task next to the one it belongs to now that views mix
 * depths. Sorting the flat set by `position` would not: positions are numbered
 * per parent (`nextSiblingPosition` in the tasks repo), so they collide across
 * the set and a child sorts among unrelated roots.
 *
 * A task the walk never reaches — its `parentId` names a row absent from this
 * mirror, or it sits in a cycle — is appended afterwards in sibling order, so
 * it still lists rather than disappearing.
 */
export function tasksInTreeOrder(tasks: ReadonlyMap<number, Task>): Task[] {
  const index = indexChildren(tasks);
  const roots: Task[] = [];
  for (const task of tasks.values()) {
    if (task.parentId === null) roots.push(task);
  }
  roots.sort(byPositionId);

  const out: Task[] = [];
  const placed = new Set<number>();
  for (const root of roots) visit(index, root, out, placed);

  const stranded: Task[] = [];
  for (const task of tasks.values()) {
    if (!placed.has(task.id)) stranded.push(task);
  }
  stranded.sort(byPositionId);
  for (const task of stranded) out.push(task);
  return out;
}
