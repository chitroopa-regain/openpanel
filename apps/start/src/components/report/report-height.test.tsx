// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from '@testing-library/react';
import { deriveRowsFromReports, useReportLayouts } from '../grafana-grid';
import {
  getReportChartHeights,
  getReportHeight,
  prepareReportHeightChange,
} from './report-height';
import { ReportItem, ReportItemReadOnly } from './report-item';

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ navigate: vi.fn() }),
}));
vi.mock('@/components/report-chart', () => ({
  ReportChart: ({ options }: any) => (
    <div data-testid="chart" data-options={JSON.stringify(options)} />
  ),
}));
vi.mock('@/components/report-chart/report-cache-status', () => ({
  ReportCacheBadge: () => null,
}));
vi.mock('@/components/ui/tooltip', () => ({
  Tooltiper: ({ children }: any) => children,
}));

const report = (id: string, x: number, y: number, h = 4): any => ({
  id,
  name: id,
  dashboardId: 'dashboard',
  chartType: 'retention',
  range: null,
  breakdowns: [],
  layout: { x, y, w: 6, h, minW: 3, minH: 3, maxH: h === 4 ? null : 12 },
});
const props = {
  organizationId: 'org',
  projectId: 'project',
  range: null,
  startDate: null,
  endDate: null,
  interval: null,
  onDelete: vi.fn(),
  onDuplicate: vi.fn(),
};
afterEach(cleanup);

describe('saved dashboard height', () => {
  it('preserves legacy defaults and top-level app metrics defaults', () => {
    for (const h of [undefined, 0, 4, NaN, Infinity]) {
      expect(getReportHeight({ layout: { h } })).toBe(3);
      expect(
        getReportHeight({ dashboardId: 'top-level-app-metrics', layout: { h } })
      ).toBe(6);
    }
    expect(
      getReportHeight({
        dashboardId: 'top-level-app-metrics',
        layout: { h: 3 },
      })
    ).toBe(6);
    expect(getReportHeight({ layout: { h: 10000, maxH: 12 } })).toBe(12);
    for (const h of [2, 3, 4, 6, 9, 12, 16]) {
      expect(getReportHeight({ layout: { h, maxH: null } })).toBe(3);
    }
  });

  it('roundtrips only the target height and keeps widths/order/row alignment across breakpoints', () => {
    const reports = [
      report('a', 0, 0),
      report('b', 1, 0),
      report('c', 0, 1),
      report('d', 1, 1),
    ];
    const rows = deriveRowsFromReports(reports);
    const next = prepareReportHeightChange(reports, rows, 'a', 9);
    expect(next[0].layout).toEqual({ ...reports[0].layout, h: 9, maxH: 12 });
    expect(next[1]).toBe(reports[1]);
    expect(reports[0].layout.h).toBe(4);
    const reloaded = JSON.parse(JSON.stringify(next));
    expect(deriveRowsFromReports(reloaded)).toEqual(rows);
    const { result } = renderHook(() => useReportLayouts(reloaded));
    for (const layout of Object.values(result.current)) {
      expect(layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))).toEqual([
        { i: 'a', x: 0, y: 0, w: 6, h: 9 },
        { i: 'b', x: 6, y: 0, w: 6, h: 3 },
        { i: 'c', x: 0, y: 9, w: 6, h: 3 },
        { i: 'd', x: 6, y: 9, w: 6, h: 3 },
      ]);
    }
    const reset = prepareReportHeightChange(reloaded, rows, 'a', 3);
    expect(getReportHeight(reset[0])).toBe(3);
  });

  it('materializes unsaved row memberships without changing the visible layout', () => {
    const reports = Array.from({ length: 7 }, (_, index) => ({
      ...report(String(index), 0, 0),
      layout: null,
    }));
    const rows = deriveRowsFromReports(reports);
    const next = prepareReportHeightChange(reports, rows, '2', 6);
    expect(deriveRowsFromReports(JSON.parse(JSON.stringify(next)))).toEqual(
      rows
    );
    expect(next.map((r) => r.layout.h)).toEqual([3, 3, 6, 3, 3, 3, 3]);
  });

  it('rejects invalid presets and unknown IDs', () => {
    const reports = [report('a', 0, 0)];
    expect(prepareReportHeightChange(reports, [['a']], 'a', 100)).toBe(reports);
    expect(prepareReportHeightChange(reports, [['a']], 'missing', 6)).toBe(
      reports
    );
  });

  it('scales chart bounds without changing defaults', () => {
    expect(getReportChartHeights(report('a', 0, 0))).toEqual({
      maxHeight: 300,
      minHeight: 100,
    });
    expect(getReportChartHeights(report('a', 0, 0, 9))).toEqual({
      maxHeight: 996,
      minHeight: 100,
    });
  });

  it('lets editors choose and reset height through the real card menu', () => {
    const change = vi.fn();
    render(
      <ReportItem
        {...props}
        report={report('ARPU', 0, 0)}
        onHeightChange={change}
      />
    );
    fireEvent.keyDown(
      screen.getByRole('button', { name: 'Options for ARPU' }),
      { key: 'Enter' }
    );
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Extra tall' }));
    expect(change).toHaveBeenCalledWith('ARPU', 9);
    fireEvent.keyDown(
      screen.getByRole('button', { name: 'Options for ARPU' }),
      { key: 'Enter' }
    );
    fireEvent.click(
      screen.getByRole('menuitemradio', { name: 'Default height' })
    );
    expect(change).toHaveBeenLastCalledWith('ARPU', 3);
  });

  it('disables presets during a save and omits them without an editing callback', () => {
    const change = vi.fn();
    const view = render(
      <ReportItem
        {...props}
        report={report('ARPU', 0, 0)}
        onHeightChange={change}
        isHeightSaving
      />
    );
    fireEvent.keyDown(
      screen.getByRole('button', { name: 'Options for ARPU' }),
      { key: 'Enter' }
    );
    expect(
      screen
        .getByRole('menuitemradio', { name: 'Tall' })
        .getAttribute('data-disabled')
    ).not.toBeNull();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Tall' }));
    expect(change).not.toHaveBeenCalled();
    view.unmount();
    render(<ReportItem {...props} report={report('ARPU', 0, 0)} />);
    fireEvent.keyDown(
      screen.getByRole('button', { name: 'Options for ARPU' }),
      { key: 'Enter' }
    );
    expect(screen.queryByText('Card height')).toBeNull();
  });

  it('read-only cards render the saved bounds with no editing controls', () => {
    render(
      <ReportItemReadOnly
        {...props}
        shareId="share"
        report={report('ARPU', 0, 0, 9)}
      />
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(
      JSON.parse(screen.getByTestId('chart').dataset.options!).maxHeight
    ).toBe(996);
  });
});
