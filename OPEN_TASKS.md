# Open tasks

What is outstanding in this repo, and what "green" currently means.

States: `[ ]` todo · `[>]` doing · `[x]` done · `[~]` dropped · `[!]` blocked.
Keep an item only while it is actionable here. Anything that needs a decision
rather than a commit belongs in `~/projects/TODO.md`.

## What green means

`bun devctl test all` runs four tiers in this order and stops at the first
failure. The pre-push hook runs `devctl check` and then that command; the
pre-commit hook runs `devctl check` and the unit tier only.

| Command | Passing count, 2026-09-06 | Runs in the pre-push sweep |
|---|---|---|
| `bun devctl check` | tsc + 7 lint scripts | yes |
| `bun devctl test unit` | 1251 tests, 103 files; coverage ok, 133 files, 27 exempt | yes |
| `bun devctl test browser` | 96 tests | yes |
| `bun devctl test e2e` | 50 Playwright tests, 2 projects | yes |
| `bun devctl test multi` | 24 `scripts/e2e-*.ts`, each exiting 0 | yes |
| `bun devctl test mutation` | see below — not part of `all` | no |
| `bun devctl verify` | TLC: `tasks` ✓ 7.4s, `pairing` ✓ 1.8s, **`auth` never finishes** — see below | no |

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
- [ ] **04 — Due-date reminders.** Push is configured
      (`handlers/push.http.ts:36`) but the only sender is the missed-call wake
      path, subscriptions are stored against a family-phone device
      (`apps/family-phone.ts:112`), and `due_at` triggers nothing. Needs a
      user-level subscription table, the two subscribe routes that
      `push.http.ts`'s own header comment already promises, and a 60-second
      scan in the api process. → `docs/plans/04-due-date-reminders.md` ·
      ~2–3 days
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

- [ ] **05 — Recurring tasks.** No recurrence column, route field or control.
      Deferred deliberately at v1 (`docs/tasks-v1.md`). A small fixed rule set
      with a `basis: 'due' | 'completed'` anchor, not RFC 5545. →
      `docs/plans/05-recurring-tasks.md` · ~2–4 days
- [ ] **06 — Offline shell and capture.** The service worker caches nothing by
      explicit decision (`spa.ts`, `serviceWorker` source), so no signal means a
      blank page and no capture. Network-first precache with a kill switch,
      then an IndexedDB outbox. → `docs/plans/06-offline-capture.md` ·
      ~3–5 days
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
      it stands. Getting the two verdicts means dropping the `auth` block below
      for the run — with it in place, `auth` runs first and nothing after it is
      reached.
- [!] **The `auth` subsystem does not finish.** Two runs, 2245s and 1580s of
      TLC wall time, neither reaching a verdict; both were killed, and the
      `✗ auth` line in the report is that kill, not a violated invariant. It
      models nine handlers over two co-modelled fields (`authMachine.phase` ×
      `sessionsMachine.outstanding`) at `maxInFlight: 2`, and 2 messages in
      flight across 9 handlers is where the blow-up is. Java gets roughly a
      quarter of a core inside the container and TLC runs `-workers 1`.
      Nothing about it is specific to the tasks work — the `auth` block of
      `specs/verification.config.ts` is untouched since before `0c34d83`.
      Fix by dropping `auth` to `maxInFlight: 1`, splitting it in two, or
      raising the worker count. **Until then `devctl verify` exits non-zero on
      `auth` alone and cannot join any sweep.**
- [ ] **Commit `scripts/e2e-pstn-live.ts`.** Every other user-facing path has a
      committed verification artefact that runs in one command. The live Twilio
      trunk does not — see Phase 7E below.

## Phase 7E — the real PSTN trunk

7A–7D are built and verified against a mocked Twilio. The code for 7E is
committed; none of it has met a real trunk. See `docs/family-phone.md`.

- [ ] Buy the Twilio number and set the four `TWILIO_*` values as Fly secrets
      (`docs/deploy.md` carries the table).
- [ ] Point the Twilio console webhook at the public URL, and set `EAL_ORIGIN`
      to exactly that URL. Twilio signs the URL it was configured with; the api
      rebuilds it from `EAL_ORIGIN` to verify the signature.
- [ ] **Watch a real inbound call for a 403 on `/voice`.** This is the one
      failure the mocks cannot catch: whether the chosen proxy (Fly, or the
      Tailscale Funnel) forwards the original `Host` header, so the
      reconstructed URL matches what Twilio hashed.
- [ ] Set `TWILIO_CALLER_ID` to a non-Italian number if the DID is Italian.
      AGCOM drops internationally-routed calls presenting an Italian caller ID,
      with no whitelist. Inbound is unaffected.
- [ ] Smoke-test outbound separately from inbound. The inbound test does not
      cover the caller ID, which is the half AGCOM breaks.

## Dependencies on hold

Four packages cannot move yet. Each blocker is measured, not assumed.

| Package | Held at | Unblocks when |
|---|---|---|
| `typescript` | 6.0.3 | Stryker stops calling `ts.parseConfigFileTextToJson`, which TS 7 removed. A mutation run dies at once under 7.0.2, at both Stryker 9.6.1 and 10.0.0. `tsc` itself is clean under 7. |
| `@stryker-mutator/core` | 9.6.1 | The same TS 7 fix lands, and `stryker-mutator-bun-runner` publishes a version whose peer is not `^9.0.0`. |
| `preact` | 10.29.1 | polly stops pinning exact `preact@10.29.1`. A second copy breaks hooks: the browser tier fell to 2 passed / 64 failed with `Cannot read properties of undefined (reading '__H')`. |
| `@preact/signals` | 2.9.0 | polly stops pinning exact `@preact/signals@2.9.0`. Same fault. |

The `stryker-mutator-bun-runner` patch in `patches/` is pinned to Bun 1.3.x for
its JUnit parsing. It still holds on Bun 1.4.0 — `bun mutation:verify` passes
all six kill-matrix checks — but re-run that after any Bun bump, or the
redundancy signal dies silently.

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
      printed into an assistant session transcript on 2026-08-24.
- [!] **Nothing has ever been pushed.** `git ls-remote --heads upstream`
      returns no refs, so `https://github.com/AlexJeffcott/eal.git` is empty
      and this disk holds the only copy of every commit. `main` has no
      upstream configured either, so a bare `git push` fails. The first push
      is `git push -u upstream main`.
- [ ] **`EAL_INVITE_CODE` on Fly has no copy in the repo, by design.** It is
      the one string a new device needs, and `fly secrets list` shows only a
      digest. Keep it in a password manager.
