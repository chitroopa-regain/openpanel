import { describe, expect, it } from 'vitest';
import {
  dateToEpochValue,
  defaultEpochDateOperator,
  epochUnitForValue,
  epochValueToDate,
  inferEpochUnit,
  isEpochDateComparisonOperator,
} from './epoch-date-filter.utils';

describe('epoch date filter inference', () => {
  it('recognizes millisecond epoch values on a timestamp-named property', () => {
    expect(
      inferEpochUnit('properties.first_install_time', [
        '1262304089131',
        '1262304213288',
        '1262304217786',
      ])
    ).toBe('milliseconds');
  });

  it('recognizes second epoch values', () => {
    expect(
      inferEpochUnit('profile.properties.created_at', [
        '1767225600',
        '1767312000',
        '1767398400',
      ])
    ).toBe('seconds');
  });

  it('does not treat arbitrary numeric identifiers as dates', () => {
    expect(
      inferEpochUnit('properties.order_id', ['1262304089131', '1262304213288'])
    ).toBeNull();
  });

  it('rejects timestamp-named properties when most values are not epochs', () => {
    expect(
      inferEpochUnit('properties.install_time', [
        'not-set',
        'unknown',
        '1262304089131',
      ])
    ).toBeNull();
  });

  it('rejects datasets that mix second and millisecond epochs', () => {
    expect(
      inferEpochUnit('properties.first_install_time', [
        '1767225600',
        '1767312000000',
      ])
    ).toBeNull();
  });
});

describe('epoch date conversion', () => {
  const date = new Date('2026-09-01T10:15:00.000Z');

  it('round-trips milliseconds without changing the instant', () => {
    const value = dateToEpochValue(date, 'milliseconds');
    expect(epochUnitForValue(value)).toBe('milliseconds');
    expect(epochValueToDate(value, 'milliseconds')?.toISOString()).toBe(
      date.toISOString()
    );
  });

  it('round-trips seconds without changing the instant', () => {
    const value = dateToEpochValue(date, 'seconds');
    expect(epochUnitForValue(value)).toBe('seconds');
    expect(epochValueToDate(value, 'seconds')?.toISOString()).toBe(
      date.toISOString()
    );
  });
});

describe('epoch date filter controls', () => {
  it.each([
    'gte',
    'gt',
    'lte',
    'lt',
  ])('uses the date picker for %s comparisons', (operator) => {
    expect(isEpochDateComparisonOperator(operator)).toBe(true);
  });

  it.each([
    'is',
    'isNot',
    'isNull',
    'isNotNull',
    'contains',
  ])('does not replace %s filters with a lossy single-value date picker', (operator) => {
    expect(isEpochDateComparisonOperator(operator)).toBe(false);
  });

  it('defaults only a new empty epoch equality filter to on-or-after', () => {
    expect(defaultEpochDateOperator('milliseconds', 'is', 0)).toBe('gte');
    expect(defaultEpochDateOperator('milliseconds', 'is', 2)).toBeNull();
    expect(defaultEpochDateOperator('milliseconds', 'isNot', 0)).toBeNull();
    expect(defaultEpochDateOperator(null, 'is', 0)).toBeNull();
  });
});
