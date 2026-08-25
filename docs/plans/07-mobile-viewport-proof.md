# Plan 07 — Prove the tasks surface at 350px

Status: **done, 2026-08-25.**

Measured, then fixed, then measured again:

| Reading | Before | After |
|---|---|---|
| Horizontal overflow, task list at 350px | not measured | 0px |
| Horizontal overflow, expanded detail | not measured | 0px |
| Horizontal overflow, filter builder, 2 conditions | not measured | 0px |
| Horizontal overflow, assistant sheet | not measured | 0px |
| Complete control | 38 × 27 px | ≥ 44 × 44 px |
| Expand control | 209 × 24 px | ≥ 209 × 44 px |
| Quick-add submit | 64 × 37 px | ≥ 64 × 44 px |
| Playwright projects | 1 (Desktop Chrome) | 2 (+ `mobile-350`, touch, 350×750) |
| e2e tier | 24 tests | 38 tests |

The panels already fitted; nothing overflowed at 350px. The touch targets did
not: every one of the three controls a thumb hits was short in the block axis,
so a tick aimed at the checkbox landed on the row and opened the task instead.
The fix is one rule block at the end of `packages/web/src/apps/tasks/tasks.css`,
unconditional rather than behind `pointer: coarse` — 44px is a reasonable
desktop size too, and a media query would make the desktop project fail the
same test.

`mobile-350` is Chromium-based (`devices['Pixel 5']` narrowed to 350px), not
WebKit: the WebKit profiles cannot drive the CDP virtual authenticator that
every signed-in spec needs. It is scoped by `grep: /350px|floor/`, so the whole
suite does not run twice.

## The reading

350px is eal's hard floor. Three panels are measured against it. The two you
will use every day are not.

| Surface | 350px case |
|---|---|
| Showcase | `packages/e2e-tests/tests/showcase.spec.ts:31` |
| Family phone | `packages/e2e-tests/tests/family-phone.spec.ts:41` |
| PSTN contacts | `packages/e2e-tests/tests/pstn-contacts.spec.ts:32` |
| **Tasks** | **none** — `packages/e2e-tests/tests/tasks.spec.ts` |
| **Chat sheet** | **none** |

Playwright runs one project, `devices['Desktop Chrome']`
(`packages/e2e-tests/playwright.config.ts:58`). Nothing exercises touch targets
or the safe-area inset.

The gauge is blank. That is not the same as green.

## Steps

1. **Four cases in `tasks.spec.ts`**, each at 350 × 900, each asserting
   `document.documentElement.scrollWidth - clientWidth <= 0`:
   - the task list;
   - a task with its inline detail editor expanded — date inputs and the
     assignee select are the likeliest overflow;
   - the filter builder with two conditions added;
   - the chat sheet open over the tasks panel.
2. **Fix what overflows** in `packages/web/src/apps/tasks/tasks.css` and
   `packages/web/src/shell/shell.css`. CSS classes with polly tokens. No inline
   styles, including shared style constants.
3. **Add a real mobile project** to `playwright.config.ts` — `devices['iPhone
   SE']` — so touch emulation and `viewport-fit=cover` are exercised, not just
   a narrowed desktop window. Run the tasks and chat cases under both projects.
4. **Check the tap targets** while you are there: 44 × 44 CSS pixels is the
   floor for the row checkbox, the expand control and the quick-add submit.

## Verification artefact

The e2e tier itself. `bun devctl test e2e` covers the four cases above under
both projects, and the count in `OPEN_TASKS.md` moves from 24 to 32.

## Done when

Every case passes at 350px in both projects, and the tasks panel is on the same
footing as the showcase.
