import { describe, expect, it } from 'vitest';
import {
  aggregateRetentionMetric,
  describeRetentionStep,
} from './retention-metric';

const rows = [
  // Server-side summary row must be ignored, whatever it holds.
  {
    cohort_interval: 'Weighted Average',
    sum: 300,
    values: [999, 999],
    valueWeights: [300, 300],
  },
  { cohort_interval: '2026-09-01', sum: 100, values: [10, 4] },
  { cohort_interval: '2026-09-02', sum: 200, values: [30, null] },
  // Synthetic gap-fill row: no cohort here.
  { cohort_interval: '2026-09-03', sum: 0, values: [0, 0] },
];

describe('aggregateRetentionMetric', () => {
  it('sums unique users across every matured cohort (disableCohortize)', () => {
    const result = aggregateRetentionMetric(rows, 0, 'unique_users');
    expect(result.value).toBe(40);
    expect(result.measuredProfiles).toBe(300);
    expect(result.totalProfiles).toBe(300);
    expect(result.measuredCohorts).toBe(2);
    expect(result.totalCohorts).toBe(2);
  });

  it('sums property totals the same way', () => {
    const result = aggregateRetentionMetric(
      [
        { cohort_interval: '2026-09-01', sum: 10, values: [1500.5] },
        { cohort_interval: '2026-09-02', sum: 5, values: [499.5] },
      ],
      0,
      'property_sum',
    );
    expect(result.value).toBe(2000);
  });

  it('excludes immature cells from numerator AND denominator', () => {
    const result = aggregateRetentionMetric(rows, 1, 'retention_rate');
    // Only the Sep 1 cohort has lived to step 1: 4 / 100.
    expect(result.value).toBeCloseTo(0.04);
    expect(result.measuredProfiles).toBe(100);
    expect(result.totalProfiles).toBe(300);
    expect(result.measuredCohorts).toBe(1);
  });

  it('weights a retention rate by cohort size, not by cohort count', () => {
    const result = aggregateRetentionMetric(rows, 0, 'retention_rate');
    // (10 + 30) / (100 + 200), not mean(10%, 15%).
    expect(result.value).toBeCloseTo(40 / 300);
  });

  it('weights a property average by its denominator counts', () => {
    const result = aggregateRetentionMetric(
      [
        {
          cohort_interval: '2026-09-01',
          sum: 100,
          values: [10],
          valueWeights: [20],
        },
        {
          cohort_interval: '2026-09-02',
          sum: 100,
          values: [40],
          valueWeights: [5],
        },
      ],
      0,
      'property_average',
    );
    // (10*20 + 40*5) / (20 + 5) = 400 / 25
    expect(result.value).toBe(16);
  });

  it('returns null when nothing has matured at the step', () => {
    const result = aggregateRetentionMetric(rows, 5, 'unique_users');
    expect(result.value).toBeNull();
    expect(result.measuredCohorts).toBe(0);
    expect(result.totalCohorts).toBe(2);
  });

  it('reads serialized numbers ClickHouse may hand back as strings', () => {
    const result = aggregateRetentionMetric(
      [
        {
          cohort_interval: '2026-09-01',
          sum: 3,
          values: ['12.5' as unknown as number],
        },
      ],
      0,
      'property_sum',
    );
    expect(result.value).toBe(12.5);
  });
});

describe('describeRetentionStep', () => {
  it('spells out the criteria the step is read with', () => {
    expect(describeRetentionStep(0, 'day', 'on_or_after')).toBe('Day ≥ 0');
    expect(describeRetentionStep(3, 'week', 'on')).toBe('Week 3');
    expect(describeRetentionStep(1, 'month', 'on_or_before')).toBe(
      'Month ≤ 1',
    );
  });
});
