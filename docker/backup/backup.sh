#!/bin/sh
# Creates a compressed custom-format dump, verifies it is readable and rotates old ones.
set -eu
DIR=/backups
mkdir -p "$DIR/daily" "$DIR/weekly"
STAMP=$(date +%Y%m%d-%H%M%S)
FILE="$DIR/daily/celtist-$STAMP.dump"
pg_dump --format=custom --compress=9 --no-owner --dbname="$DATABASE_URL" --file="$FILE.partial"
pg_restore --list "$FILE.partial" >/dev/null   # a dump that cannot be listed is not a backup
mv "$FILE.partial" "$FILE"
if [ "$(date +%u)" = "7" ]; then cp "$FILE" "$DIR/weekly/celtist-$STAMP.dump"; fi
DAILY_KEEP=$(( ${BACKUP_DAILY_RETENTION:-7} + 1 ))
WEEKLY_KEEP=$(( ${BACKUP_WEEKLY_RETENTION:-4} + 1 ))
ls -1t "$DIR"/daily/*.dump 2>/dev/null | tail -n +"$DAILY_KEEP" | xargs -r rm -f
ls -1t "$DIR"/weekly/*.dump 2>/dev/null | tail -n +"$WEEKLY_KEEP" | xargs -r rm -f
echo "[backup] $(date -Iseconds) wrote $FILE ($(du -h "$FILE" | cut -f1))"
