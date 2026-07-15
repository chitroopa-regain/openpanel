import { createClient, type ClickHouseClient } from '@clickhouse/client';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
  chQuery: vi.fn(),
  tables: {
    events: 'funnel_metric_events_test',
    profileTraits: 'funnel_metric_profile_traits_test',
  },
}));

vi.mock('../clickhouse/client', () => ({
  ch: {},
  chQuery: mocks.chQuery,
  TABLE_NAMES: {
    events: mocks.tables.events,
    profiles: 'profiles',
    profile_traits: mocks.tables.profileTraits,
    alias: 'profile_aliases',
    self_hosting: 'self_hosting',
    events_bots: 'events_bots',
    dau_mv: 'dau_mv',
    event_names_mv: 'distinct_event_names_mv',
    event_property_values_mv: 'event_property_values_mv',
    cohort_events_mv: 'cohort_events_mv',
    event_profile_firsts: 'event_profile_firsts_local',
    sessions: 'sessions',
    events_imports: 'events_imports',
    session_replay_chunks: 'session_replay_chunks',
  },
}));

vi.mock('../prisma-client', () => ({
  db: {},
}));

import { FunnelService, qualifyFunnelCondition } from './funnel.service';

const normalizeSql = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const prodFunnelMetricReport = {
  id: '22222222-3333-4444-8555-000000000003',
  name: 'Trait Breakdown Funnel Metric - Revenue',
  projectId: 'regain-app',
  events: [
    {
      id: 's1',
      name: 'Subscription: Paywall Viewed',
      type: 'event',
      filters: [
        {
          id: 'f_paywall',
          name: 'properties.paywallVariant',
          value: ['CHOOSE_A_PLAN'],
          operator: 'is',
        },
      ],
      segment: 'event',
    },
    {
      id: 's2',
      name: 'Subscription: Purchase Initiated',
      type: 'event',
      filters: [],
      segment: 'event',
    },
    {
      id: 's3',
      name: 'Server: Purchase',
      type: 'event',
      filters: [],
      segment: 'event',
    },
  ],
  breakdowns: [{ name: 'profile.properties.show_monthly_back_press_offer' }],
  options: {
    type: 'funnel',
    funnelGroup: 'profile_id',
    funnelWindow: 30,
    breakdownStep: 0,
    funnelProperty: 'properties.value_inr',
    funnelWindowUnit: 'day',
  },
};

const eventPropertyBreakdowns = [{ name: 'properties.step_bucket' }];

