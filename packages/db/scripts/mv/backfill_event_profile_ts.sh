#!/usr/bin/env bash
# Backfill openpanel.event_profile_ts_local from openpanel.events, one
# (project, UTC day) at a time, NEWEST DAY FIRST, so the exact view's
# coverage grows backwards from today and short-range reports flip to it
# early. Resumable through openpanel.event_profile_ts_backfill (one row per
# finished project/day) — the target table itself cannot tell backfilled rows
# from live-fed late arrivals, so "already has rows" is not a valid skip test.
# Overlap with the live feed produces duplicate timestamps at most; readers
# apply arrayDistinct, so it is harmless.
#
# Cost measured 2026-09-09 (4 threads): regain-app ~54 s/day, brainrot-app
# ~16 s/day, 2.1 GiB peak memory. Run with THREADS=2 during the day.
#
# Usage:
#   CH_URL=http://host:8123 CH_USER=default CH_PASSWORD=… \
#     ./backfill_event_profile_ts.sh <project_id> <oldest_day YYYY-MM-DD> [<newest_day YYYY-MM-DD>]
# Env: THREADS (default 2), MV_CREATED_AT ("YYYY-MM-DD HH:MM:SS" UTC) — the
#      day the live view was created is backfilled only up to that instant.
set -euo pipefail

PROJECT=${1:?project_id}
OLDEST=${2:?oldest day YYYY-MM-DD}
NEWEST=${3:-$(date -u -d 'yesterday' +%F)}
THREADS=${THREADS:-2}
MV_CREATED_AT=${MV_CREATED_AT:-}
LOG=${LOG:-/tmp/backfill_event_profile_ts_${PROJECT}.log}

q() {
  curl -sS --fail-with-body "${CH_URL}/?database=openpanel&max_threads=${THREADS}&max_execution_time=1800&max_bytes_before_external_group_by=2000000000" \
    -H "X-ClickHouse-User: ${CH_USER:-default}" -H "X-ClickHouse-Key: ${CH_PASSWORD}" \
    --data-binary "$1"
}

q "CREATE TABLE IF NOT EXISTS event_profile_ts_backfill (project_id String, day Date, rows UInt64, done_at DateTime) ENGINE = ReplicatedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}') ORDER BY (project_id, day)"

day="$NEWEST"
while [[ "$day" > "$OLDEST" || "$day" == "$OLDEST" ]]; do
  done_already=$(q "SELECT count() FROM event_profile_ts_backfill WHERE project_id = '${PROJECT}' AND day = toDate('${day}')")
  if [[ "$done_already" != "0" ]]; then
    echo "$(date -u +%T) skip $PROJECT $day (logged as done)" | tee -a "$LOG"
  else
    upper="toDateTime('${day} 00:00:00', 'UTC') + INTERVAL 1 DAY"
    if [[ -n "$MV_CREATED_AT" && "$day" == "${MV_CREATED_AT:0:10}" ]]; then
      upper="toDateTime('${MV_CREATED_AT}', 'UTC')"
    fi
    start=$(date +%s)
    q "INSERT INTO event_profile_ts_local (project_id, name, profile_id, day, app_version, country, ts_identified)
       SELECT project_id, name, profile_id, toDate(created_at) AS day, app_version, country,
              groupArrayIf(created_at, profile_id != device_id) AS ts_identified
       FROM events
       WHERE project_id = '${PROJECT}'
         AND created_at >= toDateTime('${day} 00:00:00', 'UTC')
         AND created_at < ${upper}
       GROUP BY project_id, name, profile_id, day, app_version, country"
    rows=$(q "SELECT count() FROM event_profile_ts_local WHERE project_id = '${PROJECT}' AND day = toDate('${day}')")
    q "INSERT INTO event_profile_ts_backfill (project_id, day, rows, done_at) VALUES ('${PROJECT}', toDate('${day}'), ${rows}, now())"
    echo "$(date -u +%T) done $PROJECT $day rows=${rows} in $(( $(date +%s) - start ))s" | tee -a "$LOG"
  fi
  day=$(date -u -d "$day - 1 day" +%F)
done
echo "$(date -u +%T) backfill complete for $PROJECT ($OLDEST..$NEWEST)" | tee -a "$LOG"
