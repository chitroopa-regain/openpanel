import { describe, expect, it } from 'vitest';
import {
  attachFunnelPropertyStatsToSeries,
  getFunnelPropertyAveragePerStarter,
} from './chart';

describe('chart funnel property measures', () => {
  it('treats property average as ARPU over first-step users', () => {
    expect(getFunnelPropertyAveragePerStarter(38_942, 16_598)).toBeCloseTo(
      2.346,
      3
    );
    expect(getFunnelPropertyAveragePerStarter(38_942, 0)).toBe(0);
    expect(getFunnelPropertyAveragePerStarter(38_942, undefined)).toBe(0);
  });

  it('attaches property average using the first step denominator, not converted users', () => {
    const series: any[] = [
      {
        id: 'VARIANT_A',
        steps: [{ count: 8_302 }, { count: 160 }],
        lastStep: { count: 160 },
      },
    ];

    attachFunnelPropertyStatsToSeries(
      series,
      new Map([['VARIANT_A', { sum: 39_340, average: 245.875, count: 160 }]])
    );

    expect(series[0].lastStep.propertySum).toBe(39_340);
    expect(series[0].lastStep.propertyCount).toBe(160);
    expect(series[0].lastStep.propertyAverage).toBeCloseTo(4.739, 3);
  });
});
