# Tasks (v1) — design

Status: draft, awaiting approval.

> **Three later stages have moved past this document; it is kept as the v1
> record, not as current documentation.**
>
> - **Stage 1** added `tasks.kind` — project → epic → task — with the pairing
>   rule in `handlers/tasks.shared.ts:levelViolation`.
> - **Stage 2** widened `status` from `('open','done')` to
>   `('todo','doing','blocked','done')` and added a board. Wherever this page
>   says `open`, read `todo`; wherever it says the status machine has three
>   states, read five (`packages/api/src/specs/tasks-status-machine.ts` is the
>   live model). The predictable-resurrection rule this page introduced still
>   holds — `restore` now lands in `todo`, and so does `reopen`.
> - **Stage 3** added `tasks.sequential` and the Available ("Next") view. The
>   "Sequential vs parallel projects" line in the deferral list below is no
>   longer deferred: it is built. The rule lives in
>   `packages/client/src/task-availability.ts` — one definition, read by the
>   SPA's Next view and by the assistant's `next_actions` tool.

Replaces: the `greetings` / `say-hello` / `hello:said` demo end-to-end.

## Purpose

A shared household task list that doubles as the canary feature for the whole
stack. Every signed-in user sees the same task set; mutations from any device
(SPA, CLI in v2) broadcast over WSS to every connected client. The feature is
small enough to ship in one cut but exercises every layer the architecture is
trying to prove: passkey auth, hierarchical data, optimistic UI, real-time
broadcast convergence, multi-device parity.

Out of scope for v1, deferred deliberately (each is its own design):

- Recurrence (RFC 5545 RRULE machinery).
- Categories / tags (GTD-style `@home`, `@laptop`).
- Comments / activity log table.
- Natural-language quick-add parsing.
- Background purge of soft-deleted rows.
- CLI surface (read/create/complete tasks from the terminal).
- Sequential vs parallel projects (OmniFocus-style). **Built in stage 3** — see
  the note at the top of this page.
- Email / Slack capture integrations.

The v1 feature set is deliberately tight. Each deferred item has a known shape
and can be added later without schema rewrites.

## Schema

```sql
CREATE TABLE tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  title         TEXT    NOT NULL,
  notes         TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL CHECK (status IN ('open','done')),
  defer_until   TEXT,                                      -- ISO 8601, nullable
  due_at        TEXT,                                      -- ISO 8601, nullable
  created_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_to   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT,                                      -- non-null iff status='done'
  deleted_at    TEXT,                                      -- non-null = in trash
  position      INTEGER NOT NULL DEFAULT 0,

  CHECK ((status = 'done') = (completed_at IS NOT NULL))
);

CREATE INDEX idx_tasks_parent_position ON tasks (parent_id, position);
CREATE INDEX idx_tasks_assigned_to     ON tasks (assigned_to);
CREATE INDEX idx_tasks_status          ON tasks (status);
CREATE INDEX idx_tasks_defer_until     ON tasks (defer_until);
CREATE INDEX idx_tasks_deleted_at      ON tasks (deleted_at);
```

### Design notes on the schema

- **Adjacency list (`parent_id`)** is the right hierarchy storage for our scale
  (household-sized, shallow trees, frequent re-parenting and clones). SQLite
  recursive CTEs handle ancestor / descendant queries; every recursive query
  carries a `LIMIT` as a safety bound. Nested-set and closure-table approaches
  optimise stable-tree reads and become painful with frequent writes — not us.
- **Soft delete via `deleted_at`** plus a Trash view, not `DELETE` of rows.
  Standard data-lifecycle pattern. Restore is `UPDATE tasks SET deleted_at = NULL`.
  Background purge after 30 days is deferred — the column is what matters now.
- **CHECK constraint on status / completed_at** locks the most important
  invariant at the storage layer so application bugs cannot violate it.
- **`defer_until` is the primary date.** Things-3-style: "when am I going to
  do this?", not "when does it have to be done?". The UI defaults to start
  dates; `due_at` is for true deadlines and triggers visual urgency only.
