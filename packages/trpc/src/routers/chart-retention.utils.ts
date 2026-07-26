import { getSelectPropertyKey, TABLE_NAMES } from '@openpanel/db';
import sqlstring from 'sqlstring';

export type RetentionMeasure =
  | 'retention_rate'
  | 'unique_users'
  | 'property_sum'
  | 'property_average';

export type RetentionTimeUnit = 'day' | 'week' | 'month';

export interface ProcessedRetentionCohortRow {
  cohort_interval: string;
  display_interval?: string;
  sum: number;
  values: number[];
  valueWeights?: number[];
  percentages: number[];
}

export interface RawRetentionCohortRow {
  display_interval?: string;
  cohort_interval: string;
  total_first_event_count: number;
  [key: string]: any;
}

const BREAKDOWN_COLUMN_PATTERN = /^b_\d+$/;

export function buildRetentionBreakdownSelects(
  normalizedExpressions: string[],
  timestampExpression = 'e.created_at'
) {
  const tupleExpression = `tuple(${normalizedExpressions.join(', ')})`;
  return normalizedExpressions.map((expression, index) =>
    normalizedExpressions.length === 1
      ? `argMin(${expression}, ${timestampExpression}) AS b_${index}`
      : `tupleElement(argMin(${tupleExpression}, ${timestampExpression}), ${index + 1}) AS b_${index}`
  );
}

export function groupRetentionRowsByBreakdowns(
  data: RawRetentionCohortRow[]
): Array<{ breakdowns: string[]; rows: RawRetentionCohortRow[] }> {
  const breakdownKeys = Array.from(
    new Set(
      data.flatMap((row) =>
        Object.keys(row).filter((key) => BREAKDOWN_COLUMN_PATTERN.test(key))
      )
    )
  ).sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));

  if (breakdownKeys.length === 0) {
    return [{ breakdowns: [], rows: data }];
  }

  const groups = new Map<
    string,
    { breakdowns: string[]; rows: RawRetentionCohortRow[] }
  >();
  for (const row of data) {
    const breakdowns = breakdownKeys.map((key) =>
      String(row[key] ?? '(not set)')
    );
    const signature = JSON.stringify(breakdowns);
    const group = groups.get(signature) ?? { breakdowns, rows: [] };
    group.rows.push(row);
    groups.set(signature, group);
  }

  return Array.from(groups.values());
}

export function aggregateRetentionRowsByDisplayInterval(
  rows: ProcessedRetentionCohortRow[],
  valueMode: 'sum' | 'weighted_average'
) {
  const groups = new Map<
    string,
    {
      sum: number;
      values: number[];
      weightedValues: number[];
      valueWeights: number[];
    }
  >();

  for (const row of rows) {
    const key = row.display_interval ?? row.cohort_interval;
    const group = groups.get(key) ?? {
      sum: 0,
      values: Array(row.values.length).fill(0) as number[],
      weightedValues: Array(row.values.length).fill(0) as number[],
      valueWeights: Array(row.values.length).fill(0) as number[],
    };

    group.sum += row.sum;
    row.values.forEach((value, index) => {
      const weight = row.valueWeights?.[index] ?? row.sum;
      group.values[index] = (group.values[index] ?? 0) + value;
      group.valueWeights[index] = (group.valueWeights[index] ?? 0) + weight;
      group.weightedValues[index] =
        (group.weightedValues[index] ?? 0) + value * weight;
    });
    groups.set(key, group);
  }

  return Array.from(groups.entries())
    .map(([cohort_interval, group]) => {
      const values =
        valueMode === 'weighted_average'
          ? group.weightedValues.map((value, index) =>
              (group.valueWeights[index] ?? 0) > 0
                ? Math.round((value / group.valueWeights[index]!) * 100) / 100
                : 0
            )
          : group.values;

      return {
        cohort_interval,
        sum: group.sum,
        values,
        percentages: values.map((value) =>
          group.sum > 0 ? Math.round((value / group.sum) * 10000) / 10000 : 0
        ),
      };
    })
    .sort((a, b) => a.cohort_interval.localeCompare(b.cohort_interval));
}

export function getRetentionTimeUnitConfig(unit: RetentionTimeUnit): {
  diffUnit: RetentionTimeUnit;
  sqlInterval: 'DAY' | 'WEEK' | 'MONTH';
} {
  const config = {
    day: { diffUnit: 'day', sqlInterval: 'DAY' },
    week: { diffUnit: 'week', sqlInterval: 'WEEK' },
    month: { diffUnit: 'month', sqlInterval: 'MONTH' },
  } as const satisfies Record<
    RetentionTimeUnit,
    { diffUnit: RetentionTimeUnit; sqlInterval: 'DAY' | 'WEEK' | 'MONTH' }
  >;

  return config[unit];
}

export function isWildcardEventSelection(events: string[]) {
  return events.includes('*');
}

export function getConcreteEventNameWhereClause(events: string[]) {
  if (events.length === 1) {
    return `name = ${sqlstring.escape(events[0])}`;
  }

  return `name IN (${events.map((e) => sqlstring.escape(e)).join(',')})`;
}

export function getRetentionReturnEventWhereClause(events: string[]) {
  if (isWildcardEventSelection(events)) {
    return '1 = 1';
  }

  return getConcreteEventNameWhereClause(events);
}

export function isRetentionPropertyMeasure(
  measure: RetentionMeasure | undefined
) {
  return measure === 'property_sum' || measure === 'property_average';
}

export function getRetentionMeasurePropertyExpression(
  measure: RetentionMeasure | undefined,
  property?: string
) {
  if (!(isRetentionPropertyMeasure(measure) && property)) {
    return undefined;
  }

  return `toFloat64OrNull(toString(${getSelectPropertyKey(property)}))`;
}

export function buildRetentionFirstTimeCteSql({
  projectId,
  eventPredicate,
  startExpression,
  endExpression,
}: {
  projectId: string;
  eventPredicate: string;
  startExpression: string;
  endExpression: string;
}) {
  return `SELECT profile_id AS ft_profile_id, min(created_at) AS first_created_at FROM ${TABLE_NAMES.events} WHERE project_id = ${sqlstring.escape(projectId)} AND ${eventPredicate} GROUP BY ft_profile_id HAVING first_created_at >= ${startExpression} AND first_created_at <= ${endExpression}`;
}

export function buildRetentionMeasureIntervalSelect({
  index,
  criteria,
  measure,
  propertyExpression,
  propertyAverageDenominatorStep = 0,
}: {
  index: number;
  criteria: '>=' | '=' | '<=';
  measure?: RetentionMeasure;
  propertyExpression?: string;
  propertyAverageDenominatorStep?: number;
}) {
  const predicate = `r.x_after_cohort ${criteria} ${index}`;

  if (measure === 'property_average' && propertyExpression) {
    const denominator =
      propertyAverageDenominatorStep > 0
        ? `uniqExactIf(r.profile_id, ${predicate})`
        : 'any(cs.total_first_event_count)';
    return `round(sumIf(r.retention_property_value, ${predicate}) / nullIf(${denominator}, 0), 2) AS interval_${index}_user_count`;
  }

  if (measure === 'property_sum' && propertyExpression) {
    return `round(sumIf(r.retention_property_value, ${predicate}), 2) AS interval_${index}_user_count`;
  }

  return `uniqExactIf(r.profile_id, ${predicate}) AS interval_${index}_user_count`;
}
