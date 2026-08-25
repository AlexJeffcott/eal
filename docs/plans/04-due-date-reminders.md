# Plan 04 — Due-date reminders

Status: not started. Depends on Plan 01 — do not attach push subscriptions to
an instance anyone can join.

## The reading

Push works, for exactly one event, and tasks are not it.

| Fact | Evidence |
|---|---|
| VAPID config loads from env, all three keys or none | `packages/api/src/handlers/push.http.ts:36` |
| The only HTTP route is the public VAPID key | `packages/api/src/handlers/push.http.ts:69` |
| The subscribe / unsubscribe routes named in that file's own header comment **do not exist** | `packages/api/src/handlers/push.http.ts:7` |
| Subscriptions arrive over the family-phone device WebSocket | `packages/api/src/handlers/family-phone.ws.ts:219` |
| They are stored against a device, not a user | `packages/api/src/apps/family-phone.ts:112` |
| The only sender is the missed-call wake path | `packages/api/src/handlers/family-phone-call-wake.ts` |
| `due_at` triggers nothing at all | `packages/api/src/handlers/tasks.shared.ts` |

## Decision

A user-level subscription and a scan tick inside the api process.

The tick belongs in the api, not in the agent worker. Reminders must fire when
the agent machine is off, and the api is the part that is always up. The
existing `agent-scheduler.ts` is a call-placing scheduler tied to family-phone
devices; do not overload it.

## Steps

1. **Schema.** `push_subscriptions(user_id, endpoint, p256dh, auth,
   created_at)` with a unique index on `endpoint`. A new `push` app in
   `packages/api/src/apps/`. Do not reuse
   `family_phone_push_subscriptions` — its foreign key is a device.
2. **Routes.** `POST /api/v1/push/subscribe` and `/unsubscribe`, authed. The
   header comment in `push.http.ts` already describes them; make them real.
3. **Column.** `tasks.reminded_at TEXT` — non-null once a reminder for the
   current `due_at` has been sent. Clearing or moving `due_at` clears it. This
   is what makes the tick idempotent across restarts.
4. **The tick.** Every 60 s: select open, non-deleted tasks where
   `due_at <= now` and `reminded_at IS NULL`; send one push per subscription of
   the assignee (or of every member when unassigned); stamp `reminded_at`.
5. **Payload.** Reuse the shape the service worker already parses —
   `{ kind: 'task', title, body, tag, url }` (`packages/api/src/spa.ts`, the
   `serviceWorker` source). `url` deep-links to `/tasks`.
6. **Web.** A "Remind me" control in the tasks panel that calls
   `requestPushPermission()` then `ensurePushSubscription()`
   (`packages/web/src/platform/push.ts`) and POSTs the result. Permission must
   be requested from a real gesture.
7. **Deploy.** Generate a VAPID pair, set the three `EAL_VAPID_*` values as Fly
   secrets, add them to the `docs/deploy.md` table.

## Scope held back

Exact-time reminders only. A morning digest ("everything due today, at 08:00")
needs a per-user timezone, which `docs/tasks-v1.md` already records as a v1
limitation. Add the column when you want the digest, not before.

## Verification artefact

`scripts/e2e-task-reminder.ts`, run by `bun devctl test multi`. Stand up a
local HTTP server that impersonates the push vendor endpoint. Create a task due
in two seconds. Assert exactly one request arrives, that its body carries the
task title, and that the next tick sends nothing.

## Done when

A task due in two minutes rings your phone with the app closed.

## Not measured

iOS delivers Web Push only to a PWA added to the home screen, on iOS 16.4 and
later. I have not verified this on your phone. Test it there before counting
the feature as working.