- **No `version` / optimistic-lock column.** Server is the tiebreaker. Multiple
  clients can race; each mutation goes server-side, broadcasts back canonical
  state, and every client (including the originator) replays the broadcast.
  See "Convergence" below.
- **`ON DELETE CASCADE` on `parent_id`** is for hard-delete during testing /
  schema integrity only. Application `DELETE` requests soft-delete via
  `deleted_at`; the cascade fires when a row really leaves the table (after
  purge).
- **`ON DELETE RESTRICT` on `created_by` / `updated_by`** prevents user
  deletion from corrupting audit fields. `assigned_to` cascades to NULL so a
  deleted user's assignments simply unassign.

## API surface

All routes are mounted under `/api/v1/tasks` and require an authed principal
(SPA bearer token or CLI session token). The principal binding is the same
middleware the greetings demo used.

### Routes

| Method | Path                                  | Body                                                                            | Returns                          |
|--------|---------------------------------------|---------------------------------------------------------------------------------|----------------------------------|
| POST   | `/api/v1/tasks`                       | `{ title, parent_id?, assigned_to?, notes?, defer_until?, due_at? }`            | `{ task }`                       |
| GET    | `/api/v1/tasks`                       | (query params — see Views)                                                      | `{ tasks: Task[] }`              |
| GET    | `/api/v1/tasks/:id`                   | —                                                                               | `{ task, children: Task[] }`     |
| PATCH  | `/api/v1/tasks/:id`                   | `{ title?, notes?, assigned_to?, defer_until?, due_at?, position?, parent_id? }`| `{ task }`                       |
| POST   | `/api/v1/tasks/:id/complete`          | —                                                                               | `{ task }`                       |
| POST   | `/api/v1/tasks/:id/reopen`            | —                                                                               | `{ task }`                       |
| POST   | `/api/v1/tasks/:id/clone`             | —                                                                               | `{ subtree: Task[] }`            |
| DELETE | `/api/v1/tasks/:id`                   | —                                                                               | `{ task }` (with `deleted_at`)   |
| POST   | `/api/v1/tasks/:id/restore`           | —                                                                               | `{ task }`                       |

### Task JSON shape

```ts
interface Task {
  id: number;
  parent_id: number | null;
  title: string;
  notes: string;
  status: 'open' | 'done';
  defer_until: string | null;     // ISO 8601
  due_at: string | null;          // ISO 8601
  created_by: number;
  assigned_to: number | null;
  updated_by: number;
  created_at: string;             // ISO 8601
  updated_at: string;             // ISO 8601
  completed_at: string | null;    // ISO 8601, non-null iff status='done'
  deleted_at: string | null;      // ISO 8601, non-null = soft-deleted
  position: number;
}
```

### Validation rules

- `title` non-empty after trim. Trim before persisting.
- `parent_id`, when provided, must reference an existing non-deleted task.
- Re-parenting (`PATCH` with new `parent_id`) must not create a cycle.
  Enforce with a recursive CTE that walks ancestors of the new parent and
  rejects if it encounters the moving task's id.
- `assigned_to`, when provided, must reference an existing user.
- `defer_until` and `due_at`, when provided, must parse as ISO 8601 timestamps.
- A soft-deleted task cannot be patched. `restore` first.
- `complete` on a `done` task is a no-op (return current state, 200).
- `reopen` on an `open` task is a no-op.
- `clone` requires the source to be non-deleted; sets every cloned row's
  `status = 'open'`, `completed_at = NULL`, fresh `created_at` / `updated_at`,
  preserves the subtree shape (children of cloned root are themselves cloned
  with new `parent_id` pointing at the new root).

### Errors

All error responses match the existing `{ error: string }` envelope (already
relied on by `extractServerError` in `eal-client.ts`). Status codes:

- 400 — validation failure (`title required`, `defer_until must be ISO 8601`,
  `would create cycle`).
