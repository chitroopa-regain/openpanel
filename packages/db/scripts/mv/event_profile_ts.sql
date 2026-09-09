-- Exact per-day identified timestamps per (project, event, profile, day,
-- app_version, country). Same grain as event_profile_firsts_local, but keeps
-- EVERY identified timestamp instead of (min, max), so windowFunnel and the
-- time-to-convert chain computed from it are exact, not approximate.
--
-- Merges concatenate the arrays (SimpleAggregateFunction(groupArrayArray)).
-- The source `events` table is ReplacingMergeTree, so an event can be inserted
-- twice before its merge and appear twice here; readers apply arrayDistinct.
--
-- The `openpanel` database uses the Replicated database engine, so plain DDL
-- on one node is replicated to the other (ON CLUSTER is rejected there).
-- Backfill with backfill_event_profile_ts.sh (newest day first).

CREATE TABLE IF NOT EXISTS openpanel.event_profile_ts_local
(
    `project_id`   LowCardinality(String),
    `name`         LowCardinality(String),
    `profile_id`   String CODEC(ZSTD(3)),
    `day`          Date,
    `app_version`  LowCardinality(String),
    `country`      LowCardinality(String),
    `ts_identified` SimpleAggregateFunction(groupArrayArray, Array(DateTime64(3))) CODEC(Delta, ZSTD(3))
)
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY (project_id, toYYYYMM(day))
ORDER BY (project_id, name, day, app_version, country, profile_id)
SETTINGS index_granularity = 8192;

-- Live feed. `day` is toDate(created_at) in the SERVER timezone, exactly like
-- event_profile_firsts_mv, so the readers' day pre-filter (start - 1 day,
-- end + window + 1) stays valid for both sources.
CREATE MATERIALIZED VIEW IF NOT EXISTS openpanel.event_profile_ts_mv
TO openpanel.event_profile_ts_local
AS
SELECT
    project_id,
    name,
    profile_id,
    toDate(created_at) AS day,
    app_version,
    country,
    groupArrayIf(created_at, profile_id != device_id) AS ts_identified
FROM openpanel.events
WHERE project_id IN ('brainrot-app', 'regain-app')
GROUP BY project_id, name, profile_id, day, app_version, country;