describe('FunnelService.getFunnelPropertySums', () => {
  beforeEach(() => {
    mocks.chQuery.mockReset();
  });

  it('returns property sum, average, and converted entity count per breakdown', async () => {
    mocks.chQuery.mockResolvedValue([
      { b_0: 'true', total_sum: 90, property_average: 30, property_count: 3 },
      { b_0: 'false', total_sum: 30, property_average: 15, property_count: 2 },
    ]);

    const service = new FunnelService({} as any);
    const result = await service.getFunnelPropertyStats(
      prodFunnelMetricInput(service)
    );

    expect(Object.fromEntries(result)).toEqual({
      true: { sum: 90, average: 30, count: 3 },
      false: { sum: 30, average: 15, count: 2 },
    });

    const sql = getLastQuerySql();
    expect(sql).toContain('sum(pv.prop_value) as total_sum');
    expect(sql).toContain('avg(pv.prop_value) as property_average');
    expect(sql).toContain('count(pv.prop_value) as property_count');
  });

  it('builds profile-trait breakdown SQL without the correlated scalar subquery', async () => {
    mocks.chQuery.mockResolvedValue([{ b_0: 'true', total_sum: 42 }]);

    const service = new FunnelService({} as any);
    const result = await service.getFunnelPropertySums(
      prodFunnelMetricInput(service)
    );

    expect(result.get('true')).toBe(42);

    const sql = normalizeSql(String(mocks.chQuery.mock.calls[0]?.[0] ?? ''));
    expect(sql).toContain('trait_show_monthly_back_press_offer AS');
    expect(sql).toContain(`FROM ${mocks.tables.profileTraits}`);
    expect(sql).toContain("key = 'show_monthly_back_press_offer'");
    expect(sql).toContain(
      'LEFT ANY JOIN trait_show_monthly_back_press_offer ON trait_show_monthly_back_press_offer.profile_id = e.profile_id'
    );
    expect(sql).toContain(
      "argMaxIf(trait_show_monthly_back_press_offer.value, e.created_at, e.properties['paywallVariant'] = 'CHOOSE_A_PLAN' AND e.name = 'Subscription: Paywall Viewed') as b_0"
    );
    expect(sql).toContain('GROUP BY e.profile_id');
    expect(sql).toContain(
      'LEFT JOIN prop_bd bd ON pv.profile_id = bd.profile_id'
    );

    expect(sql).not.toContain('t.profile_id = profile_id');
    expect(sql).not.toContain('SELECT argMax(t.value, t.updated_at)');
    expect(sql).not.toContain(
      "argMaxIf(trait_show_monthly_back_press_offer.value, created_at, properties['paywallVariant'] = 'CHOOSE_A_PLAN' AND name = 'Subscription: Paywall Viewed')"
    );
  });

  it('builds all-steps profile-trait breakdown SQL when breakdownStep is unset', async () => {
    mocks.chQuery.mockResolvedValue([{ b_0: 'true', total_sum: 42 }]);

    const service = new FunnelService({} as any);
    await service.getFunnelPropertySums({
      ...prodFunnelMetricInput(service),
      breakdownStep: undefined,
    });

    const sql = getLastQuerySql();
    expect(sql).toContain('trait_show_monthly_back_press_offer.value as b_0');
    expect(sql).toContain('GROUP BY e.profile_id, b_0');
    expect(sql).not.toContain(
      'argMaxIf(trait_show_monthly_back_press_offer.value'
    );
  });

  it('builds step-2 profile-trait breakdown SQL when breakdownStep is 1', async () => {
    mocks.chQuery.mockResolvedValue([{ b_0: 'true', total_sum: 42 }]);

    const service = new FunnelService({} as any);
    await service.getFunnelPropertySums({
      ...prodFunnelMetricInput(service),
      breakdownStep: 1,
    });

    const sql = getLastQuerySql();
    expect(sql).toContain(
      "argMaxIf(trait_show_monthly_back_press_offer.value, e.created_at, e.name = 'Subscription: Purchase Initiated') as b_0"
    );
    expect(sql).toContain('GROUP BY e.profile_id');
    expect(sql).not.toContain('GROUP BY e.profile_id, b_0');
  });

  it('builds step-1 event-property breakdown SQL without trait CTEs', async () => {
    mocks.chQuery.mockResolvedValue([{ b_0: 'control', total_sum: 42 }]);

    const service = new FunnelService({} as any);
    await service.getFunnelPropertySums({
      ...prodFunnelMetricInput(service),
      breakdowns: eventPropertyBreakdowns,
      breakdownStep: 0,
    });

    const sql = getLastQuerySql();
    expect(sql).toContain(
      "argMaxIf(properties['step_bucket'], e.created_at, properties['paywallVariant'] = 'CHOOSE_A_PLAN' AND name = 'Subscription: Paywall Viewed') as b_0"
    );
    expect(sql).not.toContain('trait_show_monthly_back_press_offer');
    expect(sql).not.toContain('e.name = ');
  });

  it('builds step-2 event-property breakdown SQL without trait CTEs', async () => {
    mocks.chQuery.mockResolvedValue([{ b_0: 'started', total_sum: 42 }]);

    const service = new FunnelService({} as any);
    await service.getFunnelPropertySums({
      ...prodFunnelMetricInput(service),
      breakdowns: eventPropertyBreakdowns,
      breakdownStep: 1,
    });

    const sql = getLastQuerySql();
    expect(sql).toContain(
      "argMaxIf(properties['step_bucket'], e.created_at, name = 'Subscription: Purchase Initiated') as b_0"
    );
    expect(sql).not.toContain('trait_show_monthly_back_press_offer');
  });

  it('builds all-steps event-property breakdown SQL when breakdownStep is unset', async () => {
    mocks.chQuery.mockResolvedValue([{ b_0: 'started', total_sum: 42 }]);

    const service = new FunnelService({} as any);
    await service.getFunnelPropertySums({
      ...prodFunnelMetricInput(service),
      breakdowns: eventPropertyBreakdowns,
      breakdownStep: undefined,
    });

    const sql = getLastQuerySql();
    expect(sql).toContain("properties['step_bucket'] as b_0");
    expect(sql).toContain('GROUP BY e.profile_id, b_0');
    expect(sql).not.toContain("argMaxIf(properties['step_bucket']");
    expect(sql).not.toContain('trait_show_monthly_back_press_offer');
  });

  it('builds profile-trait filter SQL on a funnel step', async () => {
    mocks.chQuery.mockResolvedValue([{ b_0: 'true', total_sum: 42 }]);

    const service = new FunnelService({} as any);
    await service.getFunnelPropertySums({
      ...prodFunnelMetricInput(service, {
        events: [
          {
            ...prodFunnelMetricReport.events[0]!,
            filters: [
              {
                id: 'f_plan',
                name: 'profile.properties.plan',
                value: ['pro'],
                operator: 'is',
              },
            ],
          },
          ...prodFunnelMetricReport.events.slice(1),
        ],
      }),
    });

    const sql = getLastQuerySql();
    expect(sql).toContain(
      "e.profile_id IN (SELECT profile_id FROM funnel_metric_profile_traits_test WHERE project_id = 'regain-app' AND key = 'plan' GROUP BY profile_id HAVING argMax(value, updated_at) = 'pro')"
    );
    expect(sql).toContain("e.name = 'Subscription: Paywall Viewed'");
    expect(sql).not.toContain('SELECT e.profile_id FROM');
  });

  it('builds combined event-property and profile-trait filter SQL on a funnel step', async () => {
    mocks.chQuery.mockResolvedValue([{ b_0: 'true', total_sum: 42 }]);

    const service = new FunnelService({} as any);
    await service.getFunnelPropertySums({
      ...prodFunnelMetricInput(service, {
        events: [
          {
            ...prodFunnelMetricReport.events[0]!,
            filters: [
              ...prodFunnelMetricReport.events[0]!.filters,
              {
                id: 'f_plan',
                name: 'profile.properties.plan',
                value: ['pro'],
                operator: 'is',
              },
            ],
          },
          ...prodFunnelMetricReport.events.slice(1),
        ],
      }),
    });

    const sql = getLastQuerySql();
    expect(sql).toContain(
      "e.properties['paywallVariant'] = 'CHOOSE_A_PLAN' AND e.profile_id IN (SELECT profile_id FROM funnel_metric_profile_traits_test"
    );
    expect(sql).toContain("AND e.name = 'Subscription: Paywall Viewed'");
    expect(sql).not.toContain('SELECT e.profile_id FROM');
  });

  it('builds session-grouped funnel metric SQL', async () => {
    mocks.chQuery.mockResolvedValue([{ b_0: 'true', total_sum: 42 }]);

    const service = new FunnelService({} as any);
    await service.getFunnelPropertySums({
      ...prodFunnelMetricInput(service),
      groupBy: 'session_id',
    });

    const sql = getLastQuerySql();
    expect(sql).toContain('SELECT session_id, min(created_at) as step_1_ts');
    expect(sql).toContain(
      'JOIN funnel_metric_events_test e ON e.session_id = prev.session_id'
    );
    expect(sql).toContain('GROUP BY e.session_id');
    expect(sql).toContain(
      'LEFT JOIN prop_bd bd ON pv.session_id = bd.session_id'
    );
    expect(sql).not.toContain('profile_id != device_id');
    expect(sql).not.toContain('e.profile_id != e.device_id');
  });

  it('uses the supplied funnel window seconds in later-step constraints', async () => {
    mocks.chQuery.mockResolvedValue([{ b_0: 'true', total_sum: 42 }]);

    const service = new FunnelService({} as any);
    await service.getFunnelPropertySums({
      ...prodFunnelMetricInput(service),
      funnelWindowSeconds: 15 * 60,
    });

    const sql = getLastQuerySql();
    expect(sql).toContain(
      "dateDiff('second', s1.step_1_ts, e.created_at) <= 900"
    );
    expect(sql).not.toContain(
      "dateDiff('second', s1.step_1_ts, e.created_at) <= 2592000"
    );
  });

  it('sums the configured numeric property at the final funnel step', async () => {
    mocks.chQuery.mockResolvedValue([{ b_0: 'true', total_sum: 42 }]);

    const service = new FunnelService({} as any);
    await service.getFunnelPropertySums(prodFunnelMetricInput(service));

    const sql = getLastQuerySql();
    expect(sql).toContain(
      "toFloat64OrNull(toString(e.properties['value_inr']))"
    );
    expect(sql).toContain(
      "e.created_at = ls.step_3_ts AND (name = 'Server: Purchase')"
    );
    expect(sql).toContain('sum(pv.prop_value) as total_sum');
  });

  it('maps empty breakdown values to Not set', async () => {
    mocks.chQuery.mockResolvedValue([{ b_0: '', total_sum: 10 }]);

    const service = new FunnelService({} as any);
    const result = await service.getFunnelPropertySums(
      prodFunnelMetricInput(service)
    );

    expect(result.get('Not set')).toBe(10);
  });

  it('returns the total under none when there is no breakdown', async () => {
    mocks.chQuery.mockResolvedValue([{ total_sum: 99 }]);

    const service = new FunnelService({} as any);
    const result = await service.getFunnelPropertySums({
      ...prodFunnelMetricInput(service),
      breakdowns: [],
      breakdownStep: undefined,
    });

    const sql = getLastQuerySql();
    expect(result.get('none')).toBe(99);
    expect(sql).not.toContain('prop_bd AS');
    expect(sql).not.toContain('LEFT JOIN prop_bd');
    expect(sql).not.toContain('trait_show_monthly_back_press_offer');
  });

  it('passes session_timezone to chQuery so bare-string dates resolve in the caller timezone', async () => {
    // Regression: getFunnelPropertySums builds a SQL with unqualified
    // toDateTime('YYYY-MM-DD HH:MM:SS') literals. ClickHouse parses these in
    // the session timezone, which defaults to UTC. If the setting isn't
    // threaded through chQuery the IST day window silently shifts by +5:30h
    // and drops the early-morning IST tail (see the 2026-04-15 debugging
    // session). This test pins the call-site contract instead of the SQL
    // string so the fix can't be removed without tripping the assertion.
    mocks.chQuery.mockResolvedValue([{ b_0: 'true', total_sum: 42 }]);

    const service = new FunnelService({} as any);
    await service.getFunnelPropertySums({
      ...prodFunnelMetricInput(service),
      timezone: 'Asia/Calcutta',
    });

    const [, settings] = mocks.chQuery.mock.calls.at(-1) ?? [];
    expect(settings).toEqual({ session_timezone: 'Asia/Calcutta' });
  });

  it('qualifies only the outer event columns when step conditions contain trait subqueries', async () => {
    mocks.chQuery.mockResolvedValue([{ b_0: 'true', total_sum: 42 }]);

    const service = new FunnelService({} as any);
    await service.getFunnelPropertySums({
      ...prodFunnelMetricInput(service),
      stepConditions: [
        "profile_id IN (SELECT profile_id FROM profile_traits WHERE project_id = 'regain-app' AND key = 'plan' GROUP BY profile_id HAVING argMax(value, updated_at) = 'pro') AND name = 'Subscription: Paywall Viewed'",
        "name = 'Subscription: Purchase Initiated'",
        "name = 'Server: Purchase'",
      ],
    });

    const sql = getLastQuerySql();
    expect(sql).toContain(
      'e.profile_id IN (SELECT profile_id FROM profile_traits'
    );
    expect(sql).toContain("e.name = 'Subscription: Paywall Viewed'");
    expect(sql).not.toContain('SELECT e.profile_id FROM profile_traits');
  });

  // ──────────────────────────────────────────────────────────────
  // SQL-shape assertions for the Mixpanel-parity window expansion.
  // These run under plain `vitest run` (no ClickHouse required), so
  // CI can catch a dropped widening in step_2..N / prop_vals /
  // prop_bd / timing_bd even when OPENPANEL_RUN_CLICKHOUSE_TESTS
  // isn't set.
  // ──────────────────────────────────────────────────────────────

  it('widens step_2..N, prop_vals and prop_bd to endDate + funnelWindowSeconds', async () => {
    mocks.chQuery.mockResolvedValue([{ b_0: 'true', total_sum: 42 }]);

    const service = new FunnelService({} as any);
    // 30 days = 2592000 seconds — matches prodFunnelMetricInput's
    // funnelWindowSeconds so the expected literal is stable.
    await service.getFunnelPropertySums({
      ...prodFunnelMetricInput(service),
      breakdownStep: 1, // exercise argMaxIf on prop_bd too
    });

    const sql = getLastQuerySql();
    const extended = "addSeconds(toDateTime('2026-04-15 23:59:59'), 2592000)";

    // step_1 stays on the report range
    expect(sql).toContain(
      'step_1 AS ( SELECT profile_id, min(created_at) as step_1_ts FROM'
    );
    expect(sql).toContain(
      "created_at BETWEEN toDateTime('2026-04-15 00:00:00') AND toDateTime('2026-04-15 23:59:59')"
    );

    // Every later-step CTE must reach the extended end.
    // (2 later steps for the 3-event prod funnel + prop_vals + prop_bd).
    const extendedOccurrences = sql.split(extended).length - 1;
    expect(extendedOccurrences).toBeGreaterThanOrEqual(4);

    // step_2 + step_3 CTEs
    expect(sql).toContain(
      `step_2 AS ( SELECT prev.profile_id as profile_id, min(e.created_at) as step_2_ts FROM step_1 prev JOIN ${mocks.tables.events} e ON e.profile_id = prev.profile_id JOIN step_1 s1 ON s1.profile_id = prev.profile_id WHERE e.project_id = 'regain-app' AND e.created_at BETWEEN toDateTime('2026-04-15 00:00:00') AND ${extended}`
    );
    expect(sql).toContain(
      `step_3 AS ( SELECT prev.profile_id as profile_id, min(e.created_at) as step_3_ts FROM step_2 prev JOIN ${mocks.tables.events} e ON e.profile_id = prev.profile_id JOIN step_1 s1 ON s1.profile_id = prev.profile_id WHERE e.project_id = 'regain-app' AND e.created_at BETWEEN toDateTime('2026-04-15 00:00:00') AND ${extended}`
    );

    // prop_bd + prop_vals both need the extended scan. Splice out each
    // CTE body by the `prop_bd AS (` / `prop_vals AS (` anchor and assert
    // the extended-end substring is inside.
    const afterPropBd = sql.split('prop_bd AS (')[1] ?? '';
    const propBdBody = afterPropBd.split('prop_vals AS (')[0] ?? '';
    expect(propBdBody).toContain(`argMaxIf(`);
    expect(propBdBody).toContain(
      `e.created_at BETWEEN toDateTime('2026-04-15 00:00:00') AND ${extended}`
    );

    const propValsBody = afterPropBd.split('prop_vals AS (')[1] ?? '';
    expect(propValsBody).toContain(
      `e.created_at BETWEEN toDateTime('2026-04-15 00:00:00') AND ${extended}`
    );
  });

  it('buildFunnelCte qualifies internal windowFunnel conditions when caller signals expectProfilesFinalJoin', async () => {
    // Regression for the "profiles FINAL attached externally → internal
    // step conditions are still unqualified → AMBIGUOUS_IDENTIFIER"
    // class of bug. Without the signal, buildFunnelCte only qualifies
    // when traitDescriptors.size > 0, so a caller that plans to attach
    // profiles FINAL after the fact (FunnelService.getFunnel and the
    // chart.ts:getFunnelProfiles router) can silently end up with an
    // unqualified `properties['X']` inside windowFunnel even though
    // profile.properties suddenly exists in scope.
    const service = new FunnelService({} as any);
    const { query } = service.buildFunnelCte({
      projectId: 'regain-app',
      startDate: '2026-04-15 00:00:00',
      endDate: '2026-04-15 23:59:59',
      eventSeries: [
        {
          id: 's1',
          name: 'Subscription: Paywall Viewed',
          type: 'event',
          filters: [
            {
              id: 'f1',
              name: 'properties.paywallVariant',
              value: ['CHOOSE_A_PLAN'],
              operator: 'is',
            },
          ],
          segment: 'event',
        },
        {
          id: 's2',
          name: 'Server: Purchase',
          type: 'event',
          filters: [],
          segment: 'event',
        },
      ] as any,
      funnelWindowMilliseconds: 7 * 86400 * 1000,
      timezone: 'Asia/Calcutta',
      groupBy: 'profile_id',
      expectProfilesFinalJoin: true,
    });

    const sql = normalizeSql(query.toSQL());
    // The first step condition fed into windowFunnel must be fully
    // qualified — bare `properties[...]` and bare `name =` would
    // collide with the profiles FINAL join the caller is about to
    // attach.
    expect(sql).toContain(
      "events.properties['paywallVariant'] = 'CHOOSE_A_PLAN'"
    );
    expect(sql).toContain("events.name = 'Subscription: Paywall Viewed'");
    expect(sql).toContain("events.name = 'Server: Purchase'");
    // And the step-1 anchor `toDateTime('...')` literals must land in
    // the windowFunnel predicate with SINGLE quotes, not double-escaped
    // `''YYYY-MM-DD HH:MM:SS''` (which would happen if clix's SELECT
    // serializer runs escapeDate over the raw string — see
    // query-builder.ts escapeDate comment). Pin the happy shape here
    // and explicitly reject the mangled form so a future regression in
    // how the select is wrapped breaks this test instantly.
    expect(sql).toContain("toDateTime('2026-04-15 00:00:00')");
    expect(sql).toContain("toDateTime('2026-04-15 23:59:59')");
    expect(sql).not.toContain("toDateTime(''");
    expect(sql).not.toContain("''2026-04-15");
    // And the surrounding SELECT / WHERE / GROUP BY event-column refs
    // get the same alias so the later `profile.` columns can't collide.
    expect(sql).toContain('events.profile_id AS profile_id');
    expect(sql).toContain(
      "events.created_at >= toDateTime('2026-04-15 00:00:00')"
    );
    expect(sql).toContain('events.profile_id != events.device_id');
    expect(sql).toContain('GROUP BY events.profile_id');
    // Without the signal, qualification is off — bare references only.
    const { query: unqualified } = service.buildFunnelCte({
      projectId: 'regain-app',
      startDate: '2026-04-15 00:00:00',
      endDate: '2026-04-15 23:59:59',
      eventSeries: [
        {
          id: 's1',
          name: 'Subscription: Paywall Viewed',
          type: 'event',
          filters: [],
          segment: 'event',
        },
      ] as any,
      funnelWindowMilliseconds: 7 * 86400 * 1000,
      timezone: 'Asia/Calcutta',
      groupBy: 'profile_id',
      expectProfilesFinalJoin: false,
    });
    const unqualifiedSql = normalizeSql(unqualified.toSQL());
    expect(unqualifiedSql).not.toContain(
      'events.profile_id != events.device_id'
    );
    expect(unqualifiedSql).toContain('profile_id != device_id');
  });

  it('qualifyFunnelCondition qualifies outer event columns without touching subqueries or literals', () => {
    // The exported helper is called from FunnelService.getFunnel and
    // chart.ts:getFunnelProfiles to qualify breakdown-step conditions
    // before they land inside an `argMaxIf(..., <cond>)` call. If it
    // silently mis-qualifies a column inside an `IN (SELECT ...)`
    // subquery, the inner scoping breaks and every user gets bucketed
    // identically (the exact class of bug the earlier timezone +
    // trait-breakdown commits were fighting). Pin the semantics here so
    // callers can rely on it without each re-proving the contract.

    // Bare event columns get the alias prefix.
    expect(
      qualifyFunnelCondition("name = 'Subscription: Paywall Viewed'")
    ).toBe("events.name = 'Subscription: Paywall Viewed'");

    expect(
      qualifyFunnelCondition(
        "properties['paywallVariant'] = 'CHOOSE_A_PLAN' AND name = 'Subscription: Paywall Viewed'"
      )
    ).toBe(
      "events.properties['paywallVariant'] = 'CHOOSE_A_PLAN' AND events.name = 'Subscription: Paywall Viewed'"
    );

    // Trait CTE references (`trait_<key>.value`) are not in the column
    // whitelist — they pass through untouched, and only the bare `name`
    // gets qualified. This is important because over-qualifying a trait
    // column would produce `events.trait_show_...` which doesn't exist.
    expect(
      qualifyFunnelCondition(
        "trait_show_monthly_back_press_offer.value = 'true' AND name = 'Server: Purchase'"
      )
    ).toBe(
      "trait_show_monthly_back_press_offer.value = 'true' AND events.name = 'Server: Purchase'"
    );

    // The outer `profile_id` gets qualified; the inner `profile_id`
    // inside the IN subquery stays bare and resolves against
    // profile_traits in its own scope. This is the specific property
    // the reviewer called out when the C54 funnel uses a trait filter
    // on the paywall step AND a trait breakdown on Purchase Initiated
    // at the same time.
    const stepCond =
      "profile_id IN (SELECT profile_id FROM profile_traits WHERE project_id = 'regain-app' AND key = 'country' GROUP BY profile_id HAVING argMax(value, updated_at) = 'IN') AND name = 'Subscription: Paywall Viewed'";
    const qualified = qualifyFunnelCondition(stepCond);
    expect(qualified).toBe(
      "events.profile_id IN (SELECT profile_id FROM profile_traits WHERE project_id = 'regain-app' AND key = 'country' GROUP BY profile_id HAVING argMax(value, updated_at) = 'IN') AND events.name = 'Subscription: Paywall Viewed'"
    );
    // The inner SELECT's profile_id must stay bare — otherwise the
    // subquery resolves its own profile_id to events.profile_id and
    // the `GROUP BY profile_id` below is invalid.
    expect(qualified).not.toContain('SELECT events.profile_id');

    // String literals that look like column names are untouched.
    expect(
      qualifyFunnelCondition(
        "name = 'created_at' AND properties['profile_id'] = '42'"
      )
    ).toBe(
      "events.name = 'created_at' AND events.properties['profile_id'] = '42'"
    );

    // Custom alias is honoured (used by getFunnelPropertySums' `e` alias).
    expect(qualifyFunnelCondition("name = 'X'", 'e')).toBe("e.name = 'X'");

    // First-time-ever join column `ft_<i>.ft_profile_id` must NOT be split
    // into `ft_<i>.ft_events.profile_id`. The regex anchor `\b` matches at
    // slice-start (no char before in the slice) even when the preceding
    // char in the full string is a word char, so the helper must reject
    // mid-identifier matches via prevChar. The c54-launch-board funnel hit
    // this by combining `firstTimeFilter: true` on step A with a
    // profile.properties.* trait filter — the CH error was:
    // "Identifier 'ft_0.ft_events.profile_id' cannot be resolved from
    //  subquery with name ft_0. In scope session_funnel."
    expect(
      qualifyFunnelCondition("(name = 'X' AND ft_0.ft_profile_id != '')")
    ).toBe("(events.name = 'X' AND ft_0.ft_profile_id != '')");

    // Likewise for trait CTE alias columns that happen to end in `name`,
    // `properties`, etc. — `trait_user_name.value` must not become
    // `trait_user_events.name.value`.
    expect(
      qualifyFunnelCondition("trait_user_name.value = 'a' AND name = 'X'")
    ).toBe("trait_user_name.value = 'a' AND events.name = 'X'");
  });

  it('buildFunnelCte emits trait CTEs + LEFT ANY JOIN for profile.properties breakdowns', async () => {
    // Regression for the getFunnelProfiles "View Users" drawer. The router
    // used to build its trait breakdown via getTraitBreakdownExpression,
    // which emitted the unqualified correlated-subquery form — global
    // scalar per profile instead of per-user values. The fix was to let
    // buildFunnelCte handle trait breakdowns through the same CTE +
    // LEFT ANY JOIN pattern the FunnelService.getFunnel path already
    // used. buildFunnelCte now returns `traitCtes` alongside
    // `firstTimeCtes` so every caller registers them the same way and
    // nobody has to rebuild the same SELECT inline.
    const service = new FunnelService({} as any);
    const traitDescriptors = new Map([
      [
        'show_monthly_back_press_offer',
        {
          key: 'show_monthly_back_press_offer',
          cteName: 'trait_show_monthly_back_press_offer',
          column: 'trait_show_monthly_back_press_offer.value',
        },
      ],
    ]);

    const { query, traitCtes, firstTimeCtes } = service.buildFunnelCte({
      projectId: 'regain-app',
      startDate: '2026-04-15 00:00:00',
      endDate: '2026-04-15 23:59:59',
      eventSeries: [
        {
          id: 's1',
          name: 'Subscription: Paywall Viewed',
          type: 'event',
          filters: [],
          segment: 'event',
        },
        {
          id: 's2',
          name: 'Server: Purchase',
          type: 'event',
          filters: [],
          segment: 'event',
        },
      ] as any,
      funnelWindowMilliseconds: 30 * 86400 * 1000,
      timezone: 'Asia/Calcutta',
      groupBy: 'profile_id',
      additionalSelects: ['trait_show_monthly_back_press_offer.value as b_0'],
      additionalGroupBy: ['b_0'],
      traitDescriptors,
    });

    // The inner session_funnel CTE must add the LEFT ANY JOIN so bare
    // `trait_show_monthly_back_press_offer.value` references resolve.
    const innerSql = normalizeSql(query.toSQL());
    expect(innerSql).toContain(
      'LEFT ANY JOIN trait_show_monthly_back_press_offer ON trait_show_monthly_back_press_offer.profile_id = events.profile_id'
    );
    expect(innerSql).toContain(
      'trait_show_monthly_back_press_offer.value as b_0'
    );

    // firstTimeCtes is empty for this shape — we're only pinning the
    // trait CTE shape.
    expect(firstTimeCtes).toEqual([]);

    // buildFunnelCte returns one top-level CTE per trait descriptor so
    // callers can register them without rebuilding the SELECT.
    expect(traitCtes).toHaveLength(1);
    expect(traitCtes[0]!.name).toBe('trait_show_monthly_back_press_offer');
    const cteSql = normalizeSql(traitCtes[0]!.sql);
    expect(cteSql).toContain(
      'SELECT profile_id, argMax(value, updated_at) AS value'
    );
    expect(cteSql).toContain(
      `FROM ${mocks.tables.profileTraits} WHERE project_id = 'regain-app' AND key = 'show_monthly_back_press_offer'`
    );
    expect(cteSql).toContain('GROUP BY profile_id');
  });

  it('buildFunnelCte preserves ft_<i>.ft_profile_id verbatim alongside trait CTEs', async () => {
    // End-to-end regression for the c54-launch-board funnel that crashed
    // with:
    //   Identifier 'ft_0.ft_events.profile_id' cannot be resolved from
    //   subquery with name ft_0. In scope session_funnel.
    //
    // Shape: step 1 has `firstTimeFilter: true` AND the funnel has a
    // trait breakdown (profile.properties.show_monthly_back_press_offer)
    // AND a trait filter (profile.properties.country = 'IN' becomes an
    // `IN (SELECT ... FROM profile_traits ...)` subquery inside step 1's
    // predicate). All three together trigger `needsQualify=true`, which
    // used to split `ft_0.ft_profile_id` → `ft_0.ft_events.profile_id`
    // via qualifyFunnelCondition's regex. The join alias is `ft_0` and
    // the CTE column is `ft_profile_id` — they must stay intact.
    const service = new FunnelService({} as any);
    const traitDescriptors = new Map([
      [
        'show_monthly_back_press_offer',
        {
          key: 'show_monthly_back_press_offer',
          cteName: 'trait_show_monthly_back_press_offer',
          column: 'trait_show_monthly_back_press_offer.value',
        },
      ],
    ]);

    const { query, firstTimeCtes } = service.buildFunnelCte({
      projectId: 'regain-app',
      startDate: '2026-03-18 00:00:00',
      endDate: '2026-04-18 00:00:00',
      eventSeries: [
        {
          id: 'KEbT',
          name: 'All New Users',
          displayName: 'All New Users',
          type: 'event',
          segment: 'event',
          firstTimeFilter: true,
          filters: [
            {
              id: 'OHHm',
              name: 'profile.properties.country',
              value: ['IN'],
              operator: 'is',
            },
            {
              id: 'aBFj',
              name: 'app_version',
              value: ['54.3.1571'],
              operator: 'is',
            },
          ],
          customEventComponents: [
            { eventName: 'New User Identify', filters: [] },
            { eventName: 'Started Mixpanel Tracking: Beginning', filters: [] },
            {
              eventName: 'Started Mixpanel Tracking: From Setup Completed',
              filters: [],
            },
          ],
        },
        {
          id: 'thYj',
          name: 'Subscription: Paywall Viewed',
          type: 'event',
          filters: [],
          segment: 'event',
        },
        {
          id: 'YYQT',
          name: 'Server: Purchase',
          type: 'event',
          filters: [],
          segment: 'event',
        },
      ] as any,
      funnelWindowMilliseconds: 604800000, // 7 days
      timezone: 'Asia/Calcutta',
      groupBy: 'profile_id',
      additionalSelects: ['trait_show_monthly_back_press_offer.value as b_0'],
      additionalGroupBy: ['b_0'],
      traitDescriptors,
    });

    const sql = normalizeSql(query.toSQL());

    // The first-time join must be registered against events.profile_id and
    // its predicate must stay `ft_0.ft_profile_id != ''` verbatim.
    expect(sql).toContain(
      `LEFT JOIN first_time_step_0 ft_0 ON ft_0.ft_profile_id = events.profile_id`
    );
    expect(sql).toContain("ft_0.ft_profile_id != ''");

    // The qualifier must not split `ft_profile_id` into `ft_` + `events.profile_id`.
    expect(sql).not.toContain('ft_0.ft_events.profile_id');
    expect(sql).not.toContain('ft_events.profile_id');

    // Step 1 condition still gets qualified where it should — event-name
    // references become `events.name = ...`, proving qualification is
    // running (so the preserved `ft_0.ft_profile_id` above isn't a
    // no-op from qualify being skipped entirely).
    expect(sql).toContain("events.name = 'New User Identify'");

    // And the inner trait subquery for the country filter stays bare —
    // its `profile_id` is bound to `profile_traits` inside the subquery.
    expect(sql).toContain('events.profile_id IN (SELECT profile_id FROM');
    expect(sql).not.toContain('SELECT events.profile_id FROM');

    // The first-time CTE itself is emitted at the top level.
    expect(firstTimeCtes).toHaveLength(1);
    expect(firstTimeCtes[0]!.name).toBe('first_time_step_0');
    expect(firstTimeCtes[0]!.sql).toContain(
      'SELECT profile_id as ft_profile_id'
    );
  });

  it('keeps the dateDiff per-user cap alongside the widened scan', async () => {
    // The per-user window cap is the only thing bounding cross-day
    // conversions once the scan is widened. If it ever goes away,
    // users could be attributed to a funnel entry weeks after they
    // actually viewed the paywall. Pin it.
    mocks.chQuery.mockResolvedValue([{ b_0: 'true', total_sum: 42 }]);

    const service = new FunnelService({} as any);
    await service.getFunnelPropertySums({
      ...prodFunnelMetricInput(service),
      funnelWindowSeconds: 15 * 60, // 15 minutes
    });

    const sql = getLastQuerySql();
    expect(sql).toContain(
      "dateDiff('second', s1.step_1_ts, e.created_at) <= 900"
    );
    expect(sql).toContain("addSeconds(toDateTime('2026-04-15 23:59:59'), 900)");
  });
});

