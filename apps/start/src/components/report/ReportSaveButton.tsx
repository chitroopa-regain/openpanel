import { Button } from '@/components/ui/button';
import { clearReportDraft } from '@/components/report-chart/report-draft';
import { useAppParams } from '@/hooks/use-app-params';
import { handleError } from '@/integrations/trpc/react';
import { pushModal } from '@/modals';
import { useDispatch, useSelector } from '@/redux';
import { SaveIcon } from 'lucide-react';
import { toast } from 'sonner';

import { useTRPC } from '@/integrations/trpc/react';
import {
  useIsFetching,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';

import { useParams, useRouter, useSearch } from '@tanstack/react-router';
import { resetDirty } from './reportSlice';

interface ReportSaveButtonProps {
  className?: string;
}
export function ReportSaveButton({ className }: ReportSaveButtonProps) {
  const trpc = useTRPC();
  const router = useRouter();
  const { organizationId, projectId } = useAppParams();
  const fetching = [
    useIsFetching(trpc.chart.chart.pathFilter()),
    useIsFetching(trpc.chart.cohort.pathFilter()),
  ];
  const { reportId } = useParams({ strict: false });
  const savedReportSearch = useSearch({
    from: '/_app/$organizationId/$projectId/reports_/$reportId',
    shouldThrow: false,
  });
  const newReportSearch = useSearch({
    from: '/_app/$organizationId/$projectId/reports',
    shouldThrow: false,
  });
  const search = savedReportSearch ?? newReportSearch;
  const dispatch = useDispatch();
  const queryClient = useQueryClient();
  const create = useMutation(
    trpc.report.create.mutationOptions({
      onSuccess(res) {
        toast('Success', {
          description: 'Report created.',
        });
        queryClient.invalidateQueries(
          trpc.report.list.queryFilter({
            dashboardId: res.dashboardId,
            projectId: res.projectId,
          }),
        );
        queryClient.invalidateQueries(trpc.dashboard.list.pathFilter());
        void router.navigate({
          to: '/$organizationId/$projectId/reports/$reportId',
          params: {
            organizationId,
            projectId,
            reportId: res.id,
          },
          search: search?.dashboardId
            ? { dashboardId: search.dashboardId }
            : undefined,
        });
      },
      onError: handleError,
    }),
  );
  const update = useMutation(
    trpc.report.update.mutationOptions({
      async onSuccess(res) {
        if (reportId) {
          const reportQuery = trpc.report.get.queryOptions({ reportId });
          queryClient.setQueryData(reportQuery.queryKey, {
            ...report,
            id: reportId,
            dashboardId: res.dashboardId,
            projectId: res.projectId,
            // Optimistic revision stamp. The server's own value arrives with
            // the refetch below; this only keeps the cached shape complete in
            // the meantime.
            updatedAt: res.updatedAt ?? new Date(),
          });
          try {
            await queryClient.fetchQuery({ ...reportQuery, staleTime: 0 });
          } catch {
            // The mutation succeeded and the cache already contains the saved
            // editor state. A later invalidation can retry the server refresh.
          }
        }
        if (search?.draft && reportId && organizationId && projectId) {
          clearReportDraft(search.draft);
          void router.navigate({
            to: '/$organizationId/$projectId/reports/$reportId',
            params: {
              organizationId,
              projectId,
              reportId,
            },
            search: {
              ...(search ?? {}),
              draft: undefined,
            },
            replace: true,
          });
        }
        dispatch(resetDirty());
        toast('Success', {
          description: 'Report updated.',
        });
        queryClient.invalidateQueries(
          trpc.report.list.queryFilter({
            dashboardId: res.dashboardId,
            projectId: res.projectId,
          }),
        );
        queryClient.invalidateQueries(
          trpc.report.get.queryFilter({
            reportId,
          }),
        );
      },
      onError: handleError,
    }),
  );
  const report = useSelector((state) => state.report);
  const isLoading =
    create.isPending || update.isPending || fetching.some((f) => f !== 0);

  if (reportId && organizationId && projectId) {
    return (
      <Button
        className={className}
        disabled={!report.dirty}
        loading={update.isPending || isLoading}
        onClick={() => {
          update.mutate({
            reportId: reportId,
            report,
          });
        }}
        icon={SaveIcon}
      >
        Update
      </Button>
    );
  }
  return (
      <Button
        className={className}
        disabled={!report.dirty}
        onClick={() => {
          if (search?.dashboardId) {
            create.mutate({
              dashboardId: search.dashboardId,
              report: {
                ...report,
                name: report.name || 'Untitled report',
              },
            });
            return;
          }

          pushModal('SaveReport', {
            report,
          });
        }}
        icon={SaveIcon}
        loading={isLoading}
    >
      Save
    </Button>
  );
}
