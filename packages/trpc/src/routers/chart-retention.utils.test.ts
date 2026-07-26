import { describe, expect, it } from 'vitest';
import { processCohortData } from './chart';
import {
  aggregateRetentionRowsByDisplayInterval,
  buildRetentionBreakdownSelects,
  buildRetentionFirstTimeCteSql,
  buildRetentionMeasureIntervalSelect,
  getConcreteEventNameWhereClause,
  getRetentionMeasurePropertyExpression,
  getRetentionReturnEventWhereClause,
  getRetentionTimeUnitConfig,
  groupRetentionRowsByBreakdowns,
  isWildcardEventSelection,
} from './chart-retention.utils';

describe('chart retention utils', () => {
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
      'round(sumIf(r.retention_property_value, r.x_after_cohort = 2) / nullIf(any(cs.total_first_event_count), 0), 2) AS interval_2_user_count'
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
      'round(sumIf(r.retention_property_value, r.x_after_cohort = 2) / nullIf(uniqExactIf(r.profile_id, r.x_after_cohort = 2), 0), 2) AS interval_2_user_count'
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
      'round(sumIf(r.retention_property_value, r.x_after_cohort >= 1), 2) AS interval_1_user_count'
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
      'round(sumIf(r.retention_property_value, r.x_after_cohort <= 7), 2) AS interval_7_user_count'
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
        percentages: [0.02, 0.025],
      },
    ]);
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
});
