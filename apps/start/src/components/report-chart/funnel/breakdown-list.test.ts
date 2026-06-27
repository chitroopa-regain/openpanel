import { describe, expect, it } from 'vitest';
import {
  getFunnelBreakdownStickyLayout,
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

    expect(layout.totalConversion.width).toBeGreaterThanOrEqual(112);
    expect(pinnedWidth).toBeLessThanOrEqual(360);
  });

  it('keeps enough trailing scroll room to reveal the final metric column', () => {
    expect(getFunnelBreakdownTableScrollGutterWidth()).toBeGreaterThanOrEqual(
      96
    );
  });
});