const runClickHouseOutputTest =
  process.env.OPENPANEL_RUN_CLICKHOUSE_TESTS === '1' &&
  Boolean(process.env.OPENPANEL_TEST_CLICKHOUSE_URL);
const clickhouseUrl = process.env.OPENPANEL_TEST_CLICKHOUSE_URL;

describe.skipIf(!runClickHouseOutputTest)(
  'FunnelService.getFunnelPropertySums ClickHouse output',
  () => {
    let clickhouse: ClickHouseClient;

    beforeAll(async () => {
      clickhouse = createClient({ url: clickhouseUrl! });
      await recreateTables(clickhouse);
    });

    beforeEach(async () => {
      await clickhouse.command({
        query: `TRUNCATE TABLE ${mocks.tables.events}`,
      });
      await clickhouse.command({
        query: `TRUNCATE TABLE ${mocks.tables.profileTraits}`,
      });
      mocks.chQuery.mockReset();
      mocks.chQuery.mockImplementation(
        async (query: string, clickhouseSettings?: Record<string, unknown>) => {
          const res = await clickhouse.query({
            query,
            clickhouse_settings: {
              date_time_input_format: 'best_effort',
              ...clickhouseSettings,
            },
          });
          const json = await res.json<Record<string, any>>();
          return json.data.map((row) => ({
            ...row,
            total_sum:
              row.total_sum == null ? row.total_sum : Number(row.total_sum),
            property_average:
              row.property_average == null
                ? row.property_average
                : Number(row.property_average),
            property_count:
              row.property_count == null
                ? row.property_count
                : Number(row.property_count),
          }));
        }
      );
    });

    afterAll(async () => {
      if (!clickhouse) {
        return;
      }
      await clickhouse.command({
        query: `DROP TABLE IF EXISTS ${mocks.tables.events}`,
      });
      await clickhouse.command({
        query: `DROP TABLE IF EXISTS ${mocks.tables.profileTraits}`,
      });
      await clickhouse.close();
    });

    it('returns the same split as the seeded completing profiles', async () => {
      await seedFunnelMetricRows(clickhouse);

      const service = new FunnelService({} as any);
      const result = await service.getFunnelPropertySums(
        prodFunnelMetricInput(service)
      );

      expect(Object.fromEntries(result)).toEqual({
        false: 30,
        true: 90,
        'Not set': 5,
      });
    });

    it('applies the IST day boundary when timezone is Asia/Calcutta', async () => {
      // Regression for the 2026-04-15 bug: getFunnelPropertySums builds
      // unqualified `toDateTime('YYYY-MM-DD HH:MM:SS')` literals for
      // startDate/endDate and used to call chQuery without forwarding the
      // caller's timezone. ClickHouse then parsed the bare strings as UTC
      // and the query window silently shifted by +5:30h — excluding ~5.5h
      // of early-morning IST events for the target day and leaking in
      // 5.5h of the following IST day.
      //
      // Seeds three completing profiles around the 2026-04-14 IST boundary:
      //   p_ist_start — 2026-04-13 18:35 UTC (= 2026-04-14 00:05 IST)
      //                 → IN a correct IST window, OUT of a UTC window
      //   p_ist_mid   — 2026-04-14 12:00 UTC (= 2026-04-14 17:30 IST)
      //                 → IN both windows (sanity anchor)
      //   p_ist_after — 2026-04-14 19:00 UTC (= 2026-04-15 00:30 IST)
      //                 → OUT of a correct IST window, IN a UTC window
      //
      // With the timezone threaded through, the sum is 11 + 22 = 33 and
      // p_ist_after is excluded. If the pass-through is removed, CH parses
      // the window as UTC, the sum shifts to 22 + 99 = 121, and this
      // assertion fails — flagging the regression.
      await clickhouse.insert({
        table: mocks.tables.events,
        format: 'JSONEachRow',
        values: [
          eventRow(
            'p_ist_start',
            'Subscription: Paywall Viewed',
            '2026-04-13 18:35:00',
            '0'
          ),
          eventRow(
            'p_ist_start',
            'Subscription: Purchase Initiated',
            '2026-04-13 18:36:00',
            '0'
          ),
          eventRow(
            'p_ist_start',
            'Server: Purchase',
            '2026-04-13 18:37:00',
            '11'
          ),
          eventRow(
            'p_ist_mid',
            'Subscription: Paywall Viewed',
            '2026-04-14 12:00:00',
            '0'
          ),
          eventRow(
            'p_ist_mid',
            'Subscription: Purchase Initiated',
            '2026-04-14 12:01:00',
            '0'
          ),
          eventRow(
            'p_ist_mid',
            'Server: Purchase',
            '2026-04-14 12:02:00',
            '22'
          ),
          eventRow(
            'p_ist_after',
            'Subscription: Paywall Viewed',
            '2026-04-14 19:00:00',
            '0'
          ),
          eventRow(
            'p_ist_after',
            'Subscription: Purchase Initiated',
            '2026-04-14 19:01:00',
            '0'
          ),
          eventRow(
            'p_ist_after',
            'Server: Purchase',
            '2026-04-14 19:02:00',
            '99'
          ),
        ],
      });
      await clickhouse.insert({
        table: mocks.tables.profileTraits,
        format: 'JSONEachRow',
        values: [
          traitRow('p_ist_start', 'true'),
          traitRow('p_ist_mid', 'true'),
          traitRow('p_ist_after', 'true'),
        ],
      });

      const service = new FunnelService({} as any);
      const result = await service.getFunnelPropertySums({
        ...prodFunnelMetricInput(service),
        startDate: '2026-04-14 00:00:00',
        endDate: '2026-04-14 23:59:59',
      });

      expect(Object.fromEntries(result)).toEqual({ true: 33 });
    });

    it('captures conversions that occur after endDate but within funnelWindow', async () => {
      // Regression for the 2026-04-15 Mixpanel reconciliation: the C54
      // "Revenue" tile for "yesterday" silently dropped ~29 completers /
      // ~7,100 INR per day compared to Mixpanel. Root cause:
      // getFunnelPropertySums builds step_N CTEs whose WHERE clause scans
      //   e.created_at BETWEEN toDateTime(startDate) AND toDateTime(endDate)
      // for EVERY step (not just step_1). The intended
      //   dateDiff('second', s1.step_1_ts, e.created_at) <= funnelWindowSeconds
      // gate is never exercised, because the WHERE already clamps step_N to
      // the same day as step_1. Any user who views the paywall late in the
      // IST day and converts after midnight IST is excluded even when the
      // report's funnelWindow is 7 / 30 / any-large-N days. Mixpanel keeps
      // a forward-rolling window from step_1, so it captures these.
      //
      // Seeds one profile p_cross_day:
      //   Paywall Viewed      — 2026-04-14 11:30 UTC = 17:00 IST 04-14 (in window)
      //   Purchase Initiated  — 2026-04-14 11:35 UTC = 17:05 IST 04-14 (in window)
      //   Server: Purchase    — 2026-04-14 20:30 UTC = 02:00 IST 04-15 (OUT of
      //                         the IST day window, INSIDE the 30-day funnelWindow)
      //
      // Expected after fix: step_N's WHERE clause extends to
      // endDate + funnelWindowSeconds so the purchase lands → { true: 299 }.
      // With the current bug, step_3 scan excludes the purchase → {}.
      await clickhouse.insert({
        table: mocks.tables.events,
        format: 'JSONEachRow',
        values: [
          eventRow(
            'p_cross_day',
            'Subscription: Paywall Viewed',
            '2026-04-14 11:30:00',
            '0'
          ),
          eventRow(
            'p_cross_day',
            'Subscription: Purchase Initiated',
            '2026-04-14 11:35:00',
            '0'
          ),
          eventRow(
            'p_cross_day',
            'Server: Purchase',
            '2026-04-14 20:30:00',
            '299'
          ),
        ],
      });
      await clickhouse.insert({
        table: mocks.tables.profileTraits,
        format: 'JSONEachRow',
        values: [traitRow('p_cross_day', 'true')],
      });

      const service = new FunnelService({} as any);
      const result = await service.getFunnelPropertySums({
        ...prodFunnelMetricInput(service),
        startDate: '2026-04-14 00:00:00',
        endDate: '2026-04-14 23:59:59',
      });

      expect(Object.fromEntries(result)).toEqual({ true: 299 });
    });

    it('buckets a later-step breakdown (breakdownStep=1) correctly when step 2 lands after endDate', async () => {
      // Regression: the first draft of the cross-day fix widened step_2..N
      // and prop_vals, but left prop_bd scoped to the report range. When
      // breakdownStep > 0, prop_bd is where the breakdown value is
      // extracted from the chosen step's event via argMaxIf. For a user
      // whose step 2 lands on 2026-04-15 IST, the argMaxIf source was
      // missing from prop_bd, so b_0 became NULL and the sum got silently
      // re-bucketed from the expected breakdown into "Not set" — exactly
      // the failure mode the earlier Mixpanel reconciliation was tracking.
      //
      // Seeds two profiles with breakdownStep=1 (step 2 = Purchase
      // Initiated) as an event-property breakdown. Step 1 lives late in
      // the IST day, step 2 *and* step 3 land across the IST boundary so
      // prop_bd's WHERE clause is the only thing deciding whether the
      // breakdown value is visible:
      //
      //   p_step2_a — paywall at 18:25 UTC (23:55 IST 04-14, in window)
      //               step 2 (Purchase Initiated) at 18:35 UTC
      //                 = 00:05 IST 04-15, step_bucket="a"
      //               Server: Purchase at 18:45 UTC
      //                 = 00:15 IST 04-15, value_inr=299
      //   p_step2_b — paywall at 18:26 UTC (23:56 IST 04-14, in window)
      //               step 2 at 18:36 UTC = 00:06 IST 04-15, step_bucket="b"
      //               Server: Purchase at 18:46 UTC = 00:16 IST 04-15, 99
      //
      // Correct post-fix: { a: 299, b: 99 }.
      // With prop_bd still on [startDate, endDate]: { 'Not set': 398 }.
      await clickhouse.insert({
        table: mocks.tables.events,
        format: 'JSONEachRow',
        values: [
          eventRow(
            'p_step2_a',
            'Subscription: Paywall Viewed',
            '2026-04-14 18:25:00',
            '0'
          ),
          stepBucketRow(
            'p_step2_a',
            'Subscription: Purchase Initiated',
            '2026-04-14 18:35:00',
            'a'
          ),
          eventRow(
            'p_step2_a',
            'Server: Purchase',
            '2026-04-14 18:45:00',
            '299'
          ),
          eventRow(
            'p_step2_b',
            'Subscription: Paywall Viewed',
            '2026-04-14 18:26:00',
            '0'
          ),
          stepBucketRow(
            'p_step2_b',
            'Subscription: Purchase Initiated',
            '2026-04-14 18:36:00',
            'b'
          ),
          eventRow(
            'p_step2_b',
            'Server: Purchase',
            '2026-04-14 18:46:00',
            '99'
          ),
        ],
      });

      const service = new FunnelService({} as any);
      const result = await service.getFunnelPropertySums({
        ...prodFunnelMetricInput(service),
        startDate: '2026-04-14 00:00:00',
        endDate: '2026-04-14 23:59:59',
        breakdowns: [{ name: 'properties.step_bucket' }],
        breakdownStep: 1,
      });

      expect(Object.fromEntries(result)).toEqual({ a: 299, b: 99 });
    });
  }
);

