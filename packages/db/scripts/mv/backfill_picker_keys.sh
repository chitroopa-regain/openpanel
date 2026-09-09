#!/usr/bin/env bash
# One-pass backfill of the picker "keys" views (see picker_keys.sql).
# Idempotent: AggregatingMergeTree merges duplicate keys by max(last_seen).
set -euo pipefail
q() {
  curl -sS --fail-with-body "${CH_URL}/?database=openpanel&max_threads=${THREADS:-4}&max_execution_time=3600&max_bytes_before_external_group_by=2000000000" \
    -H "X-ClickHouse-User: ${CH_USER:-default}" -H "X-ClickHouse-Key: ${CH_PASSWORD}" --data-binary "$1"
}
t() { date -u +%T; }
echo "$(t) trait keys"; q "INSERT INTO profile_trait_keys_local SELECT project_id, key, max(updated_at) FROM profile_traits GROUP BY project_id, key"
echo "$(t) trait values"; q "INSERT INTO profile_trait_values_local SELECT project_id, key, value, max(updated_at) FROM profile_traits WHERE value != '' GROUP BY project_id, key, value"
echo "$(t) event keys (from the values view: key columns only)"; q "INSERT INTO event_property_keys_local SELECT project_id, name, property_key, max(created_at) FROM event_property_values_mv WHERE property_key != '' AND property_key NOT IN ('__duration_from','__properties_from') GROUP BY project_id, name, property_key"
echo "$(t) done"
q "SELECT 'event_property_keys', count(), formatReadableSize(sum(length(property_key))) FROM event_property_keys_local FORMAT TSV"
q "SELECT 'profile_trait_keys', count() FROM profile_trait_keys_local FORMAT TSV"
q "SELECT 'profile_trait_values', count() FROM profile_trait_values_local FORMAT TSV"
