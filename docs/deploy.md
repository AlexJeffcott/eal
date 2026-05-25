# Deploying eal

eal ships as one container, deployed to **Fly.io** via `fly.toml`, building
`deploy/Dockerfile`.

## How it works

- **One container.** `deploy/Dockerfile` — `oven/bun` base, with the Litestream
  binary copied in.
- **Ephemeral disk, durable data.** There is no volume. `deploy/entrypoint.sh`
  runs `litestream restore` on every cold start (rehydrating the SQLite file
  from object storage) and then `litestream replicate -exec` (streaming changes
  out while the server runs). A redeploy or a crash loses nothing.
- **TLS at the edge.** Fly terminates HTTPS at its proxy and forwards plain HTTP
  to the container, so the container runs `SKIP_TLS=1`. The public endpoint is
  still HTTPS/WSS.
- **The local mirror.** `bun devctl dev --litestream` runs the *same* entrypoint
  against a local file replica — the cold-start restore path is exercised in
  development, not first discovered in production. `scripts/e2e-litestream-restore.ts`
  proves it: it boots, writes, deletes the DB, reboots, and asserts the data
  came back.

## Required configuration

Every value is required — the server has no fallbacks and fails loud at boot.

| Variable | Secret? | Example | Notes |
|---|---|---|---|
| `PORT` | no | `8080` | Internal listen port. Set in `fly.toml` `[env]`. |
| `DATABASE_PATH` | no | `/data/eal.db` | SQLite file path inside the container. |
| `EAL_ORIGIN` | no | `https://eal.fly.dev` | Public origin. The WebAuthn RP ID is its hostname. |
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

## Fly.io

1. `fly launch --no-deploy` — accept `fly.toml`; it sets `app` and the region.
2. Create a Tigris bucket: `fly storage create`. It prints the bucket name,
   endpoint, and keys.
3. Set the Litestream config as secrets:
   ```sh
   fly secrets set \
     LITESTREAM_BUCKET=… LITESTREAM_PATH=db \
     LITESTREAM_ENDPOINT=… LITESTREAM_REGION=auto \
     LITESTREAM_ACCESS_KEY_ID=… LITESTREAM_SECRET_ACCESS_KEY=…
   ```
4. Edit `EAL_ORIGIN` in `fly.toml` to your real hostname (`https://<app>.fly.dev`
   or a custom domain).
5. `fly deploy`. Fly health-checks `/public/health` before routing.

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