- 401 — unauthenticated.
- 404 — task not found (or soft-deleted when the route requires it live).
- 409 — `assigned_to` references unknown user (rare; users don't get deleted
  often).
- 500 — anything else; surfaces the raw `err.message` so the friendly mapper
  can match.

The web friendly-mapper gets a small extension to map task-specific phrases
(`title required`, `would create cycle`, `cannot patch deleted task`) to
human-readable copy. Same pattern as `friendlySignInError`.

## WS events

Three event types. Payloads carry the full canonical `Task` row so clients can
patch local state without re-fetching.

```ts
// Created.
{ "type": "task:created",  "topic": "tasks", "payload": Task }

// Updated (also fired for complete, reopen, restore, assign, move).
{ "type": "task:updated",  "topic": "tasks", "payload": Task }

// Soft-deleted. payload.deleted_at is non-null.
{ "type": "task:deleted",  "topic": "tasks", "payload": Task }
```

Clone fires:

```ts
{ "type": "task:tree-cloned", "topic": "tasks", "payload": { root_id: number, tasks: Task[] } }
```

A single event carries the whole new subtree so the client can splice it in
atomically — no flicker of half-rendered trees.

### Broadcast scope

All authed sockets receive every `tasks` topic event. There's no per-user
permission filtering (tasks are shared by design). Anonymous sockets do not
exist — the WS auth handshake gates connection.

### Ordering

The server is the single broadcaster. Events from a single client mutation
are emitted in the same order the server applied them. Cross-client ordering
is not guaranteed (one client's create may arrive before another client's
older delete) — clients reconcile by trusting the payload's `updated_at`.

## View filters

`GET /api/v1/tasks` accepts query parameters. All filters combine with `AND`.
The default response excludes soft-deleted tasks unless `?trash=1`.

| Param         | Type                  | Meaning                                                  |
|---------------|-----------------------|----------------------------------------------------------|
| `parent_id`   | integer \| `null`     | Children of this parent (or roots when `null`)           |
| `assigned_to` | integer \| `me`       | Filter by assignee; `me` resolves to the principal       |
| `created_by`  | integer \| `me`       | Filter by creator                                        |
| `status`      | `open` \| `done`      | Status filter                                            |
| `due_before`  | ISO 8601              | `due_at < x`                                             |
| `defer_after` | ISO 8601              | `defer_until > x` (Upcoming view)                        |
| `today`       | `1`                   | `(defer_until IS NULL OR defer_until <= today) AND open` |
| `inbox`       | `1`                   | `parent_id IS NULL AND assigned_to IS NULL AND defer_until IS NULL` |
| `trash`       | `1`                   | `deleted_at IS NOT NULL` (otherwise excluded)            |
| `q`           | string                | `title LIKE %q% OR notes LIKE %q%`                       |

The v1 SPA surfaces:

- **Inbox** (default landing for capture)
- **Today**
- **All open** (no filter, status=open)
- **By project** (drill into a parent)
- **Mine** (`assigned_to=me`)
- **Trash**

**Upcoming** uses the `defer_after` filter but is hidden behind a v2 toggle
per the design conversation — schema and route support it; the UI doesn't
expose it yet.

## TLA+ invariants

Two new state-machine specs under `packages/api/src/specs/`, following the
existing `auth-machine.ts` / `ws-machine.ts` pattern. Both come with the same
anchoring caveat the existing specs carry: `polly verify` proves the SPECS
are consistent. It does not prove the production code matches the specs;
that's the test layers' job.

### `tasks-status-machine`

**Superseded by stage 2** — see the header note. The live model has five
states (`todo`, `doing`, `blocked`, `done`, `deleted`) and adds a `setStatus`
transition for the board's lane move. What follows is the v1 shape.

Models a single task's lifecycle. Three states: `open`, `done`, `deleted`.
Plus the implicit `gone` state once a row is purged.

Transitions:

