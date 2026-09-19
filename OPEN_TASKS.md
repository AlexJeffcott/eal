# Open tasks

What is outstanding in this repo, and what "green" currently means.

States: `[ ]` todo · `[>]` doing · `[x]` done · `[~]` dropped · `[!]` blocked.
Keep an item only while it is actionable here. Anything that needs a decision
rather than a commit belongs in `~/projects/TODO.md`.

## What green means

`bun devctl test all` runs four tiers in this order and stops at the first
failure. The pre-push hook runs `devctl check` and then that command; the
pre-commit hook runs `devctl check` and the unit tier only.

| Command | Passing count, 2026-09-19 | Runs in the pre-push sweep |
|---|---|---|
| `bun devctl check` | tsc + 7 lint scripts | yes |
| `bun devctl test unit` | 1519 tests, 114 files; coverage ok, 145 files, 29 exempt | yes |
| `bun devctl test browser` | 113 tests | yes |
| `bun devctl test e2e` | 54 Playwright tests, 2 projects | yes |
| `bun devctl test multi` | 31 `scripts/e2e-*.ts`, each exiting 0 | yes |
| `bun devctl test mutation` | see below — not part of `all` | no |
| `bun devctl verify` | TLC: `tasks` ✓ 2.5s, `pairing` ✓ 1.3s, `auth` ✓ 2.2s — compositional PASS; then the hand-written `TasksConvergence` ✓ 5,991 distinct states, 0 on queue, 1.1s | yes |

