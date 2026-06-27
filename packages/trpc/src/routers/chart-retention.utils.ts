import { getSelectPropertyKey } from '@openpanel/db';
import sqlstring from 'sqlstring';

export type RetentionMeasure =
  | 'retention_rate'
  | 'unique_users'
  | 'property_sum'
  | 'property_average';

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

export function buildRetentionMeasureIntervalSelect({
  index,
  criteria,
  measure,
  propertyExpression,
}: {
  index: number;
  criteria: '>=' | '=';
  measure?: RetentionMeasure;
  propertyExpression?: string;
}) {
  const predicate = `r.x_after_cohort ${criteria} ${index}`;

  if (measure === 'property_average' && propertyExpression) {
    return `round(avgIf(r.retention_property_value, ${predicate}), 2) AS interval_${index}_user_count`;
  }

  if (measure === 'property_sum' && propertyExpression) {
    return `round(sumIf(r.retention_property_value, ${predicate}), 2) AS interval_${index}_user_count`;
  }

  return `uniqExactIf(r.profile_id, ${predicate}) AS interval_${index}_user_count`;
}
