/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReportSaveButton } from './ReportSaveButton';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  navigate: vi.fn(() => Promise.resolve()),
  setQueryData: vi.fn(),
  invalidateQueries: vi.fn(),
  clearReportDraft: vi.fn(),
  getQueryKey: ['report', 'get', { reportId: 'report-1' }],
}));

const sixMonthReport = {
  ready: true,
  dirty: true,
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
};

vi.mock('@/redux', () => ({
  useDispatch: () => mocks.dispatch,
  useSelector: (selector: (state: unknown) => unknown) =>
    selector({ report: sixMonthReport }),
}));

vi.mock('@/hooks/use-app-params', () => ({
  useAppParams: () => ({
    organizationId: 'organization-1',
    projectId: 'regain-app',
  }),
}));

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ reportId: 'report-1' }),
  useRouter: () => ({ navigate: mocks.navigate }),
  useSearch: () => ({ dashboardId: 'regain-pro', draft: 'draft-token' }),
}));

vi.mock('@tanstack/react-query', () => ({
  useIsFetching: () => 0,
  useQueryClient: () => ({
    setQueryData: mocks.setQueryData,
    invalidateQueries: mocks.invalidateQueries,
  }),
  useMutation: (options: {
    kind: 'create' | 'update';
    onSuccess?: (result: unknown) => void;
  }) => ({
    isPending: false,
    mutate: vi.fn(() => {
      if (options.kind === 'update') {
        options.onSuccess?.({
          id: 'report-1',
          dashboardId: 'regain-pro',
          projectId: 'regain-app',
        });
      }
    }),
  }),
}));

vi.mock('@/integrations/trpc/react', () => ({
  handleError: vi.fn(),
  useTRPC: () => ({
    chart: {
      chart: { pathFilter: () => ['chart'] },
      cohort: { pathFilter: () => ['cohort'] },
    },
    dashboard: { list: { pathFilter: () => ['dashboard-list'] } },
    report: {
      create: {
        mutationOptions: (options: object) => ({ ...options, kind: 'create' }),
      },
      update: {
        mutationOptions: (options: object) => ({ ...options, kind: 'update' }),
      },
      list: { queryFilter: () => ({ queryKey: ['report-list'] }) },
      get: {
        queryKey: () => mocks.getQueryKey,
        queryFilter: () => ({ queryKey: mocks.getQueryKey }),
      },
    },
  }),
}));

vi.mock('@/components/report-chart/report-draft', () => ({
  clearReportDraft: mocks.clearReportDraft,
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} onClick={onClick} type="button">
      {children}
    </button>
  ),
}));

vi.mock('@/modals', () => ({ pushModal: vi.fn() }));
vi.mock('sonner', () => ({ toast: vi.fn() }));

describe('ReportSaveButton update', () => {
  it('hydrates the report cache with the saved six-month range before removing the draft route', () => {
    render(<ReportSaveButton />);

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    expect(mocks.setQueryData).toHaveBeenCalledWith(mocks.getQueryKey, {
      ...sixMonthReport,
      id: 'report-1',
      dashboardId: 'regain-pro',
      projectId: 'regain-app',
    });
    expect(mocks.navigate).toHaveBeenCalled();
    expect(mocks.setQueryData.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.navigate.mock.invocationCallOrder[0]!
    );
  });
});
