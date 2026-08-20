import { describe, expect, it } from 'vitest';
import {
  clampFunnelBreakdownColumnWidth,
  DEFAULT_FUNNEL_BREAKDOWN_COLUMN_WIDTHS,
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

  it('reserves enough width for the first step event-name header', () => {
    const metrics = getFunnelBreakdownMetricColumnWidths();

    // The first step header does not span Time/Conv/# columns, so it needs its
    // own wide column to show names like "1 Application Installed".
    expect(metrics.firstStepCount).toBeGreaterThanOrEqual(240);
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

  it('moves pinned columns and grows the table when a user expands Breakdown', () => {
    const expanded = {
      ...DEFAULT_FUNNEL_BREAKDOWN_COLUMN_WIDTHS,
      breakdown: 420,
    };
    const defaultWidth = getFunnelBreakdownTableMinWidth(3);
    const expandedLayout = getFunnelBreakdownStickyLayout(expanded);

    expect(expandedLayout.totalConversion.left).toBe(460);
    expect(getFunnelBreakdownStickyColumnStyle('breakdown', expanded)).toEqual({
      left: 40,
      width: 420,
      minWidth: 420,
      maxWidth: 420,
    });
    expect(getFunnelBreakdownTableMinWidth(3, expanded)).toBe(
      defaultWidth + 220
    );
  });

  it('clamps dragged columns to usable minimum and maximum widths', () => {
    expect(clampFunnelBreakdownColumnWidth('breakdown', 20)).toBe(160);
    expect(clampFunnelBreakdownColumnWidth('breakdown', 900)).toBe(600);
    expect(clampFunnelBreakdownColumnWidth('count', 120)).toBe(120);
  });
});
