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
    sessions: 'sessions',
    events_imports: 'events_imports',
    session_replay_chunks: 'session_replay_chunks',
  },
}));

vi.mock('../prisma-client', () => ({
  db: {},
}));

import { FunnelService } from './funnel.service';

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
