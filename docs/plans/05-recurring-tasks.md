# Plan 05 — Recurring tasks

Status: built on branch `recurring-tasks`, 2026-09-19. Not merged, not
deployed. Deferred deliberately at v1 — `docs/tasks-v1.md`, "Out of scope for
v1".

## As built

Proved by `scripts/e2e-tasks-recurrence.ts`: a database file in the shape
release v46 left in production, migrated by the api on boot, then two real
browsers driven through the editor and the tick box, with every count read from
the database file. Falsified two ways — with the untick's reclaim disabled it
fails at step 3, and with `nextOccurrence` ignoring `today` it fails at step 2.

### Decisions taken

| Question | Answer |
|---|---|
| The rule set | The fixed set below. `{every:'days',interval}`, `{every:'weekdays'}`, `{every:'week',days}`, `{every:'month',day}`, each with `basis`. Canonical JSON in `tasks.recurrence`. Unknown fields are refused; `interval` is 1–365; a weekly rule names at least one day; `day` is 1–31 and falls on the last day of a shorter month. |
| Dates or instants | Calendar dates. A due date is what `<input type=date>` produced, stored as typed and shown by its first ten characters, so the arithmetic is a day count on the date part with no `Date` anywhere. A clock change cannot move a task. A time on the anchor is carried unchanged. `packages/shared/src/recurrence.ts`. |
| Whose "today" | The device's. The server runs in UTC and at 00:30 in Rome UTC's date is still yesterday. `complete` and the board's lane move take an optional `today`; the server refuses one more than a day from its own UTC date, which no timezone is. The CLI and the assistant send the local date of the machine they run on. With none sent, UTC's. |
| Never a backlog | The successor is the first occurrence strictly after `today`. A recurring task with `basis: 'due'` and no `due_at` counts from `today`. |
| The accidental tick | Reopening a finished occurrence removes its successor if nobody has touched it, and the rule returns. A touched successor stays and keeps the rule; the reopened row comes back plain. |
| What "untouched" is | A column, `spawn_group`, not a comparison of timestamps. Every row of a spawned tree holds the finished row's id; any write to any of them clears it on all of them. Both clocks are whole seconds, so an edit in the second a row was made would read as no edit. The reminder scan is not a person and does not clear it. |
| The trash | One occurrence. Deleting spawns nothing. Clearing the rule ends the series. Restore brings the rule back. Binning the *finished* row settles its successor as kept. |
| Containers | The successor is the live subtree, every row at `todo`, `client_id` and `reminded_at` NULL, every date moved by as many days as the root's. Completing a container still completes its own row only. |
| A copy | `clone` of a recurring task recurs: it is a second series, on purpose. |
| Events | `task:updated` for the tick, then `task:created` for a leaf successor or `task:tree-cloned` for a container's. An untick that takes rows back sends a new event, `task:removed { ids }`. The rows are gone, not binned. |

### What the plan, or its brief, got wrong

| Claim | Reading |
|---|---|
| Step 1: the schema goes in `packages/api/src/apps/tasks.ts` | That file holds the `CREATE TABLE`. Columns added since go in `packages/api/src/db/schema.ts` as `ensureColumn` calls, and **must sit after `rebuildTasksStatusIfLegacy`**, whose hand-written column list would otherwise drop them. Three columns, not one. |
| Step 2: `nextOccurrence(rule, anchor)`, "strictly later than now" | The clock is an argument: `nextOccurrence(rule, anchor, today)`. A function that reads the clock cannot be property-tested, and cannot be told it is tomorrow in Rome. It lives in `@eal/shared`, not `tasks.shared.ts`: the SPA describes the rule and the assistant validates it with the same code. |
| Step 3: `completeTaskCore` creates the successor | So must the board. `POST /:id/status` with `done` is a completion and a drag back out is a reopen. All three routes land in one function, `moveStatus`. |
| Step 4: reuse `task:created` | For a leaf. A container's successor is a subtree and rides `task:tree-cloned`. And nothing existing could say "these rows no longer exist", so `task:removed` is new. |
| Brief: "untouched" = still todo, not deleted, never updated since creation, no children added | "Never updated since creation" cannot be read off `updated_at`: whole seconds. Hence `spawn_group`. It also had to cover moving a row *into* the tree, cloning the successor, and binning the finished row — the last found by the property test, below. |
| Open question: does the trash hold the series or one occurrence | One occurrence. There is no series object to bin. |

### Defects found on the way

- **Binning the finished row left its successor provisional.** Found by the
  property test, shrunk to four steps: tick, bin the finished row, restore it,
  reopen. Restore lands in `todo` by a different road than reopen, so the
  successor survived with a group id pointing at a row that was no longer
  `done` — and a later tick-and-untick of that row would have removed a
  successor two occurrences old. `softDelete` now releases the group.
- **The recurrence badge overflowed the 350px floor by 211px.** polly's Badge
  sets `white-space: nowrap` on its own element, so allowing the wrap on the
  wrapper did nothing. Found by the Playwright case, which then failed six
  unrelated cases too: every member sees every task, so one wide row breaks
  every later measurement on that server.
