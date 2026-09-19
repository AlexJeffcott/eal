# Plan 06 — Offline shell and capture

Status: parts A and B built on branch `offline-shell-capture`, 2026-09-19.
Not merged, not deployed, not yet tried on a phone. Plan 02 is done, which this plan required — an
outbox on top of a socket that never reconnects hides the wrong bug.

## Part A as built

Proved by `scripts/e2e-offline-shell.ts`: a real browser, a cold profile, and a
server process that is killed and restarted. Falsified two ways — with the
saved user removed it fails at step 2, and with the resync rule reverted it
fails at step 3.

The plan below named one defect. An offline cold boot reached three more:

| Defect | Fix |
|---|---|
| `GET /auth/me` was the only source of the user, so the cached shell opened on the sign-in screen | The client keeps the last confirmed user beside the token (`eal-user` in localStorage) and returns it only when no response arrived at all. A 401 and a sign-out both clear it. |
| The first WS connect never retried, so the app stayed deaf when the network returned | A socket that never opened now joins the reconnect loop and reads `reconnecting`. A refused token still reads `error` and does not retry. |
| The first `connected` skipped the seed, so the list stayed empty until the next drop | `installWsResync` skips only a `connected` that arrives before any seed has started. |

Differences from the decision below:

- The kill switch is `EAL_SW_KILL`, read on install, on activate and after
  every navigation — not on activate only. A worker activates once per
  version, so an activate-only check never runs again on the device that
  needs it.
- The page reads the switch too, before it registers. `register()` on a scope
  revives a registration that `unregister()` has only marked for removal, and
  the page registers on every boot. Measured: without the page-side check the
  registration count stayed at 1 under `EAL_SW_KILL=1`.
- The worker serves the cached entry when the network has not answered in 4
  seconds, and when it answers with a failing status. A late answer still
  replaces the entry. No signal on a phone is more often a request that hangs
  than one that fails.
- `/manifest.json` is cached as well as the four paths named below.

Known and not fixed in part A:

- ~~The task list is empty offline.~~ Fixed in part B: the list copy.
- The HTML, the bundle and the stylesheet are cached one entry each. A
  connection that dies between them leaves entries from two deploys. Each
  online load fetches all three, so the window is one page load wide.
- A token revoked while the device is offline: the WS retry loop then runs
  with no end, as it already did for a token revoked during a drop.

## Part B as built

Proved by `scripts/e2e-offline-capture.ts`: a real browser, a cold profile, a
database file from before the `client_id` column, a server process that is
killed and restarted, and a create whose response is failed at the response
stage over CDP — the server has committed and the device never hears. Every
count is read from the database, not the DOM. Falsified two ways — with the
server's client-id lookup disabled the replay is a 500, and with the IndexedDB
write removed the capture does not survive the reload.

| Piece | Where |
|---|---|
| The spec, hand-written TLA+, 5,991 distinct states, run by `bun devctl verify` | `specs/tla/tasks-convergence/TasksConvergence.tla` |
| Its TypeScript twin: explored exhaustively in the unit tier, asserts TLC's state count, and breaks the model once per invariant | `packages/api/src/specs/tasks-convergence-machine.ts` |
| `tasks.client_id`, unique per creator through a partial index; a replayed create returns the first row, 200, the same bytes, and is not broadcast again | `db/schema.ts`, `handlers/tasks.shared.ts:createTaskOnce` |
| `ServerRefusedError` carries the status; a `TypeError` still means no response arrived | `packages/client/src/eal-client.ts` |
| The outbox and the list copy — logic, with storage injected | `packages/web/src/apps/tasks/outbox.ts` |
| IndexedDB, Web Locks, `crypto.randomUUID` | `packages/web/src/apps/tasks/outbox-idb.ts` |
| The pending row: no controls, `data-task-pending`, fits 350px (asserted by the script) | `tasks-panel.tsx`, `tasks.css` |

What the plan got wrong, or did not name:

| The plan said | What is true |
|---|---|
| "Extend `tasks-convergence-machine`" | It did not exist. `docs/tasks-v1.md` named it and nothing had written it. polly's generator cannot express it — no sets, no sequences, no second device — and `polly verify` lists a `customTLAPaths` spec and SKIPS it. So the spec is hand-written and `packages/devctl/commands/verify.ts` runs TLC over it. |
| "On success the temp id is replaced by the server id" | There are three roads back, not one. A create whose response is lost still broadcasts, so the row reaches the device that still holds the entry — by broadcast if the socket is up, by seed if it was not. Each road must settle the entry by its client id or the capture shows twice. Found by the model (`NoDoubleDisplay`) before any code existed. `clientId` is on the `Task` wire shape for this reason. |
| "Have `createTaskCore` reject a duplicate" | A rejection is wrong. The device treats a failing status as "drop the entry and tell the user", so the replay must be a 200 carrying the first row. |
| Outbox store `{ tempId, title, createdAt }` | `{ clientId, userId, title, parentId, createdAt }`. `parentId` because capture lands where the user is standing. `userId` because if the sign-out clear ever fails, the next member's session must not send the last member's captures as its own. |
| Nothing about the list | Part A left the list empty offline. The copy is written after every change once a seed has succeeded, and read on ONE path: a seed that failed with no response, into an empty list. Reading it before every connect would let the server's list replace rows under the user a second later (lingua, PR #419). |

