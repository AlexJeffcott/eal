# Plan 01 — Close registration

Status: **code complete, 2026-08-25.** One step remains and it is not a commit:
set `EAL_INVITE_CODE` as a Fly secret and confirm the deployed origin answers
403. Until that runs, `https://eal.fly.dev` is still open to anyone.

What landed:

| Piece | Where |
|---|---|
| The gate: config loader, constant-time compare, global failure throttle | `packages/api/src/auth/registration.ts` (+ 14 unit tests) |
| Enforcement, ahead of every other check | `packages/api/src/handlers/auth.shared.ts` `registerOptionsCore` |
| Explicit config, never `process.env` at the handler | `AuthRoutesContext.registration`, `server-factory.ts` |
| Wire contract, 9 cases | `packages/api/src/handlers/auth.http.test.ts` |
| Invite-code field, friendly errors | `shell/auth/sign-in.tsx`, `shell/actions.ts`, `actions/registry.test.ts` |
| Harnesses configure the gate | `scripts/lib/boot-api.ts` (`E2E_INVITE_CODE`), `playwright.config.ts`, `tests/lib/shell.ts` (`registerPasskey`) |
| A generated code in a fresh `.env`, never a literal | `packages/devctl/commands/setup.ts` |
| Verification artefact | `scripts/e2e-registration-closed.ts` |

Measured after the change: unit 1073 pass (129 files, 27 exempt — `auth.shared.ts`
was promoted out of the exempt list), browser 66 pass, e2e 25 pass,
`e2e-auth-multi` / `e2e-passkey-multi` / `e2e-cli-pair` / `e2e-client-contract`
each exit 0.

## The reading

`https://eal.fly.dev` answers 200 and registration is open to anyone who
loads it.

| Fact | Evidence |
|---|---|
| `POST /public/auth/register/options` accepts a display name and nothing else | `packages/api/src/handlers/auth.shared.ts:41` |
| `register/verify` mints a session for the new user | `packages/api/src/handlers/auth.shared.ts:51` |
| Any signed-in principal may view, edit and delete **every** task | `packages/api/src/auth/policy.ts:29` |
| The origin is public and healthy | `curl https://eal.fly.dev/public/health` → `{"status":"ok"}` |

A stranger who finds the hostname can create an account and read and write
the household's tasks.

## Decision

Gate registration behind an invite code held in an environment variable.

- No code configured → registration is **closed**: `/register/options` and
  `/register/verify` return 403. Fail closed, per the project's no-fallback
  rule.
- Code configured → the client must present it.

Rejected: a "first user only" cap. It closes the hole but leaves no way to add
Elisa's phone later without a redeploy.

Login is untouched. Existing credentials keep working.

## Steps

1. **`packages/api/src/auth/registration.ts`** — `loadRegistrationConfig(env)`
   reads `EAL_INVITE_CODE`. Returns `{ inviteCode: string | null }`. Throws at
   boot when the value is set but shorter than 16 characters, so a guessable
   code cannot ship.
2. **Thread it explicitly.** `AuthRoutesContext`
   (`packages/api/src/handlers/auth.http.ts:43`) gains `registration`.
   `server-factory.ts:198` builds it from `options.env ?? process.env`
   (`server-factory.ts:211`) — the same path apps use, so a developer's `.env`
   cannot decide whether the gate is on in a test.
3. **`registerOptionsCore`** throws `AuthError(403, 'registration is closed')`
   when no code is configured, and `AuthError(403, 'invalid invite code')` on a
   mismatch. Compare with a constant-time comparison, not `===`.
4. **Wire shape.** `/register/options` body becomes
   `{ displayName: string, inviteCode: string }`. Gating `options` is enough on
   paper — `verify` needs a challenge that only `options` issues — but assert
   that in a test rather than assuming it.
5. **Rate-limit register attempts per source IP.** Copy the shape of
   `packages/api/src/handlers/family-phone-pstn-rate-limit.ts`.
6. **Web.** Add the invite-code field to the register path of
   `packages/web/src/shell/auth/sign-in.tsx`. CSS classes with polly tokens; no
   inline styles.
7. **Deploy.** `fly secrets set EAL_INVITE_CODE=…`. Add the row to the table in
   `docs/deploy.md`.

## Tests

| Tier | What it asserts |
|---|---|
| unit — `auth.shared.test.ts` | 403 with no code configured; 403 on mismatch; success on match |
| unit — `auth.http.test.ts` | the wire envelope for both 403s; `verify` alone cannot mint a session |
| e2e — `packages/e2e-tests/tests/auth.spec.ts` | the register form carries the field and a wrong code shows the friendly error |

## Verification artefact

`scripts/e2e-registration-closed.ts`, run by `bun devctl test multi`. It boots a
real server over HTTPS with no `EAL_INVITE_CODE`, asserts 403 from
`/register/options`, then reboots with the variable set and asserts a complete
registration.

After deploying, one command must read 403:

```sh
curl -si -X POST https://eal.fly.dev/public/auth/register/options \
  -H 'content-type: application/json' -d '{"displayName":"probe"}' | head -1
```

## Done when

The curl above reads `HTTP/2 403`, and you can still register a new device with
the code in hand.

## Not measured

I have not read the deployed database. Before shipping, list the users on the
live instance and confirm no stranger already holds an account.
