import { describe, expect, it } from 'vitest';
import { getReportHeight, withReportHeight } from './report-height';

// Production read-only metadata audit: pre-feature h values range from 2 to
// 16 (not only the reorder placeholder 4). Top-level app metrics has h=8.
// Every existing layout has maxH=NULL. None of these heights was rendered
// before this feature, so enabling controls must not resize existing boards.
// An explicit height selection needs an opt-in marker in saved metadata.
describe('legacy dashboard height compatibility', () => {
  it('opts into the selected height and preserves it across serialization', () => {
    const before = {
      id: 'report',
      dashboardId: 'legacy-board',
      layout: { x: 2, y: 3, w: 6, h: 8, maxH: null },
    };
    const changed = withReportHeight(before, 9, 0, 0);
    expect(getReportHeight(JSON.parse(JSON.stringify(changed)))).toBe(9);
    expect(changed.layout).toMatchObject({ x: 2, y: 3, w: 6, h: 9, maxH: 12 });
    expect(getReportHeight(withReportHeight(changed, 3, 0, 0))).toBe(3);
  });
  for (const h of [2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 16]) {
    it(`preserves the ordinary dashboard default for legacy h=${h}`, () => {
      expect(
        getReportHeight({ dashboardId: 'legacy-board', layout: { h } })
      ).toBe(3);
    });
  }

  it('preserves the top-level metrics default for its existing h=8', () => {
    expect(
      getReportHeight({
        dashboardId: 'top-level-app-metrics',
        layout: { h: 8 },
      })
    ).toBe(6);
  });
});
