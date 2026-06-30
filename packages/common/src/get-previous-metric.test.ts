import { describe, expect, it } from 'vitest';

import { getPreviousMetric } from './get-previous-metric';

describe('getPreviousMetric', () => {
  it('reports a conventional decrease relative to the previous value', () => {
    expect(getPreviousMetric(25900, 34243)).toEqual({
      diff: 24.4,
      state: 'negative',
      value: 34243,
    });
  });

  it('reports a conventional increase relative to the previous value', () => {
    expect(getPreviousMetric(34243, 25900)).toEqual({
      diff: 32.2,
      state: 'positive',
      value: 25900,
    });
  });

  it('reports 100 percent down when current is zero and previous was non-zero', () => {
    expect(getPreviousMetric(0, 500)).toEqual({
      diff: 100,
      state: 'negative',
      value: 500,
    });
  });
});
