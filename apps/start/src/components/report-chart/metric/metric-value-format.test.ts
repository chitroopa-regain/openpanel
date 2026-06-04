import { describe, expect, it } from 'vitest';
import { formatMetricDisplayValue } from './metric-value-format';

describe('formatMetricDisplayValue', () => {
  it('uses one decimal for compact thousands to save dashboard space', () => {
    expect(formatMetricDisplayValue(91370)).toBe('91.3K');
  });

  it('does not pad compact values with trailing zeroes', () => {
    expect(formatMetricDisplayValue(91000)).toBe('91K');
  });

  it('keeps full formatting for smaller dashboard values', () => {
    expect(formatMetricDisplayValue(9999)).toBe('9,999');
  });
});
