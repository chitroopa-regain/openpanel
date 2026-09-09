# Funnel fast-path views

Two pre-aggregated ClickHouse tables feed the funnel fast path
(`FunnelService.resolveMvSource`). Both are keyed
`(project_id, name, day, app_version, country, profile_id)` where `day` is the
event's calendar day in the **server** timezone (UTC).

| Table | Holds | Exact? |
|---|---|---|
| `event_profile_firsts_local` | first and last identified timestamp per key | No — a repeated middle step can hide the bridging occurrence; timing medians drift on high-repeat steps |
| `event_profile_ts_local` | every identified timestamp per key (`Array(DateTime64(3))`) | Yes — windowFunnel and the timing chain see the full stream |

Readers apply `arrayDistinct` on the array: the source `events` table is a
ReplacingMergeTree, so an event can be inserted twice before its merge.

## Rollout of the exact view

1. `event_profile_ts.sql` — create the table and the live materialized view
   (plain DDL; the `openpanel` database is Replicated, so it lands on both
   nodes). Note the creation instant (UTC).
2. `backfill_event_profile_ts.sh` — newest day first, per project, resumable
   through `event_profile_ts_backfill`. Pass `MV_CREATED_AT` so the creation
   day is backfilled only up to the instant the live feed started.
   Measured: regain-app ~54 s/day at 4 threads (~100 s at 2), brainrot-app
   ~16 s/day, 2.1 GiB peak.
3. Validate with the equivalence harness (`../equivalence/`) using a frozen
   window inside the backfilled range and `OP_FUNNEL_TS_MV=1` set while
   generating the pairs. Expect zero funnel diffs.
4. Set `OP_FUNNEL_TS_MV=1` on the api. Coverage is auto-detected per project:
   a report whose start day precedes the backfill's `min(day)` keeps using the
   (min, max) view; a stalled feed (`OP_FUNNEL_MV_MAX_STALENESS_HOURS`, default
   24) falls back the same way. `OP_FUNNEL_MV_DISABLED=1` disables both views.

Not eligible for either view (raw path): session-grouped funnels, steps with
event-property filters, event-property breakdowns, cohort filters/buckets,
repeated event names, first-time filters.