async function recreateTables(clickhouse: ClickHouseClient) {
  await clickhouse.command({
    query: `DROP TABLE IF EXISTS ${mocks.tables.events}`,
  });
  await clickhouse.command({
    query: `DROP TABLE IF EXISTS ${mocks.tables.profileTraits}`,
  });
  await clickhouse.command({
    query: `
      CREATE TABLE ${mocks.tables.events} (
        project_id String,
        profile_id String,
        device_id String,
        session_id String,
        name String,
        properties Map(String, String),
        created_at DateTime64(3)
      ) ENGINE = Memory
    `,
  });
  await clickhouse.command({
    query: `
      CREATE TABLE ${mocks.tables.profileTraits} (
        project_id String,
        profile_id String,
        key String,
        value String,
        updated_at DateTime64(3)
      ) ENGINE = Memory
    `,
  });
}

async function seedFunnelMetricRows(clickhouse: ClickHouseClient) {
  await clickhouse.insert({
    table: mocks.tables.events,
    format: 'JSONEachRow',
    values: [
      eventRow(
        'p_false',
        'Subscription: Paywall Viewed',
        '2026-04-15 00:01:00',
        '0'
      ),
      eventRow(
        'p_false',
        'Subscription: Purchase Initiated',
        '2026-04-15 00:02:00',
        '0'
      ),
      eventRow('p_false', 'Server: Purchase', '2026-04-15 00:03:00', '30'),
      eventRow(
        'p_true_1',
        'Subscription: Paywall Viewed',
        '2026-04-15 01:01:00',
        '0'
      ),
      eventRow(
        'p_true_1',
        'Subscription: Purchase Initiated',
        '2026-04-15 01:02:00',
        '0'
      ),
      eventRow('p_true_1', 'Server: Purchase', '2026-04-15 01:03:00', '70'),
      eventRow(
        'p_true_2',
        'Subscription: Paywall Viewed',
        '2026-04-15 02:01:00',
        '0'
      ),
      eventRow(
        'p_true_2',
        'Subscription: Purchase Initiated',
        '2026-04-15 02:02:00',
        '0'
      ),
      eventRow('p_true_2', 'Server: Purchase', '2026-04-15 02:03:00', '20'),
      eventRow(
        'p_not_set',
        'Subscription: Paywall Viewed',
        '2026-04-15 03:01:00',
        '0'
      ),
      eventRow(
        'p_not_set',
        'Subscription: Purchase Initiated',
        '2026-04-15 03:02:00',
        '0'
      ),
      eventRow('p_not_set', 'Server: Purchase', '2026-04-15 03:03:00', '5'),
      eventRow(
        'p_incomplete',
        'Subscription: Paywall Viewed',
        '2026-04-15 04:01:00',
        '0'
      ),
      eventRow(
        'p_incomplete',
        'Subscription: Purchase Initiated',
        '2026-04-15 04:02:00',
        '0'
      ),
    ],
  });

  await clickhouse.insert({
    table: mocks.tables.profileTraits,
    format: 'JSONEachRow',
    values: [
      traitRow('p_false', 'false'),
      traitRow('p_true_1', 'true'),
      traitRow('p_true_2', 'true'),
      traitRow('p_incomplete', 'false'),
    ],
  });
}

