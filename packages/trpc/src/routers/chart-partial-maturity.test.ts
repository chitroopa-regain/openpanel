import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { processCohortData } from './chart';
import { attachAcquisitionCost, type SpendRow } from './chart-acquisition-cost';
import {
  aggregateRetentionRowsByDisplayInterval,
  getRetentionIntervalMaturityExpression,
  getRetentionMaturedIntervalsExpression,
} from './chart-retention.utils';

const daily = (
  day: number,
  mature: boolean,
  value = 10,
  size = 100,
  breakdown = 'google'
) => ({
  cohort_interval: `2026-09-${String(day).padStart(2, '0')}`,
  display_interval: '2026-09-01',
  total_first_event_count: size,
  matured_intervals: mature ? 7 : 6,
  // Deliberately non-null immature input: guard must exclude BOTH sides.
  interval_7_user_count: value,
  b_0: breakdown,
  roas_rev_d0: 1,
  roas_rev_d7: mature ? value * size : null,
  roas_rev_d30: null,
  roas_rev_lifetime: value * size,
});
const monthly = (
  rows: ReturnType<typeof daily>[],
  metric = 'property_average'
) => processCohortData(rows, 7, undefined, undefined, 'month', 'day', metric);
const spend = (day: number, amount: number): SpendRow => ({
  day: `2026-09-${String(day).padStart(2, '0')}`,
  platform: 'google_ads',
  campaign_id: 'g1',
  campaign_name: 'Google',
  os: 'android',
  spend_inr: amount,
});

