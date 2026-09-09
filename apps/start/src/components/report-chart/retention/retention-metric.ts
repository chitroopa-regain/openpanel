/**
 * Collapse every cohort in a retention result into ONE number at a given
 * retention step — Mixpanel's `disableCohortize: true` read through its
 * "insights-metric" display.
 *
 * Why this is not the 'Weighted Average' row: that row is a per-cohort MEAN.
 * For `unique_users` / `property_sum` it answers "how many per cohort", but a
 * headline card must answer "how many in total" — the 4 Regain Pro cards read
 * total revenue / total converters across the whole date range. Rates and
 * averages are the one place a weighted mean IS the total, so those keep the
 * weighted form.
 *
 * Immature cells (NULL — the cohort has not lived long enough to be measured
 * at this step) are excluded from BOTH numerator and denominator. Synthetic
 * gap-fill rows (sum 0) contribute nothing either way.
 */

export type RetentionMetricMeasure =
  | 'retention_rate'
  | 'unique_users'
  | 'property_sum'
  | 'property_average';

export interface RetentionMetricRow {
  cohort_interval: string;
  sum: number;
  values: Array<number | null>;
  valueWeights?: number[];
}

export interface RetentionMetricAggregate {
  /** The headline. `null` when no cohort has matured at this step. */
  value: number | null;
  /** Profiles in the cohorts that were measured (matured) at this step. */
  measuredProfiles: number;
  /** Profiles across every real cohort, matured or not. */
  totalProfiles: number;
  /** Real (non-synthetic) cohorts that were measured at this step. */
  measuredCohorts: number;
  /** Real cohorts in the range. */
  totalCohorts: number;
}

export const RETENTION_SUMMARY_ROW = 'Weighted Average';

export function aggregateRetentionMetric(
  rows: RetentionMetricRow[],
  step: number,
  measure: RetentionMetricMeasure,
): RetentionMetricAggregate {
  let numerator = 0;
  let weightSum = 0;
  let measuredProfiles = 0;
  let totalProfiles = 0;
  let measuredCohorts = 0;
  let totalCohorts = 0;

  for (const row of rows) {
    if (row.cohort_interval === RETENTION_SUMMARY_ROW) {
      continue;
    }
    const cohortSize = Number(row.sum) || 0;
    if (cohortSize === 0) {
      // Gap-fill row, not a cohort.
      continue;
    }
    totalCohorts += 1;
    totalProfiles += cohortSize;

    const raw = row.values[step];
    if (raw === null || raw === undefined) {
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      continue;
    }
    const weight = row.valueWeights?.[step] ?? cohortSize;

    measuredCohorts += 1;
    measuredProfiles += cohortSize;
    weightSum += weight;
    numerator +=
      measure === 'property_average'
        ? value * weight
        : value;
  }

  let value: number | null = null;
  if (measuredCohorts > 0) {
    switch (measure) {
      case 'retention_rate':
        value = weightSum > 0 ? numerator / weightSum : 0;
        break;
      case 'property_average':
        value = weightSum > 0 ? numerator / weightSum : 0;
        break;
      default:
        value = numerator;
    }
  }

  return {
    value,
    measuredProfiles,
    totalProfiles,
    measuredCohorts,
    totalCohorts,
  };
}

/** "Day ≥ 0", "Week 3", "Month ≤ 1" — what the headline number reads. */
export function describeRetentionStep(
  step: number,
  unit: 'day' | 'week' | 'month',
  criteria: 'on_or_after' | 'on' | 'on_or_before',
) {
  const unitLabel = { day: 'Day', week: 'Week', month: 'Month' }[unit];
  const comparator =
    criteria === 'on_or_after' ? '≥ ' : criteria === 'on_or_before' ? '≤ ' : '';
  return `${unitLabel} ${comparator}${step}`;
}
