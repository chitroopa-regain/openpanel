/** @vitest-environment jsdom */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReportEditor from './report-editor';
import { setReport } from '@/components/report/reportSlice';

const dispatch = vi.fn();
const navigate = vi.fn(() => Promise.resolve());

vi.mock('@/redux', () => ({
  useDispatch: () => dispatch,
  useSelector: (selector: (state: unknown) => unknown) =>
    selector({
      report: {
        ready: false,
        dirty: false,
        projectId: 'regain-app',
        name: 'Monthly Subscription Retention',
        chartType: 'retention',
        lineType: 'monotone',
        interval: 'month',
        breakdowns: [],
        series: [],
        range: '6m',
        startDate: null,
        endDate: null,
        previous: false,
        metric: 'sum',
        limit: 500,
      },
    }),
}));

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ reportId: 'report-1' }),
  useRouter: () => ({ navigate }),
  useSearch: () => ({ dashboardId: 'regain-pro' }),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQuery: () => ({ data: null }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@/hooks/use-app-params', () => ({
  useAppParams: () => ({
    organizationId: 'organization-1',
    projectId: 'regain-app',
  }),
}));

vi.mock('@/hooks/use-breakpoint', () => ({
  useBreakpoint: () => ({ isAboveLg: true }),
}));

vi.mock('@/integrations/trpc/react', () => ({
  handleError: vi.fn(),
  useTRPC: () => ({
    project: {
      getProjectWithClients: { queryOptions: () => ({}) },
    },
    dashboard: {
      byId: { queryOptions: () => ({}) },
      list: { pathFilter: () => ({}) },
    },
    report: {
      create: { mutationOptions: (options: unknown) => options },
      update: { mutationOptions: (options: unknown) => options },
      list: { queryFilter: () => ({}) },
      get: { queryFilter: () => ({}) },
    },
  }),
}));

vi.mock('@/components/page-breadcrumbs', () => ({
  PageBreadcrumbs: () => null,
}));
vi.mock('@/components/report/ReportChartType', () => ({
  ReportChartType: () => null,
}));
vi.mock('@/components/report/ReportInterval', () => ({
  ReportInterval: () => null,
}));
vi.mock('@/components/report/ReportLineType', () => ({
  ReportLineType: () => null,
}));
vi.mock('@/components/report/ReportSaveButton', () => ({
  ReportSaveButton: () => null,
}));
vi.mock('@/components/report/sidebar/ReportSidebar', () => ({
  ReportSidebar: () => null,
}));
vi.mock('@/components/report-chart', () => ({
  ReportChart: () => null,
}));
vi.mock('@/components/time-window-picker', () => ({
  TimeWindowPicker: () => null,
}));
vi.mock('@/components/report-chart/report-cache-status', () => ({
  ReportCacheBadge: () => null,
}));
vi.mock('../report/edit-report-name', () => ({
  default: () => null,
}));
vi.mock('@/components/report-chart/report-draft', () => ({
  clearReportDraft: vi.fn(),
  createReportDraftToken: () => 'draft-token',
  loadReportDraft: () => null,
  saveReportDraft: vi.fn(),
}));

const sixMonthReport = {
  id: 'report-1',
  projectId: 'regain-app',
  dashboardId: 'regain-pro',
  name: 'Monthly Subscription Retention',
  chartType: 'retention',
  lineType: 'monotone',
  interval: 'month',
  breakdowns: [],
  series: [],
  range: '6m',
  startDate: null,
  endDate: null,
  previous: false,
  metric: 'sum',
  limit: 500,
};

afterEach(async () => {
  cleanup();
  await Promise.resolve();
  dispatch.mockClear();
  navigate.mockClear();
});

describe('ReportEditor lifecycle', () => {
  it('does not reset a saved six-month range while Update replaces the same route', async () => {
    const currentEditor = render(
      <ReportEditor report={sixMonthReport as never} />
    );

    expect(dispatch).toHaveBeenCalledWith(setReport(sixMonthReport as never));
    dispatch.mockClear();

    currentEditor.unmount();
    expect(dispatch).not.toHaveBeenCalled();

    const replacementEditor = render(
      <ReportEditor report={sixMonthReport as never} />
    );
    dispatch.mockClear();
    await Promise.resolve();

    expect(dispatch).not.toHaveBeenCalled();
    replacementEditor.unmount();
  });

  it('still resets shared report state after a real navigation away', async () => {
    const { unmount } = render(
      <ReportEditor report={sixMonthReport as never} />
    );
    dispatch.mockClear();

    unmount();
    expect(dispatch).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(dispatch).toHaveBeenCalledWith({
      payload: undefined,
      type: 'report/reset',
    });
  });
});
