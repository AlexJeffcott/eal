# Deploying eal

eal ships as one container, deployed to **Fly.io** via `fly.toml`, building
`deploy/Dockerfile`.

## How it works

- **One container.** `deploy/Dockerfile` — `oven/bun` base, with the Litestream
  binary copied in.
- **A volume, and Litestream on top of it.** Both, not one. `fly.toml`
  `[mounts]` attaches the 1GB volume `eal_data` at `/data`, which survives
  redeploys and machine restarts but not the machine being deleted (region
  migration, manual destroy). `deploy/entrypoint.sh` then runs `litestream
  restore` **only when the SQLite file is absent** — it logs `/data/eal.db
  present — skipping restore` otherwise — and always runs `litestream replicate
  -exec`, streaming changes to object storage while the server runs. So a
  redeploy is served by the volume, and the object-storage replica is what
  covers the case the volume cannot: a machine that no longer exists.
- **TLS at the edge.** Fly terminates HTTPS at its proxy and forwards plain HTTP
  to the container, so the container runs `SKIP_TLS=1`. The public endpoint is
  still HTTPS/WSS.
- **The local mirror.** `bun devctl dev --litestream` runs the *same* entrypoint
  against a local file replica — the cold-start restore path is exercised in
  development, not first discovered in production. `scripts/e2e-litestream-restore.ts`
  proves it: it boots, writes, deletes the DB, reboots, and asserts the data
  came back. This matters more than it looks: with the volume in place the
  restore path almost never runs in production, so development is the only
  place it is routinely exercised.

## Required configuration

Every value is required — the server has no fallbacks and fails loud at boot.

| Variable | Secret? | Example | Notes |
|---|---|---|---|
| `PORT` | no | `8080` | Internal listen port. Set in `fly.toml` `[env]`. |
| `DATABASE_PATH` | no | `/data/eal.db` | SQLite file path inside the container. |
| `EAL_ORIGIN` | no | `https://eal.fly.dev` | Public origin. The WebAuthn RP ID is its hostname. |
| `EAL_INVITE_CODE` | **yes** | — | The registration gate. **Unset closes registration entirely** — the deployed origin is public, and any account can read and write every task. Minimum 16 characters; the api refuses to boot with a shorter one. Login is unaffected. |
| `SKIP_TLS` | no | `1` | Required: Fly's proxy terminates TLS. |
| `LITESTREAM_CONFIG` | no | `deploy/litestream.yml` | Always the production (S3) config. |
| `LITESTREAM_BUCKET` | no | `eal-prod` | Replica bucket. |
| `LITESTREAM_PATH` | no | `db` | Key prefix within the bucket. |
| `LITESTREAM_ENDPOINT` | no | `https://…t3.storage.dev` | S3 endpoint (Tigris). |
| `LITESTREAM_REGION` | no | `auto` | Region. |
| `LITESTREAM_ACCESS_KEY_ID` | **yes** | — | Object-storage key. |
| `LITESTREAM_SECRET_ACCESS_KEY` | **yes** | — | Object-storage secret. |

The replica config (`deploy/litestream.yml`) is plain S3 driven by these env
vars — Fly's **Tigris** is the natural fit, but any S3-compatible store works.

### Web Push (due-date reminders)

Due-date reminders are **off by default**. The 60-second scan that fires them
runs inside the api process and starts only when all three VAPID values are
set; with none of them set it logs that reminders are off and starts nothing,
and with only some of them set the api **fails to boot** — there is no
half-configured push identity (`loadPushVapidConfig`,
`packages/api/src/handlers/push.http.ts`).

Subscriptions are accepted either way, so a browser that has already tapped
"Remind me" starts being delivered to as soon as the keys are set. Nothing
needs re-tapping.

| Variable | Secret? | Example | Notes |
|---|---|---|---|
| `EAL_VAPID_PUBLIC_KEY` | no | `BJ…` (87 chars) | The application server key the SPA binds its subscription to. Served to any client at `/public/push/vapid-public-key`; it is public by design. |
| `EAL_VAPID_PRIVATE_KEY` | **yes** | — | Signs every push. Anyone holding it can push to every subscribed browser. |
| `EAL_VAPID_SUBJECT` | no | `mailto:you@example.com` | Contact the push vendor can reach. Must start with `mailto:` or `https://`; the api refuses to boot otherwise. |
| `EAL_REMINDER_TICK_MS` | no | — | **Do not set in production.** The scan's cadence, defaulting to 60000. It exists so `scripts/e2e-task-reminder.ts` can watch several passes in a few seconds. Set to anything but a positive integer, the api fails to boot. |

Generate the pair with the `web-push` CLI that ships inside `packages/api`:

```sh
bun packages/api/node_modules/.bin/web-push generate-vapid-keys
fly secrets set EAL_VAPID_PRIVATE_KEY=… EAL_VAPID_PUBLIC_KEY=… \
  EAL_VAPID_SUBJECT=mailto:you@example.com
```

