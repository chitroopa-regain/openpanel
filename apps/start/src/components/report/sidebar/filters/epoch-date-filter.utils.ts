export type EpochUnit = 'seconds' | 'milliseconds';

export function isEpochDateComparisonOperator(operator: string): boolean {
  return (
    operator === 'gte' ||
    operator === 'gt' ||
    operator === 'lte' ||
    operator === 'lt'
  );
}

export function defaultEpochDateOperator(
  unit: EpochUnit | null,
  operator: string,
  valueCount: number
): 'gte' | null {
  return unit && operator === 'is' && valueCount === 0 ? 'gte' : null;
}

const MIN_DATE_MS = Date.UTC(2000, 0, 1);
const MAX_DATE_MS = Date.UTC(2100, 0, 1);
const TIMESTAMP_NAME_PATTERN =
  /(^|[._])(date|time|timestamp|datetime|created_at|updated_at|first_seen|last_seen)(?=$|[._])/i;

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function epochUnitForValue(value: unknown): EpochUnit | null {
  const numeric = parseFiniteNumber(value);
  if (numeric === null) {
    return null;
  }

  if (numeric >= MIN_DATE_MS && numeric <= MAX_DATE_MS) {
    return 'milliseconds';
  }

  const milliseconds = numeric * 1000;
  if (milliseconds >= MIN_DATE_MS && milliseconds <= MAX_DATE_MS) {
    return 'seconds';
  }

  return null;
}

export function inferEpochUnit(
  propertyName: string,
  values: readonly unknown[]
): EpochUnit | null {
  if (!TIMESTAMP_NAME_PATTERN.test(propertyName)) {
    return null;
  }

  const sampled = values.filter(
    (value) => value !== null && value !== undefined && value !== ''
  );
  if (sampled.length === 0) {
    return null;
  }

  const units = sampled.map(epochUnitForValue).filter(Boolean) as EpochUnit[];
  if (units.length / sampled.length < 0.8) {
    return null;
  }

  const distinctUnits = new Set(units);
  if (distinctUnits.size !== 1) {
    return null;
  }

  return units[0] ?? null;
}

export function epochValueToDate(value: unknown, unit: EpochUnit): Date | null {
  const numeric = parseFiniteNumber(value);
  if (numeric === null) {
    return null;
  }
  const date = new Date(unit === 'seconds' ? numeric * 1000 : numeric);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function dateToEpochValue(date: Date, unit: EpochUnit): string {
  const milliseconds = date.getTime();
  return String(
    unit === 'seconds' ? Math.floor(milliseconds / 1000) : milliseconds
  );
}
