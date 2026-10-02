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
  /** Intervals of history this cohort has; see getRetentionMaturedIntervalsExpression. */
  maturedIntervals?: number;
  /** Cumulative revenue for ROAS; present only with acquisition cost on. */
  revenue?: RoasRevenue;
}

/**
 * ROAS windows, in days after the cohort day, matching the grid's own columns:
 * D0 = `< 1 Day`, D7 = `Day 7` (days 0..7). A window is reported only once it
 * has fully elapsed, and only when the report's range reaches it — the return
 * leg is cut at cohort + range, so a 7-day report cannot see day 30.
 */
export const ROAS_WINDOWS = [
  { key: 'd0', day: 0 },
  { key: 'd7', day: 7 },
  { key: 'd30', day: 30 },
] as const;

export interface RoasRevenue {
  d0: number | null;
  d7: number | null;
  d30: number | null;
  /** Everything the cohort has paid through now. */
  lifetime: number | null;
  /** D0 is today's cohort, still running: a "so far" value. */
  d0Partial?: boolean;
}

export function buildRoasRevenueSelects({
  unit,
  diffInterval,
  cohortExpression,
  asOfExpression,
}: {
  unit: RetentionTimeUnit;
  diffInterval: number;
  cohortExpression: string;
  asOfExpression: string;
}) {
  const revenue = 'ifNull(r.retention_property_value, 0)';
  // D0 also shows for the cohort day still in progress (flagged partial, a
  // "so far" number); D7/D30 only once fully elapsed.
  const windows = ROAS_WINDOWS.map(({ key, day }) => {
    if (unit !== 'day' || day > diffInterval) {
      return `CAST(NULL, 'Nullable(Float64)') AS roas_rev_${key}`;
    }
    const shownFrom = day === 0 ? 0 : day + 1;
    return `if(addDays(${cohortExpression}, ${shownFrom}) <= ${asOfExpression}, round(sumIf(${revenue}, r.x_after_cohort <= ${day}), 2), NULL) AS roas_rev_${key}`;
  });
  const d0Partial =
    unit === 'day'
      ? `addDays(${cohortExpression}, 1) > ${asOfExpression} AS roas_rev_d0_partial`
      : 'false AS roas_rev_d0_partial';
  return [
    ...windows,
    d0Partial,
    `round(sum(${revenue}), 2) AS roas_rev_lifetime`,
  ].join(',\n');
}

const toNullableNumber = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);

export function readRoasRevenue(
  row: RawRetentionCohortRow
): RoasRevenue | undefined {
  if (!('roas_rev_lifetime' in row)) {
    return undefined;
  }
  return {
    d0: toNullableNumber(row.roas_rev_d0),
    d7: toNullableNumber(row.roas_rev_d7),
    d30: toNullableNumber(row.roas_rev_d30),
    lifetime: toNullableNumber(row.roas_rev_lifetime),
    d0Partial: Boolean(Number(row.roas_rev_d0_partial ?? 0)),
  };
}

