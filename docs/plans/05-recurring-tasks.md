# Plan 05 — Recurring tasks

Status: not started. Deferred deliberately at v1 —
`docs/tasks-v1.md`, "Out of scope for v1".

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
