import type { Task } from './task-types.ts';

/**
 * "What should I do next" — the one derived query stage 3 adds, and the only
 * place the `sequential` flag means anything.
 *
 * It lives in `@eal/client`, not in the SPA and not in the api, because two
 * surfaces have to answer the same question with the same answer: the browser's
 * Available view (packages/web/src/apps/tasks/filter.ts) and the assistant's
 * `next_actions` tool (packages/cli/src/apps/tasks.ts). A second copy is how
 * the two would come to disagree, and nothing would say which was right. The
 * api needs no copy at all: this is a read over the whole tree, not a row
 * predicate, so there is no route and no SQL — both callers already hold every
 * live row.
 *
 * ── The definition ─────────────────────────────────────────────────────────
 *
 * A task is **outstanding** when it is live (not in the trash) and either its
 * own status is not `done`, or some descendant of it is outstanding. In other
 * words: this branch still carries work. It is stated over the subtree rather
 * than over the row because a finished container can still hold unfinished
 * children — `complete` does not cascade — and calling such a container
 * "finished work" would hide everything under it.
 *
 * A task is **available** when all of these hold:
 *
 *   1. it is live — `deletedAt === null`;
 *   2. its status is `todo` or `doing` — not `blocked`, not `done`. Blocked is
 *      waiting on a person, which is the opposite of available;
 *   3. it is not deferred into the future — `deferUntil` is null or at/before
 *      the end of today, the same cutoff the Today view uses;
 *   4. no child of it is outstanding — a container is not itself an action
 *      while there is still work filed inside it;
 *   5. **every ancestor admits it.** For each ancestor that is `sequential`,
 *      this task's branch must descend from that ancestor's *first outstanding
 *      child*, first meaning the sibling order `(position, id)` below. A
 *      parallel ancestor admits every child.
 *
 * Rule 5 composes down the whole chain, which is the part that is easy to get
 * wrong. Checking only the immediate parent gives a different — and wrong —
 * answer whenever a sequential container sits above a parallel one: a
 * sequential project holding two parallel epics would hand out the work in
 * *both* epics, when the point of marking it sequential was to see only the
 * first. `task-availability.property.test.ts` generates that shape and fails
 * against the immediate-parent reading.
 *
 * ── Rows the mirror should not be trusted about ─────────────────────────────
 *
 * The SPA's task map is patched by broadcasts that arrive in any order, so it
 * can briefly hold shapes the server rejects: a `parentId` naming a row that
 * has not arrived, or a cycle. Both are handled explicitly rather than left to
 * a walk that would not terminate — see `availableTaskIds`.
 */

/**
 * Sibling order: the per-parent `position`, then `id` as the tiebreak.
 *
 * `position` is numbered per parent (`nextSiblingPosition` in the api's tasks
 * repo), so it orders siblings and nothing else. This is the definition the
 * SPA's tree reads use too — `packages/web/src/apps/tasks/tree.ts` imports it
 * from here rather than keeping a second copy, because "the first step" and
 * "the first row" have to be the same step.
 */
export function compareSiblingOrder(a: Task, b: Task): number {
  if (a.position !== b.position) return a.position - b.position;
  return a.id - b.id;
}

/**
 * End of `now`'s local day, as an ISO 8601 timestamp — the cutoff a defer date
 * is compared against. Local, not UTC: "hidden until tomorrow" means the
 * person's tomorrow, and a phone in Rome asking a UTC server would show a
 * deferred task an hour early in summer.
 *
 * A date-only `deferUntil` ("2026-09-06") compares correctly against this as a
 * string, because ISO 8601 sorts lexicographically and a bare date sorts before
 * any timestamp on the same day.
 */
export function endOfDayIso(now: Date): string {
  const eod = new Date(now);
  eod.setHours(23, 59, 59, 999);
  return eod.toISOString();
}

/** Children of each parent id, in sibling order, plus the rows with no parent. */
interface Forest {
  childrenOf: ReadonlyMap<number, readonly Task[]>;
  roots: readonly Task[];
}

/**
 * Index the rows into a forest.
 *
 * A row whose `parentId` names nothing in the set is treated as a root. That is
 * not a fallback for a missing value — the value is present and the row it
 * names is not — and the alternative is worse: dropping the row would make a
 * task invisible in Next because of a broadcast that had not landed yet.
 * Treated as a root it is judged on its own predicates, with no ancestor to
 * admit or refuse it, which is exactly what is known about it.
 */
