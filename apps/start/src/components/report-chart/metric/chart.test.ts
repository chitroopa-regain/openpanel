import { describe, expect, it } from 'vitest';

import { shouldForceCompactMetricLayout } from './chart';

describe('metric chart layout selection', () => {
  it('keeps a single hero metric large', () => {
    expect(shouldForceCompactMetricLayout('hero', 1)).toBe(false);
  });

  it('forces multi-series hero metrics into compact cards so values do not overlap', () => {
    expect(shouldForceCompactMetricLayout('hero', 4)).toBe(true);
  });

  it('leaves compact metric charts compact by default', () => {
    expect(shouldForceCompactMetricLayout('compact', 4)).toBe(false);
  });
});