function eventRow(
  profileId: string,
  name: string,
  createdAt: string,
  valueInr: string
) {
  return {
    project_id: prodFunnelMetricReport.projectId,
    profile_id: profileId,
    device_id: `device_${profileId}`,
    session_id: `session_${profileId}`,
    name,
    properties: {
      paywallVariant:
        name === 'Subscription: Paywall Viewed' ? 'CHOOSE_A_PLAN' : '',
      value_inr: valueInr,
    },
    created_at: createdAt,
  };
}

function traitRow(profileId: string, value: string) {
  return {
    project_id: prodFunnelMetricReport.projectId,
    profile_id: profileId,
    key: 'show_monthly_back_press_offer',
    value,
    updated_at: '2026-04-15 00:00:00',
  };
}

// Event row tagged with a `step_bucket` property — used by the later-step
// breakdown regression test to attribute a cross-day conversion via
// `breakdownStep: 1` + `breakdowns: [{ name: 'properties.step_bucket' }]`.
function stepBucketRow(
  profileId: string,
  name: string,
  createdAt: string,
  bucket: string
) {
  return {
    project_id: prodFunnelMetricReport.projectId,
    profile_id: profileId,
    device_id: `device_${profileId}`,
    session_id: `session_${profileId}`,
    name,
    properties: {
      paywallVariant:
        name === 'Subscription: Paywall Viewed' ? 'CHOOSE_A_PLAN' : '',
      value_inr: '0',
      step_bucket: bucket,
    },
    created_at: createdAt,
  };
}

