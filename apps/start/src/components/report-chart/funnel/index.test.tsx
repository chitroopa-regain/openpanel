import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  layout: 'dashboard' as 'dashboard' | 'default',
  mode: 'both' as 'both' | 'chart' | 'table' | undefined,
}));
vi.mock('../context', () => ({
  useReportChartContext: () => ({
    isLazyLoading: false,
    isEditMode: state.layout === 'default',
    options: { displayLayout: state.layout },
    report: {
      projectId: 'fixture',
      series: [{ id: 'step' }],
      options: { type: 'funnel', displayMode: state.mode },
    },
  }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { current: [{ id: 'one' }, { id: 'two' }] } }),
}));
vi.mock('@/integrations/trpc/react', () => ({
  useTRPC: () => ({ chart: { funnel: { queryOptions: () => ({ queryKey: [] }) } } }),
}));
vi.mock('../use-report-revalidation', () => ({ useReportRevalidation: () => {} }));
vi.mock('@/redux', () => ({ useDispatch: () => vi.fn() }));
vi.mock('../../../components/report/reportSlice', () => ({
  changeFunnelHiddenBreakdowns: vi.fn(),
  changeFunnelTopN: vi.fn(),
}));
vi.mock('@/hooks/use-visible-funnel-breakdowns', () => ({
  useVisibleFunnelBreakdowns: () => ({
    breakdowns: [], visibleSeriesIds: [], rankOf: () => 0,
  }),
}));
vi.mock('@/modals', () => ({ pushModal: vi.fn() }));
vi.mock('./chart', () => ({
  Chart: () => createElement('div', { 'data-testid': 'chart' }),
  Summary: () => createElement('div', { 'data-testid': 'summary' }),
}));
vi.mock('./breakdown-list', () => ({
  BreakdownList: () => createElement('div', { 'data-testid': 'table' }),
}));

import { ReportFunnelChart } from './index';

const render = () => renderToStaticMarkup(createElement(ReportFunnelChart));
describe('funnel dashboard chart/table space allocation', () => {
  beforeEach(() => { state.layout = 'dashboard'; state.mode = 'both'; });

  it('protects both surfaces from shrinking in dashboard combined mode', () => {
    const html = render();
    expect(html).toContain('class="h-[320px] min-h-[320px] min-w-0 grow shrink-0"><div data-testid="chart"');
    expect(html).toContain('class="min-w-0 shrink-0"><div data-testid="table"');
  });

  it.each(['chart', 'table', undefined] as const)('preserves dashboard %s mode', (mode) => {
    state.mode = mode;
    const html = render();
    expect(html).not.toContain('h-[320px]');
    expect(html.includes('data-testid="chart"')).toBe(mode !== 'table');
    expect(html.includes('data-testid="table"')).toBe(mode === 'table');
  });

  it('does not impose dashboard sizing on the editor', () => {
    state.layout = 'default';
    const html = render();
    expect(html).not.toContain('h-[320px]');
    expect(html).toContain('data-testid="chart"');
    expect(html).toContain('data-testid="table"');
    expect(html).toContain('data-testid="summary"');
  });
});