**Set and live since release v40, 2026-09-06.** All three secrets read
`Deployed` in `fly secrets list -a eal`, and the production log carries
`[reminders] due-date scan every 60000ms`.

They were already set before the reminder code shipped — this page said they
were not, which was wrong and would have sent the next reader to generate a
replacement pair. **Do not regenerate them.** A new public key invalidates every
`PushSubscription` a browser has already bound to the old one: those endpoints
keep accepting pushes signed by the old private key and reject the new
signature, so every phone silently stops being reminded until it re-subscribes.
Rotate only to revoke a leaked private key, and expect to re-tap "Remind me" on
every device afterwards.

**iOS caveat, not measured.** iOS delivers Web Push only to a PWA that has been
added to the home screen, on iOS 16.4 and later. That has not been verified on
the owner's phone. Test it there before counting reminders as working.

### Twilio PSTN trunk (Phase 7)

The family-phone PSTN trunk is **off by default**. It mounts only when
`TWILIO_ENABLED=true`; with the flag unset or `false`, the Twilio handlers
do not register and the rest of eal boots unchanged. When the flag is `true`,
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_PHONE_NUMBER` all become
required — `loadTwilioConfig()` fails loud at boot if any is missing or
malformed (no half-configured trunk). `TWILIO_CALLER_ID` stays optional and
defaults to the trunk DID.

| Variable | Secret? | Example | Notes |
|---|---|---|---|
| `TWILIO_ENABLED` | no | `true` | Mounts the PSTN trunk. Unset/`false` = off; when `true` the three required vars below must be set. Set in `fly.toml` `[env]`. |
| `TWILIO_ACCOUNT_SID` | **yes** | `AC…` | REST account SID (the `AC…`-prefixed 34-char id, pairs with the token). |
| `TWILIO_AUTH_TOKEN` | **yes** | — | Auth token; also the key that verifies the `X-Twilio-Signature` webhook header. |
| `TWILIO_PHONE_NUMBER` | no | `+39…` | E.164 trunk number — the inbound DID, and the default outbound caller ID. Not secret (it's a published number), but set via `fly secrets` alongside the pair for simplicity. |
| `TWILIO_CALLER_ID` | no | `+44…` | Optional outbound caller ID (Twilio `From`). Defaults to `TWILIO_PHONE_NUMBER`. Set to a **non-Italian** number when the DID is Italian: AGCOM blocks internationally-routed calls bearing an Italian CLI (see `docs/family-phone.md` Phase 7). |

Secrets go via `fly secrets set TWILIO_AUTH_TOKEN=… TWILIO_ACCOUNT_SID=…`,
never in `fly.toml` (which is committed). Locally they live in the gitignored
`.env`, which Bun auto-loads.

## Fly.io

1. `fly launch --no-deploy` — accept `fly.toml`; it sets `app` and the region.
2. Create a Tigris bucket: `fly storage create -a <app> -n <bucket>`. Fly
   sets `BUCKET_NAME` + `AWS_ENDPOINT_URL_S3` + `AWS_REGION` +
   `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` as secrets on the app.
   `deploy/litestream.yml` reads them directly — no `fly secrets set` for
   Litestream needed.
3. Set the registration gate:
   `fly secrets set EAL_INVITE_CODE=$(openssl rand -base64 24)`. Without it the
   deploy boots with registration closed, and nobody — including you — can add
   a device. Read the value back with `fly secrets list` (digest only) or keep
   your own copy; it is the one string a new phone needs.
4. Edit `EAL_ORIGIN` in `fly.toml` to your real hostname (`https://<app>.fly.dev`
   or a custom domain).
5. `fly deploy`. Fly health-checks `/public/health` before routing.
6. Confirm the door is shut to a stranger — one command, and it must read 403:

   ```sh
   curl -si -X POST https://<app>.fly.dev/public/auth/register/options \
     -H 'content-type: application/json' -d '{"displayName":"probe"}' | head -1
   ```

## Verifying before you deploy

```sh
bun devctl dev --litestream            # run the prod entrypoint against a local replica
bun scripts/e2e-litestream-restore.ts  # prove restore-on-cold-start end-to-end
```

## Push-time gates

The `pre-push` hook (installed by `bun devctl install-hooks`) runs the full
sweep before every push:

```
[pre-push] devctl check        # tsc + lint scripts
[pre-push] devctl test all     # unit, browser, e2e, multi
[pre-push] devctl verify       # polly TLC model-checking (requires Docker)
```

`devctl verify` needs Docker Desktop running — TLC is invoked through a
container under the hood. If Docker is not running the push fails with a
clear message; start Docker and retry. The verify step covers the shadow
state machines under `packages/api/src/specs/` (auth, ws, sessions,
task-status, auth-gate); a spec failure is the first signal that a refactor
broke the invariants the model encodes.

## Bumping Litestream

The Litestream version in `deploy/Dockerfile` **must match** the version used
locally (`litestream version`) — the replica format is not compatible across the
0.3 / 0.5 lines. Bump the Dockerfile pin and your local install together.