/** Rolled-up revenue: a window is known only when every member's is. */
export function addRoasRevenue(
  a: RoasRevenue | undefined,
  b: RoasRevenue | undefined
): RoasRevenue | undefined {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  const add = (x: number | null, y: number | null) =>
    x === null || y === null ? null : Math.round((x + y) * 100) / 100;
  return {
    d0: add(a.d0, b.d0),
    d7: add(a.d7, b.d7),
    d30: add(a.d30, b.d30),
    lifetime: add(a.lifetime, b.lifetime),
    d0Partial: Boolean(a.d0Partial || b.d0Partial),
  };
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
      maturedIntervals: number;
      revenue?: RoasRevenue;
    }
  >();

  for (const row of rows) {
    const key = row.display_interval ?? row.cohort_interval;
    const group = groups.get(key) ?? {
      sum: 0,
      values: new Array(row.values.length).fill(0) as number[],
      weightedValues: new Array(row.values.length).fill(0) as number[],
      valueWeights: new Array(row.values.length).fill(0) as number[],
      maturedIntervals: Number.POSITIVE_INFINITY,
    };

    group.sum += row.sum;
    group.revenue = addRoasRevenue(group.revenue, row.revenue);
    // The group can only be shown as far as its YOUNGEST member reaches. A
    // display row is read left to right, so every cell in it has to come from
    // the same population; letting a young member drop out column by column
    // silently shrinks the denominator and can make a cumulative row rise.
    group.maturedIntervals = Math.min(
      group.maturedIntervals,
      row.maturedIntervals ?? Number.POSITIVE_INFINITY
    );
    row.values.forEach((value, index) => {
      // A null inside the horizon is not missing history — it is a cohort with
      // no denominator at this index (a per-converter average with nobody to
      // average). Its weight is zero, so skipping it is a no-op, not a drop.
      if (value === null) {
        return;
      }
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
      const isMature = (index: number) => index <= group.maturedIntervals;
      const values =
        valueMode === 'weighted_average'
          ? group.weightedValues.map((value, index) => {
              if (!isMature(index)) {
                return null;
              }
              const weight = group.valueWeights[index] ?? 0;
              return weight > 0
                ? Math.round((value / weight) * 100) / 100
                : null;
            })
          : group.values.map((value, index) =>
              isMature(index) ? value : null
            );

      return {
        cohort_interval,
        sum: group.sum,
        values,
        valueWeights: group.valueWeights,
        revenue: group.revenue,
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

/**
 * Retention window bounds.
 *
 * Legacy (exactDays=false): `toDate(...)` compared with the DateTime64
 * `created_at`, which ClickHouse reads as UTC midnight — kept byte-identical
 * for existing reports.
 *
 * exactDays: local-midnight bounds. The cohort window is [start day 00:00,
 * end day 00:00) where an end with a time of day (e.g. the "Yesterday" preset's
 * 23:59:59) includes that whole day, and an end at 00:00:00 (the other
 * presets) is already exclusive — the same rule processCohortGroupData uses
 * for its row domain.
 */
export function getRetentionDateBounds({
  startDate,
  endDate,
  timezone,
  exactDays,
  windowInterval,
}: {
  startDate: string;
  endDate: string;
  timezone: string;
  exactDays: boolean;
  windowInterval: string;
}) {
  const tz = sqlstring.escape(timezone);
  const startDay = `toDate(${sqlstring.escape(startDate)}, ${tz})`;
  const endDay = `toDate(${sqlstring.escape(endDate)}, ${tz})`;
  if (!exactDays) {
    return {
      firstTimeStart: startDay,
      firstTimeEnd: endDay,
      secondTimeEnd: `${endDay} + ${windowInterval} - INTERVAL 1 SECOND`,
      cohortWindow: (col: string) => `${col} BETWEEN ${startDay} AND ${endDay}`,
      returnWindow: (col: string) =>
        `${col} >= ${startDay}\n              AND ${col} < ${endDay} + ${windowInterval}`,
    };
  }
  const endHasTime =
    endDate.length > 10 && endDate.slice(11, 19) !== '00:00:00';
  const start = `toDateTime64(${startDay}, 3, ${tz})`;
  const end = `toDateTime64(${endDay}${endHasTime ? ' + 1' : ''}, 3, ${tz})`;
  return {
    firstTimeStart: start,
    firstTimeEnd: `${end} - INTERVAL 1 MILLISECOND`,
    secondTimeEnd: `${end} + ${windowInterval} - INTERVAL 1 MILLISECOND`,
    cohortWindow: (col: string) => `${col} >= ${start} AND ${col} < ${end}`,
    returnWindow: (col: string) =>
      `${col} >= ${start}\n              AND ${col} < ${end} + ${windowInterval}`,
  };
}

/** ClickHouse's default max_query_size (256 KiB). */
const DEFAULT_MAX_QUERY_SIZE = 262_144;

/**
 * The retention SQL has one select per return interval, so a day-unit report
 * over ~3 years (1,200+ columns) passes ClickHouse's 256 KiB query-size limit
 * and its AST limits. Raise them in proportion — only for queries that need
 * it, so every other report runs with exactly the settings it had.
 */
export function getRetentionQuerySettings(query: string) {
  if (query.length < DEFAULT_MAX_QUERY_SIZE * 0.8) {
    return undefined;
  }
  const scale = Math.ceil(query.length / DEFAULT_MAX_QUERY_SIZE) + 1;
  return {
    max_query_size: String(DEFAULT_MAX_QUERY_SIZE * scale),
    max_ast_elements: String(50_000 * scale),
    max_expanded_ast_elements: String(500_000 * scale),
  };
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

/**
 * How many intervals of history a cohort actually has — the largest `index`
 * for which getRetentionIntervalMaturityExpression is true. Kept adjacent to
 * that function because the two must agree exactly; the rollup uses this to
 * find a display group's common horizon, and an off-by-one here would show a
 * column built from a different population than the one beside it.
 */
export function getRetentionMaturedIntervalsExpression({
  unit,
  cohortExpression,
  asOfExpression,
}: {
  unit: RetentionTimeUnit;
  cohortExpression: string;
  asOfExpression: string;
}) {
  const days = `dateDiff('day', ${cohortExpression}, ${asOfExpression})`;
  if (unit === 'day') {
    return days;
  }
  // addWeeks adds a fixed 7 days, so the horizon is exact arithmetic.
  if (unit === 'week') {
    return `intDiv(${days}, 7)`;
  }
  // addMonths is calendar-aware and clamps day-of-month, so dateDiff('month')
  // — which compares month indices and ignores the day — overshoots by one
  // whenever the cohort's day-of-month has not yet come round. Step back once.
  const months = `dateDiff('month', ${cohortExpression}, ${asOfExpression})`;
  return `if(addMonths(${cohortExpression}, ${months}) <= ${asOfExpression}, ${months}, ${months} - 1)`;
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
  excludeEmptyProfiles = false,
}: {
  index: number;
  criteria: '>=' | '=' | '<=';
  measure?: RetentionMeasure;
  propertyExpression?: string;
  propertyAverageDenominatorStep?: number;
  maturityExpression?: string;
  excludeEmptyProfiles?: boolean;
}) {
  // A LEFT JOIN with no return events supplies an empty profile and interval 0.
  // Exclude that placeholder so an empty D0 cohort cannot count as one user.
  const predicate = `${excludeEmptyProfiles ? "r.profile_id != '' AND " : ''}r.x_after_cohort ${criteria} ${index}`;
  let aggregateExpression: string;

  if (measure === 'property_average' && propertyExpression) {
    const denominator =
      propertyAverageDenominatorStep > 0
        ? `uniqExactIf(r.profile_id, ${predicate})`
        : 'any(cs.total_first_event_count)';
    // ifNull, because retention_property_value is Nullable and ClickHouse's
    // sum over an empty/all-NULL set returns NULL rather than 0. A cohort that
    // simply earned nothing in this tail must read 0, not "no data" — as NULL
    // it dropped out of the weekly rollup's denominator and pushed the row up.
    aggregateExpression = `round(sumIf(ifNull(r.retention_property_value, 0), ${predicate}) / nullIf(${denominator}, 0), 2)`;
  } else if (measure === 'property_sum' && propertyExpression) {
    aggregateExpression = `round(sumIf(ifNull(r.retention_property_value, 0), ${predicate}), 2)`;
  } else {
    aggregateExpression = `uniqExactIf(r.profile_id, ${predicate})`;
  }

  const expression = maturityExpression
    ? `if(${maturityExpression}, ${aggregateExpression}, NULL)`
    : aggregateExpression;
  return `${expression} AS interval_${index}_user_count`;
}
