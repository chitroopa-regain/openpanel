import { describe, expect, it } from 'vitest';
import { toChartValue } from './chart';

describe('retention chart value normalization', () => {
  it('normalizes serialized property values for Recharts', () => {
    expect(toChartValue('114.65', false)).toBe(114.65);
    expect(toChartValue('0.514', true)).toBe(51.4);
  });

  it('turns missing and invalid values into chart gaps', () => {
    expect(toChartValue(null, false)).toBeNull();
    expect(toChartValue('not-a-number', false)).toBeNull();
  });
});
