# Plan 06 — Offline shell and capture

Status: part A built on branch `offline-shell-capture`, 2026-09-19, not
deployed. Part B not started. Plan 02 is done, which this plan required — an
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

- **The task list is empty offline.** Nothing caches it. Part B has to keep a
  copy of the list in IndexedDB beside the outbox, or an offline capture lands
  in a list that looks deleted.
- The HTML, the bundle and the stylesheet are cached one entry each. A
  connection that dies between them leaves entries from two deploys. Each
  online load fetches all three, so the window is one page load wide.
- A token revoked while the device is offline: the WS retry loop then runs
  with no end, as it already did for a token revoked during a drop.

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
