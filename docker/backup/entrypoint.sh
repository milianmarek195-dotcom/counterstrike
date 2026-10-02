#!/bin/sh
set -e
# Daily dump at 03:15 container time; backup.sh also keeps a weekly copy on Sundays.
echo "15 3 * * * /usr/local/bin/backup.sh >> /var/log/backup.log 2>&1" > /etc/crontabs/root
touch /var/log/backup.log
crond -b -l 8
echo "[backup] scheduler started (daily 03:15, keep ${BACKUP_DAILY_RETENTION:-7} daily / ${BACKUP_WEEKLY_RETENTION:-4} weekly)"
exec tail -F /var/log/backup.log
