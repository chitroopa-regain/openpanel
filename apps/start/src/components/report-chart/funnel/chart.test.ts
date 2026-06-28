import { describe, expect, it } from 'vitest';
import {
  getFunnelBarSize,
  getFunnelLabelLayout,
  getFunnelPreviewSummaryItems,
  getFunnelResponsiveBarSize,
} from './chart';

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

  it('expands breakdown bars when the dashboard card has spare width', () => {
    const fixedSize = getFunnelBarSize({
      breakdownCount: 2,
      stepCount: 2,
      dashboardLayout: true,
    });
    const responsiveSize = getFunnelResponsiveBarSize({
      containerWidth: 1000,
      chartWidth: 1000,
      breakdownCount: 2,
      stepCount: 2,
      dashboardLayout: true,
    });

    expect(responsiveSize).toBeGreaterThan(fixedSize);
    expect(responsiveSize).toBeLessThanOrEqual(128);
  });

  it('keeps responsive bars compact when there is no spare width', () => {
    const fixedSize = getFunnelBarSize({
      breakdownCount: 5,
      stepCount: 4,
      dashboardLayout: true,
    });
    const responsiveSize = getFunnelResponsiveBarSize({
      containerWidth: 360,
      chartWidth: 360,
      breakdownCount: 5,
      stepCount: 4,
      dashboardLayout: true,
    });

    expect(responsiveSize).toBe(fixedSize);
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

  it('builds a compact preview summary with final conversion by breakdown', () => {
    const summary = getFunnelPreviewSummaryItems({
      breakdowns: [
        {
          breakdowns: ['46.2.1392'],
          id: 'version-a',
          lastStep: { percent: 0 },
        },
        {
          breakdowns: ['43.1.1330'],
          colorIndex: 4,
          id: 'version-b',
          lastStep: { percent: 16.67 },
        },
        {
          breakdowns: ['45.0.1374'],
          id: 'version-c',
          lastStep: { percent: 89.57 },
        },
      ],
      maxItems: 2,
    });

    expect(summary.items).toEqual([
      {
        colorIndex: 0,
        id: 'version-a',
        label: '46.2.1392',
        percentText: '0%',
      },
      {
        colorIndex: 4,
        id: 'version-b',
        label: '43.1.1330',
        percentText: '16.67%',
      },
    ]);
    expect(summary.remainingCount).toBe(1);
  });
});