More found while building it:

- The replay lookup must run BEFORE the parent and level checks. A parent
  binned between the two sends otherwise turns the replay into a 404 for a row
  that exists, and the device drops a capture the server has.
- The replay lookup reads the trash. A capture binned before its replay
  arrives is still that capture.
- 401 and 403 are "send it again", not refusals. An expired session is a
  reason to sign in, not a reason to discard what the user wrote.
- The stored entry is deleted a moment after the signal forgets it. A flush
  that lists IndexedDB in that moment would put the entry back on the screen;
  the outbox keeps the ids it has seen finished.
- `e2e-offline-shell.ts` guarded against a cached list, which part B adds on
  purpose. Its seed proof is now a row written into the database file while the
  server is dead, which no broadcast and no copy can hold.

Known and not fixed in part B:

- **Only quick-add goes through the outbox.** Complete, edit, move and delete
  still need the server, and fail with the raw fetch error offline. The list is
  readable offline; it is not editable.
- **Sign-out discards unsent captures.** It logs the count to the console and
  does not ask first.
- A capture made inside a container that is deleted before the flush is
  refused (404). The title goes back to the input; the entry is gone.
- The subscribe-to-seed gap is not modelled: `Seed` is one atomic step in the
  spec. A broadcast that lands between the socket opening and the list
  response arriving can be overwritten by an older list. Plan 02's territory.
- Not tried on a phone. iOS evicts a home-screen PWA's IndexedDB on the same
  schedule as its caches, and that has never been measured.

## The reading

The service worker caches nothing, by an explicit decision.

| Fact | Evidence |
|---|---|
| `fetch` is pass-through; no precache, no runtime cache | `packages/api/src/spa.ts`, `serviceWorker` source |
| The reason given: a buggy SW must never lock a user into a stale bundle | same comment |
| `/sw.js` is served `cache-control: no-store` | `packages/api/src/spa.ts:206` |
| An IndexedDB adapter already exists | `packages/web/src/platform/indexed-db.ts` |

No signal means a blank page. You cannot capture a task on the underground, so
you stop trusting the app to hold your list.

## Decision

Two parts, shipped separately, precache first.

### Part A — app shell precache

Cache `/`, `/public/static/main.js`, `/public/static/main.css` and `/icon.svg`.
**Network-first with a cache fallback**, never cache-first. That honours the
existing warning: a broken bundle is replaced the moment the network answers.

Add a kill switch. The SW checks `/public/sw-kill` on activate; a `1` makes it
unregister itself and delete every cache. One deploy then recovers any device.

### Part B — capture outbox

Quick-add writes to IndexedDB first, then posts. On success the temp id is
replaced by the server id. Entries survive a reload and a cold start.

`docs/tasks-v1.md` already models optimistic creates with a client-side temp id
in `tasks-convergence-machine`. Extend that spec to cover an outbox entry that
survives a reload, so the "no phantom tasks" invariant still holds.

## Steps

1. Version constant in the SW source; bump it in the same commit as any change
   to the cached list.
2. Precache on `install`, delete other cache keys on `activate` (the activate
   handler already deletes every cache — keep the new one).
3. `/public/sw-kill` route returning `0`, and the SW check.
4. IndexedDB outbox store: `{ tempId, title, createdAt }`.
5. Quick-add writes the outbox entry, renders it as pending, and flushes on
   `online` and on every successful reconnect from Plan 02.
6. Flush is idempotent. A retried entry must not create two tasks — carry the
   `tempId` to the server and have `createTaskCore` reject a duplicate.

## Verification artefact

`scripts/e2e-offline-capture.ts`, run by `bun devctl test multi`. Load the app,
set the context offline, reload and assert the shell still renders, add a task
and assert it shows as pending, go back online, and assert exactly one task
reaches the server with the temp id resolved.

## Done when

Aeroplane mode: the app opens, you capture a task, you come back online, and it
is on the server once.

## Risk

A service worker that caches wrongly is the one failure that survives a
redeploy. The kill switch in step 3 is not optional.