- **`aria-pressed` on a day toggle was silently dropped.** polly's Button
  forwards `data-action-*`, `aria-label` and `title` and nothing else. The state
  is in the accessible name ("Tuesday, on").
- **A done child with its own successor would be copied twice** into a
  container's next occurrence — once as itself, once as its live successor.
  `spawnSuccessor` skips a done row that something already succeeds.
- **A list copy from before this build has no `recurrence` key**, and the panel
  reads `recurrence !== null` as "repeats". `withKnownRecurrence` reads a
  missing or unparseable rule as null.
- **A blur in the same tick as an input commits the old value** in polly's
  `ActionInput`, which commits the draft it last rendered with. A finger cannot
  do that; the e2e script could, and did. The script now waits for the value
  before it blurs. Not an app defect, recorded so the next script does not
  rediscover it.
- **A locator click on quick-add lands on the sticky top bar** once the list
  scrolls: the click scrolls its target to the top edge, under the bar, and
  opens the Assistant. The script focuses and types instead.

### The verifier

`tasks-status-machine.ts` does not model recurrence, and its header says why:
the property is about a series of rows and the machine is one enum for one
task; whether an untick reclaims depends on writes to a different row through a
different route; and whether `complete` spawns depends on a column's value,
which the extractor cannot read. A `successor` field could be added and
anchored, but TLC would then prove what was typed to mirror the code.
`handlers/tasks.recurrence.property.test.ts` stands in: arbitrary complete /
reopen / lane-move / edit / bin / restore sequences from two people against the
real cores and SQLite, four laws checked after every step. Three broken repos
each fail it. It is a search, not a proof. `bun devctl verify` still passes
over the routes, whose `requires` / `ensures` are unchanged.

### Known and not fixed

- **Complete still needs the server.** An offline tick fails, recurring or not
  (plan 06 left this). A pending outbox row offers no recurrence control.
- **The mock client spawns a leaf successor only**, never a container's
  subtree. The browser tier renders what it is given; the tree is proved
  against the real api.
- **The Today view's cutoff is UTC end-of-day** (`tasks.shared.ts`,
  `defaultTodayCutoff`) unless the caller sends one. Pre-existing, and the same
  class of defect `today` fixes here. Not changed.
- **Nothing here is tried on a phone.**
- A rule cannot say "every second Tuesday" or "the last Friday". Move to RRULE
  when a rule is met that cannot be expressed — not before.

## The reading

There is no recurrence anywhere: no column, no route field, no UI control. A
household task list without it makes you retype the bins every week.

## Decision

A small fixed rule set, not RFC 5545.

| Option | Cost |
|---|---|
| Full RRULE via a library | complete, and a dependency plus a parser for cases you will never write |
| **Fixed set**: every N days · weekdays · weekly on given days · monthly on day N | covers household work; a pure function and a property test; no dependency |

**Recommendation: the fixed set.** Store it as JSON in a `recurrence TEXT`
column. Move to RRULE only when you meet a rule you cannot express.

### The basis question

On completion, the next occurrence is computed from one of two anchors, and
both are needed:

| Basis | Example | Anchor |
|---|---|---|
| `due` | bins go out every Tuesday | the previous `due_at` |
| `completed` | water the plants every 5 days | `completed_at` |

The rule carries `basis: 'due' \| 'completed'`.

Never generate a backlog. Complete a weekly task three weeks late and the
successor is the first occurrence strictly after now — not three catch-up rows.

## Steps

1. **Schema.** `tasks.recurrence TEXT` (nullable), in
   `packages/api/src/apps/tasks.ts`.
2. **The function.** `nextOccurrence(rule, anchor): string | null` in
   `packages/api/src/handlers/tasks.shared.ts`. Pure. Property-tested with
   `fast-check`, which is already a devDependency: for any rule and any anchor
   the result is strictly later than now, and applying it twice never moves
   backwards.
3. **`completeTaskCore`** creates the successor in the same transaction as the
   completion and returns both rows.
4. **WS.** Reuse `task:created` for the successor, emitted after `task:updated`
   for the completion, in that order.
5. **UI.** A recurrence control in the inline detail editor
   (`packages/web/src/apps/tasks/tasks-panel.tsx`), and a badge on a recurring
   row. CSS classes with polly tokens.
6. **Assistant.** Extend `create_task` and `update_task` in
   `packages/cli/src/apps/tasks.ts` with a `recurrence` argument, so "remind me
   every Tuesday" works from chat.

## Verification artefact

`scripts/e2e-tasks-recurrence.ts`, run by `bun devctl test multi`. Two real
browsers. Complete a weekly task in browser A. Assert browser B receives the
successor, with the correct `due_at`, and that no second successor appears.

## Done when

A weekly task reappears once after completion, on both devices, dated
correctly.

## Open

Deleting a recurring task: does the trash hold the whole series or one
occurrence? Recommendation: one occurrence, and clearing `recurrence` on the
row ends the series. Decide before the UI lands.
