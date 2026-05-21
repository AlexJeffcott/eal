# eal — production container, deployed to Fly.io.
# Build context is the repo root: `docker build -f deploy/Dockerfile .`
#
# The container speaks plain HTTP; Fly's proxy terminates TLS at its edge. The
# image carries the Litestream binary so the entrypoint can restore-on-boot and
# replicate continuously — see deploy/entrypoint.sh.

FROM oven/bun:1.3

WORKDIR /app

# Litestream binary, lifted from its official image. Pinned — and the pin MUST
# match the version used in local dev (the replica format is not compatible
# across the 0.3 / 0.5 lines). Check `litestream version` locally before bumping.
COPY --from=litestream/litestream:0.5.11 /usr/local/bin/litestream /usr/local/bin/litestream

# Dependencies first — this layer is cached unless a manifest or the lockfile
# changes. `packages/` carries both the workspace manifests and the source.
# `--production` omits devDependencies: the container has no need for puppeteer,
# stryker, typescript et al. (Bun runs the .ts server directly), and skipping
# puppeteer also skips its Chrome-download postinstall.
# tsconfig.json is required at runtime: the server builds the SPA via Bun.build
# at boot, which reads `jsxImportSource: "preact"` from it. Without it the build
# falls back to React's JSX runtime and fails to resolve.
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages ./packages
RUN bun install --frozen-lockfile --production

# Deployment scripts + Litestream config.
COPY deploy ./deploy
RUN chmod +x ./deploy/entrypoint.sh

# Litestream restores the DB here on a cold start; the platform config points
# DATABASE_PATH at a file under this directory.
RUN mkdir -p /data

ENTRYPOINT ["./deploy/entrypoint.sh"]
