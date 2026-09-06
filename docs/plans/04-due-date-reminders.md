# Plan 04 — Due-date reminders

Status: **steps 1–6 built and verified, 2026-09-06. Step 7 (deploy) is the
owner's and is not done.** Depended on Plan 01 — do not attach push
subscriptions to an instance anyone can join; registration has been closed
since 2026-08-25.

Two things in this plan were written before stages 2 and 3 and were stale by
the time it was built. Both are corrected in place below.

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

1. ✅ **Schema.** `push_subscriptions(user_id, endpoint, p256dh, auth,
   created_at, updated_at)`, `endpoint` unique. A new `push` app in
   `packages/api/src/apps/push.ts`. Not `family_phone_push_subscriptions` —
   its foreign key is a device, and unpairing a handset must not silence that
   person's deadlines.
2. ✅ **Routes.** `POST /api/v1/push/subscribe` and `/unsubscribe`, authed,
   in `pushSubscriptionRoutes` (`handlers/push.http.ts`). The header comment
   that promised them since v1 now describes what is there.
3. ✅ **Column.** `tasks.reminded_at TEXT`. Cleared when `due_at` is written to
   a *different* value — one `CASE` in the repo's UPDATE, so there is no
   read-modify-write to race against. **It must be added after
   `rebuildTasksStatusIfLegacy`**, which copies the table through a
   hand-written column list; `schema.test.ts` drives that upgrade.
4. ✅ **The tick.** Every 60 s, in the api process
   (`handlers/task-reminders.ts`). ~~select open, non-deleted tasks~~ — **there
   is no `open` status since `74550d3`.** The predicate is *not done*
   (`ListFilter.unfinished`, the same spelling the Today view uses), so **a
   blocked task still reminds**: blocked and overdue is the most useful
   reminder there is. Deadlines are compared through SQLite's `datetime()`, not
   lexicographically — a stored `due_at` may be a date, a Zulu timestamp or an
   offset one, and raw string comparison gets the last two wrong.
5. ✅ **Payload.** `{ kind: 'task', title, body, tag, url }`, confirmed against
   the `serviceWorker` source at `packages/api/src/spa.ts:120-136`. Title is
   the task's own title; `url` deep-links to `/tasks`.
6. ✅ **Web.** A "Remind me" control at the top of the tasks panel, from a real
   tap. It renders nothing on a browser with no PushManager, and a sentence
   rather than a button when the site is blocked.
7. ⬜ **Deploy.** Generate a VAPID pair, set the three `EAL_VAPID_*` values as
   Fly secrets. `docs/deploy.md` now carries the table and the command. **Not
   done — this is the owner's step.**

## Scope held back

Exact-time reminders only, as planned. A morning digest ("everything due today,
at 08:00") needs a per-user timezone, which `docs/tasks-v1.md` already records
as a v1 limitation. Add the column when you want the digest, not before.

No recurrence, no snooze, no lead time ("remind me 30 minutes before").

## Decided while building, not in the plan

- **A failed send still stamps.** Stamping only on success retries a broken
  vendor every 60 s for as long as the row is overdue, and a deadline that
  finally rings forty minutes late is worse than one that did not ring.
- **A task with nobody subscribed still stamps.** Otherwise the day someone
  first taps "Remind me" they are buried under every deadline that passed
  before they did.
- **404 / 410 deletes the subscription.** The vendor is saying it will never
  accept another push; the browser mints a fresh endpoint next time. Any other
  error keeps the row.
- **`reminded_at` is not on the wire.** It is bookkeeping for the scan, not a
  property of the task, and the SPA reconciles against every broadcast.
- **No TLA+ model.** See `OPEN_TASKS.md` — one of its two transitions lives in
  a background loop polly's analyzer cannot read, and a one-sided model would
  claim coverage it does not have.

## Verification artefact

`scripts/e2e-task-reminder.ts`, run by `bun devctl test multi`. Built as
planned, with three corrections found while building it:

- The vendor server must speak **HTTPS**. web-push dials the endpoint's scheme
  and refuses plaintext, so an `http://` endpoint fails the TLS handshake
  rather than testing anything. It reuses `packages/api/certs`, which every
  multi-tier script already requires.
- "Its body carries the task title" is only checkable by **decrypting** it: the
  body is aes128gcm ciphertext (RFC 8188 over RFC 8291). The script holds the
  subscription's private key and decrypts with `node:crypto` — which also
  proves the payload was encrypted to that subscription and signed by the
  configured VAPID identity.
- "The next tick sends nothing" is proved by a **signal, not a sleep**: two
  further tasks are created and waited for, so every push that arrives is
  evidence another scan ran, and the first deadline must appear in none of them.

Non-vacuity, measured: with `markReminded` removed from the scan it fails with
`e2e-task-reminder: FAIL — the first deadline was announced 2 times across 3
pushes: [...]` and exits 1.

## Done when

A task due in two minutes rings your phone with the app closed.

**This has not happened yet, and cannot until step 7 is done.** Everything up
to the vendor is proved; what is unproved is the leg from a real push vendor to
a real handset, which needs the secrets set and a phone in the room.

## Not measured

iOS delivers Web Push only to a PWA added to the home screen, on iOS 16.4 and
later. I have not verified this on your phone. Test it there before counting
the feature as working.
