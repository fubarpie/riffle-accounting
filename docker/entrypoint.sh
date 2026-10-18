#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Select the process to run from $MODE. `exec` makes node PID 1 of the
# container process tree so it receives SIGTERM from `docker stop`.
set -eu

# Later phases will run database migrations here when RUN_MIGRATIONS=true.

case "${MODE:-api}" in
  api)    exec node apps/api/dist/main.js ;;
  worker) exec node apps/worker/dist/main.js ;;
  *)
    echo "riffle-entrypoint: unknown MODE '${MODE}' (expected api or worker)" >&2
    exit 64
    ;;
esac