function getLastQuerySql() {
  return normalizeSql(String(mocks.chQuery.mock.calls.at(-1)?.[0] ?? ''));
}

function prodFunnelMetricInput(
  service: FunnelService,
  overrides: {
    events?: typeof prodFunnelMetricReport.events;
  } = {}
) {
  const events = overrides.events ?? prodFunnelMetricReport.events;
  return {
    projectId: prodFunnelMetricReport.projectId,
    startDate: '2026-04-15 00:00:00',
    endDate: '2026-04-15 23:59:59',
    stepConditions: service.getFunnelConditions(
      events as any,
      prodFunnelMetricReport.projectId
    ),
    funnelWindowSeconds: 30 * 86400,
    groupBy: 'profile_id' as const,
    allEventNames: events.map((event) => event.name),
    propertyKey: prodFunnelMetricReport.options.funnelProperty,
    breakdowns: prodFunnelMetricReport.breakdowns,
    breakdownStep: prodFunnelMetricReport.options.breakdownStep,
    timezone: 'Asia/Calcutta',
  };
}

describe('FunnelService.isMvEligibleFunnel', () => {
  const originalDisabled = process.env.OP_FUNNEL_MV_DISABLED;
  const originalStale = process.env.OP_FUNNEL_MV_MAX_STALENESS_HOURS;

  beforeEach(() => {
    delete process.env.OP_FUNNEL_MV_DISABLED;
    delete process.env.OP_FUNNEL_MV_MAX_STALENESS_HOURS;
    mocks.chQuery.mockReset();
    // Default: MV covers brainrot-app from 2026-04-01, fresh (0h stale)
    mocks.chQuery.mockResolvedValue([
      {
        project_id: 'brainrot-app',
        min_day: '2026-04-01',
        max_day: '2026-07-15',
        staleness_hours: 0,
      },
    ]);
  });

  afterAll(() => {
    if (originalDisabled === undefined) delete process.env.OP_FUNNEL_MV_DISABLED;
    else process.env.OP_FUNNEL_MV_DISABLED = originalDisabled;
    if (originalStale === undefined)
      delete process.env.OP_FUNNEL_MV_MAX_STALENESS_HOURS;
    else process.env.OP_FUNNEL_MV_MAX_STALENESS_HOURS = originalStale;
  });

  const simpleFunnel: any = {
    eventSeries: [
      { name: 'Application Installed', filters: [], segment: 'event' },
      { name: 'Counter Bubble: Shown', filters: [], segment: 'event' },
    ],
    breakdowns: [],
    groupBy: 'profile_id' as const,
    anyFilterOnProfile: false,
    anyBreakdownOnProfile: false,
    projectId: 'brainrot-app',
    traitDescriptors: new Map(),
    startDate: '2026-06-15 00:00:00',
  };

  it('accepts a simple 2-step funnel when MV has coverage', async () => {
    const s = new FunnelService({} as any);
    expect(await s.isMvEligibleFunnel(simpleFunnel)).toBe(true);
  });

  it('honors global kill switch OP_FUNNEL_MV_DISABLED=1', async () => {
    process.env.OP_FUNNEL_MV_DISABLED = '1';
    const s = new FunnelService({} as any);
    expect(await s.isMvEligibleFunnel(simpleFunnel)).toBe(false);
  });

  it('rejects projects the MV has no data for', async () => {
    const s = new FunnelService({} as any);
    expect(
      await s.isMvEligibleFunnel({ ...simpleFunnel, projectId: 'regain-app' })
    ).toBe(false);
  });

  it('rejects when query range predates MV backfill', async () => {
    const s = new FunnelService({} as any);
    // MV covers 2026-04-01 → 2026-07-15; asking for 2026-01-01 is out of range
    expect(
      await s.isMvEligibleFunnel({
        ...simpleFunnel,
        startDate: '2026-01-01 00:00:00',
      })
    ).toBe(false);
  });

  it('rejects when MV writer is stalled beyond staleness limit', async () => {
    mocks.chQuery.mockReset();
    mocks.chQuery.mockResolvedValue([
      {
        project_id: 'brainrot-app',
        min_day: '2026-04-01',
        max_day: '2026-07-10',
        staleness_hours: 120, // 5 days stale
      },
    ]);
    const s = new FunnelService({} as any);
    expect(await s.isMvEligibleFunnel(simpleFunnel)).toBe(false);
  });

  it('falls back safely when MV table does not exist', async () => {
    mocks.chQuery.mockReset();
    mocks.chQuery.mockRejectedValue(new Error('UNKNOWN_TABLE'));
    const s = new FunnelService({} as any);
    expect(await s.isMvEligibleFunnel(simpleFunnel)).toBe(false);
  });

  it('rejects session-mode funnels (MV is per-profile)', async () => {
    const s = new FunnelService({} as any);
    expect(
      await s.isMvEligibleFunnel({
        ...simpleFunnel,
        groupBy: 'session_id' as const,
      })
    ).toBe(false);
  });

  it('rejects step with per-event property filter (properties.*)', async () => {
    const s = new FunnelService({} as any);
    expect(
      await s.isMvEligibleFunnel({
        ...simpleFunnel,
        eventSeries: [
          {
            name: 'Application Installed',
            filters: [
              { name: 'properties.source', value: ['x'], operator: 'is' },
            ],
            segment: 'event',
          },
          simpleFunnel.eventSeries[1],
        ],
      })
    ).toBe(false);
  });

  it('accepts step with whitelisted top-level filter (app_version)', async () => {
    const s = new FunnelService({} as any);
    expect(
      await s.isMvEligibleFunnel({
        ...simpleFunnel,
        eventSeries: [
          {
            name: 'Application Installed',
            filters: [
              { name: 'app_version', value: ['9.8.415'], operator: 'is' },
            ],
            segment: 'event',
          },
          simpleFunnel.eventSeries[1],
        ],
      })
    ).toBe(true);
  });

  it('accepts step with whitelisted top-level filter (country)', async () => {
    const s = new FunnelService({} as any);
    expect(
      await s.isMvEligibleFunnel({
        ...simpleFunnel,
        eventSeries: [
          {
            name: 'Application Installed',
            filters: [{ name: 'country', value: ['IN'], operator: 'is' }],
            segment: 'event',
          },
          simpleFunnel.eventSeries[1],
        ],
      })
    ).toBe(true);
  });

  it('rejects non-whitelisted top-level filter (os_version)', async () => {
    const s = new FunnelService({} as any);
    expect(
      await s.isMvEligibleFunnel({
        ...simpleFunnel,
        eventSeries: [
          {
            name: 'Application Installed',
            filters: [{ name: 'os_version', value: ['14'], operator: 'is' }],
            segment: 'event',
          },
          simpleFunnel.eventSeries[1],
        ],
      })
    ).toBe(false);
  });

  it('rejects step with firstTimeFilter', async () => {
    const s = new FunnelService({} as any);
    expect(
      await s.isMvEligibleFunnel({
        ...simpleFunnel,
        eventSeries: [
          { ...simpleFunnel.eventSeries[0], firstTimeFilter: true },
          simpleFunnel.eventSeries[1],
        ],
      })
    ).toBe(false);
  });

  it('rejects custom event with per-component filter', async () => {
    const s = new FunnelService({} as any);
    expect(
      await s.isMvEligibleFunnel({
        ...simpleFunnel,
        eventSeries: [
          simpleFunnel.eventSeries[0],
          {
            name: 'custom',
            filters: [],
            segment: 'event',
            customEventComponents: [
              {
                eventName: 'Counter Bubble: Shown',
                filters: [{ name: 'properties.x', value: [1], operator: 'is' }],
              },
            ],
          },
        ],
      })
    ).toBe(false);
  });

  it('rejects funnel with event-property breakdown (properties.*)', async () => {
    const s = new FunnelService({} as any);
    expect(
      await s.isMvEligibleFunnel({
        ...simpleFunnel,
        breakdowns: [{ name: 'properties.country' }],
      })
    ).toBe(false);
  });

  it('accepts whitelisted top-level breakdown (app_version)', async () => {
    const s = new FunnelService({} as any);
    expect(
      await s.isMvEligibleFunnel({
        ...simpleFunnel,
        breakdowns: [{ name: 'app_version' }],
      })
    ).toBe(true);
  });

  it('rejects when profile filters/breakdowns require profiles FINAL join', async () => {
    const s = new FunnelService({} as any);
    expect(
      await s.isMvEligibleFunnel({ ...simpleFunnel, anyFilterOnProfile: true })
    ).toBe(false);
    expect(
      await s.isMvEligibleFunnel({
        ...simpleFunnel,
        anyBreakdownOnProfile: true,
      })
    ).toBe(false);
  });
});

