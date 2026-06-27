import { describe, expect, it } from 'vitest';
import { getFunnelBarSize, getFunnelLabelLayout } from './chart';

describe('funnel chart adaptive layout', () => {
  it('uses thinner dashboard bars when many breakdowns are visible', () => {
    expect(
      getFunnelBarSize({
        breakdownCount: 4,
        stepCount: 1,
        dashboardLayout: true,
      })
    ).toBeLessThan(34);
    expect(
      getFunnelBarSize({
        breakdownCount: 4,
        stepCount: 1,
        dashboardLayout: true,
      })
    ).toBeLessThan(
      getFunnelBarSize({
        breakdownCount: 1,
        stepCount: 1,
        dashboardLayout: true,
      })
    );
  });

  it('sizes value chips from the value text instead of a fixed fat width', () => {
    const smallValue = getFunnelLabelLayout({
      x: 10,
      y: 80,
      width: 28,
      value: 100,
      percentText: '100%',
      countText: '5',
    });
    const largeValue = getFunnelLabelLayout({
      x: 10,
      y: 80,
      width: 56,
      value: 100,
      percentText: '89.57%',
      countText: '175.9K',
    });

    expect(smallValue.compact).toBe(true);
    expect(smallValue.labelWidth).toBeLessThan(56);
    expect(largeValue.labelWidth).toBeGreaterThan(smallValue.labelWidth);
  });

  it('moves labels inside the plot when a full-height bar has no top headroom', () => {
    const label = getFunnelLabelLayout({
      x: 0,
      y: 0,
      width: 56,
      value: 100,
      percentText: '100%',
      countText: '222',
    });

    expect(label.labelY).toBeGreaterThanOrEqual(4);
  });
});
