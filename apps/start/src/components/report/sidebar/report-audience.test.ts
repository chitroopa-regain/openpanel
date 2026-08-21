import { describe, expect, it } from 'vitest';
import { AUDIENCE_SUPPORTED_CHART_TYPES } from './ReportAudience';

describe('audience support by chart type', () => {
  it('supports the chart types whose query path applies the audience', () => {
    for (const t of ['linear', 'bar', 'area', 'pie', 'metric', 'table', 'map', 'histogram', 'funnel', 'funnel_metric', 'retention']) {
      expect(AUDIENCE_SUPPORTED_CHART_TYPES.has(t)).toBe(true);
    }
  });

  it('does NOT claim support for sankey or conversion', () => {
    // Their query paths ignore the audience. Offering the picker there would
    // accept a cohort and silently do nothing — the failure this feature exists
    // to prevent — so the UI shows a disabled note instead.
    expect(AUDIENCE_SUPPORTED_CHART_TYPES.has('sankey')).toBe(false);
    expect(AUDIENCE_SUPPORTED_CHART_TYPES.has('conversion')).toBe(false);
  });
});