describe('FunnelService.buildFunnelCteFromMv', () => {
  it('generates a windowFunnel over the MV via arrayJoin(min, max)', () => {
    const s = new FunnelService({} as any);
    const { sql, firstTimeCtes, traitCtes } = s.buildFunnelCteFromMv({
      projectId: 'brainrot-app',
      startDate: '2026-06-15 00:00:00',
      endDate: '2026-07-16 00:00:00',
      eventSeries: [
        { name: 'Application Installed', filters: [], segment: 'event' } as any,
        {
          name: 'All Active Users Events',
          filters: [],
          segment: 'event',
          customEventComponents: [
            { eventName: 'Counter Bubble: Shown', filters: [] },
            { eventName: 'Counter Bubble Pulse: Shown', filters: [] },
          ],
        } as any,
      ],
      funnelWindowMilliseconds: 86400000,
    });
    const normalized = normalizeSql(sql);
    expect(firstTimeCtes).toEqual([]);
    expect(traitCtes).toEqual([]);
    expect(normalized).toContain('FROM event_profile_firsts_local');
    expect(normalized).toContain(
      "arrayJoin([min_created_at_identified, max_created_at_identified]) AS ts"
    );
    // MV subquery must project whitelisted top-level cols so step-condition
    // filters like `app_version = '9.8.415'` resolve to real column refs.
    expect(normalized).toContain(
      'SELECT project_id, name, profile_id, app_version, country,'
    );
    expect(normalized).toContain(
      "windowFunnel(86400000, 'strict_increase')"
    );
    expect(normalized).toContain('toUInt64(toUnixTimestamp64Milli(ts))');
    // Step 1 anchored to [startDate, endDate]
    expect(normalized).toContain(
      "ts >= toDateTime64('2026-06-15 00:00:00', 3)"
    );
    expect(normalized).toContain(
      "ts <= toDateTime64('2026-07-16 00:00:00', 3)"
    );
    // Custom-event OR-clause preserved
    expect(normalized).toContain("name = 'Counter Bubble: Shown'");
    expect(normalized).toContain("name = 'Counter Bubble Pulse: Shown'");
    // Extended outer bound (endDate + windowSeconds) so cross-day step-2 events land
    expect(normalized).toContain(
      "ts <= addSeconds(toDateTime64('2026-07-16 00:00:00', 3), 86400)"
    );
    // Day partition prune
    expect(normalized).toContain(
      "day BETWEEN toDate('2026-06-15 00:00:00') AND addDays(toDate('2026-07-16 00:00:00'), 1)"
    );
    // MV zero-sentinel filter (unidentified rows have min_..._identified = 0)
    expect(normalized).toContain(
      "min_created_at_identified > toDateTime64('1970-01-02', 3)"
    );
  });

  it('throws on zero-step input', () => {
    const s = new FunnelService({} as any);
    expect(() =>
      s.buildFunnelCteFromMv({
        projectId: 'brainrot-app',
        startDate: '2026-06-15 00:00:00',
        endDate: '2026-07-16 00:00:00',
        eventSeries: [],
        funnelWindowMilliseconds: 86400000,
      })
    ).toThrow(/at least one step/);
  });
});

