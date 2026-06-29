import { describe, expect, it } from 'vitest';

import {
  compactMetricCardClassName,
  compactMetricGridClassName,
  compactMetricLabelClassName,
  compactMetricValueClassName,
} from './metric-card-layout';

describe('compact metric card responsive layout', () => {
  it('uses auto-fit columns with a minimum card width so edit-mode cards do not crowd', () => {
    expect(compactMetricGridClassName).toContain('auto-fit');
    expect(compactMetricGridClassName).toContain('minmax(min(9rem,100%),1fr)');
  });

  it('sizes labels and values from the card container instead of the viewport', () => {
    expect(compactMetricCardClassName).toContain('@container');
    expect(compactMetricLabelClassName).toContain('cqw');
    expect(compactMetricValueClassName).toContain('cqw');
    expect(compactMetricValueClassName).not.toContain('vw');
  });
});
