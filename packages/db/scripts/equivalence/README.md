# Funnel equivalence harness

Proves that the fast (materialized-view) funnel path returns the same numbers
as the raw-events path for the reports people actually use. Run it before
flipping any query optimisation on, and nightly against production.

## 1. Export the reports (Postgres, on jitsu-mgmt1)

```sql
\t on
\a
select json_build_object(
  'reports', (select json_agg(r) from (
     select r.id, r.name, r."projectId", r."dashboardId", r."chartType", r.range, r.interval,
            r."lineType", r.metric, r.unit, r.previous, r."funnelGroup", r."funnelWindow",
            r.events as series, r.breakdowns, r.options, r."dateConfig",
            r."cohortFilters", r."cohortBreakdown", r.formula, r.criteria
     from reports r join dashboards d on d.id = r."dashboardId"
     where r."chartType" in ('funnel','funnel_metric')
       and (d."updatedAt" > now() - interval '30 days' or r."updatedAt" > now() - interval '30 days')
       and (r."cohortFilters" is null or r."cohortFilters"::text in ('[]','null'))
       and (r."cohortBreakdown" is null or r."cohortBreakdown"::text in ('[]','null','{}'))
     order by r."dashboardId", r.name) r),
  'customEvents', (select json_agg(c) from (select id, name, "projectId", components from custom_events) c)
);
```

Save the output as `reports.json`. Reports with cohort filters/breakdowns are
excluded because they never take the MV path.

## 2. Generate the SQL pairs (any dev machine)

```bash
EQ_REPORTS=reports.json EQ_OUT=pairs.json EQ_TIMEZONE=Asia/Calcutta \
  pnpm vitest run packages/db/src/services/funnel-equivalence.harness.test.ts
```

Drives the real `FunnelService` twice per report (MV disabled / enabled) with
a recording ClickHouse client. `mvEligible` marks reports whose two variants
differ, i.e. the ones where the fast path is actually used.

Add `EQ_FREEZE_START="2026-08-01 00:00:00" EQ_FREEZE_END="2026-08-31 23:59:59"`
to pin every report to one fixed window. Relative ranges move between the two
runs, so without freezing a one-user drift can be live ingestion rather than a
semantic difference.

## 3. Run and compare (a host that reaches ClickHouse)

```bash
CH_URL=http://jitsu-ha-vip-private.regainapp.xyz:8123 CH_USER=default CH_PASSWORD=… \
  python3 funnel-equivalence-run.py pairs.json --only c66-launch-board,regain-pro --threads 4 --out results.json
```

- `funnel` rows (level × breakdown × count) must be identical.
- `timing` medians are compared with TDigest tolerance (2 % or 2 s).
- `props` sums within 0.01, converted counts identical.

Exit code 1 on any divergence. Timings for both paths are printed, so the
run is also the before/after latency measurement.
