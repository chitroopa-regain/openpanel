-- Small "keys" views that back the report-builder pickers.
--
-- Why: chart.properties listed event-property keys by grouping the
-- event_property_values_mv inner table (4.9B rows / 176 GiB on prod) —
-- 77-129 s unfiltered, 8-18 s per event — and profile keys by a DISTINCT over
-- profile_traits (522M rows / 9.5 GiB, 14-18 s, hidden behind a 1 h cache).
-- chart.values for a trait ran argMax per profile over the key's rows.
-- These views hold only what the pickers need, so each request is a few
-- thousand rows behind a primary-key prefix.
--
-- Plain DDL: the `openpanel` database is Replicated. Backfill with
-- backfill_picker_keys.sh (one pass each; the trait ones take ~1 minute, the
-- event-keys one ~5 minutes reading the values view's key columns).

-- Distinct event property keys per (project, event), last time seen.
CREATE TABLE IF NOT EXISTS openpanel.event_property_keys_local
(
    `project_id`   LowCardinality(String),
    `name`         LowCardinality(String),
    `property_key` String CODEC(ZSTD(3)),
    `last_seen`    SimpleAggregateFunction(max, DateTime64(3))
)
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
ORDER BY (project_id, name, property_key)
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS openpanel.event_property_keys_mv
TO openpanel.event_property_keys_local
AS
SELECT
    project_id,
    name,
    property_key,
    max(created_at) AS last_seen
FROM (
    SELECT project_id, name, arrayJoin(mapKeys(properties)) AS property_key, created_at
    FROM openpanel.events
)
WHERE property_key != '' AND property_key NOT IN ('__duration_from', '__properties_from')
GROUP BY project_id, name, property_key;

-- Distinct profile trait keys per project, last time written.
CREATE TABLE IF NOT EXISTS openpanel.profile_trait_keys_local
(
    `project_id` LowCardinality(String),
    `key`        String CODEC(ZSTD(3)),
    `last_seen`  SimpleAggregateFunction(max, DateTime64(3))
)
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
ORDER BY (project_id, key)
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS openpanel.profile_trait_keys_mv
TO openpanel.profile_trait_keys_local
AS
SELECT project_id, key, max(updated_at) AS last_seen
FROM openpanel.profile_traits
GROUP BY project_id, key;

-- Distinct (key, value) pairs ever written for a trait, last time written.
-- NOTE: this is "values that have existed", not "each profile's current
-- value" — a value a profile later moved away from stays listed. For a
-- filter picker that is the useful set; the filter itself still evaluates
-- against each profile's latest value.
CREATE TABLE IF NOT EXISTS openpanel.profile_trait_values_local
(
    `project_id` LowCardinality(String),
    `key`        String CODEC(ZSTD(3)),
    `value`      String CODEC(ZSTD(3)),
    `last_seen`  SimpleAggregateFunction(max, DateTime64(3))
)
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
ORDER BY (project_id, key, value)
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS openpanel.profile_trait_values_mv
TO openpanel.profile_trait_values_local
AS
SELECT project_id, key, value, max(updated_at) AS last_seen
FROM openpanel.profile_traits
WHERE value != ''
GROUP BY project_id, key, value;