describe('FunnelService.getFunnelTimingStatsFromMv (MV timing path)', () => {
  beforeEach(() => {
    mocks.chQuery.mockReset();
    mocks.chQuery.mockResolvedValue([{ step_1_median: 42 }]);
  });

  const timingInput = {
    projectId: 'brainrot-app',
    startDate: '2026-06-15 00:00:00',
    endDate: '2026-07-16 00:00:00',
    funnelWindowSeconds: 86400,
    allEventNames: ['Application Installed', 'Counter Bubble: Shown'],
    timezone: 'UTC',
  };

  it('returns empty map for <2 step conditions', async () => {
    const s = new FunnelService({} as any);
    const r = await (s as any).getFunnelTimingStatsFromMv({
      ...timingInput,
      stepConditions: ["name = 'Application Installed'"],
    });
    expect(r.size).toBe(0);
    expect(mocks.chQuery).not.toHaveBeenCalled();
  });

  it('generates chained CTEs sourced from mv_events with arrayJoin', async () => {
    const s = new FunnelService({} as any);
    await (s as any).getFunnelTimingStatsFromMv({
      ...timingInput,
      stepConditions: [
        "name = 'Application Installed'",
        "name = 'Counter Bubble: Shown'",
      ],
    });

    const sql = normalizeSql(String(mocks.chQuery.mock.calls[0]?.[0] ?? ''));
    // Base MV CTE with arrayJoin
    expect(sql).toContain('mv_events AS');
    expect(sql).toContain(
      'arrayJoin([min_created_at_identified, max_created_at_identified]) AS ts'
    );
    expect(sql).toContain('FROM event_profile_firsts_local');
    // step_1 anchored to report range
    expect(sql).toContain('step_1 AS');
    expect(sql).toContain('min(ts) as step_1_ts');
    expect(sql).toContain("ts >= toDateTime64('2026-06-15 00:00:00', 3)");
    expect(sql).toContain("ts <= toDateTime64('2026-07-16 00:00:00', 3)");
    // step_2 chained + funnel window gate
    expect(sql).toContain('step_2 AS');
    expect(sql).toContain('e.ts > prev.step_1_ts');
    expect(sql).toContain("dateDiff('second', s1.step_1_ts, e.ts) <= 86400");
    // Median select
    expect(sql).toContain('quantileTDigestIf(0.5)');
    expect(sql).toContain('step_1_median');
  });

  it('rewrites created_at refs in step conditions to ts', async () => {
    const s = new FunnelService({} as any);
    await (s as any).getFunnelTimingStatsFromMv({
      ...timingInput,
      // Simulate a step condition emitted by getFunnelConditions that
      // includes a created_at reference (the step-1 anchor injection).
      stepConditions: [
        "(name = 'Application Installed') AND created_at >= toDateTime('2026-06-15')",
        "name = 'Counter Bubble: Shown'",
      ],
    });
    const sql = normalizeSql(String(mocks.chQuery.mock.calls[0]?.[0] ?? ''));
    // The `created_at` in the step-1 condition must be rewritten to `ts`
    // — otherwise the mv_events subquery (which doesn't expose created_at)
    // would fail with UNKNOWN_IDENTIFIER.
    expect(sql).toContain('ts >= toDateTime');
    expect(sql).not.toMatch(/step_1 AS[^)]*created_at\s*>=/);
  });
});
