#!/bin/sh
# Usage: restore.sh /backups/daily/celtist-YYYYMMDD-HHMMSS.dump
# Restores INTO the database in DATABASE_URL, replacing its contents. Stop the API first (see docs/DEPLOYMENT.md).
set -eu
[ $# -eq 1 ] || { echo "usage: restore.sh <dump file>"; exit 2; }
[ -f "$1" ] || { echo "file not found: $1"; exit 2; }
pg_restore --list "$1" >/dev/null
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$1"
echo "[restore] done"
