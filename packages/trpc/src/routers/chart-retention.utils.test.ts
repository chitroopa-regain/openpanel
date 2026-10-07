import { describe, expect, it } from 'vitest';
import { processCohortData } from './chart';
import {
  addRoasRevenue,
  aggregateRetentionRowsByDisplayInterval,
  buildRoasRevenueSelects,
  getRetentionDateBounds,
  getRetentionQuerySettings,
  buildRetentionBreakdownSelects,
  buildRetentionFirstTimeCteSql,
  buildRetentionMeasureIntervalSelect,
  getConcreteEventNameWhereClause,
  getRetentionElapsedIntervalExpression,
  getRetentionIntervalMaturityExpression,
  getRetentionMaturedIntervalsExpression,
  getRetentionMeasurePropertyExpression,
  getRetentionReturnEventWhereClause,
  getRetentionTimeUnitConfig,
  groupRetentionRowsByBreakdowns,
  isWildcardEventSelection,
} from './chart-retention.utils';

describe('chart retention utils', () => {
  it('excludes the unmatched LEFT JOIN row from opted-in D0 counts', () => {
    expect(
      buildRetentionMeasureIntervalSelect({
        index: 0,
        criteria: '=',
        excludeEmptyProfiles: true,
        maturityExpression: 'cohort_has_started',
      })
    ).toBe(
      "if(cohort_has_started, uniqExactIf(r.profile_id, r.profile_id != '' AND r.x_after_cohort = 0), NULL) AS interval_0_user_count"
    );
    expect(
      buildRetentionMeasureIntervalSelect({ index: 0, criteria: '=' })
    ).toBe(
      'uniqExactIf(r.profile_id, r.x_after_cohort = 0) AS interval_0_user_count'
    );
  });

  it('uses rolling elapsed windows instead of calendar week boundaries', () => {
    expect(
      getRetentionElapsedIntervalExpression('week', 'cohort_date', 'event_date')
    ).toBe("intDiv(dateDiff('DAY', cohort_date, event_date), 7)");
    expect(
      getRetentionElapsedIntervalExpression(
        'month',
        'cohort_date',
        'event_date'
      )
    ).toBe(
      "dateDiff('MONTH', cohort_date, event_date) - if(event_date < addMonths(cohort_date, dateDiff('MONTH', cohort_date, event_date)), 1, 0)"
    );
  });

  it('builds interval maturity checks in the selected conversion-window unit', () => {
    expect(
      getRetentionIntervalMaturityExpression({
        index: 2,
        unit: 'week',
        cohortExpression: 'cs.cohort_interval',
        asOfExpression: "today('Asia/Calcutta')",
      })
    ).toBe("addWeeks(cs.cohort_interval, 2) <= today('Asia/Calcutta')");
  });

  it('preserves immature intervals as null and excludes them from weighted averages', () => {
    const result = processCohortData(
      [
        {
          cohort_interval: '2026-07-25',
          total_first_event_count: 10,
          interval_0_user_count: 5,
          interval_1_user_count: 0,
        },
        {
          cohort_interval: '2026-07-26',
          total_first_event_count: 20,
          interval_0_user_count: 10,
          interval_1_user_count: null,
        },
      ],
      1
    );

    expect(result[0]?.percentages).toEqual([0.5, 0]);
    expect(result[2]?.values).toEqual([10, null]);
    expect(result[2]?.percentages).toEqual([0.5, null]);
  });

  it('preserves mature weights through mixed display and conversion intervals', () => {
    const result = processCohortData(
      [
        {
          cohort_interval: '2026-07-20',
          display_interval: '2026-07-19',
          total_first_event_count: 100,
          interval_0_user_count: 50,
        },
        {
          cohort_interval: '2026-07-21',
          display_interval: '2026-07-19',
          total_first_event_count: 300,
          interval_0_user_count: null,
        },
        {
          cohort_interval: '2026-07-27',
          display_interval: '2026-07-26',
          total_first_event_count: 200,
          interval_0_user_count: 50,
        },
      ],
      0,
      undefined,
      undefined,
      'week',
      'day'
    );

    expect(result[0]?.percentages).toEqual([0.3333]);
  });

  it('sorts retention breakdowns by total profile count', () => {
    const rows = [
      {
        cohort_interval: '2026-07-20',
        total_first_event_count: 10,
        b_0: 'small',
        interval_0_user_count: 5,
      },
      {
        cohort_interval: '2026-07-20',
        total_first_event_count: 30,
        b_0: 'large',
        interval_0_user_count: 15,
      },
    ];

    expect(processCohortData(rows, 0).map((row) => row.breakdowns[0])).toEqual([
      'large',
      'large',
      'small',
      'small',
    ]);
    expect(
      processCohortData(
        rows,
        0,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'profile_count_asc'
      ).map((row) => row.breakdowns[0])
    ).toEqual(['small', 'small', 'large', 'large']);
  });

  it('wraps interval aggregates with a maturity guard', () => {
    expect(
      buildRetentionMeasureIntervalSelect({
        index: 1,
        criteria: '=',
        maturityExpression: "addDays(cs.cohort_interval, 1) <= today('UTC')",
      })
    ).toBe(
      "if(addDays(cs.cohort_interval, 1) <= today('UTC'), uniqExactIf(r.profile_id, r.x_after_cohort = 1), NULL) AS interval_1_user_count"
    );
  });

  it('extracts multi-property breakdown values from the same cohort event', () => {
    expect(
      buildRetentionBreakdownSelects([
        "coalesce(browser, '(not set)')",
        "coalesce(version, '(not set)')",
      ])
    ).toEqual([
      "tupleElement(argMin(tuple(coalesce(browser, '(not set)'), coalesce(version, '(not set)')), e.created_at), 1) AS b_0",
      "tupleElement(argMin(tuple(coalesce(browser, '(not set)'), coalesce(version, '(not set)')), e.created_at), 2) AS b_1",
    ]);
  });

  it('carries partial coverage through processCohortData into weekly cells', () => {
    const result = processCohortData(
      [
        {
          cohort_interval: '2026-08-25',
          display_interval: '2026-08-23',
          total_first_event_count: 346,
          matured_intervals: 2,
          interval_0_user_count: 0.29,
          interval_1_user_count: 0.29,
          interval_2_user_count: 0.29,
        },
        {
          cohort_interval: '2026-08-26',
          display_interval: '2026-08-23',
          total_first_event_count: 470,
          matured_intervals: 1,
          interval_0_user_count: 5.8,
          interval_1_user_count: 5.8,
          interval_2_user_count: null,
        },
      ],
      2,
      undefined,
      undefined,
      'week',
      'day',
      'property_average'
    );

    const week = result.find((row) => row.cohort_interval === '2026-08-23');
    expect(week?.sum).toBe(816);
    expect(week?.values).toEqual([3.46, 3.46, 0.29]);
    expect(week?.coverage?.[2]).toEqual({ eligible: 1, total: 2 });
  });

  it('treats a zero-revenue cohort as zero rather than dropping it', () => {
    // The reported defect in its smallest form: before the fix the
    // 900-profile cohort arrived as NULL and left the denominator entirely,
    // so the week reported 8 — the other cohort's value — instead of 0.8.
    // This covers the ROLLUP half only; it is handed a 0 rather than deriving
    // one, so it would still pass with the SQL reverted. The ifNull half is
    // pinned by the buildRetentionMeasureIntervalSelect string assertions,
    // which is the layer that actually emits it.
    const result = processCohortData(
      [
        {
          cohort_interval: '2026-08-25',
          display_interval: '2026-08-23',
          total_first_event_count: 100,
          matured_intervals: 0,
          interval_0_user_count: 8,
        },
        {
          cohort_interval: '2026-08-26',
          display_interval: '2026-08-23',
          total_first_event_count: 900,
          matured_intervals: 0,
          interval_0_user_count: 0,
        },
      ],
      0,
      undefined,
      undefined,
      'week',
      'day',
      'property_average'
    );

    const week = result.find((row) => row.cohort_interval === '2026-08-23');
    expect(week?.values).toEqual([0.8]);
  });

  it('reports the TOTAL cohort size on the summary row, not the mean', () => {
    // Regression: the summary row divided the total by the cohort-day count,
    // so a column headed "Total profiles" showed an average — while every
    // cohort row beneath it showed a real total. Same column, two meanings.
    const result = processCohortData(
      [
        {
          cohort_interval: '2026-07-01',
          total_first_event_count: 10,
          interval_0_user_count: 5,
        },
        {
          cohort_interval: '2026-07-02',
          total_first_event_count: 30,
          interval_0_user_count: 6,
        },
      ],
      0
    );

    const [summary, ...cohorts] = result;
    expect(summary?.cohort_interval).toBe('Weighted Average');
    expect(summary?.sum).toBe(40); // was 20, the mean of 10 and 30
    // The invariant that makes the header honest.
    expect(summary?.sum).toBe(cohorts.reduce((acc, row) => acc + row.sum, 0));
  });

  it('still weights the day cells rather than summing them', () => {
    // The other half of the fix: cohort sizes add, rates do not. If this ever
    // starts returning 11 (5 + 6) the summary row has become incoherent.
    const result = processCohortData(
      [
        {
          cohort_interval: '2026-07-01',
          total_first_event_count: 10,
          interval_0_user_count: 5,
        },
        {
          cohort_interval: '2026-07-02',
          total_first_event_count: 30,
          interval_0_user_count: 6,
        },
      ],
      0
    );

    // Weighted by cohort size: (5*10 + 6*30) / 40 = 5.75 -> 6 at 0 decimals.
    expect(result[0]?.values).toEqual([6]);
    expect(result[0]?.percentages).toEqual([0.275]);
  });

  it('keeps zero-retention cohorts in the weighted-average denominator', () => {
    const result = processCohortData(
      [
        {
          cohort_interval: '2026-07-01',
          total_first_event_count: 10,
          interval_0_user_count: 5,
        },
        {
          cohort_interval: '2026-07-02',
          total_first_event_count: 10,
          interval_0_user_count: 0,
        },
      ],
      0
    );

    expect(result[0]?.cohort_interval).toBe('Weighted Average');
    expect(result[0]?.percentages).toEqual([0.25]);
  });

  it('preserves two-decimal weighted averages for retention property metrics', () => {
    const result = processCohortData(
      [
        {
          cohort_interval: '2026-07-21',
          total_first_event_count: 10,
          interval_0_user_count: 5.54,
        },
        {
          cohort_interval: '2026-07-22',
          total_first_event_count: 10,
          interval_0_user_count: 7.04,
        },
      ],
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      'property_sum'
    );

    expect(result[0]?.values).toEqual([6.29]);
  });

  it('keeps retention cohorts separated by ordered breakdown values', () => {
    const result = groupRetentionRowsByBreakdowns([
      {
        cohort_interval: '2026-07-01',
        total_first_event_count: 4,
        interval_0_user_count: 2,
        interval_1_user_count: 1,
        b_0: 'Chrome',
        b_1: '1.0',
      },
      {
        cohort_interval: '2026-07-01',
        total_first_event_count: 2,
        interval_0_user_count: 1,
        interval_1_user_count: 1,
        b_0: 'Safari',
        b_1: '2.0',
      },
    ]);

    expect(result).toHaveLength(2);
    expect(result.map((group) => group.breakdowns)).toEqual([
      ['Chrome', '1.0'],
      ['Safari', '2.0'],
    ]);
    expect(result[0]?.rows).toHaveLength(1);
    expect(result[0]?.rows[0]?.interval_1_user_count).toBe(1);
    expect(result[1]?.rows).toHaveLength(1);
  });

  it('detects wildcard any-event selections', () => {
    expect(isWildcardEventSelection(['*'])).toBe(true);
    expect(isWildcardEventSelection(['*', 'New User Identify'])).toBe(true);
    expect(isWildcardEventSelection(['New User Identify'])).toBe(false);
  });

  it('builds an unrestricted clause for wildcard selections', () => {
    expect(getRetentionReturnEventWhereClause(['*'])).toBe('1 = 1');
    expect(getRetentionReturnEventWhereClause(['*', 'New User Identify'])).toBe(
      '1 = 1'
    );
  });

  it('builds exact-match clauses for concrete cohort event names', () => {
    expect(getConcreteEventNameWhereClause(['New User Identify'])).toBe(
      "name = 'New User Identify'"
    );
    expect(
      getConcreteEventNameWhereClause([
        'New User Identify',
        'Onboarding Intro Step 1: Shown',
      ])
    ).toBe("name IN ('New User Identify','Onboarding Intro Step 1: Shown')");
  });

  it('keeps wildcard handling scoped to retention return events', () => {
    expect(getConcreteEventNameWhereClause(['*'])).toBe("name = '*'");
    expect(getRetentionReturnEventWhereClause(['New User Identify'])).toBe(
      "name = 'New User Identify'"
    );
  });

  it('does not build a property expression without a property key', () => {
    expect(
      getRetentionMeasurePropertyExpression('property_average')
    ).toBeUndefined();
    expect(
      getRetentionMeasurePropertyExpression('property_sum')
    ).toBeUndefined();
    expect(
      getRetentionMeasurePropertyExpression(
        'unique_users',
        'properties.value_inr'
      )
    ).toBeUndefined();
  });

  it('builds nullable numeric extraction for property measures', () => {
    expect(
      getRetentionMeasurePropertyExpression(
        'property_average',
        'properties.value_inr'
      )
    ).toBe("toFloat64OrNull(toString(properties['value_inr']))");
  });

  it('builds first-time-ever CTE SQL over all historical events', () => {
    expect(
      buildRetentionFirstTimeCteSql({
        projectId: 'project_1',
        eventPredicate: "name = 'Application Installed'",
        startExpression: "toDate('2026-06-24', 'Asia/Kolkata')",
        endExpression: "toDate('2026-07-01', 'Asia/Kolkata')",
      })
    ).toBe(
      "SELECT profile_id AS ft_profile_id, min(created_at) AS first_created_at FROM events WHERE project_id = 'project_1' AND name = 'Application Installed' GROUP BY ft_profile_id HAVING first_created_at >= toDate('2026-06-24', 'Asia/Kolkata') AND first_created_at <= toDate('2026-07-01', 'Asia/Kolkata')"
    );
  });

  it('builds unique-user interval aggregation by default', () => {
    expect(
      buildRetentionMeasureIntervalSelect({ index: 3, criteria: '>=' })
    ).toBe(
      'uniqExactIf(r.profile_id, r.x_after_cohort >= 3) AS interval_3_user_count'
    );
  });

  it('builds property average as property sum divided by cohort users by default', () => {
    expect(
      buildRetentionMeasureIntervalSelect({
        index: 2,
        criteria: '=',
        measure: 'property_average',
        propertyExpression:
          "toFloat64OrNull(toString(properties['value_inr']))",
      })
    ).toBe(
      'round(sumIf(ifNull(r.retention_property_value, 0), r.x_after_cohort = 2) / nullIf(any(cs.total_first_event_count), 0), 2) AS interval_2_user_count'
    );
  });

  it('builds property average with selected retention step unique users as denominator', () => {
    expect(
      buildRetentionMeasureIntervalSelect({
        index: 2,
        criteria: '=',
        measure: 'property_average',
        propertyExpression:
          "toFloat64OrNull(toString(properties['value_inr']))",
        propertyAverageDenominatorStep: 1,
      })
    ).toBe(
      'round(sumIf(ifNull(r.retention_property_value, 0), r.x_after_cohort = 2) / nullIf(uniqExactIf(r.profile_id, r.x_after_cohort = 2), 0), 2) AS interval_2_user_count'
    );
  });

  it('builds property sum interval aggregation', () => {
    expect(
      buildRetentionMeasureIntervalSelect({
        index: 1,
        criteria: '>=',
        measure: 'property_sum',
        propertyExpression:
          "toFloat64OrNull(toString(properties['value_inr']))",
      })
    ).toBe(
      'round(sumIf(ifNull(r.retention_property_value, 0), r.x_after_cohort >= 1), 2) AS interval_1_user_count'
    );
  });

  it('builds on-or-before retention predicates for cumulative property windows', () => {
    expect(
      buildRetentionMeasureIntervalSelect({
        index: 7,
        criteria: '<=',
        measure: 'property_sum',
        propertyExpression:
          "toFloat64OrNull(toString(properties['value_inr']))",
      })
    ).toBe(
      'round(sumIf(ifNull(r.retention_property_value, 0), r.x_after_cohort <= 7), 2) AS interval_7_user_count'
    );
  });

  it('derives the matured-interval horizon with the same arithmetic as the maturity flag', () => {
    expect(
      getRetentionMaturedIntervalsExpression({
        unit: 'day',
        cohortExpression: 'cs.cohort_interval',
        asOfExpression: "toDate(now('UTC'))",
      })
    ).toBe(
      "if(dateDiff('day', cs.cohort_interval, toDate(now('UTC'))) >= 0, greatest(0, dateDiff('day', cs.cohort_interval, toDate(now('UTC'))) - 1), -1)"
    );

    // addWeeks is a fixed 7 days, so the horizon is plain integer division —
    // NOT dateDiff('week'), which counts calendar boundaries crossed.
    expect(
      getRetentionMaturedIntervalsExpression({
        unit: 'week',
        cohortExpression: 'cs.cohort_interval',
        asOfExpression: "toDate(now('UTC'))",
      })
    ).toBe(
      "intDiv(dateDiff('day', cs.cohort_interval, toDate(now('UTC'))), 7)"
    );

    // addMonths clamps day-of-month, so the calendar-month difference
    // overshoots until the cohort's day-of-month comes round again.
    expect(
      getRetentionMaturedIntervalsExpression({
        unit: 'month',
        cohortExpression: 'cs.cohort_interval',
        asOfExpression: "toDate(now('UTC'))",
      })
    ).toBe(
      "if(addMonths(cs.cohort_interval, dateDiff('month', cs.cohort_interval, toDate(now('UTC')))) <= toDate(now('UTC')), dateDiff('month', cs.cohort_interval, toDate(now('UTC'))), dateDiff('month', cs.cohort_interval, toDate(now('UTC'))) - 1)"
    );
  });

  it('maps a separate retention time unit to diff/sql/dateDiff units', () => {
    expect(getRetentionTimeUnitConfig('day')).toEqual({
      diffUnit: 'day',
      sqlInterval: 'DAY',
    });
    expect(getRetentionTimeUnitConfig('week')).toEqual({
      diffUnit: 'week',
      sqlInterval: 'WEEK',
    });
    expect(getRetentionTimeUnitConfig('month')).toEqual({
      diffUnit: 'month',
      sqlInterval: 'MONTH',
    });
  });

  it('aggregates daily retention rows into weekly rows by summing counts and recomputing rates', () => {
    expect(
      aggregateRetentionRowsByDisplayInterval(
        [
          {
            cohort_interval: '2026-05-31',
            display_interval: '2026-05-31',
            sum: 100,
            values: [2, 1],
            percentages: [0.02, 0.01],
          },
          {
            cohort_interval: '2026-06-01',
            display_interval: '2026-05-31',
            sum: 300,
            values: [6, 9],
            percentages: [0.02, 0.03],
          },
        ],
        'sum'
      )
    ).toEqual([
      {
        cohort_interval: '2026-05-31',
        sum: 400,
        values: [8, 10],
        valueWeights: [400, 400],
        coverage: [
          { eligible: 2, total: 2 },
          { eligible: 2, total: 2 },
        ],
        revenueCohorts: [],
        percentages: [0.02, 0.025],
      },
    ]);
  });

  it('uses the eligible cohort rather than truncating the display row', () => {
    expect(
      aggregateRetentionRowsByDisplayInterval(
        [
          {
            cohort_interval: '2026-07-25',
            display_interval: '2026-07-20',
            sum: 100,
            values: [50, 40],
            percentages: [0.5, 0.4],
            maturedIntervals: 1,
          },
          {
            cohort_interval: '2026-07-26',
            display_interval: '2026-07-20',
            sum: 300,
            values: [90, null],
            percentages: [0.3, null],
            maturedIntervals: 0,
          },
        ],
        'sum'
      )
    ).toMatchObject([
      {
        cohort_interval: '2026-07-20',
        sum: 400,
        values: [140, 40],
        percentages: [0.35, 0.4],
        valueWeights: [400, 100],
        coverage: [
          { eligible: 2, total: 2 },
          { eligible: 1, total: 2 },
        ],
      },
    ]);
  });

  it('keeps a mature zero-value cohort in the weighted-average denominator', () => {
    // The reported bug: a cohort that earned nothing came back as NULL rather
    // than 0 and fell out of the denominator, so the surviving high-revenue
    // cohort set the whole week. 0.29 over 346 and 5.8 over 470 must average
    // over all 816, not over the 470 that happen to still have revenue.
    expect(
      aggregateRetentionRowsByDisplayInterval(
        [
          {
            cohort_interval: '2026-08-25',
            display_interval: '2026-08-23',
            sum: 346,
            values: [0.29, 0],
            percentages: [0, 0],
            maturedIntervals: 1,
          },
          {
            cohort_interval: '2026-08-26',
            display_interval: '2026-08-23',
            sum: 470,
            values: [5.8, 5.8],
            percentages: [0, 0],
            maturedIntervals: 1,
          },
        ],
        'weighted_average'
      )
    ).toMatchObject([
      {
        cohort_interval: '2026-08-23',
        sum: 816,
        // 3.46 was the buggy reading; it is the mean over 816 users either
        // way, and the day-1 cell may not exceed the day-0 cell above it.
        values: [3.46, 3.34],
        valueWeights: [816, 816],
      },
    ]);
  });

  it('keeps zeros and explicitly marks changing on-or-after populations', () => {
    // Verbatim from prod ClickHouse, regain-ios week 2026-08-23,
    // property_average(value_inr) with criteria "On or After", columns D7..D10.
    // Only two of the seven daily cohorts ever earned anything; the other five
    // used to come back NULL and leave the denominator, which is what let the
    // week read 3.46, 5.8, 5.8, 5.8.
    const cohorts: Array<[string, number, number, Array<number | null>]> = [
      ['2026-08-23', 404, 15, [0, 0, 0, 0]],
      ['2026-08-24', 412, 14, [0, 0, 0, 0]],
      ['2026-08-25', 346, 13, [0.29, 0, 0, 0]],
      ['2026-08-26', 470, 12, [5.8, 5.8, 5.8, 5.8]],
      ['2026-08-27', 311, 11, [0, 0, 0, 0]],
      ['2026-08-28', 181, 10, [0, 0, 0, 0]],
      ['2026-08-29', 186, 9, [0, 0, 0, null]],
    ];

    const [row] = aggregateRetentionRowsByDisplayInterval(
      cohorts.map(([cohort_interval, sum, matured, values]) => ({
        cohort_interval,
        display_interval: '2026-08-23',
        sum,
        values,
        percentages: values.map(() => 0),
        // D7 is column 0 in this slice, so the horizon shifts down by 7.
        maturedIntervals: matured - 7,
      })),
      'weighted_average'
    );

    expect(row?.sum).toBe(2310);
    // D10 now uses the six eligible cohorts, explicitly flagged partial.
    expect(row?.values).toEqual([1.22, 1.18, 1.18, 1.28]);
    expect(row?.coverage?.[3]).toEqual({ eligible: 6, total: 7 });
    expect(row?.valueWeights?.slice(0, 3)).toEqual([2310, 2310, 2310]);
  });

  it('aggregates property averages with per-interval denominator weights', () => {
    expect(
      aggregateRetentionRowsByDisplayInterval(
        [
          {
            cohort_interval: '2026-05-31',
            display_interval: '2026-05-31',
            sum: 100,
            values: [10],
            valueWeights: [5],
            percentages: [0.1],
          },
          {
            cohort_interval: '2026-06-01',
            display_interval: '2026-05-31',
            sum: 300,
            values: [20],
            valueWeights: [15],
            percentages: [0.067],
          },
        ],
        'weighted_average'
      )
    ).toMatchObject([
      {
        cohort_interval: '2026-05-31',
        sum: 400,
        values: [17.5],
      },
    ]);
  });

  it('ROAS revenue windows: complete-only, cut at the report range, day unit only', () => {
    const sql = buildRoasRevenueSelects({
      unit: 'day',
      diffInterval: 7,
      cohortExpression: 'cs.cohort_interval',
      asOfExpression: 'today_ist',
    });
    expect(sql).toContain(
      'if(addDays(cs.cohort_interval, 0) <= today_ist, round(sumIf(ifNull(r.retention_property_value, 0), r.x_after_cohort <= 0), 2), NULL) AS roas_rev_d0'
    );
    // Today's cohort shows D0 "so far", flagged as partial.
    expect(sql).toContain(
      'addDays(cs.cohort_interval, 1) > today_ist AS roas_rev_d0_partial'
    );
    expect(sql).toContain(
      'if(addDays(cs.cohort_interval, 8) <= today_ist, round(sumIf(ifNull(r.retention_property_value, 0), r.x_after_cohort <= 7), 2), NULL) AS roas_rev_d7'
    );
    // A 7-day report cannot see day 30.
    expect(sql).toContain("CAST(NULL, 'Nullable(Float64)') AS roas_rev_d30");
    expect(sql).toContain(
      'round(sum(ifNull(r.retention_property_value, 0)), 2) AS roas_rev_lifetime'
    );
    const weekly = buildRoasRevenueSelects({
      unit: 'week',
      diffInterval: 8,
      cohortExpression: 'c',
      asOfExpression: 'n',
    });
    expect(weekly).toContain("CAST(NULL, 'Nullable(Float64)') AS roas_rev_d0");
  });

  it('rolls ROAS revenue up over eligible members only', () => {
    expect(
      addRoasRevenue(
        { d0: 1, d7: 2, d30: null, lifetime: 3 },
        { d0: 1.5, d7: null, d30: null, lifetime: 4 }
      )
    ).toEqual({ d0: 2.5, d7: 2, d30: null, lifetime: 7, d0Partial: false });
    expect(
      addRoasRevenue(undefined, { d0: 1, d7: 1, d30: 1, lifetime: 1 })
    ).toEqual({ d0: 1, d7: 1, d30: 1, lifetime: 1 });
  });

  it('legacy retention bounds stay byte-identical; exact-day bounds use local midnight', () => {
    const legacy = getRetentionDateBounds({
      startDate: '2026-09-25 00:00:00',
      endDate: '2026-10-03 00:00:00',
      timezone: 'Asia/Calcutta',
      exactDays: false,
      windowInterval: 'INTERVAL 9 DAY',
    });
    expect(legacy.cohortWindow('e.created_at')).toBe(
      "e.created_at BETWEEN toDate('2026-09-25 00:00:00', 'Asia/Calcutta') AND toDate('2026-10-03 00:00:00', 'Asia/Calcutta')"
    );
    expect(legacy.returnWindow('created_at')).toBe(
      "created_at >= toDate('2026-09-25 00:00:00', 'Asia/Calcutta')\n              AND created_at < toDate('2026-10-03 00:00:00', 'Asia/Calcutta') + INTERVAL 9 DAY"
    );
    expect(legacy.firstTimeEnd).toBe(
      "toDate('2026-10-03 00:00:00', 'Asia/Calcutta')"
    );

    const exact = getRetentionDateBounds({
      startDate: '2026-09-25 00:00:00',
      endDate: '2026-10-03 00:00:00',
      timezone: 'Asia/Calcutta',
      exactDays: true,
      windowInterval: 'INTERVAL 9 DAY',
    });
    expect(exact.cohortWindow('e.created_at')).toBe(
      "e.created_at >= toDateTime64(toDate('2026-09-25 00:00:00', 'Asia/Calcutta'), 3, 'Asia/Calcutta') AND e.created_at < toDateTime64(toDate('2026-10-03 00:00:00', 'Asia/Calcutta'), 3, 'Asia/Calcutta')"
    );
    // "Yesterday" ends at 23:59:59: that whole day is in.
    const yesterday = getRetentionDateBounds({
      startDate: '2026-10-01 00:00:00',
      endDate: '2026-10-01 23:59:59',
      timezone: 'Asia/Calcutta',
      exactDays: true,
      windowInterval: 'INTERVAL 1 DAY',
    });
    expect(yesterday.cohortWindow('c')).toContain(
      "c < toDateTime64(toDate('2026-10-01 23:59:59', 'Asia/Calcutta') + 1, 3, 'Asia/Calcutta')"
    );
  });

  it('only oversized retention queries get raised ClickHouse limits', () => {
    expect(getRetentionQuerySettings('SELECT 1')).toBeUndefined();
    const big = getRetentionQuerySettings('x'.repeat(300_000));
    expect(Number(big?.max_query_size)).toBeGreaterThan(300_000);
    expect(Number(big?.max_ast_elements)).toBeGreaterThan(50_000);
  });
});