- `open → done` (complete)
- `done → open` (reopen)
- `open → deleted`, `done → deleted` (soft delete)
- `deleted → open` (restore; restore always returns to `open` for predictability)
- `deleted → gone` (purge, deferred to v2)

Invariants:

- A `done` task always has `completed_at`. A non-`done` task never does.
- A `deleted` task always has `deleted_at`.
- No transition from `gone` exists.

### `tasks-convergence-machine`

Models N devices observing an interleaving of `(local-op, server-accept,
broadcast-deliver)` for a single task set. State variables: server's task
set, each device's local task set, pending broadcasts.

Invariants:

- **Eventual convergence**: once `pending_broadcasts` is empty, every device's
  task set equals the server's.
- **No phantom tasks**: a task on any device must either exist on the server
  OR be a pending local optimistic create (tagged with a client-side temp id).
- **No lost deletes**: if the server has marked a task `deleted_at != NULL`,
  no device may show it in non-Trash views once the broadcast has been
  delivered to that device.

This is the spec that makes the multi-device demo worth doing. Catches the
class of bug where a client mutates locally and the broadcast never
reconciles — silently divergent state across devices.

## Test plan

Five tiers, mapped to the existing `bun devctl test <tier>` infrastructure.
Each new layer is named with the file path that will contain it.

### Unit (`bun devctl test unit`)

- `packages/api/src/db/repos/tasks.test.ts` — repo CRUD, soft-delete behaviour,
  CHECK-constraint enforcement (`(status='done') = (completed_at NOT NULL)`),
  cycle-detection on re-parent, clone preserves subtree shape, cascade on
  hard-delete of parent (when triggered by purge).
- `packages/api/src/handlers/tasks.shared.test.ts` — core functions:
  `createTaskCore`, `updateTaskCore`, `completeTaskCore`, `reopenTaskCore`,
  `cloneTaskCore`, `deleteTaskCore`, `restoreTaskCore`, `listTasksCore` with
  every filter combination.
- Property-based test for cycle detection: arbitrary tree, arbitrary move,
  assert no cycle ever results and rejection is correct.

### Wire contract (`bun devctl test unit`, same tier)

- `packages/api/src/handlers/tasks.http.test.ts` — drives the real Elysia
  routes via `createTestApp`. Asserts:
  - Every endpoint's success shape matches the `Task` interface above.
  - Every error shape matches `{ error: string }` (the contract
    `extractServerError` depends on, already locked by `auth.http.test.ts`).
  - 400 / 404 / 409 codes for the documented failure modes.
  - Authenticated routes return 401 without a principal.

### Browser (`bun devctl test browser`)

- `packages/web/tests/browser/tasks.browser.tsx` — `MockEalClient` driven:
  - Empty state renders correctly.
  - Create flow: typing a title and submitting creates a task in the local
    store, badge updates, the new row renders in the list.
  - Complete / reopen flips status and updates the rendered checkbox.
  - Inbox / Today / All / Trash filter switches show the expected tasks.
  - Detail view shows notes, allows edit, save returns to list.
  - Friendly error mapping for `title required` etc.
  - Convergence: simulate a broadcast `task:updated` while the user has an
    optimistic local edit in flight; assert the server's payload wins.

### Multi-process E2E (`bun devctl test multi`)

- `scripts/e2e-tasks-multi.ts` — modelled on `e2e-hello-multi.ts`. Two real
  puppeteer browsers + virtual authenticators, both signed in as the same
  household. Browser A creates a task; assert browser B sees it within a
  bounded time. Browser B completes it; assert browser A's checkbox flips.
  Browser A deletes it; assert it appears in Trash on both.
- `scripts/e2e-tasks-parity.ts` — modelled on `e2e-hello-parity.ts`. Asserts
  HTTP create and the equivalent WS broadcast produce byte-identical `Task`
  payloads, so the SPA's "broadcast wins" reconciliation never has a phantom
  diff to apply.

### Verify (`bun devctl verify`)

- `packages/api/src/specs/tasks-status-machine.ts` — TLC-checked status
  transitions.
