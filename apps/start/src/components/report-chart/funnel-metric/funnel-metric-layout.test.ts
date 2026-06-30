import { describe, expect, it } from 'vitest';

import {
  funnelMetricCardClassName,
  funnelMetricGridClassName,
  funnelMetricLabelClassName,
  funnelMetricValueClassName,
  getFunnelMetricValueFontSizePx,
} from './funnel-metric-layout';

describe('funnel metric dashboard cards responsive layout', () => {
  it('uses auto-fit cards so a narrow dashboard tile does not force three columns', () => {
    expect(funnelMetricGridClassName).toContain('auto-fit');
    expect(funnelMetricGridClassName).toContain('minmax(min(7rem,100%),1fr)');
    expect(funnelMetricGridClassName).toContain('w-full');
  });

  it('sizes each KPI card from its own container and clips long labels safely', () => {
    expect(funnelMetricCardClassName).toContain('@container');
    expect(funnelMetricCardClassName).toContain('overflow-hidden');
    expect(funnelMetricLabelClassName).toContain('truncate');
    expect(funnelMetricLabelClassName).toContain('cqw');
  });

  it('keeps values small enough for Mixpanel-like narrow cards', () => {
    expect(funnelMetricValueClassName).toContain('cqw');
    expect(funnelMetricValueClassName).toContain('truncate');
    expect(getFunnelMetricValueFontSizePx(112, '50.8K'.length)).toBeLessThanOrEqual(28);
    expect(getFunnelMetricValueFontSizePx(112, '1.1K'.length)).toBeLessThanOrEqual(35);
  });
});
