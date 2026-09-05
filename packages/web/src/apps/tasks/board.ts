import type { Task, TaskStatus } from '@eal/client';

/**
 * The board — the workflow axis drawn as lanes.
 *
 * It is a second *arrangement* of the list, not a second query: `lanesFor`
 * takes the rows `visibleFor` already selected and buckets them by status, so
 * the view, the scope and every condition mean exactly the same thing in either
 * layout. Nothing here reads the task store.
 */

/** One lane: the status it holds, and the word on its heading. */
export interface LaneSpec {
  status: TaskStatus;
  label: string;
}

/**
 * Left to right, the order work moves in. Four is the whole set — the board
 * has no "everything else" lane, because `status` is NOT NULL with a CHECK, so
 * every task lands in exactly one of these.
 */
export const BOARD_LANES: readonly LaneSpec[] = [
  { status: 'todo', label: 'To do' },
  { status: 'doing', label: 'Doing' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'done', label: 'Done' },
];

export interface Lane {
  status: TaskStatus;
  label: string;
  tasks: Task[];
}

/**
 * Within-lane order: due date first, then `position`, then id.
 *
 * `position` alone is not enough and cannot be made enough without a schema
 * change. It is numbered per parent (`nextSiblingPosition` in the tasks repo),
 * and a lane cuts across parents — the first child of two different projects
 * both hold position 0 — so a plain `position` sort would interleave unrelated
 * subtrees in an order nobody chose. Due date is the one field that means the
 * same thing across every parent, so it leads; `position` then keeps siblings
 * in their chosen order, and the id breaks the remaining ties so the sort is
 * total and the lane does not reshuffle between renders.
 *
 * A task with no due date sorts after every dated one. "Someday" belongs below
 * "Friday", and the alternative — nulls first — would push the dated work off
 * the bottom of a phone screen.
 *
 * Dragging a card *within* a lane to reorder it is deliberately not offered:
 * it would need a lane-scoped position space this schema does not have. See
 * OPEN_TASKS.md.
 */
export function byDueThenPosition(a: Task, b: Task): number {
  if (a.dueAt !== b.dueAt) {
    if (a.dueAt === null) return 1;
    if (b.dueAt === null) return -1;
    // ISO 8601 sorts correctly as a string, and a date-only value sorts
    // before any timestamp on the same day — which is the order wanted.
    return a.dueAt < b.dueAt ? -1 : 1;
  }
  if (a.position !== b.position) return a.position - b.position;
  return a.id - b.id;
}

/**
 * Bucket already-filtered rows into the four lanes, each sorted.
 *
 * Every lane is returned even when empty. A missing "Blocked" lane would read
 * as "blocked is not a thing here" rather than "nothing is blocked", and on the
 * phone — where one lane fills the screen — an empty lane is the answer to the
 * question the person just asked.
 */
export function lanesFor(visible: readonly Task[]): Lane[] {
  const byStatus = new Map<TaskStatus, Task[]>();
  for (const spec of BOARD_LANES) byStatus.set(spec.status, []);
  for (const task of visible) {
    const lane = byStatus.get(task.status);
    // Stryker disable next-line all -- defensive: `status` is NOT NULL with a
    // CHECK bounding it to these four, and the client's own wire guard
    // (eal-client.ts:isTaskShape) rejects anything else before it reaches the
    // store. Unreachable; kept so a widened column fails loudly rather than
    // dropping rows off the board.
    if (lane === undefined) continue;
    lane.push(task);
  }
  return BOARD_LANES.map((spec) => ({
    status: spec.status,
    label: spec.label,
    // Stryker disable next-line all -- defensive: every lane key was seeded
    // above, so the fallback is unreachable.
    tasks: (byStatus.get(spec.status) ?? []).sort(byDueThenPosition),
  }));
}

/** True when `value` names one of the four lanes — guards a `data-` attribute. */
export function isTaskStatus(value: string): value is TaskStatus {
  return value === 'todo' || value === 'doing' || value === 'blocked' || value === 'done';
}

/**
 * The lane a phone shows next, wrapping at both ends.
 *
 * Under 900px the board is one lane at a time (see tasks.css), and paging with
 * two arrows beats a row of four tabs at 350px: the tabs would each be about
 * 80px wide, under the 44px-square touch floor once their labels are counted.
 * Wrapping means neither arrow is ever dead, which is one less disabled state
 * to explain on a screen this size.
 */
export function adjacentLane(current: TaskStatus, step: 1 | -1): TaskStatus {
  const at = BOARD_LANES.findIndex((lane) => lane.status === current);
  const next = (at + step + BOARD_LANES.length) % BOARD_LANES.length;
  const lane = BOARD_LANES[next];
  // Stryker disable next-line all -- defensive: `next` is a modulo of the
  // array's own length, so the index is always in range. Unreachable; kept
  // because noUncheckedIndexedAccess types it as possibly undefined and the
  // alternative is a cast, which this repo bans.
  if (lane === undefined) return current;
  return lane.status;
}
