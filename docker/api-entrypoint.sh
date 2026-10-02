#!/bin/sh
set -e
# Apply pending migrations before the API starts. Only one instance should run migrations (RUN_MIGRATIONS=true).
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[entrypoint] applying database migrations"
  npm run migrate:deploy -w @celtist/database
fi
exec node apps/api/dist/main.js
