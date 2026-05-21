#!/bin/sh
# eal container entrypoint — the restore-then-replicate choreography.
#
# This exact script runs in production AND in the local mirror (`devctl dev
# --litestream`). The only difference between the two is LITESTREAM_CONFIG:
# production points it at an S3 replica, the local mirror at a file replica.
# Same boot sequence either way — which is the point: dev exercises the
# restore-on-cold-start path that production depends on.
#
# Required env (no fallbacks — fail loud if absent):
#   DATABASE_PATH      where the SQLite file lives
#   LITESTREAM_CONFIG  path to the Litestream config file
set -eu

echo "entrypoint: DATABASE_PATH=$DATABASE_PATH LITESTREAM_CONFIG=$LITESTREAM_CONFIG"

# Cold start (ephemeral disk, or the local mirror after a wipe): the DB file is
# absent, so rehydrate it from the replica. `-if-replica-exists` makes the very
# first ever boot — empty replica — a clean no-op rather than an error.
if [ ! -f "$DATABASE_PATH" ]; then
  echo "entrypoint: $DATABASE_PATH absent — restoring from replica"
  litestream restore -if-replica-exists -config "$LITESTREAM_CONFIG" "$DATABASE_PATH"
else
  echo "entrypoint: $DATABASE_PATH present — skipping restore"
fi

# Run the server as Litestream's child: Litestream replicates the DB
# continuously and does a final sync when the server exits.
exec litestream replicate -config "$LITESTREAM_CONFIG" -exec "bun packages/api/src/server.ts"