- `packages/api/src/specs/tasks-convergence-machine.ts` — TLC-checked
  convergence + no-phantom + no-lost-delete.

### Coverage policy

`tasks.shared.ts` and `tasks.http.ts` will follow the existing `auth.shared.ts`
/ `auth.http.ts` pattern: unit-tested at the core-function level, plus the
http test for the wire envelope. Anything that can only be exercised against
real HTTPS + WSS goes into `coverage.config.ts` as an exempt entry with the
e2e script as the `claimedBy`.

## Web UI

The home page card "Latest greeting" goes away. Replaced by a tasks surface:

- Authed view (signed in): tabs / segmented control across **Inbox**, **Today**,
  **All open**, **Trash**. Each tab renders a list. Each row has:
  checkbox (toggle open/done), title, optional assignee badge, optional
  defer / due date pills, click-into for detail.
- A persistent **Quick add** input at the top of every tab. Single line.
  Title only. Enter creates and clears. Keyboard shortcut `Q` focuses it from
  anywhere on the page.
- Anonymous view (signed out): unchanged — Sign in card.
- The "Pair a CLI device" link in the header remains.

Detail view (`/public/task/:id`) shows full notes, assigned-to picker,
defer / due pickers, children list, "Clone" button, "Move to Trash" button.

The first paint shows whatever is in the store before WS reconciles, so the
list appears instantly on navigation. The WS broadcast then patches.

## Cutover plan

1. Land the new `tasks` table via `applySchema` (additive — `greetings` still
   present).
2. Build repo, core, HTTP routes, WS broadcast for tasks behind no flag —
   they're new endpoints, no existing user depends on them.
3. Land the new web UI replacing the `Latest greeting` card. Greetings code
   in the SPA is removed in the same commit; `subscribeHelloSaid` callback
   in `main.tsx` and the `$latestGreeting` store go away.
4. After the new UI is verified end-to-end, remove the server-side greetings
   surface in a separate commit: `say-hello` route, `hello:said` WS topic,
   `greetings` repo, `format-greeting`. Drop the `greetings` table via a
   schema migration step in `applySchema`.
5. Delete the e2e harnesses `e2e-hello-multi.ts` and `e2e-hello-parity.ts`
   in the same commit as step 4. The new `e2e-tasks-multi.ts` /
   `e2e-tasks-parity.ts` replace them as the cross-boundary canary.
6. Update `packages/cli/src/commands/hello.ts` — the CLI currently has a
   `hello` command that calls `sayHello`. v1 keeps it as a no-op alias for
   the canary script so existing scripts don't break; v2 introduces task
   CLI commands proper.

The cutover is reversible up to step 4. After step 4, rolling back means
restoring the greetings code from git.

## Open items for review

If anything here is wrong or needs reshaping, push back before any code lands.
Specific places I'd welcome a second look:

- **`ON DELETE CASCADE` vs `ON DELETE SET NULL` on `parent_id`.** I picked
  cascade because soft-delete prevents the cascade from firing in practice;
  the only time it does fire is during purge or explicit hard-delete, where
  orphaning children is worse than deleting them. Alternative: set children's
  `parent_id` to NULL on parent delete, promoting them to roots. Which feels
  right?
- **Clone behaviour on a partially-completed parent.** Currently every child
  is reset to `open`. Alternative: only clone children that were `done` at
  the time of cloning (interpretation: "let's do that again"). I prefer the
  former — simpler, more predictable.
- **Re-parenting cycle detection.** Currently rejected at the application
  layer via a recursive CTE check. SQLite has no native cycle constraint.
  Acceptable, but if any future hot path re-parents a lot, materialise the
  ancestor set in a sidecar table.
- **`Today` filter timezone.** Server uses UTC for `defer_until`; "today" is
  the principal's local day. For v1 the SPA sends `defer_before=<end-of-my-day>`
  computed client-side. Document and accept this as a v1 limitation; a v2
  could add a per-user timezone column.
