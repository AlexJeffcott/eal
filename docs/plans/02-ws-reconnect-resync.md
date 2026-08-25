# Plan 02 — Reconnect and resync the browser WebSocket

Status: **done, 2026-08-25.**

What landed:

| Piece | Where |
|---|---|
| Reconnect loop, 500 ms → 30 s backoff, re-`subscribe` on every open | `packages/client/src/eal-client.ts` `openBrowserWs` / `scheduleReconnect` |
| `connectionState()`, `subscribeConnectionState()`, `reconnectNow()` | the `EalClient` surface, mirrored in `@eal/client-mock` |
| `$wsState` follows the socket; re-seed on every reconnect after the first | `packages/web/src/main.tsx` `installWsResync` |
| Wake on `visibilitychange` and `online`, ignoring the backoff | same |
| A "Reconnecting" banner that says what is stale | `packages/web/src/shell/app.tsx` |
| 6 unit tests driving a fake socket | `packages/client/src/eal-client.test.ts` |
| 2 browser tests for the banner | `packages/web/tests/browser/ws-error.browser.tsx` |
| Verification artefact | `scripts/e2e-tasks-reconnect.ts` |

The artefact was checked against the defect: with the `close` handler removed
it fails at step 2 (`Waiting for selector [data-ws-reconnecting] failed`), and
passes with it restored. Measured after the change: unit 1079 pass, browser 68
pass, e2e 25 pass.

The first `connect()` still does not retry — a rejected token or a wrong origin
would otherwise retry forever in silence. Only drops after a successful connect
reconnect.

## The reading

The browser WebSocket never reconnects, and the UI does not know it has gone.

| Fact | Evidence |
|---|---|
| `connectWs` installs no `close` listener for the `browser` role | `packages/client/src/eal-client.ts:506` |
| `connect()` sends one `subscribe` frame and returns | `packages/client/src/eal-client.ts:552` |
| `$wsState` is written `'connected'` once and never revised | `packages/web/src/main.tsx:336` |
| `seedSessionData` runs once, at boot | `packages/web/src/main.tsx:131` |
| The agent path and the family-phone device path **do** reconnect | `eal-client.ts:556`, `eal-client.ts:882` |

A phone suspends the tab. The socket closes. The app keeps showing
"connected", every broadcast sent while it was away is lost, and the list stays
wrong until a full page reload.

## Decision

Reconnect inside the client, and re-seed the stores on every reconnect.

Re-seed rather than replay: the server keeps no per-client event log, and
broadcasts are fire-and-forget. A full `listTasks()` is bounded by the
household's task count, so it is cheap. A server-side event log with cursors is
the alternative and is far larger than this problem.

## Steps

1. **Client — reconnect loop.** Copy the shape already proven in the device
   path (`eal-client.ts:882`): a `closed` flag recording caller intent, a
   `close` listener, exponential backoff 500 ms → 30 s, reset on a successful
   handshake. On each open, re-run the auth handshake and re-send
   `{ type: 'subscribe', topic: 'tasks' }`.
2. **Client — state channel.** Add
   `subscribeConnectionState(handler: (s: 'connecting' | 'connected' | 'reconnecting' | 'error') => void)`.
   The shell owns the display; the client owns the truth.
3. **Web — re-seed.** On every transition into `connected` **after the first**,
   call `seedSessionData(stores)`. That refetches tasks, messages, the roster
   and devices.
4. **Web — wake fast.** A `visibilitychange` listener: when the document
   becomes visible and the state is not `connected`, force an immediate attempt
   instead of waiting out the backoff.
5. **Web — show it.** `$wsState` drives a visible indicator. A phone that is
   offline must say so.
6. **Chat — no silent hang.** A `chat:send` whose socket drops currently fails
   only when the *agent* drops (`server-factory.ts:180`). Add a browser-side
   timeout that turns an unanswered request into `chat:error`.

## Tests

| Tier | What it asserts |
|---|---|
| unit — `packages/client/src/eal-client.test.ts` | backoff schedule; `close()` stops the loop; a re-open re-subscribes |
| browser — `packages/web/tests/browser/ws-error.browser.tsx` | state moves to `reconnecting`; the re-seed fires on the second connect |
| multi — new script below | real sockets, two real browsers |

## Verification artefact

`scripts/e2e-tasks-reconnect.ts`, run by `bun devctl test multi`. Two real
browsers signed in as the same household. Close browser B's socket from inside
the page. Create a task in browser A. Restore B's network. Assert B shows the
task **without a reload**, and that `$wsState` read `reconnecting` while the
socket was down.

## Done when

The multi script passes, and on a real phone: lock the screen for two minutes,
create a task on the laptop, unlock the phone, and the task is there without a
reload.

## Not measured

iOS may terminate a backgrounded tab outright rather than suspend it. In that
case boot runs and seeds normally, so the fix is unnecessary for that path —
but I have not measured which behaviour your phone takes.
