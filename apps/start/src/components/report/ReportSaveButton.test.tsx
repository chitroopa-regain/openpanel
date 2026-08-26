/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReportSaveButton } from './ReportSaveButton';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  navigate: vi.fn(() => Promise.resolve()),
  setQueryData: vi.fn(),
  fetchQuery: vi.fn(() => Promise.resolve(sixMonthReport)),
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
    fetchQuery: mocks.fetchQuery,
    invalidateQueries: mocks.invalidateQueries,
  }),
  useMutation: (options: {
    kind: 'create' | 'update';
    onSuccess?: (result: unknown) => void | Promise<void>;
  }) => ({
    isPending: false,
    mutate: vi.fn(async () => {
      if (options.kind === 'update') {
        await options.onSuccess?.({
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
        queryOptions: () => ({
          queryKey: mocks.getQueryKey,
          queryFn: vi.fn(),
        }),
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
  it('refreshes the exact report query before removing the draft route', async () => {
    render(<ReportSaveButton />);

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalled());
    expect(mocks.setQueryData).toHaveBeenCalledWith(mocks.getQueryKey, {
      ...sixMonthReport,
      id: 'report-1',
      dashboardId: 'regain-pro',
      projectId: 'regain-app',
      // Revision stamp: the cached report shape carries updatedAt, which the
      // query cache keys saved reports on.
      updatedAt: expect.anything(),
    });
    expect(mocks.fetchQuery).toHaveBeenCalledWith({
      queryKey: mocks.getQueryKey,
      queryFn: expect.any(Function),
      staleTime: 0,
    });
    expect(mocks.setQueryData.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.fetchQuery.mock.invocationCallOrder[0]!
    );
    expect(mocks.fetchQuery.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.navigate.mock.invocationCallOrder[0]!
    );
  });
});
