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
  values: Array<number | null>;
  valueWeights?: number[];
  percentages: Array<number | null>;
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
      hasValues: boolean[];
    }
  >();

  for (const row of rows) {
    const key = row.display_interval ?? row.cohort_interval;
    const group = groups.get(key) ?? {
      sum: 0,
      values: new Array(row.values.length).fill(0) as number[],
      weightedValues: new Array(row.values.length).fill(0) as number[],
      valueWeights: new Array(row.values.length).fill(0) as number[],
      hasValues: new Array(row.values.length).fill(false) as boolean[],
    };

    group.sum += row.sum;
    row.values.forEach((value, index) => {
      if (value === null) {
        return;
      }
      const weight = row.valueWeights?.[index] ?? row.sum;
      group.hasValues[index] = true;
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
          ? group.weightedValues.map((value, index) => {
              if (!group.hasValues[index]) {
                return null;
              }
              const weight = group.valueWeights[index] ?? 0;
              return weight > 0 ? Math.round((value / weight) * 100) / 100 : 0;
            })
          : group.values.map((value, index) =>
              group.hasValues[index] ? value : null
            );

      return {
        cohort_interval,
        sum: group.sum,
        values,
        valueWeights: group.valueWeights,
        percentages: values.map((value, index) => {
          if (value === null) {
            return null;
          }
          const observedProfiles = group.valueWeights[index] ?? 0;
          return observedProfiles > 0
            ? Math.round((value / observedProfiles) * 10_000) / 10_000
            : 0;
        }),
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

export function getRetentionElapsedIntervalExpression(
  unit: RetentionTimeUnit,
  cohortExpression: string,
  eventExpression: string
) {
  if (unit === 'week') {
    return `intDiv(dateDiff('DAY', ${cohortExpression}, ${eventExpression}), 7)`;
  }

  if (unit === 'month') {
    const calendarMonths = `dateDiff('MONTH', ${cohortExpression}, ${eventExpression})`;
    return `${calendarMonths} - if(${eventExpression} < addMonths(${cohortExpression}, ${calendarMonths}), 1, 0)`;
  }

  return `dateDiff('DAY', ${cohortExpression}, ${eventExpression})`;
}

export function getRetentionIntervalMaturityExpression({
  index,
  unit,
  cohortExpression,
  asOfExpression,
}: {
  index: number;
  unit: RetentionTimeUnit;
  cohortExpression: string;
  asOfExpression: string;
}) {
  const addFunction = {
    day: 'addDays',
    week: 'addWeeks',
    month: 'addMonths',
  }[unit];
  return `${addFunction}(${cohortExpression}, ${index}) <= ${asOfExpression}`;
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
  maturityExpression,
}: {
  index: number;
  criteria: '>=' | '=' | '<=';
  measure?: RetentionMeasure;
  propertyExpression?: string;
  propertyAverageDenominatorStep?: number;
  maturityExpression?: string;
}) {
  const predicate = `r.x_after_cohort ${criteria} ${index}`;
  let aggregateExpression: string;

  if (measure === 'property_average' && propertyExpression) {
    const denominator =
      propertyAverageDenominatorStep > 0
        ? `uniqExactIf(r.profile_id, ${predicate})`
        : 'any(cs.total_first_event_count)';
    aggregateExpression = `round(sumIf(r.retention_property_value, ${predicate}) / nullIf(${denominator}, 0), 2)`;
  } else if (measure === 'property_sum' && propertyExpression) {
    aggregateExpression = `round(sumIf(r.retention_property_value, ${predicate}), 2)`;
  } else {
    aggregateExpression = `uniqExactIf(r.profile_id, ${predicate})`;
  }

  const expression = maturityExpression
    ? `if(${maturityExpression}, ${aggregateExpression}, NULL)`
    : aggregateExpression;
  return `${expression} AS interval_${index}_user_count`;
}
