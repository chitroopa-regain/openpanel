import { describe, expect, it } from 'vitest';
import {
  buildRetentionMeasureIntervalSelect,
  getConcreteEventNameWhereClause,
  getRetentionMeasurePropertyExpression,
  getRetentionReturnEventWhereClause,
  isWildcardEventSelection,
} from './chart-retention.utils';

describe('chart retention utils', () => {
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

  it('builds unique-user interval aggregation by default', () => {
    expect(
      buildRetentionMeasureIntervalSelect({ index: 3, criteria: '>=' })
    ).toBe(
      'uniqExactIf(r.profile_id, r.x_after_cohort >= 3) AS interval_3_user_count'
    );
  });

  it('builds property average interval aggregation', () => {
    expect(
      buildRetentionMeasureIntervalSelect({
        index: 2,
        criteria: '=',
        measure: 'property_average',
        propertyExpression:
          "toFloat64OrNull(toString(properties['value_inr']))",
      })
    ).toBe(
      'round(avgIf(r.retention_property_value, r.x_after_cohort = 2), 2) AS interval_2_user_count'
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
});