describe('partial monthly maturity contract', () => {
  it('September on Oct 6 uses Sep 1..28, not the whole monthly population', () => {
    const result = monthly(
      Array.from({ length: 30 }, (_, i) =>
        daily(i + 1, i < 28, i < 28 ? 10 : 900, i < 28 ? 100 : 9000)
      )
    );
    for (const row of result) {
      expect(row.values[7]).toBe(10);
      expect(row.valueWeights?.[7]).toBe(2800);
      expect(row.coverage?.[7]).toEqual({ eligible: 28, total: 30 });
    }
  });

  it('keeps real zeros, null when none eligible, and full coverage when all finish', () => {
    for (const [matureCount, expected] of [
      [0, null],
      [1, 0],
      [2, 0],
    ] as const) {
      for (const row of monthly([
        daily(29, matureCount > 0, 0),
        daily(30, matureCount > 1, 0),
      ])) {
        expect(row.values[7]).toBe(expected);
        expect(row.coverage?.[7]).toEqual({ eligible: matureCount, total: 2 });
      }
    }
  });

  it('uses per-cell denominator for rate, property-average summaries and independent breakdowns', () => {
    const a = daily(1, true, 10, 100, 'A');
    const a2 = daily(30, false, 999, 900, 'A');
    const b = daily(1, true, 0, 300, 'B');
    const result = monthly([a, a2, b]);
    expect(
      result
        .filter((r) => r.cohort_interval === 'Weighted Average')
        .map((r) => [r.breakdowns[0], r.values[7], r.valueWeights?.[7]])
    ).toEqual([
      ['A', 10, 100],
      ['B', 0, 300],
    ]);
    const august = {
      ...daily(1, true, 20, 300),
      cohort_interval: '2026-08-01',
      display_interval: '2026-08-01',
    };
    expect(
      monthly([daily(1, true), daily(30, false, 999, 900), august])[0]
        ?.values[7]
    ).toBe(17.5);
    const rate = monthly(
      [daily(1, true, 10, 100), daily(30, false, 999, 900)],
      'retention_rate'
    );
    expect(rate[0]?.percentages[7]).toBe(0.1);
  });

  it('counts completed cohorts with no returners as completed, not immature', () => {
    const a = { ...daily(1, true, 10), interval_7_denominator_count: 2 };
    const b = {
      ...daily(2, true),
      interval_7_user_count: null,
      interval_7_denominator_count: 0,
    };
    const result = processCohortData(
      [a, b],
      7,
      undefined,
      undefined,
      'month',
      'day',
      'property_average'
    );
    for (const row of result) {
      expect(row.values[7]).toBe(10);
      expect(row.valueWeights?.[7]).toBe(2);
      expect(row.coverage?.[7]).toEqual({ eligible: 2, total: 2 });
    }
  });

  it('matches ROAS revenue to actual daily spend (not monthly spend or a day-count fraction)', () => {
    const data = monthly([
      daily(28, true, 2, 100),
      daily(29, false, 99, 900),
      daily(30, false, 99, 900),
    ]);
    const { rows } = attachAcquisitionCost(
      data,
      [spend(28, 50), spend(29, 900), spend(30, 50)],
      { interval: 'month', attribution: null }
    );
    for (const row of rows) {
      expect(row.roas?.d7).toBe(4);
      expect(row.roas?.d30).toBeNull();
      expect(row.roas?.coverage?.d7).toEqual({ eligible: 1, total: 3 });
      expect(row.spend).toBe(1000); // spend/CPI remain the full displayed period
    }
  });

  it('preserves lifetime spend on dates without an install cohort', () => {
    const data = monthly([daily(1, true, 2, 100), daily(30, false, 1, 100)]);
    const { rows } = attachAcquisitionCost(
      data,
      [spend(1, 100), spend(15, 1000), spend(30, 900)],
      { interval: 'month', attribution: null }
    );
    for (const row of rows) {
      expect(row.spend).toBe(2000);
      expect(row.roas?.lifetime).toBe(0.15); // 300 revenue / all 2000 spend
    }
  });

  it('uses daily whole-population shares for top-N/non-attribution breakdown ROAS', () => {
    const data = monthly([
      daily(28, true, 2, 25, 'variant'),
      daily(29, false, 99, 900, 'variant'),
    ]);
    const { rows } = attachAcquisitionCost(
      data,
      [spend(28, 100), spend(29, 900)],
      {
        interval: 'month',
        attribution: null,
        overallSums: new Map([['2026-09-01', 2000]]),
        overallDailySums: new Map([
          ['2026-09-28', 100],
          ['2026-09-29', 1900],
        ]),
      }
    );
    expect(rows[1]?.roas?.d7).toBe(2); // 50 revenue / (100 spend * 25/100)
    expect(rows[0]?.roas?.d7).toBe(2);
  });

  it('preserves live D0 in display cells while excluding only today from the summary', () => {
    const input = [
      {
        cohort_interval: '2026-09-29',
        display_interval: '2026-09-01',
        sum: 10,
        values: [0],
        percentages: [0],
        revenue: { d0: 10, d7: null, d30: null, lifetime: 10 },
      },
      {
        cohort_interval: '2026-09-30',
        display_interval: '2026-09-01',
        sum: 10,
        values: [0],
        percentages: [0],
        revenue: { d0: 90, d7: null, d30: null, lifetime: 90, d0Partial: true },
      },
    ];
    const cohort = aggregateRetentionRowsByDisplayInterval(input, 'sum')[0]!;
    const { rows } = attachAcquisitionCost(
      [{ cohort_interval: 'Weighted Average', sum: 20 }, cohort],
      [spend(29, 20), spend(30, 100)],
      { interval: 'month', attribution: null }
    );
    expect(rows[1]?.roas?.d0).toBe(0.833);
    expect(rows[1]?.roas?.partial).toEqual(['d0']);
    expect(rows[0]?.roas?.d0).toBe(0.5);
    expect(rows[0]?.roas?.coverage?.d0).toEqual({ eligible: 1, total: 2 });
  });

  it('generates completed-day D7 guards and retains live D0', () => {
    const args = {
      unit: 'day' as const,
      cohortExpression: 'c',
      asOfExpression: 'today_ist',
    };
    expect(getRetentionIntervalMaturityExpression({ ...args, index: 7 })).toBe(
      'addDays(c, 8) <= today_ist'
    );
    expect(getRetentionIntervalMaturityExpression({ ...args, index: 0 })).toBe(
      'addDays(c, 0) <= today_ist'
    );
    expect(getRetentionMaturedIntervalsExpression(args)).toBe(
      "if(dateDiff('day', c, today_ist) >= 0, greatest(0, dateDiff('day', c, today_ist) - 1), -1)"
    );
  });

  it.skipIf(process.env.RUN_CLICKHOUSE_MATURITY !== '1')(
    'executes generated SQL across local-midnight boundaries in isolated ClickHouse',
    () => {
      const args = {
        unit: 'day' as const,
        cohortExpression: "toDate('2026-09-29')",
        asOfExpression: "toDate(toDateTime(ts, 'UTC'), 'Asia/Calcutta')",
      };
      const query = `SELECT ts, ${getRetentionIntervalMaturityExpression({ ...args, index: 7 })} AS eligible, ${getRetentionMaturedIntervalsExpression(args)} AS horizon FROM (SELECT arrayJoin(['2026-10-05 18:30:00','2026-10-06 18:29:59','2026-10-06 18:30:00']) AS ts) FORMAT JSONEachRow`;
      const output = execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '--entrypoint',
          'clickhouse',
          'clickhouse/clickhouse-server:25.12',
          'local',
          '--query',
          query,
        ],
        { encoding: 'utf8' }
      );
      expect(
        output
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      ).toEqual([
        { ts: '2026-10-05 18:30:00', eligible: 0, horizon: 6 },
        { ts: '2026-10-06 18:29:59', eligible: 0, horizon: 6 },
        { ts: '2026-10-06 18:30:00', eligible: 1, horizon: 7 },
      ]);
    }
  );
});