All five rows above the mutation row were read in one `bun devctl test all`
sweep on 2026-09-19, on branch `recurring-tasks`, followed by `bun devctl
verify`. The multi tier gained `e2e-offline-shell.ts` (the offline shell and the
worker kill switch), `e2e-offline-capture.ts` (the capture outbox, over a
pre-`client_id` database file) and `e2e-tasks-recurrence.ts` (recurring tasks
across two browsers, over a database file in release v46's shape).

The multi tier now includes `e2e-registration-closed.ts` (the registration
gate), `e2e-tasks-reconnect.ts` (the WS drop and resync),
`e2e-agent-offline.ts` (the assistant-availability signal) and
`e2e-tasks-levels-migration.ts` (the project/epic/task migration, driven over
a real pre-migration database file), `e2e-tasks-status-migration.ts` (the
todo/doing/blocked/done widening, driven over a real pre-migration database
file) and `e2e-tasks-sequential-migration.ts` (the `sequential` column and the
Available answer, driven over the same pre-stage-2 database file and then
through the assistant's own `next_actions` tool over real HTTP). The offline one
drops a live socket from inside the page, so it fails if the reconnect handler is
removed. The levels one fails at the first check if the promote pass is removed.
The status one fails at its first check with `"Redecorate the hall" reads status
open, expected todo — the status rebuild did not run` when
`rebuildTasksStatusIfLegacy` is taken out of `applySchema`. The sequential one
fails with `the sequential column is not on the table after boot — the status
rebuild ate it` when its `ensureColumn` is moved above
`rebuildTasksStatusIfLegacy` — all four checked, not assumed.

It also includes `e2e-task-reminder.ts` (stage 4's due-date reminders, driven
against a local HTTPS server impersonating a push vendor, with the payload
decrypted). With the `reminded_at` stamp removed from the scan it fails with
`the first deadline was announced 2 times across 3 pushes: [...]` — checked,
not assumed.

And `e2e-pstn-live.ts` (the Twilio webhook signature boundary, 6 checks). It
boots the api with `SKIP_TLS=1` and `EAL_ORIGIN` set to a name that is *not*
the address it binds, which is the production shape — the container listens on
a private port and the world reaches it under another name. Its falsifier was
measured on 2026-09-19 by rewriting `publicUrl`
(`handlers/family-phone-twilio.http.ts:97`) to read the request's own host,
which is the defect that would 403 every real inbound call behind Fly:

| Tier, against the broken `publicUrl` | Reading |
|---|---|
| `family-phone-twilio.http.test.ts` | 21 pass, 0 fail |
| `e2e-pstn-inbound.ts` | exit 0 |
| `e2e-pstn-routed.ts` | exit 0 |
| `e2e-pstn-live.ts` | **exit 1** — `signed over the public URL: expected 200, got 403` |

Nothing else in the repo catches it. The mocked PSTN scripts sign over
`api.url`, which `bootApi` also pins `EAL_ORIGIN` to, so both spellings agree
and the check passes for the wrong reason. This is the `~/projects/CLAUDE.md`
failure mode exactly: green across tiers, broken for the user.

Every tier runs with the developer's own `.env` in place and needs no
environment override. Tests take their config explicitly: `createTestApp`
defaults `env` to `{}`, and `bootApi`, the Playwright `webServer` and the
Litestream entrypoint each pin `TWILIO_ENABLED=false`. Keep it that way — do
not add a `[test] preload` to `bunfig.toml`, which was tried and breaks the
polly browser runner.

## Phone-first daily use

The target: a todo app used every day from the phone and the laptop, one
household member for now. Most of the stack is already there. The app is
deployed and healthy at `https://eal.fly.dev`, it installs as a PWA, tasks
carry four views, composable filters, subtasks, assignees, dates and WS
broadcast, and the assistant path runs web chat → WS relay → `eal agent` →
`claude` → `eal mcp` → six task tools.

Seven items stand between that and daily use. Each has a plan under
`docs/plans/`. Sizes are estimates and are not measured.

**01, 02, 03 and 07 are the smallest set that makes both devices usable** —
about 3 to 5 days. **04** is the item that keeps the app in use after that.

01, 02 and 07 are done and deployed as of 2026-08-25. 03 is decided and built;
what remains there is a machine to install it on.

- [x] **01 — Close registration.** Done and deployed 2026-08-25. Registration
      was open to anyone who found the hostname, and `authorize()` grants every
      principal every action on every task (`auth/policy.ts:29`).
      `EAL_INVITE_CODE` now gates it and fails closed when unset
      (`packages/api/src/auth/registration.ts`). `https://eal.fly.dev` answers
      `403 invalid invite code` to an uninvited POST and `200` with the code. →
      `docs/plans/01-close-registration.md`
- [x] **02 — Reconnect and resync the browser WS.** Done 2026-08-25. The
      browser socket had no `close` listener, `$wsState` was written
      `'connected'` once, and `seedSessionData` ran only at boot — a phone that
      suspended its tab silently stopped updating. The client now reconnects
      with backoff, re-subscribes, and the shell re-seeds on every reconnect;
      `visibilitychange` and `online` skip the backoff. Proved by
      `scripts/e2e-tasks-reconnect.ts`, which fails without the fix. →
      `docs/plans/02-ws-reconnect-resync.md`
- [>] **03 — Keep the assistant online.** Decided 2026-08-25: the always-on
      machine at home. The code is built — `agent:status` over the WS, `GET
      /api/v1/agent/status`, a composer that disables itself with the reason
      and recovers on its own, and unit templates in `deploy/`. Proved by
      `scripts/e2e-agent-offline.ts`. **Still open: pick the machine, pair it,
      install the unit, stop it sleeping.** → `docs/plans/03-always-on-agent.md`
- [x] **04 — Due-date reminders. Live 2026-09-06, release v40.** A `push` app
      owning a user-level `push_subscriptions` table, the two
      subscribe/unsubscribe routes `push.http.ts`'s header comment had promised
      since v1, a `tasks.reminded_at` column, a 60-second scan inside the api
      process (`handlers/task-reminders.ts`), and a "Remind me" control in the
      tasks panel. Proved by `scripts/e2e-task-reminder.ts`, which stands up a
      fake push vendor over HTTPS and decrypts the payload it receives.
      **The three `EAL_VAPID_*` secrets were already set** — this file and
      `docs/deploy.md` both said they were not, which was wrong. The real
      blocker was the deploy: v39 dated 25 August predated all six commits, so
      the live api served the VAPID key and answered 404 at
      `/api/v1/push/subscribe`. The production log now reads `[reminders]
      due-date scan every 60000ms`.
      **Still open, and not a code task: confirm on the owner's phone.** iOS
      delivers Web Push only to a PWA added to the home screen, iOS 16.4+, and
      that has never been tested. Tap "Remind me", set a task due in two
      minutes, close the app, watch.
      → `docs/plans/04-due-date-reminders.md`
- [ ] **Ordering the work inside a project.** `sequential` (stage 3) decides
      *whether* a container hands out one step at a time; which step is first is
      `(position, id)`, and `position` is only ever set by insertion order —
      there is no way to reorder the steps of a sequential project short of
      deleting and re-adding them. Same missing coordinate space as the lane
      drag below, and the same fix would serve both.
- [ ] **Reordering inside a board lane.** Deliberately not built with the
      board. `position` is one integer numbered per parent
      (`nextSiblingPosition` in the tasks repo) and a lane cuts across parents,
      so the first child of two projects both hold position 0 and a lane-scoped
      drag has no coordinate space to write into. Lanes sort by
      `(dueAt, position, id)` instead — `packages/web/src/apps/tasks/board.ts`.
      Doing it properly needs either a second position column scoped to the
      lane, or fractional indexing.

- [>] **05 — Recurring tasks.** **Built on branch `recurring-tasks`,
      2026-09-19. Not merged, not deployed.** Four rules (every N days,
      weekdays, weekly on days, monthly on day N), each counted from the due
      date or from completion, as calendar-date arithmetic in `@eal/shared`.
      Completing a recurring row — by the tick box, the board or the assistant
      — spawns one successor dated strictly after the device's `today`, and
      hands it the rule. Unticking removes an untouched successor and returns
      the rule; a touched one stays. A recurring project spawns its subtree
      reset to `todo`. Set from the detail editor or by the assistant
      ("every Tuesday"). Proved by `scripts/e2e-tasks-recurrence.ts` — two
      browsers, a v46-shaped database file migrated on boot, counts read from
      the database — falsified two ways. The plan lists what it got wrong and
      seven defects found on the way.
      **Still open:** merge and deploy — the deploy carries a migration (three
      nullable columns, two partial indexes, NULL on every existing row).
      Complete still needs the server, so a recurring task cannot be ticked
      offline. **Also open, not a code task: tick a recurring task on the
      owner's phone** late in the evening, and read the successor's date.
      → `docs/plans/05-recurring-tasks.md`
- [ ] **The Today view's day ends at UTC midnight** unless the caller sends a
      cutoff (`tasks.shared.ts`, `defaultTodayCutoff`; the client's
      `endOfDayIso`). In Italy that is 01:00 or 02:00 local. Same class of
      defect plan 05 fixed for recurrence with a device-supplied `today`; not
      changed there.
- [>] **06 — Offline shell and capture.** **Both parts are live, release v46,
      2026-09-19T16:23Z.** Read from the deployment: `/sw.js` line 1 is
      `eal-sw-v2-shell`, `/public/sw-kill` answers `0` with `no-store`, the
      machine passes its check, and the boot log shows no migration error.
      Part A, the shell: the worker caches it network-first, `EAL_SW_KILL=1`
      removes it (`docs/deploy.md`), and an offline cold boot opens signed in,
      reads `reconnecting`, and seeds when the server returns —
      `scripts/e2e-offline-shell.ts`.
      Part B, capture: quick-add goes through an IndexedDB outbox, shows as a
      pending row, and is sent until the server's row comes back;
      `tasks.client_id` makes a create that is sent twice one task; a copy of
      the list stands in when the seed gets no response —
      `scripts/e2e-offline-capture.ts`, which fails a response after the server
      has committed and reads every count from the database. The spec is
      hand-written TLA+ (`specs/tla/tasks-convergence/`), now part of
      `bun devctl verify`. The plan lists what it got wrong.
      **Still open:** only quick-add works offline; complete, edit, move and
      delete still need the server. Sign-out discards unsent captures without
      asking. No signed-in request has been made against the live deployment
      since v46 — the phone check below is that reading.
      **Also open, not a code task: confirm on the owner's phone.** Open the
      app once online, set aeroplane mode, close and reopen it, add a task, turn
      the network back on, and count the rows on the laptop. iOS evicts a
      home-screen PWA's caches and IndexedDB on its own schedule, and that has
      never been measured. → `docs/plans/06-offline-capture.md`
- [x] **07 — Prove the tasks surface at 350px.** Done 2026-08-25. The tasks
      panel, the expanded detail, the filter builder and the assistant sheet
      each have a 350px case, and a second Playwright project (`mobile-350`,
      touch, 350×750) runs them on a mobile profile. Nothing overflowed; the
      touch targets did — complete 38×27, expand 209×24, quick-add 64×37, all
      now ≥44px. → `docs/plans/07-mobile-viewport-proof.md`

Each plan names the verification artefact it must commit under `scripts/`,
per the rule in `~/projects/CLAUDE.md`: a green test tier is not proof that a
user-facing feature works.

## Testing

- [ ] **No CI. `.github/` does not exist.** Every tier runs on one machine,
      and only if someone pushes. The coverage policy leans on this: 28 files
      are exempt from the unit threshold because a named e2e or multi script
      covers them (`scripts/coverage.config.ts`), and that claim is only true
      while those scripts actually run. Add a workflow that runs `devctl check`
      and `devctl test all`. The browser and e2e tiers need Chrome, and the
      multi tier needs the Litestream binary.
- [!] **`chat.browser.tsx` flakes.** It intermittently reports nothing:
      `timed out after 60000ms waiting for __pollyReport`. Measured on an idle
      machine at about 1 run in 6 for that file alone, and far more often under
      load — on 2026-08-25 it read **4 failures in 6 consecutive runs**, on a
      machine that had been running browser harnesses all day. Whether that is
      load alone or a change in the bundle is not established. When the file
      does report, every test in it passes (70 of 70).
      `tasks.browser.tsx` ran 3 of 3 clean. In a failing run the page
      emits no console output, no page error and no failed request, so the
      inlined `<script type="module">` never executes. Adding any `console.log`
      to the file makes it pass. It fails at the same rate on polly 0.82.1, so
      no dependency bump caused it. The fix belongs in polly's browser runner
      (`dist/tools/test/src/browser/run.js`): it inlines the whole bundle into
      the page and waits 60 s for an exposed binding, with no retry and no
      diagnostics when the page stays silent. Until then, a browser run that
      fails with only that message is a re-run, not a bug.
- [ ] **Run the whole-suite mutation config once and record the score.** The
      root `stryker.conf.json` and the `handlers-shared` shard were blocked for
      months by the red family-phone baseline. `handlers-shared` now completes
      (94.70%, 302 killed, 0 errors, 4 minutes) and `shared` reads 94.74%. The
      root config has never finished a run. `specs`, `cli-lib` and `web-logic`
      have no current score either. Run `bun devctl test mutation`, then
      `bun mutation:report` for the redundancy and theatre signals.
- [x] **The TLC model checker runs.** Re-run 2026-09-06 with Docker up, after
      stage 3. `tasks` ✓ (7 handlers, 5 ensures, 8 states, 7.4s) and `pairing` ✓
      (2 handlers, 2 ensures, 8 states, 1.8s). Non-interference and
      precondition locality both verified. 93 handlers belong to no subsystem
      and are not checked, which is the documented partition, not a regression.
      `sequential` needed no model change: it is an attribute and a derived
      query, not a state transition, so `tasks-status-machine.ts` is correct as
      it stands. Getting the two verdicts meant dropping the `auth` block for
      that run: `auth` ran first then, and nothing after it was reached. Since
      `c0a7d11` the subsystems are declared cheap-first and `auth` terminates,
      so all three report in one run.

      Re-run again 2026-09-06 after stage 4, same two verdicts (`tasks` ✓ 7.4s,
      `pairing` ✓ 1.7s), and `git diff specs/verification.config.ts` empty
      afterwards. **`reminded_at` is deliberately not modelled.** It is a
      two-state lifecycle per task — unreminded ⇄ reminded — and exactly one of
      its two transitions is an HTTP handler: `PATCH /:id` clears the stamp when
      `due_at` moves. The other, the one that sets it, lives in a background
      loop, and polly's analyzer extracts `requires`/`ensures`/assignments from
      route handlers only — the same reason `ws.state` and `call.state` have
      shadow modules but no subsystem. A machine with one anchorable transition
      would explore a state space that can only ever go one way: it would prove
      nothing while claiming coverage, which is worse than not modelling it.
      The property that matters — one reminder per deadline, across restarts —
      is instead held by the `reminded_at IS NULL` guard on `markReminded`
      (unit-tested), and by `scripts/e2e-task-reminder.ts` watching three
      consecutive scans over a still-overdue task.
- [x] **The `auth` subsystem finishes.** It used to be killed for memory at
      about 5 minutes: 9 handlers over two co-modelled fields
      (`authMachine.phase` × `sessionsMachine.outstanding`) at
      `maxInFlight: 2` reached 9,622,903 distinct states with 8,009,447 still
      queued at depth 6. `c0a7d11` (2026-09-08) made two measured cuts, both in
      the `auth` block of `specs/verification.config.ts`: `POST /cli-pair/start`
      and `POST /cli-pair/poll` are dropped, because each generated
      `UNCHANGED contextStates` with no precondition, and `maxInFlight` drops to
      1, which removes the squared term in the `42 × handlerCount` send
      branching factor. `verification.workers` is 6.

      Measured 2026-09-19 inside the pre-push sweep: `tasks` ✓ 7 handlers,
      5 ensures, 116,032 states, 2.7s; `pairing` ✓ 2 handlers, 2 ensures,
      29,248 states, 1.2s; `auth` ✓ 7 handlers, 7 ensures, 97,600 states,
      2.3s. Non-interference verified, compositional PASS. `devctl verify` is
      the third stage of the pre-push hook and it passed there.
- [x] **`scripts/e2e-pstn-live.ts` is committed.** Written 2026-09-19 and
      green: 6 of 6 checks locally, and the multi tier reads 28 scripts at
      exit 0. The script has two modes. With no arguments it runs in the multi tier against a locally
      booted api. With `--target https://eal.fly.dev` and `TWILIO_AUTH_TOKEN`
      in the environment it probes the deployment, sending no `CallSid`,
      `From` or `To` so a verified signature stops at the field check before
      the rate limiter and the IVR — the probe writes no row. It names three
      statuses: 400 the signature verified, 403 it did not, 404 the trunk is
      not mounted. Live mode has not been run; the deployment has no `TWILIO_*`
      secrets and `fly.toml` has no `TWILIO_ENABLED`.

## Phase 7E — the real PSTN trunk

7A–7D are built and verified against a mocked Twilio. The code for 7E is
committed; none of it has met a real trunk. See `docs/family-phone.md`.

- [ ] Buy the Twilio number and replace the four `TWILIO_*` values on Fly
      (`docs/deploy.md` carries the table). Three are currently placeholders —
      see the measured entry below. On country: the DID's main job is the
      outbound caller ID, because inbound over PSTN is rare (friends and
      family reach the handsets over the VoIP path, which needs no number).
      So it must not be Italian — AGCOM, below. **Settled 2026-09-19: buy
      Estonia Local.** The rate does key on the `From` number's country, so
      the first branch applies — but the figure that framed the choice was
      misread, and the choice is not close.

      Measured against the live Pricing API, destination `+393331234567`
      (`GET pricing.twilio.com/v2/Voice/Numbers/{dest}?OriginationNumber=`).
      `base_price` equals `current_price` in every row, so these are list
      prices, not an account rate:

      | Origin prefix of `From` | $/min to an Italian mobile |
      |---|---|
      | 30–49 EU block, and **44 — the UK is in this tier** | 0.0445 |
      | 1 — US/CA mainland | 0.0476 |
      | `ROW`, and the NANP Caribbean prefixes (1242, 1246, …) | 0.3473 |

      The 7.8× gap is EEA against **rest-of-world**, not EEA against US. A
      US caller ID costs 7% more than an EEA one, not 780% more. `$0.3473`
      is what a caller ID from neither tier pays. The old line also said the
      UK is not EEA: true, and irrelevant here — Twilio puts `44` in the
      cheap tier regardless.

      Origin-based pricing applies to the mobile destination only. An
      Italian *landline* destination is `0.0168/min` from origin `ALL`.

      Estonia **Local**, not Mobile: `$1.00/mo` against US Local's `$1.15`.
      Voice-enabled stock is in hand, `address_requirements: any`, and the
      regulatory bundle asks for `first_name`, `last_name` and one name
      document — no Estonian address, same terms the old line credited to
      Estonia Mobile at three times the price. It is therefore cheaper per
      month *and* cheaper per minute than US Local, so no break-even minute
      count decides it. An Estonian CLI is not Italian, so AGCOM passes.
- [ ] Point the Twilio console webhook at
      `https://eal.fly.dev/api/family-phone/twilio/voice`. `EAL_ORIGIN`
      (`fly.toml:22`) must equal that URL's origin exactly — the api rebuilds
      the signed URL from it. Proved to work end to end below.
- [!] **A trial account cannot carry audio.** Twilio strips `<Stream>` from
      TwiML on trial and substitutes a `<Say>`. The whole 7B/7C path is Media
      Streams, so any real audio test needs the upgrade: a card and a $20
      minimum deposit. Media Streams then bills $0.0044/min on top of call
      minutes. A trial account can still fire the webhook, from a verified
      number only.
- [x] **The `Host` header is not the risk. Corrected 2026-09-19.** This line
      used to say a real inbound call was the only way to learn whether the
      proxy forwards the original `Host`. The api never reads that header:
      `publicUrl` (`handlers/family-phone-twilio.http.ts:97`) rebuilds the
      signed URL from `EAL_ORIGIN` plus the request's own path and query, so a
      proxy that rewrites `Host` cannot break the signature.
      `scripts/e2e-pstn-live.ts` measures it, locally and against the
      deployment. What it does require is that `EAL_ORIGIN` equals the webhook
      URL's origin exactly — `fly.toml:22` reads `https://eal.fly.dev`, and
      the Twilio console must be pointed at that same host.
- [x] **The live deployment verifies the signature. Measured 2026-09-19.**
      `bun scripts/e2e-pstn-live.ts --target https://eal.fly.dev` exits 0:
      a signature computed over `https://eal.fly.dev` is accepted by the
      deployed api and reaches the field check (400), and an unsigned webhook
      is refused (403). **Fly's proxy does not break `X-Twilio-Signature`.**
      That was the one failure the mocks were said not to catch, and it is
      now a reading rather than a worry.

      | Gauge | Before | After |
      |---|---|---|
      | Machine | 44, 2026-09-09 | 45, 2026-09-19T14:40:15Z |
      | `/voice` unsigned | 404 — not mounted | 403 — mounted, verifying |
      | `/voice` signed over the public origin | unknown | 400 — verified |

      **The signed probe cannot be repeated from this machine.** Re-run after
      v46, it answers 403. The probe signs with `TWILIO_AUTH_TOKEN` from the
      local environment, and `.env` holds the trial account's token while Fly
      holds the random placeholder below, which has no copy on this disk. A 403
      to a signature under a different token is the correct answer (the
      script's own case 5), so this is not a regression reading — but it is
      not a pass either. The probe works again when one real token is in both
      places.

      **The three `TWILIO_*` secrets on Fly are random placeholders, not a
      real account.** The SID is `AC` + 16 random bytes, the token 32 random
      bytes, the number `+10000000000`. `twilio/config.ts` validates shape
      only and nothing calls Twilio at boot, so placeholders answer the
      signature question without an account. The token is random rather than
      a fixed string because the four webhook routes are now publicly
      mounted, and a guessable token would let anyone forge a signed request
      at `/voice`. **Replace all three when the real number is bought** —
      outbound (`twilio/rest.ts`) will fail against these until then.

      The probe sends no `CallSid`, `From` or `To`, so a verified signature
      stops at the field check before the rate limiter and the IVR. It writes
      no row to the production database, and can be re-run at any time.
- [ ] **Watch a real inbound call.** What a real call still proves, and the
      script cannot: Twilio's own `CallSid`/`From`/`To` fields, the
      `wss://` media WebSocket opening against the public origin, and audio
      crossing it. `e2e-pstn-inbound.ts` covers that path against a mocked
      Twilio.
- [ ] Set `TWILIO_CALLER_ID` to a non-Italian number if the DID is Italian.
      AGCOM drops internationally-routed calls presenting an Italian caller ID,
      with no whitelist. Inbound is unaffected.
- [ ] Smoke-test outbound separately from inbound. The inbound test does not
      cover the caller ID, which is the half AGCOM breaks.

## Dependencies on hold

Nothing is on hold. All four packages listed here came off it on 2026-09-09.

**`typescript` 7.0.2** needs a second patch, in `patches/`. TS 7 ships the
native compiler, and its npm package exports two names — `version` and
`versionMajorMinor` — so every call into the old JS API throws. Stryker's
`TSConfigPreprocessor` makes two of those calls
(`dist/src/sandbox/ts-config-preprocessor.js`, identical code in 9.6.1 and
10.0.0), and an unpatched mutation run dies there before the dry run. The patch
points both call sites at `typescript-legacy-api`, a devDependency alias for
`typescript@6.0.3` that exists for this one purpose. `tsc` on the CLI stays on
7.0.2. If the alias is ever dropped the import throws `ERR_MODULE_NOT_FOUND`
naming it, which is the intended failure — it does not fall back.

Two readings say the patch changes no behaviour. `cli-lib` under TS 6 and under
TS 7 returned the same numbers to the digit: 436 mutants, 89.12%, 324 killed,
12 timeout, 38 survived, 3 no-coverage, 0 errors. `bun mutation:verify` passes
all six kill-matrix checks under both. Debug logging confirms the preprocessor
runs and parses `tsconfig.json` rather than being skipped.

`tsc --noEmit` is 4.4× faster: 2185ms on 6.0.3, 497ms on 7.0.2.

**Drop the patch when Stryker stops using the TypeScript JS API**, and drop the
`typescript-legacy-api` alias with it. `cosmiconfig@9.0.1` is the only other
package in the tree that reaches for that API, at `dist/loaders.js:76` and
`:105`, and it does so only to load a `.ts` config file. This repo has none, so
the path is never taken. Check that again if one is ever added.

**`preact` 10.29.8 and `@preact/signals` 2.11.2** needed no workaround in the
end. They first went in behind an `overrides` block, because `@fairfox/polly`
up to 0.90.0 declared `preact`, `@preact/signals` and `@preact/signals-core` as
*both* exact hard dependencies and peer dependencies — two fields that mean
opposite things, so a package manager honours both and this repo got polly's
copy nested under polly and its own at the root. That second copy is the `__H`
hook fault recorded here before. polly 0.91.0 fixes it at the source: the three
are devDependencies for polly's own build and peers for consumers, and
`@preact/signals-core` joined the peer list because three shipped files import
it directly. The `overrides` block is gone.

Measured after removing it: the lockfile resolves one version of each, every
symlink under `packages/web` and under polly points at the same store entry,
`tsc` is clean, unit 1316, browser 103/103 with zero `__H` errors.

**`@stryker-mutator/core` 10.0.0** runs against the patched
`stryker-mutator-bun-runner@0.4.0` even though the runner's peer still reads
`^9.0.0` and it pulls its own `@stryker-mutator/api@9.6.1` alongside core's 10.
Two API copies, and the plugin still loads. Measured under 10.0.0: `cli-lib`
436 mutants, 89.12%, 0 errors, 3m25s; `shared` 43 mutants, 90.70%, 0 errors;
`bun mutation:verify` passes all six kill-matrix checks. Scores are a few points
below the Stryker 9 figures recorded above because 10's instrumenter emits more
mutants — `shared` went 38 → 43 — not because kills were lost.

The `stryker-mutator-bun-runner` patch in `patches/` was written against Bun
1.3.x for its JUnit parsing. It holds on Bun 1.4.2 — `bun mutation:verify`
passes all six kill-matrix checks — but re-run that after any Bun bump, or the
redundancy signal dies silently.

Bun 1.4.2 is the floor everywhere as of 2026-09-09: `engines.bun` in
`package.json`, and the `oven/bun:1.4.2` base in `deploy/Dockerfile`. The two
move together — the lockfile is written by the local Bun, and the image installs
it with `--frozen-lockfile`, so an image on an older Bun can fail to read a
lockfile the developer just wrote.

## Running the CLI

There is no `eal` binary. `packages/cli/package.json` declares
`bin: { eal: "src/index.ts" }`, but nothing links it into `node_modules/.bin`,
so every invocation goes through bun and the default api URL is
`https://127.0.0.1:3000` — a command against production must say so:

```sh
bun packages/cli/src/index.ts auth pair --label=agent-$(hostname -s) \
  --api-url https://eal.fly.dev
```

`bun link` inside `packages/cli` installs a real `eal` shim, if bun's global
bin directory is on PATH. The unit templates in `deploy/` call bun with the
full script path, so they work either way.

## This machine

- [ ] **`.env` line 9 is a placeholder: `TWILIO_PHONE_NUMBER=+39...`.** With
      `TWILIO_ENABLED=true` beside it, `bun devctl dev` cannot boot — the E.164
      check fails, loudly and correctly. The test tiers no longer care, because
      they pin their own trunk config. Either set the real number when it is
      bought, or set `TWILIO_ENABLED=false` until then.
- [ ] **Rotate the Twilio auth token and account SID in `.env`.** Both were
      printed into an assistant session transcript on 2026-08-24. The git side
      of this is now measured, 2026-09-19: the SID in those five June test
      files starts `AC0123` and ends `cdef`, a fixture, and `.env` holds a
      different string; a search of every branch for the real SID and for the
      real auth token returns 0 commits each; `.env` is untracked and ignored
      at `.gitignore:37`. The push published no real credential. The transcript
      leak stands on its own, and rotation is still the answer to it.
- [x] **Pushed 2026-09-09, and the repository is public.** `upstream/main` is
      `b5a6bf5`, the same commit as this disk, pushed at 16:38 UTC. The branch
      `polly-control-geometry` is there too, at `c0a7d11`. This disk and the
      deployed image are no longer the only copies.
      `git push upstream main` on 2026-09-06 had been rejected by **GitHub push
      protection, GH013**: it read a Twilio Account String Identifier in five
      commits from 1–2 June — `cf03d26`, `abe4467`, `bb642ce` (all
      `twilio/config.test.ts:10` or `family-phone-twilio.http.test.ts:7`),
      `3d0717c` and `682db29`. All five are test files, and all five carry the
      fixture SID rather than the real one — the rotation item above now holds
      that comparison. By what route the block was cleared is not recorded
      here; only that the push landed.
- [ ] **`EAL_INVITE_CODE` on Fly has no copy in the repo, by design.** It is
      the one string a new device needs, and `fly secrets list` shows only a
      digest. Keep it in a password manager.
