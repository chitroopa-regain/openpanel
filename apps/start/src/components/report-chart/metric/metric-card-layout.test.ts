import { describe, expect, it } from 'vitest';

import {
  compactMetricCardClassName,
  compactMetricGridClassName,
  compactMetricLabelClassName,
  compactMetricValueClassName,
  getCompactMetricLabelFontSizePx,
  getCompactMetricValueFontSizePx,
} from './metric-card-layout';

describe('compact metric card responsive layout', () => {
  it('uses auto-fit columns with a compact minimum card width', () => {
    expect(compactMetricGridClassName).toContain('auto-fit');
    expect(compactMetricGridClassName).toContain('minmax(min(8.5rem,100%),1fr)');
  });

  it('sizes labels and values from the card container instead of the viewport', () => {
    expect(compactMetricCardClassName).toContain('@container');
    expect(compactMetricLabelClassName).toContain('cqw');
    expect(compactMetricValueClassName).toContain('cqw');
    expect(compactMetricValueClassName).not.toContain('vw');
  });

  it('fits large values into narrow dashboard cards like Mixpanel', () => {
    expect(getCompactMetricValueFontSizePx(128, '37.7K'.length)).toBeLessThanOrEqual(34);
    expect(getCompactMetricValueFontSizePx(128, '1.1K'.length)).toBeLessThanOrEqual(41);
    expect(getCompactMetricValueFontSizePx(220, '37.7K'.length)).toBe(44);
  });

  it('shrinks long breakdown labels in narrow dashboard cards', () => {
    expect(getCompactMetricLabelFontSizePx(128, 'DEFAULT_REMOTE'.length)).toBeLessThanOrEqual(13);
    expect(getCompactMetricLabelFontSizePx(180, 'BASELINE'.length)).toBe(14);
  });
});
