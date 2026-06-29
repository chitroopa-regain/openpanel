import { describe, expect, it } from 'vitest';
import {
  getFunnelBreakdownMetricColumnWidths,
  getFunnelBreakdownStickyColumnStyle,
  getFunnelBreakdownStickyLayout,
  getFunnelBreakdownTableMinWidth,
  getFunnelBreakdownTableScrollGutterWidth,
} from './breakdown-list';

describe('getFunnelBreakdownStickyLayout', () => {
  it('keeps sticky funnel breakdown columns aligned to their rendered widths', () => {
    const layout = getFunnelBreakdownStickyLayout();

    expect(layout.selection.width).toBe(40);
    expect(layout.breakdown.width).toBe(200);
    expect(layout.breakdown.left).toBe(layout.selection.width);
    expect(layout.totalConversion.left).toBe(
      layout.selection.width + layout.breakdown.width
    );
  });

  it('keeps the pinned columns inside narrow mobile viewports', () => {
    const layout = getFunnelBreakdownStickyLayout();
    const pinnedWidth =
      layout.selection.width +
      layout.breakdown.width +
      layout.totalConversion.width;

    expect(layout.totalConversion.width).toBeGreaterThanOrEqual(120);
    expect(pinnedWidth).toBeLessThanOrEqual(360);
  });

  it('reserves a fixed-width non-sticky gutter so wide dashboard cards do not stretch pinned columns', () => {
    const layout = getFunnelBreakdownStickyLayout();
    const metrics = getFunnelBreakdownMetricColumnWidths();
    const twoStepWidth = getFunnelBreakdownTableMinWidth(2);
    const fixedColumnsWithoutGutter =
      layout.selection.width +
      layout.breakdown.width +
      layout.totalConversion.width +
      metrics.firstStepCount +
      metrics.time +
      metrics.conversion +
      metrics.count;

    expect(twoStepWidth).toBe(
      fixedColumnsWithoutGutter + getFunnelBreakdownTableScrollGutterWidth()
    );
    expect(layout.totalConversion.left).toBe(
      layout.selection.width + layout.breakdown.width
    );
    expect(layout.totalConversion.left + layout.totalConversion.width).toBe(
      layout.selection.width +
        layout.breakdown.width +
        layout.totalConversion.width
    );
  });

  it('keeps enough trailing scroll room to reveal the final metric column', () => {
    expect(getFunnelBreakdownTableScrollGutterWidth()).toBeGreaterThanOrEqual(
      96
    );
  });

  it('exports inline sticky styles that cannot be overridden by table auto-layout CSS', () => {
    expect(getFunnelBreakdownStickyColumnStyle('selection')).toEqual({
      left: 0,
      width: 40,
      minWidth: 40,
      maxWidth: 40,
    });
    expect(getFunnelBreakdownStickyColumnStyle('breakdown')).toEqual({
      left: 40,
      width: 200,
      minWidth: 200,
      maxWidth: 200,
    });
    expect(getFunnelBreakdownStickyColumnStyle('totalConversion')).toEqual({
      left: 240,
      width: 120,
      minWidth: 120,
      maxWidth: 120,
    });
  });
});