function indexForest(tasks: Iterable<Task>): Forest {
  const byId = new Map<number, Task>();
  for (const task of tasks) byId.set(task.id, task);

  const childrenOf = new Map<number, Task[]>();
  const roots: Task[] = [];
  for (const task of byId.values()) {
    const parentId = task.parentId;
    if (parentId === null || !byId.has(parentId)) {
      roots.push(task);
      continue;
    }
    const siblings = childrenOf.get(parentId);
    if (siblings === undefined) childrenOf.set(parentId, [task]);
    else siblings.push(task);
  }
  // Children are sorted because the order decides which one a sequential
  // parent lets through. Roots are not: the result is a set of ids, so the
  // order the forest is walked in is not observable, and sorting them would be
  // a line no test could ever fail on.
  for (const siblings of childrenOf.values()) siblings.sort(compareSiblingOrder);
  return { childrenOf, roots };
}

/**
 * Does this branch still carry work?
 *
 * `seen` is the cycle guard the mirror needs, and it is the same one
 * `progressOf` in the SPA's tree.ts carries, for the same reason: the server
 * rejects a re-parent that would make a cycle, but this map is patched by
 * broadcasts in any order and can hold one until the next arrives. Without the
 * guard the walk would not terminate.
 *
 * No memoisation. Household trees are tens of rows and this runs once per
 * render; a memo across a possible cycle would have to reason about which
 * cached answers were computed inside one, which is more risk than the loop
 * costs.
 */
function isOutstanding(
  task: Task,
  childrenOf: ReadonlyMap<number, readonly Task[]>,
  seen: Set<number>,
): boolean {
  // A trashed branch is not outstanding work. Trash is its own view over the
  // same tree, and a task waiting to be emptied is not something to go and do.
  if (task.deletedAt !== null) return false;
  if (task.status !== 'done') return true;
  const children = childrenOf.get(task.id);
  if (children === undefined) return false;
  for (const child of children) {
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    if (isOutstanding(child, childrenOf, seen)) return true;
  }
  return false;
}

/** Rule 1–3: is this row itself something a person could pick up right now? */
function isActionableRow(task: Task, todayCutoff: string): boolean {
  if (task.deletedAt !== null) return false;
  if (task.status !== 'todo' && task.status !== 'doing') return false;
  return task.deferUntil === null || task.deferUntil <= todayCutoff;
}

/**
 * The ids a person could act on right now, given the whole live task set.
 *
 * `tasks` may be any iterable of rows — the SPA passes its map's values, the
 * CLI passes the array `listTasks` returned. Rows the walk cannot reach from a
 * root (members of a cycle, and anything filed beneath one) are absent from the
 * result: no well-founded ancestor chain exists for them, so no honest answer
 * to "does every ancestor admit it" does either. They still list in All, which
 * is where a person would notice and fix the loop.
 */
export function availableTaskIds(tasks: Iterable<Task>, ctx: { now: Date }): Set<number> {
  const todayCutoff = endOfDayIso(ctx.now);
  const { childrenOf, roots } = indexForest(tasks);
  const available = new Set<number>();
  const visited = new Set<number>();

  const visit = (task: Task, admitted: boolean): void => {
    visited.add(task.id);
    const children = childrenOf.get(task.id) ?? [];

    // One pass over the children gives both halves of the rule: whether this
    // row still holds work (so it is not itself an action), and which child is
    // the gate a sequential parent opens.
    let gateId: number | null = null;
    for (const child of children) {
      if (isOutstanding(child, childrenOf, new Set<number>([child.id]))) {
        gateId = child.id;
        break;
      }
    }
    const holdsWork = gateId !== null;

    if (admitted && !holdsWork && isActionableRow(task, todayCutoff)) {
      available.add(task.id);
    }

    for (const child of children) {
      // Cycle guard: a child already visited on this walk closes a loop, and
      // descending again would not terminate.
      if (visited.has(child.id)) continue;
      // A parallel parent admits every child; a sequential one admits only the
      // branch its first outstanding child leads. A sequential parent with no
      // outstanding child (gateId === null) admits none — there is no first
      // step to be, and the parent itself is the remaining action.
      visit(child, admitted && (!task.sequential || child.id === gateId));
    }
  };

  for (const root of roots) visit(root, true);
  return available;
}
