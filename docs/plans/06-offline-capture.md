# Plan 06 — Offline shell and capture

Status: not started. Do this after Plan 02 — an outbox on top of a socket that
never reconnects hides the wrong bug.

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
